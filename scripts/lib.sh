#!/bin/bash
# Team Kazakhstan — shared functions of the NAS scripts (sourced, not run).
#
# Only plain `docker` commands are used (Docker Engine 20.10+); Docker Compose
# is not required. The scripts touch only containers named <CONTAINER_PREFIX>-*
# that carry the label org.teamkz.managed=true: other containers, networks,
# ports and Task Scheduler jobs on the NAS are never changed.
# Written for bash 4.3 (DSM 6.2) and newer.

set -u
set -o pipefail

TKZ_SCRIPTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd "$TKZ_SCRIPTS_DIR/.." && pwd)
ENV_FILE="$APP_DIR/.env"
LOG_DIR="$APP_DIR/logs"
STATE_DIR="$APP_DIR/state"
RUNTIME_DIR="$STATE_DIR/runtime"
LOCK_DIR="$STATE_DIR/ops.lock"
VERSION=$(tr -d ' \r\n' 2> /dev/null < "$APP_DIR/VERSION" || echo 0.0.0)
IMAGE_REPO=team-kazakhstan
IMAGE="$IMAGE_REPO:$VERSION"
# Task Scheduler starts scripts with a minimal PATH; docker lives in
# /usr/local/bin (DSM 6.2 Docker, DSM 7.2 Container Manager links it there).
export PATH="${PATH:-/usr/bin:/bin}:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin"
umask 022

# ------------------------------------------------------------------ output

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
ok() { say "OK    $*"; }
warn() { say "WARN  $*"; }
die() {
  say "ERROR $*"
  [ -z "${TKZ_FAIL_HINT:-}" ] || say "HINT  $TKZ_FAIL_HINT"
  exit 1
}

# Output goes to the terminal / Task Scheduler and to logs/<name>.log
# (rotated at 1 MB, one previous copy kept).
log_init() {
  mkdir -p "$LOG_DIR" || exit 1
  local f="$LOG_DIR/$1.log"
  if [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 1048576 ]; then mv -f "$f" "$f.1"; fi
  exec > >(tee -a "$f") 2>&1
  say "===== $1 (Team Kazakhstan $VERSION, $APP_DIR) ====="
}

require_root() {
  [ "$(id -u)" = 0 ] || die "run as root: Task Scheduler → the task → General → User: root (over SSH: sudo bash $0)"
}

# ------------------------------------------------------------------ locking

# One operation at a time (setup, start, stop, update, backup, restore...).
# A lock left by a crashed run or from before a reboot is detected and removed.
boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo none; }

acquire_lock() { # $1 = seconds to wait (0 = give up at once)
  local waited=0 pid boot
  mkdir -p "$STATE_DIR" || die "cannot create $STATE_DIR"
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    boot=$(cat "$LOCK_DIR/boot" 2>/dev/null || true)
    if [ -n "$pid" ] && { [ "$boot" != "$(boot_id)" ] || ! kill -0 "$pid" 2>/dev/null; }; then
      warn "removing a stale lock (process $pid is gone)"
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [ "$waited" -ge "${1:-0}" ]; then
      say "another operation is running: $(cat "$LOCK_DIR/owner" 2>/dev/null || echo unknown) (process ${pid:-?})"
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  echo $$ > "$LOCK_DIR/pid"
  boot_id > "$LOCK_DIR/boot"
  printf '%s\n' "${TKZ_SCRIPT_NAME:-script}" > "$LOCK_DIR/owner"
  trap release_lock EXIT
}

release_lock() {
  if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK_DIR"; fi
}

# ------------------------------------------------------------ configuration

# Reads .env once without executing it (no `source`): KEY=value, optional
# quotes, trailing "# comments" and Windows line endings are handled.
declare -A TKZ_ENV=()
read_env() {
  local line key v
  TKZ_ENV=()
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line//$'\r'/}
    [[ $line =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    v=${BASH_REMATCH[2]}
    v="${v#"${v%%[![:space:]]*}"}"
    case $v in
      \"*) v=${v#\"} && v=${v%%\"*} ;;
      \'*) v=${v#\'} && v=${v%%\'*} ;;
      *) v=${v%%[[:space:]]#*} && v="${v%"${v##*[![:space:]]}"}" ;;
    esac
    TKZ_ENV[$key]=$v
  done < "$ENV_FILE"
}

# Value of a key; returns 1 if the key is absent.
env_raw() {
  [ "${TKZ_ENV[$1]+set}" = set ] || return 1
  printf '%s' "${TKZ_ENV[$1]}"
}

# Sets KEY=value in .env: replaces the existing line or appends one. The file
# is rewritten in place, so its owner and permissions stay as they are.
set_env_value() { # key value
  local key=$1 value=$2 tmp="$ENV_FILE.tmp.$$"
  if grep -qE "^[[:space:]]*$key[[:space:]]*=" "$ENV_FILE"; then
    sed -E "s|^[[:space:]]*$key[[:space:]]*=.*|$key=$value|" "$ENV_FILE" > "$tmp" || die "cannot update .env"
  else
    cp "$ENV_FILE" "$tmp" || die "cannot update .env"
    [ -z "$(tail -c 1 "$ENV_FILE")" ] || echo >> "$tmp"
    echo "$key=$value" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE" && rm -f "$tmp"
}

# Value or default (also when the key is present but empty).
cfg() {
  local v
  v=$(env_raw "$1") || v=""
  if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "${2:-}"; fi
}

check() { # value regex message
  [[ $1 =~ $2 ]] || die "$3 (now: \"$1\"). Fix it in $ENV_FILE"
}

load_config() {
  [ -f "$ENV_FILE" ] || die ".env not found in $APP_DIR: copy .env.example to .env and fill it in (README_RU.md, step 3)"
  read_env
  DATA_DIR=$(cfg DATA_DIR /volume1/docker/team-kz-data)
  BACKUP_DIR=$(cfg BACKUP_DIR /volume1/docker/team-kz-backups)
  BACKUP_COPY_DIR=$(cfg BACKUP_COPY_DIR)
  DEPLOY_MODE=$(cfg DEPLOY_MODE tailscale)
  TS_HOSTNAME=$(cfg TS_HOSTNAME team)
  TS_AUTHKEY=$(cfg TS_AUTHKEY)
  TS_EXTRA_ARGS=$(cfg TS_EXTRA_ARGS)
  TS_FUNNEL=$(cfg TS_FUNNEL false)
  APP_BASE_URL=$(cfg APP_BASE_URL auto)
  if ! HTTP_BIND=$(env_raw HTTP_BIND); then HTTP_BIND=127.0.0.1:8095; fi
  TRUST_PROXY=$(cfg TRUST_PROXY auto)
  EXTRA_ALLOWED_HOSTS=$(cfg EXTRA_ALLOWED_HOSTS)
  CONTAINER_PREFIX=$(cfg CONTAINER_PREFIX teamkz)
  APP_UID=$(cfg APP_UID 1000)
  APP_GID=$(cfg APP_GID 1000)
  if ! CONTAINER_MEMORY=$(env_raw CONTAINER_MEMORY); then CONTAINER_MEMORY=512m; fi
  TAILSCALE_IMAGE=$(cfg TAILSCALE_IMAGE tailscale/tailscale:v1.104.2)
  BUILD_FROM_SOURCE=$(cfg BUILD_FROM_SOURCE auto)
  SESSION_TTL_HOURS=$(cfg SESSION_TTL_HOURS 168)
  SESSION_IDLE_HOURS=$(cfg SESSION_IDLE_HOURS 48)
  INVITE_TTL_HOURS=$(cfg INVITE_TTL_HOURS 72)
  LOG_LEVEL=$(cfg LOG_LEVEL info)
  TZ_NAME=$(cfg TZ Asia/Almaty)
  BACKUP_RETENTION_DAYS=$(cfg BACKUP_RETENTION_DAYS 30)
  BACKUP_MIN_KEEP=$(cfg BACKUP_MIN_KEEP 7)
  APP_BACKUP_RETENTION_DAYS=$(cfg APP_BACKUP_RETENTION_DAYS 14)
  ALLOW_INSECURE_HTTP=$(cfg ALLOW_INSECURE_HTTP false)
  INITIAL_ADMIN_USERNAME=$(cfg INITIAL_ADMIN_USERNAME)
  INITIAL_ADMIN_PASSWORD=$(cfg INITIAL_ADMIN_PASSWORD)

  local path_re='^/[A-Za-z0-9._/-]+$'
  check "$DATA_DIR" "$path_re" "DATA_DIR must be an absolute path without spaces, e.g. /volume1/docker/team-kz-data"
  check "$BACKUP_DIR" "$path_re" "BACKUP_DIR must be an absolute path without spaces"
  [ -z "$BACKUP_COPY_DIR" ] || check "$BACKUP_COPY_DIR" "$path_re" "BACKUP_COPY_DIR must be an absolute path without spaces"
  [ -d "$(dirname "$DATA_DIR")" ] || die "the folder $(dirname "$DATA_DIR") (parent of DATA_DIR) does not exist: create the shared folder or fix DATA_DIR"
  [ -d "$(dirname "$BACKUP_DIR")" ] || die "the folder $(dirname "$BACKUP_DIR") (parent of BACKUP_DIR) does not exist"
  case "$DATA_DIR/" in "$APP_DIR"/*) warn "DATA_DIR is inside the application folder: do not delete this folder when updating" ;; esac
  check "$DEPLOY_MODE" '^(tailscale|proxy)$' "DEPLOY_MODE must be tailscale or proxy"
  check "$TS_HOSTNAME" '^[a-z0-9][a-z0-9-]{0,62}$' "TS_HOSTNAME: lower-case letters, digits and dashes"
  [ -z "$TS_AUTHKEY" ] || check "$TS_AUTHKEY" '^tskey-[A-Za-z0-9_-]+$' "TS_AUTHKEY must start with tskey-"
  [ -z "$TS_EXTRA_ARGS" ] || check "$TS_EXTRA_ARGS" '^[A-Za-z0-9 =:,._/-]+$' "TS_EXTRA_ARGS contains unexpected characters"
  check "$TS_FUNNEL" '^(true|false)$' "TS_FUNNEL must be true or false"
  if [ "$APP_BASE_URL" = auto ]; then
    [ "$DEPLOY_MODE" = tailscale ] || die "APP_BASE_URL=auto works only with DEPLOY_MODE=tailscale: set the HTTPS address of your reverse proxy"
  elif [ "$ALLOW_INSECURE_HTTP" = true ]; then
    check "$APP_BASE_URL" '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' "APP_BASE_URL must look like https://team.example.ts.net"
  else
    check "$APP_BASE_URL" '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' "APP_BASE_URL must be https://... (the camera needs HTTPS)"
  fi
  [ -z "$HTTP_BIND" ] || check "$HTTP_BIND" '^(([0-9]{1,3}\.){3}[0-9]{1,3}:)?[0-9]{2,5}$' "HTTP_BIND must be <port> or <ip>:<port>, e.g. 127.0.0.1:8095"
  [ "$DEPLOY_MODE" = tailscale ] || [ -n "$HTTP_BIND" ] || die "DEPLOY_MODE=proxy needs HTTP_BIND (the port your reverse proxy forwards to)"
  check "$TRUST_PROXY" '^(auto|none|loopback|[0-9a-fA-F.:/,]+)$' "TRUST_PROXY must be auto, none or IP addresses"
  [ -z "$EXTRA_ALLOWED_HOSTS" ] || check "$EXTRA_ALLOWED_HOSTS" '^[A-Za-z0-9.:,-]+$' "EXTRA_ALLOWED_HOSTS: host names or ip:port, comma separated"
  check "$CONTAINER_PREFIX" '^[a-z][a-z0-9-]{1,20}$' "CONTAINER_PREFIX: lower-case letters, digits, dashes"
  check "$APP_UID" '^[1-9][0-9]{0,8}$' "APP_UID must be a number other than 0"
  check "$APP_GID" '^[1-9][0-9]{0,8}$' "APP_GID must be a number other than 0"
  [ -z "$CONTAINER_MEMORY" ] || check "$CONTAINER_MEMORY" '^[0-9]+[mMgG]$' "CONTAINER_MEMORY like 512m or 1g (or empty)"
  check "$TAILSCALE_IMAGE" '^[a-z0-9./_-]+:[A-Za-z0-9._-]+$' "TAILSCALE_IMAGE like tailscale/tailscale:v1.104.2"
  check "$BUILD_FROM_SOURCE" '^(auto|yes|no)$' "BUILD_FROM_SOURCE must be auto, yes or no"
  local n
  for n in SESSION_TTL_HOURS SESSION_IDLE_HOURS INVITE_TTL_HOURS BACKUP_RETENTION_DAYS BACKUP_MIN_KEEP APP_BACKUP_RETENTION_DAYS; do
    check "${!n}" '^[0-9]{1,5}$' "$n must be a number"
  done
  check "$LOG_LEVEL" '^(fatal|error|warn|info|debug)$' "LOG_LEVEL must be error, warn, info or debug"
  check "$TZ_NAME" '^[A-Za-z0-9_/+-]+$' "TZ like Asia/Almaty"
  if [ -n "$INITIAL_ADMIN_USERNAME$INITIAL_ADMIN_PASSWORD" ]; then
    [ -n "$INITIAL_ADMIN_USERNAME" ] && [ -n "$INITIAL_ADMIN_PASSWORD" ] || die "set both INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD in .env, or neither"
    check "$INITIAL_ADMIN_USERNAME" '^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$' "INITIAL_ADMIN_USERNAME: 3-40 Latin letters, digits, dot, dash, underscore"
    # The password itself is never printed, not even in error messages.
    [ "${#INITIAL_ADMIN_PASSWORD}" -ge 8 ] || die "INITIAL_ADMIN_PASSWORD must have at least 8 characters"
  fi

  APP_CT="$CONTAINER_PREFIX-app"
  TS_CT="$CONTAINER_PREFIX-tailscale"
}

# The image this installation runs (set by setup/update/rollback; start keeps it).
deployed_image() {
  local img
  img=$(cat "$STATE_DIR/deployed-image" 2>/dev/null || true)
  if [ -n "$img" ]; then printf '%s' "$img"; else printf '%s' "$IMAGE"; fi
}

set_deployed_image() {
  printf '%s\n' "$1" > "$STATE_DIR/deployed-image"
}

# ------------------------------------------------------------------- docker

docker_check() { # $1 = seconds to wait for the daemon (after a reboot)
  command -v docker > /dev/null 2>&1 || die "docker not found. DSM 7.2: Package Center → Container Manager; DSM 6.2: Package Center → Docker"
  local waited=0 v=""
  while :; do
    v=$(docker version --format '{{.Server.Version}}' 2> /dev/null || true)
    [ -n "$v" ] && break
    [ "$waited" -ge "${1:-0}" ] && die "the Docker service does not respond (Package Center → Docker / Container Manager → Run)"
    sleep 10
    waited=$((waited + 10))
  done
  DOCKER_VERSION=$v
  local major=${v%%.*} rest=${v#*.} minor
  minor=${rest%%.*}
  if ! [[ $major =~ ^[0-9]+$ ]] || [ "$major" -lt 20 ] || { [ "$major" -eq 20 ] && [ "${minor:-0}" -lt 10 ] 2> /dev/null; }; then
    die "Docker $v is too old: 20.10 or newer is required (DSM 6.2: install Docker 20.10.3 from the Synology Download Center)"
  fi
  case "$(docker version --format '{{.Server.Arch}}' 2> /dev/null || uname -m)" in
    amd64 | x86_64) ARCH=amd64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *) die "processor architecture $(uname -m) is not supported: only 64-bit x86 (amd64) and 64-bit ARM (arm64)" ;;
  esac
}

ct_exists() { docker container inspect "$1" > /dev/null 2>&1; }
ct_state() { docker container inspect -f '{{.State.Status}}' "$1" 2> /dev/null || echo missing; }
ct_label() { docker container inspect -f "{{ index .Config.Labels \"$2\" }}" "$1" 2> /dev/null || true; }
ct_restarts() { docker container inspect -f '{{.RestartCount}}' "$1" 2> /dev/null || echo 0; }
image_exists() { docker image inspect "$1" > /dev/null 2>&1; }
image_id() { docker image inspect -f '{{.Id}}' "$1" 2> /dev/null || true; }
image_label() { docker image inspect -f "{{ index .Config.Labels \"$2\" }}" "$1" 2> /dev/null || true; }

# Never touch a container with our name that we did not create.
assert_ours() {
  if ct_exists "$1" && [ "$(ct_label "$1" org.teamkz.managed)" != true ]; then
    die "a container named \"$1\" already exists and does not belong to Team Kazakhstan; set another CONTAINER_PREFIX in .env"
  fi
}

hash_of() { printf '%s\n' "$@" | sha256sum | cut -c1-16; }

# Is the host port free (or used by our own container)?
check_port() {
  [ -n "$HTTP_BIND" ] || return 0
  local port=${HTTP_BIND##*:} owner
  owner=$(docker ps --format '{{.Names}} {{.Ports}}' 2> /dev/null | grep -E ":$port->" | awk '{print $1}' | head -n 1 || true)
  if [ -n "$owner" ]; then
    [ "$owner" = "$APP_CT" ] || [ "$owner" = "$TS_CT" ] || die "port $port is already used by the container \"$owner\": choose another HTTP_BIND in .env"
    return 0
  fi
  if command -v netstat > /dev/null 2>&1 && [ "$(netstat -tln 2> /dev/null | awk '{print $4}' | grep -Ec "[:.]$port\$")" -gt 0 ]; then
    die "port $port is already used on the NAS: choose another HTTP_BIND in .env"
  fi
}

ensure_dirs() {
  mkdir -p "$DATA_DIR/app" "$DATA_DIR/tailscale" "$BACKUP_DIR" "$STATE_DIR" "$RUNTIME_DIR/tailscale" "$LOG_DIR" || die "cannot create the data folders"
  chmod 750 "$DATA_DIR" "$DATA_DIR/app"
  chmod 700 "$DATA_DIR/tailscale" "$STATE_DIR" "$RUNTIME_DIR" "$BACKUP_DIR"
  # The app runs as APP_UID:APP_GID and must own its data (bind mount).
  if [ "$(stat -c '%u:%g' "$DATA_DIR/app")" != "$APP_UID:$APP_GID" ] || [ -n "$(find "$DATA_DIR/app" \( ! -user "$APP_UID" -o ! -group "$APP_GID" \) 2> /dev/null | head -n 1)" ]; then
    chown -R "$APP_UID:$APP_GID" "$DATA_DIR/app" || die "cannot change the owner of $DATA_DIR/app"
    ok "owner of $DATA_DIR/app set to $APP_UID:$APP_GID"
  fi
}

# ------------------------------------------------------------------- images

ensure_image() { # makes $IMAGE available: archive from images/ or build from source
  if image_exists "$IMAGE"; then
    ok "image $IMAGE is present"
    return 0
  fi
  local f archive=""
  for f in "$APP_DIR/images/$IMAGE_REPO-$VERSION-linux-$ARCH.tar.gz" "$APP_DIR/images/$IMAGE_REPO-$VERSION-linux-$ARCH.tar"; do
    if [ -f "$f" ]; then
      archive=$f
      break
    fi
  done
  if [ -n "$archive" ] && [ "$BUILD_FROM_SOURCE" != yes ]; then
    # "hash  name" (text mode) or "hash *name" (binary mode) are both valid.
    if [ -f "$APP_DIR/images/SHA256SUMS" ] && grep -qE "[ *]$(basename "$archive")\$" "$APP_DIR/images/SHA256SUMS"; then
      (cd "$APP_DIR/images" && grep -E "[ *]$(basename "$archive")\$" SHA256SUMS | sha256sum -c - > /dev/null) || die "checksum of $(basename "$archive") does not match images/SHA256SUMS: upload the file again"
      ok "checksum of $(basename "$archive") verified"
    fi
    say "loading the image from images/$(basename "$archive") ..."
    docker load -i "$archive" || die "docker load failed"
    image_exists "$IMAGE" || die "the archive does not contain $IMAGE"
    local arch
    arch=$(docker image inspect -f '{{.Architecture}}' "$IMAGE" 2> /dev/null)
    [ "$arch" = "$ARCH" ] || die "the image is for $arch but this NAS is $ARCH: use the linux-$ARCH archive"
    ok "image $IMAGE loaded ($arch)"
  elif [ "$BUILD_FROM_SOURCE" != no ]; then
    [ -f "$APP_DIR/Dockerfile" ] || die "no image archive and no Dockerfile"
    say "no archive images/$IMAGE_REPO-$VERSION-linux-$ARCH.tar: building from source (internet needed, 5-30 minutes on a NAS)..."
    docker build --build-arg "APP_VERSION=$VERSION" -t "$IMAGE" "$APP_DIR" || die "docker build failed (see above)"
    ok "image $IMAGE built"
  else
    die "images/$IMAGE_REPO-$VERSION-linux-$ARCH.tar not found and BUILD_FROM_SOURCE=no"
  fi
}

# -------------------------------------------------------------- containers

write_tailscale_files() {
  mkdir -p "$RUNTIME_DIR/tailscale"
  # TS_FUNNEL=true: the same HTTPS proxy, published through Tailscale Funnel
  # (reachable without the Tailscale app). false: tailnet devices only.
  local serve=serve.json
  [ "$TS_FUNNEL" != true ] || serve=serve-funnel.json
  cp "$APP_DIR/deploy/tailscale/$serve" "$RUNTIME_DIR/tailscale/serve.json" || die "deploy/tailscale/$serve is missing"
  {
    echo "TS_HOSTNAME=$TS_HOSTNAME"
    echo "TS_STATE_DIR=/var/lib/tailscale"
    echo "TS_USERSPACE=true"
    echo "TS_AUTH_ONCE=true"
    echo "TS_SERVE_CONFIG=/config/serve.json"
    [ -z "$TS_EXTRA_ARGS" ] || echo "TS_EXTRA_ARGS=$TS_EXTRA_ARGS"
    [ -z "$TS_AUTHKEY" ] || echo "TS_AUTHKEY=$TS_AUTHKEY"
  } > "$RUNTIME_DIR/tailscale.env"
  chmod 600 "$RUNTIME_DIR/tailscale.env"
}

# Starts the container, or recreates it when its settings (hash) changed.
# Returns 0 if (re)created, 1 if the existing container was kept.
ensure_container() { # name hash image docker-run-args...
  local name=$1 hash=$2 image=$3
  shift 3
  assert_ours "$name"
  if ct_exists "$name"; then
    if [ "$(ct_label "$name" org.teamkz.confighash)" = "$hash" ]; then
      if [ "$(ct_state "$name")" != running ]; then
        say "starting $name"
        docker start "$name" > /dev/null || die "cannot start $name"
      fi
      return 1
    fi
    say "settings or image changed: recreating $name"
    docker rm -f "$name" > /dev/null || die "cannot remove the old $name"
  fi
  docker run -d --label "org.teamkz.confighash=$hash" "$@" "$image" > /dev/null || die "cannot create $name"
  ok "container $name created"
  return 0
}

start_tailscale() {
  write_tailscale_files
  if [ ! -s "$DATA_DIR/tailscale/tailscaled.state" ] && [ -z "$TS_AUTHKEY" ] && ! ct_exists "$TS_CT"; then
    die "first start: TS_AUTHKEY is empty. Tailscale admin console → Settings → Keys → Generate auth key, put it into .env"
  fi
  local args=(--name "$TS_CT" --hostname "$TS_HOSTNAME" --label org.teamkz.managed=true --label org.teamkz.role=tailscale
    --restart unless-stopped --env-file "$RUNTIME_DIR/tailscale.env"
    -v "$DATA_DIR/tailscale:/var/lib/tailscale" -v "$RUNTIME_DIR/tailscale:/config:ro"
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3)
  [ -z "$HTTP_BIND" ] || args+=(-p "$HTTP_BIND:8080")
  local h
  h=$(hash_of "$TAILSCALE_IMAGE" "${args[@]}" "$(cat "$RUNTIME_DIR/tailscale.env")" "$(cat "$RUNTIME_DIR/tailscale/serve.json")")
  if ! image_exists "$TAILSCALE_IMAGE"; then
    say "downloading $TAILSCALE_IMAGE ..."
    docker pull "$TAILSCALE_IMAGE" > /dev/null || die "cannot download $TAILSCALE_IMAGE (internet access of the NAS?)"
  fi
  ensure_container "$TS_CT" "$h" "$TAILSCALE_IMAGE" "${args[@]}" || true
  wait_tailscale
}

wait_tailscale() {
  local i json state
  TS_DNS=""
  for i in $(seq 1 36); do
    json=$(docker exec "$TS_CT" tailscale status --json 2> /dev/null || true)
    state=$(printf '%s\n' "$json" | sed -n 's/^[[:space:]]*"BackendState":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    case $state in
      Running)
        TS_DNS=$(printf '%s\n' "$json" | sed -n 's/^[[:space:]]*"DNSName":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
        TS_DNS=${TS_DNS%.}
        [ -n "$TS_DNS" ] || die "Tailscale is connected but has no DNS name: enable MagicDNS in the Tailscale admin console (DNS)"
        if [[ $json =~ \"CertDomains\":[[:space:]]*null ]]; then
          warn "HTTPS certificates are off in the tailnet: Tailscale admin console → DNS → HTTPS Certificates → Enable"
        fi
        ok "Tailscale connected: $TS_DNS"
        return 0
        ;;
      NeedsMachineAuth)
        die "the machine waits for approval: Tailscale admin console → Machines → $TS_HOSTNAME → Approve, then run the task again"
        ;;
      NeedsLogin)
        [ "$i" -lt 6 ] || die "Tailscale needs a valid auth key: put a new TS_AUTHKEY into .env, run the task again"
        ;;
    esac
    sleep 5
  done
  docker logs --tail 30 "$TS_CT" 2>&1 | sed 's/tskey-[A-Za-z0-9_-]*/tskey-***/g'
  die "Tailscale did not connect within 3 minutes (internet access of the NAS? see the log above)"
}

resolve_runtime() { # base URL and trusted proxy for the app
  if [ "$APP_BASE_URL" = auto ]; then
    RESOLVED_BASE_URL="https://$TS_DNS"
  else
    RESOLVED_BASE_URL=$APP_BASE_URL
    if [ "$DEPLOY_MODE" = tailscale ] && [ -n "${TS_DNS:-}" ] && [ "${APP_BASE_URL#https://}" != "$TS_DNS" ]; then
      warn "APP_BASE_URL ($APP_BASE_URL) differs from the Tailscale name ($TS_DNS): links in invitations use APP_BASE_URL"
    fi
  fi
  if [ "$DEPLOY_MODE" = tailscale ]; then
    RESOLVED_TRUST_PROXY=loopback
  else
    case $TRUST_PROXY in
      none) RESOLVED_TRUST_PROXY="" ;;
      auto) RESOLVED_TRUST_PROXY=$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2> /dev/null || true) ;;
      *) RESOLVED_TRUST_PROXY=$TRUST_PROXY ;;
    esac
  fi
  write_app_env
}

write_app_env() {
  mkdir -p "$RUNTIME_DIR"
  {
    echo "NODE_ENV=production"
    echo "APP_BASE_URL=$RESOLVED_BASE_URL"
    echo "TRUST_PROXY=$RESOLVED_TRUST_PROXY"
    echo "EXTRA_ALLOWED_HOSTS=$EXTRA_ALLOWED_HOSTS"
    echo "SESSION_TTL_HOURS=$SESSION_TTL_HOURS"
    echo "SESSION_IDLE_HOURS=$SESSION_IDLE_HOURS"
    echo "INVITE_TTL_HOURS=$INVITE_TTL_HOURS"
    echo "APP_BACKUP_RETENTION_DAYS=$APP_BACKUP_RETENTION_DAYS"
    echo "LOG_LEVEL=$LOG_LEVEL"
    echo "TZ=$TZ_NAME"
    [ "$ALLOW_INSECURE_HTTP" != true ] || echo "ALLOW_INSECURE_HTTP=true"
  } > "$RUNTIME_DIR/app.env"
  chmod 600 "$RUNTIME_DIR/app.env"
}

app_args() {
  APP_ARGS=(--name "$APP_CT" --label org.teamkz.managed=true --label org.teamkz.role=app
    --restart unless-stopped --user "$APP_UID:$APP_GID" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 256
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3
    --env-file "$RUNTIME_DIR/app.env" -v "$DATA_DIR/app:/data")
  [ -z "$CONTAINER_MEMORY" ] || APP_ARGS+=(--memory "$CONTAINER_MEMORY")
  if [ "$DEPLOY_MODE" = tailscale ]; then
    APP_ARGS+=(--network "container:$TS_CT")
  else
    APP_ARGS+=(-p "$HTTP_BIND:8080")
  fi
}

# Health inside the container, then the path the users take (via the proxy).
wait_app() { # seconds
  local i restarts0
  restarts0=$(ct_restarts "$APP_CT")
  for i in $(seq 1 $((${1:-120} / 3))); do
    if [ "$(ct_restarts "$APP_CT")" -gt "$((restarts0 + 1))" ] || [ "$(ct_state "$APP_CT")" = exited ]; then
      docker logs --tail 40 "$APP_CT" 2>&1
      say "the application stops right after the start (log above)"
      return 1
    fi
    if docker exec "$APP_CT" node dist/server/healthcheck.js > /dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  docker logs --tail 40 "$APP_CT" 2>&1
  return 1
}

proxy_path_ok() {
  if [ "$DEPLOY_MODE" = tailscale ]; then
    docker exec "$TS_CT" wget -q -T 5 -O /dev/null http://127.0.0.1:8080/api/health > /dev/null 2>&1
  else
    local port=${HTTP_BIND##*:}
    curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$port/api/health" > /dev/null 2>&1
  fi
}

# Creates/starts everything for the given image; idempotent.
deploy_all() { # image
  local image=$1 h extra=""
  # Refuse before changing anything if a foreign container has one of our names.
  assert_ours "$APP_CT"
  assert_ours "$TS_CT"
  ensure_dirs
  check_port
  if [ "$DEPLOY_MODE" = tailscale ]; then
    start_tailscale
    extra=$(docker container inspect -f '{{.Id}}' "$TS_CT")
  else
    TS_DNS=""
    if ct_exists "$TS_CT"; then
      assert_ours "$TS_CT"
      say "DEPLOY_MODE=proxy: removing the Tailscale container of this app ($TS_CT)"
      docker rm -f "$TS_CT" > /dev/null
    fi
  fi
  resolve_runtime
  app_args
  # The Tailscale container id is part of the hash: when it is recreated, the
  # app (sharing its network) is recreated too.
  h=$(hash_of "$(image_id "$image")" "${APP_ARGS[@]}" "$(cat "$RUNTIME_DIR/app.env")" "$extra")
  ensure_container "$APP_CT" "$h" "$image" --label "org.teamkz.version=$(image_label "$image" org.opencontainers.image.version)" "${APP_ARGS[@]}" || true
  say "waiting for the application ..."
  wait_app 150 || die "the application did not become healthy; nothing else was changed. See the log above and README_RU.md, \"Диагностика\""
  if ! proxy_path_ok; then
    say "the application answers, but not through $([ "$DEPLOY_MODE" = tailscale ] && echo Tailscale || echo "port $HTTP_BIND"); restarting it once"
    docker restart "$APP_CT" > /dev/null
    wait_app 90 && proxy_path_ok || die "the application is not reachable through $([ "$DEPLOY_MODE" = tailscale ] && echo Tailscale || echo "$HTTP_BIND")"
  fi
  printf '%s\n' "$RESOLVED_BASE_URL" > "$STATE_DIR/base-url"
  ok "Team Kazakhstan $(image_label "$image" org.opencontainers.image.version) is running: $RESOLVED_BASE_URL"
}

stop_containers() {
  local c
  for c in "$APP_CT" "$TS_CT"; do
    if ct_exists "$c"; then
      assert_ours "$c"
      if [ "$(ct_state "$c")" = running ]; then
        docker stop -t 20 "$c" > /dev/null && ok "stopped $c"
      fi
    fi
  done
}

# ------------------------------------------------------- CLI in the container

# Runs the app CLI: inside the running container, otherwise in a temporary
# container of the deployed image without network (for restore, offline backup).
app_cli() { # args...
  if [ "$(ct_state "$APP_CT")" = running ]; then
    docker exec "$APP_CT" node dist/server/cli.js "$@"
  else
    app_cli_oneoff "$(deployed_image)" "" "$@"
  fi
}

app_cli_oneoff() { # image extra-mount(-v spec or "") args...
  local image=$1 mount=$2
  shift 2
  if [ ! -f "$RUNTIME_DIR/app.env" ]; then
    # Never deployed yet (e.g. restore on a clean NAS before setup): the
    # address only matters for links, which these commands do not create.
    RESOLVED_BASE_URL=$APP_BASE_URL
    [ "$APP_BASE_URL" != auto ] || RESOLVED_BASE_URL=$(cat "$STATE_DIR/base-url" 2> /dev/null || echo "https://$TS_HOSTNAME.invalid")
    RESOLVED_TRUST_PROXY=""
    write_app_env
  fi
  local extra=()
  [ -z "$mount" ] || extra=(-v "$mount")
  docker run --rm --network none --user "$APP_UID:$APP_GID" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --cap-drop ALL --security-opt no-new-privileges --env-file "$RUNTIME_DIR/app.env" \
    -v "$DATA_DIR/app:/data" ${extra[@]+"${extra[@]}"} "$image" node dist/server/cli.js "$@"
}

# ------------------------------------------------------------------ backups

# Consistent backup through the app (SQLite VACUUM INTO + referenced photos),
# moved to BACKUP_DIR, checked, optionally copied to BACKUP_COPY_DIR.
# Sets BACKUP_RESULT to the archive path.
do_backup() { # reason
  local reason=$1 out inner name target sum copy_state=off
  out=$(app_cli backup --out /data/backups --reason "$reason" 2>&1)
  local rc=$?
  printf '%s\n' "$out" | grep -v '^BACKUP_FILE=' | sed 's/^/      /'
  [ $rc -eq 0 ] || die "backup failed (exit code $rc)"
  inner=$(printf '%s\n' "$out" | sed -n 's/^BACKUP_FILE=//p' | tail -n 1)
  name=$(basename "$inner")
  [[ $name =~ ^team-kz-backup-[0-9]{8}-[0-9]{6}-[a-z0-9-]+\.tar\.gz$ ]] || die "unexpected backup name: $name"
  [ -f "$DATA_DIR/app/backups/$name" ] || die "backup file not found: $DATA_DIR/app/backups/$name"
  mkdir -p "$BACKUP_DIR"
  target="$BACKUP_DIR/$name"
  mv "$DATA_DIR/app/backups/$name" "$target.partial" && mv "$target.partial" "$target" || die "cannot move the backup to $BACKUP_DIR"
  chown 0:0 "$target" 2> /dev/null || true
  chmod 600 "$target"
  gzip -t "$target" || die "the backup archive is damaged: $target"
  # grep -c reads the whole listing: with pipefail, grep -q could kill tar (SIGPIPE).
  [ "$(tar -tzf "$target" 2> /dev/null | grep -c '^manifest.json$')" -ge 1 ] || die "the backup archive has no manifest: $target"
  sum=$(sha256sum "$target" | cut -d' ' -f1)
  printf '%s  %s\n' "$sum" "$name" > "$target.sha256"
  chmod 600 "$target.sha256"
  ok "backup $target ($(wc -c < "$target") bytes, sha256 ${sum:0:16}...)"
  prune_backups "$BACKUP_DIR"

  if [ -n "$BACKUP_COPY_DIR" ]; then
    if [ -d "$BACKUP_COPY_DIR" ] && [ -w "$BACKUP_COPY_DIR" ]; then
      if cp "$target" "$BACKUP_COPY_DIR/$name.partial" && mv "$BACKUP_COPY_DIR/$name.partial" "$BACKUP_COPY_DIR/$name" && cp "$target.sha256" "$BACKUP_COPY_DIR/"; then
        (cd "$BACKUP_COPY_DIR" && sha256sum -c "$name.sha256" > /dev/null) && copy_state=ok || copy_state=failed
      else
        copy_state=failed
      fi
      if [ $copy_state = ok ]; then
        ok "second copy: $BACKUP_COPY_DIR/$name"
        prune_backups "$BACKUP_COPY_DIR"
      else
        warn "the second copy to $BACKUP_COPY_DIR failed"
      fi
    else
      copy_state=failed
      warn "BACKUP_COPY_DIR=$BACKUP_COPY_DIR is not available (disk not connected / share not mounted?)"
    fi
  fi
  printf '{"at":"%s","file":"%s","size":%s,"sha256":"%s","secondCopy":"%s"}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$name" "$(wc -c < "$target")" "$sum" "$copy_state" > "$DATA_DIR/app/.last-host-backup.json"
  chown "$APP_UID:$APP_GID" "$DATA_DIR/app/.last-host-backup.json" 2> /dev/null || true
  BACKUP_RESULT=$target
  BACKUP_COPY_STATE=$copy_state
}

# Keeps the BACKUP_MIN_KEEP newest archives; older ones are removed after
# BACKUP_RETENTION_DAYS days.
prune_backups() { # dir
  local dir=$1 n=0 f
  for f in $(ls -1t "$dir"/team-kz-backup-*.tar.gz 2> /dev/null); do
    n=$((n + 1))
    [ "$n" -le "$BACKUP_MIN_KEEP" ] && continue
    if [ -n "$(find "$f" -mtime +"$BACKUP_RETENTION_DAYS" 2> /dev/null)" ]; then
      rm -f "$f" "$f.sha256"
      say "removed old backup $(basename "$f")"
    fi
  done
}

# ------------------------------------------------------- one-time links

# The link goes to ADMIN-LINK.txt next to .env, never into the logs. It works
# once and expires (60 minutes); the watchdog deletes the file after 2 hours.
write_admin_link() { # cli-args...
  local out link file="$APP_DIR/ADMIN-LINK.txt"
  if ! out=$(app_cli "$@" 2>&1); then
    printf '%s\n' "$out"
    die "the link could not be created"
  fi
  link=$(printf '%s\n' "$out" | grep -E '^https?://' | tail -n 1)
  [ -n "$link" ] || die "the application returned no link"
  {
    echo "Team Kazakhstan — one-time link, created $(date '+%Y-%m-%d %H:%M')"
    printf '%s\n' "$out" | grep -v -E '^https?://'
    echo
    echo "$link"
    echo
    echo "Open it on the phone or computer where you will sign in (with Tailscale connected)."
    echo "It works once. Delete this file after use; it is removed automatically after 2 hours."
  } > "$file"
  chmod 640 "$file"
  chgrp administrators "$file" 2> /dev/null || true
  ok "one-time link written to $file (open it in File Station; it is not in the logs)"
}

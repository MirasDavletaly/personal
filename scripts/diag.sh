#!/bin/bash
# Team Kazakhstan — diagnostics. Read-only: changes nothing on the NAS.
#   bash /volume1/docker/team-kz/scripts/diag.sh
# Writes logs/diag-<time>.txt (secrets masked) with: DSM, CPU architecture,
# Docker, existing containers and ports, the NAS's own Tailscale, Task
# Scheduler jobs, and the state of this installation. Send this file when
# asking for help.

TKZ_SCRIPT_NAME=diag
. "$(dirname "$0")/lib.sh"

mkdir -p "$LOG_DIR"
out="$LOG_DIR/diag-$(date '+%Y%m%d-%H%M%S').txt"
mask() { sed -E 's/tskey-[A-Za-z0-9_-]+/tskey-***/g; s/((AUTHKEY|PASSWORD|SECRET|TOKEN)[A-Z_]*=).*/\1***/; s/(token=)[A-Za-z0-9_-]{8,}/\1***/g'; }
section() { printf '\n===== %s =====\n' "$*"; }
run() { printf '$ %s\n' "$*"; "$@" 2>&1 | head -n "${LINES_MAX:-60}"; }

{
  section "time and system"
  date
  [ "$(id -u)" = 0 ] || echo "NOTE: not running as root; some checks are limited"
  cat /etc.defaults/VERSION 2> /dev/null | grep -E '^(productversion|buildnumber|smallfixnumber|majorversion|minorversion)='
  cat /proc/sys/kernel/syno_hw_version 2> /dev/null && echo
  run uname -a
  echo "architecture: $(uname -m)"
  grep -m1 -E 'model name|Hardware' /proc/cpuinfo 2> /dev/null
  grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2> /dev/null
  echo "bash: $BASH_VERSION"

  section "Docker (only plain docker is used by these scripts)"
  echo "docker: $(command -v docker || echo NOT FOUND)"
  run docker version --format 'client {{.Client.Version}}, server {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'
  run docker info --format 'kernel {{.KernelVersion}}; os {{.OperatingSystem}}; storage {{.Driver}}; cgroup {{.CgroupVersion}}; cpus {{.NCPU}}; mem {{.MemTotal}}'
  echo "docker compose v2: $(docker compose version --short 2> /dev/null || echo 'not available (not needed)')"
  echo "docker-compose v1: $(docker-compose version --short 2> /dev/null || echo 'not available (not needed)')"
  for p in ContainerManager Docker Tailscale; do [ -d "/var/packages/$p" ] && echo "DSM package present: $p"; done

  section "all containers on the NAS (read-only listing)"
  run docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  section "Docker networks"
  run docker network ls

  section "listening TCP ports"
  if command -v netstat > /dev/null 2>&1; then LINES_MAX=80 run netstat -tln; elif command -v ss > /dev/null 2>&1; then LINES_MAX=80 run ss -tln; fi

  section "Tailscale of the NAS itself (read-only)"
  ts_host=$(command -v tailscale 2> /dev/null || ls /var/packages/Tailscale/target/bin/tailscale 2> /dev/null || true)
  if [ -n "$ts_host" ]; then
    run "$ts_host" version
    LINES_MAX=40 run "$ts_host" status
    run "$ts_host" serve status
    run "$ts_host" funnel status
  else
    echo "no Tailscale package on the NAS (the app uses its own Tailscale container anyway)"
  fi

  section "Task Scheduler jobs (names and commands)"
  if [ -x /usr/syno/bin/synoschedtask ]; then
    /usr/syno/bin/synoschedtask --get 2> /dev/null | grep -E '^\s*(ID|Name|State|Owner|Command|Cmd)' | head -n 120
  else
    grep -v '^#' /etc/crontab 2> /dev/null | head -n 40
  fi

  section "this installation"
  echo "app dir: $APP_DIR, package version: $VERSION"
  if [ -f "$ENV_FILE" ]; then
    echo "--- .env (secrets masked)"
    grep -vE '^\s*(#|$)' "$ENV_FILE" | tr -d '\r'
  else
    echo ".env is missing"
  fi
  echo "--- state"
  for f in deployed-image previous-image pre-update-backup base-url STOPPED; do
    [ -e "$STATE_DIR/$f" ] && echo "$f: $(cat "$STATE_DIR/$f" 2> /dev/null)"
  done
  [ -d "$LOCK_DIR" ] && echo "lock held by: $(cat "$LOCK_DIR/owner" 2> /dev/null) pid $(cat "$LOCK_DIR/pid" 2> /dev/null)"
  if [ -f "$ENV_FILE" ] && (load_config) > /dev/null 2>&1; then
    load_config
    echo "--- folders"
    for d in "$DATA_DIR" "$DATA_DIR/app" "$DATA_DIR/tailscale" "$BACKUP_DIR" "${BACKUP_COPY_DIR:-}"; do
      [ -n "$d" ] || continue
      if [ -d "$d" ]; then echo "$(stat -c '%U:%G %a' "$d" 2> /dev/null) $d"; else echo "missing: $d"; fi
    done
    df -h "$APP_DIR" "$(dirname "$DATA_DIR")" "$(dirname "$BACKUP_DIR")" 2> /dev/null
    echo "--- newest backups"
    ls -lt "$BACKUP_DIR" 2> /dev/null | head -n 6
    for c in "$APP_CT" "$TS_CT"; do
      echo "--- container $c"
      if ct_exists "$c"; then
        docker container inspect -f 'image={{.Config.Image}} state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}} managed={{index .Config.Labels "org.teamkz.managed"}}' "$c"
        LINES_MAX=40 run docker logs --tail 40 "$c"
      else
        echo "not created"
      fi
    done
    if [ "$(ct_state "$TS_CT")" = running ]; then
      echo "--- Tailscale of this app"
      LINES_MAX=20 run docker exec "$TS_CT" tailscale status
      run docker exec "$TS_CT" tailscale serve status
      echo "(Funnel must be off: the directory is not public)"
      run docker exec "$TS_CT" tailscale funnel status
    fi
    echo "--- reachability"
    if [ "$(ct_state "$APP_CT")" = running ]; then
      docker exec "$APP_CT" node dist/server/healthcheck.js > /dev/null 2>&1 && echo "inside the container: OK" || echo "inside the container: FAILED"
      proxy_path_ok && echo "through $DEPLOY_MODE: OK" || echo "through $DEPLOY_MODE: FAILED"
      run docker exec "$APP_CT" node dist/server/cli.js status
    fi
  else
    echo ".env could not be read: $( (load_config) 2>&1 | tail -n 1)"
  fi
} 2>&1 | mask > "$out"

cat "$out"
echo
echo "diagnostics saved to $out"

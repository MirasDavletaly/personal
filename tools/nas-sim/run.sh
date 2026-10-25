#!/bin/bash
# NAS simulation (dev only): runs the real scripts/*.sh against a fake docker
# (tools/nas-sim/bin/docker) and the real build in dist/. Needs: npm run build.
#   bash tools/nas-sim/run.sh [path/to/image.tar]
# Verifies the script logic (order, locks, markers, backups, restore, update,
# rollback, error messages). It does not verify Docker itself.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SIM=$(mktemp -d)
export SIM_ROOT=$SIM SIM_APP_SRC=$ROOT
IMAGE_TAR=${1:-}
mkdir -p "$SIM/bin"
cp "$ROOT/tools/nas-sim/bin/docker" "$SIM/bin/docker"
printf '#!/bin/bash\n[ "${1:-}" = -u ] && echo 0 || /usr/bin/id "$@"\n' > "$SIM/bin/id"
printf '#!/bin/bash\nexit 0\n' > "$SIM/bin/chown"
printf '#!/bin/bash\nexit 0\n' > "$SIM/bin/chgrp"
printf '#!/bin/bash\necho "Proto Recv-Q Send-Q Local Address Foreign Address State"\n[ -n "${SIM_BUSY_PORT:-}" ] && echo "tcp 0 0 0.0.0.0:$SIM_BUSY_PORT 0.0.0.0:* LISTEN"\nexit 0\n' > "$SIM/bin/netstat"
chmod +x "$SIM/bin/"*
export PATH="$SIM/bin:$PATH"

APP="$SIM/volume1/docker/team-kz"
DATA="$SIM/volume1/docker/team-kz-data"
BK="$SIM/volume1/docker/team-kz-backups"
mkdir -p "$APP/images" "$SIM/usb"
cp -r "$ROOT/scripts" "$ROOT/deploy" "$ROOT/VERSION" "$ROOT/.env.example" "$ROOT/Dockerfile" "$APP/"
if [ -n "$IMAGE_TAR" ]; then
  cp "$IMAGE_TAR" "$APP/images/"
  (cd "$APP/images" && sha256sum "$(basename "$IMAGE_TAR")" > SHA256SUMS)
fi
cleanup() {
  for c in "$SIM"/docker-state/containers/*; do [ -s "$c/pid" ] && kill "$(cat "$c/pid")" 2> /dev/null; done
}
trap cleanup EXIT
PORT=$((18500 + RANDOM % 300))
link=""

write_env() {
  cat > "$APP/.env" << EOF
# simulated NAS (edited on Windows: CRLF line endings)
DATA_DIR=$DATA
BACKUP_DIR=$BK
BACKUP_COPY_DIR=$SIM/usb
DEPLOY_MODE=${1:-tailscale}
TS_HOSTNAME=team
TS_AUTHKEY=tskey-auth-SIMULATEDSECRET123
APP_BASE_URL=${2:-auto}
HTTP_BIND="127.0.0.1:$PORT"   # quoted with a comment
CONTAINER_PREFIX=${3:-teamkz}
BACKUP_RETENTION_DAYS=30
BACKUP_MIN_KEEP=7
EOF
  sed -i 's/$/\r/' "$APP/.env"
}
write_env

pass=0
failn=0
OUT=""
step() { # name expected-rc command...
  local name=$1 want=$2
  shift 2
  # Output via a file, not $(...): the app process started by the fake docker
  # keeps inherited pipe handles open on Windows, so $(...) would never end.
  "$@" > "$SIM/step.out" 2>&1
  local rc=$?
  sleep 1 # let tee inside the scripts flush the last lines
  OUT=$(cat "$SIM/step.out")
  if [ "$rc" = "$want" ]; then
    pass=$((pass + 1))
    echo "  ok   $name"
  else
    failn=$((failn + 1))
    echo "  FAIL $name (exit $rc, expected $want)"
    printf '%s\n' "$OUT" | tail -n 25 | sed 's/^/       | /'
  fi
}
expect() { # name grep-pattern [text]
  if printf '%s\n' "${3:-$OUT}" | grep -qE -- "$2"; then
    pass=$((pass + 1))
    echo "  ok   $1"
  else
    failn=$((failn + 1))
    echo "  FAIL $1: no /$2/"
    printf '%s\n' "${3:-$OUT}" | tail -n 15 | sed 's/^/       | /'
  fi
}
reject() { # name grep-pattern text
  if printf '%s\n' "$3" | grep -qE -- "$2"; then
    failn=$((failn + 1))
    echo "  FAIL $1: found /$2/"
  else
    pass=$((pass + 1))
    echo "  ok   $1"
  fi
}
appport() { cat "$SIM/docker-state/containers/teamkz-app/port"; }
api() { # method path json
  curl -s -X "$1" "http://127.0.0.1:$(appport)$2" -H "Host: team.tail81e59e.ts.net" -H 'x-requested-with: team-kz' -H 'content-type: application/json' --data "$3"
}
sh_() { bash "$APP/scripts/$1" "${@:2}"; }

echo "== NAS simulation in $SIM (port $PORT)"

echo "-- configuration errors"
mv "$APP/.env" "$APP/.env.off"
step "setup without .env refuses" 1 sh_ setup.sh
expect "explains .env" "copy .env.example to .env"
mv "$APP/.env.off" "$APP/.env"
sed -i 's#^APP_BASE_URL=auto#APP_BASE_URL=http://team.example#' "$APP/.env"
step "http base URL refused" 1 sh_ setup.sh
expect "explains https" "must be https"
write_env
SIM_DOCKER_VERSION=19.03.15 step "old Docker refused" 1 sh_ setup.sh
expect "explains Docker version" "too old"

echo "-- first installation"
step "setup.sh" 0 sh_ setup.sh
if [ -n "$IMAGE_TAR" ]; then
  expect "archive checksum verified" "checksum of .* verified"
  expect "image loaded from the archive" "image team-kazakhstan:1.0.0 loaded \(amd64\)"
else
  expect "built from source (no archive)" "building from source"
fi
expect "tailscale connected" "Tailscale connected: team.tail81e59e.ts.net"
expect "app running at the Tailscale address" "is running: https://team.tail81e59e.ts.net"
expect "admin link written" "one-time link written"
[ -f "$APP/ADMIN-LINK.txt" ] && link=$(grep -E '^https://' "$APP/ADMIN-LINK.txt")
expect "link points to /setup" "^https://team.tail81e59e.ts.net/setup#token=" "${link:-}"
reject "no token in setup.log" "token=" "$(cat "$APP/logs/setup.log")"
reject "no auth key in logs" "SIMULATEDSECRET" "$(cat "$APP/logs/"*.log)"
expect "auth key only in the tailscale env file" "SIMULATEDSECRET" "$(cat "$APP/state/runtime/tailscale.env")"
reject "auth key not in the app env file" "SIMULATEDSECRET" "$(cat "$APP/state/runtime/app.env")"
expect "app trusts only loopback" "^TRUST_PROXY=loopback" "$(cat "$APP/state/runtime/app.env")"
expect "app runs read-only, non-root, no capabilities" "--read-only.*--cap-drop ALL" "$(grep 'run -d' "$SIM/docker-state/calls.log" | grep team-kazakhstan | tail -n 1)"
expect "app shares the tailscale network" "--network container:teamkz-tailscale" "$(grep 'run -d' "$SIM/docker-state/calls.log" | grep team-kazakhstan | tail -n 1)"

token=${link#*token=}
r=$(api POST /api/invites/accept "{\"token\":\"$token\",\"username\":\"miras\",\"displayName\":\"Miras\",\"password\":\"correct horse battery staple\"}")
expect "administrator created with the link" '"role":"admin"' "$r"

step "setup.sh again is idempotent" 0 sh_ setup.sh
expect "image kept" "image team-kazakhstan:1.0.0 is present"
reject "containers not recreated" "recreating" "$OUT"
expect "admin exists" "administrator account exists"

echo "-- Funnel on / off"
step "funnel.sh on" 0 sh_ funnel.sh on
expect "TS_FUNNEL written to .env" "TS_FUNNEL=true written to .env"
expect ".env has TS_FUNNEL=true" "^TS_FUNNEL=true" "$(tr -d '\r' < "$APP/.env")"
expect "serve config publishes through Funnel" '"AllowFunnel"' "$(cat "$APP/state/runtime/tailscale/serve.json")"
expect "tailscale container recreated" "recreating teamkz-tailscale"
expect "public address reported" "opens without Tailscale"
expect "warns about long passwords" "long password"
r=$(curl -s -X POST "http://127.0.0.1:$(appport)/api/auth/login" -H "Host: team.tail81e59e.ts.net" -H 'x-requested-with: team-kz' -H 'content-type: application/json' --data '{"username":"miras","password":"correct horse battery staple"}')
expect "data kept, admin signs in after the switch" '"role":"admin"' "$r"
step "funnel.sh off" 0 sh_ funnel.sh off
reject "serve config private again" '"AllowFunnel"' "$(cat "$APP/state/runtime/tailscale/serve.json")"
expect "tailnet only reported" "opens only on devices with Tailscale"
step "funnel.sh status" 0 sh_ funnel.sh status
write_env

echo "-- locking"
( sh_ start.sh > "$SIM/p1.txt" 2>&1 ) &
sleep 0.3
( sh_ start.sh > "$SIM/p2.txt" 2>&1 ) &
wait
expect "second start refused while the first runs" "another operation is running" "$(cat "$SIM/p1.txt" "$SIM/p2.txt")"

echo "-- backup"
step "backup.sh" 0 sh_ backup.sh
expect "backup written" "OK    backup $BK/team-kz-backup-"
expect "second copy" "second copy: $SIM/usb/"
ls "$BK"/*.tar.gz > /dev/null 2>&1 && ls "$BK"/*.sha256 > /dev/null 2>&1
expect "archive and sha256 present" "tar.gz.sha256" "$(ls "$BK")"
expect "status for the admin panel" '"secondCopy":"ok"' "$(cat "$DATA/app/.last-host-backup.json")"
(cd "$BK" && sha256sum -c ./*.sha256 > /dev/null 2>&1)
step "sha256 verifies" 0 bash -c "cd '$BK' && sha256sum -c *.sha256"

echo "-- stop / boot / watchdog"
step "stop.sh" 0 sh_ stop.sh
expect "STOPPED marker" "STOPPED" "$(ls "$APP/state")"
step "boot task respects stop.sh" 0 sh_ start.sh --boot
expect "not started" "stopped on purpose"
step "watchdog silent while stopped" 0 sh_ start.sh --check
step "start.sh" 0 sh_ start.sh
expect "running again" "is running"
reject "STOPPED removed" "STOPPED" "$(ls "$APP/state")"
kill "$(cat "$SIM/docker-state/containers/teamkz-app/pid")" 2> /dev/null
sleep 1
step "watchdog repairs a crashed app" 0 sh_ start.sh --check
expect "repair logged" "repairing" "$(cat "$APP/logs/watchdog.log")"
before=$(wc -l < "$APP/logs/watchdog.log")
step "watchdog silent when healthy" 0 sh_ start.sh --check
expect "watchdog log unchanged" "^$before\$" "$(wc -l < "$APP/logs/watchdog.log")"

echo "-- restore"
step "restore refuses to overwrite data" 1 sh_ restore.sh --latest
expect "explains --yes-overwrite" "yes-overwrite"
step "restore --yes-overwrite" 0 sh_ restore.sh --latest --yes-overwrite
expect "restored" "restored from team-kz-backup-"
expect "safety backup before restore" "pre-restore"
r=$(curl -s -X POST "http://127.0.0.1:$(appport)/api/auth/login" -H "Host: team.tail81e59e.ts.net" -H 'x-requested-with: team-kz' -H 'content-type: application/json' --data '{"username":"miras","password":"correct horse battery staple"}')
expect "admin can sign in after restore" '"role":"admin"' "$r"

echo "-- update and rollback"
echo 1.0.1 > "$APP/VERSION"
step "update.sh" 0 sh_ update.sh
expect "backup before migrations" "backup of the installed version"
expect "recreated with the new image" "recreating teamkz-app"
expect "deployed 1.0.1" "team-kazakhstan:1.0.1" "$(cat "$APP/state/deployed-image")"
expect "previous recorded" "team-kazakhstan:1.0.0" "$(cat "$APP/state/previous-image")"
step "rollback needs --yes" 1 sh_ rollback.sh
step "rollback.sh --yes" 0 sh_ rollback.sh --yes
expect "back on 1.0.0" "team-kazakhstan:1.0.0" "$(cat "$APP/state/deployed-image")"
step "start keeps the rolled-back version" 0 sh_ start.sh
reject "no switch to the package version" "recreating" "$OUT"
echo 1.0.0 > "$APP/VERSION"

echo "-- links, demo data, diagnostics"
step "admin-link.sh --reset" 0 sh_ admin-link.sh --reset miras
expect "reset link" "/invite#token=" "$(cat "$APP/ADMIN-LINK.txt")"
step "demo data needs a flag" 1 sh_ demo-data.sh
step "demo-data.sh --yes" 0 sh_ demo-data.sh --yes
expect "loaded" "demo data loaded"
step "diag.sh" 0 sh_ diag.sh
reject "diag masks the auth key" "SIMULATEDSECRET" "$OUT"
expect "diag shows funnel status" "funnel status"
expect "diag shows the app status" "schema version"
expect "diag shows restart times" "restarts and outages"
expect "diag shows the watchdog log" "logs/start.log"

echo "-- conflicts with other services"
mkdir -p "$SIM/docker-state/containers/kzit"
printf 'tailscale\n' > "$SIM/docker-state/containers/kzit/kind"
printf 'running\n' > "$SIM/docker-state/containers/kzit/state"
printf '127.0.0.1:%s:8080\n' $((PORT + 1)) > "$SIM/docker-state/containers/kzit/ports"
: > "$SIM/docker-state/containers/kzit/labels"
: > "$SIM/docker-state/containers/kzit/vols"
printf '\n' > "$SIM/docker-state/containers/kzit/net"
sed -i "s#127.0.0.1:$PORT\"#127.0.0.1:$((PORT + 1))\"#" "$APP/.env"
step "port of another container refused" 1 sh_ start.sh
expect "names the other container" 'already used by the container "kzit"'
write_env
# A port held by a non-Docker process (our own container's port is fine).
sed -i "s#127.0.0.1:$PORT\"#127.0.0.1:$((PORT + 2))\"#" "$APP/.env"
SIM_BUSY_PORT=$((PORT + 2)) step "port used outside Docker refused" 1 sh_ start.sh
expect "explains the port" "already used on the NAS"
write_env
cp -r "$SIM/docker-state/containers/kzit" "$SIM/docker-state/containers/other-app"
write_env tailscale auto other
sed -i "s#127.0.0.1:$PORT\"#127.0.0.1:$((PORT + 3))\"#" "$APP/.env"
step "foreign container with our name refused" 1 sh_ start.sh
expect "does not belong" "does not belong to Team Kazakhstan"
rm -rf "$SIM/docker-state/containers/other-app" "$SIM/docker-state/containers/other-tailscale"
write_env

echo "-- proxy mode"
write_env proxy https://team.company.kz
step "start in proxy mode" 0 sh_ start.sh
expect "tailscale container removed" "removing the Tailscale container"
expect "address from .env" "is running: https://team.company.kz"
expect "trusts the bridge gateway" "^TRUST_PROXY=172.17.0.1" "$(cat "$APP/state/runtime/app.env")"
step "health on the published port" 0 curl -fsS "http://127.0.0.1:$PORT/api/health"
write_env

echo "-- first administrator from .env (clean data folder)"
step "stop before the clean installation" 0 sh_ stop.sh --remove
DATA2="$SIM/volume1/docker/team-kz-data2"
write_env
sed -i "s#^DATA_DIR=.*#DATA_DIR=$DATA2\r#" "$APP/.env"
printf 'INITIAL_ADMIN_USERNAME=Miras\r\nINITIAL_ADMIN_PASSWORD=Probe8ch\r\n' >> "$APP/.env"
rm -f "$APP/ADMIN-LINK.txt"
step "setup.sh with INITIAL_ADMIN_*" 0 sh_ setup.sh
expect "administrator created from .env" "administrator Miras created from .env"
expect "asks to remove the password from .env" "remove INITIAL_ADMIN_PASSWORD"
reject "no one-time link needed" "one-time link written" "$OUT"
reject "the password is in no log" "Probe8ch" "$(cat "$APP/logs/"*.log)"
r=$(curl -s -X POST "http://127.0.0.1:$(appport)/api/auth/login" -H "Host: team.tail81e59e.ts.net" -H 'x-requested-with: team-kz' -H 'content-type: application/json' --data '{"username":"Miras","password":"Probe8ch"}')
expect "Miras signs in as administrator" '"username":"miras".*"role":"admin"' "$r"
step "setup.sh again" 0 sh_ setup.sh
expect "admin exists" "administrator account exists"
expect "reminds to remove the password" "INITIAL_ADMIN_PASSWORD is still in .env"
write_env

echo "-- stop --remove"
step "stop.sh --remove" 0 sh_ stop.sh --remove
reject "containers removed" "teamkz" "$(ls "$SIM/docker-state/containers")"
expect "data kept" "team-kz.sqlite" "$(ls "$DATA/app")"

cleanup
echo "== passed: $pass, failed: $failn (logs: $APP/logs)"
[ "$failn" = 0 ]

#!/bin/bash
# Team Kazakhstan — first installation on the NAS (safe to run again).
#
# Task Scheduler → Create → Scheduled Task → User-defined script, User: root,
# disabled schedule, run with "Run":
#   bash /volume1/docker/team-kz/scripts/setup.sh
#
# Checks Docker and .env, creates the data folders, loads the image archive
# from images/ (or builds from source), starts Tailscale and the app, and
# writes the one-time administrator link to ADMIN-LINK.txt.
#   --prepare-only   only checks and folders (for the Compose variant)

TKZ_SCRIPT_NAME=setup
. "$(dirname "$0")/lib.sh"

log_init setup
require_root
load_config
docker_check 60
acquire_lock 0 || die "wait until it has finished and run the task again"

say "Docker $DOCKER_VERSION, architecture $ARCH, mode $DEPLOY_MODE"
say "application: $APP_DIR"
say "data:        $DATA_DIR"
say "backups:     $BACKUP_DIR"

if [ "${1:-}" = --prepare-only ]; then
  ensure_dirs
  check_port
  ok "folders prepared; continue with docker compose (see compose.yaml)"
  exit 0
fi

installed=$(cat "$STATE_DIR/deployed-image" 2> /dev/null || true)
if [ -n "$installed" ] && [ "$installed" != "$IMAGE" ]; then
  die "$installed is installed; to install $IMAGE use scripts/update.sh (it makes a backup before the database migrations)"
fi

ensure_image
deploy_all "$IMAGE"
set_deployed_image "$IMAGE"
rm -f "$STATE_DIR/STOPPED"

admins=$(app_cli status 2>&1 | sed -n 's/^administrators:[[:space:]]*//p')
if [ "${admins:-0}" = 0 ] && [ -n "$INITIAL_ADMIN_USERNAME" ]; then
  # First administrator from .env (INITIAL_ADMIN_*): the password goes to the
  # app through stdin, never into arguments or logs.
  if printf '%s' "$INITIAL_ADMIN_PASSWORD" | docker exec -i "$APP_CT" node dist/server/cli.js create-admin --if-none --password-stdin \
    --username "$INITIAL_ADMIN_USERNAME" --display-name "$INITIAL_ADMIN_USERNAME"; then
    ok "administrator $INITIAL_ADMIN_USERNAME created from .env"
    warn "remove INITIAL_ADMIN_PASSWORD from .env now; change the password later in My profile → Change password"
  else
    die "the administrator from .env could not be created (see above); or leave INITIAL_ADMIN_* empty to get a one-time link"
  fi
elif [ "${admins:-0}" = 0 ]; then
  write_admin_link setup-link
  say "NEXT: open ADMIN-LINK.txt in File Station and create the administrator account within 60 minutes"
else
  ok "administrator account exists"
  [ -z "$INITIAL_ADMIN_PASSWORD" ] || warn "INITIAL_ADMIN_PASSWORD is still in .env but no longer used: remove it"
fi

say "-------------------------------------------------------------------"
say "Address:  $RESOLVED_BASE_URL  (phones and computers with Tailscale)"
say "Create the remaining Task Scheduler tasks (README_RU.md, step 6):"
say "  boot-up:   bash $APP_DIR/scripts/start.sh --boot"
say "  every 15m: bash $APP_DIR/scripts/start.sh --check"
say "  daily:     bash $APP_DIR/scripts/backup.sh"
ok "installation finished"

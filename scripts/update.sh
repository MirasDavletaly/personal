#!/bin/bash
# Team Kazakhstan — install the version of this package over the running one.
#
# 1. File Station: unpack the new ZIP over /volume1/docker/team-kz (.env,
#    logs and state stay; data is in DATA_DIR anyway), put the image archive
#    for this NAS into images/ (or let it build from source).
# 2. Task Scheduler (root): bash /volume1/docker/team-kz/scripts/update.sh
#
# Order: new image ready → backup of the running version → app recreated with
# the new image (database migrations run at its start) → health check.
# If anything fails: scripts/rollback.sh --yes (README_RU.md, "Откат").
#   --skip-backup   no backup before the migrations (not recommended)

TKZ_SCRIPT_NAME=update
. "$(dirname "$0")/lib.sh"

log_init update
require_root
load_config
docker_check 60
acquire_lock 0 || die "wait until it has finished"

current=$(deployed_image)
if ! ct_exists "$APP_CT" && [ ! -f "$STATE_DIR/deployed-image" ]; then
  die "Team Kazakhstan is not installed yet: run scripts/setup.sh"
fi
current_version=$(image_label "$current" org.opencontainers.image.version)
say "installed: $current (${current_version:-unknown}) → this package: $IMAGE"

ensure_image
if [ "$current" = "$IMAGE" ] && [ "$(image_id "$current")" = "$(image_id "$IMAGE")" ] && ct_exists "$APP_CT"; then
  say "this version is already installed: applying the settings from .env"
  deploy_all "$IMAGE"
  exit 0
fi

if [ "${1:-}" = --skip-backup ]; then
  warn "no backup before the update (--skip-backup)"
  rm -f "$STATE_DIR/pre-update-backup"
else
  if ! image_exists "$current" && ! [ "$(ct_state "$APP_CT")" = running ]; then
    die "the installed image $current is missing, so no backup can be made; run with --skip-backup only if you have a backup"
  fi
  reason=$(printf 'pre-update-%s-to-%s' "${current_version:-old}" "$VERSION" | tr -c 'a-z0-9-' '-' | cut -c1-30)
  say "backup of the installed version before the migrations ..."
  do_backup "$reason"
  printf '%s\n' "$BACKUP_RESULT" > "$STATE_DIR/pre-update-backup"
fi
printf '%s\n' "$current" > "$STATE_DIR/previous-image"

TKZ_FAIL_HINT="the previous version and its data can be restored with: bash $APP_DIR/scripts/rollback.sh --yes"
deploy_all "$IMAGE"
set_deployed_image "$IMAGE"
TKZ_FAIL_HINT=""

# Keep only the current and the previous image of this app (never others').
for tag in $(docker image ls "$IMAGE_REPO" --format '{{.Tag}}' 2> /dev/null); do
  ref="$IMAGE_REPO:$tag"
  if [ "$ref" != "$IMAGE" ] && [ "$ref" != "$current" ]; then
    docker rmi "$ref" > /dev/null 2>&1 && say "removed old image $ref"
  fi
done
ok "updated to $VERSION. Backup before the update: $(cat "$STATE_DIR/pre-update-backup" 2> /dev/null || echo none)"

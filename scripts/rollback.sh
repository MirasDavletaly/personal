#!/bin/bash
# Team Kazakhstan — return to the version before the last update.
#
# The database schema of the new version may be incompatible with the old
# one, so a rollback always restores the backup made by update.sh right before
# the migrations. Changes made after the update are lost (they stay in a
# "pre-rollback" backup). Needs --yes:
#   bash /volume1/docker/team-kz/scripts/rollback.sh --yes

TKZ_SCRIPT_NAME=rollback
. "$(dirname "$0")/lib.sh"

log_init rollback
require_root
load_config
docker_check 60
acquire_lock 0 || die "wait until it has finished"

previous=$(cat "$STATE_DIR/previous-image" 2> /dev/null || true)
backup=$(cat "$STATE_DIR/pre-update-backup" 2> /dev/null || true)
[ -n "$previous" ] || die "no previous version recorded (rollback is possible after update.sh only)"
image_exists "$previous" || die "the previous image $previous is no longer on the NAS: load its archive (images/) with docker load and repeat"
[ -n "$backup" ] && [ -f "$backup" ] || die "the backup made before the update is missing ($backup); restore a backup with restore.sh instead"
say "back to: $previous, database from: $backup"
[ "${1:-}" = --yes ] || die "this replaces the current data with that backup. Run again as: rollback.sh --yes"

if [ "$(ct_state "$APP_CT")" = running ]; then
  say "backup of the current state (new version) first ..."
  do_backup pre-rollback
fi
assert_ours "$APP_CT"
ct_exists "$APP_CT" && docker stop -t 20 "$APP_CT" > /dev/null
say "restoring $backup with $previous ..."
app_cli_oneoff "$previous" "$(dirname "$backup"):/restore:ro" restore "/restore/$(basename "$backup")" --force || die "restore failed"
deploy_all "$previous"
set_deployed_image "$previous"
rm -f "$STATE_DIR/previous-image"
ok "rolled back to $previous"

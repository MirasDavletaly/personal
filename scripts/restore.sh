#!/bin/bash
# Team Kazakhstan — restore a backup archive.
#
#   bash .../scripts/restore.sh --latest
#   bash .../scripts/restore.sh /volume1/docker/team-kz-backups/team-kz-backup-...tar.gz
#   ... --yes-overwrite     required when the directory already has data
#
# The archive is checked first (gzip, SHA-256 file if present, manifest,
# checksums of every file, SQLite integrity, schema version). Existing data is
# never overwritten without --yes-overwrite; with it, a "pre-restore" backup
# is made first and the old files are kept in DATA_DIR/app/pre-restore-<time>/.
# On a clean installation: setup.sh first, then restore.sh (no flag needed).

TKZ_SCRIPT_NAME=restore
. "$(dirname "$0")/lib.sh"

log_init restore
require_root
load_config
docker_check 60
acquire_lock 0 || die "wait until it has finished"

case ${1:-} in
  "") die "usage: restore.sh <archive> | --latest  [--yes-overwrite]" ;;
  --latest)
    archive=$(ls -1t "$BACKUP_DIR"/team-kz-backup-*.tar.gz 2> /dev/null | head -n 1)
    [ -n "$archive" ] || die "no backups in $BACKUP_DIR"
    ;;
  *)
    archive=$1
    [ -f "$archive" ] || [ ! -f "$BACKUP_DIR/$archive" ] || archive="$BACKUP_DIR/$archive"
    ;;
esac
overwrite=""
[ "${2:-}" = --yes-overwrite ] && overwrite=--force
[ -f "$archive" ] || die "archive not found: $archive"
[[ $archive =~ ^/[A-Za-z0-9._/-]+$ ]] || die "the archive path must be absolute and without spaces: $archive"
dir=$(dirname "$archive")
name=$(basename "$archive")
say "archive: $archive"

gzip -t "$archive" || die "the archive is damaged (gzip)"
[ "$(tar -tzf "$archive" 2> /dev/null | grep -c '^manifest.json$')" -ge 1 ] || die "not a Team Kazakhstan backup (no manifest.json)"
if [ -f "$archive.sha256" ]; then
  (cd "$dir" && sha256sum -c "$name.sha256" > /dev/null) || die "SHA-256 does not match $name.sha256"
  ok "SHA-256 matches"
fi

image=$(deployed_image)
if ! image_exists "$image"; then
  image=$IMAGE
  ensure_image
fi
ensure_dirs
app_cli_oneoff "$image" "$dir:/restore:ro" verify-backup "/restore/$name" || die "the archive failed the check (see above); nothing was changed"

has_data=$(app_cli status 2> /dev/null | awk '/^(employees|users):/ {s += $2} END {print s + 0}')
if [ "${has_data:-0}" -gt 0 ]; then
  [ -n "$overwrite" ] || die "the installation already has data ($has_data active employees and users). To replace it: restore.sh $archive --yes-overwrite"
  if [ "$(ct_state "$APP_CT")" = running ]; then
    say "backup of the current data first ..."
    do_backup pre-restore
  fi
fi

if ct_exists "$APP_CT"; then
  assert_ours "$APP_CT"
  docker stop -t 20 "$APP_CT" > /dev/null
fi
TKZ_FAIL_HINT="the application is stopped; start it again with scripts/start.sh"
app_cli_oneoff "$image" "$dir:/restore:ro" restore "/restore/$name" ${overwrite:+"$overwrite"} || die "restore failed (see above)"
TKZ_FAIL_HINT=""
deploy_all "$image"
set_deployed_image "$image"
rm -f "$STATE_DIR/STOPPED"
ok "restored from $name"

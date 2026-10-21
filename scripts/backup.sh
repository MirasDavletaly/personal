#!/bin/bash
# Team Kazakhstan — consistent backup of the database and photos.
#
# Task Scheduler → Scheduled Task → User-defined script, User: root, daily
# (e.g. 03:15):
#   bash /volume1/docker/team-kz/scripts/backup.sh
#
# The app writes the archive online (SQLite VACUUM INTO: a transactionally
# consistent copy of the WAL database, plus exactly the photos it refers to),
# no downtime. The archive is checked (gzip, manifest, SHA-256), moved to
# BACKUP_DIR, copied to BACKUP_COPY_DIR if set, old archives are pruned
# (BACKUP_RETENTION_DAYS, keeping at least BACKUP_MIN_KEEP).
# Exit code 2: backup made, but the second copy failed.
#   backup.sh [reason]   reason: a-z, 0-9, dashes (default: scheduled)

TKZ_SCRIPT_NAME=backup
. "$(dirname "$0")/lib.sh"

log_init backup
require_root
load_config
docker_check 120
acquire_lock 900 || die "another operation is still running"

reason=${1:-scheduled}
[[ $reason =~ ^[a-z0-9-]{1,30}$ ]] || die "reason: a-z, 0-9 and dashes"
if [ "$(ct_state "$APP_CT")" != running ] && ! image_exists "$(deployed_image)"; then
  die "Team Kazakhstan is not installed (no container, no image)"
fi
[ -f "$DATA_DIR/app/team-kz.sqlite" ] || die "no database in $DATA_DIR/app yet"

do_backup "$reason"
[ "${BACKUP_COPY_STATE:-off}" != failed ] || exit 2

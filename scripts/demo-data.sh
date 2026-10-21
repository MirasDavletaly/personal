#!/bin/bash
# Team Kazakhstan — demonstration data, only on explicit request.
#   bash .../scripts/demo-data.sh --yes      load 8 fictional employees (marked "Demo")
#   bash .../scripts/demo-data.sh --remove   remove them again (also in Admin → Backups)

TKZ_SCRIPT_NAME=demo-data
. "$(dirname "$0")/lib.sh"

log_init demo-data
require_root
load_config
docker_check 60
acquire_lock 120 || die "another operation is still running"

case ${1:-} in
  --yes) app_cli demo-data --yes || die "failed" ;;
  --remove) app_cli demo-data --remove || die "failed" ;;
  *) die "demo data is loaded only on request: demo-data.sh --yes (remove: --remove)" ;;
esac

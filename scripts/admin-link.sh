#!/bin/bash
# Team Kazakhstan — one-time links created on the NAS (no email needed).
#
#   bash .../scripts/admin-link.sh                     first administrator
#   bash .../scripts/admin-link.sh --reset <username>  new password for an account
#                                                      (e.g. the administrator forgot it)
#   bash .../scripts/admin-link.sh --add-admin         one more administrator
#
# The link is written to ADMIN-LINK.txt next to .env (not to the logs),
# works once and expires after 60 minutes.

TKZ_SCRIPT_NAME=admin-link
. "$(dirname "$0")/lib.sh"

log_init admin-link
require_root
load_config
docker_check 60
acquire_lock 120 || die "another operation is still running"
[ "$(ct_state "$APP_CT")" = running ] || die "the application is not running: run scripts/start.sh (or setup.sh) first"

case ${1:-} in
  "") write_admin_link setup-link ;;
  --add-admin) write_admin_link setup-link --force ;;
  --reset)
    [[ ${2:-} =~ ^[a-z0-9][a-z0-9._-]{2,39}$ ]] || die "usage: admin-link.sh --reset <username>"
    write_admin_link reset-link "$2"
    ;;
  *) die "usage: admin-link.sh [--reset <username> | --add-admin]" ;;
esac

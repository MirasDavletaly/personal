#!/bin/bash
# Team Kazakhstan — stop (data stays). The boot task will not start it again
# until start.sh is run.
#   bash .../scripts/stop.sh            stop the containers
#   bash .../scripts/stop.sh --remove   stop and remove the containers
#                                       (image, data and Tailscale identity stay)

TKZ_SCRIPT_NAME=stop
. "$(dirname "$0")/lib.sh"

log_init stop
require_root
load_config
docker_check 60
acquire_lock 120 || die "another operation is still running"

touch "$STATE_DIR/STOPPED"
stop_containers
if [ "${1:-}" = --remove ]; then
  for c in "$APP_CT" "$TS_CT"; do
    if ct_exists "$c"; then
      assert_ours "$c"
      docker rm "$c" > /dev/null && ok "removed container $c"
    fi
  done
fi
ok "stopped. Data in $DATA_DIR is kept. Start again: scripts/start.sh"

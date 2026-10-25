#!/bin/bash
# Team Kazakhstan — start / keep running.
#
#   bash .../scripts/start.sh           start now (also after stop.sh)
#   bash .../scripts/start.sh --boot    Task Scheduler "Triggered task → Boot-up":
#                                       waits for Docker, respects stop.sh
#   bash .../scripts/start.sh --check   Task Scheduler every 15 minutes: silent
#                                       when all is well, repairs otherwise
#                                       (logs/watchdog.log)
# DSM stops the containers when it shuts down and starts them again after
# boot, but in no particular order: the app can start before the Tailscale
# container whose network it uses and then stays down ("cannot join network
# of a non running container"). These tasks start both in the right order.
# Never changes the installed version: that is update.sh / rollback.sh.

TKZ_SCRIPT_NAME=start
. "$(dirname "$0")/lib.sh"

mode=${1:-now}
case $mode in
  now | --boot | --check) ;;
  *) die "usage: start.sh [--boot | --check]" ;;
esac

if [ "$mode" = --check ]; then
  require_root
  load_config
  find "$APP_DIR" -maxdepth 1 -name ADMIN-LINK.txt -mmin +120 -exec rm -f {} \; 2> /dev/null
  [ -f "$STATE_DIR/STOPPED" ] && exit 0
  [ -f "$STATE_DIR/deployed-image" ] || exit 0
  docker version > /dev/null 2>&1 || exit 0
  acquire_lock 0 > /dev/null || exit 0
  problem=""
  [ "$(ct_state "$APP_CT")" = running ] || problem="the application container is $(ct_state "$APP_CT")"
  if [ -z "$problem" ] && [ "$DEPLOY_MODE" = tailscale ] && [ "$(ct_state "$TS_CT")" != running ]; then
    problem="the Tailscale container is $(ct_state "$TS_CT")"
  fi
  if [ -z "$problem" ] && ! proxy_path_ok; then problem="the application does not answer through $DEPLOY_MODE"; fi
  [ -z "$problem" ] && exit 0
  log_init watchdog
  warn "$problem: repairing"
  docker_check 0
  deploy_all "$(deployed_image)"
  exit 0
fi

log_init start
require_root
load_config
if [ "$mode" = --boot ]; then
  docker_check 600
  if [ -f "$STATE_DIR/STOPPED" ]; then
    say "stopped on purpose with stop.sh: not starting (run start.sh to start)"
    exit 0
  fi
  acquire_lock 300 || die "another operation is still running"
else
  docker_check 60
  acquire_lock 0 || die "wait until it has finished"
  rm -f "$STATE_DIR/STOPPED"
fi

[ -f "$STATE_DIR/deployed-image" ] || say "not installed yet with setup.sh: starting this package's version"
image=$(deployed_image)
if ! image_exists "$image"; then
  [ "$image" = "$IMAGE" ] || die "the installed image $image is missing; run scripts/update.sh"
  ensure_image
fi
deploy_all "$image"

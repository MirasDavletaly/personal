#!/bin/bash
# Team Kazakhstan — public access through Tailscale Funnel.
#
#   bash .../scripts/funnel.sh on       the link opens on any device, without
#                                       the Tailscale app (like the other sites
#                                       of this NAS); data stays behind sign-in
#   bash .../scripts/funnel.sh off      tailnet devices only (the default)
#   bash .../scripts/funnel.sh status
#
# Writes TS_FUNNEL=true/false into .env and recreates the Tailscale container
# with the matching Serve configuration (its identity is kept: no new key).
# No ports are opened on the NAS or the router: Funnel goes through Tailscale.

TKZ_SCRIPT_NAME=funnel
. "$(dirname "$0")/lib.sh"

log_init funnel
require_root
load_config
docker_check 60
[ "$DEPLOY_MODE" = tailscale ] || die "Funnel works only with DEPLOY_MODE=tailscale"

case ${1:-} in
  status)
    docker exec "$TS_CT" tailscale funnel status 2>&1 | sed 's/^/      /'
    exit 0
    ;;
  on | off) ;;
  *) die "usage: funnel.sh on | off | status" ;;
esac

acquire_lock 0 || die "another operation is still running"
value=false
[ "$1" = off ] || value=true
if [ "$TS_FUNNEL" = "$value" ]; then
  say "TS_FUNNEL is already $value in .env: applying it"
else
  set_env_value TS_FUNNEL "$value"
  ok "TS_FUNNEL=$value written to .env"
fi
load_config
deploy_all "$(deployed_image)"
say "Funnel status of $TS_DNS:"
docker exec "$TS_CT" tailscale funnel status 2>&1 | sed 's/^/      /'

if [ "$value" = true ]; then
  ok "public: https://$TS_DNS opens without Tailscale; the name can take up to 10 minutes to appear"
  warn "the sign-in page is now reachable from the internet: give every account a long password (My profile → Change password)"
  say "if the status above mentions that Funnel is not allowed: Tailscale admin console → Access controls → nodeAttrs must give \"funnel\" to this machine (the default policy does)"
else
  ok "tailnet only: https://$TS_DNS opens only on devices with Tailscale"
fi

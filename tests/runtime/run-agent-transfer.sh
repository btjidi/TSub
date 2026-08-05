#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/38-agent.sh"

TSUB_TMP="$TMP/tmp"
TSUB_ETC="$TMP/etc"
mkdir -p "$TSUB_TMP" "$TSUB_ETC" "$TMP/bin"
printf 'agent_controller_url=https://old.example/api/deploy/agent\nagent_deployment_id=old\nagent_token_b64=b2xkLXRva2Vu\nagent_poll_interval_seconds=300\n' >"$TSUB_ETC/runtime.conf"
export TSUB_CONFIG="$TSUB_ETC/runtime.conf"
printf 'transfer_target_url=https://new.example\ntransfer_claim_b64=Y2xhaW0tdG9rZW4=\n' >"$TMP/transfer.conf"

cat >"$TMP/bin/curl" <<'EOF'
#!/bin/sh
output=''
previous=''
for argument in "$@"; do
  if [ "$previous" = -o ]; then output=$argument; fi
  previous=$argument
done
case "$*" in
  *https://new.example/api/deploy/agent/transfer/claim*)
    cat >"$output" <<'CONFIG'
agent_mode=remote
agent_controller_url=https://new.example/api/deploy/agent
agent_deployment_id=new-deployment
agent_token_b64=bmV3LXRva2Vu
CONFIG
    ;;
esac
exit 0
EOF
chmod 700 "$TMP/bin/curl"
PATH="$TMP/bin:$PATH"
TSUB_AGENT_TOKEN=old-token
TSUB_AGENT_URL=https://old.example/api/deploy/agent

agent_execute_transfer "$TMP/transfer.conf" command-1 lease-1
grep -q '^agent_controller_url=https://new.example/api/deploy/agent$' "$TSUB_ETC/runtime.conf"
grep -q '^agent_deployment_id=new-deployment$' "$TSUB_ETC/runtime.conf"
grep -q '^agent_poll_interval_seconds=300$' "$TSUB_ETC/runtime.conf"
[ "$(agent_poll_interval)" = 300 ]
[ "$TSUB_AGENT_URL" = https://new.example/api/deploy/agent ]
[ "$TSUB_AGENT_TOKEN" = new-token ]
[ "$(stat -c '%a' "$TSUB_ETC/runtime.conf")" = 600 ]

printf 'transfer_target_url=http://insecure.example\ntransfer_claim_b64=Y2xhaW0=\n' >"$TMP/insecure.conf"
if agent_execute_transfer "$TMP/insecure.conf" command-2 lease-2; then exit 1; fi
grep -q '^agent_controller_url=https://new.example/api/deploy/agent$' "$TSUB_ETC/runtime.conf"

echo 'agent controller transfer tests passed'

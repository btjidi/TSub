#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin" "$TMP/state" "$TMP/etc"

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
agent_deployment_id=remote-deployment
agent_token_b64=bmV3LXRva2Vu
CONFIG
    ;;
  *) exit 1 ;;
esac
EOF
chmod 700 "$TMP/bin/curl"

cat >"$TMP/runtime.sh" <<EOF
#!/bin/sh
[ "\${1:-}" = agent-install ]
grep -q '^agent_mode=remote$' "$TMP/etc/runtime.conf"
: >"$TMP/agent-installed"
EOF
chmod 700 "$TMP/runtime.sh"

cat >"$TMP/etc/runtime.conf" <<'EOF'
runtime_core=xray
agent_mode=local
agent_controller_url=
agent_deployment_id=local-deployment
agent_token_b64=
EOF
cat >"$TMP/transfer.conf" <<'EOF'
transfer_target_url=https://new.example
transfer_claim_b64=Y2xhaW0tdG9rZW4=
EOF

PATH="$TMP/bin:$PATH"
TSUB_EXECUTOR_TEST_MODE=true
TSUB_EXECUTOR_STATE="$TMP/state"
TSUB_RUNTIME_PATH="$TMP/runtime.sh"
TSUB_RUNTIME_SOURCE_PATH="$TMP/runtime-source.sh"
TSUB_RUNTIME_CONFIG="$TMP/etc/runtime.conf"
export PATH TSUB_EXECUTOR_TEST_MODE TSUB_EXECUTOR_STATE TSUB_RUNTIME_PATH TSUB_RUNTIME_SOURCE_PATH TSUB_RUNTIME_CONFIG
. "$ROOT/server/executor/tsub-local-executor.sh"

[ "$(executor_runtime_path)" = "$TMP/runtime.sh" ]

execute_controller_transfer "$TMP/transfer.conf"
grep -q '^runtime_core=xray$' "$TMP/etc/runtime.conf"
grep -q '^agent_mode=remote$' "$TMP/etc/runtime.conf"
grep -q '^agent_controller_url=https://new.example/api/deploy/agent$' "$TMP/etc/runtime.conf"
grep -q '^agent_deployment_id=remote-deployment$' "$TMP/etc/runtime.conf"
[ "$(stat -c '%a' "$TMP/etc/runtime.conf")" = 600 ]
[ -f "$TMP/agent-installed" ]

cp "$TMP/runtime.sh" "$TMP/runtime-source.sh"
chmod 700 "$TMP/runtime-source.sh"
rm -f "$TMP/runtime.sh"
[ "$(executor_runtime_path)" = "$TMP/runtime-source.sh" ]

printf 'local executor controller transfer tests passed\n'

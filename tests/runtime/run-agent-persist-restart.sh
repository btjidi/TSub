#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-agent-persist.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/38-agent.sh"
. "$ROOT/runtime/v2/modules/55-maintenance.sh"

TSUB_TMP="$TEST_TMP/tmp"
TSUB_BIN="$TEST_TMP/bin"
TSUB_ETC="$TEST_TMP/etc"
mkdir -p "$TSUB_TMP" "$TSUB_BIN" "$TSUB_ETC"
TSUB_CONFIG="$TEST_TMP/bootstrap.conf"
cat >"$TSUB_CONFIG" <<'EOF'
agent_mode=remote
agent_controller_url=https://controller.example/api/deploy/agent
agent_deployment_id=deploy-test
EOF
cat >"$TSUB_ETC/runtime.conf" <<'EOF'
agent_mode=none
agent_controller_url=https://controller.example/api/deploy/agent
agent_deployment_id=deploy-test
agent_token_b64=
agent_mode=remote
agent_controller_url=https://controller.example/api/deploy/agent
agent_deployment_id=deploy-test
agent_token_b64=cGVyc2lzdGVkLXRva2Vu
EOF

atomic_install() { cp "$1" "$2"; chmod "$3" "$2"; }
install_control_command() { return 0; }
install_maintenance() { :; }
remove_traffic_maintenance() { :; }
install_push_maintenance() { :; }
install_agent_service() {
  [ "$TSUB_CONFIG" = "$TSUB_ETC/runtime.conf" ]
  if [ "$(kv_get agent_mode)" = remote ]; then
    [ "$(kv_get agent_token_b64)" = cGVyc2lzdGVkLXRva2Vu ]
  else
    [ -z "$(kv_get agent_token_b64)" ]
  fi
  printf '%s\n' restarted >"$TEST_TMP/agent.state"
}

bootstrap_config=$TSUB_CONFIG
persist_runtime
[ "$(cat "$TEST_TMP/agent.state")" = restarted ]
[ "$TSUB_CONFIG" = "$bootstrap_config" ]
grep -q '^agent_token_b64=cGVyc2lzdGVkLXRva2Vu$' "$TSUB_ETC/runtime.conf"
[ "$(grep -c '^agent_mode=' "$TSUB_ETC/runtime.conf")" -eq 1 ]
[ "$(grep -c '^agent_token_b64=' "$TSUB_ETC/runtime.conf")" -eq 1 ]
grep -q '^agent_mode=remote$' "$TSUB_ETC/runtime.conf"

cat >"$TSUB_CONFIG" <<'EOF'
schema_version=2
agent_mode=local
agent_controller_url=http://127.0.0.1:8787/api/deploy/agent
agent_deployment_id=deploy-local
EOF
persist_runtime
[ "$(grep -c '^agent_mode=' "$TSUB_ETC/runtime.conf")" -eq 1 ]
grep -q '^agent_mode=local$' "$TSUB_ETC/runtime.conf"
! grep -q '^agent_token_b64=' "$TSUB_ETC/runtime.conf"

cat >"$TEST_TMP/agent.conf" <<'EOF'
agent_mode=remote
agent_controller_url=https://controller.example/api/deploy/agent
agent_deployment_id=deploy-test
agent_token_b64=dGVzdA==
agent_poll_interval_seconds=300
EOF
TSUB_CONFIG="$TEST_TMP/agent.conf"
agent_poll_once() { printf 300; }
run_agent_loop & agent_loop_pid=$!
sleep 1
kill -TERM "$agent_loop_pid"
agent_stop_attempt=0
while kill -0 "$agent_loop_pid" 2>/dev/null && [ "$agent_stop_attempt" -lt 10 ]; do
  agent_stop_attempt=$((agent_stop_attempt + 1)); sleep 1
done
if kill -0 "$agent_loop_pid" 2>/dev/null; then
  echo 'agent loop did not stop after TERM' >&2
  kill -KILL "$agent_loop_pid" 2>/dev/null || true
  exit 1
fi
wait "$agent_loop_pid" 2>/dev/null || true

grep -q '^TimeoutStopSec=20$' "$ROOT/runtime/v2/modules/38-agent.sh"

echo 'persisted agent restart tests passed'

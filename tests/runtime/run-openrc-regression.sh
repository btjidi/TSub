#!/bin/sh
# shellcheck disable=SC2034
set -eu

[ "${TSUB_OPENRC_CONTAINER_TEST:-}" = true ] && [ -r /etc/alpine-release ] || {
  printf '%s\n' 'This test is restricted to an Alpine test container.' >&2
  exit 2
}

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-openrc.XXXXXX")
cleanup() {
  rm -f /etc/init.d/tsub-core /etc/init.d/tsub-agent /etc/periodic/daily/tsub-maintenance
  rm -rf "$TEST_TMP"
}
trap cleanup EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/32-tunnel.sh"
. "$ROOT/runtime/v2/modules/38-subscription.sh"
. "$ROOT/runtime/v2/modules/38-agent.sh"
. "$ROOT/runtime/v2/modules/40-service.sh"
. "$ROOT/runtime/v2/modules/55-maintenance.sh"

TSUB_TMP="$TEST_TMP/tmp"; TSUB_STATE="$TEST_TMP/state"; TSUB_BIN="$TEST_TMP/bin"; TSUB_ETC="$TEST_TMP/etc"
TSUB_LOG="$TSUB_STATE/runtime.log"; TSUB_INIT=openrc; TSUB_SERVICE_USER=''; TSUB_CORE_BIN="$TSUB_BIN/sing-box-test"
mkdir -p "$TSUB_TMP" "$TSUB_STATE" "$TSUB_BIN" "$TSUB_ETC" "$TEST_TMP/fake-bin"
printf '#!/bin/sh\nexit 0\n' >"$TSUB_CORE_BIN"; chmod 700 "$TSUB_CORE_BIN"
printf '{}\n' >"$TSUB_ETC/config.json"
printf '%s\n' "$TSUB_CORE_BIN" >"$TSUB_STATE/core.identity"
TSUB_CONFIG="$TEST_TMP/runtime.conf"
cat >"$TSUB_CONFIG" <<'EOF'
runtime_core=sing-box
inbound_ports=51231/tcp
tunnel_count=0
subscription_server_enabled=false
agent_mode=remote
agent_controller_url=https://controller.example/api/deploy/agent
agent_deployment_id=deploy-openrc
agent_token_b64=dGVzdC10b2tlbg==
EOF

cat >"$TEST_TMP/fake-bin/rc-service" <<EOF
#!/bin/sh
printf 'rc-service %s %s\n' "\${1:-}" "\${2:-}" >>'$TEST_TMP/openrc.log'
EOF
cat >"$TEST_TMP/fake-bin/rc-update" <<EOF
#!/bin/sh
printf 'rc-update %s %s %s\n' "\${1:-}" "\${2:-}" "\${3:-}" >>'$TEST_TMP/openrc.log'
EOF
chmod 755 "$TEST_TMP/fake-bin/rc-service" "$TEST_TMP/fake-bin/rc-update"
PATH="$TEST_TMP/fake-bin:$PATH"

install_service_definition
first_hash=$(sha256_file /etc/init.d/tsub-core)
install_service_definition
[ "$(sha256_file /etc/init.d/tsub-core)" = "$first_hash" ]
service_start
grep -q '^rc-update add tsub-core default$' "$TEST_TMP/openrc.log"
grep -q '^rc-service tsub-core restart$' "$TEST_TMP/openrc.log"
grep -q 'pidfile="/run/tsub-core.pid"' /etc/init.d/tsub-core

install_agent_service "$ROOT/public/proxy/v2/tsub-proxy.sh" "$TSUB_CONFIG"
grep -q '^rc-update add tsub-agent default$' "$TEST_TMP/openrc.log"
grep -q '^rc-service tsub-agent restart$' "$TEST_TMP/openrc.log"
grep -q 'pidfile="/run/tsub-agent.pid"' /etc/init.d/tsub-agent
grep -q 'retry="TERM/10/KILL/5"' /etc/init.d/tsub-agent

install_maintenance "$ROOT/public/proxy/v2/tsub-proxy.sh" "$TSUB_CONFIG"
maintenance_hash=$(sha256_file /etc/periodic/daily/tsub-maintenance)
install_maintenance "$ROOT/public/proxy/v2/tsub-proxy.sh" "$TSUB_CONFIG"
[ "$(sha256_file /etc/periodic/daily/tsub-maintenance)" = "$maintenance_hash" ]

remove_agent_service
remove_service_definition
[ ! -e /etc/init.d/tsub-agent ]
[ ! -e /etc/init.d/tsub-core ]
printf 'OpenRC lifecycle regression tests passed\n'

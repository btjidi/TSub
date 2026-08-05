#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-edge-probe.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/34-edge-probe.sh"

TSUB_TMP="$TEST_TMP/tmp"; TSUB_CONFIG="$TEST_TMP/probe.conf"
mkdir -p "$TSUB_TMP" "$TEST_TMP/bin"
cat >"$TEST_TMP/bin/curl" <<'EOF'
#!/bin/sh
headers=''; previous=''
printf '%s\n' "$*" >>"$EDGE_PROBE_ARGS"
for argument in "$@"; do
  [ "$previous" != -D ] || headers=$argument
  previous=$argument
done
if [ "${EDGE_PROBE_MODE:-pass}" = pass ]; then
  printf 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n\r\n' >"$headers"
  printf '203.0.113.8|0.010|0.020|101|0.030'
else
  printf 'HTTP/1.1 101 Switching Protocols\r\nServer: test\r\n\r\n' >"$headers"
  printf '203.0.113.8|0.010|0.020|101|0.030'
fi
EOF
chmod 755 "$TEST_TMP/bin/curl"
EDGE_PROBE_ARGS="$TEST_TMP/args"; export EDGE_PROBE_ARGS

cat >"$TSUB_CONFIG" <<'EOF'
edge_probe_hostname=cdn.example.com
edge_probe_address_b64=MjAzLjAuMTEzLjg=
edge_probe_port=8443
edge_probe_path_b64=L3dz
EOF
PATH="$TEST_TMP/bin:$PATH" edge_probe >"$TEST_TMP/pass.log"
grep -q -- '--resolve cdn.example.com:8443:203.0.113.8' "$EDGE_PROBE_ARGS"
grep -q 'WebSocket 101' "$TEST_TMP/pass.log"

sed -i 's#edge_probe_address_b64=.*#edge_probe_address_b64=d3d3LnZpc2EuY24=#' "$TSUB_CONFIG"
PATH="$TEST_TMP/bin:$PATH" edge_probe >"$TEST_TMP/host.log"
grep -q -- '--connect-to cdn.example.com:8443:www.visa.cn:8443' "$EDGE_PROBE_ARGS"

EDGE_PROBE_MODE=missing-headers; export EDGE_PROBE_MODE
if PATH="$TEST_TMP/bin:$PATH" edge_probe >"$TEST_TMP/fail.log" 2>&1; then
  printf '%s\n' 'edge probe accepted a bare 101 response' >&2; exit 1
fi
grep -q 'WebSocket101=false' "$TEST_TMP/fail.log"
printf '%s\n' 'Edge probe runtime tests passed'

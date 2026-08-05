#!/bin/sh
# shellcheck disable=SC2034
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-quick.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/30-provider.sh"
. "$ROOT/runtime/v2/modules/32-tunnel.sh"

TSUB_TMP="$TEST_TMP/tmp"; TSUB_STATE="$TEST_TMP/state"; TSUB_BIN="$TEST_TMP/bin"; TSUB_ARCH=amd64
mkdir -p "$TSUB_TMP" "$TSUB_STATE" "$TSUB_BIN" "$TEST_TMP/fake-bin"
TSUB_CONFIG="$TEST_TMP/runtime.conf"
printf '#!/bin/sh\nexit 0\n' >"$TEST_TMP/cloudflared"; chmod 755 "$TEST_TMP/cloudflared"
cloudflared_hash=$(sha256_file "$TEST_TMP/cloudflared")
cat >"$TSUB_CONFIG" <<EOF
tunnel_count=1
tunnel_1_type=quick
tunnel_1_target_port=51231
tunnel_1_target_scheme=http
cloudflared_version=test
cloudflared_amd64_url=$TEST_TMP/cloudflared
cloudflared_amd64_sha256=$cloudflared_hash
cloudflared_amd64_format=binary
cloudflared_amd64_binary_sha256=$cloudflared_hash
push_token_b64=cXVpY2stdGVzdC10b2tlbg==
quick_tunnel_callback_url=https://controller.example/api/deploy/edge/quick
deployment_id=deploy-quick
EOF
download_file() { cp "$1" "$2"; }
ensure_tunnel_binary
grep -q 'quick-tunnel-monitor.sh' "$TSUB_STATE/start-tunnels.sh"
grep -q '^umask 077$' "$TSUB_STATE/start-tunnels.sh"
[ "$(stat -c '%a' "$TSUB_STATE/tunnel-supervisor.sh")" = 700 ]
! grep -q 'quick-test-token' "$TSUB_STATE/start-tunnels.sh"
[ "$(stat -c '%a' "$TSUB_STATE/quick-tunnel.token")" = 600 ]
quick_hash=$(tunnel_config_hash)
sed -i 's/^tunnel_1_type=quick$/tunnel_1_type=named/' "$TSUB_CONFIG"
[ "$(tunnel_config_hash)" != "$quick_hash" ]
sed -i 's/^tunnel_1_type=named$/tunnel_1_type=quick/' "$TSUB_CONFIG"

cat >"$TEST_TMP/fake-bin/curl" <<'EOF'
#!/bin/sh
output=''
previous=''
for argument in "$@"; do
  [ "$previous" != -o ] || output=$argument
  previous=$argument
done
printf '%s\n' 'vless://test@example.com:443?security=tls#quick' >"$output"
EOF
chmod 755 "$TEST_TMP/fake-bin/curl"
sleep 60 & primary_tunnel_pid=$!
printf '%s\n' "$primary_tunnel_pid" >"$TSUB_STATE/tunnel-1.pid"
printf '%s\n' 'INF route https://valid-quick.trycloudflare.com ready' >"$TSUB_STATE/tunnel-1.log"
PATH="$TEST_TMP/fake-bin:$PATH" "$TSUB_STATE/quick-tunnel-monitor.sh" 1 \
  'https://controller.example/api/deploy/edge/quick' deploy-quick "$TSUB_STATE/tunnel-1.pid" "$TSUB_STATE/tunnel-1.log" \
  "$TSUB_STATE/quick-tunnel.token" "$TSUB_STATE/nodes.txt" "$TSUB_STATE/quick-tunnel.hostname" &
monitor_pid=$!
attempt=0
while [ ! -s "$TSUB_STATE/quick-tunnel.hostname" ] && [ "$attempt" -lt 20 ]; do attempt=$((attempt + 1)); sleep 1; done
[ "$(cat "$TSUB_STATE/quick-tunnel.hostname")" = valid-quick.trycloudflare.com ]
grep -q '^vless://' "$TSUB_STATE/nodes.txt"

printf '%s\n' 'stale direct node' >"$TSUB_STATE/nodes.txt"
attempt=0
while ! grep -q '^vless://' "$TSUB_STATE/nodes.txt" && [ "$attempt" -lt 20 ]; do attempt=$((attempt + 1)); sleep 1; done
grep -q '^vless://' "$TSUB_STATE/nodes.txt"
[ -s "$TSUB_STATE/quick-tunnel.hostname.nodes.cksum" ]
kill "$monitor_pid" 2>/dev/null || true
wait "$monitor_pid" 2>/dev/null || true

cat >"$TSUB_TUNNEL_BIN" <<EOF
#!/bin/sh
count_file='$TEST_TMP/cloudflared.count'
count=0
[ ! -r "\$count_file" ] || count=\$(cat "\$count_file")
count=\$((count + 1)); printf '%s\n' "\$count" >"\$count_file"
printf '%s\n' "INF route https://supervised-\$count.trycloudflare.com ready" >&2
trap 'exit 0' HUP INT TERM
while :; do sleep 1; done
EOF
chmod 755 "$TSUB_TUNNEL_BIN"
PATH="$TEST_TMP/fake-bin:$PATH"; export PATH
tunnel_start
attempt=0
while [ "$(cat "$TSUB_STATE/quick-tunnel.hostname" 2>/dev/null || true)" != supervised-1.trycloudflare.com ] && [ "$attempt" -lt 20 ]; do
  attempt=$((attempt + 1)); sleep 1
done
[ "$(cat "$TSUB_STATE/quick-tunnel.hostname")" = supervised-1.trycloudflare.com ]
supervisor_pid=$(cat "$TSUB_STATE/tunnel-supervisor-1.pid")
first_supervised_pid=$(cat "$TSUB_STATE/tunnel-1.pid")
kill "$first_supervised_pid"
attempt=0
while [ "$(cat "$TSUB_STATE/quick-tunnel.hostname" 2>/dev/null || true)" != supervised-2.trycloudflare.com ] && [ "$attempt" -lt 20 ]; do
  attempt=$((attempt + 1)); sleep 1
done
[ "$(cat "$TSUB_STATE/quick-tunnel.hostname")" = supervised-2.trycloudflare.com ]
kill -0 "$supervisor_pid"

sleep 30 & stale_tunnel_pid=$!
sleep 30 & stale_monitor_pid=$!
printf '%s\n' "$stale_tunnel_pid" >"$TSUB_STATE/tunnel-9.pid"
printf '%s\n' "$stale_monitor_pid" >"$TSUB_STATE/quick-tunnel-monitor-9.pid"
printf '%s\n' old.trycloudflare.com >"$TSUB_STATE/quick-tunnel.hostname"
tunnel_stop
sleep 3
! kill -0 "$supervisor_pid" 2>/dev/null
wait "$primary_tunnel_pid" 2>/dev/null || true
wait "$stale_tunnel_pid" 2>/dev/null || true
wait "$stale_monitor_pid" 2>/dev/null || true
[ ! -e "$TSUB_STATE/tunnel-9.pid" ]
[ ! -e "$TSUB_STATE/tunnel-supervisor-1.pid" ]
[ ! -e "$TSUB_STATE/quick-tunnel-monitor-9.pid" ]
[ ! -e "$TSUB_STATE/quick-tunnel.hostname" ]
[ ! -e "$TSUB_STATE/quick-tunnel.hostname.nodes.cksum" ]

sed -i 's/^tunnel_count=1$/tunnel_count=0/' "$TSUB_CONFIG"
ensure_tunnel_binary
! grep -q 'nohup .*cloudflared' "$TSUB_STATE/start-tunnels.sh"
printf 'Quick Tunnel tests passed\n'

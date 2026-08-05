#!/bin/sh
# shellcheck disable=SC2034
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-core-traffic.XXXXXX")
CORE_PID=''
cleanup() {
  [ -z "$CORE_PID" ] || kill "$CORE_PID" 2>/dev/null || true
  rm -rf "$TEST_TMP"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$TEST_TMP/bin" "$TEST_TMP/state" "$TEST_TMP/etc" "$TEST_TMP/runtime-bin" "$TEST_TMP/work/transaction"

cat >"$TEST_TMP/bin/curl" <<'EOF'
#!/bin/sh
case " $* " in
  *'/debug/vars'*) cat "$TSUB_FAKE_XRAY_JSON" ;;
  *'/connections'*) cat "$TSUB_FAKE_SINGBOX_JSON" ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$TEST_TMP/bin/curl"

SECRET='abcdefghijklmnopqrstuvwxyzABCDEFGH123456789'
SECRET_B64=$(printf '%s' "$SECRET" | base64 | tr -d '\n')
write_config() {
  cat >"$TEST_TMP/runtime.conf" <<EOF
subscription_traffic_enabled=true
subscription_traffic_quota_bytes=0
subscription_traffic_checkpoint_minutes=15
inbound_ports=443/tcp
runtime_core=$1
traffic_core_api_port=19090
traffic_core_api_secret_b64=$SECRET_B64
EOF
}

PATH="$TEST_TMP/bin:$PATH"
export PATH
TSUB_CONFIG="$TEST_TMP/runtime.conf"
TSUB_STATE="$TEST_TMP/state"
TSUB_ETC="$TEST_TMP/etc"
TSUB_BIN="$TEST_TMP/runtime-bin"
TSUB_TMP="$TEST_TMP/work"
TSUB_TX="$TSUB_TMP/transaction"
TSUB_ARCH=amd64
TSUB_HAS_NET_ADMIN=false
TSUB_INIT=none
TSUB_DEGRADED_REASON=''
TSUB_FAKE_SINGBOX_JSON="$TEST_TMP/singbox.json"
TSUB_FAKE_XRAY_JSON="$TEST_TMP/xray.json"
export TSUB_FAKE_SINGBOX_JSON TSUB_FAKE_XRAY_JSON

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/30-provider.sh"
. "$ROOT/runtime/v2/modules/37-traffic.sh"

sleep 300 &
CORE_PID=$!
printf '%s\n' "$CORE_PID" >"$TSUB_STATE/core.pid"
write_config sing-box
printf '%s\n' '{"downloadTotal":200,"uploadTotal":100,"connections":[]}' >"$TSUB_FAKE_SINGBOX_JSON"
traffic_apply_rules
[ "$(traffic_backend)" = core-singbox ]
traffic_checkpoint
grep -q '^upload_total=100$' "$TSUB_STATE/traffic.state"
grep -q '^download_total=200$' "$TSUB_STATE/traffic.state"

printf '%s\n' '{"downloadTotal":260,"uploadTotal":150,"connections":[]}' >"$TSUB_FAKE_SINGBOX_JSON"
traffic_checkpoint
grep -q '^upload_total=150$' "$TSUB_STATE/traffic.state"
grep -q '^download_total=260$' "$TSUB_STATE/traffic.state"

kill "$CORE_PID"
wait "$CORE_PID" 2>/dev/null || true
sleep 300 &
CORE_PID=$!
printf '%s\n' "$CORE_PID" >"$TSUB_STATE/core.pid"
printf '%s\n' '{"downloadTotal":20,"uploadTotal":10,"connections":[]}' >"$TSUB_FAKE_SINGBOX_JSON"
traffic_checkpoint
grep -q '^upload_total=160$' "$TSUB_STATE/traffic.state"
grep -q '^download_total=280$' "$TSUB_STATE/traffic.state"

write_config xray
printf '%s\n' '{"stats":{"inbound":{"a":{"downlink":80,"uplink":40},"b":{"downlink":20,"uplink":10}},"outbound":{},"user":{}}}' >"$TSUB_FAKE_XRAY_JSON"
traffic_apply_rules
[ "$(traffic_backend)" = core-xray ]
traffic_checkpoint
grep -q '^upload_total=210$' "$TSUB_STATE/traffic.state"
grep -q '^download_total=380$' "$TSUB_STATE/traffic.state"

cp "$TSUB_STATE/traffic.state" "$TEST_TMP/traffic.before"
printf '%s\n' '{"stats":"invalid"}' >"$TSUB_FAKE_XRAY_JSON"
traffic_checkpoint
cmp -s "$TEST_TMP/traffic.before" "$TSUB_STATE/traffic.state"
[ "$(wc -c <"$TSUB_STATE/traffic.state")" -lt 16384 ]

printf 'runtime core traffic tests passed\n'

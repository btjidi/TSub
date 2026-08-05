#!/bin/sh
# shellcheck disable=SC2034
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-runtime-test.XXXXXX")
TEST_STAGE=setup
cleanup() {
  test_code=$?
  if [ "$test_code" -ne 0 ]; then
    printf 'runtime subscription test failed at %s\n' "$TEST_STAGE" >&2
  fi
  rm -rf "$TEST_TMP"
  exit "$test_code"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$TEST_TMP/bin" "$TEST_TMP/state" "$TEST_TMP/etc" "$TEST_TMP/runtime-bin"
cp "$ROOT/tests/runtime/fake-nft.sh" "$TEST_TMP/bin/nft"
cp "$ROOT/tests/runtime/fake-busybox.sh" "$TEST_TMP/bin/busybox"
cat >"$TEST_TMP/bin/id" <<'EOF'
#!/bin/sh
if [ "${1:-}" = '-u' ] && [ "$#" -eq 1 ]; then
  printf '0\n'
  exit 0
fi
exec /usr/bin/id "$@"
EOF
chmod 755 "$TEST_TMP/bin/nft" "$TEST_TMP/bin/busybox" "$TEST_TMP/bin/id"

TOKEN='abcdefghijklmnopqrstuvwxyzABCDEFGH123456789'
TOKEN_B64=$(printf '%s' "$TOKEN" | base64 | tr -d '\n')
cat >"$TEST_TMP/runtime.conf" <<EOF
subscription_server_enabled=true
subscription_server_port=51250
subscription_server_token_b64=$TOKEN_B64
subscription_hostname=203.0.113.10
subscription_traffic_enabled=true
subscription_traffic_quota_bytes=1073741824
subscription_traffic_checkpoint_minutes=15
inbound_ports=443/tcp
push_url=https://controller.example/api/deploy/push/deploy-test
push_token_b64=$(printf '%s' 'push-token' | base64 | tr -d '\n')
push_generation=79411d85-b0dc-4cd2-b46c-01789a18c650
EOF

PATH="$TEST_TMP/bin:$PATH"
export PATH
TSUB_CONFIG="$TEST_TMP/runtime.conf"
TSUB_STATE="$TEST_TMP/state"
TSUB_ETC="$TEST_TMP/etc"
TSUB_BIN="$TEST_TMP/runtime-bin"
TSUB_TMP="$TEST_TMP/work"
TSUB_TX="$TSUB_TMP/transaction"
TSUB_ARCH=amd64
TSUB_HAS_NET_ADMIN=true
TSUB_DEGRADED_REASON=''
mkdir -p "$TSUB_TMP" "$TSUB_TX"
export TSUB_FAKE_COUNTERS="$TEST_TMP/counters"
printf '0 0\n' >"$TSUB_FAKE_COUNTERS"

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/30-provider.sh"
. "$ROOT/runtime/v2/modules/37-traffic.sh"
. "$ROOT/runtime/v2/modules/38-subscription.sh"
. "$ROOT/runtime/v2/modules/39-push.sh"

TEST_STAGE=push-settings
[ "$(push_interval_minutes)" = 15 ]
for interval in 5 15 30 60; do
  sed "s/^push_generation=/push_interval_minutes=$interval\npush_generation=/" "$TEST_TMP/runtime.conf" >"$TEST_TMP/runtime-push-$interval.conf"
  TSUB_CONFIG="$TEST_TMP/runtime-push-$interval.conf"
  [ "$(push_interval_minutes)" = "$interval" ]
done
sed 's/^push_generation=/push_enabled=false\npush_generation=/' "$TEST_TMP/runtime.conf" >"$TEST_TMP/runtime-push-disabled.conf"
TSUB_CONFIG="$TEST_TMP/runtime-push-disabled.conf"
! push_enabled
TSUB_CONFIG="$TEST_TMP/runtime.conf"

traffic_apply_rules
TEST_STAGE=initial-checkpoint
grep -q '^443/tcp$' "$TSUB_STATE/traffic.ports"
printf '100 200\n' >"$TSUB_FAKE_COUNTERS"
traffic_checkpoint
grep -q '^upload_total=100$' "$TSUB_STATE/traffic.state"
grep -q '^download_total=200$' "$TSUB_STATE/traffic.state"

printf '25 40\n' >"$TSUB_FAKE_COUNTERS"
traffic_checkpoint
grep -q '^upload_total=125$' "$TSUB_STATE/traffic.state"
grep -q '^download_total=240$' "$TSUB_STATE/traffic.state"
[ "$(wc -c <"$TSUB_STATE/traffic.state")" -lt 16384 ]

# Disabling traffic must checkpoint the last live counters before removing rules.
sed 's/subscription_traffic_enabled=true/subscription_traffic_enabled=false/' \
  "$TEST_TMP/runtime.conf" >"$TEST_TMP/runtime-disabled.conf"
printf '35 55\n' >"$TSUB_FAKE_COUNTERS"
TSUB_CONFIG="$TEST_TMP/runtime-disabled.conf"
traffic_apply_rules
grep -q '^upload_total=135$' "$TSUB_STATE/traffic.state"
grep -q '^download_total=255$' "$TSUB_STATE/traffic.state"
TSUB_CONFIG="$TEST_TMP/runtime.conf"
traffic_apply_rules
printf '0 0\n' >"$TSUB_FAKE_COUNTERS"

traffic_snapshot
TEST_STAGE=traffic-snapshot
TSUB_CONFIG="$TEST_TMP/runtime-disabled.conf"
traffic_apply_rules
[ ! -f "$TSUB_STATE/traffic.backend" ]
traffic_restore_snapshot
grep -q '^443/tcp$' "$TSUB_STATE/traffic.ports"
TSUB_CONFIG="$TEST_TMP/runtime.conf"

printf 'vless://uuid@example.com:443#TSub\n' >"$TSUB_STATE/nodes.txt"
subscription_prepare
TEST_STAGE=subscription-cgi
CGI="$TSUB_STATE/subscription-web/cgi-bin/$TOKEN"
TEST_STAGE=cgi-executable
[ -x "$CGI" ]
OUTPUT=$("$CGI")
TEST_STAGE=cgi-traffic-header
printf '%s' "$OUTPUT" | grep -q 'Subscription-Userinfo: upload=135; download=255; total=1073741824; expire=0'
TEST_STAGE=cgi-node
printf '%s' "$OUTPUT" | grep -q 'vless://uuid@example.com:443#TSub'
TEST_STAGE=cgi-index
[ "$(cat "$TSUB_STATE/subscription-web/index.html")" = 'Not Found' ]

subscription_snapshot
TEST_STAGE=subscription-snapshot
OLD_CGI="$CGI"
SECOND_TOKEN='secondTokenABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
SECOND_TOKEN_B64=$(printf '%s' "$SECOND_TOKEN" | base64 | tr -d '\n')
sed "s|subscription_server_token_b64=.*|subscription_server_token_b64=$SECOND_TOKEN_B64|" \
  "$TEST_TMP/runtime.conf" >"$TEST_TMP/runtime-second.conf"
TSUB_CONFIG="$TEST_TMP/runtime-second.conf"
subscription_prepare
[ -x "$TSUB_STATE/subscription-web/cgi-bin/$SECOND_TOKEN" ]
subscription_restore_snapshot
[ -x "$OLD_CGI" ]
[ ! -e "$TSUB_STATE/subscription-web/cgi-bin/$SECOND_TOKEN" ]

printf 'vless://uuid@example.com:443#TSub' >"$TSUB_STATE/nodes.txt"
EVENT_FILE="$TEST_TMP/subscription.event"
printf '%s\n' "$$" >"$TSUB_STATE/subscription.pid"
subscription_append_event "$EVENT_FILE"
grep -q '^subscriptionNodeCount=1$' "$EVENT_FILE"
grep -q '^cacheNode=vless://uuid@example.com:443#TSub$' "$EVENT_FILE"
rm -f "$TSUB_STATE/subscription.pid"

cat >"$TEST_TMP/bin/curl" <<'EOF'
#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output=$1 ;;
    @*) cp "${1#@}" "$TSUB_FAKE_PUSH_BODY" ;;
  esac
  shift
done
[ -z "$output" ] || printf '{"success":true}\n' >"$output"
printf 200
EOF
chmod 755 "$TEST_TMP/bin/curl"
TSUB_FAKE_PUSH_BODY="$TEST_TMP/push.body"
export TSUB_FAKE_PUSH_BODY
push_snapshot
TEST_STAGE=push
grep -q '^sequence=1$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^upload=135$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^download=255$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^serverAddress=203.0.113.10$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^subscriptionPort=51250$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^subscriptionReady=true$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^subscriptionNodeCount=1$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^node=vless://uuid@example.com:443#TSub$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^sequence=1$' "$TSUB_STATE/push.state"

cat >"$TEST_TMP/bin/curl" <<'EOF'
#!/bin/sh
output=''
count=$(cat "$TSUB_FAKE_PUSH_COUNT" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\n' "$count" >"$TSUB_FAKE_PUSH_COUNT"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output=$1 ;;
    @*) cp "${1#@}" "$TSUB_FAKE_PUSH_BODY" ;;
  esac
  shift
done
if [ "$count" -eq 1 ]; then
  printf '{"success":false,"code":"STALE_PUSH_SEQUENCE","data":{"expectedSequence":8}}\n' >"$output"
  printf 409
else
  printf '{"success":true}\n' >"$output"
  printf 200
fi
EOF
chmod 755 "$TEST_TMP/bin/curl"
TSUB_FAKE_PUSH_COUNT="$TEST_TMP/push.count"
export TSUB_FAKE_PUSH_COUNT
rm -f "$TSUB_STATE/push.state"
push_snapshot
TEST_STAGE=push-sequence-resync
[ "$(cat "$TSUB_FAKE_PUSH_COUNT")" = 2 ]
grep -q '^sequence=8$' "$TSUB_FAKE_PUSH_BODY"
grep -q '^sequence=8$' "$TSUB_STATE/push.state"

cat >"$TEST_TMP/bin/curl" <<'EOF'
#!/bin/sh
count=$(cat "$TSUB_FAKE_CALLBACK_COUNT" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\n' "$count" >"$TSUB_FAKE_CALLBACK_COUNT"
[ "$count" -ge 3 ]
EOF
chmod 755 "$TEST_TMP/bin/curl"
TSUB_FAKE_CALLBACK_COUNT="$TEST_TMP/callback.count"
export TSUB_FAKE_CALLBACK_COUNT
TSUB_CALLBACK_URL='https://callback.example/events'
TSUB_CALLBACK_TOKEN='callback-token'
TSUB_STAGE='test'
printf '%s\n' "$$" >"$TSUB_STATE/subscription.pid"
emit_event running 'retry test'
TEST_STAGE=callback
[ "$(cat "$TSUB_FAKE_CALLBACK_COUNT")" = 3 ]
rm -f "$TSUB_STATE/subscription.pid"

printf 'runtime subscription and traffic tests passed\n'

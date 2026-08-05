#!/bin/sh
# shellcheck disable=SC1007
set -eu

TEST_ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

TSUB_CONFIG="$TEST_TMP/runtime.conf"
TSUB_TMP="$TEST_TMP/work"
mkdir -p "$TSUB_TMP" "$TEST_TMP/bin"
printf 'payload_b64=%s\n' 'eyJpbmJvdW5kcyI6W3sicHJvdG9jb2wiOiJ2bGVzcyJ9XX0=' >"$TSUB_CONFIG"
REAL_BASE64=$(command -v base64)
export REAL_BASE64
awk 'BEGIN { for (i = 0; i < 8192; i++) printf "x" }' >"$TEST_TMP/long.source"
long_b64=$("$REAL_BASE64" <"$TEST_TMP/long.source" | tr -d '[:space:]')
printf 'long_payload_b64=%s\n' "$long_b64" >>"$TSUB_CONFIG"

cat >"$TEST_TMP/bin/base64" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -d)
    # Simulate an implementation that writes partial output before rejecting -d.
    printf partial
    exit 1
    ;;
  --decode)
    exec "$REAL_BASE64" -d
    ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$TEST_TMP/bin/base64"
PATH="$TEST_TMP/bin:/usr/bin:/bin"
export PATH TSUB_CONFIG TSUB_TMP

# shellcheck source=../../runtime/v2/modules/00-common.sh
. "$TEST_ROOT/runtime/v2/modules/00-common.sh"

b64_decode_file payload_b64 "$TEST_TMP/config.json"
[ "$(cat "$TEST_TMP/config.json")" = '{"inbounds":[{"protocol":"vless"}]}' ]
b64_decode_file long_payload_b64 "$TEST_TMP/long.decoded"
cmp "$TEST_TMP/long.source" "$TEST_TMP/long.decoded"
[ ! -e "$TEST_TMP/config.json.b64.$$" ]
[ ! -e "$TEST_TMP/config.json.decoded.$$" ]

printf 'runtime base64 fallback tests passed\n'

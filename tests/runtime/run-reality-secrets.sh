#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/31-secrets.sh"

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-reality.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
TSUB_TMP="$TEST_TMP/tmp"; TSUB_STATE="$TEST_TMP/state"; TSUB_CONFIG="$TEST_TMP/runtime.conf"
mkdir -p "$TSUB_TMP" "$TSUB_STATE"
printf 'runtime_core=xray\nreality_auto_ids=inbound_1\n' >"$TSUB_CONFIG"

TSUB_CORE_BIN="$TEST_TMP/xray"
cat >"$TSUB_CORE_BIN" <<'EOF'
#!/bin/sh
printf '%s\n' \
  'PrivateKey: gB_9B5CKNIs_l_jxuhOLtzyr1selS2543cgNwqK0tmE' \
  'Password (PublicKey): KkSw8MfhE5b2QRGNcFtdfhQCTPQM4N24juo9dsWYy38' \
  'Hash32: ignored'
EOF
chmod 755 "$TSUB_CORE_BIN"
ensure_runtime_secrets
grep -q '^private=gB_9B5CKNIs_l_jxuhOLtzyr1selS2543cgNwqK0tmE$' "$TSUB_STATE/secrets/reality-inbound_1.conf"
grep -q '^public=KkSw8MfhE5b2QRGNcFtdfhQCTPQM4N24juo9dsWYy38$' "$TSUB_STATE/secrets/reality-inbound_1.conf"

rm -rf "$TSUB_STATE/secrets"
cat >"$TSUB_CORE_BIN" <<'EOF'
#!/bin/sh
printf '%s\n' 'PrivateKey: invalid!' 'PublicKey: short'
EOF
chmod 755 "$TSUB_CORE_BIN"
if (ensure_runtime_secrets) >/dev/null 2>&1; then
  printf 'malformed Reality output was accepted\n' >&2
  exit 1
fi

printf 'reality secret tests passed\n'

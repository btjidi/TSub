#!/bin/sh
set -eu

ROOT=$(dirname "$0")
ROOT=$(CDPATH='' cd -- "$ROOT/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

mkdir -p "$TMP/archive/sing-box-package" "$TMP/bin" "$TMP/state" "$TMP/work"
printf '#!/bin/sh\nprintf "archive-core-ok\\n"\n' >"$TMP/archive/sing-box-package/sing-box"
chmod 755 "$TMP/archive/sing-box-package/sing-box"
tar -czf "$TMP/sing-box.tar.gz" -C "$TMP/archive" sing-box-package
archive_hash=$(sha256sum "$TMP/sing-box.tar.gz" | awk '{print $1}')
binary_hash=$(sha256sum "$TMP/archive/sing-box-package/sing-box" | awk '{print $1}')

cat >"$TMP/runtime.conf" <<EOF
runtime_core=sing-box
sing-box_version=test
sing-box_amd64_url=$TMP/sing-box.tar.gz
sing-box_amd64_sha256=$archive_hash
sing-box_amd64_format=tar.gz
sing-box_amd64_binary_sha256=$binary_hash
EOF

TSUB_CONFIG="$TMP/runtime.conf"
TSUB_ARCH=amd64
TSUB_BIN="$TMP/bin"
TSUB_STATE="$TMP/state"
TSUB_TMP="$TMP/work"
TSUB_DOWNLOAD_PART=''
TSUB_CALLBACK_URL=''
export TSUB_CONFIG TSUB_ARCH TSUB_BIN TSUB_STATE TSUB_TMP TSUB_DOWNLOAD_PART TSUB_CALLBACK_URL

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/30-provider.sh"
download_file() { cp "$1" "$2"; }

ensure_core
[ -x "$TSUB_CORE_BIN" ]
[ "$(sha256_file "$TSUB_CORE_BIN")" = "$binary_hash" ]
[ "$($TSUB_CORE_BIN)" = archive-core-ok ]

bad_hash=$(printf bad | sha256sum | awk '{print $1}')
sed "s/sing-box_amd64_binary_sha256=.*/sing-box_amd64_binary_sha256=$bad_hash/" "$TMP/runtime.conf" >"$TMP/bad.conf"
if (
  TSUB_CONFIG="$TMP/bad.conf"
  TSUB_BIN="$TMP/bad-bin"
  mkdir -p "$TSUB_BIN"
  ensure_core
) >/dev/null 2>&1; then
  echo 'archive extraction accepted an invalid binary hash' >&2
  exit 1
fi

printf 'provider archive tests passed\n'

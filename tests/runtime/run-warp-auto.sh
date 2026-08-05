#!/bin/sh
# shellcheck disable=SC2034
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-warp.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/30-provider.sh"
. "$ROOT/runtime/v2/modules/31-secrets.sh"

TSUB_TMP="$TEST_TMP/tmp"; TSUB_STATE="$TEST_TMP/state"; TSUB_BIN="$TEST_TMP/bin"; TSUB_LOG="$TEST_TMP/runtime.log"; TSUB_ARCH=amd64
mkdir -p "$TSUB_TMP" "$TSUB_STATE" "$TSUB_BIN"; : >"$TSUB_LOG"
fake_wgcf="$TEST_TMP/wgcf"
cat >"$fake_wgcf" <<'EOF'
#!/bin/sh
case "$1" in
  register) printf 'account\n' >wgcf-account.toml ;;
  generate) cat >wgcf-profile.conf <<'PROFILE'
[Interface]
PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
Address = 172.16.0.2/32, 2606:4700:110:8765::2/128
[Peer]
PublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
Endpoint = engage.cloudflareclient.com:2408
Reserved = 1, 2, 3
PROFILE
  ;;
esac
EOF
chmod 755 "$fake_wgcf"
wgcf_hash=$(sha256_file "$fake_wgcf")
TSUB_CONFIG="$TEST_TMP/runtime.conf"
cat >"$TSUB_CONFIG" <<EOF
warp_backend=userspace
warp_provisioning=auto
warp_terms_accepted=true
wgcf_version=2.2.22
wgcf_amd64_url=$fake_wgcf
wgcf_amd64_sha256=$wgcf_hash
wgcf_amd64_format=binary
wgcf_amd64_binary_sha256=$wgcf_hash
reality_auto_ids=
EOF
download_file() { cp "$1" "$2"; }

ensure_runtime_secrets
[ "$(stat -c '%a' "$TSUB_STATE/secrets/warp/wgcf-profile.conf")" = 600 ]
profile_hash=$(sha256_file "$TSUB_STATE/secrets/warp/wgcf-profile.conf")
cat >"$TEST_TMP/core.json" <<'EOF'
{"private":"__TSUB_WARP_PRIVATE_KEY__","peer":"__TSUB_WARP_PEER_PUBLIC_KEY__","addresses":["__TSUB_WARP_IPV4__","__TSUB_WARP_IPV6__"],"endpoint":"__TSUB_WARP_ENDPOINT__","port":"__TSUB_WARP_PORT__","reserved":"__TSUB_WARP_RESERVED__"}
EOF
replace_runtime_secrets "$TEST_TMP/core.json"
grep -q '"private":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="' "$TEST_TMP/core.json"
grep -q '"addresses":\["172.16.0.2/32","2606:4700:110:8765::2/128"\]' "$TEST_TMP/core.json"
grep -q '"port":2408' "$TEST_TMP/core.json"
grep -q '"reserved":\[1,2,3\]' "$TEST_TMP/core.json"

ensure_runtime_secrets
[ "$(sha256_file "$TSUB_STATE/secrets/warp/wgcf-profile.conf")" = "$profile_hash" ]
printf 'automatic WARP tests passed\n'

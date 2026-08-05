#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/33-certificate.sh"

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-certificate-pin.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
TSUB_TMP="$TEST_TMP/tmp"
TSUB_STATE="$TEST_TMP/state"
TSUB_CONFIG="$TEST_TMP/runtime.conf"
TSUB_NODES_FILE="$TSUB_STATE/nodes.txt"
TSUB_NODE_DETAILS_FILE="$TSUB_STATE/node-details.txt"
mkdir -p "$TSUB_TMP" "$TSUB_STATE/certificates/certificates"
cat >"$TSUB_CONFIG" <<'EOF'
certificate_mode=self-signed
certificate_domain=hy.example.com
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=hy.example.com' \
  -keyout "$TEST_TMP/certificate.key" \
  -out "$TSUB_STATE/certificates/certificates/hy.example.com.crt" >/dev/null 2>&1

PIN_PLACEHOLDER=__TSUB_CERT_PIN_SHA256__
SPKI_PLACEHOLDER=__TSUB_CERT_SPKI_SHA256__
SPKI_EXPECTED=$(openssl x509 -in "$TSUB_STATE/certificates/certificates/hy.example.com.crt" -pubkey -noout 2>/dev/null \
  | openssl pkey -pubin -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary 2>/dev/null \
  | openssl base64 -A)
VMESS_JSON=$(printf '{"v":"2","pcs":"%s","spki":"%s"}' "$PIN_PLACEHOLDER" "$SPKI_PLACEHOLDER")
VMESS_URL="vmess://$(printf '%s' "$VMESS_JSON" | base64 | tr -d '\r\n')"
cat >"$TSUB_NODES_FILE" <<EOF
hysteria2://secret@example.com:443?security=tls&sni=hy.example.com&pinSHA256=$PIN_PLACEHOLDER&spki=$SPKI_PLACEHOLDER#HY2
vless://uuid@example.com:443?security=tls&sni=hy.example.com&pcs=$PIN_PLACEHOLDER&spki=$SPKI_PLACEHOLDER#VLESS
tuic://uuid:password@example.com:8443?security=tls&sni=hy.example.com&alpn=h3&allow_insecure=1&pcs=$PIN_PLACEHOLDER&spki=$SPKI_PLACEHOLDER#TUIC
$VMESS_URL
EOF
cat >"$TSUB_NODE_DETAILS_FILE" <<EOF
HY2（Hysteria2）
hysteria2://secret@example.com:443?pinSHA256=$PIN_PLACEHOLDER&spki=$SPKI_PLACEHOLDER#HY2

VMess（VMess）
$VMESS_URL
EOF

apply_exported_certificate_pin
EXPECTED=$(openssl x509 -in "$TSUB_STATE/certificates/certificates/hy.example.com.crt" -outform DER 2>/dev/null \
  | openssl dgst -sha256 2>/dev/null \
  | sed 's/^.*= //')
[ "$(cat "$TSUB_STATE/certificate.pin-sha256")" = "$EXPECTED" ]
grep -q "pinSHA256=$EXPECTED" "$TSUB_NODES_FILE"
grep -q "pcs=$EXPECTED" "$TSUB_NODES_FILE"
grep -q "pinSHA256=$EXPECTED" "$TSUB_NODE_DETAILS_FILE"
SPKI_URLENCODED=$(printf '%s' "$SPKI_EXPECTED" | sed -e 's/%/%25/g' -e 's/+/%2B/g' -e 's|/|%2F|g' -e 's/=/%3D/g')
grep -q "tuic://.*allow_insecure=1.*pcs=$EXPECTED.*spki=$SPKI_URLENCODED" "$TSUB_NODES_FILE"
grep -q "spki=$SPKI_URLENCODED" "$TSUB_NODES_FILE"
grep -q "spki=$SPKI_URLENCODED" "$TSUB_NODE_DETAILS_FILE"
grep -q "$SPKI_EXPECTED" "$TSUB_STATE/certificate.spki-sha256"
! grep -q "$PIN_PLACEHOLDER" "$TSUB_NODES_FILE"
! grep -q "$PIN_PLACEHOLDER" "$TSUB_NODE_DETAILS_FILE"
! grep -q "$SPKI_PLACEHOLDER" "$TSUB_NODES_FILE"
! grep -q "$SPKI_PLACEHOLDER" "$TSUB_NODE_DETAILS_FILE"
cp "$TSUB_NODES_FILE" "$TEST_TMP/invalid-tuic.txt"
sed "s/pcs=$EXPECTED/pcs=invalid/" "$TEST_TMP/invalid-tuic.txt" >"$TEST_TMP/invalid-tuic.tmp"
mv "$TEST_TMP/invalid-tuic.tmp" "$TEST_TMP/invalid-tuic.txt"
if validate_exported_tuic_certificate_pin "$TEST_TMP/invalid-tuic.txt" "$EXPECTED" "$SPKI_EXPECTED"; then
  printf 'invalid TUIC pin unexpectedly passed validation\n' >&2
  exit 1
fi
VMESS_PIN=$(sed -n 's|^vmess://||p' "$TSUB_NODES_FILE" | base64 -d | sed -n 's/.*"pcs":"\([0-9a-f]*\)".*/\1/p')
[ "$VMESS_PIN" = "$EXPECTED" ]
VMESS_SPKI=$(sed -n 's|^vmess://||p' "$TSUB_NODES_FILE" | base64 -d | sed -n 's/.*"spki":"\([A-Za-z0-9+/=]*\)".*/\1/p')
[ "$VMESS_SPKI" = "$SPKI_EXPECTED" ]
printf 'certificate pin tests passed\n'

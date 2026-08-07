acme_firewall_open() {
  TSUB_ACME_FIREWALL=''
  [ "$TSUB_HAS_NET_ADMIN" = true ] || return 0
  if have nft; then
    nft add table inet tsub_acme
    nft 'add chain inet tsub_acme input { type filter hook input priority -10; policy accept; }'
    nft add rule inet tsub_acme input tcp dport 80 accept
    TSUB_ACME_FIREWALL=nft
  elif have iptables; then
    iptables -I INPUT -p tcp --dport 80 -m comment --comment TSUB_ACME -j ACCEPT
    TSUB_ACME_FIREWALL=iptables
  fi
}

acme_firewall_close() {
  [ "$TSUB_ACME_FIREWALL" = nft ] && nft delete table inet tsub_acme >/dev/null 2>&1 || true
  if [ "$TSUB_ACME_FIREWALL" = iptables ]; then
    iptables -D INPUT -p tcp --dport 80 -m comment --comment TSUB_ACME -j ACCEPT >/dev/null 2>&1 || true
  fi
  TSUB_ACME_FIREWALL=''
}

certificate_pin_sha256() {
  certificate_pin_file=$1
  certificate_pin_body="$TSUB_TMP/certificate-pin.b64"
  certificate_pin_der="$TSUB_TMP/certificate-pin.der"
  sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/ {
    /-----BEGIN CERTIFICATE-----/d
    /-----END CERTIFICATE-----/d
    p
  }' "$certificate_pin_file" | tr -d '[:space:]' >"$certificate_pin_body"
  [ -s "$certificate_pin_body" ] || return 1
  certificate_pin_decoded=false
  if have base64; then
    if base64 -d <"$certificate_pin_body" >"$certificate_pin_der" 2>/dev/null && [ -s "$certificate_pin_der" ]; then certificate_pin_decoded=true
    elif base64 --decode <"$certificate_pin_body" >"$certificate_pin_der" 2>/dev/null && [ -s "$certificate_pin_der" ]; then certificate_pin_decoded=true
    elif base64 -D <"$certificate_pin_body" >"$certificate_pin_der" 2>/dev/null && [ -s "$certificate_pin_der" ]; then certificate_pin_decoded=true
    fi
  fi
  if [ "$certificate_pin_decoded" = false ] && have openssl; then
    if openssl base64 -d -A <"$certificate_pin_body" >"$certificate_pin_der" 2>/dev/null && [ -s "$certificate_pin_der" ]; then certificate_pin_decoded=true; fi
  fi
  [ "$certificate_pin_decoded" = true ] || return 1
  certificate_pin=$(sha256_file "$certificate_pin_der" | tr 'A-F' 'a-f')
  case "$certificate_pin" in
    *[!0-9a-f]*|'') return 1 ;;
  esac
  [ "${#certificate_pin}" -eq 64 ] || return 1
  printf '%s\n' "$certificate_pin"
}

certificate_spki_sha256() {
  certificate_spki_file=$1
  certificate_spki_der="$TSUB_TMP/certificate-spki.der"
  certificate_spki_digest="$TSUB_TMP/certificate-spki.sha256"
  have openssl || return 1
  openssl x509 -in "$certificate_spki_file" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null >"$certificate_spki_der" || return 1
  [ -s "$certificate_spki_der" ] || return 1
  openssl dgst -sha256 -binary "$certificate_spki_der" >"$certificate_spki_digest" 2>/dev/null || return 1
  [ "$(wc -c <"$certificate_spki_digest" | tr -d ' ')" = 32 ] || return 1
  certificate_spki=$(certificate_base64_encode_file "$certificate_spki_digest") || return 1
  case "$certificate_spki" in *[!A-Za-z0-9+/=]*|'') return 1 ;; esac
  [ "${#certificate_spki}" -eq 44 ] || return 1
  case "$certificate_spki" in *=) ;; *) return 1 ;; esac
  printf '%s\n' "$certificate_spki"
}

certificate_spki_urlencode() {
  printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/+/%2B/g' -e 's|/|%2F|g' -e 's/=/%3D/g'
}

certificate_base64_decode_value() {
  certificate_encoded=$1
  certificate_output=$2
  printf '%s' "$certificate_encoded" | tr '_-' '/+' >"$certificate_output.b64"
  certificate_decoded=false
  if have base64; then
    if base64 -d <"$certificate_output.b64" >"$certificate_output" 2>/dev/null && [ -s "$certificate_output" ]; then certificate_decoded=true
    elif base64 --decode <"$certificate_output.b64" >"$certificate_output" 2>/dev/null && [ -s "$certificate_output" ]; then certificate_decoded=true
    elif base64 -D <"$certificate_output.b64" >"$certificate_output" 2>/dev/null && [ -s "$certificate_output" ]; then certificate_decoded=true
    fi
  fi
  if [ "$certificate_decoded" = false ] && have openssl; then
    if openssl base64 -d -A <"$certificate_output.b64" >"$certificate_output" 2>/dev/null && [ -s "$certificate_output" ]; then certificate_decoded=true; fi
  fi
  rm -f "$certificate_output.b64"
  [ "$certificate_decoded" = true ]
}

certificate_base64_encode_file() {
  certificate_input=$1
  if have base64; then base64 <"$certificate_input" | tr -d '\r\n'
  elif have openssl; then openssl base64 -A <"$certificate_input"
  else return 1; fi
}

replace_certificate_pin_in_file() {
  certificate_nodes_file=$1
  certificate_pin=$2
  certificate_spki=$3
  certificate_spki_encoded=$(certificate_spki_urlencode "$certificate_spki") || return 1
  [ -f "$certificate_nodes_file" ] || return 0
  certificate_nodes_output="$TSUB_TMP/$(basename "$certificate_nodes_file").pinned"
  : >"$certificate_nodes_output"
  certificate_line_number=0
  while IFS= read -r certificate_line || [ -n "$certificate_line" ]; do
    certificate_line_number=$((certificate_line_number + 1))
    case "$certificate_line" in
      vmess://*)
        certificate_vmess_payload="$TSUB_TMP/vmess-pin.$certificate_line_number.json"
        if ! certificate_base64_decode_value "${certificate_line#vmess://}" "$certificate_vmess_payload"; then
          i18n_log ERROR "VMess 节点证书指纹写入失败：链接 Base64 无效" "Failed to write the VMess certificate pin: invalid link Base64"
          return 1
        fi
        sed -e "s/__TSUB_CERT_PIN_SHA256__/$certificate_pin/g" -e "s|__TSUB_CERT_SPKI_SHA256__|$certificate_spki|g" "$certificate_vmess_payload" >"$certificate_vmess_payload.pinned"
        certificate_vmess_encoded=$(certificate_base64_encode_file "$certificate_vmess_payload.pinned") || return 1
        printf 'vmess://%s\n' "$certificate_vmess_encoded" >>"$certificate_nodes_output"
        ;;
      *)
        printf '%s\n' "$certificate_line" | sed -e "s/__TSUB_CERT_PIN_SHA256__/$certificate_pin/g" -e "s|__TSUB_CERT_SPKI_SHA256__|$certificate_spki_encoded|g" >>"$certificate_nodes_output"
        ;;
    esac
  done <"$certificate_nodes_file"
  if grep -Eq '__TSUB_CERT_(PIN|SPKI)_SHA256__' "$certificate_nodes_output" 2>/dev/null; then
    i18n_log ERROR "节点证书指纹占位符未完全替换" "Node certificate pin placeholders were not fully replaced"
    return 1
  fi
  mv -f "$certificate_nodes_output" "$certificate_nodes_file"
}

validate_exported_tuic_certificate_pin() {
  certificate_nodes_file=$1
  certificate_pin=$2
  certificate_spki_encoded=$(certificate_spki_urlencode "$3") || return 1
  [ -f "$certificate_nodes_file" ] || return 0
  while IFS= read -r certificate_line || [ -n "$certificate_line" ]; do
    case "$certificate_line" in
      tuic://*)
        case "$certificate_line" in *"pcs=$certificate_pin"*) ;; *) return 1 ;; esac
        case "$certificate_line" in *"spki=$certificate_spki_encoded"*) ;; *) return 1 ;; esac
        ;;
    esac
  done <"$certificate_nodes_file"
}

apply_exported_certificate_pin() {
  [ "$(kv_get certificate_mode)" = self-signed ] || return 0
  certificate_domain=$(kv_get certificate_domain)
  [ -n "$certificate_domain" ] || return 0
  certificate_file="$TSUB_STATE/certificates/certificates/$certificate_domain.crt"
  [ -s "$certificate_file" ] || { i18n_log ERROR "自签证书不存在，无法固定客户端证书指纹" "The self-signed certificate does not exist; client certificate pinning cannot be applied"; return 1; }
  certificate_pin=$(certificate_pin_sha256 "$certificate_file") || { i18n_log ERROR "自签证书 SHA-256 指纹计算失败" "Failed to calculate the self-signed certificate SHA-256 fingerprint"; return 1; }
  certificate_spki=$(certificate_spki_sha256 "$certificate_file") || { i18n_log ERROR "自签证书 SPKI SHA-256 计算失败" "Failed to calculate the self-signed certificate SPKI SHA-256 pin"; return 1; }
  replace_certificate_pin_in_file "$TSUB_NODES_FILE" "$certificate_pin" "$certificate_spki" || return 1
  replace_certificate_pin_in_file "$TSUB_NODE_DETAILS_FILE" "$certificate_pin" "$certificate_spki" || return 1
  validate_exported_tuic_certificate_pin "$TSUB_NODES_FILE" "$certificate_pin" "$certificate_spki" \
    || { i18n_log ERROR "TUIC 节点缺少有效的自签证书指纹" "The TUIC node is missing valid self-signed certificate pins"; return 1; }
  printf '%s\n' "$certificate_pin" >"$TSUB_TMP/certificate.pin"
  atomic_install "$TSUB_TMP/certificate.pin" "$TSUB_STATE/certificate.pin-sha256" 600
  printf '%s\n' "$certificate_spki" >"$TSUB_TMP/certificate.spki"
  atomic_install "$TSUB_TMP/certificate.spki" "$TSUB_STATE/certificate.spki-sha256" 600
}

ensure_certificate() {
  TSUB_CERT_CHANGED=false
  mode=$(kv_get certificate_mode)
  domain=$(kv_get certificate_domain)
  [ "$mode" != existing ] && [ -n "$domain" ] || return 0
  cert_root="$TSUB_STATE/certificates"
  cert_dir="$cert_root/certificates"
  cert_file="$cert_dir/$domain.crt"
  key_file="$cert_dir/$domain.key"
  generated_file="$cert_root/$domain.generated"
  mkdir -p "$cert_dir"
  chmod 700 "$cert_root" "$cert_dir"
  if [ "$mode" = self-signed ]; then
    rotate=false
    if [ ! -s "$cert_file" ] || [ ! -s "$key_file" ]; then
      rotate=true
    elif [ -r "$generated_file" ]; then
      generated_at=$(sed -n '1p' "$generated_file")
      now=$(date +%s 2>/dev/null || printf 0)
      case "$generated_at:$now" in
        *[!0-9:]*) rotate=false ;;
        *) [ $((now - generated_at)) -lt 28512000 ] || rotate=true ;;
      esac
    fi
    [ "$rotate" = true ] || return 0
    self_signed_key="$TSUB_TMP/$domain.key"
    self_signed_cert="$TSUB_TMP/$domain.crt"
    self_signed_output="$TSUB_TMP/$domain.tls"
    core=$(kv_get runtime_core)
    case "$core" in
      sing-box)
        "$TSUB_CORE_BIN" generate tls-keypair "$domain" --months 12 >"$self_signed_output"
        awk '/BEGIN.*PRIVATE KEY/{capture=1}capture{print}/END.*PRIVATE KEY/{capture=0}' "$self_signed_output" >"$self_signed_key"
        awk '/BEGIN CERTIFICATE/{capture=1}capture{print}/END CERTIFICATE/{capture=0}' "$self_signed_output" >"$self_signed_cert"
        ;;
      xray)
        self_signed_base="$TSUB_TMP/$domain"
        "$TSUB_CORE_BIN" tls cert --domain="$domain" --expire=8760h --file="$self_signed_base" >"$self_signed_output" 2>&1
        for candidate in "$self_signed_base.key" "$self_signed_base.key.pem" "$TSUB_TMP/key.pem"; do
          if [ -s "$candidate" ]; then
            [ "$candidate" = "$self_signed_key" ] || cp "$candidate" "$self_signed_key"
            break
          fi
        done
        for candidate in "$self_signed_base.crt" "$self_signed_base.cert" "$self_signed_base.crt.pem" "$TSUB_TMP/cert.pem"; do
          if [ -s "$candidate" ]; then
            [ "$candidate" = "$self_signed_cert" ] || cp "$candidate" "$self_signed_cert"
            break
          fi
        done
        ;;
      *) i18n_die "当前核心不支持生成自签证书" "The current core cannot generate a self-signed certificate" ;;
    esac
    grep -q 'BEGIN.*PRIVATE KEY' "$self_signed_key" 2>/dev/null || i18n_die "核心未生成有效的自签证书私钥" "The core did not generate a valid self-signed certificate private key"
    grep -q 'BEGIN CERTIFICATE' "$self_signed_cert" 2>/dev/null || i18n_die "核心未生成有效的自签证书" "The core did not generate a valid self-signed certificate"
    atomic_install "$self_signed_key" "$key_file" 600
    atomic_install "$self_signed_cert" "$cert_file" 600
    date +%s >"$TSUB_TMP/certificate.generated"
    atomic_install "$TSUB_TMP/certificate.generated" "$generated_file" 600
    TSUB_CERT_CHANGED=true
    return 0
  fi
  [ "$(id -u)" -eq 0 ] || i18n_die "ACME 自动证书需要 root 权限" "Automatic ACME certificates require root"
  version=$(kv_get lego_version); version=${version:-stable}
  expected=$(component_binary_sha lego)
  [ -n "$expected" ] || i18n_die "lego/$TSUB_ARCH 缺少 SHA-256" "lego/$TSUB_ARCH is missing a SHA-256"
  lego_bin="$TSUB_BIN/lego-$version-$TSUB_ARCH-$expected"
  if [ -x "$lego_bin" ] && [ "$(sha256_file "$lego_bin")" != "$expected" ]; then rm -f "$lego_bin"; fi
  [ -x "$lego_bin" ] || verify_download lego "$lego_bin"
  previous_cert_hash=''
  [ -s "$cert_file" ] && previous_cert_hash=$(sha256_file "$cert_file")
  email=$(kv_get certificate_email)
  mkdir -p "$cert_root"
  if [ "$mode" = cloudflare-dns01 ]; then
    token_file="$TSUB_TMP/cloudflare-dns.token"
    b64_decode_file certificate_api_token_b64 "$token_file" || i18n_die "DNS-01 Token 解码失败" "Failed to decode the DNS-01 token"
    CF_DNS_API_TOKEN=$(cat "$token_file"); export CF_DNS_API_TOKEN
    if [ -s "$cert_file" ]; then "$lego_bin" --path "$cert_root" --email "$email" --domains "$domain" --dns cloudflare renew --days 30
    else "$lego_bin" --path "$cert_root" --email "$email" --domains "$domain" --dns cloudflare --accept-tos run; fi
    unset CF_DNS_API_TOKEN
  else
    if have ss && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '[:.]80$'; then i18n_die "HTTP-01 需要空闲的 80 端口" "HTTP-01 requires port 80 to be available"; fi
    acme_firewall_open
    set +e
    if [ -s "$cert_file" ]; then "$lego_bin" --path "$cert_root" --email "$email" --domains "$domain" --http renew --days 30
    else "$lego_bin" --path "$cert_root" --email "$email" --domains "$domain" --http --accept-tos run; fi
    acme_result=$?
    set -e
    acme_firewall_close
    [ "$acme_result" -eq 0 ] || i18n_die "HTTP-01 证书申请失败" "HTTP-01 certificate issuance failed"
  fi
  [ -s "$cert_file" ] || i18n_die "ACME 未生成证书" "ACME did not generate a certificate"
  current_cert_hash=$(sha256_file "$cert_file")
  [ "$previous_cert_hash" = "$current_cert_hash" ] || TSUB_CERT_CHANGED=true
}

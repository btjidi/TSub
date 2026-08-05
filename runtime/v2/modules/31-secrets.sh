generate_reality_keypair() {
  output=$1
  core=$(kv_get runtime_core)
  case "$core" in
    sing-box) run_core_command "$TSUB_CORE_BIN" generate reality-keypair >"$output" ;;
    xray) run_core_command "$TSUB_CORE_BIN" x25519 >"$output" ;;
    *) return 1 ;;
  esac
}

valid_reality_key() {
  [ "${#1}" -eq 43 ] || return 1
  case "$1" in *[!A-Za-z0-9_-]*) return 1 ;; esac
}

valid_warp_key() {
  [ "${#1}" -ge 43 ] && [ "${#1}" -le 64 ] || return 1
  case "$1" in *[!A-Za-z0-9+/=_-]*) return 1 ;; esac
}

ensure_warp_identity() {
  [ "$(kv_get warp_backend)" = userspace ] || return 0
  [ "$(kv_get warp_provisioning)" = auto ] || return 0
  [ "$(kv_get warp_terms_accepted)" = true ] || die "自动 WARP 未确认服务条款"
  warp_dir="$TSUB_STATE/secrets/warp"
  warp_profile="$warp_dir/wgcf-profile.conf"
  mkdir -p "$warp_dir"
  chmod 700 "$TSUB_STATE/secrets" "$warp_dir"
  if [ ! -s "$warp_profile" ]; then
    version=$(kv_get wgcf_version); version=${version:-2.2.22}
    expected=$(component_binary_sha wgcf)
    [ -n "$expected" ] || die "wgcf/$TSUB_ARCH 缺少 SHA-256"
    warp_bin="$TSUB_BIN/wgcf-$version-$TSUB_ARCH-$expected"
    if [ -x "$warp_bin" ] && [ "$(sha256_file "$warp_bin")" != "$expected" ]; then rm -f "$warp_bin"; fi
    [ -x "$warp_bin" ] || verify_download wgcf "$warp_bin"
    warp_work="$TSUB_TMP/wgcf-register"
    rm -rf "$warp_work"; mkdir -p "$warp_work"; chmod 700 "$warp_work"
    if ! (cd "$warp_work" && "$warp_bin" register --accept-tos >/dev/null 2>register.err && "$warp_bin" generate >/dev/null 2>generate.err); then
      append_redacted_log "$warp_work/register.err"
      append_redacted_log "$warp_work/generate.err"
      die "WARP 免费身份注册失败；请稍后重试或切换手工导入"
    fi
    [ -s "$warp_work/wgcf-account.toml" ] && atomic_install "$warp_work/wgcf-account.toml" "$warp_dir/wgcf-account.toml" 600
    [ -s "$warp_work/wgcf-profile.conf" ] || die "WARP 身份生成结果缺少配置"
    atomic_install "$warp_work/wgcf-profile.conf" "$warp_profile" 600
  fi
  chmod 600 "$warp_dir"/* 2>/dev/null || true
  warp_private=$(sed -n 's/^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p')
  warp_peer=$(sed -n 's/^[[:space:]]*PublicKey[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p')
  warp_addresses=$(sed -n 's/^[[:space:]]*Address[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p')
  warp_ipv4=$(printf '%s' "$warp_addresses" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[0-9.]+/[0-9]+$' | sed -n '1p')
  warp_ipv6=$(printf '%s' "$warp_addresses" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[0-9a-fA-F:]+/[0-9]+$' | sed -n '1p')
  warp_endpoint_value=$(sed -n 's/^[[:space:]]*Endpoint[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p')
  warp_endpoint=${warp_endpoint_value%:*}; warp_port=${warp_endpoint_value##*:}
  warp_reserved=$(sed -n 's/^[[:space:]]*Reserved[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p' | tr -d '[][:space:]')
  [ -n "$warp_reserved" ] || warp_reserved=0,0,0
  valid_warp_key "$warp_private" && valid_warp_key "$warp_peer" || die "WARP 身份中的密钥格式无效"
  [ -n "$warp_ipv4" ] && [ -n "$warp_ipv6" ] || die "WARP 身份缺少双栈地址"
  case "$warp_port" in ''|*[!0-9]*) die "WARP Endpoint 端口无效" ;; esac
  case "$warp_reserved" in *[!0-9,]*) die "WARP Reserved 格式无效" ;; esac
}

ensure_runtime_secrets() {
  mkdir -p "$TSUB_STATE/secrets"
  chmod 700 "$TSUB_STATE/secrets"
  ensure_warp_identity
  ids=$(kv_get reality_auto_ids)
  [ -n "$ids" ] || return 0
  secrets_dir="$TSUB_STATE/secrets"
  mkdir -p "$secrets_dir"
  chmod 700 "$secrets_dir"
  old_ifs=$IFS; IFS=,
  for id in $ids; do
    case "$id" in ''|*[!A-Za-z0-9_]*) IFS=$old_ifs; die "Reality 入站标识无效" ;; esac
    secret_file="$secrets_dir/reality-$id.conf"
    if [ ! -s "$secret_file" ]; then
      generated="$TSUB_TMP/reality-$id.out"
      generate_reality_keypair "$generated" || { IFS=$old_ifs; die "Reality 密钥生成失败"; }
      private_key=$(sed -n 's/^[Pp]rivate[Kk]ey:[[:space:]]*//p; s/^[Pp]rivate key:[[:space:]]*//p' "$generated" | sed -n '1p')
      public_key=$(sed -n 's/^[Pp]ublic[Kk]ey:[[:space:]]*//p; s/^[Pp]ublic key:[[:space:]]*//p; s/^[Pp]assword ([Pp]ublic[Kk]ey):[[:space:]]*//p; s/^[Pp]assword:[[:space:]]*//p' "$generated" | sed -n '1p')
      valid_reality_key "$private_key" && valid_reality_key "$public_key" || { IFS=$old_ifs; die "Reality 密钥输出无法识别"; }
      printf 'private=%s\npublic=%s\n' "$private_key" "$public_key" >"$TSUB_TMP/reality-$id.conf"
      atomic_install "$TSUB_TMP/reality-$id.conf" "$secret_file" 600
    fi
  done
  IFS=$old_ifs
}

replace_runtime_secrets() {
  target=$1
  ids=$(kv_get reality_auto_ids)
  if [ -n "$ids" ]; then
    old_ifs=$IFS; IFS=,
    for id in $ids; do
      secret_file="$TSUB_STATE/secrets/reality-$id.conf"
      [ -r "$secret_file" ] || { IFS=$old_ifs; die "Reality 密钥不存在: $id"; }
      private_key=$(sed -n 's/^private=//p' "$secret_file" | sed -n '1p')
      public_key=$(sed -n 's/^public=//p' "$secret_file" | sed -n '1p')
      sed "s|__TSUB_REALITY_PRIVATE_${id}__|$private_key|g; s|__TSUB_REALITY_PUBLIC_${id}__|$public_key|g" "$target" >"$target.secrets"
      mv "$target.secrets" "$target"
    done
    IFS=$old_ifs
  fi
  if [ "$(kv_get warp_backend)" = userspace ] && [ "$(kv_get warp_provisioning)" = auto ]; then
    ensure_warp_identity
    warp_private_escaped=$(printf '%s' "$warp_private" | sed 's/[\\&|]/\\&/g')
    warp_peer_escaped=$(printf '%s' "$warp_peer" | sed 's/[\\&|]/\\&/g')
    warp_endpoint_escaped=$(printf '%s' "$warp_endpoint" | sed 's/[\\&|]/\\&/g')
    sed "s|__TSUB_WARP_PRIVATE_KEY__|$warp_private_escaped|g; s|__TSUB_WARP_PEER_PUBLIC_KEY__|$warp_peer_escaped|g; s|__TSUB_WARP_IPV4__|$warp_ipv4|g; s|__TSUB_WARP_IPV6__|$warp_ipv6|g; s|__TSUB_WARP_ENDPOINT__|$warp_endpoint_escaped|g; s|\"__TSUB_WARP_PORT__\"|$warp_port|g; s|\"__TSUB_WARP_RESERVED__\"|[$warp_reserved]|g" "$target" >"$target.warp"
    mv "$target.warp" "$target"
  fi
  chmod 600 "$target"
}

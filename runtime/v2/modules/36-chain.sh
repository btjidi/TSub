chain_diagnostic_target() {
  chain_diag_protocol=$1
  chain_diag_server=$2
  chain_diag_port=$3
  chain_diag_transport=$4
  chain_diag_tag=$5

  case "$chain_diag_server" in
    ''|*[!0-9A-Fa-f:.]*)
      if have getent; then
        getent ahosts "$chain_diag_server" >/dev/null 2>&1 \
          || i18n_log WARN "链式上游域名解析失败：$chain_diag_server" "Chain upstream DNS resolution failed: $chain_diag_server"
      elif have nslookup; then
        nslookup "$chain_diag_server" >/dev/null 2>&1 \
          || i18n_log WARN "链式上游域名解析失败：$chain_diag_server" "Chain upstream DNS resolution failed: $chain_diag_server"
      else
        i18n_log WARN '缺少 getent/nslookup，已跳过链式上游 DNS 检查' 'getent/nslookup is unavailable; skipped chain upstream DNS check'
      fi
      ;;
  esac

  if have nc; then
    case "$chain_diag_protocol:$chain_diag_transport" in
      hysteria2:*|tuic:*|*:quic)
        nc -u -z -w 3 "$chain_diag_server" "$chain_diag_port" >/dev/null 2>&1 \
          || i18n_log WARN "链式上游 UDP 端口探测失败：$chain_diag_server:$chain_diag_port" "Chain upstream UDP probe failed: $chain_diag_server:$chain_diag_port"
        ;;
      *)
        nc -z -w 3 "$chain_diag_server" "$chain_diag_port" >/dev/null 2>&1 \
          || i18n_log WARN "链式上游 TCP 端口探测失败：$chain_diag_server:$chain_diag_port" "Chain upstream TCP probe failed: $chain_diag_server:$chain_diag_port"
        ;;
    esac
  else
    i18n_log WARN '缺少 nc，已跳过链式上游端口可达性检查' 'nc is unavailable; skipped chain upstream port reachability checks'
  fi

  chain_diag_tag_count=$(grep -F -c "\"$chain_diag_tag\"" "$TSUB_ETC/config.json" 2>/dev/null || true)
  case "$chain_diag_tag_count" in ''|*[!0-9]*) chain_diag_tag_count=0 ;; esac
  [ "$chain_diag_tag_count" -ge 2 ] \
    || i18n_die "核心配置缺少链式上游出站或路由：$chain_diag_tag" "Core configuration is missing the chain upstream outbound or route: $chain_diag_tag"
}

chain_diagnostics() {
  chain_diag_count=$(kv_get chain_count); chain_diag_count=${chain_diag_count:-0}
  case "$chain_diag_count" in ''|*[!0-9]*) chain_diag_count=0 ;; esac
  [ "$chain_diag_count" -gt 0 ] || return 0

  chain_diag_file="$TSUB_TMP/chain-targets"
  b64_decode_file chain_targets_b64 "$chain_diag_file" \
    || i18n_die '链式上游诊断信息无效' 'Chain upstream diagnostic metadata is invalid'
  chain_diag_seen=0
  while IFS='|' read -r chain_diag_inbound chain_diag_protocol chain_diag_server chain_diag_port chain_diag_transport chain_diag_tag; do
    [ -n "$chain_diag_server" ] || continue
    chain_diag_seen=$((chain_diag_seen + 1))
    chain_diagnostic_target "$chain_diag_protocol" "$chain_diag_server" "$chain_diag_port" "$chain_diag_transport" "$chain_diag_tag"
  done <"$chain_diag_file"
  [ "$chain_diag_seen" -eq "$chain_diag_count" ] \
    || i18n_die '链式上游诊断数量与配置不一致' 'Chain upstream diagnostic count does not match the configuration'
  i18n_log INFO "链式上游诊断完成：$chain_diag_seen 个入站" "Chain upstream diagnostics completed for $chain_diag_seen inbound(s)"
}

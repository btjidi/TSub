summary_decode_value() {
  summary_key=$1
  summary_target="$TSUB_TMP/summary.$summary_key"
  b64_decode_file "$summary_key" "$summary_target" 2>/dev/null || return 1
  cat "$summary_target"
}

summary_subscription_host() {
  summary_host=$(kv_get subscription_hostname)
  [ -n "$summary_host" ] || summary_host=${TSUB_HOSTNAME:-}
  case "$summary_host" in \[*\]) printf '%s' "$summary_host" ;; *:*) printf '[%s]' "$summary_host" ;; *) printf '%s' "$summary_host" ;; esac
}

runtime_local_time() {
  date '+%Y/%m/%d %H:%M:%S'
}

record_runtime_change_time() {
  runtime_time_file="$TSUB_TMP/deployment-time"
  runtime_local_time >"$runtime_time_file"
  atomic_install "$runtime_time_file" "$TSUB_STATE/deployment-time" 600
}

summary_number() {
  case "$1" in ''|*[!0-9]*) printf 0 ;; *) printf '%s' "$1" ;; esac
}

summary_traffic_backend() {
  summary_backend=$(traffic_backend 2>/dev/null || printf unavailable)
  case "$summary_backend" in
    core-xray) printf '核心统计 · Xray' ;;
    core-singbox) printf '核心统计 · sing-box' ;;
    nftables|iptables) printf '端口统计 · %s' "$summary_backend" ;;
    *) printf '统计不可用' ;;
  esac
}

print_runtime_basic_info() {
  printf '\nTSub Proxy 基础信息\n'
  summary_deployment_time=$(cat "$TSUB_STATE/deployment-time" 2>/dev/null || true)
  [ -n "$summary_deployment_time" ] || summary_deployment_time='未记录（重新 Apply 后生成）'
  printf '部署时间：%s\n' "$summary_deployment_time"

  summary_core=$(kv_get runtime_core); summary_core=${summary_core:-unknown}
  summary_tier=$(kv_get runtime_tier_mode)
  [ -n "$summary_tier" ] || summary_tier=$(kv_get runtime_tier)
  [ -n "$summary_tier" ] || summary_tier=${TSUB_TIER:-auto}
  summary_node_count=$(awk 'NF { count++ } END { print count + 0 }' "$TSUB_STATE/nodes.txt" 2>/dev/null || printf 0)
  summary_node_count=$(summary_number "$summary_node_count")
  printf '%s · %s · %s 个节点' "$summary_core" "$summary_tier" "$summary_node_count"

  [ "$(kv_get certificate_mode)" != self-signed ] || printf ' · 自签证书/指纹固定'
  if subscription_enabled; then
    printf ' · 服务器订阅：%s' "$(kv_get subscription_server_port)"
    if [ "$(kv_get subscription_traffic_enabled)" = true ]; then
      printf '/流量统计 · %s' "$(summary_traffic_backend)"
    fi
  fi

  summary_rss=$(process_rss_mb 2>/dev/null || printf 0)
  summary_tunnel_rss=$(tunnel_health_rss 2>/dev/null || printf 0)
  summary_rss=$(summary_number "$summary_rss")
  summary_tunnel_rss=$(summary_number "$summary_tunnel_rss")
  summary_rss=$((summary_rss + summary_tunnel_rss))
  printf ' · %s/%s · %s/%sMB' "${TSUB_CONTAINER:-unknown}" "${TSUB_INIT:-none}" "$summary_rss" "${TSUB_MEMORY_MB:-0}"
  summary_control=${TSUB_CONTROL_COMMAND_ACTUAL:-}
  [ -n "$summary_control" ] || summary_control=$(kv_get control_command)
  [ -z "$summary_control" ] || printf ' · 服务器命令：%s' "$summary_control"
  printf '\n'
}

print_connection_info() {
  printf '核心：%s %s\n' "$(kv_get runtime_core)" "${TSUB_CORE_VERSION:-$(kv_get "$(kv_get runtime_core)_version")}"
  if [ -s "$TSUB_STATE/nodes.txt" ]; then
    printf '\n注意：以下节点链接包含 UUID、密码等敏感凭据，请妥善保管。\n'
    printf '节点信息：\n\n'
    if [ -s "$TSUB_STATE/node-details.txt" ]; then cat "$TSUB_STATE/node-details.txt"; printf '\n'
    else cat "$TSUB_STATE/nodes.txt"; fi
  else
    printf '节点信息：当前没有可输出的节点\n'
  fi
  if subscription_enabled; then
    summary_host=$(summary_subscription_host)
    summary_token=$(cat "$TSUB_STATE/subscription.token" 2>/dev/null || true)
    if [ -n "$summary_host" ] && [ -n "$summary_token" ]; then
      if [ "$(kv_get subscription_address_mode)" = dual ]; then
        summary_ipv4=$(kv_get subscription_ipv4); summary_ipv6=$(kv_get subscription_ipv6)
        [ -z "$summary_ipv4" ] || printf '\n服务器本地 HTTP 订阅（IPv4）：http://%s:%s/cgi-bin/%s\n' "$summary_ipv4" "$(kv_get subscription_server_port)" "$summary_token"
        [ -z "$summary_ipv6" ] || printf '服务器本地 HTTP 订阅（IPv6）：http://[%s]:%s/cgi-bin/%s\n' "$summary_ipv6" "$(kv_get subscription_server_port)" "$summary_token"
      else
        printf '\n服务器本地 HTTP 订阅：http://%s:%s/cgi-bin/%s\n' "$summary_host" "$(kv_get subscription_server_port)" "$summary_token"
      fi
    fi
    summary_mirror=$(summary_decode_value subscription_mirror_url_b64 2>/dev/null || true)
    [ -z "$summary_mirror" ] || printf '主控 HTTPS 镜像订阅：%s\n' "$summary_mirror"
  else
    printf '\n服务器订阅：未启用服务器订阅\n'
  fi
}

print_runtime_summary() {
  summary_action=$1
  if [ "${TSUB_SUPPRESS_SENSITIVE_OUTPUT:-false}" = true ]; then
    case "$summary_action" in update) printf 'TSub Proxy 更新成功\n' ;; repair) printf 'TSub Proxy 修复成功\n' ;; *) printf 'TSub Proxy 安装成功\n' ;; esac
    return 0
  fi
  printf '\nTSub Proxy 安装结果\n'
  print_connection_info
  if push_enabled; then printf '主动推送：已开启（每 %s 分钟）\n' "$(push_interval_minutes)"; else printf '主动推送：未开启\n'; fi
  printf '流量统计：%s\n' "$(traffic_backend 2>/dev/null || printf unavailable)"
  if [ -n "${TSUB_CONTROL_COMMAND_ACTUAL:-}" ]; then printf '服务器控制命令：%s\n' "$TSUB_CONTROL_COMMAND_ACTUAL"; fi
  [ -z "${TSUB_DEGRADED_REASON:-}" ] || printf '降级原因：%s\n' "$TSUB_DEGRADED_REASON"
  case "$summary_action" in update) printf 'TSub Proxy 更新成功\n' ;; repair) printf 'TSub Proxy 修复成功\n' ;; *) printf 'TSub Proxy 安装成功\n' ;; esac
}

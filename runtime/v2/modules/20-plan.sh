provider_budget() {
  case "$1" in
    xray) budget_rss=42; budget_install_rss=18; budget_binary_mb=38 ;;
    sing-box) budget_rss=44; budget_install_rss=20; budget_binary_mb=35 ;;
    naive) budget_rss=38; budget_install_rss=18; budget_binary_mb=25 ;;
    cloudflared) budget_rss=45; budget_install_rss=25; budget_binary_mb=35 ;;
    *) return 1 ;;
  esac
}

confirm_low_memory_install() {
  install_warning=$1
  [ "${TSUB_FORCE_LOW_MEMORY_INSTALL:-false}" != true ] || return 0
  confirmation_input=${TSUB_CONFIRM_INPUT:-/dev/tty}
  confirmation_output=${TSUB_CONFIRM_OUTPUT:-/dev/tty}
  if [ ! -r "$confirmation_input" ] || [ ! -w "$confirmation_output" ]; then
    die "$install_warning；当前为非交互执行，无法确认强制安装"
  fi
  printf '%s\n' "$install_warning" >"$confirmation_output"
  printf '%s' '继续可能触发 OOM 并导致安装回滚。输入 Y 强制安装，其他输入取消：' >>"$confirmation_output"
  install_confirmation=''
  IFS= read -r install_confirmation <"$confirmation_input" || true
  case "$install_confirmation" in
    y|Y)
      TSUB_FORCE_LOW_MEMORY_INSTALL=true
      add_degraded_reason "用户已确认低内存强制安装"
      log WARN "用户已确认低内存强制安装；继续执行"
      ;;
    *) die "$install_warning；用户未确认强制安装" ;;
  esac
}

require_install_headroom() {
  install_reserve=12
  if [ "$TSUB_MEMORY_MB" -le 96 ]; then
    install_reserve=16
    [ "$(kv_get "${core}_${TSUB_ARCH}_format")" != tar.gz ] || install_reserve=24
    [ "$TSUB_MEMORY_MB" -gt 64 ] || [ "$(kv_get "${core}_${TSUB_ARCH}_format")" != tar.gz ] || install_reserve=40
  fi
  install_required=$((install_rss + install_reserve))
  if [ "$TSUB_MEMORY_AVAILABLE_MB" -lt "$install_required" ]; then
    if [ "$TSUB_MEMORY_MB" -le 64 ] && [ "$(kv_get "${core}_${TSUB_ARCH}_format")" = tar.gz ]; then
      install_warning="64MB 节点不能安全解包 $core；建议改用经过 SHA-256 校验的预解包 binary 资产"
    else
      install_warning="当前可用内存 ${TSUB_MEMORY_AVAILABLE_MB}MB 不足以安全安装；需要至少 ${install_required}MB 可用内存"
    fi
    confirm_low_memory_install "$install_warning"
  fi
}

planned_core_is_installed() {
  planned_version=$(kv_get "${core}_version")
  planned_sha=$(kv_get "${core}_${TSUB_ARCH}_binary_sha256")
  [ -n "$planned_sha" ] || planned_sha=$(kv_get "${core}_${TSUB_ARCH}_sha256")
  [ -n "$planned_version" ] && [ -n "$planned_sha" ] || return 1
  planned_target="$TSUB_BIN/$core-$planned_version-$TSUB_ARCH-$planned_sha"
  [ -x "$planned_target" ] && [ "$(sha256_file "$planned_target")" = "$planned_sha" ]
}

plan_runtime() {
  TSUB_STAGE=plan
  core=$(kv_get runtime_core)
  case "$core" in xray|sing-box|naive) : ;; *) die "配置未选择受支持的主核心" ;; esac
  inbound_count=$(kv_get inbound_count)
  case "$inbound_count" in ''|*[!0-9]*) die "inbound_count 无效" ;; esac
  [ "$inbound_count" -gt 0 ] || die "至少需要一个入站"
  provider_budget "$core"
  estimated_rss=$budget_rss
  TSUB_ESTIMATED_CORE_RSS=$budget_rss
  TSUB_ESTIMATED_CLOUDFLARED_RSS=0
  install_rss=$budget_install_rss
  binary_mb=$budget_binary_mb
  tunnels=$(kv_get tunnel_count); tunnels=${tunnels:-0}
  if [ "$tunnels" -gt 0 ]; then
    [ "$TSUB_TIER" != tiny ] || die "tiny 档默认拒绝 cloudflared；请使用核心内协议或提高资源"
    [ "$TSUB_MEMORY_MB" -ge 128 ] || log WARN "隧道建议服务器 cgroup 内存上限至少为 128MB；当前为 ${TSUB_MEMORY_MB}MB"
    estimated_rss=$((estimated_rss + 45))
    TSUB_ESTIMATED_CLOUDFLARED_RSS=45
    binary_mb=$((binary_mb + 35))
  fi
  if [ "$(kv_get subscription_server_enabled)" = true ]; then
    estimated_rss=$((estimated_rss + 2))
    binary_mb=$((binary_mb + 2))
  fi
  certificate_mode=$(kv_get certificate_mode)
  case "$certificate_mode" in existing|self-signed) : ;; *) binary_mb=$((binary_mb + 20)) ;; esac
  [ $((estimated_rss * 100)) -le $((TSUB_MEMORY_MB * 80)) ] || die "预计常驻内存 ${estimated_rss}MB 超过 cgroup 80% 预算"
  required_kb=$((binary_mb * 2 * 1024 + 8192))
  [ "$TSUB_DISK_KB" -ge "$required_kb" ] || die "磁盘不足：至少需要 ${required_kb}KB 可用空间"
  [ "$TSUB_MEMORY_MB" -ge 56 ] || die "低于 56MB 的内存限制不受支持"
  planned_core_is_installed || require_install_headroom
  case "$TSUB_PID_LIMIT" in
    ''|max|*[!0-9]*) : ;;
    *) required_pids=$((12 + tunnels * 4)); [ "$TSUB_PID_LIMIT" -ge "$required_pids" ] || die "PID 上限 $TSUB_PID_LIMIT 低于所需 $required_pids" ;;
  esac
  if [ "$(id -u)" -ne 0 ]; then
    old_ifs=$IFS; IFS=,
    for port_spec in $(kv_get inbound_ports); do
      port_number=${port_spec%/*}
      if [ "$port_number" -lt 1024 ]; then IFS=$old_ifs; die "无特权模式不能绑定低于 1024 的端口"; fi
    done
    IFS=$old_ifs
  fi
  if [ "$(kv_get firewall_enabled)" = true ] && [ "$TSUB_TIER" = tiny ]; then
    add_degraded_reason "tiny 档已跳过端口放行规则"
    log WARN "tiny 档自动跳过端口放行规则"
  elif [ "$(kv_get firewall_enabled)" = true ] && [ "$TSUB_HAS_NET_ADMIN" != true ]; then
    add_degraded_reason "缺少 CAP_NET_ADMIN，已跳过端口放行规则"
    log WARN "缺少 CAP_NET_ADMIN，已跳过端口放行规则"
  fi
  if [ -n "$(kv_get udp_hop_rules)" ]; then
    [ "$TSUB_HAS_NET_ADMIN" = true ] || die "Hysteria2 端口跳跃需要 CAP_NET_ADMIN"
    [ "$(id -u)" -eq 0 ] || die "Hysteria2 端口跳跃需要 root 权限"
    have nft || have iptables || die "Hysteria2 端口跳跃需要 nftables 或 iptables"
  fi
  if [ "$(kv_get warp_backend)" = tun ] && [ "$TSUB_HAS_TUN" != true ]; then
    die "配置要求 TUN WARP，但 /dev/net/tun 不可用"
  fi
  if [ ! -f "$TSUB_ETC/config.json" ] && have ss; then
    old_ifs=$IFS; IFS=,
    for port_spec in $(kv_get inbound_ports); do
      port_number=${port_spec%/*}
      if ss -lntu 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]${port_number}$"; then
        IFS=$old_ifs
        die "端口 $port_number 已被占用"
      fi
    done
    IFS=$old_ifs
    subscription_port=$(kv_get subscription_server_port)
    if [ -n "$subscription_port" ] && ss -lntu 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]${subscription_port}$"; then
      die "订阅端口 $subscription_port 已被占用"
    fi
  fi
  emit_event running "plan accepted: core=$core tier=$TSUB_TIER memory=${TSUB_MEMORY_MB}MB"
}

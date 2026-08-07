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
  install_warning_zh=$1
  install_warning_en=$2
  install_warning=$(i18n_text "$install_warning_zh" "$install_warning_en")
  [ "${TSUB_FORCE_LOW_MEMORY_INSTALL:-false}" != true ] || return 0
  confirmation_input=${TSUB_CONFIRM_INPUT:-/dev/tty}
  confirmation_output=${TSUB_CONFIRM_OUTPUT:-/dev/tty}
  if [ ! -r "$confirmation_input" ] || [ ! -w "$confirmation_output" ]; then
    i18n_die "$install_warning_zh；当前为非交互执行，无法确认强制安装" "$install_warning_en; forced installation cannot be confirmed in non-interactive mode"
  fi
  printf '%s\n' "$install_warning" >"$confirmation_output"
  i18n_text '继续可能触发 OOM 并导致安装回滚。输入 Y 强制安装，其他输入取消：' 'Continuing may trigger OOM and roll back the installation. Enter Y to force installation; any other input cancels: ' >>"$confirmation_output"
  install_confirmation=''
  IFS= read -r install_confirmation <"$confirmation_input" || true
  case "$install_confirmation" in
    y|Y)
      TSUB_FORCE_LOW_MEMORY_INSTALL=true
      i18n_degraded "用户已确认低内存强制安装" "Low-memory forced installation was confirmed"
      i18n_log WARN "用户已确认低内存强制安装；继续执行" "Low-memory forced installation confirmed; continuing"
      ;;
    *) i18n_die "$install_warning_zh；用户未确认强制安装" "$install_warning_en; forced installation was not confirmed" ;;
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
      install_warning_zh="64MB 节点不能安全解包 $core；建议改用经过 SHA-256 校验的预解包 binary 资产"
      install_warning_en="A 64MB node cannot safely unpack $core; use a pre-extracted binary asset verified with SHA-256"
    else
      install_warning_zh="当前可用内存 ${TSUB_MEMORY_AVAILABLE_MB}MB 不足以安全安装；需要至少 ${install_required}MB 可用内存"
      install_warning_en="${TSUB_MEMORY_AVAILABLE_MB}MB of available memory is insufficient for safe installation; at least ${install_required}MB is required"
    fi
    confirm_low_memory_install "$install_warning_zh" "$install_warning_en"
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
  case "$core" in xray|sing-box|naive) : ;; *) i18n_die "配置未选择受支持的主核心" "No supported primary core is selected" ;; esac
  inbound_count=$(kv_get inbound_count)
  case "$inbound_count" in ''|*[!0-9]*) i18n_die "inbound_count 无效" "Invalid inbound_count" ;; esac
  [ "$inbound_count" -gt 0 ] || i18n_die "至少需要一个入站" "At least one inbound is required"
  provider_budget "$core"
  estimated_rss=$budget_rss
  TSUB_ESTIMATED_CORE_RSS=$budget_rss
  TSUB_ESTIMATED_CLOUDFLARED_RSS=0
  install_rss=$budget_install_rss
  binary_mb=$budget_binary_mb
  tunnels=$(kv_get tunnel_count); tunnels=${tunnels:-0}
  if [ "$tunnels" -gt 0 ]; then
    [ "$TSUB_TIER" != tiny ] || i18n_die "tiny 档默认拒绝 cloudflared；请使用核心内协议或提高资源" "The tiny tier does not allow cloudflared by default; use a core-native protocol or increase resources"
    [ "$TSUB_MEMORY_MB" -ge 128 ] || i18n_log WARN "隧道建议服务器 cgroup 内存上限至少为 128MB；当前为 ${TSUB_MEMORY_MB}MB" "Tunnels should have a cgroup memory limit of at least 128MB; current limit is ${TSUB_MEMORY_MB}MB"
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
  [ $((estimated_rss * 100)) -le $((TSUB_MEMORY_MB * 80)) ] || i18n_die "预计常驻内存 ${estimated_rss}MB 超过 cgroup 80% 预算" "Estimated resident memory ${estimated_rss}MB exceeds 80% of the cgroup budget"
  required_kb=$((binary_mb * 2 * 1024 + 8192))
  [ "$TSUB_DISK_KB" -ge "$required_kb" ] || i18n_die "磁盘不足：至少需要 ${required_kb}KB 可用空间" "Insufficient disk space: at least ${required_kb}KB is required"
  [ "$TSUB_MEMORY_MB" -ge 56 ] || i18n_die "低于 56MB 的内存限制不受支持" "Memory limits below 56MB are not supported"
  planned_core_is_installed || require_install_headroom
  case "$TSUB_PID_LIMIT" in
    ''|max|*[!0-9]*) : ;;
    *) required_pids=$((12 + tunnels * 4)); [ "$TSUB_PID_LIMIT" -ge "$required_pids" ] || i18n_die "PID 上限 $TSUB_PID_LIMIT 低于所需 $required_pids" "PID limit $TSUB_PID_LIMIT is below the required $required_pids" ;;
  esac
  if [ "$(id -u)" -ne 0 ]; then
    old_ifs=$IFS; IFS=,
    for port_spec in $(kv_get inbound_ports); do
      port_number=${port_spec%/*}
      if [ "$port_number" -lt 1024 ]; then IFS=$old_ifs; i18n_die "无特权模式不能绑定低于 1024 的端口" "Unprivileged mode cannot bind ports below 1024"; fi
    done
    IFS=$old_ifs
  fi
  if [ "$(kv_get firewall_enabled)" = true ] && [ "$TSUB_TIER" = tiny ]; then
    i18n_degraded "tiny 档已跳过端口放行规则" "Port allow rules were skipped on the tiny tier"
    i18n_log WARN "tiny 档自动跳过端口放行规则" "Port allow rules were automatically skipped on the tiny tier"
  elif [ "$(kv_get firewall_enabled)" = true ] && [ "$TSUB_HAS_NET_ADMIN" != true ]; then
    i18n_degraded "缺少 CAP_NET_ADMIN，已跳过端口放行规则" "Port allow rules were skipped because CAP_NET_ADMIN is unavailable"
    i18n_log WARN "缺少 CAP_NET_ADMIN，已跳过端口放行规则" "Port allow rules were skipped because CAP_NET_ADMIN is unavailable"
  fi
  if [ -n "$(kv_get udp_hop_rules)" ]; then
    [ "$TSUB_HAS_NET_ADMIN" = true ] || i18n_die "Hysteria2 端口跳跃需要 CAP_NET_ADMIN" "Hysteria2 port hopping requires CAP_NET_ADMIN"
    [ "$(id -u)" -eq 0 ] || i18n_die "Hysteria2 端口跳跃需要 root 权限" "Hysteria2 port hopping requires root"
    have nft || have iptables || i18n_die "Hysteria2 端口跳跃需要 nftables 或 iptables" "Hysteria2 port hopping requires nftables or iptables"
  fi
  if [ "$(kv_get warp_backend)" = tun ] && [ "$TSUB_HAS_TUN" != true ]; then
    i18n_die "配置要求 TUN WARP，但 /dev/net/tun 不可用" "The configuration requires TUN WARP, but /dev/net/tun is unavailable"
  fi
  if [ ! -f "$TSUB_ETC/config.json" ] && have ss; then
    old_ifs=$IFS; IFS=,
    for port_spec in $(kv_get inbound_ports); do
      port_number=${port_spec%/*}
      if ss -lntu 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]${port_number}$"; then
        IFS=$old_ifs
        i18n_die "端口 $port_number 已被占用" "Port $port_number is already in use"
      fi
    done
    IFS=$old_ifs
    subscription_port=$(kv_get subscription_server_port)
    if [ -n "$subscription_port" ] && ss -lntu 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]${subscription_port}$"; then
      i18n_die "订阅端口 $subscription_port 已被占用" "Subscription port $subscription_port is already in use"
    fi
  fi
  emit_event running "$(i18n_text "计划检查通过：核心=$core 档位=$TSUB_TIER 内存=${TSUB_MEMORY_MB}MB" "Plan accepted: core=$core tier=$TSUB_TIER memory=${TSUB_MEMORY_MB}MB")"
}

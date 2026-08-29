# shellcheck shell=sh

control_is_owned() {
  control_owned_path=$1
  [ -f "$control_owned_path" ] && grep -q '^# TSub Proxy managed control launcher$' "$control_owned_path" 2>/dev/null
}

load_control_command() {
  TSUB_CONTROL_COMMAND_ACTUAL=$(cat "$TSUB_STATE/control-command.name" 2>/dev/null || true)
  case "$TSUB_CONTROL_COMMAND_ACTUAL" in ''|*[!a-z0-9_-]*) TSUB_CONTROL_COMMAND_ACTUAL='' ;; esac
}

control_remove_path() {
  control_remove_target=$1
  [ -n "$control_remove_target" ] && control_is_owned "$control_remove_target" || return 0
  if [ -w "$control_remove_target" ] || [ -w "$(dirname "$control_remove_target")" ]; then
    rm -f "$control_remove_target"
  elif have sudo && sudo -n true >/dev/null 2>&1; then
    sudo -n rm -f "$control_remove_target"
  fi
}

control_write_launcher() {
  control_source=$1 control_target=$2 control_use_sudo=$3
  if [ "$control_use_sudo" = true ]; then
    control_temp_target="${control_target}.new.$$"
    sudo -n cp "$control_source" "$control_temp_target" || return 1
    sudo -n chmod 755 "$control_temp_target" || { sudo -n rm -f "$control_temp_target"; return 1; }
    sudo -n mv -f "$control_temp_target" "$control_target" || { sudo -n rm -f "$control_temp_target"; return 1; }
  else
    atomic_install "$control_source" "$control_target" 755
  fi
}

install_control_command() {
  control_requested=$(kv_get control_command); control_requested=${control_requested:-tsub}
  case "$control_requested" in ''|[!a-z]*|*[!a-z0-9_-]*) i18n_log WARN "服务器控制命令格式无效: $control_requested" "Invalid server control command: $control_requested"; return 1 ;; esac
  [ "${#control_requested}" -le 32 ] || { i18n_log WARN "服务器控制命令超过 32 位" "The server control command exceeds 32 characters"; return 1; }
  control_use_sudo=false
  if [ "$(id -u)" -eq 0 ]; then control_dir=${TSUB_CONTROL_SYSTEM_BIN:-/usr/local/bin}; mkdir -p "$control_dir"
  elif have sudo && sudo -n true >/dev/null 2>&1; then control_dir=${TSUB_CONTROL_SYSTEM_BIN:-/usr/local/bin}; control_use_sudo=true; sudo -n mkdir -p "$control_dir" || return 1
  else control_dir=${TSUB_CONTROL_USER_BIN:-"$HOME/.local/bin"}; mkdir -p "$control_dir"; fi
  control_index=1
  while [ "$control_index" -le 999 ]; do
    if [ "$control_index" -eq 1 ]; then control_candidate=$control_requested; else control_candidate="${control_requested}-${control_index}"; fi
    control_target="$control_dir/$control_candidate"
    control_resolved=$(command -v "$control_candidate" 2>/dev/null || true)
    control_resolved_available=true; [ -z "$control_resolved" ] || control_is_owned "$control_resolved" || control_resolved_available=false
    control_target_available=true; [ ! -e "$control_target" ] || control_is_owned "$control_target" || control_target_available=false
    [ "$control_resolved_available" = true ] && [ "$control_target_available" = true ] && break
    control_index=$((control_index + 1))
  done
  [ "$control_index" -le 999 ] || { i18n_log WARN "无法为服务器控制命令找到可用名称" "No available name could be found for the server control command"; return 1; }
  control_config_quoted=$(printf '%s' "$2" | sed "s/'/'\\\\''/g")
  control_runtime_quoted=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
  control_launcher="$TSUB_TMP/control-launcher"
  cat >"$control_launcher" <<EOF
#!/bin/sh
# TSub Proxy managed control launcher
TSUB_CONFIG='$control_config_quoted'
export TSUB_CONFIG
exec '$control_runtime_quoted' menu
EOF
  control_old_path=$(cat "$TSUB_STATE/control-command.path" 2>/dev/null || true)
  control_write_launcher "$control_launcher" "$control_target" "$control_use_sudo" || return 1
  [ -z "$control_old_path" ] || [ "$control_old_path" = "$control_target" ] || control_remove_path "$control_old_path"
  printf '%s\n' "$control_candidate" >"$TSUB_STATE/control-command.name"
  printf '%s\n' "$control_target" >"$TSUB_STATE/control-command.path"
  chmod 600 "$TSUB_STATE/control-command.name" "$TSUB_STATE/control-command.path"
  TSUB_CONTROL_COMMAND_ACTUAL=$control_candidate
  return 0
}

remove_control_command() {
  control_old_path=$(cat "$TSUB_STATE/control-command.path" 2>/dev/null || true)
  [ -z "$control_old_path" ] || control_remove_path "$control_old_path"
  rm -f "$TSUB_STATE/control-command.name" "$TSUB_STATE/control-command.path"
  TSUB_CONTROL_COMMAND_ACTUAL=''
}

control_confirm_word() {
  control_prompt_zh=$1 control_prompt_en=$2 control_word=$3
  i18n_text "$control_prompt_zh" "$control_prompt_en"
  control_confirm=''; IFS= read -r control_confirm || true
  [ "$control_confirm" = "$control_word" ] || [ "$control_confirm" = "${control_word#确认}" ]
}

control_show_status() {
  load_installed_core
  printf '\n'; i18n_print '服务状态' 'Service status'
  core_pid=$(cat "$TSUB_STATE/core.pid" 2>/dev/null || true)
  case "$core_pid" in ''|*[!0-9]*) i18n_print '核心：未运行' 'Core: stopped' ;; *) kill -0 "$core_pid" 2>/dev/null && i18n_print '核心：运行中' 'Core: running' || i18n_print '核心：未运行' 'Core: stopped' ;; esac
  named_rss=$(tunnel_health_rss named 2>/dev/null || printf 0)
  [ "$named_rss" -gt 0 ] 2>/dev/null && i18n_print '固定 Tunnel：运行中' 'Named Tunnel: running' || i18n_print '固定 Tunnel：未运行或未配置' 'Named Tunnel: stopped or not configured'
  case "$(tunnel_quick_status 2>/dev/null || printf not-required)" in
    ready) i18n_print '临时 Tunnel：运行中' 'Quick Tunnel: running' ;;
    pending) i18n_print '临时 Tunnel：等待恢复' 'Quick Tunnel: waiting to recover' ;;
    *) i18n_print '临时 Tunnel：未配置' 'Quick Tunnel: not configured' ;;
  esac
  subscription_health_check >/dev/null 2>&1 && i18n_print '服务器订阅：正常' 'Server subscription: healthy' || i18n_print '服务器订阅：异常或未启用' 'Server subscription: unavailable or disabled'
}

control_agent_process_running() {
  if have pgrep; then
    pgrep -f '[t]sub-proxy.sh agent' >/dev/null 2>&1
  else
    ps ax 2>/dev/null | grep '[t]sub-proxy.sh agent' >/dev/null 2>&1
  fi
}

control_systemd_available() {
  [ -d /run/systemd/system ] && have systemctl
}

control_agent_status() {
  printf '\n'; i18n_print 'Agent 与调度状态' 'Agent and scheduler status'
  if agent_enabled; then
    i18n_print 'Agent 配置：已配置' 'Agent configuration: configured'
  else
    i18n_print 'Agent 配置：缺失（需要主控地址、部署 ID 和 Token）' 'Agent configuration: incomplete (controller URL, deployment ID, and token are required)'
  fi
  if control_systemd_available; then
      i18n_print '调度器：systemd' 'Scheduler: systemd'
      if [ "$(id -u)" -ne 0 ]; then
        i18n_print '调度器状态：当前用户不是 root，无法创建系统 Agent 服务' 'Scheduler status: the current user is not root; a system Agent service cannot be created'
      elif systemctl is-active --quiet tsub-agent.service 2>/dev/null; then
        i18n_print 'Agent 服务：运行中' 'Agent service: running'
      elif systemctl is-enabled --quiet tsub-agent.service 2>/dev/null; then
        i18n_print 'Agent 服务：已启用但未运行' 'Agent service: enabled but not running'
      else
        i18n_print 'Agent 服务：未安装' 'Agent service: not installed'
      fi
  elif [ "$TSUB_INIT" = openrc ]; then
    i18n_print '调度器：OpenRC' 'Scheduler: OpenRC'
  elif [ "$TSUB_INIT" = crontab ] || have crontab; then
    i18n_print '调度器：crontab' 'Scheduler: crontab'
  else
      i18n_print '调度器：未检测到可用入口（缺少 crontab 或系统服务权限）' 'Scheduler: no usable entry detected (crontab or system service privilege is missing)'
      case "$TSUB_OS_FAMILY" in
        debian) i18n_print '建议：sudo apt-get update && sudo apt-get install -y cron' 'Suggestion: sudo apt-get update && sudo apt-get install -y cron' ;;
        alpine) i18n_print '建议：sudo apk add --no-cache dcron' 'Suggestion: sudo apk add --no-cache dcron' ;;
        rhel) i18n_print '建议：sudo dnf install -y cronie' 'Suggestion: sudo dnf install -y cronie' ;;
        *) i18n_print '建议：使用 root 安装并启用系统调度器' 'Suggestion: install and enable a system scheduler as root' ;;
      esac
  fi
  if control_agent_process_running; then
    i18n_print 'Agent 进程：运行中' 'Agent process: running'
  else
    i18n_print 'Agent 进程：未运行（主控不会收到心跳）' 'Agent process: not running (the controller will not receive heartbeats)'
  fi
  [ -f "$TSUB_LOG" ] && { i18n_print '最近 Agent 日志：' 'Recent Agent log:'; grep -Ei 'agent|heartbeat|scheduler' "$TSUB_LOG" | tail -n 5 | sed 's/Authorization: Bearer [^ ]*/Authorization: Bearer <redacted>/g'; }
}

control_agent_repair() {
  agent_enabled || { i18n_print '无法修复：Agent 配置不完整，请重新绑定节点。' 'Cannot repair: Agent configuration is incomplete; bind the node again.'; return 1; }
  if [ "$(id -u)" -ne 0 ] && control_systemd_available; then
    i18n_print '当前不是 root，无法直接创建系统服务。请复制以下命令并输入 sudo 密码：' 'The current user is not root and cannot create a system service. Run the following command with sudo:'
    printf 'sudo env TSUB_CONFIG=%s TSUB_ETC=%s TSUB_STATE=%s TSUB_BIN=%s %s agent-install\n' \
      "$TSUB_ETC/runtime.conf" "$TSUB_ETC" "$TSUB_STATE" "$TSUB_BIN" "$TSUB_BIN/tsub-proxy.sh"
    return 2
  fi
  control_confirm_word '将安装或刷新 Agent 调度服务。输入 REPAIR 确认：' 'This will install or refresh the Agent scheduler. Enter REPAIR to confirm: ' REPAIR || { i18n_print '已取消。' 'Canceled.'; return 1; }
  install_agent_service "$TSUB_BIN/tsub-proxy.sh" "$TSUB_ETC/runtime.conf"
}

control_agent_heartbeat_test() {
  agent_enabled || { i18n_print '心跳测试失败：Agent 配置不完整。' 'Heartbeat test failed: Agent configuration is incomplete.'; return 1; }
  i18n_print '正在发送一次心跳测试，请稍候...' 'Sending one heartbeat test, please wait...'
  if agent_heartbeat_now; then
    i18n_print '心跳测试成功，主控已收到请求。' 'Heartbeat test succeeded; the controller received the request.'
  else
    i18n_print '心跳测试失败，请检查 Agent Token、主控地址、DNS 和 TLS；详细信息见日志。' 'Heartbeat test failed; check the Agent token, controller URL, DNS, and TLS. See the log for details.'
    return 1
  fi
}

control_restart_services() {
  plan_runtime || return 1
  load_installed_core || return 1
  ensure_tunnel_binary || return 1
  prepare_service_identity || return 1
  traffic_checkpoint || return 1
  service_stop || return 1
  service_start || return 1
  health_check || return 1
  tunnel_reconcile_quick || i18n_degraded '临时隧道未恢复，核心服务已继续运行' 'Quick Tunnel did not recover; core services are still running'
  if ! push_snapshot; then
    i18n_degraded '核心已重启，但主动推送失败' 'Core restarted, but the snapshot push failed'
  fi
  if ! agent_heartbeat_now; then
    i18n_degraded '核心已重启，但 Agent 心跳上报失败' 'Core restarted, but the Agent heartbeat failed'
  fi
  emit_event succeeded "$(i18n_text '重启完成' 'Restart completed')"
}

control_maintenance_menu() {
  while :; do
    printf '\n'; i18n_print '维护操作' 'Maintenance operations'
    i18n_print '1. 重启核心服务' '1. Restart core service'
    i18n_print '2. 更新 Runtime' '2. Update Runtime'
    i18n_print '3. 回滚上一配置' '3. Roll back to the previous configuration'
    i18n_print '4. 查看最近日志' '4. Show recent logs'
    i18n_print '0. 返回上一级' '0. Back'
    i18n_text '请选择：' 'Select an option: '
    IFS= read -r choice || return 0
    case "$choice" in
      1)
        control_confirm_word '重启会短暂中断代理连接。输入 RESTART 确认：' 'Restarting briefly interrupts proxy connections. Enter RESTART to confirm: ' RESTART || { i18n_print '已取消。' 'Canceled.'; continue; }
        control_restart_services || i18n_print '重启失败，请查看最近日志。' 'Restart failed; check the recent log.' ;;
      2)
        control_confirm_word '更新 Runtime 可能会重新加载 Agent。输入 UPDATE 确认：' 'Updating Runtime may reload the Agent. Enter UPDATE to confirm: ' UPDATE || { i18n_print '已取消。' 'Canceled.'; continue; }
        agent_maybe_update_runtime force || i18n_print 'Runtime 更新未执行。' 'Runtime update was not performed.' ;;
      3)
        control_confirm_word '回滚会恢复上一份配置并重启服务。输入 ROLLBACK 确认：' 'Rollback restores the previous configuration and restarts services. Enter ROLLBACK to confirm: ' ROLLBACK || { i18n_print '已取消。' 'Canceled.'; continue; }
        rollback_runtime; record_runtime_change_time; agent_heartbeat_now || true ;;
      4) tail -n 80 "$TSUB_LOG" 2>/dev/null || i18n_print '暂无日志。' 'No logs available.' ;;
      0|q|Q) return 0 ;;
      *) i18n_print '无效选项。' 'Invalid option.' ;;
    esac
  done
}

control_menu() {
  print_runtime_basic_info
  while :; do
    printf '\n'; i18n_print 'TSub Proxy 控制菜单' 'TSub Proxy control menu'
    i18n_print '1. 显示全部节点与订阅链接' '1. Show all nodes and subscription links'
    i18n_print '2. 查看服务状态' '2. Show service status'
    i18n_print '3. 运行只读诊断' '3. Run read-only diagnostics'
    i18n_print '4. 查看 Agent 与调度状态' '4. Show Agent and scheduler status'
    i18n_print '5. 修复 Agent 调度' '5. Repair Agent scheduler'
    i18n_print '6. 立即测试心跳' '6. Test heartbeat now'
    i18n_print '7. 重新获取临时隧道域名' '7. Request a new Quick Tunnel hostname'
    i18n_print '8. 同步节点并主动推送' '8. Sync nodes and push to the controller'
    i18n_print '9. 进入维护操作' '9. Maintenance operations'
    i18n_print '10. 卸载 TSub Proxy' '10. Uninstall TSub Proxy'
    i18n_print '0. 退出' '0. Exit'
    i18n_text '请选择：' 'Select an option: '
    IFS= read -r control_choice || return 0
    case "$control_choice" in
      1) export_nodes; print_connection_info ;;
      2) control_show_status ;;
      3) load_installed_core; validate_config "$TSUB_ETC/config.json" && i18n_print '诊断通过。' 'Diagnostics passed.' || i18n_print '诊断发现问题，请查看上方输出。' 'Diagnostics found issues; review the output above.' ;;
      4) control_agent_status ;;
      5) control_agent_repair ;;
      6) control_agent_heartbeat_test ;;
      7) tunnel_refresh_quick && i18n_print '临时隧道已刷新。' 'Quick Tunnel refreshed.' || i18n_print '临时隧道刷新失败，请查看日志。' 'Quick Tunnel refresh failed; check the log.' ;;
      8) export_nodes && push_snapshot && i18n_print '节点已同步并主动推送。' 'Nodes synchronized and pushed.' || i18n_print '节点同步或主动推送失败，请查看日志。' 'Node synchronization or push failed; check the log.' ;;
      9) control_maintenance_menu ;;
      10)
        control_confirm_word '卸载将停止代理并清理 TSub 管理的服务、规则和控制命令。输入 UNINSTALL 确认：' 'Uninstalling stops the proxy and removes TSub-managed services, rules, and control commands. Enter UNINSTALL to confirm: ' UNINSTALL || { i18n_print '已取消卸载。' 'Uninstall canceled.'; continue; }
        uninstall_runtime; return 0 ;;
      0|q|Q) return 0 ;;
      *) i18n_print '无效选项。' 'Invalid option.' ;;
    esac
  done
}

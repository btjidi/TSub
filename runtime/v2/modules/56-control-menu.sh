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
        plan_runtime; load_installed_core; ensure_tunnel_binary; prepare_service_identity; traffic_checkpoint; service_stop; service_start; health_check; tunnel_reconcile_quick || true; push_snapshot || true; agent_heartbeat_now || true; emit_event succeeded "$(i18n_text '重启完成' 'Restart completed')" ;;
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
    i18n_print '4. 重新获取临时隧道域名' '4. Request a new Quick Tunnel hostname'
    i18n_print '5. 同步节点并主动推送' '5. Sync nodes and push to the controller'
    i18n_print '6. 进入维护操作' '6. Maintenance operations'
    i18n_print '7. 卸载 TSub Proxy' '7. Uninstall TSub Proxy'
    i18n_print '0. 退出' '0. Exit'
    i18n_text '请选择：' 'Select an option: '
    IFS= read -r control_choice || return 0
    case "$control_choice" in
      1) export_nodes; print_connection_info ;;
      2) control_show_status ;;
      3) load_installed_core; validate_config "$TSUB_ETC/config.json" && i18n_print '诊断通过。' 'Diagnostics passed.' || i18n_print '诊断发现问题，请查看上方输出。' 'Diagnostics found issues; review the output above.' ;;
      4) tunnel_refresh_quick ;;
      5) export_nodes; push_snapshot && i18n_print '节点已同步并主动推送。' 'Nodes synchronized and pushed.' || i18n_print '节点同步或主动推送失败。' 'Node synchronization or push failed.' ;;
      6) control_maintenance_menu ;;
      7)
        control_confirm_word '卸载将停止代理并清理 TSub 管理的服务、规则和控制命令。输入 UNINSTALL 确认：' 'Uninstalling stops the proxy and removes TSub-managed services, rules, and control commands. Enter UNINSTALL to confirm: ' UNINSTALL || { i18n_print '已取消卸载。' 'Uninstall canceled.'; continue; }
        uninstall_runtime; return 0 ;;
      0|q|Q) return 0 ;;
      *) i18n_print '无效选项。' 'Invalid option.' ;;
    esac
  done
}

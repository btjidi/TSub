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
  if [ "$(id -u)" -eq 0 ]; then
    control_dir=${TSUB_CONTROL_SYSTEM_BIN:-/usr/local/bin}
    mkdir -p "$control_dir"
  elif have sudo && sudo -n true >/dev/null 2>&1; then
    control_dir=${TSUB_CONTROL_SYSTEM_BIN:-/usr/local/bin}
    control_use_sudo=true
    sudo -n mkdir -p "$control_dir" || return 1
  else
    control_dir=${TSUB_CONTROL_USER_BIN:-"$HOME/.local/bin"}
    mkdir -p "$control_dir"
  fi

  control_index=1
  while [ "$control_index" -le 999 ]; do
    if [ "$control_index" -eq 1 ]; then control_candidate=$control_requested
    else control_candidate="${control_requested}-${control_index}"; fi
    control_target="$control_dir/$control_candidate"
    control_resolved=$(command -v "$control_candidate" 2>/dev/null || true)
    control_resolved_available=true
    [ -z "$control_resolved" ] || control_is_owned "$control_resolved" || control_resolved_available=false
    control_target_available=true
    [ ! -e "$control_target" ] || control_is_owned "$control_target" || control_target_available=false
    if [ "$control_resolved_available" = true ] && [ "$control_target_available" = true ]; then break; fi
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
  if [ -n "$control_old_path" ] && [ "$control_old_path" != "$control_target" ]; then control_remove_path "$control_old_path"; fi
  printf '%s\n' "$control_candidate" >"$TSUB_STATE/control-command.name"
  printf '%s\n' "$control_target" >"$TSUB_STATE/control-command.path"
  chmod 600 "$TSUB_STATE/control-command.name" "$TSUB_STATE/control-command.path"
  TSUB_CONTROL_COMMAND_ACTUAL=$control_candidate

  case ":$PATH:" in
    *":$control_dir:"*) : ;;
    *)
      if [ "$control_use_sudo" = false ] && [ "$(id -u)" -ne 0 ]; then
        control_profile="$HOME/.profile"
        if ! grep -q '^# TSub Proxy user command path$' "$control_profile" 2>/dev/null; then
          printf '\n# TSub Proxy user command path\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$control_profile" || true
        fi
        i18n_degraded "控制命令目录将在重新登录后加入 PATH；当前可执行 $control_target" "The control command directory will be added to PATH after signing in again; run $control_target for now"
      fi
      ;;
  esac
  return 0
}

remove_control_command() {
  control_old_path=$(cat "$TSUB_STATE/control-command.path" 2>/dev/null || true)
  [ -z "$control_old_path" ] || control_remove_path "$control_old_path"
  rm -f "$TSUB_STATE/control-command.name" "$TSUB_STATE/control-command.path"
  TSUB_CONTROL_COMMAND_ACTUAL=''
}

control_menu() {
  print_runtime_basic_info
  while :; do
    printf '\n'; i18n_print 'TSub Proxy 控制菜单' 'TSub Proxy control menu'
    i18n_print '1. 显示全部节点与订阅链接' '1. Show all nodes and subscription links'
    control_push_available=false
    if push_enabled; then control_push_available=true; i18n_print '2. 立即主动推送到主控' '2. Push to the controller now'; fi
    i18n_print '3. 卸载 TSub Proxy' '3. Uninstall TSub Proxy'
    i18n_print '0. 退出' '0. Exit'
    i18n_text '请选择：' 'Select an option: '
    IFS= read -r control_choice || return 0
    case "$control_choice" in
      1)
        export_nodes
        print_connection_info
        ;;
      2)
        if [ "$control_push_available" = true ]; then
          if push_snapshot; then i18n_print '主动推送请求已发送。' 'Push request sent.'; else i18n_print '主动推送失败，请检查网络和主控状态。' 'Push failed; check the network and controller status.' >&2; fi
        else
          i18n_print '无效选项。' 'Invalid option.'
        fi
        ;;
      3)
        i18n_text '卸载将停止代理并清理 TSub 管理的服务、规则和控制命令。输入 Y 确认：' 'Uninstalling stops the proxy and removes TSub-managed services, rules, and control commands. Enter Y to confirm: '
        control_confirm=''
        IFS= read -r control_confirm || true
        case "$control_confirm" in
          y|Y) uninstall_runtime; return 0 ;;
          *) i18n_print '已取消卸载。' 'Uninstall canceled.' ;;
        esac
        ;;
      0|q|Q) return 0 ;;
      *) i18n_print '无效选项。' 'Invalid option.' ;;
    esac
  done
}

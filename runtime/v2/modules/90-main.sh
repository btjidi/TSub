main() {
  TSUB_CONFIG=${TSUB_CONFIG:-/tmp/tsub-bootstrap.conf}
  [ -r "$TSUB_CONFIG" ] || { printf '%s\n' 'TSub 配置文件不可读' >&2; exit 2; }
  action=${1:-apply}
  TSUB_CALLBACK_URL=''; TSUB_CALLBACK_TOKEN=''; TSUB_DEGRADED_REASON=''; TSUB_FORCE_LOW_MEMORY_INSTALL=false; TSUB_STAGE=bootstrap
  if [ "$action" = menu ]; then detect_system_identity >/dev/null; else detect_system_identity; fi
  mark_runtime_oom_candidate
  if [ "$(id -u)" -eq 0 ]; then
    TSUB_ETC=${TSUB_ETC:-/etc/tsub}
    TSUB_STATE=${TSUB_STATE:-/var/lib/tsub}
    TSUB_BIN=${TSUB_BIN:-/var/lib/tsub/bin}
  else
    TSUB_ETC=${TSUB_ETC:-"${XDG_CONFIG_HOME:-$HOME/.config}/tsub"}
    TSUB_STATE=${TSUB_STATE:-"${XDG_STATE_HOME:-$HOME/.local/state}/tsub"}
    TSUB_BIN=${TSUB_BIN:-"$TSUB_STATE/bin"}
  fi
  mkdir -p "$TSUB_ETC" "$TSUB_STATE" "$TSUB_BIN"
  if [ "$action" = menu ]; then ensure_dependencies "$action" >/dev/null || exit 3
  elif ! ensure_dependencies "$action"; then exit 3; fi
  TSUB_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub.XXXXXX")
  TSUB_TX="$TSUB_TMP/transaction"
  mkdir -p "$TSUB_TX"
  TSUB_LOG="$TSUB_STATE/runtime.log"
  TSUB_DOWNLOAD_PART=''
  TSUB_OPERATION_LOCK=''; TSUB_OPERATION_LOCK_HELD=false
  trap 'cleanup_runtime' EXIT
  trap 'exit 130' HUP INT TERM
  sanitize_runtime_log
  TSUB_CALLBACK_URL=$(kv_get callback_url)
  callback_file="$TSUB_TMP/callback.token"
  if b64_decode_file callback_token_b64 "$callback_file"; then TSUB_CALLBACK_TOKEN=$(cat "$callback_file"); else TSUB_CALLBACK_TOKEN=''; fi
  acquire_runtime_operation_lock "$action"
  TSUB_HEALTH_WAIT=$(kv_get health_wait); TSUB_HEALTH_WAIT=${TSUB_HEALTH_WAIT:-5}
  detect_platform_capabilities
  if [ "$action" = menu ]; then detect_resources >/dev/null; else detect_resources; fi
  mark_runtime_oom_candidate
  load_control_command
  if [ "$(id -u)" -ne 0 ]; then
    if have crontab; then TSUB_INIT='crontab'; else TSUB_INIT='none'; fi
  fi
  case "$action" in
    plan) plan_runtime; emit_event succeeded "$(i18n_text '计划检查完成' 'Plan completed')" ;;
    apply|update|repair) plan_runtime; apply_runtime; record_runtime_change_time; print_runtime_summary "$action" ;;
    status) plan_runtime; load_installed_core; TSUB_CORE_RSS=$(process_rss_mb); TSUB_CLOUDFLARED_RSS=$(tunnel_health_rss 2>/dev/null || printf 0); TSUB_CURRENT_RSS=$((TSUB_CORE_RSS + TSUB_CLOUDFLARED_RSS)); emit_event succeeded "$(i18n_text '状态采集完成' 'Status collected')" ;;
    doctor) plan_runtime; load_installed_core; validate_config "$TSUB_ETC/config.json"; TSUB_CORE_RSS=$(process_rss_mb); TSUB_CLOUDFLARED_RSS=$(tunnel_health_rss 2>/dev/null || printf 0); TSUB_CURRENT_RSS=$((TSUB_CORE_RSS + TSUB_CLOUDFLARED_RSS)); emit_event succeeded "$(i18n_text '诊断完成' 'Doctor completed')" ;;
    list) export_nodes; push_snapshot || i18n_die "节点同步推送失败" "Node synchronization push failed"; emit_event succeeded "$(i18n_text '节点导出完成' 'Nodes exported')" ;;
    traffic) traffic_ensure_rules; traffic_checkpoint ;;
    push) push_snapshot ;;
    agent) run_agent_loop ;;
    update-runtime)
      agent_update_sha=''
      agent_maybe_update_runtime force no-reload
      [ -n "$agent_update_sha" ] && [ "$(sha256_file "$TSUB_BIN/tsub-proxy.sh")" = "$agent_update_sha" ] \
        || i18n_die 'Runtime 更新失败，当前版本保持不变' 'Runtime update failed; the current version was preserved'
      ;;
    agent-install) install_agent_service "$TSUB_BIN/tsub-proxy.sh" "$TSUB_ETC/runtime.conf" ;;
    edge-probe) edge_probe ;;
    refresh-quick) load_installed_core; ensure_tunnel_binary; tunnel_refresh_quick ;;
    menu) control_menu ;;
    restart) plan_runtime; load_installed_core; ensure_tunnel_binary; prepare_service_identity; traffic_checkpoint; service_stop; service_start; health_check; tunnel_reconcile_quick || true; push_snapshot || true; traffic_ensure_rules; traffic_checkpoint; emit_event succeeded "$(i18n_text '重启完成' 'Restart completed')" ;;
    rollback) load_installed_core; rollback_runtime; record_runtime_change_time ;;
    uninstall) uninstall_runtime ;;
    *) i18n_die "未知操作: $action" "Unknown operation: $action" ;;
  esac
  sanitize_runtime_log
  trim_runtime_log
}

main "$@"

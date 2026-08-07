apply_runtime() {
  TSUB_STAGE=apply
  ensure_core
  ensure_runtime_secrets
  tunnel_candidate_hash=$(tunnel_config_hash)
  tunnel_current_hash=$(cat "$TSUB_STATE/tunnel.config.hash" 2>/dev/null || true)
  ensure_tunnel_binary
  ensure_certificate
  prepare_service_identity
  subscription_candidate_hash=$(subscription_config_hash)
  subscription_current_hash=$(cat "$TSUB_STATE/subscription.config.hash" 2>/dev/null || true)
  apply_candidate="$TSUB_TX/config.json"
  render_config "$apply_candidate"
  apply_candidate_hash=$(sha256_file "$apply_candidate")
  apply_current_hash=''
  [ -f "$TSUB_ETC/config.json" ] && apply_current_hash=$(sha256_file "$TSUB_ETC/config.json")
  if [ "$apply_candidate_hash" = "$apply_current_hash" ] && [ "$subscription_candidate_hash" = "$subscription_current_hash" ]; then
    if [ "$TSUB_CORE_CHANGED" = true ] || [ "${TSUB_CERT_CHANGED:-false}" = true ] || [ "$tunnel_candidate_hash" != "$tunnel_current_hash" ] || [ "${action:-}" = repair ]; then
      traffic_checkpoint
      service_stop
      prepare_service_identity
      install_service_definition
      if ! service_start || ! health_check; then
        service_stop
        if [ -n "$TSUB_PREVIOUS_CORE" ] && [ -x "$TSUB_PREVIOUS_CORE" ]; then
          TSUB_CORE_BIN=$TSUB_PREVIOUS_CORE
          prepare_service_identity
          install_service_definition
          service_start || true
        fi
        i18n_die "组件更新健康检查失败，已恢复上一核心" "Component update health check failed; the previous core was restored"
      fi
      [ -z "$TSUB_PREVIOUS_CORE" ] || printf '%s\n' "$TSUB_PREVIOUS_CORE" >"$TSUB_STATE/core.previous.identity"
      printf '%s\n' "$TSUB_CORE_BIN" >"$TSUB_STATE/core.identity"
      printf '%s\n' "$tunnel_candidate_hash" >"$TSUB_STATE/tunnel.config.hash"
    fi
    export_nodes
    persist_runtime
    TSUB_CURRENT_RSS=$(process_rss_mb)
    unchanged_tunnel_rss=$(tunnel_health_rss 2>/dev/null || printf 0)
    TSUB_CURRENT_RSS=$((TSUB_CURRENT_RSS + unchanged_tunnel_rss))
    push_snapshot || i18n_degraded "首次主动推送失败" "Initial push failed"
    emit_event succeeded "$(i18n_text '配置未发生变化' 'Configuration unchanged')"
    return 0
  fi
  [ "${TSUB_CORE_DOWNLOADED:-false}" != true ] || require_install_headroom
  validate_config "$apply_candidate"
  subscription_snapshot
  traffic_snapshot
  subscription_prepare
  firewall_snapshot
  cp "$TSUB_TX/firewall.ports" "$TSUB_STATE/firewall.previous.ports"
  cp "$TSUB_TX/firewall.hops.rules" "$TSUB_STATE/firewall.previous.hops.rules"
  [ -f "$TSUB_STATE/config.previous.json" ] && cp "$TSUB_STATE/config.previous.json" "$TSUB_STATE/config.previous.2.json"
  [ -f "$TSUB_ETC/config.json" ] && cp "$TSUB_ETC/config.json" "$TSUB_STATE/config.previous.json"
  service_stop
  atomic_install "$apply_candidate" "$TSUB_ETC/config.json" 600
  if ! firewall_ports_apply "$(kv_get inbound_ports)"; then
    firewall_restore
    i18n_die "端口放行规则事务失败" "Port allow rule transaction failed"
  fi
  if ! firewall_hops_apply "$(kv_get udp_hop_rules)"; then
    firewall_restore
    i18n_die "Hysteria2 端口跳跃规则安装失败" "Failed to install Hysteria2 port hopping rules"
  fi
  traffic_apply_rules
  prepare_service_identity
  install_service_definition
  if ! service_start || ! health_check; then
    service_stop
    cp "$TSUB_ETC/config.json" "$TSUB_STATE/config.failed.json" 2>/dev/null || true
    chmod 600 "$TSUB_STATE/config.failed.json" 2>/dev/null || true
    firewall_restore
    subscription_restore_snapshot
    traffic_restore_snapshot
    if [ -f "$TSUB_STATE/config.previous.json" ]; then
      atomic_install "$TSUB_STATE/config.previous.json" "$TSUB_ETC/config.json" 600
      if [ -n "$TSUB_PREVIOUS_CORE" ] && [ -x "$TSUB_PREVIOUS_CORE" ]; then
        TSUB_CORE_BIN=$TSUB_PREVIOUS_CORE
        prepare_service_identity
        install_service_definition
      fi
      service_start || true
    fi
    i18n_die "事务切换失败，旧配置已恢复" "Transaction switch failed; the previous configuration was restored"
  fi
  export_nodes
  [ -z "$TSUB_PREVIOUS_CORE" ] || printf '%s\n' "$TSUB_PREVIOUS_CORE" >"$TSUB_STATE/core.previous.identity"
  printf '%s\n' "$TSUB_CORE_BIN" >"$TSUB_STATE/core.identity"
  printf '%s\n' "$subscription_candidate_hash" >"$TSUB_STATE/subscription.config.hash"
  printf '%s\n' "$tunnel_candidate_hash" >"$TSUB_STATE/tunnel.config.hash"
  persist_runtime
  push_snapshot || i18n_degraded "首次主动推送失败" "Initial push failed"
  apply_event_message=$(i18n_text '配置应用完成' 'Apply completed')
  if [ -n "${TSUB_DEGRADED_REASON:-}" ]; then
    apply_event_message="$apply_event_message; $(i18n_text '降级' 'degraded'): $TSUB_DEGRADED_REASON"
  fi
  emit_event succeeded "$apply_event_message"
}

rollback_runtime() {
  [ -f "$TSUB_STATE/config.previous.json" ] || i18n_die "没有可回滚快照" "No rollback snapshot is available"
  traffic_checkpoint
  service_stop
  cp "$TSUB_ETC/config.json" "$TSUB_TX/config.failed.json" 2>/dev/null || true
  atomic_install "$TSUB_STATE/config.previous.json" "$TSUB_ETC/config.json" 600
  rollback_core=$(cat "$TSUB_STATE/core.previous.identity" 2>/dev/null || true)
  if [ -n "$rollback_core" ] && [ -x "$rollback_core" ]; then
    current_core=$(cat "$TSUB_STATE/core.identity" 2>/dev/null || true)
    [ -z "$current_core" ] || printf '%s\n' "$current_core" >"$TSUB_STATE/core.previous.identity"
    TSUB_CORE_BIN=$rollback_core
    printf '%s\n' "$rollback_core" >"$TSUB_STATE/core.identity"
    prepare_service_identity
    install_service_definition
  fi
  if [ -r "$TSUB_STATE/firewall.previous.ports" ]; then firewall_ports_apply "$(cat "$TSUB_STATE/firewall.previous.ports")"; fi
  firewall_hops_apply "$(cat "$TSUB_STATE/firewall.previous.hops.rules" 2>/dev/null || true)" || true
  service_start
  health_check
  emit_event succeeded "$(i18n_text '回滚完成' 'Rollback completed')"
}

uninstall_runtime() {
  traffic_checkpoint
  service_stop
  push_uninstall_event || true
  subscription_remove
  traffic_remove_rules
  firewall_remove
  remove_service_definition
  rm -f "$TSUB_ETC/config.json" "$TSUB_STATE/core.pid"
  remove_maintenance
  rm -f "$TSUB_STATE/deployment-time"
  emit_event succeeded "$(i18n_text '卸载完成' 'Uninstall completed')"
  i18n_print 'TSub Proxy 卸载成功' 'TSub Proxy uninstalled successfully'
}

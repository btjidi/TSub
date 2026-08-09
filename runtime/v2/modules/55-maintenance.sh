# shellcheck shell=sh

persist_runtime() {
  runtime_target="$TSUB_BIN/tsub-proxy.sh"
  atomic_install "$0" "$runtime_target" 700
  persistent_config="$TSUB_ETC/runtime.conf"
  persist_agent_source=$TSUB_CONFIG
  persist_requested_agent_mode=$(sed -n 's/^agent_mode=//p' "$TSUB_CONFIG" | awk 'NF { value=$0 } END { print value }')
  if [ "$persist_requested_agent_mode" != local ] && [ -r "$persistent_config" ] && ! grep -q '^agent_token_b64=.' "$TSUB_CONFIG"; then
    persist_agent_source=$persistent_config
  fi
  sed '/^callback_url=/d; /^callback_token_b64=/d; /^agent_mode=/d; /^agent_controller_url=/d; /^agent_deployment_id=/d; /^agent_token_b64=/d' \
    "$TSUB_CONFIG" >"$TSUB_TMP/runtime.conf"
  for persist_agent_key in agent_mode agent_controller_url agent_deployment_id agent_token_b64; do
    persist_agent_value=$(sed -n "s/^${persist_agent_key}=//p" "$persist_agent_source" | awk 'NF { value=$0 } END { print value }')
    [ -z "$persist_agent_value" ] || printf '%s=%s\n' "$persist_agent_key" "$persist_agent_value" >>"$TSUB_TMP/runtime.conf"
  done
  atomic_install "$TSUB_TMP/runtime.conf" "$persistent_config" 600
  if ! install_control_command "$runtime_target" "$persistent_config"; then i18n_degraded "服务器控制命令安装失败，可直接运行 $runtime_target menu" "Server control command installation failed; run $runtime_target menu directly"; fi
  install_maintenance "$runtime_target" "$persistent_config"
  remove_traffic_maintenance
  install_push_maintenance "$runtime_target" "$persistent_config"
  persist_bootstrap_config=$TSUB_CONFIG
  TSUB_CONFIG=$persistent_config
  install_agent_service "$runtime_target" "$persistent_config"
  TSUB_CONFIG=$persist_bootstrap_config
}

install_maintenance() {
  runtime_target=$1; persistent_config=$2
  maintenance_command="TSUB_SUPPRESS_SENSITIVE_OUTPUT=true TSUB_CONFIG=$persistent_config $runtime_target repair >>$TSUB_LOG 2>&1"
  if [ "$TSUB_INIT" = systemd ] && [ "$(id -u)" -eq 0 ]; then
    service_file="$TSUB_TMP/tsub-maintenance.service"
    timer_file="$TSUB_TMP/tsub-maintenance.timer"
    cat >"$service_file" <<EOF
[Unit]
Description=TSub certificate and core maintenance
[Service]
Type=oneshot
Environment=TSUB_CONFIG=$persistent_config
Environment=TSUB_SUPPRESS_SENSITIVE_OUTPUT=true
ExecStart=$runtime_target repair
EOF
    cat >"$timer_file" <<EOF
[Unit]
Description=Daily TSub maintenance
[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
EOF
    atomic_install "$service_file" /etc/systemd/system/tsub-maintenance.service 644
    atomic_install "$timer_file" /etc/systemd/system/tsub-maintenance.timer 644
    systemctl daemon-reload
    systemctl enable --now tsub-maintenance.timer >/dev/null 2>&1 || true
  elif [ "$(id -u)" -eq 0 ] && [ -d /etc/periodic/daily ]; then
    daily="$TSUB_TMP/tsub-maintenance"
    printf '#!/bin/sh\n%s\n' "$maintenance_command" >"$daily"
    atomic_install "$daily" /etc/periodic/daily/tsub-maintenance 700
  elif have crontab; then
    cron_file="$TSUB_TMP/maintenance.cron"
    crontab -l >"$cron_file" 2>/dev/null || :
    grep -v 'tsub-proxy.sh repair' "$cron_file" >"$cron_file.new" || true
    printf '17 4 * * * %s\n' "$maintenance_command" >>"$cron_file.new"
    crontab "$cron_file.new"
  else
    i18n_log WARN "没有可用的定时入口，证书需要手动 update/repair" "No scheduler is available; certificates require manual update/repair"
  fi
}

remove_maintenance() {
  remove_control_command
  remove_push_maintenance
  remove_traffic_maintenance
  remove_tsub_scheduler_service
  remove_agent_service
  if [ "$(id -u)" -eq 0 ]; then
    systemctl disable --now tsub-maintenance.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/tsub-maintenance.service /etc/systemd/system/tsub-maintenance.timer /etc/periodic/daily/tsub-maintenance
  fi
  if have crontab; then
    cron_file="$TSUB_TMP/maintenance.cron"
    crontab -l 2>/dev/null | grep -v 'tsub-proxy.sh repair' >"$cron_file" || true
    crontab "$cron_file" 2>/dev/null || true
  fi
  rm -f "$TSUB_ETC/runtime.conf" "$TSUB_BIN/tsub-proxy.sh" "$TSUB_STATE/quick-tunnel.meta" "$TSUB_STATE/quick-tunnel.hostname.status"
}

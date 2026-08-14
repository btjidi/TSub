push_enabled() { subscription_enabled && [ "$(kv_get push_enabled)" != false ] && [ -n "$(kv_get push_url)" ]; }

push_interval_minutes() {
  push_interval=$(kv_get push_interval_minutes)
  case "$push_interval" in 5|15|30|60) printf '%s' "$push_interval" ;; *) printf 15 ;; esac
}

push_state_value() {
  push_key=$1
  sed -n "s/^${push_key}=//p" "$TSUB_STATE/push.state" 2>/dev/null | sed -n '1p'
}

push_snapshot() {
  push_enabled || return 0
  if tunnel_quick_pending 2>/dev/null; then
    i18n_degraded '临时隧道等待恢复' 'Quick Tunnel is waiting to recover'
    return 0
  fi
  traffic_ensure_rules
  traffic_checkpoint
  push_generation=$(kv_get push_generation)
  push_previous_generation=$(push_state_value generation)
  push_sequence=$(push_state_value sequence)
  case "$push_sequence" in ''|*[!0-9]*|0) push_sequence=0 ;; esac
  [ "$push_previous_generation" = "$push_generation" ] || push_sequence=0
  push_sequence=$((push_sequence + 1))
  push_token_file="$TSUB_TMP/push.token"
  b64_decode_file push_token_b64 "$push_token_file" || { i18n_log WARN "主动推送凭证不可用" "Push credential is unavailable"; return 1; }
  push_token=$(cat "$push_token_file")
  push_upload=$(traffic_number "$(traffic_state_get upload_total)")
  push_download=$(traffic_number "$(traffic_state_get download_total)")
  push_file="$TSUB_TMP/push.snapshot"
  push_traffic_backend=$(traffic_backend)
  push_server_address=$(kv_get push_server_address)
  [ -n "$push_server_address" ] || push_server_address=$(kv_get subscription_hostname)
  push_default_server_address=$push_server_address
  push_subscription_port=$(kv_get subscription_server_port)
  push_node_count=$(awk 'NF { count++ } END { print count + 0 }' "$TSUB_STATE/nodes.txt" 2>/dev/null || printf 0)
  printf 'pushGeneration=%s\nsequence=%s\nupload=%s\ndownload=%s\ntrafficBackend=%s\nserverAddress=%s\nsubscriptionPort=%s\nsubscriptionReady=true\nsubscriptionNodeCount=%s\ndegradedReason=%s\n' \
    "$push_generation" "$push_sequence" "$push_upload" "$push_download" "$push_traffic_backend" \
    "$push_server_address" "$push_subscription_port" "$push_node_count" \
    "$(printf '%s' "${TSUB_DEGRADED_REASON:-}" | tr '\r\n' '  ' | cut -c1-300)" >"$push_file"
  [ ! -r "$TSUB_STATE/nodes.txt" ] || sed 's/^/node=/' "$TSUB_STATE/nodes.txt" >>"$push_file"
  push_attempt=0
  push_sequence_resynced=false
  while [ "$push_attempt" -lt 3 ]; do
    push_attempt=$((push_attempt + 1))
    if have curl; then
      push_curl_family=''
      case "$(kv_get push_address_mode)" in
        ipv4) push_curl_family='-4'; push_server_address=$(kv_get subscription_ipv4) ;;
        ipv6) push_curl_family='-6'; push_server_address=$(kv_get subscription_ipv6) ;;
        *)
          if [ "$push_attempt" -lt 3 ]; then push_curl_family='-4'; push_server_address=$(kv_get subscription_ipv4)
          else push_curl_family='-6'; push_server_address=$(kv_get subscription_ipv6); fi
          ;;
      esac
      [ -n "$push_server_address" ] || push_server_address=$push_default_server_address
      sed "s|^serverAddress=.*|serverAddress=$push_server_address|" "$push_file" >"$push_file.family"
      mv "$push_file.family" "$push_file"
      push_response="$TSUB_TMP/push.response"
      push_status_file="$TSUB_TMP/push.status"
      if curl $push_curl_family -sS --connect-timeout 10 --max-time 30 -X POST -H "Authorization: Bearer $push_token" \
        -H 'Content-Type: text/plain' --data-binary "@$push_file" -o "$push_response" -w '%{http_code}' \
        "$(kv_get push_url)" >"$push_status_file" 2>/dev/null; then
        push_http_status=$(cat "$push_status_file" 2>/dev/null || printf 000)
      else
        push_http_status=000
      fi
      case "$push_http_status" in 2??) push_sent=true ;; *) push_sent=false ;; esac
      if [ "$push_sent" = false ] && [ "$push_http_status" = 409 ] && [ "$push_sequence_resynced" = false ]; then
        push_expected_sequence=$(sed -n 's/.*"expectedSequence"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$push_response" | sed -n '1p')
        case "$push_expected_sequence" in ''|*[!0-9]*|0) : ;;
          *)
            push_sequence=$push_expected_sequence
            sed "s/^sequence=.*/sequence=$push_sequence/" "$push_file" >"$push_file.sequence"
            mv "$push_file.sequence" "$push_file"
            push_sequence_resynced=true
            continue
            ;;
        esac
      fi
    elif have wget; then
      wget -qO- -T 30 --header="Authorization: Bearer $push_token" --header='Content-Type: text/plain' \
        --post-file="$push_file" "$(kv_get push_url)" >/dev/null 2>&1 && push_sent=true || push_sent=false
    else
      push_sent=false
    fi
    [ "$push_sent" = false ] || break
    [ "$push_attempt" -ge 3 ] || sleep 3
  done
  if [ "$push_sent" = true ]; then
    push_state_tmp="$TSUB_TMP/push.state"
    printf 'generation=%s\nsequence=%s\n' "$push_generation" "$push_sequence" >"$push_state_tmp"
    atomic_install "$push_state_tmp" "$TSUB_STATE/push.state" 600
    return 0
  fi
  i18n_log WARN "主动推送失败，已重试 $push_attempt 次" "Push failed after $push_attempt attempts"
  return 1
}

push_uninstall_event() {
  push_enabled || return 0
  push_token_file="$TSUB_TMP/push-uninstall.token"
  b64_decode_file push_token_b64 "$push_token_file" || { i18n_log WARN "卸载状态上报凭证不可用" "Uninstall status reporting credential is unavailable"; return 1; }
  push_token=$(cat "$push_token_file")
  push_file="$TSUB_TMP/push-uninstall.event"
  printf 'pushGeneration=%s\nevent=uninstall\n' "$(kv_get push_generation)" >"$push_file"
  push_attempt=0
  while [ "$push_attempt" -lt 3 ]; do
    push_attempt=$((push_attempt + 1))
    if have curl; then
      push_curl_family=''
      case "$(kv_get push_address_mode)" in
        ipv4) push_curl_family='-4' ;;
        ipv6) push_curl_family='-6' ;;
        *) [ "$push_attempt" -lt 3 ] && push_curl_family='-4' || push_curl_family='-6' ;;
      esac
      curl $push_curl_family -fsS --connect-timeout 10 --max-time 30 -X POST -H "Authorization: Bearer $push_token" \
        -H 'Content-Type: text/plain' --data-binary "@$push_file" "$(kv_get push_url)" >/dev/null 2>&1 && push_sent=true || push_sent=false
    elif have wget; then
      wget -qO- -T 30 --header="Authorization: Bearer $push_token" --header='Content-Type: text/plain' \
        --post-file="$push_file" "$(kv_get push_url)" >/dev/null 2>&1 && push_sent=true || push_sent=false
    else
      push_sent=false
    fi
    [ "$push_sent" = false ] || return 0
    [ "$push_attempt" -ge 3 ] || sleep 3
  done
  i18n_log WARN "卸载状态上报失败，主控可能暂时保留在线状态" "Uninstall status reporting failed; the controller may temporarily keep the deployment online"
  return 1
}

install_push_maintenance() {
  remove_push_maintenance
  push_enabled || return 0
  migrate_tsub_scheduler_service
  push_runtime=$1; push_config=$2
  push_interval=$(push_interval_minutes)
  push_command="TSUB_CONFIG=$push_config $push_runtime push >>$TSUB_LOG 2>&1"
  if [ "$TSUB_INIT" = systemd ] && [ "$(id -u)" -eq 0 ]; then
    push_service="$TSUB_TMP/tsub-push.service"
    push_timer="$TSUB_TMP/tsub-push.timer"
    cat >"$push_service" <<EOF
[Unit]
Description=TSub active subscription push
[Service]
Type=oneshot
Environment=TSUB_CONFIG=$push_config
ExecStart=$push_runtime push
EOF
    cat >"$push_timer" <<EOF
[Unit]
Description=TSub active subscription push timer
[Timer]
OnActiveSec=${push_interval}m
OnUnitActiveSec=${push_interval}m
AccuracySec=1m
Persistent=true
[Install]
WantedBy=timers.target
EOF
    atomic_install "$push_service" /etc/systemd/system/tsub-push.service 644
    atomic_install "$push_timer" /etc/systemd/system/tsub-push.timer 644
    systemctl daemon-reload
    systemctl enable tsub-push.timer >/dev/null 2>&1 || true
    systemctl restart tsub-push.timer >/dev/null 2>&1 || true
  elif [ "$push_interval" -eq 15 ] && [ "$(id -u)" -eq 0 ] && [ -d /etc/periodic/15min ] && scheduler_is_running; then
    push_periodic="$TSUB_TMP/tsub-push"
    printf '#!/bin/sh\n%s\n' "$push_command" >"$push_periodic"
    atomic_install "$push_periodic" /etc/periodic/15min/tsub-push 700
  elif have crontab; then
    if ! scheduler_is_running; then
      start_scheduler_service || { i18n_degraded "主动推送定时服务未运行" "The scheduled push service is not running"; return 0; }
    fi
    push_cron="$TSUB_TMP/push.cron"
    crontab -l >"$push_cron" 2>/dev/null || :
    grep -v 'tsub-proxy.sh push' "$push_cron" >"$push_cron.new" || true
    if [ "$push_interval" -eq 60 ]; then push_schedule='7 * * * *'
    else push_schedule="*/$push_interval * * * *"; fi
    printf '%s %s\n' "$push_schedule" "$push_command" >>"$push_cron.new"
    crontab "$push_cron.new"
    scheduler_is_running || i18n_degraded "主动推送定时服务未运行" "The scheduled push service is not running"
  else
    i18n_degraded "没有主动推送定时入口" "No scheduled push entry point is available"
  fi
}

start_scheduler_service() {
  if [ "${TSUB_INIT:-none}" = systemd ] && have systemctl; then
    systemctl enable --now cron.service >/dev/null 2>&1 && return 0
    systemctl enable --now crond.service >/dev/null 2>&1 && return 0
  fi
  if have rc-service; then
    if have rc-update; then rc-update add dcron default >/dev/null 2>&1 || rc-update add cron default >/dev/null 2>&1 || rc-update add crond default >/dev/null 2>&1 || true; fi
    rc-service dcron start >/dev/null 2>&1 && return 0
    rc-service cron start >/dev/null 2>&1 && return 0
    rc-service crond start >/dev/null 2>&1 && return 0
  fi
  if have service; then
    service cron start >/dev/null 2>&1 && return 0
    service crond start >/dev/null 2>&1 && return 0
  fi
  if [ "${TSUB_INIT:-none}" = openrc ] && [ "$(id -u)" -eq 0 ] && have rc-service && [ -d /etc/init.d ]; then
    scheduler_service="$TSUB_TMP/tsub-crond"
    cat >"$scheduler_service" <<'EOF'
#!/sbin/openrc-run
# TSub-managed scheduler for periodic maintenance and active pushes.
name="TSub scheduler"
command="/usr/sbin/crond"
command_args="-f -S -c /etc/crontabs"
supervisor=supervise-daemon
pidfile="/run/tsub-crond.pid"
depend() { need net; }
EOF
    atomic_install "$scheduler_service" /etc/init.d/tsub-crond 700
    if have rc-update; then rc-update add tsub-crond default >/dev/null 2>&1 || true; fi
    rc-service tsub-crond start >/dev/null 2>&1 && return 0
  fi
  return 1
}

migrate_tsub_scheduler_service() {
  [ "${TSUB_INIT:-none}" = openrc ] || return 0
  [ "$(id -u)" -eq 0 ] || return 0
  [ -x /etc/init.d/dcron ] || return 0
  [ -r /etc/init.d/tsub-crond ] || return 0
  grep -q 'TSub-managed scheduler' /etc/init.d/tsub-crond 2>/dev/null || return 0
  if have rc-service; then rc-service tsub-crond stop >/dev/null 2>&1 || true; fi
  for scheduler_cmdline in /proc/[0-9]*/cmdline; do
    [ -r "$scheduler_cmdline" ] || continue
    scheduler_command=$(tr '\000' ' ' <"$scheduler_cmdline" 2>/dev/null || true)
    case "$scheduler_command" in
      '/usr/sbin/crond -S -c /etc/crontabs'*)
        scheduler_pid=${scheduler_cmdline#/proc/}; scheduler_pid=${scheduler_pid%/cmdline}
        kill "$scheduler_pid" >/dev/null 2>&1 || true
        ;;
    esac
  done
  if have rc-update; then rc-update del tsub-crond default >/dev/null 2>&1 || true; fi
  rm -f /etc/init.d/tsub-crond /run/tsub-crond.pid
  if have rc-update; then rc-update add dcron default >/dev/null 2>&1 || true; fi
  if have rc-service; then rc-service dcron restart >/dev/null 2>&1 || rc-service dcron start >/dev/null 2>&1 || true; fi
}

remove_tsub_scheduler_service() {
  [ "$(id -u)" -eq 0 ] || return 0
  [ -r /etc/init.d/tsub-crond ] || return 0
  grep -q 'TSub-managed scheduler' /etc/init.d/tsub-crond 2>/dev/null || return 0
  if have rc-service; then rc-service tsub-crond stop >/dev/null 2>&1 || true; fi
  if have rc-update; then rc-update del tsub-crond default >/dev/null 2>&1 || true; fi
  rm -f /etc/init.d/tsub-crond
}

remove_push_maintenance() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl disable --now tsub-push.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/tsub-push.service /etc/systemd/system/tsub-push.timer /etc/periodic/15min/tsub-push
  fi
  if have crontab; then
    push_cron="$TSUB_TMP/push.cron"
    crontab -l 2>/dev/null | grep -v 'tsub-proxy.sh push' >"$push_cron" || true
    crontab "$push_cron" 2>/dev/null || true
  fi
}

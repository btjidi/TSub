traffic_state_get() {
  traffic_key=$1
  sed -n "s/^${traffic_key}=//p" "$TSUB_STATE/traffic.state" 2>/dev/null | sed -n '1p'
}

traffic_number() {
  case "$1" in ''|*[!0-9]*) printf 0 ;; *) printf '%s' "$1" ;; esac
}

traffic_backend() {
  traffic_backend_value=$(cat "$TSUB_STATE/traffic.backend" 2>/dev/null || true)
  case "$traffic_backend_value" in nftables|iptables|core-singbox|core-xray|unavailable) printf '%s' "$traffic_backend_value" ;; *) printf unavailable ;; esac
}

traffic_read_nft() {
  traffic_direction=$1
  traffic_chain=$2
  nft list chain inet tsub_traffic "$traffic_chain" 2>/dev/null |
    awk -v marker="tsub_${traffic_direction}" '$0 ~ marker { for (i=1;i<=NF;i++) if ($i=="bytes") total += $(i+1) } END { printf "%.0f\n", total }'
}

traffic_read_iptables_family() {
  traffic_command=$1
  traffic_chain=$2
  "$traffic_command" -L "$traffic_chain" -v -n -x 2>/dev/null |
    awk '$0 ~ /TSUB_TRAFFIC_/ { total += $2 } END { printf "%.0f\n", total }'
}

traffic_http_get() {
  traffic_url=$1
  traffic_secret=${2:-}
  if have curl; then
    if [ -n "$traffic_secret" ]; then
      curl -fsS --connect-timeout 2 --max-time 5 -H "Authorization: Bearer $traffic_secret" "$traffic_url"
    else
      curl -fsS --connect-timeout 2 --max-time 5 "$traffic_url"
    fi
  elif have wget; then
    if [ -n "$traffic_secret" ]; then
      wget -qO- -T 5 --header="Authorization: Bearer $traffic_secret" "$traffic_url"
    else
      wget -qO- -T 5 "$traffic_url"
    fi
  else
    return 1
  fi
}

traffic_fetch_core_json() {
  traffic_url=$1
  traffic_secret=${2:-}
  traffic_output=$3
  traffic_http_get "$traffic_url" "$traffic_secret" 2>/dev/null | head -c 262145 >"$traffic_output"
  [ "$(wc -c <"$traffic_output")" -le 262144 ] && [ -s "$traffic_output" ]
}

traffic_extract_single_json_number() {
  traffic_json_key=$1
  traffic_json_file=$2
  traffic_values=$(sed -n "s/.*\"${traffic_json_key}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$traffic_json_file")
  [ "$(printf '%s\n' "$traffic_values" | sed '/^$/d' | wc -l)" -eq 1 ] || return 1
  traffic_number "$traffic_values"
}

traffic_read_singbox() {
  traffic_port=$(kv_get traffic_core_api_port)
  traffic_secret_file="$TSUB_TMP/traffic-core.secret"
  b64_decode_file traffic_core_api_secret_b64 "$traffic_secret_file" || return 1
  traffic_secret=$(cat "$traffic_secret_file")
  traffic_json="$TSUB_TMP/traffic-singbox.json"
  traffic_fetch_core_json "http://127.0.0.1:${traffic_port}/connections" "$traffic_secret" "$traffic_json" || return 1
  traffic_upload=$(traffic_extract_single_json_number uploadTotal "$traffic_json") || return 1
  traffic_download=$(traffic_extract_single_json_number downloadTotal "$traffic_json") || return 1
  printf '%s %s\n' "$traffic_upload" "$traffic_download"
}

traffic_read_xray() {
  traffic_port=$(kv_get traffic_core_api_port)
  traffic_json="$TSUB_TMP/traffic-xray.json"
  traffic_fetch_core_json "http://127.0.0.1:${traffic_port}/debug/vars" '' "$traffic_json" || return 1
  tr '{},' '\n\n\n' <"$traffic_json" | awk '
    {
      token=$0
      gsub(/[[:space:]]/, "", token)
      if (token == "\"stats\":") { stats=1; next }
      if (stats && token == "\"inbound\":") { inbound=1; next }
      if (inbound && token == "\"outbound\":") { found=1; exit }
      if (inbound && token ~ /^\"uplink\":[0-9]+$/) { sub(/^\"uplink\":/, "", token); up += token; count++ }
      if (inbound && token ~ /^\"downlink\":[0-9]+$/) { sub(/^\"downlink\":/, "", token); down += token; count++ }
    }
    END { if (count > 0) printf "%.0f %.0f\n", up, down; else exit 1 }
  '
}

traffic_read_raw() {
  traffic_backend_value=$(traffic_backend)
  case "$traffic_backend_value" in
    nftables)
      traffic_upload=$(traffic_read_nft upload input)
      traffic_download=$(traffic_read_nft download output)
      ;;
    iptables)
      traffic_upload=$(traffic_read_iptables_family iptables TSUB_TRAFFIC_IN)
      traffic_download=$(traffic_read_iptables_family iptables TSUB_TRAFFIC_OUT)
      if have ip6tables; then
        traffic_upload=$((traffic_upload + $(traffic_read_iptables_family ip6tables TSUB_TRAFFIC_IN)))
        traffic_download=$((traffic_download + $(traffic_read_iptables_family ip6tables TSUB_TRAFFIC_OUT)))
      fi
      ;;
    core-singbox) traffic_read_singbox; return ;;
    core-xray) traffic_read_xray; return ;;
    *) return 1 ;;
  esac
  printf '%s %s\n' "$(traffic_number "$traffic_upload")" "$(traffic_number "$traffic_download")"
}

traffic_core_pid() {
  traffic_pid=''
  [ -r "$TSUB_STATE/core.pid" ] && traffic_pid=$(cat "$TSUB_STATE/core.pid")
  if [ "${TSUB_INIT:-}" = systemd ]; then traffic_pid=$(systemctl show -p MainPID --value tsub-core.service 2>/dev/null || true); fi
  case "$traffic_pid" in ''|0|*[!0-9]*) return 1 ;; esac
  [ -r "/proc/$traffic_pid/stat" ] || return 1
  printf '%s' "$traffic_pid"
}

traffic_backend_instance() {
  traffic_backend_value=$(traffic_backend)
  case "$traffic_backend_value" in
    nftables|iptables) cat "$TSUB_STATE/traffic.instance" 2>/dev/null || return 1 ;;
    core-singbox|core-xray)
      traffic_pid=$(traffic_core_pid) || return 1
      traffic_start=$(awk '{print $22}' "/proc/$traffic_pid/stat" 2>/dev/null) || return 1
      traffic_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)
      printf '%s:%s:%s:%s' "$traffic_backend_value" "$traffic_boot" "$traffic_pid" "$traffic_start"
      ;;
    *) return 1 ;;
  esac
}

traffic_write_state() {
  traffic_upload_total=$1
  traffic_download_total=$2
  traffic_upload_raw=$3
  traffic_download_raw=$4
  traffic_state_backend=${5:-unavailable}
  traffic_state_instance=${6:-unknown}
  traffic_tmp="$TSUB_TMP/traffic.state"
  printf 'upload_total=%s\ndownload_total=%s\nupload_raw=%s\ndownload_raw=%s\nbackend=%s\ninstance=%s\n' \
    "$traffic_upload_total" "$traffic_download_total" "$traffic_upload_raw" "$traffic_download_raw" "$traffic_state_backend" "$traffic_state_instance" >"$traffic_tmp"
  atomic_install "$traffic_tmp" "$TSUB_STATE/traffic.state" 640
  if id tsub >/dev/null 2>&1; then chgrp "$(id -gn tsub)" "$TSUB_STATE/traffic.state" 2>/dev/null || true; fi
}

traffic_checkpoint() {
  traffic_raw=$(traffic_read_raw 2>/dev/null || true)
  [ -n "$traffic_raw" ] || return 0
  traffic_current_instance=$(traffic_backend_instance 2>/dev/null || true)
  [ -n "$traffic_current_instance" ] || return 0
  set -- $traffic_raw
  traffic_current_upload=$(traffic_number "${1:-0}")
  traffic_current_download=$(traffic_number "${2:-0}")
  traffic_previous_upload=$(traffic_number "$(traffic_state_get upload_raw)")
  traffic_previous_download=$(traffic_number "$(traffic_state_get download_raw)")
  traffic_total_upload=$(traffic_number "$(traffic_state_get upload_total)")
  traffic_total_download=$(traffic_number "$(traffic_state_get download_total)")
  traffic_current_backend=$(traffic_backend)
  traffic_previous_backend=$(traffic_state_get backend)
  traffic_previous_instance=$(traffic_state_get instance)
  traffic_same_period=false
  if [ -z "$traffic_previous_backend" ]; then traffic_same_period=true
  elif [ "$traffic_previous_backend" = "$traffic_current_backend" ] && [ "$traffic_previous_instance" = "$traffic_current_instance" ]; then traffic_same_period=true
  fi
  if [ "$traffic_same_period" = true ] && [ "$traffic_current_upload" -ge "$traffic_previous_upload" ]; then traffic_delta_upload=$((traffic_current_upload - traffic_previous_upload)); else traffic_delta_upload=$traffic_current_upload; fi
  if [ "$traffic_same_period" = true ] && [ "$traffic_current_download" -ge "$traffic_previous_download" ]; then traffic_delta_download=$((traffic_current_download - traffic_previous_download)); else traffic_delta_download=$traffic_current_download; fi
  traffic_write_state $((traffic_total_upload + traffic_delta_upload)) $((traffic_total_download + traffic_delta_download)) \
    "$traffic_current_upload" "$traffic_current_download" "$traffic_current_backend" "$traffic_current_instance"
}

traffic_remove_rules() {
  traffic_backend_value=$(traffic_backend)
  [ "$traffic_backend_value" = nftables ] && nft delete table inet tsub_traffic >/dev/null 2>&1 || true
  if [ "$traffic_backend_value" = iptables ]; then
    for traffic_command in iptables ip6tables; do
      have "$traffic_command" || continue
      "$traffic_command" -D INPUT -j TSUB_TRAFFIC_IN >/dev/null 2>&1 || true
      "$traffic_command" -D OUTPUT -j TSUB_TRAFFIC_OUT >/dev/null 2>&1 || true
      "$traffic_command" -F TSUB_TRAFFIC_IN >/dev/null 2>&1 || true
      "$traffic_command" -F TSUB_TRAFFIC_OUT >/dev/null 2>&1 || true
      "$traffic_command" -X TSUB_TRAFFIC_IN >/dev/null 2>&1 || true
      "$traffic_command" -X TSUB_TRAFFIC_OUT >/dev/null 2>&1 || true
    done
  fi
  rm -f "$TSUB_STATE/traffic.backend" "$TSUB_STATE/traffic.instance"
}

traffic_add_iptables_rules() {
  traffic_command=$1
  traffic_ports=$2
  "$traffic_command" -N TSUB_TRAFFIC_IN 2>/dev/null || true
  "$traffic_command" -N TSUB_TRAFFIC_OUT 2>/dev/null || true
  "$traffic_command" -C INPUT -j TSUB_TRAFFIC_IN 2>/dev/null || "$traffic_command" -I INPUT -j TSUB_TRAFFIC_IN
  "$traffic_command" -C OUTPUT -j TSUB_TRAFFIC_OUT 2>/dev/null || "$traffic_command" -I OUTPUT -j TSUB_TRAFFIC_OUT
  "$traffic_command" -F TSUB_TRAFFIC_IN
  "$traffic_command" -F TSUB_TRAFFIC_OUT
  old_ifs=$IFS; IFS=,
  for traffic_spec in $traffic_ports; do
    traffic_protocol=${traffic_spec#*/}; traffic_port=${traffic_spec%/*}
    "$traffic_command" -A TSUB_TRAFFIC_IN -p "$traffic_protocol" --dport "$traffic_port" -m comment --comment TSUB_TRAFFIC_UPLOAD -j RETURN
    "$traffic_command" -A TSUB_TRAFFIC_OUT -p "$traffic_protocol" --sport "$traffic_port" -m comment --comment TSUB_TRAFFIC_DOWNLOAD -j RETURN
  done
  IFS=$old_ifs
}

traffic_install_nft() {
  traffic_ports=$1
  nft add table inet tsub_traffic || return 1
  nft 'add chain inet tsub_traffic input { type filter hook input priority -5; policy accept; }' || return 1
  nft 'add chain inet tsub_traffic output { type filter hook output priority -5; policy accept; }' || return 1
  old_ifs=$IFS; IFS=,
  for traffic_spec in $traffic_ports; do
    traffic_protocol=${traffic_spec#*/}; traffic_port=${traffic_spec%/*}
    nft add rule inet tsub_traffic input "$traffic_protocol" dport "$traffic_port" counter comment tsub_upload || { IFS=$old_ifs; return 1; }
    nft add rule inet tsub_traffic output "$traffic_protocol" sport "$traffic_port" counter comment tsub_download || { IFS=$old_ifs; return 1; }
  done
  IFS=$old_ifs
  printf '%s\n' nftables >"$TSUB_STATE/traffic.backend"
}

traffic_install_iptables() {
  traffic_ports=$1
  traffic_add_iptables_rules iptables "$traffic_ports" || return 1
  have ip6tables && traffic_add_iptables_rules ip6tables "$traffic_ports" || true
  printf '%s\n' iptables >"$TSUB_STATE/traffic.backend"
}

traffic_mark_instance() {
  printf '%s:%s:%s\n' "$(traffic_backend)" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)" "$(date +%s).$$" >"$TSUB_STATE/traffic.instance"
}

traffic_select_core_backend() {
  case "$(kv_get runtime_core)" in
    sing-box) printf '%s\n' core-singbox >"$TSUB_STATE/traffic.backend" ;;
    xray) printf '%s\n' core-xray >"$TSUB_STATE/traffic.backend" ;;
    *) printf '%s\n' unavailable >"$TSUB_STATE/traffic.backend"; return 1 ;;
  esac
}

traffic_apply_rules() {
  [ "$(kv_get subscription_traffic_enabled)" = true ] || {
    traffic_checkpoint
    traffic_remove_rules
    rm -f "$TSUB_STATE/traffic.ports"
    return 0
  }
  traffic_checkpoint
  traffic_remove_rules
  traffic_ports=$(kv_get inbound_ports)
  traffic_installed=false
  if [ "${TSUB_HAS_NET_ADMIN:-false}" = true ] && [ "$(id -u)" -eq 0 ]; then
    if have nft && traffic_install_nft "$traffic_ports"; then traffic_installed=true
    else
      nft delete table inet tsub_traffic >/dev/null 2>&1 || true
      if have iptables; then
        printf '%s\n' iptables >"$TSUB_STATE/traffic.backend"
        if traffic_install_iptables "$traffic_ports"; then traffic_installed=true
        else traffic_remove_rules
        fi
      fi
    fi
  fi
  if [ "$traffic_installed" = true ]; then
    traffic_mark_instance
  elif ! traffic_select_core_backend; then
    add_degraded_reason "当前核心不支持低资源流量统计"
  fi
  printf '%s\n' "$traffic_ports" >"$TSUB_STATE/traffic.ports"
  [ -f "$TSUB_STATE/traffic.state" ] || traffic_write_state 0 0 0 0 unavailable unknown
}

traffic_snapshot() {
  traffic_checkpoint
  mkdir -p "$TSUB_TX/traffic.previous"
  for traffic_file in traffic.backend traffic.ports traffic.state traffic.instance; do
    [ ! -f "$TSUB_STATE/$traffic_file" ] || cp "$TSUB_STATE/$traffic_file" "$TSUB_TX/traffic.previous/$traffic_file"
  done
}

traffic_restore_snapshot() {
  traffic_remove_rules
  [ -d "$TSUB_TX/traffic.previous" ] || return 0
  [ ! -f "$TSUB_TX/traffic.previous/traffic.state" ] || cp "$TSUB_TX/traffic.previous/traffic.state" "$TSUB_STATE/traffic.state"
  traffic_previous_backend=$(cat "$TSUB_TX/traffic.previous/traffic.backend" 2>/dev/null || true)
  traffic_previous_ports=$(cat "$TSUB_TX/traffic.previous/traffic.ports" 2>/dev/null || true)
  if [ -n "$traffic_previous_ports" ] && [ "${TSUB_HAS_NET_ADMIN:-false}" = true ] && [ "$(id -u)" -eq 0 ]; then
    if [ "$traffic_previous_backend" = nftables ] && have nft && traffic_install_nft "$traffic_previous_ports"; then traffic_mark_instance
    elif [ "$traffic_previous_backend" = iptables ] && have iptables; then
      printf '%s\n' iptables >"$TSUB_STATE/traffic.backend"
      if traffic_install_iptables "$traffic_previous_ports"; then traffic_mark_instance
      else traffic_remove_rules; printf '%s\n' unavailable >"$TSUB_STATE/traffic.backend"
      fi
    else printf '%s\n' "$traffic_previous_backend" >"$TSUB_STATE/traffic.backend"; fi
  elif [ -n "$traffic_previous_backend" ]; then
    printf '%s\n' "$traffic_previous_backend" >"$TSUB_STATE/traffic.backend"
  fi
  [ -z "$traffic_previous_ports" ] || printf '%s\n' "$traffic_previous_ports" >"$TSUB_STATE/traffic.ports"
}

traffic_ensure_rules() {
  [ "$(kv_get subscription_traffic_enabled)" = true ] || return 0
  traffic_backend_value=$(traffic_backend)
  if [ "$traffic_backend_value" = nftables ] && nft list table inet tsub_traffic >/dev/null 2>&1; then return 0; fi
  if [ "$traffic_backend_value" = iptables ] && iptables -L TSUB_TRAFFIC_IN -n >/dev/null 2>&1; then return 0; fi
  if [ "$traffic_backend_value" = core-singbox ] || [ "$traffic_backend_value" = core-xray ]; then
    if traffic_read_raw >/dev/null 2>&1; then return 0; fi
    printf '%s\n' unavailable >"$TSUB_STATE/traffic.backend"
    add_degraded_reason "代理核心流量统计接口不可用"
    return 0
  fi
  traffic_apply_rules
  traffic_backend_value=$(traffic_backend)
  if [ "$traffic_backend_value" = core-singbox ] || [ "$traffic_backend_value" = core-xray ]; then
    if ! traffic_read_raw >/dev/null 2>&1; then
      printf '%s\n' unavailable >"$TSUB_STATE/traffic.backend"
      add_degraded_reason "代理核心流量统计接口不可用"
    fi
  elif [ "$traffic_backend_value" = unavailable ]; then
    add_degraded_reason "流量统计后端不可用"
  fi
}

install_traffic_maintenance() {
  [ "$(kv_get subscription_traffic_enabled)" = true ] || return 0
  traffic_runtime=$1; traffic_config=$2
  traffic_command="TSUB_CONFIG=$traffic_config $traffic_runtime traffic >/dev/null 2>&1"
  if [ "$TSUB_INIT" = systemd ] && [ "$(id -u)" -eq 0 ]; then
    traffic_service="$TSUB_TMP/tsub-traffic.service"
    traffic_timer="$TSUB_TMP/tsub-traffic.timer"
    cat >"$traffic_service" <<EOF
[Unit]
Description=TSub proxy traffic checkpoint
[Service]
Type=oneshot
Environment=TSUB_CONFIG=$traffic_config
ExecStart=$traffic_runtime traffic
EOF
    cat >"$traffic_timer" <<EOF
[Unit]
Description=TSub proxy traffic checkpoint timer
[Timer]
OnBootSec=2m
OnUnitActiveSec=15m
Persistent=true
[Install]
WantedBy=timers.target
EOF
    atomic_install "$traffic_service" /etc/systemd/system/tsub-traffic.service 644
    atomic_install "$traffic_timer" /etc/systemd/system/tsub-traffic.timer 644
    systemctl daemon-reload
    systemctl enable --now tsub-traffic.timer >/dev/null 2>&1 || true
  elif [ "$(id -u)" -eq 0 ] && [ -d /etc/periodic/15min ]; then
    traffic_periodic="$TSUB_TMP/tsub-traffic"
    printf '#!/bin/sh\n%s\n' "$traffic_command" >"$traffic_periodic"
    atomic_install "$traffic_periodic" /etc/periodic/15min/tsub-traffic 700
  elif have crontab; then
    traffic_cron="$TSUB_TMP/traffic.cron"
    crontab -l >"$traffic_cron" 2>/dev/null || :
    grep -v 'tsub-proxy.sh traffic' "$traffic_cron" >"$traffic_cron.new" || true
    printf '*/15 * * * * %s\n' "$traffic_command" >>"$traffic_cron.new"
    crontab "$traffic_cron.new"
  else
    add_degraded_reason "没有流量统计定时入口"
  fi
}

remove_traffic_maintenance() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl disable --now tsub-traffic.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/tsub-traffic.service /etc/systemd/system/tsub-traffic.timer /etc/periodic/15min/tsub-traffic
  fi
  if have crontab; then
    traffic_cron="$TSUB_TMP/traffic.cron"
    crontab -l 2>/dev/null | grep -v 'tsub-proxy.sh traffic' >"$traffic_cron" || true
    crontab "$traffic_cron" 2>/dev/null || true
  fi
}

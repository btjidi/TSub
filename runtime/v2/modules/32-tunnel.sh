ensure_tunnel_binary() {
  count=$(kv_get tunnel_count); count=${count:-0}
  if [ "$count" -le 0 ]; then
    build_tunnel_launcher
    return 0
  fi
  version=$(kv_get cloudflared_version); version=${version:-stable}
  expected=$(component_binary_sha cloudflared)
  [ -n "$expected" ] || i18n_die "cloudflared/$TSUB_ARCH 缺少 SHA-256" "cloudflared/$TSUB_ARCH is missing a SHA-256"
  TSUB_TUNNEL_BIN="$TSUB_BIN/cloudflared-$version-$TSUB_ARCH-$expected"
  if [ -x "$TSUB_TUNNEL_BIN" ] && [ "$(sha256_file "$TSUB_TUNNEL_BIN")" != "$expected" ]; then rm -f "$TSUB_TUNNEL_BIN"; fi
  [ -x "$TSUB_TUNNEL_BIN" ] || verify_download cloudflared "$TSUB_TUNNEL_BIN"
  index=1
  while [ "$index" -le "$count" ]; do
    if [ "$(kv_get "tunnel_${index}_type")" = named ]; then
      b64_decode_file "tunnel_${index}_token_b64" "$TSUB_STATE/tunnel-$index.token" || i18n_die "Tunnel Token 解码失败" "Failed to decode the tunnel token"
    elif [ "$(kv_get "tunnel_${index}_type")" = quick ]; then
      b64_decode_file push_token_b64 "$TSUB_STATE/quick-tunnel.token" || i18n_die "Quick Tunnel 回传凭证解码失败" "Failed to decode the Quick Tunnel callback credential"
    fi
    index=$((index + 1))
  done
  build_tunnel_launcher
}

tunnel_config_hash() {
  tunnel_hash_file="$TSUB_TMP/tunnel.hash.input"
  : >"$tunnel_hash_file"
  tunnel_hash_count=$(kv_get tunnel_count); tunnel_hash_count=${tunnel_hash_count:-0}
  printf 'tunnel_count=%s\n' "$tunnel_hash_count" >>"$tunnel_hash_file"
  tunnel_hash_index=1
  while [ "$tunnel_hash_index" -le "$tunnel_hash_count" ]; do
    for tunnel_hash_suffix in type hostname token_b64 target_port target_scheme; do
      tunnel_hash_key="tunnel_${tunnel_hash_index}_${tunnel_hash_suffix}"
      printf '%s=%s\n' "$tunnel_hash_key" "$(kv_get "$tunnel_hash_key")" >>"$tunnel_hash_file"
    done
    tunnel_hash_index=$((tunnel_hash_index + 1))
  done
  for tunnel_hash_key in cloudflared_version cloudflared_amd64_binary_sha256 cloudflared_arm64_binary_sha256 quick_tunnel_callback_url deployment_id push_token_b64; do
    printf '%s=%s\n' "$tunnel_hash_key" "$(kv_get "$tunnel_hash_key")" >>"$tunnel_hash_file"
  done
  sha256_file "$tunnel_hash_file"
}

build_tunnel_launcher() {
  build_quick_tunnel_monitor
  build_tunnel_supervisor
  build_quick_tunnel_metadata
  launcher="$TSUB_TMP/start-tunnels.sh"
  tunnel_metadata="$TSUB_STATE/quick-tunnel.meta"
  printf '#!/bin/sh\nset -eu\numask 077\n' >"$launcher"
  count=$(kv_get tunnel_count); count=${count:-0}; index=1
  while [ "$index" -le "$count" ]; do
    mode=$(kv_get "tunnel_${index}_type")
    # Command substitution belongs to the generated launcher.
    # shellcheck disable=SC2016
    printf '[ ! -r %s ] || kill "$(cat %s)" 2>/dev/null || true\n' "$TSUB_STATE/tunnel-supervisor-$index.pid" "$TSUB_STATE/tunnel-supervisor-$index.pid" >>"$launcher"
    # shellcheck disable=SC2016
    printf '[ ! -r %s ] || kill "$(cat %s)" 2>/dev/null || true\n' "$TSUB_STATE/tunnel-$index.pid" "$TSUB_STATE/tunnel-$index.pid" >>"$launcher"
    if [ "$mode" = named ]; then
      target_scheme=-; target_port=-; callback=-; deployment=-
      token_file="$TSUB_STATE/tunnel-$index.token"; nodes_file=-; hostname_file=-
    else
      target_port=$(kv_get "tunnel_${index}_target_port")
      target_scheme=$(kv_get "tunnel_${index}_target_scheme"); target_scheme=${target_scheme:-http}
      callback=$(kv_get quick_tunnel_callback_url); deployment=$(kv_get deployment_id)
      token_file="$TSUB_STATE/quick-tunnel.token"; nodes_file="$TSUB_STATE/nodes.txt"; hostname_file="$TSUB_STATE/quick-tunnel.hostname"
    fi
    printf 'nohup %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s >/dev/null 2>&1 &\nprintf "%%s\\n" "$!" >%s\n' \
      "$TSUB_STATE/tunnel-supervisor.sh" "$mode" "$index" "$TSUB_TUNNEL_BIN" "$target_scheme" "$target_port" \
      "$callback" "$deployment" "$token_file" "$nodes_file" "$hostname_file" "$TSUB_STATE/tunnel-$index.pid" \
      "$TSUB_STATE/tunnel-$index.log" "$TSUB_STATE/quick-tunnel-monitor-$index.pid" "$TSUB_STATE/quick-tunnel-monitor.sh" "$tunnel_metadata" \
      "$TSUB_STATE/tunnel-supervisor-$index.pid" >>"$launcher"
    index=$((index + 1))
  done
  atomic_install "$launcher" "$TSUB_STATE/start-tunnels.sh" 700
}

build_quick_tunnel_metadata() {
  metadata="$TSUB_STATE/quick-tunnel.meta"
  count=$(kv_get tunnel_count); count=${count:-0}; index=1; has_quick=false
  while [ "$index" -le "$count" ]; do
    [ "$(kv_get "tunnel_${index}_type")" != quick ] || has_quick=true
    index=$((index + 1))
  done
  if [ "$has_quick" != true ]; then rm -f "$metadata"; return 0; fi
  config_revision=$(kv_get config_revision)
  push_generation=$(kv_get push_generation)
  case "$config_revision" in ''|*[!0-9]*) i18n_die "Quick Tunnel 配置修订无效" "The Quick Tunnel configuration revision is invalid" ;; esac
  case "$push_generation" in ''|*[!A-Za-z0-9._:-]*) i18n_die "Quick Tunnel 推送代次无效" "The Quick Tunnel push generation is invalid" ;; esac
  printf 'config_revision=%s\npush_generation=%s\n' "$config_revision" "$push_generation" >"$TSUB_TMP/quick-tunnel.meta"
  atomic_install "$TSUB_TMP/quick-tunnel.meta" "$metadata" 600
}

build_tunnel_supervisor() {
  supervisor="$TSUB_TMP/tunnel-supervisor.sh"
  cat >"$supervisor" <<'EOF'
#!/bin/sh
set -eu
mode=$1; index=$2; tunnel_bin=$3; target_scheme=$4; target_port=$5; callback=$6; deployment=$7
token_file=$8; nodes_file=$9; hostname_file=${10}; tunnel_pid_file=${11}; tunnel_log=${12}; monitor_pid_file=${13}; monitor_script=${14}; metadata_file=${15}
stopping=false; tunnel_pid=''; monitor_pid=''
cleanup_tunnel_children() {
  case "$monitor_pid" in ''|*[!0-9]*) ;; *) kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true ;; esac
  case "$tunnel_pid" in ''|*[!0-9]*) ;; *) kill "$tunnel_pid" 2>/dev/null || true; wait "$tunnel_pid" 2>/dev/null || true ;; esac
  rm -f "$tunnel_pid_file" "$monitor_pid_file"
}
stop_tunnel_supervisor() { stopping=true; cleanup_tunnel_children; }
trap stop_tunnel_supervisor HUP INT TERM
while [ "$stopping" = false ]; do
  : >"$tunnel_log"; chmod 600 "$tunnel_log"
  if [ "$mode" = named ]; then
    TOKEN=$(cat "$token_file")
    "$tunnel_bin" tunnel --no-autoupdate run --token "$TOKEN" >>"$tunnel_log" 2>&1 &
    tunnel_pid=$!; unset TOKEN
  else
    quick_tls_flag=''
    [ "$target_scheme" != https ] || quick_tls_flag='--no-tls-verify'
    "$tunnel_bin" tunnel --no-autoupdate $quick_tls_flag --url "$target_scheme://127.0.0.1:$target_port" >>"$tunnel_log" 2>&1 &
    tunnel_pid=$!
  fi
  printf '%s\n' "$tunnel_pid" >"$tunnel_pid_file"; chmod 600 "$tunnel_pid_file"
  monitor_pid=''
  if [ "$mode" = quick ]; then
    "$monitor_script" "$index" "$callback" "$deployment" "$tunnel_pid_file" "$tunnel_log" "$token_file" "$nodes_file" "$hostname_file" "$metadata_file" &
    monitor_pid=$!; printf '%s\n' "$monitor_pid" >"$monitor_pid_file"; chmod 600 "$monitor_pid_file"
  fi
  wait "$tunnel_pid" 2>/dev/null || true
  [ "$stopping" = false ] || break
  case "$monitor_pid" in ''|*[!0-9]*) ;; *) kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true ;; esac
  monitor_pid=''; rm -f "$tunnel_pid_file" "$monitor_pid_file"
  sleep 2
done
cleanup_tunnel_children
EOF
  atomic_install "$supervisor" "$TSUB_STATE/tunnel-supervisor.sh" 700
}

build_quick_tunnel_monitor() {
  monitor="$TSUB_TMP/quick-tunnel-monitor.sh"
  cat >"$monitor" <<'EOF'
#!/bin/sh
set -eu
index=$1; callback=$2; deployment=$3; tunnel_pid_file=$4; tunnel_log=$5; token_file=$6; nodes_file=$7; hostname_file=$8; metadata_file=$9
nodes_checksum_file="${hostname_file}.nodes.cksum"
status_file="${hostname_file}.status"
runtime_log="${nodes_file%/*}/runtime.log"
record_status() {
  next_status=$1
  previous_status=$(cat "$status_file" 2>/dev/null || true)
  [ "$next_status" = "$previous_status" ] && return 0
  printf '%s [quick-tunnel] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf unknown)" "$next_status" >>"$runtime_log" 2>/dev/null || true
  printf '%s\n' "$next_status" >"${status_file}.new.$$"; chmod 600 "${status_file}.new.$$"; mv -f "${status_file}.new.$$" "$status_file"
}
attempt=0
while [ "$attempt" -lt 120 ]; do
  attempt=$((attempt + 1))
  tunnel_pid=$(cat "$tunnel_pid_file" 2>/dev/null || true)
  case "$tunnel_pid" in ''|*[!0-9]*) sleep 2; continue ;; esac
  kill -0 "$tunnel_pid" 2>/dev/null || exit 1
  hostname=$(sed -n 's#.*https://\([a-zA-Z0-9-]*\.trycloudflare\.com\).*#\1#p' "$tunnel_log" 2>/dev/null | tail -n 1 | tr 'A-Z' 'a-z')
  if printf '%s' "$hostname" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$'; then
    previous=$(cat "$hostname_file" 2>/dev/null || true)
    current_nodes_checksum=$(cksum "$nodes_file" 2>/dev/null || true)
    reported_nodes_checksum=$(cat "$nodes_checksum_file" 2>/dev/null || true)
    if [ "$hostname" != "$previous" ] || [ -z "$current_nodes_checksum" ] || [ "$current_nodes_checksum" != "$reported_nodes_checksum" ]; then
      response="${nodes_file}.quick.$$"
      callback_metadata=$(cat "$metadata_file" 2>/dev/null || true)
      callback_config_revision=$(printf '%s\n' "$callback_metadata" | sed -n 's/^config_revision=//p' | sed -n '1p')
      callback_push_generation=$(printf '%s\n' "$callback_metadata" | sed -n 's/^push_generation=//p' | sed -n '1p')
      case "$callback_config_revision" in ''|*[!0-9]*) record_status metadata_unavailable; sleep 5; continue ;; esac
      case "$callback_push_generation" in ''|*[!A-Za-z0-9._:-]*) record_status metadata_unavailable; sleep 5; continue ;; esac
      token=$(cat "$token_file")
      payload=$(printf '{"deploymentId":"%s","hostname":"%s","configRevision":%s,"pushGeneration":"%s"}' \
        "$deployment" "$hostname" "$callback_config_revision" "$callback_push_generation")
      sent=false
      if command -v curl >/dev/null 2>&1; then
        curl -fsS --connect-timeout 10 --max-time 30 -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H 'Accept: text/plain' --data "$payload" -o "$response" "$callback" >/dev/null 2>&1 && sent=true
      elif command -v wget >/dev/null 2>&1; then
        wget -qO "$response" -T 30 --header="Authorization: Bearer $token" --header='Content-Type: application/json' --header='Accept: text/plain' --post-data="$payload" "$callback" >/dev/null 2>&1 && sent=true
      fi
      unset token payload
      if [ "$sent" = true ] && [ -s "$response" ]; then
        chmod 640 "$response"; mv -f "$response" "$nodes_file"
        cksum "$nodes_file" >"${nodes_checksum_file}.new.$$"; chmod 600 "${nodes_checksum_file}.new.$$"; mv -f "${nodes_checksum_file}.new.$$" "$nodes_checksum_file"
        printf '%s\n' "$hostname" >"${hostname_file}.new.$$"; chmod 600 "${hostname_file}.new.$$"; mv -f "${hostname_file}.new.$$" "$hostname_file"
        record_status ready
      else rm -f "$response"; record_status callback_failed; fi
    fi
    attempt=0
  fi
  sleep 5
done
exit 1
EOF
  atomic_install "$monitor" "$TSUB_STATE/quick-tunnel-monitor.sh" 700
}

tunnel_stop() {
  for pid_file in "$TSUB_STATE"/tunnel-supervisor-*.pid; do
    [ -r "$pid_file" ] || continue
    managed_pid=$(cat "$pid_file" 2>/dev/null || true)
    case "$managed_pid" in ''|*[!0-9]*) ;; *) kill "$managed_pid" 2>/dev/null || true ;; esac
  done
  for pid_file in "$TSUB_STATE"/tunnel-*.pid "$TSUB_STATE"/quick-tunnel-monitor-*.pid; do
    [ -r "$pid_file" ] || continue
    managed_pid=$(cat "$pid_file" 2>/dev/null || true)
    case "$managed_pid" in ''|*[!0-9]*) ;; *) kill "$managed_pid" 2>/dev/null || true ;; esac
    rm -f "$pid_file"
  done
  rm -f "$TSUB_STATE"/tunnel-supervisor-*.pid
  rm -f "$TSUB_STATE/quick-tunnel.hostname" "$TSUB_STATE/quick-tunnel.hostname.nodes.cksum" "$TSUB_STATE/quick-tunnel.hostname.status"
}

tunnel_start() {
  count=$(kv_get tunnel_count); count=${count:-0}
  [ "$count" -gt 0 ] || return 0
  [ -x "$TSUB_STATE/start-tunnels.sh" ] || return 1
  "$TSUB_STATE/start-tunnels.sh"
}

tunnel_health_rss() {
  count=$(kv_get tunnel_count); count=${count:-0}
  total=0; index=1
  while [ "$index" -le "$count" ]; do
    pid=$(cat "$TSUB_STATE/tunnel-$index.pid" 2>/dev/null || true)
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    rss=$(awk '/VmRSS:/ {printf "%d", ($2 + 1023) / 1024; exit}' "/proc/$pid/status" 2>/dev/null || printf 0)
    [ "$rss" -gt 0 ] || return 1
    total=$((total + rss)); index=$((index + 1))
  done
  printf '%s\n' "$total"
}

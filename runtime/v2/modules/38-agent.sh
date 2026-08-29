# shellcheck shell=sh

agent_enabled() {
  [ "$(kv_get agent_mode)" != local ] && [ -n "$(kv_get agent_controller_url)" ] && [ -n "$(kv_get agent_deployment_id)" ] && [ -n "$(kv_get agent_token_b64)" ]
}

agent_poll_interval() {
  agent_interval=$(kv_get agent_poll_interval_seconds)
  case "$agent_interval" in 15|30|60|120|180|300) printf '%s' "$agent_interval" ;; *) printf 30 ;; esac
}

agent_controller_origin() {
  case "${TSUB_AGENT_URL:-}" in
    https://*) printf '%s' "$TSUB_AGENT_URL" | sed 's#^\(https://[^/]*\).*$#\1#' ;;
    *) return 1 ;;
  esac
}

agent_maybe_update_runtime() {
  [ -n "${TSUB_STATE:-}" ] && [ -n "${TSUB_BIN:-}" ] && [ -n "${TSUB_TMP:-}" ] || return 0
  agent_update_now=$(date +%s 2>/dev/null || printf 0)
  agent_update_checked_file="$TSUB_STATE/runtime.update-checked-at"
  agent_update_checked=$(cat "$agent_update_checked_file" 2>/dev/null || printf 0)
  case "$agent_update_now:$agent_update_checked" in *[!0-9:]*) agent_update_checked=0 ;; esac
  # Configuration application should pick up a newly published Runtime immediately;
  # the regular agent loop remains throttled to avoid needless manifest requests.
  [ "${1:-}" = force ] || { [ "$agent_update_now" -eq 0 ] || [ $((agent_update_now - agent_update_checked)) -ge 3600 ] || return 0; }

  TSUB_AGENT_URL=$(kv_get agent_controller_url)
  agent_update_origin=$(agent_controller_origin) || return 0
  agent_update_manifest="$TSUB_TMP/runtime-manifest.json"
  if ! download_file "$agent_update_origin/proxy/v2/manifest.json?v=$agent_update_now" "$agent_update_manifest"; then return 0; fi
  agent_update_version=$(sed -n 's/.*"runtimeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$agent_update_manifest" | head -n 1)
  agent_update_path=$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$agent_update_manifest" | head -n 1)
  agent_update_sha=$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' "$agent_update_manifest" | head -n 1 | tr 'A-F' 'a-f')
  agent_target_version=$(kv_get runtime_target_version)
  agent_target_path=$(kv_get runtime_target_path)
  agent_target_sha=$(kv_get runtime_target_sha256 | tr 'A-F' 'a-f')
  if [ -n "$agent_target_version" ] || [ -n "$agent_target_path" ] || [ -n "$agent_target_sha" ]; then
    agent_update_version=$agent_target_version
    agent_update_path=$agent_target_path
    agent_update_sha=$agent_target_sha
    grep -F "${agent_update_version}" "$agent_update_manifest" >/dev/null 2>&1 || return 0
  fi
  case "$agent_update_version" in ''|*[!0-9A-Za-z._-]*) return 0 ;; esac
  case "$agent_update_path" in
    /proxy/v2/tsub-proxy.sh|/proxy/v2/history/*/tsub-proxy.sh) ;;
    *) return 0 ;;
  esac
  case "$agent_update_sha" in *[!0-9a-f]*|'') return 0 ;; esac
  [ "${#agent_update_sha}" -eq 64 ] || return 0
  agent_update_target="$TSUB_BIN/tsub-proxy.sh"
  if [ -x "$agent_update_target" ] && [ "$(sha256_file "$agent_update_target")" = "$agent_update_sha" ]; then
    printf '%s\n' "$agent_update_now" >"$TSUB_TMP/runtime.update-checked-at"
    atomic_install "$TSUB_TMP/runtime.update-checked-at" "$agent_update_checked_file" 600
    return 0
  fi
  agent_update_download="$TSUB_TMP/runtime-update.sh"
  rm -f "$agent_update_download"
  if ! download_file "$agent_update_origin$agent_update_path?v=$agent_update_sha" "$agent_update_download"; then
    i18n_log WARN "Runtime $agent_update_version 下载失败，将在下一轮 Agent 轮询重试" "Runtime $agent_update_version download failed; retrying on the next agent poll"
    rm -f "$agent_update_download"
    return 0
  fi
  [ "$(sha256_file "$agent_update_download")" = "$agent_update_sha" ] || { i18n_log ERROR 'Runtime 自动更新校验失败' 'Runtime automatic update verification failed'; rm -f "$agent_update_download"; return 0; }
  if ! atomic_install "$agent_update_download" "$agent_update_target" 700; then
    i18n_log WARN "Runtime $agent_update_version 安装失败，将在下一轮 Agent 轮询重试" "Runtime $agent_update_version installation failed; retrying on the next agent poll"
    rm -f "$agent_update_download"
    return 0
  fi
  printf '%s\n' "$agent_update_now" >"$TSUB_TMP/runtime.update-checked-at"
  atomic_install "$TSUB_TMP/runtime.update-checked-at" "$agent_update_checked_file" 600
  i18n_log INFO "Runtime 已更新到 $agent_update_version" "Runtime updated to $agent_update_version"
  [ "${2:-}" = no-reload ] && return 0
  rm -rf "$TSUB_TMP"
  trap - 0 1 2 15
  exec /bin/sh "$agent_update_target" agent
}

agent_restart_service() {
  if [ "${TSUB_INIT:-none}" = systemd ] && have systemctl && [ -f /etc/systemd/system/tsub-agent.service ]; then
    systemctl restart tsub-agent.service >/dev/null 2>&1
    return $?
  fi
  if [ "${TSUB_INIT:-none}" = openrc ] && have rc-service && [ -f /etc/init.d/tsub-agent ]; then
    rc-service tsub-agent restart >/dev/null 2>&1
    return $?
  fi
  return 1
}

agent_value() {
  agent_key=$1 agent_file=$2
  sed -n "/^${agent_key}=/ { s/^[^=]*=//; p; q; }" "$agent_file"
}

agent_report() {
  agent_command_id=$1 agent_lease=$2 agent_status=$3 agent_stage=$4 agent_message=$5
  agent_message_json=$(json_escape "$agent_message")
  agent_error_code_json=$(json_escape "${TSUB_ERROR_CODE:-}")
  agent_hostname_json=$(json_escape "${TSUB_HOSTNAME:-unknown}")
  agent_node_count=0
  agent_nodes_file=${TSUB_STATE:+$TSUB_STATE/nodes.txt}
  if [ "$agent_status" = succeeded ] && [ -n "$agent_nodes_file" ] && [ -r "$agent_nodes_file" ]; then
    agent_node_count=$(wc -l <"$agent_nodes_file" | tr -d ' ')
    case "$agent_node_count" in ''|*[!0-9]*) agent_node_count=0 ;; esac
  fi
  agent_event="$TSUB_TMP/agent-event.json"
  agent_resources="\"nodeCount\":$agent_node_count"
  agent_subscription_fields=''
  if [ "$agent_status" = succeeded ] && subscription_enabled 2>/dev/null && subscription_running 2>/dev/null && ! tunnel_quick_pending 2>/dev/null && [ -r "$agent_nodes_file" ]; then
    agent_nodes_json_file="$TSUB_TMP/agent-nodes.json"
    printf '[' >"$agent_nodes_json_file"
    agent_node_separator=''
    while IFS= read -r agent_node; do
      [ -n "$agent_node" ] || continue
      agent_node_json=$(json_escape "$agent_node")
      printf '%s"%s"' "$agent_node_separator" "$agent_node_json" >>"$agent_nodes_json_file"
      agent_node_separator=,
    done <"$agent_nodes_file"
    printf ']' >>"$agent_nodes_json_file"
    agent_nodes_json_size=$(wc -c <"$agent_nodes_json_file" | tr -d ' ')
    case "$agent_nodes_json_size" in ''|*[!0-9]*) agent_nodes_json_size=999999 ;; esac
    if [ "$agent_nodes_json_size" -le 196608 ]; then
      agent_server_address=$(kv_get push_server_address)
      [ -n "$agent_server_address" ] || agent_server_address=$(kv_get subscription_hostname)
      agent_subscription_port=$(kv_get subscription_server_port)
      agent_config_revision=$(kv_get config_revision)
      case "$agent_subscription_port" in ''|*[!0-9]*) agent_subscription_port=0 ;; esac
      case "$agent_config_revision" in ''|*[!0-9]*) agent_config_revision=0 ;; esac
      agent_subscription_fields=$(printf ',"subscriptionReady":true,"subscriptionNodeCount":%s,"subscriptionNodes":%s,"serverAddress":"%s","subscriptionPort":%s,"pushGeneration":"%s","configRevision":%s' \
        "$agent_node_count" "$(cat "$agent_nodes_json_file")" "$(json_escape "$agent_server_address")" \
        "$agent_subscription_port" "$(json_escape "$(kv_get push_generation)")" "$agent_config_revision")
    fi
  fi
  if [ "$agent_stage" = edge-probe ] && [ -r "$TSUB_TMP/edge-probe.result" ]; then
    agent_probe_dns=$(agent_value dns "$TSUB_TMP/edge-probe.result"); agent_probe_tcp=$(agent_value tcp "$TSUB_TMP/edge-probe.result")
    agent_probe_tls=$(agent_value tls "$TSUB_TMP/edge-probe.result"); agent_probe_sni=$(agent_value hostSni "$TSUB_TMP/edge-probe.result")
    agent_probe_ws=$(agent_value websocket101 "$TSUB_TMP/edge-probe.result"); agent_probe_latency=$(agent_value latencyMs "$TSUB_TMP/edge-probe.result")
    case "$agent_probe_latency" in ''|*[!0-9]*) agent_probe_latency=0 ;; esac
    [ "$agent_probe_dns" = true ] || agent_probe_dns=false
    [ "$agent_probe_tcp" = true ] || agent_probe_tcp=false
    [ "$agent_probe_tls" = true ] || agent_probe_tls=false
    [ "$agent_probe_sni" = true ] || agent_probe_sni=false
    [ "$agent_probe_ws" = true ] || agent_probe_ws=false
    agent_resources="$agent_resources,\"edgeProbe\":{\"ok\":$agent_probe_ws,\"checks\":{\"dns\":$agent_probe_dns,\"tcp\":$agent_probe_tcp,\"tls\":$agent_probe_tls,\"hostSni\":$agent_probe_sni,\"websocket101\":$agent_probe_ws},\"latencyMs\":$agent_probe_latency}"
  fi
  printf '{"status":"%s","stage":"%s","message":"%s","errorCode":"%s","hostname":"%s","resources":{%s}%s}\n' \
    "$agent_status" "$agent_stage" "$agent_message_json" "$agent_error_code_json" "$agent_hostname_json" "$agent_resources" "$agent_subscription_fields" >"$agent_event"
  curl -fsS --connect-timeout 10 --max-time 30 -X POST \
    -H "Authorization: Bearer $TSUB_AGENT_TOKEN" -H "X-TSub-Lease: $agent_lease" \
    -H 'Content-Type: application/json' --data-binary "@$agent_event" \
    "$TSUB_AGENT_URL/commands/$agent_command_id/events" >/dev/null 2>&1 || true
}

agent_renew_lease() {
  agent_command_id=$1 agent_lease=$2 agent_action=$3
  agent_hostname_json=$(json_escape "${TSUB_HOSTNAME:-unknown}")
  agent_event="$TSUB_TMP/agent-lease-event.json"
  printf '{"status":"running","stage":"%s","message":"","hostname":"%s","leaseRenewal":true}\n' \
    "$agent_action" "$agent_hostname_json" >"$agent_event"
  curl -fsS --connect-timeout 10 --max-time 30 -X POST \
    -H "Authorization: Bearer $TSUB_AGENT_TOKEN" -H "X-TSub-Lease: $agent_lease" \
    -H 'Content-Type: application/json' --data-binary "@$agent_event" \
    "$TSUB_AGENT_URL/commands/$agent_command_id/events" >/dev/null 2>&1
}

agent_lease_renew_loop() {
  agent_command_id=$1 agent_lease=$2 agent_action=$3
  agent_renew_seconds=${TSUB_AGENT_LEASE_RENEW_SECONDS:-45}
  case "$agent_renew_seconds" in ''|*[!0-9]*) agent_renew_seconds=45 ;; esac
  [ "$agent_renew_seconds" -ge 1 ] || agent_renew_seconds=1
  while sleep "$agent_renew_seconds"; do
    agent_renew_lease "$agent_command_id" "$agent_lease" "$agent_action" || return 0
  done
}

agent_stop_lease_renewal() {
  agent_renew_pid=$1
  kill "$agent_renew_pid" 2>/dev/null || true
  wait "$agent_renew_pid" 2>/dev/null || true
}

agent_failure_summary() {
  agent_failure_log=$1
  [ -r "$agent_failure_log" ] || return 0
  redact_sensitive_stream <"$agent_failure_log" | tail -n 1 | tail -c 300
}

agent_capture_edge_probe_result() {
  agent_probe_log=$1
  agent_probe_line=$(sed -n 's/^TSUB_EDGE_PROBE_RESULT //p' "$agent_probe_log" 2>/dev/null | tail -n 1)
  [ -n "$agent_probe_line" ] || return 0
  printf '%s\n' "$agent_probe_line" | tr ' ' '\n' >"$TSUB_TMP/edge-probe.result"
  chmod 600 "$TSUB_TMP/edge-probe.result"
}

agent_decode_value() {
  agent_encoded=$1 agent_output=$2
  printf '%s' "$agent_encoded" >"$agent_output.b64"
  agent_decoded=false
  if have base64; then
    if base64 -d <"$agent_output.b64" >"$agent_output" 2>/dev/null; then agent_decoded=true
    elif base64 --decode <"$agent_output.b64" >"$agent_output" 2>/dev/null; then agent_decoded=true
    elif base64 -D <"$agent_output.b64" >"$agent_output" 2>/dev/null; then agent_decoded=true; fi
  fi
  if [ "$agent_decoded" = false ] && have openssl; then
    if openssl base64 -d -A <"$agent_output.b64" >"$agent_output" 2>/dev/null; then agent_decoded=true; fi
  fi
  rm -f "$agent_output.b64"
  [ "$agent_decoded" = true ] && [ -s "$agent_output" ] || { rm -f "$agent_output"; return 1; }
  chmod 600 "$agent_output"
}

agent_execute_transfer() {
  agent_transfer_config=$1 agent_command_id=$2 agent_lease=$3
  agent_target=$(agent_value transfer_target_url "$agent_transfer_config")
  case "$agent_target" in https://*) ;; *) return 4 ;; esac
  agent_claim_b64=$(agent_value transfer_claim_b64 "$agent_transfer_config")
  agent_claim_file="$TSUB_TMP/transfer.claim"
  agent_decode_value "$agent_claim_b64" "$agent_claim_file" || return 5
  agent_claim=$(cat "$agent_claim_file")
  agent_registration="$TSUB_TMP/transfer-registration.conf"
  curl -fsS --connect-timeout 10 --max-time 45 -X POST -H "Authorization: Bearer $agent_claim" \
    -o "$agent_registration" "$agent_target/api/deploy/agent/transfer/claim" || return 6
  agent_new_url=$(agent_value agent_controller_url "$agent_registration")
  agent_new_deployment=$(agent_value agent_deployment_id "$agent_registration")
  agent_new_token_b64=$(agent_value agent_token_b64 "$agent_registration")
  case "$agent_new_url" in https://*) ;; *) return 7 ;; esac
  [ -n "$agent_new_deployment" ] && [ -n "$agent_new_token_b64" ] || return 7
  agent_new_token_file="$TSUB_TMP/agent-new.token"
  agent_decode_value "$agent_new_token_b64" "$agent_new_token_file" || return 7
  agent_persistent="$TSUB_ETC/runtime.conf"
  [ -r "$agent_persistent" ] || return 8
  sed '/^agent_mode=/d; /^agent_controller_url=/d; /^agent_deployment_id=/d; /^agent_token_b64=/d' "$agent_persistent" >"$TSUB_TMP/runtime-transferred.conf"
  printf 'agent_mode=remote\nagent_controller_url=%s\nagent_deployment_id=%s\nagent_token_b64=%s\n' \
    "$agent_new_url" "$agent_new_deployment" "$agent_new_token_b64" >>"$TSUB_TMP/runtime-transferred.conf"
  atomic_install "$TSUB_TMP/runtime-transferred.conf" "$agent_persistent" 600
  agent_report "$agent_command_id" "$agent_lease" succeeded transfer-controller 'controller transfer completed'
  TSUB_AGENT_URL=$agent_new_url
  TSUB_AGENT_TOKEN=$(cat "$agent_new_token_file")
}

agent_execute_command() {
  agent_command_id=$1 agent_action=$2 agent_lease=$3
  case "$agent_action" in apply|update|update-runtime|rollback-runtime|reinstall|restart|repair|status|list|doctor|rollback|uninstall|transfer-controller|edge-probe) ;; *) return 2 ;; esac
  agent_config="$TSUB_TMP/agent-command.conf"
  curl -fsS --connect-timeout 10 --max-time 60 \
    -H "Authorization: Bearer $TSUB_AGENT_TOKEN" -H "X-TSub-Lease: $agent_lease" \
    -o "$agent_config" "$TSUB_AGENT_URL/commands/$agent_command_id/config" || return 3
  chmod 600 "$agent_config"
  if [ "$agent_action" = transfer-controller ]; then
    agent_report "$agent_command_id" "$agent_lease" running transfer-controller 'controller transfer started'
    if agent_execute_transfer "$agent_config" "$agent_command_id" "$agent_lease"; then
      return 0
    else
      agent_result=$?
    fi
    agent_report "$agent_command_id" "$agent_lease" failed transfer-controller "controller transfer failed with exit $agent_result"
    return "$agent_result"
  fi
  agent_report "$agent_command_id" "$agent_lease" running "$agent_action" 'command started'
  agent_command_log="$TSUB_TMP/agent-command.log"
  [ "$agent_action" != edge-probe ] || rm -f "$TSUB_TMP/edge-probe.result"
  agent_lease_renew_loop "$agent_command_id" "$agent_lease" "$agent_action" &
  agent_renew_pid=$!
  if TSUB_AGENT_RUNNING=true TSUB_SUPPRESS_SENSITIVE_OUTPUT=true TSUB_CONFIG="$agent_config" \
    /bin/sh "$TSUB_BIN/tsub-proxy.sh" "$agent_action" >"$agent_command_log" 2>&1; then
    agent_stop_lease_renewal "$agent_renew_pid"
    append_redacted_log "$agent_command_log"
    if [ "$agent_action" = edge-probe ]; then
      agent_capture_edge_probe_result "$agent_command_log"
      agent_probe_message=$(tail -n 1 "$agent_command_log" | tail -c 300)
      agent_report "$agent_command_id" "$agent_lease" succeeded "$agent_action" "${agent_probe_message:-edge probe passed}"
    else
      agent_report "$agent_command_id" "$agent_lease" succeeded "$agent_action" 'command completed'
      agent_poll_once true >/dev/null 2>&1 || true
      case "$agent_action" in
        update-runtime|rollback-runtime)
          rm -rf "$TSUB_TMP"
          trap - 0 1 2 15
          exec /bin/sh "$TSUB_BIN/tsub-proxy.sh" agent
          ;;
        apply|update|reinstall)
          # Report completion first, then replace this Agent with the verified Runtime.
          agent_maybe_update_runtime force
          ;;
      esac
    fi
  else
    agent_result=$?
    agent_stop_lease_renewal "$agent_renew_pid"
    append_redacted_log "$agent_command_log"
    [ "$agent_action" != edge-probe ] || agent_capture_edge_probe_result "$agent_command_log"
    agent_failure=$(agent_failure_summary "$agent_command_log" || true)
    agent_failure=${agent_failure:-command failed with exit $agent_result}
    agent_report "$agent_command_id" "$agent_lease" failed "$agent_action" "$agent_failure"
    agent_poll_once true >/dev/null 2>&1 || true
    return "$agent_result"
  fi
}

agent_poll_once() {
  agent_heartbeat_only=${1:-false}
  agent_response="$TSUB_TMP/agent-poll.txt"
  agent_payload="$TSUB_TMP/agent-poll.json"
  agent_core=$(kv_get runtime_core); agent_core=${agent_core:-unknown}
  agent_core_version=$(kv_get "${agent_core}_version"); agent_core_version=${agent_core_version:-unknown}
  agent_core_identity=$(basename "$(cat "$TSUB_STATE/core.identity" 2>/dev/null || printf unknown)")
  agent_config_revision=$(kv_get config_revision); agent_config_revision=${agent_config_revision:-0}
  case "$agent_config_revision" in ''|*[!0-9]*) agent_config_revision=0 ;; esac
  agent_core_rss=$(process_rss_mb 2>/dev/null || printf 0)
  agent_tunnel_rss=$(tunnel_health_rss 2>/dev/null || printf 0)
  case "$agent_core_rss" in ''|*[!0-9]*) agent_core_rss=0 ;; esac
  case "$agent_tunnel_rss" in ''|*[!0-9]*) agent_tunnel_rss=0 ;; esac
  agent_rss=$((agent_core_rss + agent_tunnel_rss))
  case "$agent_core" in xray) agent_estimated_core=42 ;; sing-box) agent_estimated_core=44 ;; *) agent_estimated_core=0 ;; esac
  agent_tunnel_count=$(kv_get tunnel_count); case "$agent_tunnel_count" in ''|*[!0-9]*) agent_tunnel_count=0 ;; esac
  if [ "$agent_tunnel_count" -gt 0 ]; then agent_estimated_tunnel=45; else agent_estimated_tunnel=0; fi
  printf '{"runtimeVersion":"%s","core":"%s","coreVersion":"%s","coreIdentity":"%s","osId":"%s","osVersion":"%s","osPrettyName":"%s","hostname":"%s","currentCommandId":"","configRevision":%s,"pollIntervalSeconds":%s,"cgroupLimitMb":%s,"memoryAvailableMb":%s,"swapReported":%s,"swapTotalMb":%s,"swapFreeMb":%s,"swapUsedMb":%s,"cgroupSwapReported":%s,"cgroupSwapCurrentMb":%s,"cgroupSwapLimitMb":%s,"rssMb":%s,"coreRssMb":%s,"cloudflaredRssMb":%s,"estimatedCoreRssMb":%s,"estimatedCloudflaredRssMb":%s,"quickTunnelStatus":"%s"}\n' \
    "${TSUB_RUNTIME_VERSION:-unknown}" "$(json_escape "$agent_core")" "$(json_escape "$agent_core_version")" "$(json_escape "$agent_core_identity")" \
    "$(json_escape "${TSUB_OS:-unknown}")" "$(json_escape "${TSUB_OS_VERSION:-unknown}")" "$(json_escape "${TSUB_OS_PRETTY:-unknown}")" \
    "$(json_escape "${TSUB_HOSTNAME:-unknown}")" "$agent_config_revision" "$(agent_poll_interval)" \
    "${TSUB_MEMORY_MB:-0}" "${TSUB_MEMORY_AVAILABLE_MB:-0}" "${TSUB_SWAP_REPORTED:-false}" "${TSUB_SWAP_TOTAL_MB:-0}" "${TSUB_SWAP_FREE_MB:-0}" "${TSUB_SWAP_USED_MB:-0}" \
    "${TSUB_CGROUP_SWAP_REPORTED:-false}" "${TSUB_CGROUP_SWAP_CURRENT_MB:-0}" "${TSUB_CGROUP_SWAP_LIMIT_MB:-0}" \
    "$agent_rss" "$agent_core_rss" "$agent_tunnel_rss" "$agent_estimated_core" "$agent_estimated_tunnel" "$(tunnel_quick_status)" >"$agent_payload"
  if [ "$agent_heartbeat_only" = true ]; then
    sed -i 's/}$/,"heartbeatOnly":true}/' "$agent_payload"
  fi
  agent_http=$(curl -sS -o "$agent_response" -w '%{http_code}' --connect-timeout 10 --max-time 35 -X POST \
    -H "Authorization: Bearer $TSUB_AGENT_TOKEN" -H 'Accept: text/plain' -H 'Content-Type: application/json' \
    --data-binary "@$agent_payload" "$TSUB_AGENT_URL/poll" 2>/dev/null || printf 000)
  [ "$agent_http" = 200 ] || { [ "$agent_http" = 409 ] && printf 300 || agent_poll_interval; return 1; }
  [ "$agent_heartbeat_only" = true ] && { printf '%s' "$(agent_value nextPollSeconds "$agent_response")"; return 0; }
  agent_wait=$(agent_value nextPollSeconds "$agent_response"); agent_wait=${agent_wait:-$(agent_poll_interval)}
  agent_command_id=$(agent_value commandId "$agent_response")
  if [ -n "$agent_command_id" ]; then
    agent_action=$(agent_value action "$agent_response")
    agent_lease=$(agent_value leaseId "$agent_response")
    agent_execute_command "$agent_command_id" "$agent_action" "$agent_lease" || true
  fi
  printf '%s' "$agent_wait"
}

agent_heartbeat_now() {
  agent_enabled || return 0
  have curl || return 1
  agent_token_file="$TSUB_TMP/agent-heartbeat.token"
  b64_decode_file agent_token_b64 "$agent_token_file" || return 1
  TSUB_AGENT_TOKEN=$(cat "$agent_token_file")
  TSUB_AGENT_URL=$(kv_get agent_controller_url)
  agent_poll_once true >/dev/null 2>&1
}

run_agent_loop() {
  agent_enabled || i18n_die '服务器 Agent 未配置' 'The server agent is not configured'
  have curl || i18n_die '服务器 Agent 需要 curl' 'The server agent requires curl'
  agent_token_file="$TSUB_TMP/agent.token"
  b64_decode_file agent_token_b64 "$agent_token_file" || i18n_die '服务器 Agent Token 无效' 'Invalid server agent token'
  TSUB_AGENT_TOKEN=$(cat "$agent_token_file")
  TSUB_AGENT_URL=$(kv_get agent_controller_url)
  agent_loop_running=true
  agent_sleep_pid=''
  stop_agent_loop() {
    agent_loop_running=false
    case "$agent_sleep_pid" in ''|*[!0-9]*) ;; *) kill "$agent_sleep_pid" 2>/dev/null || true ;; esac
  }
  trap stop_agent_loop HUP INT TERM
  while [ "$agent_loop_running" = true ]; do
    agent_maybe_update_runtime
    agent_sleep=$(agent_poll_once || true); agent_sleep=${agent_sleep:-$(agent_poll_interval)}
    case "$agent_sleep" in ''|*[!0-9]*) agent_sleep=$(agent_poll_interval) ;; esac
    [ "$agent_sleep" -ge 5 ] || agent_sleep=5
    [ "$agent_sleep" -le 300 ] || agent_sleep=300
    [ "$agent_loop_running" = true ] || break
    sleep "$agent_sleep" & agent_sleep_pid=$!
    wait "$agent_sleep_pid" 2>/dev/null || true
    agent_sleep_pid=''
  done
  trap - HUP INT TERM
}

install_agent_service() {
  agent_runtime=$1 agent_config=$2
  agent_enabled || return 0
  [ "${TSUB_AGENT_RUNNING:-false}" = true ] && return 0
  if [ "$TSUB_INIT" = systemd ] && [ "$(id -u)" -eq 0 ]; then
    agent_service="$TSUB_TMP/tsub-agent.service"
    cat >"$agent_service" <<EOF
[Unit]
Description=TSub controller agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
Environment=TSUB_CONFIG=$agent_config
ExecStart=$agent_runtime agent
Restart=always
RestartSec=5
TimeoutStopSec=20
[Install]
WantedBy=multi-user.target
EOF
    atomic_install "$agent_service" /etc/systemd/system/tsub-agent.service 644
    systemctl daemon-reload
    systemctl enable tsub-agent.service >/dev/null 2>&1 || true
    systemctl restart tsub-agent.service >/dev/null 2>&1 || i18n_degraded '服务器 Agent 启动失败' 'The server agent failed to start'
  elif [ "$TSUB_INIT" = openrc ] && [ "$(id -u)" -eq 0 ] && have rc-service; then
    agent_service="$TSUB_TMP/tsub-agent"
    cat >"$agent_service" <<EOF
#!/sbin/openrc-run
name="TSub controller agent"
command="$agent_runtime"
command_args="agent"
command_background=true
pidfile="/run/tsub-agent.pid"
retry="TERM/10/KILL/5"
output_log="$TSUB_LOG"
error_log="$TSUB_LOG"
export TSUB_CONFIG="$agent_config"
depend() { need net; }
EOF
    atomic_install "$agent_service" /etc/init.d/tsub-agent 700
    rc-update add tsub-agent default >/dev/null 2>&1 || true
    rc-service tsub-agent restart >/dev/null 2>&1 || i18n_degraded '服务器 Agent 启动失败' 'The server agent failed to start'
  elif have crontab; then
    agent_cron="$TSUB_TMP/agent.cron"
    crontab -l 2>/dev/null | grep -v 'tsub-proxy.sh agent' >"$agent_cron" || true
    printf '*/5 * * * * TSUB_CONFIG=%s timeout 290 %s agent >>%s 2>&1\n' "$agent_config" "$agent_runtime" "$TSUB_LOG" >>"$agent_cron"
    crontab "$agent_cron"
  else
    i18n_degraded '没有可用的服务器 Agent 调度入口' 'No server agent scheduler is available'
  fi
}

remove_agent_service() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl disable --now tsub-agent.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/tsub-agent.service
    if have rc-service; then rc-service tsub-agent stop >/dev/null 2>&1 || true; fi
    if have rc-update; then rc-update del tsub-agent default >/dev/null 2>&1 || true; fi
    rm -f /etc/init.d/tsub-agent /run/tsub-agent.pid
  fi
  if have crontab; then
    agent_cron="$TSUB_TMP/agent.cron"
    crontab -l 2>/dev/null | grep -v 'tsub-proxy.sh agent' >"$agent_cron" || true
    crontab "$agent_cron" 2>/dev/null || true
  fi
}

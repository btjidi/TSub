#!/bin/sh
set -eu
umask 077

CONFIG=${TSUB_EXECUTOR_CONFIG:-/run/tsub/executor.conf}
SOCKET=${TSUB_CONTROLLER_SOCKET:-/run/tsub/controller.sock}
RUNTIME=${TSUB_RUNTIME_PATH:-/var/lib/tsub/bin/tsub-proxy.sh}
RUNTIME_SOURCE=${TSUB_RUNTIME_SOURCE_PATH:-/opt/tsub-controller/dist/proxy/v2/tsub-proxy.sh}
STATE=${TSUB_EXECUTOR_STATE:-/var/lib/tsub-controller/executor}

value() { sed -n "/^$1=/ { s/^[^=]*=//; p; q; }" "$CONFIG"; }
executor_runtime_path() {
  if [ -x "$RUNTIME" ]; then printf '%s' "$RUNTIME"
  elif [ -x "$RUNTIME_SOURCE" ]; then printf '%s' "$RUNTIME_SOURCE"
  else return 1
  fi
}
TOKEN_FILE="$STATE/token"

load_executor_token() {
  printf '%s' "$(value agent_token_b64)" | base64 -d >"$TOKEN_FILE" 2>/dev/null
  chmod 600 "$TOKEN_FILE"
  TOKEN=$(cat "$TOKEN_FILE")
  [ -n "$TOKEN" ]
}

decode_base64_file() {
  encoded=$1 output=$2
  printf '%s' "$encoded" >"$output.b64"
  if base64 -d <"$output.b64" >"$output" 2>/dev/null ||
     base64 --decode <"$output.b64" >"$output" 2>/dev/null ||
     base64 -D <"$output.b64" >"$output" 2>/dev/null; then
    rm -f "$output.b64"
    chmod 600 "$output"
    [ -s "$output" ]
    return
  fi
  rm -f "$output.b64" "$output"
  return 1
}

execute_controller_transfer() {
  transfer_config=$1
  target_url=$(sed -n 's/^transfer_target_url=//p' "$transfer_config")
  claim_b64=$(sed -n 's/^transfer_claim_b64=//p' "$transfer_config")
  case "$target_url" in https://*) ;; *) return 20 ;; esac
  claim_file="$STATE/transfer.claim.$$"
  registration="$STATE/transfer.registration.$$"
  next_config="$STATE/runtime.next.$$"
  decode_base64_file "$claim_b64" "$claim_file" || return 21
  if ! curl -fsS --connect-timeout 10 --max-time 45 -X POST -H "Authorization: Bearer $(cat "$claim_file")" \
    -o "$registration" "$target_url/api/deploy/agent/transfer/claim"; then
    rm -f "$claim_file" "$registration"
    return 22
  fi
  rm -f "$claim_file"
  next_url=$(sed -n 's/^agent_controller_url=//p' "$registration")
  next_deployment=$(sed -n 's/^agent_deployment_id=//p' "$registration")
  next_token_b64=$(sed -n 's/^agent_token_b64=//p' "$registration")
  case "$next_url" in https://*) ;; *) rm -f "$registration"; return 23 ;; esac
  [ -n "$next_deployment" ] && [ -n "$next_token_b64" ] || { rm -f "$registration"; return 23; }
  token_check="$STATE/transfer.token.$$"
  decode_base64_file "$next_token_b64" "$token_check" || { rm -f "$registration"; return 23; }
  rm -f "$token_check"
  persistent_config=${TSUB_RUNTIME_CONFIG:-/etc/tsub/runtime.conf}
  [ -r "$persistent_config" ] || { rm -f "$registration"; return 24; }
  sed '/^agent_mode=/d; /^agent_controller_url=/d; /^agent_deployment_id=/d; /^agent_token_b64=/d' "$persistent_config" >"$next_config"
  printf 'agent_mode=remote\nagent_controller_url=%s\nagent_deployment_id=%s\nagent_token_b64=%s\n' \
    "$next_url" "$next_deployment" "$next_token_b64" >>"$next_config"
  chmod 600 "$next_config"
  mv "$next_config" "$persistent_config"
  chmod 600 "$persistent_config"
  rm -f "$registration"
  transfer_runtime=$(executor_runtime_path) || return 25
  if ! TSUB_CONFIG="$persistent_config" /bin/sh "$transfer_runtime" agent-install; then return 25; fi
}

report() {
  command_id=$1 lease_id=$2 status=$3 action=$4 message=$5
  event="$STATE/event.$$"
  safe_message=$(printf '%s' "$message" | tr '\r\n\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"status":"%s","stage":"%s","message":"%s","hostname":"%s"}\n' \
    "$status" "$action" "$safe_message" "${executor_hostname:-unknown}" >"$event"
  curl --unix-socket "$SOCKET" -fsS -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-TSub-Lease: $lease_id" -H 'Content-Type: application/json' --data-binary "@$event" \
    "http://localhost/api/deploy/agent/commands/$command_id/events" >/dev/null 2>&1 || true
  rm -f "$event"
}

executor_os_value() {
  executor_os_key=$1
  executor_os_result=$(sed -n "s/^${executor_os_key}=//p" /etc/os-release 2>/dev/null | head -n 1)
  case "$executor_os_result" in
    \"*\") executor_os_result=${executor_os_result#\"}; executor_os_result=${executor_os_result%\"} ;;
    \'*\') executor_os_result=${executor_os_result#\'}; executor_os_result=${executor_os_result%\'} ;;
  esac
  printf '%s' "$executor_os_result" | tr -d '\000-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

executor_main() {
[ "$(id -u)" -eq 0 ] || { echo 'TSub local executor must run as root' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required' >&2; exit 1; }
while [ ! -r "$CONFIG" ] || [ ! -S "$SOCKET" ] || ! executor_runtime_path >/dev/null; do sleep 5; done
mkdir -p "$STATE"
chmod 700 "$STATE"
executor_os_id=$(executor_os_value ID); executor_os_id=${executor_os_id:-unknown}
executor_os_version=$(executor_os_value VERSION_ID); executor_os_version=${executor_os_version:-unknown}
executor_os_pretty=$(executor_os_value PRETTY_NAME); executor_os_pretty=${executor_os_pretty:-$executor_os_id}
executor_hostname=$(hostname | tr -cd 'A-Za-z0-9._-'); executor_hostname=${executor_hostname:-unknown}
while :; do
  load_executor_token || { sleep 5; continue; }
  poll="$STATE/poll.$$"
  payload="$STATE/payload.$$"
  printf '{"runtimeVersion":"local-executor","osId":"%s","osVersion":"%s","osPrettyName":"%s","hostname":"%s"}\n' \
    "$executor_os_id" "$executor_os_version" "$executor_os_pretty" "$executor_hostname" >"$payload"
  code=$(curl --unix-socket "$SOCKET" -sS -o "$poll" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" -H 'Accept: text/plain' -H 'Content-Type: application/json' \
    --data-binary "@$payload" http://localhost/api/deploy/agent/poll 2>/dev/null || printf 000)
  rm -f "$payload"
  if [ "$code" = 200 ]; then
    command_id=$(sed -n 's/^commandId=//p' "$poll")
    action=$(sed -n 's/^action=//p' "$poll")
    lease_id=$(sed -n 's/^leaseId=//p' "$poll")
    wait_seconds=$(sed -n 's/^nextPollSeconds=//p' "$poll"); wait_seconds=${wait_seconds:-30}
    if [ -n "$command_id" ]; then
      case "$action" in apply|update|restart|repair|status|list|doctor|rollback|uninstall|transfer-controller) ;;
        *) report "$command_id" "$lease_id" failed executor 'unsupported action'; sleep 30; continue ;;
      esac
      command_config="$STATE/command.conf.$$"
      if curl --unix-socket "$SOCKET" -fsS -H "Authorization: Bearer $TOKEN" -H "X-TSub-Lease: $lease_id" \
        -o "$command_config" "http://localhost/api/deploy/agent/commands/$command_id/config"; then
        chmod 600 "$command_config"
        report "$command_id" "$lease_id" running "$action" 'local command started'
        if [ "$action" = transfer-controller ]; then
          if execute_controller_transfer "$command_config" >>/var/lib/tsub/runtime.log 2>&1; then
            report "$command_id" "$lease_id" succeeded "$action" 'controller transfer completed'
            rm -f "$CONFIG" "$command_config"
            continue
          else
            result=$?; report "$command_id" "$lease_id" failed "$action" "controller transfer failed with exit $result"
          fi
        else
          command_runtime=$(executor_runtime_path)
          if TSUB_AGENT_RUNNING=true TSUB_CONFIG="$command_config" /bin/sh "$command_runtime" "$action" >>/var/lib/tsub/runtime.log 2>&1; then
            report "$command_id" "$lease_id" succeeded "$action" 'local command completed'
          else
            result=$?; report "$command_id" "$lease_id" failed "$action" "local command failed with exit $result"
          fi
        fi
        rm -f "$command_config"
      fi
    fi
  else
    wait_seconds=30
    [ "$code" = 409 ] && wait_seconds=300
  fi
  rm -f "$poll"
  case "$wait_seconds" in ''|*[!0-9]*) wait_seconds=30 ;; esac
  [ "$wait_seconds" -ge 5 ] || wait_seconds=5
  [ "$wait_seconds" -le 300 ] || wait_seconds=300
  sleep "$wait_seconds"
done
}

[ "${TSUB_EXECUTOR_TEST_MODE:-false}" = true ] || executor_main

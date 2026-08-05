#!/bin/sh
# TSub Proxy v2 - POSIX shell only.
set -eu

umask 077

log() {
  if have date; then log_time=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date 2>/dev/null || printf unknown)
  else log_time=unknown; fi
  printf '%s [%s] %s\n' "$log_time" "$1" "$2" >&2
}

die() {
  log ERROR "$1"
  emit_event failed "$1"
  exit "${2:-1}"
}

have() { command -v "$1" >/dev/null 2>&1; }

core_go_memory_limit_mb() {
  runtime_memory_mb=${TSUB_MEMORY_MB:-0}
  case "$runtime_memory_mb" in ''|0|*[!0-9]*) return 1 ;; esac
  [ "$runtime_memory_mb" -le 96 ] || return 1
  if [ "$runtime_memory_mb" -le 64 ]; then printf 24
  else printf 40; fi
}

mark_runtime_oom_candidate() {
  runtime_memory_mb=${TSUB_MEMORY_MB:-0}
  case "$runtime_memory_mb" in ''|*[!0-9]*) runtime_memory_mb=0 ;; esac
  if [ "$runtime_memory_mb" -le 0 ]; then
    runtime_memory_limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || printf 0)
    case "$runtime_memory_limit" in ''|max|*[!0-9]*) return 0 ;; esac
    runtime_memory_mb=$((runtime_memory_limit / 1024 / 1024))
  fi
  [ "$runtime_memory_mb" -le 96 ] || return 0
  [ -w /proc/self/oom_score_adj ] || return 0
  printf '250\n' >/proc/self/oom_score_adj 2>/dev/null || true
}

run_core_command() (
  core_command_name=$(basename "$1")
  case "$core_command_name" in xray-*|sing-box-*)
    core_memory_limit=$(core_go_memory_limit_mb 2>/dev/null || true)
    if [ -n "$core_memory_limit" ]; then
      GOMEMLIMIT="${core_memory_limit}MiB"
      GOGC=50
      export GOMEMLIMIT GOGC
    fi
    [ ! -w /proc/self/oom_score_adj ] || printf '500\n' >/proc/self/oom_score_adj 2>/dev/null || true
    ;;
  esac
  exec "$@"
)

setpriv_supports_identity() {
  have setpriv && setpriv --help 2>&1 | grep -q -- '--reuid'
}

add_degraded_reason() {
  degraded_reason=$1
  case "; ${TSUB_DEGRADED_REASON:-};" in
    *"; $degraded_reason;"*) return 0 ;;
  esac
  TSUB_DEGRADED_REASON="${TSUB_DEGRADED_REASON:+$TSUB_DEGRADED_REASON; }$degraded_reason"
}

kv_get() {
  kv_key=$1
  while IFS='=' read -r kv_name kv_value; do
    if [ "$kv_name" = "$kv_key" ]; then
      printf '%s\n' "$kv_value"
      return 0
    fi
  done <"$TSUB_CONFIG"
  return 0
}

b64_decode_file() {
  key=$1
  output=$2
  case "$key" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  decode_input="${output}.b64.$$"
  decode_output="${output}.decoded.$$"
  sed -n "/^${key}=/ { s/^[^=]*=//; p; q; }" "$TSUB_CONFIG" | tr -d '[:space:]' >"$decode_input"
  [ -s "$decode_input" ] || { rm -f "$decode_input" "$decode_output"; return 1; }
  decoded=false
  if have base64; then
    if base64 -d <"$decode_input" >"$decode_output" 2>/dev/null && [ -s "$decode_output" ]; then decoded=true
    elif base64 --decode <"$decode_input" >"$decode_output" 2>/dev/null && [ -s "$decode_output" ]; then decoded=true
    elif base64 -D <"$decode_input" >"$decode_output" 2>/dev/null && [ -s "$decode_output" ]; then decoded=true
    fi
  fi
  if [ "$decoded" = false ] && have openssl; then
    if openssl base64 -d -A <"$decode_input" >"$decode_output" 2>/dev/null && [ -s "$decode_output" ]; then decoded=true; fi
  fi
  rm -f "$decode_input"
  [ "$decoded" = true ] || { rm -f "$decode_output"; return 1; }
  mv -f "$decode_output" "$output"
  chmod 600 "$output"
}

sha256_file() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif have openssl; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else die "缺少 SHA-256 工具"; fi
}

download_file() {
  download_url=$1
  download_target=$2
  if have curl; then curl -fL --retry 2 --connect-timeout 15 --max-time 600 -o "$download_target" "$download_url"
  elif have wget; then wget -O "$download_target" "$download_url"
  else die "必须预装 curl 或 wget"; fi
}

atomic_install() {
  source_file=$1
  target_file=$2
  mode=${3:-600}
  target_dir=$(dirname "$target_file")
  mkdir -p "$target_dir"
  temp_target="${target_file}.new.$$"
  cp "$source_file" "$temp_target"
  chmod "$mode" "$temp_target"
  mv -f "$temp_target" "$target_file"
}

runtime_action_requires_lock() {
  case "$1" in apply|update|repair|restart|rollback|uninstall) return 0 ;; *) return 1 ;; esac
}

acquire_runtime_operation_lock() {
  runtime_lock_action=$1
  runtime_action_requires_lock "$runtime_lock_action" || return 0
  TSUB_OPERATION_LOCK="$TSUB_STATE/operation.lock"
  TSUB_OPERATION_LOCK_HELD=false
  runtime_lock_wait=${TSUB_OPERATION_LOCK_WAIT_SECONDS:-1800}
  runtime_lock_poll=${TSUB_OPERATION_LOCK_POLL_SECONDS:-2}
  case "$runtime_lock_wait" in ''|*[!0-9]*) runtime_lock_wait=1800 ;; esac
  case "$runtime_lock_poll" in ''|0|*[!0-9]*) runtime_lock_poll=2 ;; esac
  runtime_lock_elapsed=0
  while ! mkdir "$TSUB_OPERATION_LOCK" 2>/dev/null; do
    runtime_lock_pid=$(cat "$TSUB_OPERATION_LOCK/pid" 2>/dev/null || true)
    case "$runtime_lock_pid" in
      ''|*[!0-9]*) runtime_lock_active=false ;;
      *) if kill -0 "$runtime_lock_pid" 2>/dev/null; then runtime_lock_active=true; else runtime_lock_active=false; fi ;;
    esac
    if [ "$runtime_lock_active" = false ]; then
      rm -f "$TSUB_OPERATION_LOCK/pid"
      rmdir "$TSUB_OPERATION_LOCK" 2>/dev/null || true
      continue
    fi
    [ "$runtime_lock_elapsed" -lt "$runtime_lock_wait" ] || die "等待其他 TSub 操作完成超时"
    sleep "$runtime_lock_poll"
    runtime_lock_elapsed=$((runtime_lock_elapsed + runtime_lock_poll))
  done
  printf '%s\n' "$$" >"$TSUB_OPERATION_LOCK/pid"
  TSUB_OPERATION_LOCK_HELD=true
}

release_runtime_operation_lock() {
  [ "${TSUB_OPERATION_LOCK_HELD:-false}" = true ] || return 0
  runtime_lock_pid=$(cat "${TSUB_OPERATION_LOCK:-}/pid" 2>/dev/null || true)
  if [ "$runtime_lock_pid" = "$$" ]; then
    rm -f "$TSUB_OPERATION_LOCK/pid"
    rmdir "$TSUB_OPERATION_LOCK" 2>/dev/null || true
  fi
  TSUB_OPERATION_LOCK_HELD=false
}

cleanup_runtime() {
  release_runtime_operation_lock
  [ -z "${TSUB_DOWNLOAD_PART:-}" ] || rm -f "$TSUB_DOWNLOAD_PART"
  [ -z "${TSUB_TMP:-}" ] || rm -rf "$TSUB_TMP"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/[[:cntrl:]]/ /g'
}

redact_sensitive_stream() {
  sed -E \
    -e 's#([Bb]earer)[[:space:]]+[A-Za-z0-9._~+/-]+#\1 [REDACTED]#g' \
    -e 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+#[REDACTED_URL]#g' \
    -e 's#((token|secret|password|uuid)(_b64)?=)[^[:space:]]+#\1[REDACTED]#g'
}

append_redacted_log() {
  redact_source=$1
  [ -r "$redact_source" ] || return 0
  redact_sensitive_stream <"$redact_source" >>"$TSUB_LOG"
}

sanitize_runtime_log() {
  [ -f "$TSUB_LOG" ] || return 0
  redact_target="$TSUB_TMP/runtime.redacted.$$"
  redact_sensitive_stream <"$TSUB_LOG" >"$redact_target"
  cat "$redact_target" >"$TSUB_LOG"
  rm -f "$redact_target"
}

trim_runtime_log() {
  [ -f "$TSUB_LOG" ] || return 0
  log_size=$(wc -c <"$TSUB_LOG")
  [ "$log_size" -le 262144 ] && return 0
  log_tail="$TSUB_TMP/runtime.tail.$$"
  tail -c 131072 "$TSUB_LOG" >"$log_tail"
  cat "$log_tail" >"$TSUB_LOG"
  rm -f "$log_tail"
}

emit_event() {
  event_status=$1
  event_message=${2:-}
  [ -n "${TSUB_CALLBACK_URL:-}" ] || return 0
  event_file="$TSUB_TMP/event.$$"
  printf 'status=%s\nstage=%s\nmessage=%s\nhostname=%s\nresourceTier=%s\ncontainer=%s\ninit=%s\ntun=%s\nfirewall=%s\n' \
    "$event_status" "${TSUB_STAGE:-bootstrap}" "$event_message" "${TSUB_HOSTNAME:-unknown}" \
    "${TSUB_TIER:-unknown}" "${TSUB_CONTAINER:-unknown}" "${TSUB_INIT:-none}" \
    "${TSUB_HAS_TUN:-false}" "${TSUB_HAS_NET_ADMIN:-false}" >"$event_file"
  printf 'memoryMb=%s\ncgroupLimitMb=%s\nmemoryAvailableMb=%s\nswapReported=%s\nswapTotalMb=%s\nswapFreeMb=%s\nswapUsedMb=%s\ncgroupSwapReported=%s\ncgroupSwapCurrentMb=%s\ncgroupSwapLimitMb=%s\ndiskKb=%s\npidLimit=%s\nrssMb=%s\ncoreRssMb=%s\ncloudflaredRssMb=%s\nestimatedCoreRssMb=%s\nestimatedCloudflaredRssMb=%s\ncoreVersion=%s\nipv6=%s\ntrafficBackend=%s\ndegradedReason=%s\ncontrolCommand=%s\n' \
    "${TSUB_MEMORY_MB:-0}" "${TSUB_MEMORY_MB:-0}" "${TSUB_MEMORY_AVAILABLE_MB:-0}" \
    "${TSUB_SWAP_REPORTED:-false}" "${TSUB_SWAP_TOTAL_MB:-0}" "${TSUB_SWAP_FREE_MB:-0}" "${TSUB_SWAP_USED_MB:-0}" \
    "${TSUB_CGROUP_SWAP_REPORTED:-false}" "${TSUB_CGROUP_SWAP_CURRENT_MB:-0}" "${TSUB_CGROUP_SWAP_LIMIT_MB:-0}" \
    "${TSUB_DISK_KB:-0}" "${TSUB_PID_LIMIT:-unknown}" "${TSUB_CURRENT_RSS:-0}" \
    "${TSUB_CORE_RSS:-0}" "${TSUB_CLOUDFLARED_RSS:-0}" "${TSUB_ESTIMATED_CORE_RSS:-0}" "${TSUB_ESTIMATED_CLOUDFLARED_RSS:-0}" \
    "${TSUB_CORE_VERSION:-unknown}" "${TSUB_HAS_IPV6:-false}" "$(traffic_backend 2>/dev/null || printf unavailable)" "${TSUB_DEGRADED_REASON:-}" "${TSUB_CONTROL_COMMAND_ACTUAL:-}" >>"$event_file"
  subscription_event_ready=false
  if type subscription_append_event >/dev/null 2>&1 && subscription_running 2>/dev/null; then
    subscription_append_event "$event_file"
    subscription_event_ready=true
  fi
  [ "$subscription_event_ready" = true ] || { [ -f "${TSUB_NODES_FILE:-/nonexistent}" ] && sed 's/^/node=/' "$TSUB_NODES_FILE" >>"$event_file"; }
  event_attempt=0; event_sent=false
  while [ "$event_attempt" -lt 6 ]; do
    event_attempt=$((event_attempt + 1))
    if have curl; then
      if curl -fsS --connect-timeout 10 --max-time 30 -X POST -H "Authorization: Bearer $TSUB_CALLBACK_TOKEN" \
        -H 'Content-Type: text/plain' --data-binary "@$event_file" "$TSUB_CALLBACK_URL" >/dev/null 2>&1; then event_sent=true; fi
    elif have wget; then
      if wget -qO- -T 30 --header="Authorization: Bearer $TSUB_CALLBACK_TOKEN" \
        --header='Content-Type: text/plain' --post-file="$event_file" "$TSUB_CALLBACK_URL" >/dev/null 2>&1; then event_sent=true; fi
    fi
    [ "$event_sent" = false ] || break
    [ "$event_attempt" -ge 6 ] || sleep 3
  done
  [ "$event_sent" = true ] || log ERROR "事件回调失败，已重试 $event_attempt 次"
  rm -f "$event_file"
}

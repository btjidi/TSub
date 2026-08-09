#!/bin/sh
# Generated file. Edit runtime/v2/modules/*.sh instead.
TSUB_RUNTIME_VERSION='2.4.25'
# module: 00-common.sh
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

runtime_language() {
  runtime_language_value=$(kv_get runtime_output_language)
  case "$runtime_language_value" in en|en-*) printf en-US ;; *) printf zh-CN ;; esac
}

i18n_text() {
  if [ "$(runtime_language)" = en-US ]; then printf '%s' "$2"; else printf '%s' "$1"; fi
}

i18n_print() { i18n_text "$1" "$2"; printf '\n'; }
i18n_log() { i18n_log_level=$1; shift; log "$i18n_log_level" "$(i18n_text "$1" "$2")"; }
i18n_die() { i18n_die_zh=$1; i18n_die_en=$2; i18n_die_code=${3:-1}; die "$(i18n_text "$i18n_die_zh" "$i18n_die_en")" "$i18n_die_code"; }
i18n_degraded() { add_degraded_reason "$(i18n_text "$1" "$2")"; }

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
  else i18n_die "缺少 SHA-256 工具" "No SHA-256 tool is available"; fi
}

download_file() {
  download_url=$1
  download_target=$2
  download_max_attempts=${TSUB_DOWNLOAD_MAX_ATTEMPTS:-64}
  download_retry_delay=${TSUB_DOWNLOAD_RETRY_DELAY_SECONDS:-1}
  download_attempt_timeout=${TSUB_DOWNLOAD_ATTEMPT_TIMEOUT_SECONDS:-600}
  case "$download_max_attempts" in ''|0|*[!0-9]*) download_max_attempts=64 ;; esac
  case "$download_retry_delay" in ''|*[!0-9]*) download_retry_delay=1 ;; esac
  case "$download_attempt_timeout" in ''|0|*[!0-9]*) download_attempt_timeout=600 ;; esac
  download_attempt=1
  download_resume=true

  while [ "$download_attempt" -le "$download_max_attempts" ]; do
    download_existing=0
    if [ -f "$download_target" ]; then
      download_existing=$(wc -c <"$download_target" 2>/dev/null | tr -d ' ')
      case "$download_existing" in ''|*[!0-9]*) download_existing=0 ;; esac
    fi

    if have curl; then
      if [ "$download_resume" = true ] && [ "$download_existing" -gt 0 ]; then
        if curl -fL --connect-timeout 15 --max-time "$download_attempt_timeout" -C - -o "$download_target" "$download_url"; then return 0; else download_status=$?; fi
      else
        if curl -fL --connect-timeout 15 --max-time "$download_attempt_timeout" -o "$download_target" "$download_url"; then return 0; else download_status=$?; fi
      fi
      case "$download_status" in
        33)
          # The origin rejected Range. Restart future attempts instead of appending incompatible data.
          rm -f "$download_target"
          download_resume=false
          ;;
        5|6|7|18|28|35|52|55|56|92) ;;
        *) return "$download_status" ;;
      esac
    elif have wget; then
      if wget -c -T 15 -t 1 -O "$download_target" "$download_url"; then return 0; else download_status=$?; fi
    else
      i18n_die "必须预装 curl 或 wget" "curl or wget must be installed"
    fi

    [ "$download_attempt" -lt "$download_max_attempts" ] || return "$download_status"
    download_received=0
    if [ -f "$download_target" ]; then
      download_received=$(wc -c <"$download_target" 2>/dev/null | tr -d ' ')
      case "$download_received" in ''|*[!0-9]*) download_received=0 ;; esac
    fi
    if [ "$download_resume" = true ] && [ "$download_received" -gt 0 ]; then
      i18n_print "下载连接中断，已接收 $download_received 字节；将从断点继续（$download_attempt/$download_max_attempts）。" "The download was interrupted after $download_received bytes; resuming from that point ($download_attempt/$download_max_attempts)."
    else
      i18n_print "下载连接中断；正在重试（$download_attempt/$download_max_attempts）。" "The download was interrupted; retrying ($download_attempt/$download_max_attempts)."
    fi
    [ "$download_retry_delay" -eq 0 ] || sleep "$download_retry_delay"
    download_attempt=$((download_attempt + 1))
  done
  return 1
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
    [ "$runtime_lock_elapsed" -lt "$runtime_lock_wait" ] || i18n_die "等待其他 TSub 操作完成超时" "Timed out waiting for another TSub operation"
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
  [ "$event_sent" = true ] || i18n_log ERROR "事件回调失败，已重试 $event_attempt 次" "Event callback failed after $event_attempt attempts"
  rm -f "$event_file"
}

# module: 10-detect.sh
os_release_value() {
  os_release_key=$1
  [ -r "$TSUB_OS_RELEASE_FILE" ] || return 0
  while IFS='=' read -r os_release_name os_release_value_raw; do
    [ "$os_release_name" = "$os_release_key" ] || continue
    case "$os_release_value_raw" in
      \"*\") os_release_value_raw=${os_release_value_raw#\"}; os_release_value_raw=${os_release_value_raw%\"} ;;
      \'*\') os_release_value_raw=${os_release_value_raw#\'}; os_release_value_raw=${os_release_value_raw%\'} ;;
    esac
    printf '%s\n' "$os_release_value_raw"
    return 0
  done <"$TSUB_OS_RELEASE_FILE"
}

bootstrap_memory_limit_mb() {
  bootstrap_limit=''
  if [ -r /sys/fs/cgroup/memory.max ]; then IFS= read -r bootstrap_limit </sys/fs/cgroup/memory.max || bootstrap_limit=''; fi
  if [ "$bootstrap_limit" = max ] || [ -z "$bootstrap_limit" ]; then
    if [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then IFS= read -r bootstrap_limit </sys/fs/cgroup/memory/memory.limit_in_bytes || bootstrap_limit=''; fi
  fi
  case "$bootstrap_limit" in ''|*[!0-9]*) bootstrap_limit='' ;; esac
  bootstrap_host_kb=0
  if [ -r /proc/meminfo ]; then
    while IFS=' :' read -r bootstrap_mem_key bootstrap_mem_value _bootstrap_mem_unit; do
      [ "$bootstrap_mem_key" = MemTotal ] || continue
      case "$bootstrap_mem_value" in ''|*[!0-9]*) bootstrap_mem_value=0 ;; esac
      bootstrap_host_kb=$bootstrap_mem_value
      break
    done </proc/meminfo
  fi
  bootstrap_host_bytes=$((bootstrap_host_kb * 1024))
  [ -n "$bootstrap_limit" ] || bootstrap_limit=$bootstrap_host_bytes
  [ "$bootstrap_host_bytes" -gt 0 ] && [ "$bootstrap_limit" -gt "$bootstrap_host_bytes" ] 2>/dev/null && bootstrap_limit=$bootstrap_host_bytes
  printf '%s\n' $((bootstrap_limit / 1024 / 1024))
}

detect_bootstrap_environment() {
  TSUB_CONTAINER=bare
  [ -f /.dockerenv ] && TSUB_CONTAINER=docker
  [ -f /run/.containerenv ] && TSUB_CONTAINER=podman
  if [ -r /proc/1/cgroup ]; then
    while IFS= read -r bootstrap_cgroup_line; do
      case "$bootstrap_cgroup_line" in *lxc*) TSUB_CONTAINER=lxc ;; *docker*) TSUB_CONTAINER=docker ;; esac
    done </proc/1/cgroup
  fi
  if [ -r /proc/version ]; then
    IFS= read -r bootstrap_kernel </proc/version || bootstrap_kernel=''
    case "$bootstrap_kernel" in *[Oo]pen[Vv][Zz]*) TSUB_CONTAINER=openvz ;; esac
  fi
  TSUB_INIT=none
  [ -d /run/systemd/system ] && have systemctl && TSUB_INIT=systemd
  [ "$TSUB_INIT" = none ] && have rc-service && TSUB_INIT=openrc
  [ "$TSUB_INIT" = none ] && have sv && TSUB_INIT=runit
  [ "$TSUB_INIT" = none ] && have s6-svc && TSUB_INIT=s6
  [ "$TSUB_INIT" = none ] && [ -w /etc/rc.local ] && TSUB_INIT=rc-local
  [ "$TSUB_INIT" = none ] && have crontab && TSUB_INIT='crontab'
  TSUB_BOOTSTRAP_MEMORY_MB=$(bootstrap_memory_limit_mb)
  if [ "$TSUB_BOOTSTRAP_MEMORY_MB" -le 96 ]; then TSUB_BOOTSTRAP_TIER=tiny
  elif [ "$TSUB_BOOTSTRAP_MEMORY_MB" -le 192 ]; then TSUB_BOOTSTRAP_TIER=small
  else TSUB_BOOTSTRAP_TIER=standard; fi
}

detect_system_identity() {
  TSUB_ARCH=$(uname -m 2>/dev/null || printf unknown)
  case "$TSUB_ARCH" in
    x86_64|amd64) TSUB_ARCH=amd64 ;;
    aarch64|arm64) TSUB_ARCH=arm64 ;;
    *) i18n_die "不支持的 CPU 架构: $TSUB_ARCH" "Unsupported CPU architecture: $TSUB_ARCH" ;;
  esac

  TSUB_OS_RELEASE_FILE=${TSUB_OS_RELEASE_FILE:-/etc/os-release}
  TSUB_OS=$(os_release_value ID); TSUB_OS=${TSUB_OS:-unknown}
  TSUB_OS_VERSION=$(os_release_value VERSION_ID); TSUB_OS_VERSION=${TSUB_OS_VERSION:-unknown}
  TSUB_OS_PRETTY=$(os_release_value PRETTY_NAME); TSUB_OS_PRETTY=${TSUB_OS_PRETTY:-$TSUB_OS}
  TSUB_OS_LIKE=$(os_release_value ID_LIKE)
  TSUB_OS_VERIFIED=true
  case "$TSUB_OS" in
    alpine) TSUB_OS_FAMILY=alpine ;;
    debian|ubuntu) TSUB_OS_FAMILY=debian ;;
    rhel|rocky|almalinux|fedora) TSUB_OS_FAMILY=rhel ;;
    *)
      case " $TSUB_OS_LIKE " in
        *" alpine "*) TSUB_OS_FAMILY=alpine ;;
        *" debian "*|*" ubuntu "*) TSUB_OS_FAMILY=debian ;;
        *" rhel "*|*" fedora "*|*" centos "*) TSUB_OS_FAMILY=rhel ;;
        *) TSUB_OS_FAMILY=unknown ;;
      esac
      TSUB_OS_VERIFIED=false
      ;;
  esac
  i18n_print "系统类型：$TSUB_OS_PRETTY（ID=$TSUB_OS，版本=$TSUB_OS_VERSION）" "System: $TSUB_OS_PRETTY (ID=$TSUB_OS, version=$TSUB_OS_VERSION)"
  i18n_print "CPU 架构：$TSUB_ARCH" "CPU architecture: $TSUB_ARCH"
  [ "$TSUB_OS_VERIFIED" = true ] || i18n_print "系统兼容性：未验证，将按 $TSUB_OS_FAMILY 系兼容能力处理" "System compatibility is unverified; using $TSUB_OS_FAMILY-compatible behavior"
  if [ "$TSUB_OS_FAMILY" = rhel ]; then
    TSUB_SELINUX_MODE=unavailable
    if have getenforce; then TSUB_SELINUX_MODE=$(getenforce 2>/dev/null || printf unknown); fi
    i18n_print "SELinux：$TSUB_SELINUX_MODE；Enforcing 模式下服务启动失败时请检查审计日志" "SELinux: $TSUB_SELINUX_MODE; check the audit log if service startup fails in Enforcing mode"
  fi
  detect_bootstrap_environment
  i18n_print "运行环境：$TSUB_CONTAINER；init：$TSUB_INIT" "Environment: $TSUB_CONTAINER; init: $TSUB_INIT"
  i18n_print "初步资源档位：$TSUB_BOOTSTRAP_TIER；内存限制：${TSUB_BOOTSTRAP_MEMORY_MB}MB" "Initial resource tier: $TSUB_BOOTSTRAP_TIER; memory limit: ${TSUB_BOOTSTRAP_MEMORY_MB}MB"
}

detect_platform_capabilities() {

  TSUB_CONTAINER=bare
  [ -f /.dockerenv ] && TSUB_CONTAINER=docker
  [ -f /run/.containerenv ] && TSUB_CONTAINER=podman
  if [ -r /proc/1/environ ] && tr '\000' '\n' </proc/1/environ 2>/dev/null | grep -q '^container=lxc'; then TSUB_CONTAINER=lxc; fi
  grep -qi openvz /proc/version 2>/dev/null && TSUB_CONTAINER=openvz

  TSUB_INIT=none
  [ -d /run/systemd/system ] && have systemctl && TSUB_INIT=systemd
  [ "$TSUB_INIT" = none ] && have rc-service && TSUB_INIT=openrc
  [ "$TSUB_INIT" = none ] && have sv && TSUB_INIT=runit
  [ "$TSUB_INIT" = none ] && have s6-svc && TSUB_INIT=s6
  [ "$TSUB_INIT" = none ] && [ -w /etc/rc.local ] && TSUB_INIT=rc-local
  [ "$TSUB_INIT" = none ] && have crontab && TSUB_INIT='crontab'

  TSUB_HAS_TUN=false
  [ -c /dev/net/tun ] && TSUB_HAS_TUN=true
  TSUB_HAS_IPV6=false
  [ -s /proc/net/if_inet6 ] && TSUB_HAS_IPV6=true
  TSUB_HAS_NET_ADMIN=false
  if [ -r /proc/self/status ]; then
    cap=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)
    net_admin_nibble=$(printf '%s' "$cap" | sed -n 's/.*\([0-9a-fA-F]\)[0-9a-fA-F]\{3\}$/\1/p')
    case "$net_admin_nibble" in 1|3|5|7|9|b|B|d|D|f|F) TSUB_HAS_NET_ADMIN=true ;; esac
  fi
  TSUB_HOSTNAME=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-120 || printf unknown)
}

memory_limit_bytes() {
  limit=''
  [ -r /sys/fs/cgroup/memory.max ] && limit=$(cat /sys/fs/cgroup/memory.max)
  [ "$limit" = max ] && limit=''
  [ -z "$limit" ] && [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ] && limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
  case "$limit" in ''|*[!0-9]*) limit='' ;; esac
  host=$(awk '/MemTotal:/ {print $2 * 1024; exit}' /proc/meminfo 2>/dev/null || printf 0)
  [ -z "$limit" ] && limit=$host
  [ "$limit" -gt "$host" ] 2>/dev/null && [ "$host" -gt 0 ] && limit=$host
  printf '%.0f\n' "$limit"
}

detect_swap_resources() {
  swap_meminfo=${TSUB_PROC_MEMINFO:-/proc/meminfo}
  swap_cgroup_root=${TSUB_CGROUP_ROOT:-/sys/fs/cgroup}
  swap_total_kb=$(awk '/^SwapTotal:/ {print $2; exit}' "$swap_meminfo" 2>/dev/null || printf 0)
  swap_free_kb=$(awk '/^SwapFree:/ {print $2; exit}' "$swap_meminfo" 2>/dev/null || printf 0)
  case "$swap_total_kb" in ''|*[!0-9]*) swap_total_kb=0 ;; esac
  case "$swap_free_kb" in ''|*[!0-9]*) swap_free_kb=0 ;; esac
  [ "$swap_free_kb" -le "$swap_total_kb" ] || swap_free_kb=$swap_total_kb
  TSUB_SWAP_REPORTED=false
  [ -r "$swap_meminfo" ] && TSUB_SWAP_REPORTED=true
  TSUB_SWAP_TOTAL_MB=$((swap_total_kb / 1024))
  TSUB_SWAP_FREE_MB=$((swap_free_kb / 1024))
  TSUB_SWAP_USED_MB=$(((swap_total_kb - swap_free_kb) / 1024))

  TSUB_CGROUP_SWAP_REPORTED=false
  TSUB_CGROUP_SWAP_CURRENT_MB=0
  TSUB_CGROUP_SWAP_LIMIT_MB=0
  if [ -r "$swap_cgroup_root/memory.swap.current" ]; then
    TSUB_CGROUP_SWAP_REPORTED=true
    swap_current=$(cat "$swap_cgroup_root/memory.swap.current" 2>/dev/null || printf 0)
    swap_limit=$(cat "$swap_cgroup_root/memory.swap.max" 2>/dev/null || printf max)
    case "$swap_current" in ''|*[!0-9]*) swap_current=0 ;; esac
    TSUB_CGROUP_SWAP_CURRENT_MB=$((swap_current / 1024 / 1024))
    if [ "$swap_limit" = max ]; then TSUB_CGROUP_SWAP_LIMIT_MB=-1
    else
      case "$swap_limit" in ''|*[!0-9]*) swap_limit=0 ;; esac
      TSUB_CGROUP_SWAP_LIMIT_MB=$((swap_limit / 1024 / 1024))
    fi
  elif [ -r "$swap_cgroup_root/memory/memory.memsw.usage_in_bytes" ]; then
    TSUB_CGROUP_SWAP_REPORTED=true
    swap_memsw_current=$(cat "$swap_cgroup_root/memory/memory.memsw.usage_in_bytes" 2>/dev/null || printf 0)
    swap_memory_current=$(cat "$swap_cgroup_root/memory/memory.usage_in_bytes" 2>/dev/null || printf 0)
    swap_memsw_limit=$(cat "$swap_cgroup_root/memory/memory.memsw.limit_in_bytes" 2>/dev/null || printf 0)
    swap_memory_limit=$(cat "$swap_cgroup_root/memory/memory.limit_in_bytes" 2>/dev/null || printf 0)
    swap_value=''
    for swap_value_name in swap_memsw_current swap_memory_current swap_memsw_limit swap_memory_limit; do
      eval "swap_value=\${$swap_value_name}"
      case "$swap_value" in ''|*[!0-9]*) eval "$swap_value_name=0" ;; esac
    done
    if [ "$swap_memsw_current" -ge "$swap_memory_current" ]; then
      TSUB_CGROUP_SWAP_CURRENT_MB=$(((swap_memsw_current - swap_memory_current) / 1024 / 1024))
    fi
    if [ "$swap_memsw_limit" -ge 1152921504606846976 ]; then TSUB_CGROUP_SWAP_LIMIT_MB=-1
    elif [ "$swap_memsw_limit" -ge "$swap_memory_limit" ]; then
      TSUB_CGROUP_SWAP_LIMIT_MB=$(((swap_memsw_limit - swap_memory_limit) / 1024 / 1024))
    fi
  fi
}

detect_resources() {
  TSUB_MEMORY_BYTES=$(memory_limit_bytes)
  TSUB_MEMORY_MB=$((TSUB_MEMORY_BYTES / 1024 / 1024))
  host_available_kb=$(awk '/MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null || printf 0)
  cgroup_current=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || printf 0)
  case "$cgroup_current" in ''|*[!0-9]*) cgroup_current=0 ;; esac
  cgroup_reclaimable=$(awk '$1 == "inactive_file" { print $2; exit }' /sys/fs/cgroup/memory.stat 2>/dev/null || printf 0)
  [ -n "$cgroup_reclaimable" ] || cgroup_reclaimable=$(awk '$1 == "total_inactive_file" { print $2; exit }' /sys/fs/cgroup/memory/memory.stat 2>/dev/null || printf 0)
  case "$cgroup_reclaimable" in ''|*[!0-9]*) cgroup_reclaimable=0 ;; esac
  cgroup_working_set=$((cgroup_current - cgroup_reclaimable)); [ "$cgroup_working_set" -lt 0 ] && cgroup_working_set=0
  cgroup_available=$((TSUB_MEMORY_BYTES - cgroup_working_set)); [ "$cgroup_available" -lt 0 ] && cgroup_available=0
  cgroup_raw_available=$((TSUB_MEMORY_BYTES - cgroup_current)); [ "$cgroup_raw_available" -lt 0 ] && cgroup_raw_available=0
  host_available=$((host_available_kb * 1024))
  TSUB_MEMORY_AVAILABLE_BYTES=$cgroup_available
  if [ "$TSUB_MEMORY_MB" -le 96 ] && [ "$cgroup_raw_available" -lt "$TSUB_MEMORY_AVAILABLE_BYTES" ]; then
    TSUB_MEMORY_AVAILABLE_BYTES=$cgroup_raw_available
  fi
  [ "$host_available" -gt 0 ] && [ "$host_available" -lt "$TSUB_MEMORY_AVAILABLE_BYTES" ] && TSUB_MEMORY_AVAILABLE_BYTES=$host_available
  TSUB_MEMORY_AVAILABLE_MB=$((TSUB_MEMORY_AVAILABLE_BYTES / 1024 / 1024))
  # shellcheck disable=SC2034 # consumed by heartbeat/event modules after sourcing
  TSUB_MEMORY_RAW_AVAILABLE_MB=$((cgroup_raw_available / 1024 / 1024))
  detect_swap_resources
  if [ "$TSUB_MEMORY_MB" -le 96 ]; then TSUB_TIER=tiny
  elif [ "$TSUB_MEMORY_MB" -le 192 ]; then TSUB_TIER=small
  else TSUB_TIER=standard; fi
  TSUB_DETECTED_TIER=$TSUB_TIER
  requested=$(kv_get runtime_tier)
  case "$requested" in
    tiny) TSUB_TIER=tiny ;;
    small)
      if [ "$TSUB_DETECTED_TIER" = tiny ]; then [ "$(kv_get runtime_confirm_higher_tier)" = true ] || i18n_die "提高资源档位需要二次确认" "Increasing the resource tier requires confirmation"; fi
      TSUB_TIER=small
      ;;
    standard)
      if [ "$TSUB_DETECTED_TIER" != standard ]; then [ "$(kv_get runtime_confirm_higher_tier)" = true ] || i18n_die "提高资源档位需要二次确认" "Increasing the resource tier requires confirmation"; fi
      TSUB_TIER=standard
      ;;
    '') : ;;
    *) i18n_die "未知资源档位: $requested" "Unknown resource tier: $requested" ;;
  esac
  TSUB_DISK_KB=$(df -Pk "$TSUB_STATE" 2>/dev/null | awk 'NR==2 {print $4}' || printf 0)
  TSUB_PID_LIMIT=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || printf unknown)
  i18n_print "资源复核：$TSUB_TIER；内存限制：${TSUB_MEMORY_MB}MB；当前可用：${TSUB_MEMORY_AVAILABLE_MB}MB；Swap：${TSUB_SWAP_USED_MB}/${TSUB_SWAP_TOTAL_MB}MB" "Resource check: $TSUB_TIER; memory limit: ${TSUB_MEMORY_MB}MB; available: ${TSUB_MEMORY_AVAILABLE_MB}MB; Swap: ${TSUB_SWAP_USED_MB}/${TSUB_SWAP_TOTAL_MB}MB"
}

# module: 15-dependencies.sh
dependency_add_missing() {
  dependency_name=$1
  case " ${TSUB_MISSING_DEPENDENCIES:-} " in *" $dependency_name "*) : ;; *) TSUB_MISSING_DEPENDENCIES="${TSUB_MISSING_DEPENDENCIES:+$TSUB_MISSING_DEPENDENCIES }$dependency_name" ;; esac
}

dependency_add_package() {
  dependency_package=$1
  case " ${TSUB_REQUIRED_PACKAGES:-} " in *" $dependency_package "*) : ;; *) TSUB_REQUIRED_PACKAGES="${TSUB_REQUIRED_PACKAGES:+$TSUB_REQUIRED_PACKAGES }$dependency_package" ;; esac
}

dependency_package_for_command() {
  dependency_command=$1
  case "$TSUB_OS_FAMILY:$dependency_command" in
    alpine:curl) printf curl ;; alpine:ss) printf iproute2 ;; alpine:nft) printf nftables ;; alpine:openssl) printf openssl ;;
    alpine:ca-certificates) printf ca-certificates ;; alpine:*) printf busybox ;;
    debian:curl) printf curl ;; debian:ss) printf iproute2 ;; debian:nft) printf nftables ;; debian:openssl) printf openssl ;;
    debian:ca-certificates) printf ca-certificates ;; debian:awk) printf mawk ;; debian:sed) printf sed ;; debian:grep) printf grep ;; debian:find) printf findutils ;;
    debian:hostname) printf hostname ;; debian:tar) printf tar ;; debian:gzip) printf gzip ;; debian:*) printf coreutils ;;
    rhel:curl) printf curl ;; rhel:ss) printf iproute ;; rhel:nft) printf nftables ;; rhel:openssl) printf openssl ;;
    rhel:ca-certificates) printf ca-certificates ;; rhel:awk) printf gawk ;; rhel:sed) printf sed ;; rhel:grep) printf grep ;; rhel:find) printf findutils ;;
    rhel:hostname) printf hostname ;; rhel:tar) printf tar ;; rhel:gzip) printf gzip ;; rhel:*) printf coreutils ;;
    *) return 1 ;;
  esac
}

dependency_package_for_scheduler() {
  case "$TSUB_OS_FAMILY" in
    alpine) printf dcron ;;
    debian) printf cron ;;
    rhel) printf cronie ;;
    *) return 1 ;;
  esac
}

scheduler_is_running() {
  if [ "${TSUB_INIT:-none}" = systemd ] && have systemctl; then
    systemctl is-active --quiet cron.service 2>/dev/null && return 0
    systemctl is-active --quiet crond.service 2>/dev/null && return 0
  fi
  if have rc-service; then
    rc-service dcron status >/dev/null 2>&1 && return 0
    rc-service cron status >/dev/null 2>&1 && return 0
    rc-service crond status >/dev/null 2>&1 && return 0
  fi
  if have pidof; then
    pidof cron >/dev/null 2>&1 && return 0
    pidof crond >/dev/null 2>&1 && return 0
  fi
  return 1
}

dependency_require_command() {
  dependency_command=$1
  have "$dependency_command" && return 0
  dependency_add_missing "$dependency_command"
  dependency_package=$(dependency_package_for_command "$dependency_command" 2>/dev/null || true)
  [ -z "$dependency_package" ] || dependency_add_package "$dependency_package"
}

dependency_ca_available() {
  [ -s /etc/ssl/certs/ca-certificates.crt ] || [ -s /etc/pki/tls/certs/ca-bundle.crt ] || [ -s /etc/ssl/cert.pem ]
}

dependency_glibc_loader_available() {
  case "$TSUB_ARCH" in
    amd64) [ -e /lib64/ld-linux-x86-64.so.2 ] || [ -e /lib/ld-linux-x86-64.so.2 ] ;;
    arm64) [ -e /lib/ld-linux-aarch64.so.1 ] || [ -e /lib64/ld-linux-aarch64.so.1 ] ;;
    *) return 1 ;;
  esac
}

detect_required_dependencies() {
  dependency_action=$1
  TSUB_MISSING_DEPENDENCIES=''; TSUB_REQUIRED_PACKAGES=''
  for dependency_command in cat awk sed grep cut tr df mktemp tail wc find nohup hostname readlink; do dependency_require_command "$dependency_command"; done
  if ! have base64 && ! have openssl; then dependency_add_missing base64; dependency_add_package "$(dependency_package_for_command base64 2>/dev/null || printf coreutils)"; fi
  if ! have sha256sum && ! have shasum && ! have openssl; then dependency_add_missing sha256; dependency_add_package "$(dependency_package_for_command sha256sum 2>/dev/null || printf coreutils)"; fi
  case "$dependency_action" in
    plan|apply|update|repair|edge-probe)
      if ! have curl && ! have wget; then dependency_add_missing downloader; dependency_add_package "$(dependency_package_for_command curl 2>/dev/null || printf curl)"; fi
      if [ "$dependency_action" = edge-probe ] && ! have curl; then dependency_add_missing curl; dependency_add_package "$(dependency_package_for_command curl 2>/dev/null || printf curl)"; fi
      if [ -n "$(kv_get agent_token_b64)" ] && ! have curl; then dependency_add_missing curl; dependency_add_package "$(dependency_package_for_command curl 2>/dev/null || printf curl)"; fi
      dependency_ca_available || { dependency_add_missing ca-certificates; dependency_add_package "$(dependency_package_for_command ca-certificates 2>/dev/null || printf ca-certificates)"; }
      [ "$(kv_get certificate_mode)" != self-signed ] || dependency_require_command openssl
      dependency_require_command ss
      core_name=$(kv_get runtime_core)
      if [ "$(kv_get "${core_name}_${TSUB_ARCH}_format")" = tar.gz ]; then
        dependency_require_command tar
        dependency_require_command gzip
      fi
      if [ "$TSUB_OS_FAMILY" = alpine ] && [ "$core_name" = sing-box ] \
        && ! dependency_glibc_loader_available; then
        dependency_add_missing glibc-compat
        dependency_add_package gcompat
      fi
      if [ -n "$(kv_get udp_hop_rules)" ] && ! have nft && ! have iptables; then dependency_add_missing nft; dependency_add_package "$(dependency_package_for_command nft 2>/dev/null || printf nftables)"; fi
      if [ "$(kv_get push_enabled)" = true ] && [ -n "$(kv_get push_url)" ] && [ "${TSUB_INIT:-none}" != systemd ] && ! have crontab; then
        dependency_add_missing cron
        dependency_add_package "$(dependency_package_for_scheduler 2>/dev/null || printf cron)"
      fi
      ;;
  esac
}

dependency_package_manager() {
  case "$TSUB_OS_FAMILY" in
    alpine) have apk && { printf apk; return 0; } ;;
    debian) have apt-get && { printf apt-get; return 0; } ;;
    rhel) have dnf && { printf dnf; return 0; }; have yum && { printf yum; return 0; } ;;
  esac
  return 1
}

dependency_run() {
  if [ "$TSUB_DEPENDENCY_USE_SUDO" = true ]; then sudo -n "$@"; else "$@"; fi
}

install_required_dependencies_once() {
  dependency_manager=$1
  case "$dependency_manager" in
    apk) dependency_run apk add --no-cache $TSUB_REQUIRED_PACKAGES ;;
    apt-get)
      dependency_install_status=0
      if [ "$TSUB_DEPENDENCY_USE_SUDO" = true ]; then
        sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $TSUB_REQUIRED_PACKAGES || dependency_install_status=$?
      else
        DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $TSUB_REQUIRED_PACKAGES || dependency_install_status=$?
      fi
      have apt-get && dependency_run apt-get clean >/dev/null 2>&1 || true
      return "$dependency_install_status"
      ;;
    dnf) dependency_run dnf install -y --setopt=install_weak_deps=False --setopt=keepcache=False $TSUB_REQUIRED_PACKAGES ;;
    yum) dependency_run yum install -y --setopt=install_weak_deps=False --setopt=keepcache=False $TSUB_REQUIRED_PACKAGES ;;
    *) return 1 ;;
  esac
}

ensure_dependencies() {
  dependency_action=$1
  detect_required_dependencies "$dependency_action"
  if [ -z "$TSUB_MISSING_DEPENDENCIES" ]; then
    i18n_print '依赖检查：已满足当前操作所需能力，无需安装' 'Dependency check: all capabilities required for this operation are available; nothing to install'
    return 0
  fi
  i18n_print "依赖检查：缺少 $TSUB_MISSING_DEPENDENCIES" "Dependency check: missing $TSUB_MISSING_DEPENDENCIES"
  if [ "$dependency_action" = plan ]; then
    i18n_print "计划模式不会修改系统；建议安装软件包：${TSUB_REQUIRED_PACKAGES:-无法自动映射}" "Plan mode will not modify the system; suggested packages: ${TSUB_REQUIRED_PACKAGES:-no automatic mapping available}"
    return 2
  fi
  case "$dependency_action" in apply|update|repair) : ;; *) i18n_print '当前操作不会自动安装依赖' 'This operation does not install dependencies automatically'; return 2 ;; esac
  dependency_manager=$(dependency_package_manager 2>/dev/null || true)
  [ -n "$dependency_manager" ] || { i18n_print "无法为该系统选择受支持的包管理器；请手动补齐：$TSUB_MISSING_DEPENDENCIES" "No supported package manager is available for this system; install manually: $TSUB_MISSING_DEPENDENCIES" >&2; return 2; }
  TSUB_DEPENDENCY_USE_SUDO=false
  if [ "$(id -u)" -ne 0 ]; then
    if have sudo && sudo -n true >/dev/null 2>&1; then TSUB_DEPENDENCY_USE_SUDO=true
    else i18n_print "无法无交互提权。请安装：$TSUB_REQUIRED_PACKAGES" "Cannot elevate privileges non-interactively. Install: $TSUB_REQUIRED_PACKAGES" >&2; return 2; fi
  fi
  i18n_print "依赖安装：使用 $dependency_manager 最小化安装 $TSUB_REQUIRED_PACKAGES" "Dependency installation: using $dependency_manager to minimally install $TSUB_REQUIRED_PACKAGES"
  dependency_attempt=1
  while ! install_required_dependencies_once "$dependency_manager"; do
    [ "$dependency_attempt" -lt 2 ] || { i18n_print '依赖安装失败' 'Dependency installation failed' >&2; return 2; }
    dependency_attempt=$((dependency_attempt + 1))
    i18n_print '依赖安装失败，正在进行最后一次重试' 'Dependency installation failed; making one final attempt' >&2
  done
  detect_required_dependencies "$dependency_action"
  [ -z "$TSUB_MISSING_DEPENDENCIES" ] || { i18n_print "依赖安装后仍缺少：$TSUB_MISSING_DEPENDENCIES" "Still missing after dependency installation: $TSUB_MISSING_DEPENDENCIES" >&2; return 2; }
  i18n_print '依赖安装：完成' 'Dependency installation completed'
}

# module: 20-plan.sh
provider_budget() {
  case "$1" in
    xray) budget_rss=42; budget_install_rss=18; budget_binary_mb=38 ;;
    sing-box) budget_rss=44; budget_install_rss=20; budget_binary_mb=35 ;;
    naive) budget_rss=38; budget_install_rss=18; budget_binary_mb=25 ;;
    cloudflared) budget_rss=45; budget_install_rss=25; budget_binary_mb=35 ;;
    *) return 1 ;;
  esac
}

confirm_low_memory_install() {
  install_warning_zh=$1
  install_warning_en=$2
  install_warning=$(i18n_text "$install_warning_zh" "$install_warning_en")
  [ "${TSUB_FORCE_LOW_MEMORY_INSTALL:-false}" != true ] || return 0
  confirmation_input=${TSUB_CONFIRM_INPUT:-/dev/tty}
  confirmation_output=${TSUB_CONFIRM_OUTPUT:-/dev/tty}
  if [ ! -r "$confirmation_input" ] || [ ! -w "$confirmation_output" ]; then
    i18n_die "$install_warning_zh；当前为非交互执行，无法确认强制安装" "$install_warning_en; forced installation cannot be confirmed in non-interactive mode"
  fi
  printf '%s\n' "$install_warning" >"$confirmation_output"
  i18n_text '继续可能触发 OOM 并导致安装回滚。输入 Y 强制安装，其他输入取消：' 'Continuing may trigger OOM and roll back the installation. Enter Y to force installation; any other input cancels: ' >>"$confirmation_output"
  install_confirmation=''
  IFS= read -r install_confirmation <"$confirmation_input" || true
  case "$install_confirmation" in
    y|Y)
      TSUB_FORCE_LOW_MEMORY_INSTALL=true
      i18n_degraded "用户已确认低内存强制安装" "Low-memory forced installation was confirmed"
      i18n_log WARN "用户已确认低内存强制安装；继续执行" "Low-memory forced installation confirmed; continuing"
      ;;
    *) i18n_die "$install_warning_zh；用户未确认强制安装" "$install_warning_en; forced installation was not confirmed" ;;
  esac
}

require_install_headroom() {
  install_reserve=12
  if [ "$TSUB_MEMORY_MB" -le 96 ]; then
    install_reserve=16
    [ "$(kv_get "${core}_${TSUB_ARCH}_format")" != tar.gz ] || install_reserve=24
    [ "$TSUB_MEMORY_MB" -gt 64 ] || [ "$(kv_get "${core}_${TSUB_ARCH}_format")" != tar.gz ] || install_reserve=40
  fi
  install_required=$((install_rss + install_reserve))
  if [ "$TSUB_MEMORY_AVAILABLE_MB" -lt "$install_required" ]; then
    if [ "$TSUB_MEMORY_MB" -le 64 ] && [ "$(kv_get "${core}_${TSUB_ARCH}_format")" = tar.gz ]; then
      install_warning_zh="64MB 节点不能安全解包 $core；建议改用经过 SHA-256 校验的预解包 binary 资产"
      install_warning_en="A 64MB node cannot safely unpack $core; use a pre-extracted binary asset verified with SHA-256"
    else
      install_warning_zh="当前可用内存 ${TSUB_MEMORY_AVAILABLE_MB}MB 不足以安全安装；需要至少 ${install_required}MB 可用内存"
      install_warning_en="${TSUB_MEMORY_AVAILABLE_MB}MB of available memory is insufficient for safe installation; at least ${install_required}MB is required"
    fi
    confirm_low_memory_install "$install_warning_zh" "$install_warning_en"
  fi
}

planned_core_is_installed() {
  planned_version=$(kv_get "${core}_version")
  planned_sha=$(kv_get "${core}_${TSUB_ARCH}_binary_sha256")
  [ -n "$planned_sha" ] || planned_sha=$(kv_get "${core}_${TSUB_ARCH}_sha256")
  [ -n "$planned_version" ] && [ -n "$planned_sha" ] || return 1
  planned_target="$TSUB_BIN/$core-$planned_version-$TSUB_ARCH-$planned_sha"
  [ -x "$planned_target" ] && [ "$(sha256_file "$planned_target")" = "$planned_sha" ]
}

plan_runtime() {
  TSUB_STAGE=plan
  core=$(kv_get runtime_core)
  case "$core" in xray|sing-box|naive) : ;; *) i18n_die "配置未选择受支持的主核心" "No supported primary core is selected" ;; esac
  inbound_count=$(kv_get inbound_count)
  case "$inbound_count" in ''|*[!0-9]*) i18n_die "inbound_count 无效" "Invalid inbound_count" ;; esac
  [ "$inbound_count" -gt 0 ] || i18n_die "至少需要一个入站" "At least one inbound is required"
  provider_budget "$core"
  estimated_rss=$budget_rss
  TSUB_ESTIMATED_CORE_RSS=$budget_rss
  TSUB_ESTIMATED_CLOUDFLARED_RSS=0
  install_rss=$budget_install_rss
  binary_mb=$budget_binary_mb
  tunnels=$(kv_get tunnel_count); tunnels=${tunnels:-0}
  if [ "$tunnels" -gt 0 ]; then
    [ "$TSUB_TIER" != tiny ] || i18n_die "tiny 档默认拒绝 cloudflared；请使用核心内协议或提高资源" "The tiny tier does not allow cloudflared by default; use a core-native protocol or increase resources"
    [ "$TSUB_MEMORY_MB" -ge 128 ] || i18n_log WARN "隧道建议服务器 cgroup 内存上限至少为 128MB；当前为 ${TSUB_MEMORY_MB}MB" "Tunnels should have a cgroup memory limit of at least 128MB; current limit is ${TSUB_MEMORY_MB}MB"
    estimated_rss=$((estimated_rss + 45))
    TSUB_ESTIMATED_CLOUDFLARED_RSS=45
    binary_mb=$((binary_mb + 35))
  fi
  if [ "$(kv_get subscription_server_enabled)" = true ]; then
    estimated_rss=$((estimated_rss + 2))
    binary_mb=$((binary_mb + 2))
  fi
  certificate_mode=$(kv_get certificate_mode)
  case "$certificate_mode" in existing|self-signed) : ;; *) binary_mb=$((binary_mb + 20)) ;; esac
  [ $((estimated_rss * 100)) -le $((TSUB_MEMORY_MB * 80)) ] || i18n_die "预计常驻内存 ${estimated_rss}MB 超过 cgroup 80% 预算" "Estimated resident memory ${estimated_rss}MB exceeds 80% of the cgroup budget"
  required_kb=$((binary_mb * 2 * 1024 + 8192))
  [ "$TSUB_DISK_KB" -ge "$required_kb" ] || i18n_die "磁盘不足：至少需要 ${required_kb}KB 可用空间" "Insufficient disk space: at least ${required_kb}KB is required"
  [ "$TSUB_MEMORY_MB" -ge 56 ] || i18n_die "低于 56MB 的内存限制不受支持" "Memory limits below 56MB are not supported"
  planned_core_is_installed || require_install_headroom
  case "$TSUB_PID_LIMIT" in
    ''|max|*[!0-9]*) : ;;
    *) required_pids=$((12 + tunnels * 4)); [ "$TSUB_PID_LIMIT" -ge "$required_pids" ] || i18n_die "PID 上限 $TSUB_PID_LIMIT 低于所需 $required_pids" "PID limit $TSUB_PID_LIMIT is below the required $required_pids" ;;
  esac
  if [ "$(id -u)" -ne 0 ]; then
    old_ifs=$IFS; IFS=,
    for port_spec in $(kv_get inbound_ports); do
      port_number=${port_spec%/*}
      if [ "$port_number" -lt 1024 ]; then IFS=$old_ifs; i18n_die "无特权模式不能绑定低于 1024 的端口" "Unprivileged mode cannot bind ports below 1024"; fi
    done
    IFS=$old_ifs
  fi
  if [ "$(kv_get firewall_enabled)" = true ] && [ "$TSUB_TIER" = tiny ]; then
    i18n_degraded "tiny 档已跳过端口放行规则" "Port allow rules were skipped on the tiny tier"
    i18n_log WARN "tiny 档自动跳过端口放行规则" "Port allow rules were automatically skipped on the tiny tier"
  elif [ "$(kv_get firewall_enabled)" = true ] && [ "$TSUB_HAS_NET_ADMIN" != true ]; then
    i18n_degraded "缺少 CAP_NET_ADMIN，已跳过端口放行规则" "Port allow rules were skipped because CAP_NET_ADMIN is unavailable"
    i18n_log WARN "缺少 CAP_NET_ADMIN，已跳过端口放行规则" "Port allow rules were skipped because CAP_NET_ADMIN is unavailable"
  fi
  if [ -n "$(kv_get udp_hop_rules)" ]; then
    [ "$TSUB_HAS_NET_ADMIN" = true ] || i18n_die "Hysteria2 端口跳跃需要 CAP_NET_ADMIN" "Hysteria2 port hopping requires CAP_NET_ADMIN"
    [ "$(id -u)" -eq 0 ] || i18n_die "Hysteria2 端口跳跃需要 root 权限" "Hysteria2 port hopping requires root"
    have nft || have iptables || i18n_die "Hysteria2 端口跳跃需要 nftables 或 iptables" "Hysteria2 port hopping requires nftables or iptables"
  fi
  if [ "$(kv_get warp_backend)" = tun ] && [ "$TSUB_HAS_TUN" != true ]; then
    i18n_die "配置要求 TUN WARP，但 /dev/net/tun 不可用" "The configuration requires TUN WARP, but /dev/net/tun is unavailable"
  fi
  if [ ! -f "$TSUB_ETC/config.json" ] && have ss; then
    old_ifs=$IFS; IFS=,
    for port_spec in $(kv_get inbound_ports); do
      port_number=${port_spec%/*}
      if ss -lntu 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]${port_number}$"; then
        IFS=$old_ifs
        i18n_die "端口 $port_number 已被占用" "Port $port_number is already in use"
      fi
    done
    IFS=$old_ifs
    subscription_port=$(kv_get subscription_server_port)
    if [ -n "$subscription_port" ] && ss -lntu 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]${subscription_port}$"; then
      i18n_die "订阅端口 $subscription_port 已被占用" "Subscription port $subscription_port is already in use"
    fi
  fi
  emit_event running "$(i18n_text "计划检查通过：核心=$core 档位=$TSUB_TIER 内存=${TSUB_MEMORY_MB}MB" "Plan accepted: core=$core tier=$TSUB_TIER memory=${TSUB_MEMORY_MB}MB")"
}

# module: 30-provider.sh
verify_download() {
  component=$1
  output=$2
  url=$(kv_get "${component}_${TSUB_ARCH}_url")
  expected=$(kv_get "${component}_${TSUB_ARCH}_sha256")
  format=$(kv_get "${component}_${TSUB_ARCH}_format"); format=${format:-binary}
  binary_expected=$(kv_get "${component}_${TSUB_ARCH}_binary_sha256"); binary_expected=${binary_expected:-$expected}
  [ -n "$url" ] && [ -n "$expected" ] || i18n_die "$component/$TSUB_ARCH 缺少版本清单或 SHA-256" "$component/$TSUB_ARCH is missing a manifest entry or SHA-256"
  TSUB_DOWNLOAD_PART="$output.part"
  i18n_print "正在下载 $component 核心组件..." "Downloading the $component core component..."
  download_file "$url" "$TSUB_DOWNLOAD_PART"
  i18n_print "下载完成，正在校验 $component..." "Download completed; verifying $component..."
  actual=$(sha256_file "$TSUB_DOWNLOAD_PART")
  [ "$actual" = "$expected" ] || i18n_die "$component 校验失败" "$component verification failed"
  case "$format" in
    binary)
      [ "$actual" = "$binary_expected" ] || i18n_die "$component 二进制校验失败" "$component binary verification failed"
      chmod 755 "$TSUB_DOWNLOAD_PART"
      mv -f "$TSUB_DOWNLOAD_PART" "$output"
      ;;
    tar.gz)
      archive_listing="$TSUB_TMP/${component}.archive.list.$$"
      tar -tzf "$TSUB_DOWNLOAD_PART" >"$archive_listing" || i18n_die "$component 压缩包目录读取失败" "Could not read the $component archive listing"
      if grep -Eq '(^/|(^|/)\.\.(/|$))' "$archive_listing"; then i18n_die "$component 压缩包包含不安全路径" "The $component archive contains an unsafe path"; fi
      extracted_list="$TSUB_TMP/${component}.archive.candidates.$$"
      awk -F/ -v component="$component" '$NF == component { print }' "$archive_listing" >"$extracted_list"
      [ "$(wc -l <"$extracted_list" | tr -d ' ')" = 1 ] || i18n_die "$component 压缩包必须包含唯一二进制文件" "The $component archive must contain exactly one binary"
      extracted=$(sed -n '1p' "$extracted_list")
      extracted_file="$TSUB_TMP/${component}.binary.$$"
      tar -xOzf "$TSUB_DOWNLOAD_PART" "$extracted" >"$extracted_file" || i18n_die "$component 压缩包解压失败" "Failed to extract the $component archive"
      [ -s "$extracted_file" ] || i18n_die "$component 压缩包中的二进制文件为空" "The binary in the $component archive is empty"
      extracted_hash=$(sha256_file "$extracted_file")
      [ "$extracted_hash" = "$binary_expected" ] || i18n_die "$component 二进制校验失败" "$component binary verification failed"
      chmod 755 "$extracted_file"
      mv -f "$extracted_file" "$output"
      rm -f "$archive_listing" "$extracted_list" "$TSUB_DOWNLOAD_PART"
      ;;
    *) i18n_die "$component 资产格式不受支持" "Unsupported $component asset format" ;;
  esac
  TSUB_DOWNLOAD_PART=''
  i18n_print "$component 下载并校验完成。" "$component was downloaded and verified successfully."
}

component_binary_sha() {
  component=$1
  component_expected=$(kv_get "${component}_${TSUB_ARCH}_binary_sha256")
  [ -n "$component_expected" ] || component_expected=$(kv_get "${component}_${TSUB_ARCH}_sha256")
  printf '%s' "$component_expected"
}

ensure_core() {
  core=$(kv_get runtime_core)
  version=$(kv_get "${core}_version")
  expected=$(component_binary_sha "$core")
  [ -n "$expected" ] || i18n_die "$core/$TSUB_ARCH 缺少 SHA-256" "$core/$TSUB_ARCH is missing a SHA-256"
  target="$TSUB_BIN/$core-$version-$TSUB_ARCH-$expected"
  if [ -x "$target" ] && [ "$(sha256_file "$target")" != "$expected" ]; then rm -f "$target"; fi
  TSUB_CORE_DOWNLOADED=false
  if [ ! -x "$target" ]; then
    TSUB_STAGE=download
    verify_download "$core" "$target"
    TSUB_CORE_DOWNLOADED=true
  fi
  TSUB_CORE_BIN=$target
  TSUB_CORE_VERSION=$(basename "$target")
  TSUB_CORE_CHANGED=false
  previous_core=$(cat "$TSUB_STATE/core.identity" 2>/dev/null || true)
  TSUB_PREVIOUS_CORE=$previous_core
  [ "$previous_core" = "$TSUB_CORE_BIN" ] || TSUB_CORE_CHANGED=true
}

load_installed_core() {
  TSUB_CORE_BIN=$(cat "$TSUB_STATE/core.identity" 2>/dev/null || true)
  [ -n "$TSUB_CORE_BIN" ] && [ -x "$TSUB_CORE_BIN" ] || i18n_die "未找到已安装核心，请先执行 apply" "No installed core was found; run apply first"
  TSUB_CORE_VERSION=$(basename "$TSUB_CORE_BIN")
}

render_config() {
  core=$(kv_get runtime_core)
  output=$1
  b64_decode_file "${core}_config_b64" "$output" || i18n_die "$core 配置 Base64 解码失败或内容为空" "The $core configuration could not be decoded from Base64 or is empty"
  cert_dir="$TSUB_STATE/certificates/certificates"
  sed "s|__TSUB_CERT_DIR__|$cert_dir|g" "$output" >"$output.rendered"
  mv "$output.rendered" "$output"
  replace_runtime_secrets "$output"
  chmod 600 "$output"
}

validate_config() {
  core=$(kv_get runtime_core)
  config=$1
  case "$core" in
    xray) run_core_command "$TSUB_CORE_BIN" run -test -config "$config" >/dev/null 2>"$TSUB_TMP/validate.err" ;;
    sing-box) run_core_command "$TSUB_CORE_BIN" check -c "$config" >/dev/null 2>"$TSUB_TMP/validate.err" ;;
    naive) "$TSUB_CORE_BIN" validate --config "$config" --adapter caddyfile >/dev/null 2>"$TSUB_TMP/validate.err" ;;
  esac || i18n_die "核心配置检查失败: $(tail -c 300 "$TSUB_TMP/validate.err" 2>/dev/null)" "Core configuration validation failed: $(tail -c 300 "$TSUB_TMP/validate.err" 2>/dev/null)"
}

export_nodes() {
  TSUB_NODES_FILE="$TSUB_STATE/nodes.txt"
  b64_decode_file nodes_b64 "$TSUB_NODES_FILE" || : >"$TSUB_NODES_FILE"
  replace_runtime_secrets "$TSUB_NODES_FILE"
  TSUB_NODE_DETAILS_FILE="$TSUB_STATE/node-details.txt"
  b64_decode_file node_details_b64 "$TSUB_NODE_DETAILS_FILE" || : >"$TSUB_NODE_DETAILS_FILE"
  replace_runtime_secrets "$TSUB_NODE_DETAILS_FILE"
  apply_exported_certificate_pin || i18n_die "节点证书指纹写入失败" "Failed to write node certificate pins"
  chmod 600 "$TSUB_NODE_DETAILS_FILE"
  if [ -r "$TSUB_STATE/legacy-nodes.txt" ] && [ ! -s "$TSUB_NODES_FILE" ]; then
    cp "$TSUB_STATE/legacy-nodes.txt" "$TSUB_NODES_FILE"
  fi
  chmod 640 "$TSUB_NODES_FILE"
  if id tsub >/dev/null 2>&1; then
    chgrp "$(id -gn tsub)" "$TSUB_NODES_FILE" 2>/dev/null || true
  fi
}

# module: 31-secrets.sh
generate_reality_keypair() {
  output=$1
  core=$(kv_get runtime_core)
  case "$core" in
    sing-box) run_core_command "$TSUB_CORE_BIN" generate reality-keypair >"$output" ;;
    xray) run_core_command "$TSUB_CORE_BIN" x25519 >"$output" ;;
    *) return 1 ;;
  esac
}

valid_reality_key() {
  [ "${#1}" -eq 43 ] || return 1
  case "$1" in *[!A-Za-z0-9_-]*) return 1 ;; esac
}

valid_warp_key() {
  [ "${#1}" -ge 43 ] && [ "${#1}" -le 64 ] || return 1
  case "$1" in *[!A-Za-z0-9+/=_-]*) return 1 ;; esac
}

ensure_warp_identity() {
  [ "$(kv_get warp_backend)" = userspace ] || return 0
  [ "$(kv_get warp_provisioning)" = auto ] || return 0
  [ "$(kv_get warp_terms_accepted)" = true ] || i18n_die "自动 WARP 未确认服务条款" "The WARP terms have not been accepted for automatic setup"
  warp_dir="$TSUB_STATE/secrets/warp"
  warp_profile="$warp_dir/wgcf-profile.conf"
  mkdir -p "$warp_dir"
  chmod 700 "$TSUB_STATE/secrets" "$warp_dir"
  if [ ! -s "$warp_profile" ]; then
    version=$(kv_get wgcf_version); version=${version:-2.2.22}
    expected=$(component_binary_sha wgcf)
    [ -n "$expected" ] || i18n_die "wgcf/$TSUB_ARCH 缺少 SHA-256" "wgcf/$TSUB_ARCH is missing a SHA-256"
    warp_bin="$TSUB_BIN/wgcf-$version-$TSUB_ARCH-$expected"
    if [ -x "$warp_bin" ] && [ "$(sha256_file "$warp_bin")" != "$expected" ]; then rm -f "$warp_bin"; fi
    [ -x "$warp_bin" ] || verify_download wgcf "$warp_bin"
    warp_work="$TSUB_TMP/wgcf-register"
    rm -rf "$warp_work"; mkdir -p "$warp_work"; chmod 700 "$warp_work"
    if ! (cd "$warp_work" && "$warp_bin" register --accept-tos >/dev/null 2>register.err && "$warp_bin" generate >/dev/null 2>generate.err); then
      append_redacted_log "$warp_work/register.err"
      append_redacted_log "$warp_work/generate.err"
      i18n_die "WARP 免费身份注册失败；请稍后重试或切换手工导入" "WARP free identity registration failed; retry later or import one manually"
    fi
    [ -s "$warp_work/wgcf-account.toml" ] && atomic_install "$warp_work/wgcf-account.toml" "$warp_dir/wgcf-account.toml" 600
    [ -s "$warp_work/wgcf-profile.conf" ] || i18n_die "WARP 身份生成结果缺少配置" "The generated WARP identity is missing its configuration"
    atomic_install "$warp_work/wgcf-profile.conf" "$warp_profile" 600
  fi
  chmod 600 "$warp_dir"/* 2>/dev/null || true
  warp_private=$(sed -n 's/^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p')
  warp_peer=$(sed -n 's/^[[:space:]]*PublicKey[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p')
  warp_addresses=$(sed -n 's/^[[:space:]]*Address[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p')
  warp_ipv4=$(printf '%s' "$warp_addresses" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[0-9.]+/[0-9]+$' | sed -n '1p')
  warp_ipv6=$(printf '%s' "$warp_addresses" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[0-9a-fA-F:]+/[0-9]+$' | sed -n '1p')
  warp_endpoint_value=$(sed -n 's/^[[:space:]]*Endpoint[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p')
  warp_endpoint=${warp_endpoint_value%:*}; warp_port=${warp_endpoint_value##*:}
  warp_reserved=$(sed -n 's/^[[:space:]]*Reserved[[:space:]]*=[[:space:]]*//p' "$warp_profile" | sed -n '1p' | tr -d '[][:space:]')
  [ -n "$warp_reserved" ] || warp_reserved=0,0,0
  valid_warp_key "$warp_private" && valid_warp_key "$warp_peer" || i18n_die "WARP 身份中的密钥格式无效" "The WARP identity contains an invalid key"
  [ -n "$warp_ipv4" ] && [ -n "$warp_ipv6" ] || i18n_die "WARP 身份缺少双栈地址" "The WARP identity is missing dual-stack addresses"
  case "$warp_port" in ''|*[!0-9]*) i18n_die "WARP Endpoint 端口无效" "Invalid WARP endpoint port" ;; esac
  case "$warp_reserved" in *[!0-9,]*) i18n_die "WARP Reserved 格式无效" "Invalid WARP reserved value" ;; esac
}

ensure_runtime_secrets() {
  mkdir -p "$TSUB_STATE/secrets"
  chmod 700 "$TSUB_STATE/secrets"
  ensure_warp_identity
  ids=$(kv_get reality_auto_ids)
  [ -n "$ids" ] || return 0
  secrets_dir="$TSUB_STATE/secrets"
  mkdir -p "$secrets_dir"
  chmod 700 "$secrets_dir"
  old_ifs=$IFS; IFS=,
  for id in $ids; do
    case "$id" in ''|*[!A-Za-z0-9_]*) IFS=$old_ifs; i18n_die "Reality 入站标识无效" "Invalid Reality inbound identifier" ;; esac
    secret_file="$secrets_dir/reality-$id.conf"
    if [ ! -s "$secret_file" ]; then
      generated="$TSUB_TMP/reality-$id.out"
      generate_reality_keypair "$generated" || { IFS=$old_ifs; i18n_die "Reality 密钥生成失败" "Failed to generate Reality keys"; }
      private_key=$(sed -n 's/^[Pp]rivate[Kk]ey:[[:space:]]*//p; s/^[Pp]rivate key:[[:space:]]*//p' "$generated" | sed -n '1p')
      public_key=$(sed -n 's/^[Pp]ublic[Kk]ey:[[:space:]]*//p; s/^[Pp]ublic key:[[:space:]]*//p; s/^[Pp]assword ([Pp]ublic[Kk]ey):[[:space:]]*//p; s/^[Pp]assword:[[:space:]]*//p' "$generated" | sed -n '1p')
      valid_reality_key "$private_key" && valid_reality_key "$public_key" || { IFS=$old_ifs; i18n_die "Reality 密钥输出无法识别" "Unrecognized Reality key output"; }
      printf 'private=%s\npublic=%s\n' "$private_key" "$public_key" >"$TSUB_TMP/reality-$id.conf"
      atomic_install "$TSUB_TMP/reality-$id.conf" "$secret_file" 600
    fi
  done
  IFS=$old_ifs
}

replace_runtime_secrets() {
  target=$1
  ids=$(kv_get reality_auto_ids)
  if [ -n "$ids" ]; then
    old_ifs=$IFS; IFS=,
    for id in $ids; do
      secret_file="$TSUB_STATE/secrets/reality-$id.conf"
      [ -r "$secret_file" ] || { IFS=$old_ifs; i18n_die "Reality 密钥不存在: $id" "Reality key does not exist: $id"; }
      private_key=$(sed -n 's/^private=//p' "$secret_file" | sed -n '1p')
      public_key=$(sed -n 's/^public=//p' "$secret_file" | sed -n '1p')
      sed "s|__TSUB_REALITY_PRIVATE_${id}__|$private_key|g; s|__TSUB_REALITY_PUBLIC_${id}__|$public_key|g" "$target" >"$target.secrets"
      mv "$target.secrets" "$target"
    done
    IFS=$old_ifs
  fi
  if [ "$(kv_get warp_backend)" = userspace ] && [ "$(kv_get warp_provisioning)" = auto ]; then
    ensure_warp_identity
    warp_private_escaped=$(printf '%s' "$warp_private" | sed 's/[\\&|]/\\&/g')
    warp_peer_escaped=$(printf '%s' "$warp_peer" | sed 's/[\\&|]/\\&/g')
    warp_endpoint_escaped=$(printf '%s' "$warp_endpoint" | sed 's/[\\&|]/\\&/g')
    sed "s|__TSUB_WARP_PRIVATE_KEY__|$warp_private_escaped|g; s|__TSUB_WARP_PEER_PUBLIC_KEY__|$warp_peer_escaped|g; s|__TSUB_WARP_IPV4__|$warp_ipv4|g; s|__TSUB_WARP_IPV6__|$warp_ipv6|g; s|__TSUB_WARP_ENDPOINT__|$warp_endpoint_escaped|g; s|\"__TSUB_WARP_PORT__\"|$warp_port|g; s|\"__TSUB_WARP_RESERVED__\"|[$warp_reserved]|g" "$target" >"$target.warp"
    mv "$target.warp" "$target"
  fi
  chmod 600 "$target"
}

# module: 32-tunnel.sh
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
restart_delay=2
cleanup_tunnel_children() {
  case "$monitor_pid" in ''|*[!0-9]*) ;; *) kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true ;; esac
  case "$tunnel_pid" in ''|*[!0-9]*) ;; *) kill "$tunnel_pid" 2>/dev/null || true; wait "$tunnel_pid" 2>/dev/null || true ;; esac
  rm -f "$tunnel_pid_file" "$monitor_pid_file"
}
stop_tunnel_supervisor() { stopping=true; cleanup_tunnel_children; }
trap stop_tunnel_supervisor HUP INT TERM
while [ "$stopping" = false ]; do
  tunnel_started_at=$(date +%s 2>/dev/null || printf 0)
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
  sleep "$restart_delay"
  if [ "$mode" = quick ]; then
    tunnel_stopped_at=$(date +%s 2>/dev/null || printf 0)
    tunnel_lifetime=0
    case "$tunnel_started_at:$tunnel_stopped_at" in *[!0-9:]*) ;; *) tunnel_lifetime=$((tunnel_stopped_at - tunnel_started_at)) ;; esac
    if [ "$tunnel_lifetime" -ge 60 ]; then restart_delay=2
    elif [ "$restart_delay" -lt 60 ]; then restart_delay=$((restart_delay * 2)); [ "$restart_delay" -le 60 ] || restart_delay=60
    fi
  else restart_delay=2
  fi
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

# module: 33-certificate.sh
acme_firewall_open() {
  TSUB_ACME_FIREWALL=''
  [ "$TSUB_HAS_NET_ADMIN" = true ] || return 0
  if have nft; then
    nft add table inet tsub_acme
    nft 'add chain inet tsub_acme input { type filter hook input priority -10; policy accept; }'
    nft add rule inet tsub_acme input tcp dport 80 accept
    TSUB_ACME_FIREWALL=nft
  elif have iptables; then
    iptables -I INPUT -p tcp --dport 80 -m comment --comment TSUB_ACME -j ACCEPT
    TSUB_ACME_FIREWALL=iptables
  fi
}

acme_firewall_close() {
  [ "$TSUB_ACME_FIREWALL" = nft ] && nft delete table inet tsub_acme >/dev/null 2>&1 || true
  if [ "$TSUB_ACME_FIREWALL" = iptables ]; then
    iptables -D INPUT -p tcp --dport 80 -m comment --comment TSUB_ACME -j ACCEPT >/dev/null 2>&1 || true
  fi
  TSUB_ACME_FIREWALL=''
}

certificate_pin_sha256() {
  certificate_pin_file=$1
  certificate_pin_body="$TSUB_TMP/certificate-pin.b64"
  certificate_pin_der="$TSUB_TMP/certificate-pin.der"
  sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/ {
    /-----BEGIN CERTIFICATE-----/d
    /-----END CERTIFICATE-----/d
    p
  }' "$certificate_pin_file" | tr -d '[:space:]' >"$certificate_pin_body"
  [ -s "$certificate_pin_body" ] || return 1
  certificate_pin_decoded=false
  if have base64; then
    if base64 -d <"$certificate_pin_body" >"$certificate_pin_der" 2>/dev/null && [ -s "$certificate_pin_der" ]; then certificate_pin_decoded=true
    elif base64 --decode <"$certificate_pin_body" >"$certificate_pin_der" 2>/dev/null && [ -s "$certificate_pin_der" ]; then certificate_pin_decoded=true
    elif base64 -D <"$certificate_pin_body" >"$certificate_pin_der" 2>/dev/null && [ -s "$certificate_pin_der" ]; then certificate_pin_decoded=true
    fi
  fi
  if [ "$certificate_pin_decoded" = false ] && have openssl; then
    if openssl base64 -d -A <"$certificate_pin_body" >"$certificate_pin_der" 2>/dev/null && [ -s "$certificate_pin_der" ]; then certificate_pin_decoded=true; fi
  fi
  [ "$certificate_pin_decoded" = true ] || return 1
  certificate_pin=$(sha256_file "$certificate_pin_der" | tr 'A-F' 'a-f')
  case "$certificate_pin" in
    *[!0-9a-f]*|'') return 1 ;;
  esac
  [ "${#certificate_pin}" -eq 64 ] || return 1
  printf '%s\n' "$certificate_pin"
}

certificate_spki_sha256() {
  certificate_spki_file=$1
  certificate_spki_der="$TSUB_TMP/certificate-spki.der"
  certificate_spki_digest="$TSUB_TMP/certificate-spki.sha256"
  have openssl || return 1
  openssl x509 -in "$certificate_spki_file" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null >"$certificate_spki_der" || return 1
  [ -s "$certificate_spki_der" ] || return 1
  openssl dgst -sha256 -binary "$certificate_spki_der" >"$certificate_spki_digest" 2>/dev/null || return 1
  [ "$(wc -c <"$certificate_spki_digest" | tr -d ' ')" = 32 ] || return 1
  certificate_spki=$(certificate_base64_encode_file "$certificate_spki_digest") || return 1
  case "$certificate_spki" in *[!A-Za-z0-9+/=]*|'') return 1 ;; esac
  [ "${#certificate_spki}" -eq 44 ] || return 1
  case "$certificate_spki" in *=) ;; *) return 1 ;; esac
  printf '%s\n' "$certificate_spki"
}

certificate_spki_urlencode() {
  printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/+/%2B/g' -e 's|/|%2F|g' -e 's/=/%3D/g'
}

certificate_base64_decode_value() {
  certificate_encoded=$1
  certificate_output=$2
  printf '%s' "$certificate_encoded" | tr '_-' '/+' >"$certificate_output.b64"
  certificate_decoded=false
  if have base64; then
    if base64 -d <"$certificate_output.b64" >"$certificate_output" 2>/dev/null && [ -s "$certificate_output" ]; then certificate_decoded=true
    elif base64 --decode <"$certificate_output.b64" >"$certificate_output" 2>/dev/null && [ -s "$certificate_output" ]; then certificate_decoded=true
    elif base64 -D <"$certificate_output.b64" >"$certificate_output" 2>/dev/null && [ -s "$certificate_output" ]; then certificate_decoded=true
    fi
  fi
  if [ "$certificate_decoded" = false ] && have openssl; then
    if openssl base64 -d -A <"$certificate_output.b64" >"$certificate_output" 2>/dev/null && [ -s "$certificate_output" ]; then certificate_decoded=true; fi
  fi
  rm -f "$certificate_output.b64"
  [ "$certificate_decoded" = true ]
}

certificate_base64_encode_file() {
  certificate_input=$1
  if have base64; then base64 <"$certificate_input" | tr -d '\r\n'
  elif have openssl; then openssl base64 -A <"$certificate_input"
  else return 1; fi
}

replace_certificate_pin_in_file() {
  certificate_nodes_file=$1
  certificate_pin=$2
  certificate_spki=$3
  certificate_spki_encoded=$(certificate_spki_urlencode "$certificate_spki") || return 1
  [ -f "$certificate_nodes_file" ] || return 0
  certificate_nodes_output="$TSUB_TMP/$(basename "$certificate_nodes_file").pinned"
  : >"$certificate_nodes_output"
  certificate_line_number=0
  while IFS= read -r certificate_line || [ -n "$certificate_line" ]; do
    certificate_line_number=$((certificate_line_number + 1))
    case "$certificate_line" in
      vmess://*)
        certificate_vmess_payload="$TSUB_TMP/vmess-pin.$certificate_line_number.json"
        if ! certificate_base64_decode_value "${certificate_line#vmess://}" "$certificate_vmess_payload"; then
          i18n_log ERROR "VMess 节点证书指纹写入失败：链接 Base64 无效" "Failed to write the VMess certificate pin: invalid link Base64"
          return 1
        fi
        sed -e "s/__TSUB_CERT_PIN_SHA256__/$certificate_pin/g" -e "s|__TSUB_CERT_SPKI_SHA256__|$certificate_spki|g" "$certificate_vmess_payload" >"$certificate_vmess_payload.pinned"
        certificate_vmess_encoded=$(certificate_base64_encode_file "$certificate_vmess_payload.pinned") || return 1
        printf 'vmess://%s\n' "$certificate_vmess_encoded" >>"$certificate_nodes_output"
        ;;
      *)
        printf '%s\n' "$certificate_line" | sed -e "s/__TSUB_CERT_PIN_SHA256__/$certificate_pin/g" -e "s|__TSUB_CERT_SPKI_SHA256__|$certificate_spki_encoded|g" >>"$certificate_nodes_output"
        ;;
    esac
  done <"$certificate_nodes_file"
  if grep -Eq '__TSUB_CERT_(PIN|SPKI)_SHA256__' "$certificate_nodes_output" 2>/dev/null; then
    i18n_log ERROR "节点证书指纹占位符未完全替换" "Node certificate pin placeholders were not fully replaced"
    return 1
  fi
  mv -f "$certificate_nodes_output" "$certificate_nodes_file"
}

validate_exported_tuic_certificate_pin() {
  certificate_nodes_file=$1
  certificate_pin=$2
  certificate_spki_encoded=$(certificate_spki_urlencode "$3") || return 1
  [ -f "$certificate_nodes_file" ] || return 0
  while IFS= read -r certificate_line || [ -n "$certificate_line" ]; do
    case "$certificate_line" in
      tuic://*)
        case "$certificate_line" in *"pcs=$certificate_pin"*) ;; *) return 1 ;; esac
        case "$certificate_line" in *"spki=$certificate_spki_encoded"*) ;; *) return 1 ;; esac
        ;;
    esac
  done <"$certificate_nodes_file"
}

apply_exported_certificate_pin() {
  [ "$(kv_get certificate_mode)" = self-signed ] || return 0
  certificate_domain=$(kv_get certificate_domain)
  [ -n "$certificate_domain" ] || return 0
  certificate_file="$TSUB_STATE/certificates/certificates/$certificate_domain.crt"
  [ -s "$certificate_file" ] || { i18n_log ERROR "自签证书不存在，无法固定客户端证书指纹" "The self-signed certificate does not exist; client certificate pinning cannot be applied"; return 1; }
  certificate_pin=$(certificate_pin_sha256 "$certificate_file") || { i18n_log ERROR "自签证书 SHA-256 指纹计算失败" "Failed to calculate the self-signed certificate SHA-256 fingerprint"; return 1; }
  certificate_spki=$(certificate_spki_sha256 "$certificate_file") || { i18n_log ERROR "自签证书 SPKI SHA-256 计算失败" "Failed to calculate the self-signed certificate SPKI SHA-256 pin"; return 1; }
  replace_certificate_pin_in_file "$TSUB_NODES_FILE" "$certificate_pin" "$certificate_spki" || return 1
  replace_certificate_pin_in_file "$TSUB_NODE_DETAILS_FILE" "$certificate_pin" "$certificate_spki" || return 1
  validate_exported_tuic_certificate_pin "$TSUB_NODES_FILE" "$certificate_pin" "$certificate_spki" \
    || { i18n_log ERROR "TUIC 节点缺少有效的自签证书指纹" "The TUIC node is missing valid self-signed certificate pins"; return 1; }
  printf '%s\n' "$certificate_pin" >"$TSUB_TMP/certificate.pin"
  atomic_install "$TSUB_TMP/certificate.pin" "$TSUB_STATE/certificate.pin-sha256" 600
  printf '%s\n' "$certificate_spki" >"$TSUB_TMP/certificate.spki"
  atomic_install "$TSUB_TMP/certificate.spki" "$TSUB_STATE/certificate.spki-sha256" 600
}

ensure_certificate() {
  TSUB_CERT_CHANGED=false
  mode=$(kv_get certificate_mode)
  domain=$(kv_get certificate_domain)
  [ "$mode" != existing ] && [ -n "$domain" ] || return 0
  cert_root="$TSUB_STATE/certificates"
  cert_dir="$cert_root/certificates"
  cert_file="$cert_dir/$domain.crt"
  key_file="$cert_dir/$domain.key"
  generated_file="$cert_root/$domain.generated"
  mkdir -p "$cert_dir"
  chmod 700 "$cert_root" "$cert_dir"
  if [ "$mode" = self-signed ]; then
    rotate=false
    if [ ! -s "$cert_file" ] || [ ! -s "$key_file" ]; then
      rotate=true
    elif [ -r "$generated_file" ]; then
      generated_at=$(sed -n '1p' "$generated_file")
      now=$(date +%s 2>/dev/null || printf 0)
      case "$generated_at:$now" in
        *[!0-9:]*) rotate=false ;;
        *) [ $((now - generated_at)) -lt 28512000 ] || rotate=true ;;
      esac
    fi
    [ "$rotate" = true ] || return 0
    self_signed_key="$TSUB_TMP/$domain.key"
    self_signed_cert="$TSUB_TMP/$domain.crt"
    self_signed_output="$TSUB_TMP/$domain.tls"
    core=$(kv_get runtime_core)
    case "$core" in
      sing-box)
        "$TSUB_CORE_BIN" generate tls-keypair "$domain" --months 12 >"$self_signed_output"
        awk '/BEGIN.*PRIVATE KEY/{capture=1}capture{print}/END.*PRIVATE KEY/{capture=0}' "$self_signed_output" >"$self_signed_key"
        awk '/BEGIN CERTIFICATE/{capture=1}capture{print}/END CERTIFICATE/{capture=0}' "$self_signed_output" >"$self_signed_cert"
        ;;
      xray)
        self_signed_base="$TSUB_TMP/$domain"
        "$TSUB_CORE_BIN" tls cert --domain="$domain" --expire=8760h --file="$self_signed_base" >"$self_signed_output" 2>&1
        for candidate in "$self_signed_base.key" "$self_signed_base.key.pem" "$TSUB_TMP/key.pem"; do
          if [ -s "$candidate" ]; then
            [ "$candidate" = "$self_signed_key" ] || cp "$candidate" "$self_signed_key"
            break
          fi
        done
        for candidate in "$self_signed_base.crt" "$self_signed_base.cert" "$self_signed_base.crt.pem" "$TSUB_TMP/cert.pem"; do
          if [ -s "$candidate" ]; then
            [ "$candidate" = "$self_signed_cert" ] || cp "$candidate" "$self_signed_cert"
            break
          fi
        done
        ;;
      *) i18n_die "当前核心不支持生成自签证书" "The current core cannot generate a self-signed certificate" ;;
    esac
    grep -q 'BEGIN.*PRIVATE KEY' "$self_signed_key" 2>/dev/null || i18n_die "核心未生成有效的自签证书私钥" "The core did not generate a valid self-signed certificate private key"
    grep -q 'BEGIN CERTIFICATE' "$self_signed_cert" 2>/dev/null || i18n_die "核心未生成有效的自签证书" "The core did not generate a valid self-signed certificate"
    atomic_install "$self_signed_key" "$key_file" 600
    atomic_install "$self_signed_cert" "$cert_file" 600
    date +%s >"$TSUB_TMP/certificate.generated"
    atomic_install "$TSUB_TMP/certificate.generated" "$generated_file" 600
    TSUB_CERT_CHANGED=true
    return 0
  fi
  [ "$(id -u)" -eq 0 ] || i18n_die "ACME 自动证书需要 root 权限" "Automatic ACME certificates require root"
  version=$(kv_get lego_version); version=${version:-stable}
  expected=$(component_binary_sha lego)
  [ -n "$expected" ] || i18n_die "lego/$TSUB_ARCH 缺少 SHA-256" "lego/$TSUB_ARCH is missing a SHA-256"
  lego_bin="$TSUB_BIN/lego-$version-$TSUB_ARCH-$expected"
  if [ -x "$lego_bin" ] && [ "$(sha256_file "$lego_bin")" != "$expected" ]; then rm -f "$lego_bin"; fi
  [ -x "$lego_bin" ] || verify_download lego "$lego_bin"
  previous_cert_hash=''
  [ -s "$cert_file" ] && previous_cert_hash=$(sha256_file "$cert_file")
  email=$(kv_get certificate_email)
  mkdir -p "$cert_root"
  if [ "$mode" = cloudflare-dns01 ]; then
    token_file="$TSUB_TMP/cloudflare-dns.token"
    b64_decode_file certificate_api_token_b64 "$token_file" || i18n_die "DNS-01 Token 解码失败" "Failed to decode the DNS-01 token"
    CF_DNS_API_TOKEN=$(cat "$token_file"); export CF_DNS_API_TOKEN
    if [ -s "$cert_file" ]; then "$lego_bin" --path "$cert_root" --email "$email" --domains "$domain" --dns cloudflare renew --days 30
    else "$lego_bin" --path "$cert_root" --email "$email" --domains "$domain" --dns cloudflare --accept-tos run; fi
    unset CF_DNS_API_TOKEN
  else
    if have ss && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '[:.]80$'; then i18n_die "HTTP-01 需要空闲的 80 端口" "HTTP-01 requires port 80 to be available"; fi
    acme_firewall_open
    set +e
    if [ -s "$cert_file" ]; then "$lego_bin" --path "$cert_root" --email "$email" --domains "$domain" --http renew --days 30
    else "$lego_bin" --path "$cert_root" --email "$email" --domains "$domain" --http --accept-tos run; fi
    acme_result=$?
    set -e
    acme_firewall_close
    [ "$acme_result" -eq 0 ] || i18n_die "HTTP-01 证书申请失败" "HTTP-01 certificate issuance failed"
  fi
  [ -s "$cert_file" ] || i18n_die "ACME 未生成证书" "ACME did not generate a certificate"
  current_cert_hash=$(sha256_file "$cert_file")
  [ "$previous_cert_hash" = "$current_cert_hash" ] || TSUB_CERT_CHANGED=true
}

# module: 34-edge-probe.sh
edge_probe_number() {
  case "$1" in ''|*[!0-9]*) printf 0 ;; *) printf '%s' "$1" ;; esac
}

edge_probe() {
  have curl || i18n_die 'CDN 真实握手检测需要 curl' 'The real CDN handshake probe requires curl'
  edge_probe_host=$(kv_get edge_probe_hostname)
  edge_probe_port=$(kv_get edge_probe_port)
  case "$edge_probe_host" in ''|*[!A-Za-z0-9.-]*) i18n_die 'CDN 握手入口域名无效' 'Invalid CDN handshake hostname' ;; esac
  case "$edge_probe_port" in 443|2053|2083|2087|2096|8443) ;; *) i18n_die 'CDN 握手端口无效' 'Invalid CDN handshake port' ;; esac
  edge_probe_address_file="$TSUB_TMP/edge-probe.address"
  edge_probe_path_file="$TSUB_TMP/edge-probe.path"
  b64_decode_file edge_probe_address_b64 "$edge_probe_address_file" || i18n_die 'CDN 握手地址无效' 'Invalid CDN handshake address'
  b64_decode_file edge_probe_path_b64 "$edge_probe_path_file" || i18n_die 'CDN 握手路径无效' 'Invalid CDN handshake path'
  edge_probe_address=$(cat "$edge_probe_address_file")
  edge_probe_path=$(cat "$edge_probe_path_file")
  case "$edge_probe_address" in ''|*[!A-Za-z0-9.:-]*) i18n_die 'CDN 握手地址无效' 'Invalid CDN handshake address' ;; esac
  case "$edge_probe_path" in /*) ;; *) i18n_die 'CDN 握手路径无效' 'Invalid CDN handshake path' ;; esac

  edge_probe_format='%{remote_ip}|%{time_connect}|%{time_appconnect}|%{http_code}|%{time_total}'
  edge_probe_output="$TSUB_TMP/edge-probe.curl"
  edge_probe_headers="$TSUB_TMP/edge-probe.headers"
  case "$edge_probe_address" in
    *:*) edge_probe_route="${edge_probe_host}:${edge_probe_port}:[${edge_probe_address}]"; set -- --resolve "$edge_probe_route" ;;
    *[!0-9.]* ) edge_probe_route="${edge_probe_host}:${edge_probe_port}:${edge_probe_address}:${edge_probe_port}"; set -- --connect-to "$edge_probe_route" ;;
    *) edge_probe_route="${edge_probe_host}:${edge_probe_port}:${edge_probe_address}"; set -- --resolve "$edge_probe_route" ;;
  esac
  curl -sS --http1.1 --connect-timeout 5 --max-time 8 -o /dev/null -D "$edge_probe_headers" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -w "$edge_probe_format" "$@" "https://${edge_probe_host}:${edge_probe_port}${edge_probe_path}" >"$edge_probe_output" 2>/dev/null || true
  IFS='|' read -r edge_probe_remote edge_probe_connect edge_probe_tls edge_probe_status edge_probe_total <"$edge_probe_output" || true
  edge_probe_dns=false; edge_probe_tcp=false; edge_probe_tls_ok=false; edge_probe_host_sni=false; edge_probe_ws=false
  [ -z "${edge_probe_remote:-}" ] || edge_probe_dns=true
  case "${edge_probe_connect:-0}" in 0|0.0|0.00|0.000|0.0000|0.00000|0.000000|'') ;; *) edge_probe_tcp=true ;; esac
  case "${edge_probe_tls:-0}" in 0|0.0|0.00|0.000|0.0000|0.00000|0.000000|'') ;; *) edge_probe_tls_ok=true; edge_probe_host_sni=true ;; esac
  if [ "${edge_probe_status:-0}" = 101 ] \
    && grep -Eiq '^Upgrade:[[:space:]]*websocket[[:space:]]*\r?$' "$edge_probe_headers" \
    && grep -Eiq '^Connection:.*Upgrade' "$edge_probe_headers"; then edge_probe_ws=true; fi
  edge_probe_latency=$(awk -v seconds="${edge_probe_total:-0}" 'BEGIN { printf "%d", seconds * 1000 + 0.5 }')
  edge_probe_result="$TSUB_TMP/edge-probe.result"
  printf 'dns=%s\ntcp=%s\ntls=%s\nhostSni=%s\nwebsocket101=%s\nlatencyMs=%s\n' \
    "$edge_probe_dns" "$edge_probe_tcp" "$edge_probe_tls_ok" "$edge_probe_host_sni" "$edge_probe_ws" "$(edge_probe_number "$edge_probe_latency")" >"$edge_probe_result"
  printf 'TSUB_EDGE_PROBE_RESULT dns=%s tcp=%s tls=%s hostSni=%s websocket101=%s latencyMs=%s\n' \
    "$edge_probe_dns" "$edge_probe_tcp" "$edge_probe_tls_ok" "$edge_probe_host_sni" "$edge_probe_ws" "$(edge_probe_number "$edge_probe_latency")"
  if [ "$edge_probe_dns" = true ] && [ "$edge_probe_tcp" = true ] && [ "$edge_probe_tls_ok" = true ] && [ "$edge_probe_ws" = true ]; then
    i18n_print "CDN 真实握手通过：TLS、Host/SNI 与 WebSocket 101 正常（${edge_probe_latency}ms）" "Real CDN handshake passed: TLS, Host/SNI, and WebSocket 101 are valid (${edge_probe_latency}ms)"
    return 0
  fi
  i18n_print "CDN 真实握手失败：DNS=$edge_probe_dns TCP=$edge_probe_tcp TLS=$edge_probe_tls_ok Host/SNI=$edge_probe_host_sni WebSocket101=$edge_probe_ws（${edge_probe_latency}ms）" "Real CDN handshake failed: DNS=$edge_probe_dns TCP=$edge_probe_tcp TLS=$edge_probe_tls_ok Host/SNI=$edge_probe_host_sni WebSocket101=$edge_probe_ws (${edge_probe_latency}ms)" >&2
  return 1
}

# module: 35-firewall.sh
firewall_ports_apply() {
  ports=$1
  [ "$(kv_get firewall_enabled)" = true ] || return 0
  [ "$TSUB_TIER" != tiny ] || { i18n_degraded "tiny 档已跳过端口放行规则" "Port allow rules were skipped on the tiny tier"; return 0; }
  [ "$TSUB_HAS_NET_ADMIN" = true ] || { i18n_degraded "缺少 CAP_NET_ADMIN，已跳过端口放行规则" "Port allow rules were skipped because CAP_NET_ADMIN is unavailable"; return 0; }
  [ "$(id -u)" -eq 0 ] || { i18n_degraded "无特权模式，已跳过端口放行规则" "Port allow rules were skipped in unprivileged mode"; return 0; }
  if have nft; then
    nft delete table inet tsub >/dev/null 2>&1 || true
    nft add table inet tsub
    nft 'add chain inet tsub input { type filter hook input priority 0; policy accept; }'
    old_ifs=$IFS; IFS=,
    for spec in $ports; do
      protocol=${spec#*/}; number=${spec%/*}
      nft add rule inet tsub input "$protocol" dport "$number" accept
    done
    IFS=$old_ifs
    printf '%s\n' nft >"$TSUB_STATE/firewall.backend"
  elif have iptables; then
    iptables -N TSUB_IN 2>/dev/null || true
    iptables -C INPUT -j TSUB_IN 2>/dev/null || iptables -I INPUT -j TSUB_IN
    iptables -F TSUB_IN
    old_ifs=$IFS; IFS=,
    for spec in $ports; do
      protocol=${spec#*/}; number=${spec%/*}
      iptables -A TSUB_IN -p "$protocol" --dport "$number" -j ACCEPT
    done
    IFS=$old_ifs
    printf '%s\n' iptables >"$TSUB_STATE/firewall.backend"
  else
    i18n_degraded "未找到 nftables/iptables，已跳过端口放行规则" "Port allow rules were skipped because nftables/iptables was not found"
    return 0
  fi
  printf '%s\n' "$ports" >"$TSUB_STATE/firewall.ports"
}

firewall_hops_remove() {
  backend=$(cat "$TSUB_STATE/firewall.hops.backend" 2>/dev/null || true)
  if [ "$backend" = nft ]; then
    nft delete table ip tsub_hop >/dev/null 2>&1 || true
    nft delete table ip6 tsub_hop >/dev/null 2>&1 || true
  elif [ "$backend" = iptables ]; then
    for command in iptables ip6tables; do
      have "$command" || continue
      "$command" -t nat -D PREROUTING -j TSUB_HOP >/dev/null 2>&1 || true
      "$command" -t nat -F TSUB_HOP >/dev/null 2>&1 || true
      "$command" -t nat -X TSUB_HOP >/dev/null 2>&1 || true
    done
  fi
  rm -f "$TSUB_STATE/firewall.hops.backend" "$TSUB_STATE/firewall.hops.rules"
}

firewall_hops_apply() {
  rules=$1
  firewall_hops_remove
  [ -n "$rules" ] || return 0
  [ "$TSUB_HAS_NET_ADMIN" = true ] && [ "$(id -u)" -eq 0 ] || return 1
  if have nft; then
    for family in ip ip6; do
      nft add table "$family" tsub_hop || return 1
      nft "add chain $family tsub_hop prerouting { type nat hook prerouting priority dstnat; policy accept; }" || return 1
    done
    for spec in $rules; do
      target=${spec%%:*}; ranges=${spec#*:}; old_ifs=$IFS; IFS=+
      for range in $ranges; do
        nft add rule ip tsub_hop prerouting udp dport "$range" redirect to ":$target" || { IFS=$old_ifs; return 1; }
        nft add rule ip6 tsub_hop prerouting udp dport "$range" redirect to ":$target" || true
        nft add rule inet tsub input udp dport "$range" accept 2>/dev/null || true
      done
      IFS=$old_ifs
    done
    printf '%s\n' nft >"$TSUB_STATE/firewall.hops.backend"
  elif have iptables; then
    for command in iptables ip6tables; do
      have "$command" || continue
      "$command" -t nat -N TSUB_HOP 2>/dev/null || true
      "$command" -t nat -C PREROUTING -j TSUB_HOP 2>/dev/null || "$command" -t nat -I PREROUTING -j TSUB_HOP
      "$command" -t nat -F TSUB_HOP
    done
    for spec in $rules; do
      target=${spec%%:*}; ranges=${spec#*:}; old_ifs=$IFS; IFS=+
      for range in $ranges; do
        start=${range%-*}; end=${range#*-}; [ "$start" = "$end" ] && match=$start || match=$start:$end
        iptables -t nat -A TSUB_HOP -p udp --dport "$match" -j REDIRECT --to-ports "$target" || { IFS=$old_ifs; return 1; }
        have ip6tables && ip6tables -t nat -A TSUB_HOP -p udp --dport "$match" -j REDIRECT --to-ports "$target" || true
        iptables -A TSUB_IN -p udp --dport "$match" -j ACCEPT 2>/dev/null || true
        have ip6tables && ip6tables -A TSUB_IN -p udp --dport "$match" -j ACCEPT 2>/dev/null || true
      done
      IFS=$old_ifs
    done
    printf '%s\n' iptables >"$TSUB_STATE/firewall.hops.backend"
  else
    return 1
  fi
  printf '%s\n' "$rules" >"$TSUB_STATE/firewall.hops.rules"
}

firewall_snapshot() {
  if [ -r "$TSUB_STATE/firewall.ports" ]; then cp "$TSUB_STATE/firewall.ports" "$TSUB_TX/firewall.ports"
  else : >"$TSUB_TX/firewall.ports"; fi
  if [ -r "$TSUB_STATE/firewall.hops.rules" ]; then cp "$TSUB_STATE/firewall.hops.rules" "$TSUB_TX/firewall.hops.rules"
  else : >"$TSUB_TX/firewall.hops.rules"; fi
}

firewall_restore() {
  [ -f "$TSUB_TX/firewall.ports" ] || return 0
  old_ports=$(cat "$TSUB_TX/firewall.ports")
  if [ -n "$old_ports" ]; then firewall_ports_apply "$old_ports"
  else
    backend=$(cat "$TSUB_STATE/firewall.backend" 2>/dev/null || true)
    [ "$backend" = nft ] && nft delete table inet tsub >/dev/null 2>&1 || true
    if [ "$backend" = iptables ]; then
      iptables -D INPUT -j TSUB_IN >/dev/null 2>&1 || true
      iptables -F TSUB_IN >/dev/null 2>&1 || true
      iptables -X TSUB_IN >/dev/null 2>&1 || true
    fi
    rm -f "$TSUB_STATE/firewall.backend" "$TSUB_STATE/firewall.ports"
  fi
  old_hops=$(cat "$TSUB_TX/firewall.hops.rules" 2>/dev/null || true)
  firewall_hops_apply "$old_hops" || true
}

firewall_remove() {
  firewall_hops_remove
  backend=$(cat "$TSUB_STATE/firewall.backend" 2>/dev/null || true)
  [ "$backend" = nft ] && nft delete table inet tsub >/dev/null 2>&1 || true
  if [ "$backend" = iptables ]; then
    iptables -D INPUT -j TSUB_IN >/dev/null 2>&1 || true
    iptables -F TSUB_IN >/dev/null 2>&1 || true
    iptables -X TSUB_IN >/dev/null 2>&1 || true
  fi
  rm -f "$TSUB_STATE/firewall.backend" "$TSUB_STATE/firewall.ports"
}

# module: 37-traffic.sh
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
    i18n_degraded "当前核心不支持低资源流量统计" "The current core does not support low-resource traffic statistics"
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
    i18n_degraded "代理核心流量统计接口不可用" "The proxy core traffic statistics API is unavailable"
    return 0
  fi
  traffic_apply_rules
  traffic_backend_value=$(traffic_backend)
  if [ "$traffic_backend_value" = core-singbox ] || [ "$traffic_backend_value" = core-xray ]; then
    if ! traffic_read_raw >/dev/null 2>&1; then
      printf '%s\n' unavailable >"$TSUB_STATE/traffic.backend"
      i18n_degraded "代理核心流量统计接口不可用" "The proxy core traffic statistics API is unavailable"
    fi
  elif [ "$traffic_backend_value" = unavailable ]; then
    i18n_degraded "流量统计后端不可用" "The traffic statistics backend is unavailable"
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
    i18n_degraded "没有流量统计定时入口" "No traffic statistics scheduler is available"
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

# module: 38-agent.sh
# shellcheck shell=sh

agent_enabled() {
  [ "$(kv_get agent_mode)" != local ] && [ -n "$(kv_get agent_controller_url)" ] && [ -n "$(kv_get agent_deployment_id)" ] && [ -n "$(kv_get agent_token_b64)" ]
}

agent_poll_interval() {
  agent_interval=$(kv_get agent_poll_interval_seconds)
  case "$agent_interval" in 15|30|60|120|180|300) printf '%s' "$agent_interval" ;; *) printf 30 ;; esac
}

agent_controller_origin() {
  case "$TSUB_AGENT_URL" in
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
  [ "$agent_update_now" -eq 0 ] || [ $((agent_update_now - agent_update_checked)) -ge 3600 ] || return 0

  agent_update_origin=$(agent_controller_origin) || return 0
  agent_update_manifest="$TSUB_TMP/runtime-manifest.json"
  if ! download_file "$agent_update_origin/proxy/v2/manifest.json?v=$agent_update_now" "$agent_update_manifest"; then return 0; fi
  agent_update_version=$(sed -n 's/.*"runtimeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$agent_update_manifest" | head -n 1)
  agent_update_path=$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$agent_update_manifest" | head -n 1)
  agent_update_sha=$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' "$agent_update_manifest" | head -n 1 | tr 'A-F' 'a-f')
  case "$agent_update_version" in ''|*[!0-9A-Za-z._-]*) return 0 ;; esac
  [ "$agent_update_path" = /proxy/v2/tsub-proxy.sh ] || return 0
  case "$agent_update_sha" in *[!0-9a-f]*|'') return 0 ;; esac
  [ "${#agent_update_sha}" -eq 64 ] || return 0
  printf '%s\n' "$agent_update_now" >"$TSUB_TMP/runtime.update-checked-at"
  atomic_install "$TSUB_TMP/runtime.update-checked-at" "$agent_update_checked_file" 600

  agent_update_target="$TSUB_BIN/tsub-proxy.sh"
  if [ -x "$agent_update_target" ] && [ "$(sha256_file "$agent_update_target")" = "$agent_update_sha" ]; then return 0; fi
  agent_update_download="$TSUB_TMP/runtime-update.sh"
  download_file "$agent_update_origin$agent_update_path?v=$agent_update_sha" "$agent_update_download" || return 0
  [ "$(sha256_file "$agent_update_download")" = "$agent_update_sha" ] || { i18n_log ERROR 'Runtime 自动更新校验失败' 'Runtime automatic update verification failed'; return 0; }
  atomic_install "$agent_update_download" "$agent_update_target" 700
  i18n_log INFO "Runtime 已更新到 $agent_update_version，正在重新加载 Agent" "Runtime updated to $agent_update_version; reloading the agent"
  rm -rf "$TSUB_TMP"
  trap - 0 1 2 15
  exec /bin/sh "$agent_update_target" agent
}

agent_value() {
  agent_key=$1 agent_file=$2
  sed -n "/^${agent_key}=/ { s/^[^=]*=//; p; q; }" "$agent_file"
}

agent_report() {
  agent_command_id=$1 agent_lease=$2 agent_status=$3 agent_stage=$4 agent_message=$5
  agent_message_json=$(json_escape "$agent_message")
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
  if [ "$agent_status" = succeeded ] && subscription_enabled 2>/dev/null && subscription_running 2>/dev/null && [ -r "$agent_nodes_file" ]; then
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
  printf '{"status":"%s","stage":"%s","message":"%s","hostname":"%s","resources":{%s}%s}\n' \
    "$agent_status" "$agent_stage" "$agent_message_json" "$agent_hostname_json" "$agent_resources" "$agent_subscription_fields" >"$agent_event"
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
  case "$agent_action" in apply|update|restart|repair|status|list|doctor|rollback|uninstall|transfer-controller|edge-probe) ;; *) return 2 ;; esac
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
    fi
  else
    agent_result=$?
    agent_stop_lease_renewal "$agent_renew_pid"
    append_redacted_log "$agent_command_log"
    [ "$agent_action" != edge-probe ] || agent_capture_edge_probe_result "$agent_command_log"
    agent_failure=$(agent_failure_summary "$agent_command_log" || true)
    agent_failure=${agent_failure:-command failed with exit $agent_result}
    agent_report "$agent_command_id" "$agent_lease" failed "$agent_action" "$agent_failure"
    return "$agent_result"
  fi
}

agent_poll_once() {
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
  printf '{"runtimeVersion":"%s","core":"%s","coreVersion":"%s","coreIdentity":"%s","osId":"%s","osVersion":"%s","osPrettyName":"%s","hostname":"%s","currentCommandId":"","configRevision":%s,"pollIntervalSeconds":%s,"cgroupLimitMb":%s,"memoryAvailableMb":%s,"swapReported":%s,"swapTotalMb":%s,"swapFreeMb":%s,"swapUsedMb":%s,"cgroupSwapReported":%s,"cgroupSwapCurrentMb":%s,"cgroupSwapLimitMb":%s,"rssMb":%s,"coreRssMb":%s,"cloudflaredRssMb":%s,"estimatedCoreRssMb":%s,"estimatedCloudflaredRssMb":%s}\n' \
    "${TSUB_RUNTIME_VERSION:-unknown}" "$(json_escape "$agent_core")" "$(json_escape "$agent_core_version")" "$(json_escape "$agent_core_identity")" \
    "$(json_escape "${TSUB_OS:-unknown}")" "$(json_escape "${TSUB_OS_VERSION:-unknown}")" "$(json_escape "${TSUB_OS_PRETTY:-unknown}")" \
    "$(json_escape "${TSUB_HOSTNAME:-unknown}")" "$agent_config_revision" "$(agent_poll_interval)" \
    "${TSUB_MEMORY_MB:-0}" "${TSUB_MEMORY_AVAILABLE_MB:-0}" "${TSUB_SWAP_REPORTED:-false}" "${TSUB_SWAP_TOTAL_MB:-0}" "${TSUB_SWAP_FREE_MB:-0}" "${TSUB_SWAP_USED_MB:-0}" \
    "${TSUB_CGROUP_SWAP_REPORTED:-false}" "${TSUB_CGROUP_SWAP_CURRENT_MB:-0}" "${TSUB_CGROUP_SWAP_LIMIT_MB:-0}" \
    "$agent_rss" "$agent_core_rss" "$agent_tunnel_rss" "$agent_estimated_core" "$agent_estimated_tunnel" >"$agent_payload"
  agent_http=$(curl -sS -o "$agent_response" -w '%{http_code}' --connect-timeout 10 --max-time 35 -X POST \
    -H "Authorization: Bearer $TSUB_AGENT_TOKEN" -H 'Accept: text/plain' -H 'Content-Type: application/json' \
    --data-binary "@$agent_payload" "$TSUB_AGENT_URL/poll" 2>/dev/null || printf 000)
  [ "$agent_http" = 200 ] || { [ "$agent_http" = 409 ] && printf 300 || agent_poll_interval; return 1; }
  agent_wait=$(agent_value nextPollSeconds "$agent_response"); agent_wait=${agent_wait:-$(agent_poll_interval)}
  agent_command_id=$(agent_value commandId "$agent_response")
  if [ -n "$agent_command_id" ]; then
    agent_action=$(agent_value action "$agent_response")
    agent_lease=$(agent_value leaseId "$agent_response")
    agent_execute_command "$agent_command_id" "$agent_action" "$agent_lease" || true
  fi
  printf '%s' "$agent_wait"
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

# module: 38-subscription.sh
subscription_enabled() { [ "$(kv_get subscription_server_enabled)" = true ]; }

subscription_config_hash() {
  subscription_hash_file="$TSUB_TMP/subscription.hash.input"
  for subscription_hash_key in subscription_server_enabled subscription_server_port subscription_server_token_b64 subscription_traffic_enabled subscription_traffic_quota_bytes subscription_traffic_checkpoint_minutes inbound_ports; do
    printf '%s=%s\n' "$subscription_hash_key" "$(kv_get "$subscription_hash_key")" >>"$subscription_hash_file"
  done
  sha256_file "$subscription_hash_file"
}

subscription_httpd_command() {
  if have busybox && busybox --list 2>/dev/null | grep -qx httpd; then command -v busybox; return 0; fi
  if have busybox-extras && busybox-extras --list 2>/dev/null | grep -qx httpd; then command -v busybox-extras; return 0; fi
  return 1
}

ensure_subscription_httpd() {
  subscription_enabled || return 0
  TSUB_HTTPD_BIN=$(subscription_httpd_command 2>/dev/null || true)
  if [ -n "$TSUB_HTTPD_BIN" ]; then return 0; fi
  subscription_version=$(kv_get busybox_version)
  subscription_expected=$(component_binary_sha busybox)
  [ -n "$subscription_version" ] && [ -n "$subscription_expected" ] || i18n_die "订阅服务缺少 BusyBox provider" "The subscription service is missing its BusyBox provider"
  TSUB_HTTPD_BIN="$TSUB_BIN/busybox-$subscription_version-$TSUB_ARCH-$subscription_expected"
  if [ -x "$TSUB_HTTPD_BIN" ] && [ "$(sha256_file "$TSUB_HTTPD_BIN")" != "$subscription_expected" ]; then rm -f "$TSUB_HTTPD_BIN"; fi
  [ -x "$TSUB_HTTPD_BIN" ] || verify_download busybox "$TSUB_HTTPD_BIN"
  "$TSUB_HTTPD_BIN" --list 2>/dev/null | grep -qx httpd || i18n_die "BusyBox provider 不包含 httpd applet" "The BusyBox provider does not contain the httpd applet"
}

subscription_prepare() {
  subscription_enabled || { subscription_stop; return 0; }
  ensure_subscription_httpd
  subscription_token_file="$TSUB_TMP/subscription.token"
  b64_decode_file subscription_server_token_b64 "$subscription_token_file" || i18n_die "订阅 Token 解码失败" "Failed to decode the subscription token"
  subscription_token=$(cat "$subscription_token_file")
  case "$subscription_token" in ''|*[!A-Za-z0-9_-]*) i18n_die "订阅 Token 格式无效" "Invalid subscription token format" ;; esac
  TSUB_SUBSCRIPTION_ROOT="$TSUB_STATE/subscription-web"
  subscription_cgi="$TSUB_SUBSCRIPTION_ROOT/cgi-bin/$subscription_token"
  mkdir -p "$TSUB_SUBSCRIPTION_ROOT/cgi-bin"
  printf '%s\n' 'Not Found' >"$TSUB_SUBSCRIPTION_ROOT/index.html"
  subscription_script="$TSUB_TMP/subscription.cgi"
  cat >"$subscription_script" <<EOF
#!/bin/sh
state='$TSUB_STATE/traffic.state'
nodes='$TSUB_STATE/nodes.txt'
number() { case "\$1" in ''|*[!0-9]*) printf 0 ;; *) printf '%s' "\$1" ;; esac; }
read_value() { sed -n "s/^\$1=//p" "\$state" 2>/dev/null | sed -n '1p'; }
upload=0; download=0
if [ '$(kv_get subscription_traffic_enabled)' = true ]; then
  upload=\$(number "\$(read_value upload_total)")
  download=\$(number "\$(read_value download_total)")
fi
printf 'Content-Type: text/plain; charset=utf-8\r\n'
printf 'Cache-Control: no-store\r\n'
printf 'Subscription-Userinfo: upload=%s; download=%s; total=%s; expire=0\r\n' "\$upload" "\$download" '$(kv_get subscription_traffic_quota_bytes)'
printf '\r\n'
[ ! -r "\$nodes" ] || cat "\$nodes"
EOF
  rm -f "$TSUB_SUBSCRIPTION_ROOT"/cgi-bin/*
  atomic_install "$subscription_script" "$subscription_cgi" 750
  subscription_launcher="$TSUB_TMP/start-subscription.sh"
  cat >"$subscription_launcher" <<EOF
#!/bin/sh
if [ "\$(id -u)" -eq 0 ] && id tsub >/dev/null 2>&1; then
  if command -v su-exec >/dev/null 2>&1; then exec su-exec tsub "\$0" --as-user
  elif command -v setpriv >/dev/null 2>&1 && setpriv --help 2>&1 | grep -q -- '--reuid'; then exec setpriv --reuid=tsub --regid=tsub --clear-groups "\$0" --as-user
  elif command -v runuser >/dev/null 2>&1; then exec runuser -u tsub -- "\$0" --as-user
  fi
fi
[ "\${1:-}" = --as-user ] && shift
nohup '$TSUB_HTTPD_BIN' httpd -f -p '$(kv_get subscription_server_port)' -h '$TSUB_SUBSCRIPTION_ROOT' >/dev/null 2>&1 &
printf '%s\n' "\$!" >'$TSUB_STATE/subscription.pid'
EOF
  atomic_install "$subscription_launcher" "$TSUB_STATE/start-subscription.sh" 750
  printf '%s\n' "$TSUB_HTTPD_BIN" >"$TSUB_STATE/subscription.httpd"
  printf '%s\n' "$subscription_token" >"$TSUB_STATE/subscription.token"
  chmod 640 "$TSUB_STATE/subscription.token" "$TSUB_SUBSCRIPTION_ROOT/index.html"
  if id tsub >/dev/null 2>&1; then
    subscription_group=$(id -gn tsub)
    chgrp -R "$subscription_group" "$TSUB_SUBSCRIPTION_ROOT" "$TSUB_STATE/start-subscription.sh" "$TSUB_STATE/subscription.token" "$TSUB_HTTPD_BIN" 2>/dev/null || true
    chmod 750 "$TSUB_SUBSCRIPTION_ROOT" "$TSUB_SUBSCRIPTION_ROOT/cgi-bin"
  fi
}

subscription_snapshot() {
  subscription_snapshot_root="$TSUB_TX/subscription.previous"
  mkdir -p "$subscription_snapshot_root"
  [ ! -d "$TSUB_STATE/subscription-web" ] || cp -pR "$TSUB_STATE/subscription-web" "$subscription_snapshot_root/subscription-web"
  for subscription_file in start-subscription.sh subscription.httpd subscription.token subscription.config.hash; do
    [ ! -f "$TSUB_STATE/$subscription_file" ] || cp -p "$TSUB_STATE/$subscription_file" "$subscription_snapshot_root/$subscription_file"
  done
}

subscription_restore_snapshot() {
  subscription_stop
  rm -rf "$TSUB_STATE/subscription-web"
  rm -f "$TSUB_STATE/start-subscription.sh" "$TSUB_STATE/subscription.httpd" "$TSUB_STATE/subscription.token" "$TSUB_STATE/subscription.config.hash"
  subscription_snapshot_root="$TSUB_TX/subscription.previous"
  [ -d "$subscription_snapshot_root" ] || return 0
  [ ! -d "$subscription_snapshot_root/subscription-web" ] || cp -pR "$subscription_snapshot_root/subscription-web" "$TSUB_STATE/subscription-web"
  for subscription_file in start-subscription.sh subscription.httpd subscription.token subscription.config.hash; do
    [ ! -f "$subscription_snapshot_root/$subscription_file" ] || cp -p "$subscription_snapshot_root/$subscription_file" "$TSUB_STATE/$subscription_file"
  done
  if id tsub >/dev/null 2>&1 && [ -d "$TSUB_STATE/subscription-web" ]; then
    subscription_group=$(id -gn tsub)
    chgrp -R "$subscription_group" "$TSUB_STATE/subscription-web" "$TSUB_STATE/start-subscription.sh" "$TSUB_STATE/subscription.token" 2>/dev/null || true
    find "$TSUB_STATE/subscription-web" -type d -exec chmod 750 {} \; 2>/dev/null || true
    find "$TSUB_STATE/subscription-web/cgi-bin" -type f -exec chmod 750 {} \; 2>/dev/null || true
    [ ! -f "$TSUB_STATE/subscription-web/index.html" ] || chmod 640 "$TSUB_STATE/subscription-web/index.html"
  fi
}

subscription_stop() {
  subscription_pids=''
  if [ -r "$TSUB_STATE/subscription.pid" ]; then
    subscription_pid=$(cat "$TSUB_STATE/subscription.pid" 2>/dev/null || true)
    case "$subscription_pid" in
      ''|*[!0-9]*) : ;;
      *) subscription_pids="$subscription_pids $subscription_pid" ;;
    esac
  fi
  for subscription_proc in /proc/[0-9]*; do
    [ -r "$subscription_proc/cmdline" ] || continue
    subscription_command=$(tr '\000' ' ' <"$subscription_proc/cmdline" 2>/dev/null || true)
    case "$subscription_command" in
      *' httpd '*" -h $TSUB_STATE/subscription-web"*) subscription_pids="$subscription_pids ${subscription_proc##*/}" ;;
    esac
  done
  for subscription_pid in $subscription_pids; do kill "$subscription_pid" 2>/dev/null || true; done
  subscription_wait=0
  while [ "$subscription_wait" -lt 5 ]; do
    subscription_alive=false
    for subscription_pid in $subscription_pids; do kill -0 "$subscription_pid" 2>/dev/null && subscription_alive=true; done
    [ "$subscription_alive" = true ] || break
    subscription_wait=$((subscription_wait + 1))
    sleep 1
  done
  for subscription_pid in $subscription_pids; do kill -0 "$subscription_pid" 2>/dev/null && kill -KILL "$subscription_pid" 2>/dev/null || true; done
  rm -f "$TSUB_STATE/subscription.pid"
}

subscription_start() {
  subscription_enabled || return 0
  subscription_stop
  [ -x "$TSUB_STATE/start-subscription.sh" ] || return 1
  "$TSUB_STATE/start-subscription.sh"
}

subscription_running() {
  subscription_enabled || return 1
  subscription_pid=$(cat "$TSUB_STATE/subscription.pid" 2>/dev/null || true)
  case "$subscription_pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$subscription_pid" 2>/dev/null
}

subscription_health_check() {
  subscription_enabled || return 0
  subscription_running || return 1
  subscription_token=$(cat "$TSUB_STATE/subscription.token" 2>/dev/null || true)
  subscription_url="http://127.0.0.1:$(kv_get subscription_server_port)/cgi-bin/$subscription_token"
  if have curl; then curl -fsS --max-time 5 "$subscription_url" >/dev/null
  elif have wget; then wget -qO- -T 5 "$subscription_url" >/dev/null
  else return 1; fi
}

subscription_append_event() {
  subscription_event_file=$1
  subscription_enabled || return 0
  subscription_running || return 0
  subscription_count=$(awk 'NF { count++ } END { print count + 0 }' "$TSUB_STATE/nodes.txt" 2>/dev/null || printf 0)
  printf 'subscriptionReady=true\nsubscriptionNodeCount=%s\n' "$subscription_count" >>"$subscription_event_file"
  [ ! -f "$TSUB_STATE/nodes.txt" ] || sed 's/^/cacheNode=/' "$TSUB_STATE/nodes.txt" >>"$subscription_event_file"
}

subscription_remove() {
  subscription_stop
  rm -rf "$TSUB_STATE/subscription-web"
  rm -f "$TSUB_STATE/start-subscription.sh" "$TSUB_STATE/subscription.httpd" "$TSUB_STATE/subscription.token"
}

# module: 39-push.sh
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

# module: 40-service.sh
active_core() {
  core_name=$(basename "$TSUB_CORE_BIN")
  case "$core_name" in xray-*) printf xray ;; sing-box-*) printf sing-box ;; naive-*) printf naive ;; *) kv_get runtime_core ;; esac
}

prepare_service_identity() {
  TSUB_SERVICE_USER=''
  [ "$(id -u)" -eq 0 ] || return 0
  if ! id tsub >/dev/null 2>&1; then
    if have useradd; then useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin tsub >/dev/null 2>&1 || true
    elif have adduser; then adduser -S -D -H -s /sbin/nologin tsub >/dev/null 2>&1 || true
    fi
  fi
  if ! id tsub >/dev/null 2>&1; then i18n_degraded "无法创建 tsub 系统用户，服务将以 root 运行" "The tsub system user could not be created; the service will run as root"; return 0; fi
  TSUB_SERVICE_USER=tsub
  low_port=false
  old_ifs=$IFS; IFS=,
  for spec in $(kv_get inbound_ports); do [ "${spec%/*}" -lt 1024 ] && low_port=true; done
  IFS=$old_ifs
  if [ "$low_port" = true ] && [ "$TSUB_INIT" != systemd ]; then
    if have setcap; then setcap cap_net_bind_service=+ep "$TSUB_CORE_BIN" || TSUB_SERVICE_USER=''
    else TSUB_SERVICE_USER=''; fi
    [ -n "$TSUB_SERVICE_USER" ] || i18n_degraded "当前 init 缺少低端口降权能力，服务将以 root 运行" "The current init system cannot drop privileges for low ports; the service will run as root"
  fi
  if [ -n "$TSUB_SERVICE_USER" ] && [ "$TSUB_INIT" != systemd ] && [ "$TSUB_INIT" != openrc ] && ! have su-exec && ! setpriv_supports_identity && ! have runuser && ! have chpst && ! have s6-setuidgid; then
    TSUB_SERVICE_USER=''
    i18n_degraded "未找到可用降权工具，服务将以 root 运行" "No privilege-dropping tool was found; the service will run as root"
  fi
  [ -n "$TSUB_SERVICE_USER" ] || return 0
  service_group=$(id -gn "$TSUB_SERVICE_USER")
  chgrp "$service_group" "$TSUB_ETC" "$TSUB_STATE" "$TSUB_BIN" "$TSUB_CORE_BIN" "$TSUB_ETC/config.json" 2>/dev/null || true
  chmod 750 "$TSUB_ETC" "$TSUB_BIN" "$TSUB_CORE_BIN" 2>/dev/null || true
  chmod 770 "$TSUB_STATE" 2>/dev/null || true
  chmod 640 "$TSUB_ETC/config.json" 2>/dev/null || true
  touch "$TSUB_LOG"; chown "$TSUB_SERVICE_USER:$service_group" "$TSUB_LOG" 2>/dev/null || true
  [ ! -e "$TSUB_STATE/start-tunnels.sh" ] || { chgrp "$service_group" "$TSUB_STATE/start-tunnels.sh"; chmod 750 "$TSUB_STATE/start-tunnels.sh"; }
  [ ! -e "$TSUB_STATE/quick-tunnel-monitor.sh" ] || {
    chown "$TSUB_SERVICE_USER:$service_group" "$TSUB_STATE/quick-tunnel-monitor.sh"
    chmod 700 "$TSUB_STATE/quick-tunnel-monitor.sh"
  }
  [ ! -e "$TSUB_STATE/tunnel-supervisor.sh" ] || {
    chown "$TSUB_SERVICE_USER:$service_group" "$TSUB_STATE/tunnel-supervisor.sh"
    chmod 700 "$TSUB_STATE/tunnel-supervisor.sh"
  }
  [ ! -e "$TSUB_STATE/start-subscription.sh" ] || { chgrp "$service_group" "$TSUB_STATE/start-subscription.sh"; chmod 750 "$TSUB_STATE/start-subscription.sh"; }
  [ ! -e "$TSUB_STATE/traffic.state" ] || { chgrp "$service_group" "$TSUB_STATE/traffic.state"; chmod 640 "$TSUB_STATE/traffic.state"; }
  if [ -d "$TSUB_STATE/subscription-web" ]; then
    chgrp -R "$service_group" "$TSUB_STATE/subscription-web" "$TSUB_STATE/subscription.token" "$TSUB_STATE/subscription.httpd" 2>/dev/null || true
    find "$TSUB_STATE/subscription-web" -type d -exec chmod 750 {} \; 2>/dev/null || true
    find "$TSUB_STATE/subscription-web/cgi-bin" -type f -exec chmod 750 {} \; 2>/dev/null || true
  fi
  if [ -d "$TSUB_STATE/certificates" ]; then
    chgrp -R "$service_group" "$TSUB_STATE/certificates" 2>/dev/null || true
    find "$TSUB_STATE/certificates" -type d -exec chmod 750 {} \; 2>/dev/null || true
  fi
  for file in "$TSUB_STATE"/tunnel-*.token "$TSUB_STATE/quick-tunnel.token" "$TSUB_STATE/quick-tunnel.meta" "$TSUB_STATE"/certificates/certificates/*; do
    [ -e "$file" ] && chown "$TSUB_SERVICE_USER:$service_group" "$file" 2>/dev/null || true
  done
  for file in "$TSUB_STATE"/tunnel-*.log "$TSUB_STATE"/tunnel-*.pid "$TSUB_STATE"/tunnel-supervisor-*.pid "$TSUB_STATE"/quick-tunnel-monitor-*.pid "$TSUB_STATE/quick-tunnel.hostname" "$TSUB_STATE/quick-tunnel.hostname.nodes.cksum" "$TSUB_STATE/quick-tunnel.hostname.status"; do
    [ -e "$file" ] || continue
    chown "$TSUB_SERVICE_USER:$service_group" "$file" 2>/dev/null || true
    chmod 600 "$file" 2>/dev/null || true
  done
  subscription_httpd=$(cat "$TSUB_STATE/subscription.httpd" 2>/dev/null || true)
  [ -z "$subscription_httpd" ] || { chgrp "$service_group" "$subscription_httpd" 2>/dev/null || true; chmod 750 "$subscription_httpd" 2>/dev/null || true; }
}

service_stop() {
  subscription_stop
  tunnel_stop
  case "$TSUB_INIT" in
    systemd) systemctl stop tsub-core.service >/dev/null 2>&1 || true ;;
    openrc) rc-service tsub-core stop >/dev/null 2>&1 || true ;;
    runit) sv down tsub-core >/dev/null 2>&1 || true ;;
    s6) s6-svc -d /run/service/tsub-core >/dev/null 2>&1 || true ;;
    *) [ -r "$TSUB_STATE/core.pid" ] && kill "$(cat "$TSUB_STATE/core.pid")" 2>/dev/null || true ;;
  esac
  stop_managed_core_processes
}

stop_managed_core_processes() {
  managed_paths=''
  for identity in "$TSUB_STATE/core.identity" "$TSUB_STATE/core.previous.identity"; do
    [ -r "$identity" ] || continue
    managed_path=$(sed -n '1p' "$identity")
    case "$managed_path" in "$TSUB_BIN"/*) managed_paths="$managed_paths $managed_path" ;; esac
  done
  case "${TSUB_CORE_BIN:-}" in "$TSUB_BIN"/*) managed_paths="$managed_paths $TSUB_CORE_BIN" ;; esac
  [ -n "$managed_paths" ] || { rm -f "$TSUB_STATE/core.pid" /run/tsub-core.pid; return 0; }
  managed_pids=''
  for process_dir in /proc/[0-9]*; do
    [ -d "$process_dir" ] || continue
    process_exe=$(readlink "$process_dir/exe" 2>/dev/null || true)
    for managed_path in $managed_paths; do
      if [ "$process_exe" = "$managed_path" ]; then
        process_pid=${process_dir##*/}
        kill "$process_pid" 2>/dev/null || true
        managed_pids="$managed_pids $process_pid"
        break
      fi
    done
  done
  [ -z "$managed_pids" ] || sleep 1
  for process_pid in $managed_pids; do kill -0 "$process_pid" 2>/dev/null && kill -KILL "$process_pid" 2>/dev/null || true; done
  rm -f "$TSUB_STATE/core.pid" /run/tsub-core.pid
}

service_start() {
  core=$(active_core)
  config="$TSUB_ETC/config.json"
  i18n_print "正在启用并启动 TSub 核心服务，请稍候..." "Enabling and starting the TSub core service, please wait..."
  case "$TSUB_INIT" in
    systemd)
      systemd_output="$TSUB_TMP/systemd-start.out"
      : >"$systemd_output"
      if ! systemctl daemon-reload >"$systemd_output" 2>&1 || ! systemctl enable --now tsub-core.service >>"$systemd_output" 2>&1; then
        cat "$systemd_output" >&2
        i18n_log ERROR "systemd 无法启用或启动 TSub 核心服务" "systemd could not enable or start the TSub core service"
        return 1
      fi
      ;;
    openrc) rc-update add tsub-core default >/dev/null 2>&1 || true; rc-service tsub-core restart ;;
    runit) sv up tsub-core ;;
    s6)
      if [ -d /run/service/tsub-core ]; then s6-svc -r /run/service/tsub-core
      else
        tunnel_start || return 1
        nohup "$TSUB_STATE/start-core.sh" >>"$TSUB_LOG" 2>&1 &
        printf '%s\n' "$!" >"$TSUB_STATE/core.pid"
      fi
      ;;
    rc-local|crontab)
      service_stop
      tunnel_start || return 1
      subscription_start || return 1
      if [ "$core" = xray ]; then
        nohup "$TSUB_CORE_BIN" run -config "$config" >>"$TSUB_LOG" 2>&1 &
      else
        nohup "$TSUB_CORE_BIN" run -c "$config" >>"$TSUB_LOG" 2>&1 &
      fi
      printf '%s\n' "$!" >"$TSUB_STATE/core.pid"
      ;;
    *)
      service_stop
      tunnel_start || return 1
      subscription_start || return 1
      if [ "$core" = xray ]; then
        nohup "$TSUB_CORE_BIN" run -config "$config" >>"$TSUB_LOG" 2>&1 &
      elif [ "$core" = naive ]; then
        nohup "$TSUB_CORE_BIN" run --config "$config" --adapter caddyfile >>"$TSUB_LOG" 2>&1 &
      else
        nohup "$TSUB_CORE_BIN" run -c "$config" >>"$TSUB_LOG" 2>&1 &
      fi
      printf '%s\n' "$!" >"$TSUB_STATE/core.pid"
      i18n_degraded "无受支持的持久化 init；已使用 nohup 立即运行" "No supported persistent init system was found; the service was started with nohup"
      ;;
  esac
}

install_service_definition() {
  core=$(active_core)
  if [ "$core" = xray ]; then args="run -config $TSUB_ETC/config.json"
  elif [ "$core" = naive ]; then args="run --config $TSUB_ETC/config.json --adapter caddyfile"
  else args="run -c $TSUB_ETC/config.json"; fi
  service_memory_environment=''
  case "$core" in xray|sing-box)
    service_memory_limit=$(core_go_memory_limit_mb 2>/dev/null || true)
    if [ -n "$service_memory_limit" ]; then
      service_memory_environment="GOMEMLIMIT=${service_memory_limit}MiB
GOGC=50
export GOMEMLIMIT GOGC"
    fi
    ;;
  esac
  start_script="$TSUB_TMP/start-core.sh"
  cat >"$start_script" <<EOF
#!/bin/sh
if [ -n "$TSUB_SERVICE_USER" ] && [ "\$(id -u)" -eq 0 ] && [ "\${1:-}" != --as-user ] && id tsub >/dev/null 2>&1; then
  if command -v su-exec >/dev/null 2>&1; then exec su-exec tsub "\$0" --as-user
  elif command -v setpriv >/dev/null 2>&1 && setpriv --help 2>&1 | grep -q -- '--reuid'; then exec setpriv --reuid=tsub --regid=tsub --clear-groups "\$0" --as-user
  elif command -v runuser >/dev/null 2>&1; then exec runuser -u tsub -- "\$0" --as-user
  fi
fi
[ ! -x "$TSUB_STATE/start-tunnels.sh" ] || "$TSUB_STATE/start-tunnels.sh"
[ ! -x "$TSUB_STATE/start-subscription.sh" ] || "$TSUB_STATE/start-subscription.sh"
printf '%s\n' "\$\$" >"$TSUB_STATE/core.pid"
$service_memory_environment
[ ! -w /proc/self/oom_score_adj ] || printf '500\n' >/proc/self/oom_score_adj 2>/dev/null || true
exec $TSUB_CORE_BIN $args
EOF
  atomic_install "$start_script" "$TSUB_STATE/start-core.sh" 700
  if [ -n "$TSUB_SERVICE_USER" ]; then chgrp "$service_group" "$TSUB_STATE/start-core.sh"; chmod 750 "$TSUB_STATE/start-core.sh"; fi
  case "$TSUB_INIT" in
    systemd)
      unit="$TSUB_TMP/tsub-core.service"
      cat >"$unit" <<EOF
[Unit]
Description=TSub protocol core
After=network-online.target
[Service]
Type=simple
${TSUB_SERVICE_USER:+User=$TSUB_SERVICE_USER}
${TSUB_SERVICE_USER:+Group=$service_group}
${TSUB_SERVICE_USER:+AmbientCapabilities=CAP_NET_BIND_SERVICE}
ExecStart=$TSUB_STATE/start-core.sh
Restart=on-failure
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF
      atomic_install "$unit" /etc/systemd/system/tsub-core.service 644
      ;;
    openrc)
      openrc_file="$TSUB_TMP/tsub-core.openrc"
      cat >"$openrc_file" <<EOF
#!/sbin/openrc-run
name="TSub protocol core"
command="$TSUB_STATE/start-core.sh"
${TSUB_SERVICE_USER:+command_user="$TSUB_SERVICE_USER:$service_group"}
command_background=true
pidfile="/run/tsub-core.pid"
depend() { need net; }
EOF
      atomic_install "$openrc_file" /etc/init.d/tsub-core 755
      ;;
    runit)
      mkdir -p /etc/sv/tsub-core
      atomic_install "$start_script" /etc/sv/tsub-core/run 755
      if [ -d /var/service ]; then ln -snf /etc/sv/tsub-core /var/service/tsub-core
      elif [ -d /etc/service ]; then ln -snf /etc/sv/tsub-core /etc/service/tsub-core
      else i18n_degraded "runit 未发现服务扫描目录" "runit service scan directory was not found"; TSUB_INIT=none; fi
      ;;
    rc-local)
      grep -q "$TSUB_STATE/start-core.sh" /etc/rc.local 2>/dev/null || sed -i "\|^exit 0$|i $TSUB_STATE/start-core.sh >/dev/null 2>&1 \&" /etc/rc.local
      ;;
    crontab)
      existing="$TSUB_TMP/crontab"
      crontab -l >"$existing" 2>/dev/null || :
      grep -q "$TSUB_STATE/start-core.sh" "$existing" || printf '@reboot %s >/dev/null 2>&1\n' "$TSUB_STATE/start-core.sh" >>"$existing"
      crontab "$existing"
      ;;
    s6)
      if [ -d /etc/services.d ]; then
        mkdir -p /etc/services.d/tsub-core
        atomic_install "$start_script" /etc/services.d/tsub-core/run 755
      else
        i18n_degraded "s6 未发现 /etc/services.d 持久化目录" "s6 persistent directory /etc/services.d was not found"
        TSUB_INIT=none
      fi
      ;;
  esac
}

remove_service_definition() {
  case "$TSUB_INIT" in
    systemd)
      systemctl disable tsub-core.service >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/tsub-core.service
      systemctl daemon-reload
      ;;
    openrc) rc-update del tsub-core default >/dev/null 2>&1 || true; rm -f /etc/init.d/tsub-core ;;
    runit) rm -f /var/service/tsub-core /etc/service/tsub-core /etc/sv/tsub-core/run; rmdir /etc/sv/tsub-core 2>/dev/null || true ;;
    s6) rm -f /etc/services.d/tsub-core/run; rmdir /etc/services.d/tsub-core 2>/dev/null || true ;;
    rc-local) sed -i "\|$TSUB_STATE/start-core.sh|d" /etc/rc.local 2>/dev/null || true ;;
    crontab)
      cron_file="$TSUB_TMP/service.cron"
      crontab -l 2>/dev/null | grep -v "$TSUB_STATE/start-core.sh" >"$cron_file" || true
      crontab "$cron_file" 2>/dev/null || true
      ;;
  esac
  rm -f "$TSUB_STATE/start-core.sh" "$TSUB_STATE/start-tunnels.sh" "$TSUB_STATE/tunnel-supervisor.sh" "$TSUB_STATE/quick-tunnel-monitor.sh" "$TSUB_STATE/core.pid" /run/tsub-core.pid
}

process_rss_mb() {
  pid=''
  if [ "$TSUB_INIT" = openrc ] && [ -r /run/tsub-core.pid ]; then pid=$(cat /run/tsub-core.pid)
  elif [ -r "$TSUB_STATE/core.pid" ]; then pid=$(cat "$TSUB_STATE/core.pid"); fi
  [ "$TSUB_INIT" = systemd ] && pid=$(systemctl show -p MainPID --value tsub-core.service 2>/dev/null || true)
  case "$pid" in ''|0|*[!0-9]*) printf 0; return ;; esac
  awk '/VmRSS:/ {printf "%d", ($2 + 1023) / 1024; exit}' "/proc/$pid/status" 2>/dev/null || printf 0
}

health_check() {
  wait_seconds=${TSUB_HEALTH_WAIT:-5}
  case "$wait_seconds" in ''|*[!0-9]*) wait_seconds=5 ;; esac
  [ "$wait_seconds" -gt 0 ] || wait_seconds=1
  i18n_print "正在等待核心服务通过健康检查（最长 ${wait_seconds} 秒）..." "Waiting for the core service health check (up to ${wait_seconds} seconds)..."
  health_elapsed=0
  while [ "$health_elapsed" -lt "$wait_seconds" ]; do
    TSUB_CORE_RSS=$(process_rss_mb)
    TSUB_CLOUDFLARED_RSS=$(tunnel_health_rss 2>/dev/null || printf 0)
    rss=$((TSUB_CORE_RSS + TSUB_CLOUDFLARED_RSS))
    TSUB_CURRENT_RSS=$rss
    health_tunnel_ready=true
    tunnel_health_rss >/dev/null 2>&1 || health_tunnel_ready=false
    if [ "$rss" -gt 0 ] && [ "$health_tunnel_ready" = true ] && subscription_health_check >/dev/null 2>&1; then
      if [ $((rss * 100)) -gt $((TSUB_MEMORY_MB * 80)) ]; then
        i18n_log ERROR "核心 RSS ${rss}MB 超过 80% 内存预算" "Core RSS ${rss}MB exceeds 80% of the memory budget"
        return 1
      fi
      i18n_print "健康检查通过，TSub 核心服务运行正常。" "Health check passed; the TSub core service is running normally."
      return 0
    fi
    health_elapsed=$((health_elapsed + 1))
    [ "$health_elapsed" -ge "$wait_seconds" ] || sleep 1
    if [ "$health_elapsed" -lt "$wait_seconds" ] && [ $((health_elapsed % 5)) -eq 0 ]; then
      i18n_print "核心服务仍在启动，已等待 ${health_elapsed} 秒..." "The core service is still starting; waited ${health_elapsed} seconds..."
    fi
  done
  TSUB_CORE_RSS=$(process_rss_mb)
  TSUB_CLOUDFLARED_RSS=$(tunnel_health_rss 2>/dev/null || printf 0)
  TSUB_CURRENT_RSS=$((TSUB_CORE_RSS + TSUB_CLOUDFLARED_RSS))
  [ "$TSUB_CORE_RSS" -gt 0 ] || i18n_log ERROR "核心进程未运行" "The core process is not running"
  tunnel_health_rss >/dev/null 2>&1 || i18n_log ERROR "Cloudflared 进程未运行" "The cloudflared process is not running"
  subscription_health_check >/dev/null 2>&1 || i18n_log ERROR "服务器订阅服务未通过健康检查" "The server subscription service failed its health check"
  i18n_log ERROR "健康检查在 ${wait_seconds} 秒后超时" "Health check timed out after ${wait_seconds} seconds"
  return 1
}

# module: 50-transaction.sh
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

# module: 55-maintenance.sh
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
  printf '\n' >>"$TSUB_TMP/runtime.conf"
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

# module: 56-control-menu.sh
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

# module: 60-summary.sh
summary_decode_value() {
  summary_key=$1
  summary_target="$TSUB_TMP/summary.$summary_key"
  b64_decode_file "$summary_key" "$summary_target" 2>/dev/null || return 1
  cat "$summary_target"
}

summary_subscription_host() {
  summary_host=$(kv_get subscription_hostname)
  [ -n "$summary_host" ] || summary_host=${TSUB_HOSTNAME:-}
  case "$summary_host" in \[*\]) printf '%s' "$summary_host" ;; *:*) printf '[%s]' "$summary_host" ;; *) printf '%s' "$summary_host" ;; esac
}

runtime_local_time() {
  date '+%Y/%m/%d %H:%M:%S'
}

record_runtime_change_time() {
  runtime_time_file="$TSUB_TMP/deployment-time"
  runtime_local_time >"$runtime_time_file"
  atomic_install "$runtime_time_file" "$TSUB_STATE/deployment-time" 600
}

summary_number() {
  case "$1" in ''|*[!0-9]*) printf 0 ;; *) printf '%s' "$1" ;; esac
}

summary_traffic_backend() {
  summary_backend=$(traffic_backend 2>/dev/null || printf unavailable)
  case "$summary_backend" in
    core-xray) i18n_text '核心统计 · Xray' 'Core statistics · Xray' ;;
    core-singbox) i18n_text '核心统计 · sing-box' 'Core statistics · sing-box' ;;
    nftables|iptables) printf '%s · %s' "$(i18n_text '端口统计' 'Port statistics')" "$summary_backend" ;;
    *) i18n_text '统计不可用' 'Statistics unavailable' ;;
  esac
}

print_runtime_basic_info() {
  printf '\n'; i18n_print 'TSub Proxy 基础信息' 'TSub Proxy basic information'
  summary_deployment_time=$(cat "$TSUB_STATE/deployment-time" 2>/dev/null || true)
  [ -n "$summary_deployment_time" ] || summary_deployment_time=$(i18n_text '未记录（重新 Apply 后生成）' 'Not recorded (generated after applying again)')
  printf '%s%s\n' "$(i18n_text '部署时间：' 'Deployment time: ')" "$summary_deployment_time"

  summary_core=$(kv_get runtime_core); summary_core=${summary_core:-unknown}
  summary_tier=$(kv_get runtime_tier_mode)
  [ -n "$summary_tier" ] || summary_tier=$(kv_get runtime_tier)
  [ -n "$summary_tier" ] || summary_tier=${TSUB_TIER:-auto}
  summary_node_count=$(awk 'NF { count++ } END { print count + 0 }' "$TSUB_STATE/nodes.txt" 2>/dev/null || printf 0)
  summary_node_count=$(summary_number "$summary_node_count")
  printf '%s · %s · %s %s' "$summary_core" "$summary_tier" "$summary_node_count" "$(i18n_text '个节点' 'nodes')"

  [ "$(kv_get certificate_mode)" != self-signed ] || printf ' · %s' "$(i18n_text '自签证书/指纹固定' 'self-signed certificate/pinning')"
  if subscription_enabled; then
    printf ' · %s%s' "$(i18n_text '服务器订阅：' 'server subscription: ')" "$(kv_get subscription_server_port)"
    if [ "$(kv_get subscription_traffic_enabled)" = true ]; then
      printf '/%s · %s' "$(i18n_text '流量统计' 'traffic statistics')" "$(summary_traffic_backend)"
    fi
  fi

  summary_rss=$(process_rss_mb 2>/dev/null || printf 0)
  summary_tunnel_rss=$(tunnel_health_rss 2>/dev/null || printf 0)
  summary_rss=$(summary_number "$summary_rss")
  summary_tunnel_rss=$(summary_number "$summary_tunnel_rss")
  summary_rss=$((summary_rss + summary_tunnel_rss))
  printf ' · %s/%s · %s/%sMB' "${TSUB_CONTAINER:-unknown}" "${TSUB_INIT:-none}" "$summary_rss" "${TSUB_MEMORY_MB:-0}"
  summary_control=${TSUB_CONTROL_COMMAND_ACTUAL:-}
  [ -n "$summary_control" ] || summary_control=$(kv_get control_command)
  [ -z "$summary_control" ] || printf ' · %s%s' "$(i18n_text '服务器命令：' 'server command: ')" "$summary_control"
  printf '\n'
}

print_connection_info() {
  printf '%s%s %s\n' "$(i18n_text '核心：' 'Core: ')" "$(kv_get runtime_core)" "${TSUB_CORE_VERSION:-$(kv_get "$(kv_get runtime_core)_version")}"
  if [ -s "$TSUB_STATE/nodes.txt" ]; then
    printf '\n'; i18n_print '注意：以下节点链接包含 UUID、密码等敏感凭据，请妥善保管。' 'Caution: the following node links contain sensitive credentials such as UUIDs and passwords. Store them securely.'
    i18n_print '节点信息：' 'Node information:'; printf '\n'
    if [ -s "$TSUB_STATE/node-details.txt" ]; then cat "$TSUB_STATE/node-details.txt"; printf '\n'
    else cat "$TSUB_STATE/nodes.txt"; fi
  else
    i18n_print '节点信息：当前没有可输出的节点' 'Node information: no nodes are available for output'
  fi
  if subscription_enabled; then
    summary_host=$(summary_subscription_host)
    summary_token=$(cat "$TSUB_STATE/subscription.token" 2>/dev/null || true)
    if [ -n "$summary_host" ] && [ -n "$summary_token" ]; then
      if [ "$(kv_get subscription_address_mode)" = dual ]; then
        summary_ipv4=$(kv_get subscription_ipv4); summary_ipv6=$(kv_get subscription_ipv6)
        [ -z "$summary_ipv4" ] || printf '\n%shttp://%s:%s/cgi-bin/%s\n' "$(i18n_text '服务器本地 HTTP 订阅（IPv4）：' 'Local server HTTP subscription (IPv4): ')" "$summary_ipv4" "$(kv_get subscription_server_port)" "$summary_token"
        [ -z "$summary_ipv6" ] || printf '%shttp://[%s]:%s/cgi-bin/%s\n' "$(i18n_text '服务器本地 HTTP 订阅（IPv6）：' 'Local server HTTP subscription (IPv6): ')" "$summary_ipv6" "$(kv_get subscription_server_port)" "$summary_token"
      else
        printf '\n%shttp://%s:%s/cgi-bin/%s\n' "$(i18n_text '服务器本地 HTTP 订阅：' 'Local server HTTP subscription: ')" "$summary_host" "$(kv_get subscription_server_port)" "$summary_token"
      fi
    fi
    summary_mirror=$(summary_decode_value subscription_mirror_url_b64 2>/dev/null || true)
    [ -z "$summary_mirror" ] || printf '%s%s\n' "$(i18n_text '主控 HTTPS 镜像订阅：' 'Controller HTTPS mirror subscription: ')" "$summary_mirror"
  else
    printf '\n'; i18n_print '服务器订阅：未启用服务器订阅' 'Server subscription: disabled'
  fi
}

print_runtime_summary() {
  summary_action=$1
  if [ "${TSUB_SUPPRESS_SENSITIVE_OUTPUT:-false}" = true ]; then
    case "$summary_action" in update) i18n_print 'TSub Proxy 更新成功' 'TSub Proxy updated successfully' ;; repair) i18n_print 'TSub Proxy 修复成功' 'TSub Proxy repaired successfully' ;; *) i18n_print 'TSub Proxy 安装成功' 'TSub Proxy installed successfully' ;; esac
    return 0
  fi
  printf '\n'; i18n_print 'TSub Proxy 安装结果' 'TSub Proxy installation result'
  print_connection_info
  if push_enabled; then printf '%s%s %s\n' "$(i18n_text '主动推送：已开启（每 ' 'Push: enabled (every ')" "$(push_interval_minutes)" "$(i18n_text '分钟）' 'minutes)')"; else i18n_print '主动推送：未开启' 'Push: disabled'; fi
  printf '%s%s\n' "$(i18n_text '流量统计：' 'Traffic statistics: ')" "$(traffic_backend 2>/dev/null || printf unavailable)"
  if [ -n "${TSUB_CONTROL_COMMAND_ACTUAL:-}" ]; then printf '%s%s\n' "$(i18n_text '服务器控制命令：' 'Server control command: ')" "$TSUB_CONTROL_COMMAND_ACTUAL"; fi
  [ -z "${TSUB_DEGRADED_REASON:-}" ] || printf '%s%s\n' "$(i18n_text '降级原因：' 'Degraded reason: ')" "$TSUB_DEGRADED_REASON"
  case "$summary_action" in update) i18n_print 'TSub Proxy 更新成功' 'TSub Proxy updated successfully' ;; repair) i18n_print 'TSub Proxy 修复成功' 'TSub Proxy repaired successfully' ;; *) i18n_print 'TSub Proxy 安装成功' 'TSub Proxy installed successfully' ;; esac
}

# module: 90-main.sh
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
    agent-install) install_agent_service "$TSUB_BIN/tsub-proxy.sh" "$TSUB_ETC/runtime.conf" ;;
    edge-probe) edge_probe ;;
    menu) control_menu ;;
    restart) plan_runtime; load_installed_core; ensure_tunnel_binary; prepare_service_identity; traffic_checkpoint; service_stop; service_start; health_check; traffic_ensure_rules; traffic_checkpoint; emit_event succeeded "$(i18n_text '重启完成' 'Restart completed')" ;;
    rollback) load_installed_core; rollback_runtime; record_runtime_change_time ;;
    uninstall) uninstall_runtime ;;
    *) i18n_die "未知操作: $action" "Unknown operation: $action" ;;
  esac
  sanitize_runtime_log
  trim_runtime_log
}

main "$@"

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

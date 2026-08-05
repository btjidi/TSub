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
    printf '依赖检查：已满足当前操作所需能力，无需安装\n'
    return 0
  fi
  printf '依赖检查：缺少 %s\n' "$TSUB_MISSING_DEPENDENCIES"
  if [ "$dependency_action" = plan ]; then
    printf '计划模式不会修改系统；建议安装软件包：%s\n' "${TSUB_REQUIRED_PACKAGES:-无法自动映射}"
    return 2
  fi
  case "$dependency_action" in apply|update|repair) : ;; *) printf '当前操作不会自动安装依赖\n'; return 2 ;; esac
  dependency_manager=$(dependency_package_manager 2>/dev/null || true)
  [ -n "$dependency_manager" ] || { printf '无法为该系统选择受支持的包管理器；请手动补齐：%s\n' "$TSUB_MISSING_DEPENDENCIES" >&2; return 2; }
  TSUB_DEPENDENCY_USE_SUDO=false
  if [ "$(id -u)" -ne 0 ]; then
    if have sudo && sudo -n true >/dev/null 2>&1; then TSUB_DEPENDENCY_USE_SUDO=true
    else printf '无法无交互提权。请安装：%s\n' "$TSUB_REQUIRED_PACKAGES" >&2; return 2; fi
  fi
  printf '依赖安装：使用 %s 最小化安装 %s\n' "$dependency_manager" "$TSUB_REQUIRED_PACKAGES"
  dependency_attempt=1
  while ! install_required_dependencies_once "$dependency_manager"; do
    [ "$dependency_attempt" -lt 2 ] || { printf '依赖安装失败\n' >&2; return 2; }
    dependency_attempt=$((dependency_attempt + 1))
    printf '依赖安装失败，正在进行最后一次重试\n' >&2
  done
  detect_required_dependencies "$dependency_action"
  [ -z "$TSUB_MISSING_DEPENDENCIES" ] || { printf '依赖安装后仍缺少：%s\n' "$TSUB_MISSING_DEPENDENCIES" >&2; return 2; }
  printf '依赖安装：完成\n'
}

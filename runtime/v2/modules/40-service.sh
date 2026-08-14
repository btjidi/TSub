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
        tunnel_start named || return 1
        nohup "$TSUB_STATE/start-core.sh" >>"$TSUB_LOG" 2>&1 &
        printf '%s\n' "$!" >"$TSUB_STATE/core.pid"
      fi
      ;;
    rc-local|crontab)
      service_stop
      tunnel_start named || return 1
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
      tunnel_start named || return 1
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
[ ! -x "$TSUB_STATE/start-tunnels.sh" ] || "$TSUB_STATE/start-tunnels.sh" named
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
    tunnel_health_rss named >/dev/null 2>&1 || health_tunnel_ready=false
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
  tunnel_health_rss named >/dev/null 2>&1 || true
  subscription_health_check >/dev/null 2>&1 || i18n_log ERROR "服务器订阅服务未通过健康检查" "The server subscription service failed its health check"
  i18n_log ERROR "健康检查在 ${wait_seconds} 秒后超时" "Health check timed out after ${wait_seconds} seconds"
  return 1
}

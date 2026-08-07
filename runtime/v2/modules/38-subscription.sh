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

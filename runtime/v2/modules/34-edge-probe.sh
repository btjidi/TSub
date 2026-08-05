edge_probe_number() {
  case "$1" in ''|*[!0-9]*) printf 0 ;; *) printf '%s' "$1" ;; esac
}

edge_probe() {
  have curl || die 'CDN 真实握手检测需要 curl'
  edge_probe_host=$(kv_get edge_probe_hostname)
  edge_probe_port=$(kv_get edge_probe_port)
  case "$edge_probe_host" in ''|*[!A-Za-z0-9.-]*) die 'CDN 握手入口域名无效' ;; esac
  case "$edge_probe_port" in 443|2053|2083|2087|2096|8443) ;; *) die 'CDN 握手端口无效' ;; esac
  edge_probe_address_file="$TSUB_TMP/edge-probe.address"
  edge_probe_path_file="$TSUB_TMP/edge-probe.path"
  b64_decode_file edge_probe_address_b64 "$edge_probe_address_file" || die 'CDN 握手地址无效'
  b64_decode_file edge_probe_path_b64 "$edge_probe_path_file" || die 'CDN 握手路径无效'
  edge_probe_address=$(cat "$edge_probe_address_file")
  edge_probe_path=$(cat "$edge_probe_path_file")
  case "$edge_probe_address" in ''|*[!A-Za-z0-9.:-]*) die 'CDN 握手地址无效' ;; esac
  case "$edge_probe_path" in /*) ;; *) die 'CDN 握手路径无效' ;; esac

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
    printf 'CDN 真实握手通过：TLS、Host/SNI 与 WebSocket 101 正常（%sms）\n' "$edge_probe_latency"
    return 0
  fi
  printf 'CDN 真实握手失败：DNS=%s TCP=%s TLS=%s Host/SNI=%s WebSocket101=%s（%sms）\n' \
    "$edge_probe_dns" "$edge_probe_tcp" "$edge_probe_tls_ok" "$edge_probe_host_sni" "$edge_probe_ws" "$edge_probe_latency" >&2
  return 1
}

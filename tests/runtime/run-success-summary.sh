#!/bin/sh
# shellcheck disable=SC2034
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/38-subscription.sh"
. "$ROOT/runtime/v2/modules/39-push.sh"
. "$ROOT/runtime/v2/modules/60-summary.sh"

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-summary.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
TSUB_TMP="$TEST_TMP/tmp"; TSUB_STATE="$TEST_TMP/state"; mkdir -p "$TSUB_TMP" "$TSUB_STATE"
TSUB_CONFIG="$TEST_TMP/runtime.conf"
summary='VLESS 443/TCP - tcp
Hysteria2 51231/UDP - hysteria'
summary_b64=$(printf '%s' "$summary" | base64 | tr -d '\r\n')
mirror='https://tsub.example/api/deploy/subscriptions/test/token'
mirror_b64=$(printf '%s' "$mirror" | base64 | tr -d '\r\n')
cat >"$TSUB_CONFIG" <<EOF
runtime_core=xray
runtime_tier_mode=auto
xray_version=26.7.28
inbound_summary_b64=$summary_b64
certificate_mode=self-signed
subscription_server_enabled=true
subscription_server_port=51250
subscription_traffic_enabled=true
subscription_hostname=2001:db8::1
subscription_mirror_url_b64=$mirror_b64
push_enabled=false
push_url=
EOF
printf 'token-value\n' >"$TSUB_STATE/subscription.token"
printf 'vless://uuid@example.com:443#node\n' >"$TSUB_STATE/nodes.txt"
printf 'node（VLESS）\nvless://uuid@example.com:443#node\n' >"$TSUB_STATE/node-details.txt"
traffic_backend() { printf core-xray; }
process_rss_mb() { printf 21; }
tunnel_health_rss() { printf 0; }
[ "$(summary_traffic_backend)" = '核心统计 · Xray' ]
traffic_backend() { printf core-singbox; }
[ "$(summary_traffic_backend)" = '核心统计 · sing-box' ]
traffic_backend() { printf nftables; }
[ "$(summary_traffic_backend)" = '端口统计 · nftables' ]
traffic_backend() { printf iptables; }
[ "$(summary_traffic_backend)" = '端口统计 · iptables' ]
traffic_backend() { printf unavailable; }
[ "$(summary_traffic_backend)" = '统计不可用' ]
traffic_backend() { printf core-xray; }
TSUB_CONTROL_COMMAND_ACTUAL=tsub-2
TSUB_CONTAINER=lxc TSUB_INIT=openrc TSUB_MEMORY_MB=122 TSUB_TIER=small
runtime_local_time() { printf '2026/07/30 06:31:16\n'; }
record_runtime_change_time
[ "$(cat "$TSUB_STATE/deployment-time")" = '2026/07/30 06:31:16' ]
[ "$(stat -c '%a' "$TSUB_STATE/deployment-time" 2>/dev/null || stat -f '%Lp' "$TSUB_STATE/deployment-time")" = 600 ]
print_runtime_basic_info >"$TEST_TMP/basic-output"
grep -q '^TSub Proxy 基础信息$' "$TEST_TMP/basic-output"
grep -q '^部署时间：2026/07/30 06:31:16$' "$TEST_TMP/basic-output"
grep -q '^xray · auto · 1 个节点 · 自签证书/指纹固定 · 服务器订阅：51250/流量统计 · 核心统计 · Xray · lxc/openrc · 21/122MB · 服务器命令：tsub-2$' "$TEST_TMP/basic-output"
! grep -q 'vless://' "$TEST_TMP/basic-output"
TSUB_CORE_VERSION=26.7.28 TSUB_DEGRADED_REASON='' print_runtime_summary apply >"$TEST_TMP/output"
grep -q '^节点信息：' "$TEST_TMP/output"
grep -q '^node（VLESS）$' "$TEST_TMP/output"
grep -q '^vless://uuid@example.com:443#node$' "$TEST_TMP/output"
grep -q 'http://\[2001:db8::1\]:51250/cgi-bin/token-value' "$TEST_TMP/output"
grep -q "$mirror" "$TEST_TMP/output"
grep -q '^服务器控制命令：tsub-2$' "$TEST_TMP/output"
grep -q '^TSub Proxy 安装成功$' "$TEST_TMP/output"
[ "$(tail -n 1 "$TEST_TMP/output")" = 'TSub Proxy 安装成功' ]

rm -f "$TSUB_STATE/deployment-time"
print_runtime_basic_info >"$TEST_TMP/legacy-output"
grep -q '^部署时间：未记录（重新 Apply 后生成）$' "$TEST_TMP/legacy-output"
printf 'summary tests passed\n'

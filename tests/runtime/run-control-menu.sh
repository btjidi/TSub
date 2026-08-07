#!/bin/sh
# shellcheck disable=SC2034
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/38-subscription.sh"
. "$ROOT/runtime/v2/modules/39-push.sh"
. "$ROOT/runtime/v2/modules/56-control-menu.sh"
. "$ROOT/runtime/v2/modules/60-summary.sh"

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-control.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
TSUB_TMP="$TEST_TMP/tmp"; TSUB_STATE="$TEST_TMP/state"; TSUB_ETC="$TEST_TMP/etc"; TSUB_BIN="$TEST_TMP/bin"
mkdir -p "$TSUB_TMP" "$TSUB_STATE" "$TSUB_ETC" "$TSUB_BIN" "$TEST_TMP/home/.local/bin" "$TEST_TMP/path"
HOME="$TEST_TMP/home"; export HOME
TSUB_CONTROL_USER_BIN="$HOME/.local/bin"; TSUB_CONTROL_SYSTEM_BIN="$TEST_TMP/system-bin"
export TSUB_CONTROL_USER_BIN TSUB_CONTROL_SYSTEM_BIN
TSUB_CONFIG="$TEST_TMP/runtime.conf"; export TSUB_CONFIG
summary=$(printf 'VLESS 443/TCP - tcp' | base64 | tr -d '\r\n')
mirror=$(printf 'https://tsub.example/subscription' | base64 | tr -d '\r\n')
cat >"$TSUB_CONFIG" <<EOF
runtime_core=sing-box
runtime_tier_mode=auto
sing-box_version=1.11.15
control_command=tsub
inbound_summary_b64=$summary
subscription_server_enabled=false
subscription_mirror_url_b64=$mirror
push_enabled=false
push_url=
nodes_b64=$(printf 'vless://uuid@example.com:443#node' | base64 | tr -d '\r\n')
EOF
TSUB_CORE_VERSION=1.11.15; TSUB_DEGRADED_REASON=''; TSUB_CONTROL_COMMAND_ACTUAL=''
TSUB_CONTAINER=bare; TSUB_INIT=none; TSUB_MEMORY_MB=128; TSUB_TIER=small
export_nodes() { printf 'vless://uuid@example.com:443#node\n' >"$TSUB_STATE/nodes.txt"; }
traffic_backend() { printf unavailable; }
process_rss_mb() { printf 18; }
tunnel_health_rss() { printf 0; }
id() { [ "${1:-}" = -u ] && { printf '1000\n'; return 0; }; command id "$@"; }
have() { [ "$1" != sudo ] && command -v "$1" >/dev/null 2>&1; }

printf '#!/bin/sh\nexit 0\n' >"$TEST_TMP/path/tsub"
chmod 755 "$TEST_TMP/path/tsub"
PATH="$TEST_TMP/path:$PATH"; export PATH
runtime="$TSUB_BIN/tsub-proxy.sh"; persistent="$TSUB_ETC/runtime.conf"
printf '#!/bin/sh\n' >"$runtime"; cp "$TSUB_CONFIG" "$persistent"
install_control_command "$runtime" "$persistent"
[ "$TSUB_CONTROL_COMMAND_ACTUAL" = tsub-2 ]
grep -q '^# TSub Proxy managed control launcher$' "$HOME/.local/bin/tsub-2"
grep -q "exec '$runtime' menu" "$HOME/.local/bin/tsub-2"
[ "$(cat "$TSUB_STATE/control-command.name")" = tsub-2 ]

id() { [ "${1:-}" = -u ] && { printf '0\n'; return 0; }; command id "$@"; }
mkdir -p "$TSUB_CONTROL_SYSTEM_BIN"
install_control_command "$runtime" "$persistent"
[ -x "$TSUB_CONTROL_SYSTEM_BIN/tsub-2" ]
[ ! -e "$HOME/.local/bin/tsub-2" ]

sed 's/^control_command=.*/control_command=proxy-menu/' "$TSUB_CONFIG" >"$TEST_TMP/runtime-renamed.conf"
TSUB_CONFIG="$TEST_TMP/runtime-renamed.conf"
install_control_command "$runtime" "$persistent"
[ "$TSUB_CONTROL_COMMAND_ACTUAL" = proxy-menu ]
[ -x "$TSUB_CONTROL_SYSTEM_BIN/proxy-menu" ]
[ ! -e "$TSUB_CONTROL_SYSTEM_BIN/tsub-2" ]

cat >"$TEST_TMP/path/sudo" <<'EOF'
#!/bin/sh
[ "${1:-}" = -n ] && shift
[ "${1:-}" = true ] && exit 0
exec "$@"
EOF
chmod 755 "$TEST_TMP/path/sudo"
id() { [ "${1:-}" = -u ] && { printf '1000\n'; return 0; }; command id "$@"; }
have() { command -v "$1" >/dev/null 2>&1; }
TSUB_CONTROL_SYSTEM_BIN="$TEST_TMP/sudo-bin"; export TSUB_CONTROL_SYSTEM_BIN
install_control_command "$runtime" "$persistent"
[ -x "$TSUB_CONTROL_SYSTEM_BIN/proxy-menu" ]

export_nodes
printf '1\n0\n' | control_menu >"$TEST_TMP/menu-disabled.out"
grep -q '^TSub Proxy 基础信息$' "$TEST_TMP/menu-disabled.out"
grep -q '^部署时间：未记录（重新 Apply 后生成）$' "$TEST_TMP/menu-disabled.out"
grep -q '^sing-box · auto · 1 个节点 · bare/none · 18/128MB · 服务器命令：proxy-menu$' "$TEST_TMP/menu-disabled.out"
grep -q '显示全部节点与订阅链接' "$TEST_TMP/menu-disabled.out"
! grep -q '立即主动推送到主控' "$TEST_TMP/menu-disabled.out"
grep -q 'vless://uuid@example.com:443#node' "$TEST_TMP/menu-disabled.out"
grep -q '未启用服务器订阅' "$TEST_TMP/menu-disabled.out"

push_enabled() { return 0; }
push_snapshot() { : >"$TEST_TMP/pushed"; }
printf '2\n0\n' | control_menu >"$TEST_TMP/menu-enabled.out"
grep -q '立即主动推送到主控' "$TEST_TMP/menu-enabled.out"
grep -q '主动推送请求已发送' "$TEST_TMP/menu-enabled.out"
[ -f "$TEST_TMP/pushed" ]

uninstall_runtime() { : >"$TEST_TMP/uninstalled"; printf 'TSub Proxy 卸载成功\n'; }
printf '3\nn\n0\n' | control_menu >"$TEST_TMP/menu-uninstall-cancelled.out"
grep -q '输入 Y 确认' "$TEST_TMP/menu-uninstall-cancelled.out"
grep -q '已取消卸载' "$TEST_TMP/menu-uninstall-cancelled.out"
[ ! -e "$TEST_TMP/uninstalled" ]
printf '3\nY\n' | control_menu >"$TEST_TMP/menu-uninstalled.out"
grep -q 'TSub Proxy 卸载成功' "$TEST_TMP/menu-uninstalled.out"
[ -f "$TEST_TMP/uninstalled" ]

printf '\nruntime_output_language=en-US\n' >>"$TSUB_CONFIG"
printf '0\n' | control_menu >"$TEST_TMP/menu-english.out"
grep -q '^TSub Proxy basic information$' "$TEST_TMP/menu-english.out"
grep -q '^TSub Proxy control menu$' "$TEST_TMP/menu-english.out"
grep -q '^0. Exit$' "$TEST_TMP/menu-english.out"
! grep -q '控制菜单\|请选择\|退出' "$TEST_TMP/menu-english.out"

printf '#!/bin/sh\n# external file\n' >"$HOME/.local/bin/keep-me"
printf '%s\n' "$HOME/.local/bin/keep-me" >"$TSUB_STATE/control-command.path"
remove_control_command
[ -f "$HOME/.local/bin/keep-me" ]
printf 'control menu tests passed\n'

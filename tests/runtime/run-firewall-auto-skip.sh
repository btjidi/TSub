#!/bin/sh
# shellcheck disable=SC2034
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/35-firewall.sh"

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-firewall.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
TSUB_CONFIG="$TEST_TMP/runtime.conf"
TSUB_STATE="$TEST_TMP/state"
mkdir -p "$TSUB_STATE"
printf 'firewall_enabled=true\n' >"$TSUB_CONFIG"

nft() { printf 'called\n' >>"$TEST_TMP/firewall.called"; }
iptables() { printf 'called\n' >>"$TEST_TMP/firewall.called"; }
have() { return 0; }
id() { printf '0\n'; }

TSUB_DEGRADED_REASON=''
TSUB_TIER=tiny
TSUB_HAS_NET_ADMIN=true
firewall_ports_apply '51231/tcp'
[ ! -e "$TEST_TMP/firewall.called" ]
[ "$TSUB_DEGRADED_REASON" = 'tiny 档已跳过端口放行规则' ]

TSUB_DEGRADED_REASON=''
TSUB_TIER=small
TSUB_HAS_NET_ADMIN=false
firewall_ports_apply '51231/tcp'
[ ! -e "$TEST_TMP/firewall.called" ]
[ "$TSUB_DEGRADED_REASON" = '缺少 CAP_NET_ADMIN，已跳过端口放行规则' ]

#!/bin/sh
# shellcheck disable=SC2034
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-tunnel-memory.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/20-plan.sh"

TSUB_CONFIG="$TEST_TMP/runtime.conf"; TSUB_ARCH=amd64; TSUB_BIN="$TEST_TMP/bin"; TSUB_ETC="$TEST_TMP/etc"
TSUB_MEMORY_AVAILABLE_MB=512; TSUB_DISK_KB=1048576; TSUB_PID_LIMIT=max
TSUB_TIER=small; TSUB_HAS_NET_ADMIN=true; TSUB_HAS_TUN=true; TSUB_DEGRADED_REASON=''
mkdir -p "$TSUB_BIN" "$TSUB_ETC"
cat >"$TSUB_CONFIG" <<'EOF'
runtime_core=xray
inbound_count=1
inbound_ports=51231/tcp
tunnel_count=1
subscription_server_enabled=false
certificate_mode=self-signed
firewall_enabled=false
warp_backend=none
EOF
planned_core_is_installed() { return 0; }
emit_event() { :; }

TSUB_MEMORY_MB=127
plan_runtime 2>"$TEST_TMP/127.log"
grep -q 'cgroup 内存上限至少为 128MB' "$TEST_TMP/127.log"
TSUB_MEMORY_MB=128
plan_runtime 2>"$TEST_TMP/128.log"
if grep -q 'cgroup 内存上限至少为 128MB' "$TEST_TMP/128.log"; then
  printf '%s\n' '128 MB should not emit the Tunnel memory recommendation' >&2; exit 1
fi
printf '%s\n' 'Tunnel memory recommendation tests passed'

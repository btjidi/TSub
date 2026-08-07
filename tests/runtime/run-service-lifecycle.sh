#!/bin/sh
# shellcheck disable=SC2034 # assignments are consumed by sourced Runtime modules
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
managed_pid=''
unmanaged_pid=''
subscription_pid=''
cleanup() {
  [ -z "$managed_pid" ] || kill "$managed_pid" 2>/dev/null || true
  [ -z "$unmanaged_pid" ] || kill "$unmanaged_pid" 2>/dev/null || true
  [ -z "$subscription_pid" ] || kill -KILL "$subscription_pid" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/20-plan.sh"
. "$ROOT/runtime/v2/modules/38-subscription.sh"
. "$ROOT/runtime/v2/modules/40-service.sh"

TSUB_MEMORY_MB=64
[ "$(core_go_memory_limit_mb)" = 24 ]
TSUB_MEMORY_MB=96
[ "$(core_go_memory_limit_mb)" = 40 ]
TSUB_MEMORY_MB=97
if core_go_memory_limit_mb >/dev/null 2>&1; then
  echo 'standard-memory core unexpectedly received a Go memory limit' >&2
  exit 1
fi

cat >"$TMP/archive.conf" <<'EOF'
sing-box_amd64_format=tar.gz
EOF
TSUB_CONFIG="$TMP/archive.conf"
TSUB_ARCH=amd64
TSUB_MEMORY_MB=64
TSUB_MEMORY_AVAILABLE_MB=59
core=sing-box
install_rss=20
printf 'n\n' >"$TMP/archive.confirm"
: >"$TMP/archive.prompt"
if (TSUB_CONFIRM_INPUT="$TMP/archive.confirm" TSUB_CONFIRM_OUTPUT="$TMP/archive.prompt" require_install_headroom) >"$TMP/archive.out" 2>&1; then
  echo '64MB archive install unexpectedly passed the safety check' >&2
  exit 1
fi
grep -q '预解包 binary' "$TMP/archive.out"

cat >"$TMP/binary.conf" <<'EOF'
sing-box_amd64_format=binary
EOF
TSUB_CONFIG="$TMP/binary.conf"
TSUB_MEMORY_AVAILABLE_MB=36
require_install_headroom

printf 'Y\n' >"$TMP/confirm.y"
: >"$TMP/confirm.out"
TSUB_MEMORY_AVAILABLE_MB=16
TSUB_DEGRADED_REASON=''
TSUB_FORCE_LOW_MEMORY_INSTALL=false
TSUB_CONFIRM_INPUT="$TMP/confirm.y"
TSUB_CONFIRM_OUTPUT="$TMP/confirm.out"
require_install_headroom
[ "$TSUB_FORCE_LOW_MEMORY_INSTALL" = true ]
[ "$TSUB_DEGRADED_REASON" = '用户已确认低内存强制安装' ]
grep -q '输入 Y 强制安装' "$TMP/confirm.out"
: >"$TMP/confirm.out"
require_install_headroom
[ ! -s "$TMP/confirm.out" ]

printf 'n\n' >"$TMP/confirm.n"
if (TSUB_FORCE_LOW_MEMORY_INSTALL=false TSUB_CONFIRM_INPUT="$TMP/confirm.n" TSUB_CONFIRM_OUTPUT="$TMP/confirm.out" require_install_headroom) >"$TMP/rejected.out" 2>&1; then
  echo 'rejected low-memory install unexpectedly passed' >&2
  exit 1
fi
grep -q '用户未确认强制安装' "$TMP/rejected.out"
unset TSUB_CONFIRM_INPUT TSUB_CONFIRM_OUTPUT
TSUB_FORCE_LOW_MEMORY_INSTALL=false

TSUB_STATE="$TMP/state"
TSUB_BIN="$TMP/bin"
TSUB_CORE_BIN="$TSUB_BIN/xray-test"
mkdir -p "$TSUB_STATE" "$TSUB_BIN"
cp "$(command -v sleep)" "$TSUB_CORE_BIN"
chmod 700 "$TSUB_CORE_BIN"

"$TSUB_CORE_BIN" 60 &
managed_pid=$!
sleep 1
printf '%s\n' "$TSUB_CORE_BIN" >"$TSUB_STATE/core.identity"

sleep 60 &
unmanaged_pid=$!
stop_managed_core_processes
if kill -0 "$managed_pid" 2>/dev/null; then
  echo 'managed core process was not stopped' >&2
  exit 1
fi
managed_pid=''
kill -0 "$unmanaged_pid"

sh -c 'trap "" TERM; while :; do sleep 1; done' &
subscription_pid=$!
printf '%s\n' "$subscription_pid" >"$TSUB_STATE/subscription.pid"
subscription_stop
if kill -0 "$subscription_pid" 2>/dev/null; then
  echo 'subscription process was not stopped before restart' >&2
  exit 1
fi
subscription_pid=''

grep -q 'pidfile="/run/tsub-core.pid"' "$ROOT/runtime/v2/modules/40-service.sh"
grep -q 'chown "$TSUB_SERVICE_USER:$service_group" "$TSUB_STATE/tunnel-supervisor.sh"' "$ROOT/runtime/v2/modules/40-service.sh"
grep -q 'chmod 700 "$TSUB_STATE/tunnel-supervisor.sh"' "$ROOT/runtime/v2/modules/40-service.sh"
grep -q 'dependency_add_package gcompat' "$ROOT/runtime/v2/modules/15-dependencies.sh"
echo 'service lifecycle tests passed'

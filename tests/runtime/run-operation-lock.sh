#!/bin/sh
# shellcheck disable=SC2034 # assignments are consumed by sourced Runtime modules
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-operation-lock.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"

TSUB_STATE="$TEST_TMP/state"
TSUB_TMP="$TEST_TMP/runtime-tmp"
TSUB_DOWNLOAD_PART=''
TSUB_OPERATION_LOCK=''
TSUB_OPERATION_LOCK_HELD=false
TSUB_CALLBACK_URL=''
mkdir -p "$TSUB_STATE" "$TSUB_TMP"

acquire_runtime_operation_lock apply
[ "$TSUB_OPERATION_LOCK_HELD" = true ]
[ "$(cat "$TSUB_STATE/operation.lock/pid")" = "$$" ]
release_runtime_operation_lock
[ ! -e "$TSUB_STATE/operation.lock" ]

mkdir "$TSUB_STATE/operation.lock"
printf '999999\n' >"$TSUB_STATE/operation.lock/pid"
acquire_runtime_operation_lock uninstall
[ "$(cat "$TSUB_STATE/operation.lock/pid")" = "$$" ]
cleanup_runtime
[ ! -e "$TSUB_STATE/operation.lock" ]

mkdir -p "$TSUB_TMP" "$TSUB_STATE/operation.lock"
printf '%s\n' "$$" >"$TSUB_STATE/operation.lock/pid"
if (
  TSUB_OPERATION_LOCK_WAIT_SECONDS=0 TSUB_OPERATION_LOCK_POLL_SECONDS=1 acquire_runtime_operation_lock repair
) >"$TEST_TMP/timeout.out" 2>&1; then
  printf '%s\n' 'operation lock timeout unexpectedly succeeded' >&2
  exit 1
fi
grep -q '等待其他 TSub 操作完成超时' "$TEST_TMP/timeout.out"

printf '%s\n' 'Runtime operation lock tests passed'

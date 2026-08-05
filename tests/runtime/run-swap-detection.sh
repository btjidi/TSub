#!/bin/sh
# shellcheck disable=SC2034 # assignments are consumed by sourced Runtime modules
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-swap.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/10-detect.sh"

TSUB_PROC_MEMINFO="$TEST_TMP/meminfo"
TSUB_CGROUP_ROOT="$TEST_TMP/cgroup"
mkdir -p "$TSUB_CGROUP_ROOT"
cat >"$TSUB_PROC_MEMINFO" <<'EOF'
MemTotal:        1048576 kB
MemAvailable:     786432 kB
SwapTotal:        524288 kB
SwapFree:         393216 kB
EOF
printf '%s\n' 67108864 >"$TSUB_CGROUP_ROOT/memory.swap.current"
printf '%s\n' 268435456 >"$TSUB_CGROUP_ROOT/memory.swap.max"
detect_swap_resources
[ "$TSUB_SWAP_REPORTED" = true ]
[ "$TSUB_SWAP_TOTAL_MB" -eq 512 ]
[ "$TSUB_SWAP_FREE_MB" -eq 384 ]
[ "$TSUB_SWAP_USED_MB" -eq 128 ]
[ "$TSUB_CGROUP_SWAP_REPORTED" = true ]
[ "$TSUB_CGROUP_SWAP_CURRENT_MB" -eq 64 ]
[ "$TSUB_CGROUP_SWAP_LIMIT_MB" -eq 256 ]

printf '%s\n' max >"$TSUB_CGROUP_ROOT/memory.swap.max"
detect_swap_resources
[ "$TSUB_CGROUP_SWAP_LIMIT_MB" -eq -1 ]

rm -f "$TSUB_CGROUP_ROOT/memory.swap.current" "$TSUB_CGROUP_ROOT/memory.swap.max"
mkdir -p "$TSUB_CGROUP_ROOT/memory"
printf '%s\n' 100663296 >"$TSUB_CGROUP_ROOT/memory/memory.memsw.usage_in_bytes"
printf '%s\n' 67108864 >"$TSUB_CGROUP_ROOT/memory/memory.usage_in_bytes"
printf '%s\n' 402653184 >"$TSUB_CGROUP_ROOT/memory/memory.memsw.limit_in_bytes"
printf '%s\n' 134217728 >"$TSUB_CGROUP_ROOT/memory/memory.limit_in_bytes"
detect_swap_resources
[ "$TSUB_CGROUP_SWAP_CURRENT_MB" -eq 32 ]
[ "$TSUB_CGROUP_SWAP_LIMIT_MB" -eq 256 ]

TSUB_TMP="$TEST_TMP/runtime"
TSUB_CALLBACK_URL=https://controller.example/api/deploy/events
TSUB_CALLBACK_TOKEN=test-token
TSUB_STAGE=detect
TSUB_HOSTNAME=swap-test
mkdir -p "$TSUB_TMP"
curl() {
  for swap_argument in "$@"; do
    case "$swap_argument" in @*) cp "${swap_argument#@}" "$TEST_TMP/event.txt" ;; esac
  done
}
emit_event running 'swap detected'
grep -q '^swapReported=true$' "$TEST_TMP/event.txt"
grep -q '^swapTotalMb=512$' "$TEST_TMP/event.txt"
grep -q '^swapFreeMb=384$' "$TEST_TMP/event.txt"
grep -q '^swapUsedMb=128$' "$TEST_TMP/event.txt"
grep -q '^cgroupSwapReported=true$' "$TEST_TMP/event.txt"
grep -q '^cgroupSwapCurrentMb=32$' "$TEST_TMP/event.txt"
grep -q '^cgroupSwapLimitMb=256$' "$TEST_TMP/event.txt"

printf '%s\n' 'Runtime Swap detection tests passed'

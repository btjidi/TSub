#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
. "$ROOT/runtime/v2/modules/50-transaction.sh"

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-uninstall.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
TSUB_TMP="$TEST_TMP/tmp"; TSUB_STATE="$TEST_TMP/state"; TSUB_ETC="$TEST_TMP/etc"; TSUB_BIN="$TEST_TMP/bin"
mkdir -p "$TSUB_TMP" "$TSUB_STATE" "$TSUB_ETC" "$TSUB_BIN"
printf '2026/07/30 06:31:16\n' >"$TSUB_STATE/deployment-time"
printf '{}\n' >"$TSUB_ETC/config.json"

traffic_checkpoint() { :; }
service_stop() { :; }
push_uninstall_event() { : >"$TEST_TMP/uninstall-notified"; }
subscription_remove() { :; }
traffic_remove_rules() { :; }
firewall_remove() { :; }
remove_service_definition() { :; }
remove_maintenance() { :; }
emit_event() { [ "$1" = succeeded ] && [ "$2" = 'uninstall completed' ]; }

uninstall_runtime >"$TEST_TMP/success.out"
[ "$(tail -n 1 "$TEST_TMP/success.out")" = 'TSub Proxy 卸载成功' ]
[ ! -e "$TSUB_STATE/deployment-time" ]
[ ! -e "$TSUB_ETC/config.json" ]
[ -e "$TEST_TMP/uninstall-notified" ]

service_stop() { exit 1; }
if (uninstall_runtime) >"$TEST_TMP/failure.out" 2>&1; then
  printf 'uninstall failure path unexpectedly succeeded\n' >&2
  exit 1
fi
! grep -q 'TSub Proxy 卸载成功' "$TEST_TMP/failure.out"
printf 'uninstall summary tests passed\n'

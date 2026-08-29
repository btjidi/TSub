#!/bin/sh
# shellcheck disable=SC2034
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-agent-update.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/38-agent.sh"

TSUB_TMP="$TEST_TMP/tmp"
TSUB_STATE="$TEST_TMP/state"
TSUB_BIN="$TEST_TMP/bin"
TSUB_CONFIG="$TEST_TMP/runtime.conf"
mkdir -p "$TSUB_TMP" "$TSUB_STATE" "$TSUB_BIN"
printf '%s\n' 'agent_controller_url=https://controller.example/api/deploy/agent' >"$TSUB_CONFIG"

cat >"$TEST_TMP/new-runtime.sh" <<EOF
#!/bin/sh
printf '%s\n' updated >'$TEST_TMP/reloaded'
EOF
chmod 700 "$TEST_TMP/new-runtime.sh"
runtime_sha=$(sha256_file "$TEST_TMP/new-runtime.sh")
cat >"$TEST_TMP/rollback-runtime.sh" <<EOF
#!/bin/sh
printf '%s\n' rollback >'$TEST_TMP/rollback-installed'
EOF
chmod 700 "$TEST_TMP/rollback-runtime.sh"
rollback_sha=$(sha256_file "$TEST_TMP/rollback-runtime.sh")
cat >"$TEST_TMP/manifest.json" <<EOF
{
  "runtimeVersion": "9.9.9",
  "runtime": {
    "path": "/proxy/v2/tsub-proxy.sh",
    "sha256": "$runtime_sha"
  },
  "history": {
    "1.0.9": {
      "path": "/proxy/v2/history/1.0.9/tsub-proxy.sh",
      "sha256": "$rollback_sha",
      "bytes": 42
    }
  }
}
EOF
printf '%s\n' old >"$TSUB_BIN/tsub-proxy.sh"
chmod 700 "$TSUB_BIN/tsub-proxy.sh"

download_file() {
  case "$1" in
    https://controller.example/proxy/v2/manifest.json?v=*) cp "$TEST_TMP/manifest.json" "$2" ;;
    https://controller.example/proxy/v2/tsub-proxy.sh?v="$runtime_sha")
      [ "${FAIL_RUNTIME_DOWNLOAD:-false}" != true ] || return 56
      cp "$TEST_TMP/new-runtime.sh" "$2"
      ;;
    https://controller.example/proxy/v2/history/1.0.9/tsub-proxy.sh?v="$rollback_sha")
      cp "$TEST_TMP/rollback-runtime.sh" "$2"
      ;;
    *) return 1 ;;
  esac
}

FAIL_RUNTIME_DOWNLOAD=true
agent_maybe_update_runtime force 2>"$TEST_TMP/update-failure.log"
[ ! -e "$TSUB_STATE/runtime.update-checked-at" ]
[ "$(cat "$TSUB_BIN/tsub-proxy.sh")" = old ]
grep -q '将在下一轮 Agent 轮询重试' "$TEST_TMP/update-failure.log"
unset FAIL_RUNTIME_DOWNLOAD

(agent_maybe_update_runtime)
[ "$(cat "$TEST_TMP/reloaded")" = updated ]
[ "$(sha256_file "$TSUB_BIN/tsub-proxy.sh")" = "$runtime_sha" ]
[ "$(stat -c '%a' "$TSUB_BIN/tsub-proxy.sh")" = 700 ]

mkdir -p "$TSUB_TMP"
printf '%s\n' "runtime_target_version=1.0.9" "runtime_target_path=/proxy/v2/history/1.0.9/tsub-proxy.sh" "runtime_target_sha256=$rollback_sha" >>"$TSUB_CONFIG"
agent_maybe_update_runtime force no-reload
[ "$(cat "$TSUB_BIN/tsub-proxy.sh")" = rollback ]
[ "$(sha256_file "$TSUB_BIN/tsub-proxy.sh")" = "$rollback_sha" ]

echo 'agent self-update tests passed'

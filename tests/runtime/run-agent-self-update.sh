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
TSUB_AGENT_URL=https://controller.example/api/deploy/agent
mkdir -p "$TSUB_TMP" "$TSUB_STATE" "$TSUB_BIN"

cat >"$TEST_TMP/new-runtime.sh" <<EOF
#!/bin/sh
printf '%s\n' updated >'$TEST_TMP/reloaded'
EOF
chmod 700 "$TEST_TMP/new-runtime.sh"
runtime_sha=$(sha256_file "$TEST_TMP/new-runtime.sh")
cat >"$TEST_TMP/manifest.json" <<EOF
{
  "runtimeVersion": "9.9.9",
  "runtime": {
    "path": "/proxy/v2/tsub-proxy.sh",
    "sha256": "$runtime_sha"
  }
}
EOF
printf '%s\n' old >"$TSUB_BIN/tsub-proxy.sh"
chmod 700 "$TSUB_BIN/tsub-proxy.sh"

download_file() {
  case "$1" in
    https://controller.example/proxy/v2/manifest.json?v=*) cp "$TEST_TMP/manifest.json" "$2" ;;
    https://controller.example/proxy/v2/tsub-proxy.sh?v="$runtime_sha") cp "$TEST_TMP/new-runtime.sh" "$2" ;;
    *) return 1 ;;
  esac
}

(agent_maybe_update_runtime)
[ "$(cat "$TEST_TMP/reloaded")" = updated ]
[ "$(sha256_file "$TSUB_BIN/tsub-proxy.sh")" = "$runtime_sha" ]
[ "$(stat -c '%a' "$TSUB_BIN/tsub-proxy.sh")" = 700 ]

echo 'agent self-update tests passed'

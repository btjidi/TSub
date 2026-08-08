#!/bin/sh
# shellcheck disable=SC2034
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-agent-heartbeat.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/20-plan.sh"
. "$ROOT/runtime/v2/modules/38-agent.sh"
. "$ROOT/runtime/v2/modules/60-summary.sh"

grep -q 'retry="TERM/10/KILL/5"' "$ROOT/runtime/v2/modules/38-agent.sh"

TSUB_TMP="$TEST_TMP/tmp"
TSUB_STATE="$TEST_TMP/state"
TSUB_BIN="$TEST_TMP/bin"
TSUB_LOG="$TSUB_STATE/runtime.log"
TSUB_ARCH=amd64
mkdir -p "$TSUB_TMP" "$TSUB_STATE" "$TSUB_BIN"

printf 'cached sing-box binary\n' >"$TEST_TMP/core"
binary_sha=$(sha256_file "$TEST_TMP/core")
archive_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TSUB_CONFIG="$TEST_TMP/runtime.conf"
cat >"$TSUB_CONFIG" <<EOF
runtime_core=sing-box
sing-box_version=1.13.15
sing-box_amd64_sha256=$archive_sha
sing-box_amd64_binary_sha256=$binary_sha
config_revision=7
agent_mode=remote
agent_controller_url=https://controller.example/api/deploy/agent
agent_deployment_id=deployment-test
agent_token_b64=dGVzdC10b2tlbg==
agent_poll_interval_seconds=180
subscription_server_enabled=true
subscription_server_port=51238
subscription_hostname=node.example.com
push_server_address=node.example.com
push_generation=agent-generation
EOF
cp "$TEST_TMP/core" "$TSUB_BIN/sing-box-1.13.15-amd64-$binary_sha"
chmod 700 "$TSUB_BIN/sing-box-1.13.15-amd64-$binary_sha"
printf '%s\n' "$TSUB_BIN/sing-box-1.13.15-amd64-$binary_sha" >"$TSUB_STATE/core.identity"
core=sing-box
planned_core_is_installed

TSUB_RUNTIME_VERSION=2.4.1
TSUB_HOSTNAME=test-server
TSUB_OS=debian
TSUB_OS_VERSION=13
TSUB_OS_PRETTY='Debian GNU/Linux 13 (trixie)'
TSUB_AGENT_TOKEN=test-token
TSUB_AGENT_URL=https://controller.example/api/deploy/agent
subscription_enabled() { return 0; }
subscription_running() { return 0; }
printf '%s\n' 'vless://identifier@node.example.com:443?security=tls#agent-node' >"$TSUB_STATE/nodes.txt"
TSUB_SWAP_REPORTED=true
TSUB_SWAP_TOTAL_MB=512
TSUB_SWAP_FREE_MB=384
TSUB_SWAP_USED_MB=128
TSUB_CGROUP_SWAP_REPORTED=true
TSUB_CGROUP_SWAP_CURRENT_MB=32
TSUB_CGROUP_SWAP_LIMIT_MB=256
curl() {
  output=''
  payload=''
  previous=''
  for argument in "$@"; do
    [ "$previous" != -o ] || output=$argument
    case "$argument" in @*) payload=${argument#@} ;; esac
    previous=$argument
  done
  if [ -n "$output" ]; then
    cp "$payload" "$TEST_TMP/payload.json"
    printf 'nextPollSeconds=180\ncommandId=\n' >"$output"
  else
    cp "$payload" "$TEST_TMP/event-payload.json"
  fi
  printf 200
}

[ "$(agent_poll_once)" = 180 ]
grep -q '"runtimeVersion":"2.4.1"' "$TEST_TMP/payload.json"
grep -q '"core":"sing-box"' "$TEST_TMP/payload.json"
grep -q '"coreVersion":"1.13.15"' "$TEST_TMP/payload.json"
grep -q '"coreIdentity":"sing-box-1.13.15-amd64-' "$TEST_TMP/payload.json"
grep -q '"osId":"debian"' "$TEST_TMP/payload.json"
grep -q '"osVersion":"13"' "$TEST_TMP/payload.json"
grep -q '"osPrettyName":"Debian GNU/Linux 13 (trixie)"' "$TEST_TMP/payload.json"
grep -q '"configRevision":7' "$TEST_TMP/payload.json"
grep -q '"pollIntervalSeconds":180' "$TEST_TMP/payload.json"
grep -q '"swapReported":true' "$TEST_TMP/payload.json"
grep -q '"swapTotalMb":512' "$TEST_TMP/payload.json"
grep -q '"swapFreeMb":384' "$TEST_TMP/payload.json"
grep -q '"swapUsedMb":128' "$TEST_TMP/payload.json"
grep -q '"cgroupSwapReported":true' "$TEST_TMP/payload.json"
grep -q '"cgroupSwapCurrentMb":32' "$TEST_TMP/payload.json"
grep -q '"cgroupSwapLimitMb":256' "$TEST_TMP/payload.json"

agent_report command-test lease-test succeeded repair 'command completed'
grep -q '"message":"command completed"' "$TEST_TMP/event-payload.json"
grep -q '"hostname":"test-server"' "$TEST_TMP/event-payload.json"
grep -q '"nodeCount":1' "$TEST_TMP/event-payload.json"
grep -q '"subscriptionReady":true' "$TEST_TMP/event-payload.json"
grep -q '"subscriptionNodeCount":1' "$TEST_TMP/event-payload.json"
grep -q '"serverAddress":"node.example.com"' "$TEST_TMP/event-payload.json"
grep -q '"pushGeneration":"agent-generation"' "$TEST_TMP/event-payload.json"
grep -q '"configRevision":7' "$TEST_TMP/event-payload.json"

printf '%s\n' 'safe diagnostic' 'vless://private@example.com:443' >"$TEST_TMP/failure.log"
[ "$(agent_failure_summary "$TEST_TMP/failure.log")" = '[REDACTED_URL]' ]

printf '%s\n' \
  'node=vless://identifier@example.com:443?security=tls#private-node' \
  'Authorization: Bearer private-bearer-token' \
  'subscription_token_b64=cHJpdmF0ZQ==' \
  'ordinary diagnostic line' >"$TSUB_LOG"
chmod 640 "$TSUB_LOG"
log_inode=$(stat -c '%i' "$TSUB_LOG")
sanitize_runtime_log
[ "$(stat -c '%i' "$TSUB_LOG")" = "$log_inode" ]
[ "$(stat -c '%a' "$TSUB_LOG")" = 640 ]
grep -q '\[REDACTED_URL\]' "$TSUB_LOG"
grep -q 'Bearer \[REDACTED\]' "$TSUB_LOG"
grep -q 'subscription_token_b64=\[REDACTED\]' "$TSUB_LOG"
grep -q 'ordinary diagnostic line' "$TSUB_LOG"
! grep -q 'private-' "$TSUB_LOG"

summary_output=$(TSUB_SUPPRESS_SENSITIVE_OUTPUT=true print_runtime_summary repair)
[ "$summary_output" = 'TSub Proxy 修复成功' ]

dd if=/dev/zero bs=1024 count=300 2>/dev/null | tr '\000' x >"$TSUB_LOG"
log_inode=$(stat -c '%i' "$TSUB_LOG")
trim_runtime_log
[ "$(stat -c '%i' "$TSUB_LOG")" = "$log_inode" ]
[ "$(wc -c <"$TSUB_LOG")" -eq 131072 ]

printf 'agent heartbeat and log tests passed\n'

#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-download-resume.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

mkdir -p "$TEST_TMP/bin"
cat >"$TEST_TMP/bin/curl" <<'FAKE_CURL'
#!/bin/sh
set -eu

output=''
resume=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -C) [ "$2" = - ] && resume=true; shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done

count=$(cat "$FAKE_CURL_COUNT" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\n' "$count" >"$FAKE_CURL_COUNT"
case "${url:-}" in
  */resume)
    if [ "$count" -eq 1 ]; then printf partial- >"$output"; exit 56; fi
    [ "$resume" = true ]
    [ "$(cat "$output")" = partial- ]
    printf complete >>"$output"
    ;;
  */no-range)
    if [ "$count" -eq 1 ]; then printf stale >"$output"; exit 56; fi
    if [ "$count" -eq 2 ]; then [ "$resume" = true ]; exit 33; fi
    [ "$resume" = false ]
    printf fresh >"$output"
    ;;
  *) exit 3 ;;
esac
FAKE_CURL
chmod 755 "$TEST_TMP/bin/curl"

PATH="$TEST_TMP/bin:$PATH"
export PATH
TSUB_CONFIG="$TEST_TMP/runtime.conf"
printf 'runtime_output_language=zh-CN\n' >"$TSUB_CONFIG"
TSUB_DOWNLOAD_MAX_ATTEMPTS=4
TSUB_DOWNLOAD_RETRY_DELAY_SECONDS=0
TSUB_DOWNLOAD_ATTEMPT_TIMEOUT_SECONDS=10
export TSUB_CONFIG TSUB_DOWNLOAD_MAX_ATTEMPTS TSUB_DOWNLOAD_RETRY_DELAY_SECONDS TSUB_DOWNLOAD_ATTEMPT_TIMEOUT_SECONDS

. "$ROOT/runtime/v2/modules/00-common.sh"

FAKE_CURL_COUNT="$TEST_TMP/resume.count"
export FAKE_CURL_COUNT
download_file 'https://example.invalid/resume' "$TEST_TMP/resume.bin" >"$TEST_TMP/resume.out"
[ "$(cat "$TEST_TMP/resume.bin")" = partial-complete ]
[ "$(cat "$FAKE_CURL_COUNT")" = 2 ]
grep -q '将从断点继续' "$TEST_TMP/resume.out"

FAKE_CURL_COUNT="$TEST_TMP/no-range.count"
export FAKE_CURL_COUNT
download_file 'https://example.invalid/no-range' "$TEST_TMP/no-range.bin" >"$TEST_TMP/no-range.out"
[ "$(cat "$TEST_TMP/no-range.bin")" = fresh ]
[ "$(cat "$FAKE_CURL_COUNT")" = 3 ]

printf '%s\n' 'Runtime resumable download tests passed'

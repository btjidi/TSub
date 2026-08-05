#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
docker run --rm --memory=64m --memory-swap=64m --pids-limit=64 \
  -v "$ROOT/public/proxy/v2/tsub-proxy.sh:/runtime.sh:ro" \
  -v "$ROOT/tests/runtime/low-memory.conf:/bootstrap.source:ro" \
  -v "$ROOT/tests/runtime/fake-core.sh:/fake-core:ro" \
  -v "$ROOT/tests/runtime/fake-curl.sh:/fake-curl:ro" \
  alpine:3.21 sh -eu -c '
    mkdir -p /tmp/tools
    cp /fake-curl /tmp/tools/curl
    chmod 755 /tmp/tools/curl
    cp /bootstrap.source /tmp/bootstrap.conf
    sed -i "s|^xray_amd64_url=.*|xray_amd64_url=https://example.invalid/fake-core|" /tmp/bootstrap.conf
    hash=$(sha256sum /fake-core | awk "{print \$1}")
    cp /tmp/bootstrap.conf /tmp/bootstrap.bad.conf
    sed -i "s/^xray_amd64_sha256=.*/xray_amd64_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" /tmp/bootstrap.bad.conf
    if PATH="/tmp/tools:$PATH" TSUB_CONFIG=/tmp/bootstrap.bad.conf TSUB_HEALTH_WAIT=2 /bin/sh /runtime.sh apply; then
      exit 1
    fi
    ! find /var/lib/tsub/bin -name "*.part" -type f | grep -q .
    sed -i "s/^xray_amd64_sha256=.*/xray_amd64_sha256=$hash/" /tmp/bootstrap.conf
    PATH="/tmp/tools:$PATH" TSUB_CONFIG=/tmp/bootstrap.conf TSUB_HEALTH_WAIT=2 /bin/sh /runtime.sh apply
    test -x "/var/lib/tsub/bin/xray-test-amd64-$hash"
    test ! -e "/var/lib/tsub/bin/xray-test-amd64-$hash.part"
    test -s /var/lib/tsub/nodes.txt
    test -r /var/lib/tsub/core.pid
    grep -q "GOMEMLIMIT=24MiB" /var/lib/tsub/start-core.sh
    grep -q "oom_score_adj" /var/lib/tsub/start-core.sh
    kill "$(cat /var/lib/tsub/core.pid)"
  '

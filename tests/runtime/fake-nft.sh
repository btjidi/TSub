#!/bin/sh
# shellcheck disable=SC2046
set -eu

case " $* " in
  *' list chain inet tsub_traffic input '*)
    set -- $(cat "$TSUB_FAKE_COUNTERS")
    printf 'tcp dport 443 counter packets 1 bytes %s comment "tsub_upload"\n' "$1"
    ;;
  *' list chain inet tsub_traffic output '*)
    set -- $(cat "$TSUB_FAKE_COUNTERS")
    printf 'tcp sport 443 counter packets 1 bytes %s comment "tsub_download"\n' "$2"
    ;;
  *) exit 0 ;;
esac

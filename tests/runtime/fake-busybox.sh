#!/bin/sh
set -eu

if [ "${1:-}" = --list ]; then
  printf 'httpd\n'
  exit 0
fi
exit 0

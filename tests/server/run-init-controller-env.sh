#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/../.." && pwd)
TEST_DIR=$(mktemp -d)
cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT HUP INT TERM

AUTO_ENV=$TEST_DIR/auto.env
AUTO_OUTPUT=$TEST_DIR/auto.out
TSUB_DOMAIN=controller.example.com \
TSUB_ENV_FILE=$AUTO_ENV \
sh "$ROOT/scripts/init-controller-env.sh" >"$AUTO_OUTPUT"

[ -f "$AUTO_ENV" ]
[ "$(stat -c '%a' "$AUTO_ENV")" = 600 ]
grep -q '^TSUB_DOMAIN=controller.example.com$' "$AUTO_ENV"
grep -q '^TSUB_PUBLIC_URL=https://controller.example.com$' "$AUTO_ENV"
grep -q '^TSUB_STATIC_DIR=/app/dist$' "$AUTO_ENV"
! grep -q 'replace-with-' "$AUTO_ENV"

deployment_secret=$(sed -n 's/^DEPLOYMENT_SECRET_KEY=//p' "$AUTO_ENV")
settings_secret=$(sed -n 's/^SETTINGS_SECRET_KEY=//p' "$AUTO_ENV")
cookie_secret=$(sed -n 's/^COOKIE_SECRET=//p' "$AUTO_ENV")
admin_password=$(sed -n "s/^ADMIN_PASSWORD='\(.*\)'$/\1/p" "$AUTO_ENV")

[ "${#deployment_secret}" -eq 64 ]
[ "${#settings_secret}" -eq 64 ]
[ "${#cookie_secret}" -eq 64 ]
[ "$deployment_secret" != "$settings_secret" ]
[ "$deployment_secret" != "$cookie_secret" ]
[ "$settings_secret" != "$cookie_secret" ]
[ "${#admin_password}" -eq 32 ]
grep -Fq "初始密码：$admin_password" "$AUTO_OUTPUT"

before_hash=$(sha256sum "$AUTO_ENV")
if TSUB_DOMAIN=changed.example.com TSUB_ENV_FILE=$AUTO_ENV sh "$ROOT/scripts/init-controller-env.sh" >"$TEST_DIR/retry.out" 2>&1; then
  echo 'existing environment file was overwritten' >&2
  exit 1
fi
[ "$(sha256sum "$AUTO_ENV")" = "$before_hash" ]

EXPLICIT_ENV=$TEST_DIR/explicit.env
EXPLICIT_OUTPUT=$TEST_DIR/explicit.out
TSUB_DOMAIN=explicit.example.com \
TSUB_ADMIN_USERNAME=operator \
TSUB_ADMIN_PASSWORD="Complex'Pass!123" \
TSUB_ENV_FILE=$EXPLICIT_ENV \
sh "$ROOT/scripts/init-controller-env.sh" >"$EXPLICIT_OUTPUT"
grep -q '^ADMIN_USERNAME=operator$' "$EXPLICIT_ENV"
grep -Fq "ADMIN_PASSWORD='Complex\'Pass!123'" "$EXPLICIT_ENV"
grep -q '已使用 TSUB_ADMIN_PASSWORD 指定的管理员密码。' "$EXPLICIT_OUTPUT"
! grep -Fq "Complex'Pass!123" "$EXPLICIT_OUTPUT"

INVALID_ENV=$TEST_DIR/invalid.env
if TSUB_DOMAIN='https://invalid.example.com' TSUB_ENV_FILE=$INVALID_ENV sh "$ROOT/scripts/init-controller-env.sh" >"$TEST_DIR/invalid.out" 2>&1; then
  echo 'invalid domain was accepted' >&2
  exit 1
fi
[ ! -e "$INVALID_ENV" ]

echo 'controller environment initialization tests passed'

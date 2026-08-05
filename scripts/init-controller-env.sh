#!/bin/sh
set -eu
umask 077

SCRIPT_DIR=$(CDPATH='' cd -P "$(dirname "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
TEMPLATE_FILE=${TSUB_ENV_TEMPLATE:-$PROJECT_DIR/server/controller.env.example}
OUTPUT_FILE=${TSUB_ENV_FILE:-$PROJECT_DIR/.env}

[ -n "${TSUB_DOMAIN:-}" ] || { echo '请通过 TSUB_DOMAIN 设置主控域名' >&2; exit 1; }
printf '%s' "$TSUB_DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo 'TSUB_DOMAIN 格式无效' >&2; exit 1; }
[ -f "$TEMPLATE_FILE" ] || { echo "环境变量模板不存在：$TEMPLATE_FILE" >&2; exit 1; }
if [ -e "$OUTPUT_FILE" ] || [ -L "$OUTPUT_FILE" ]; then
  echo "配置文件已存在，拒绝覆盖：$OUTPUT_FILE" >&2
  exit 1
fi

admin_username=${TSUB_ADMIN_USERNAME:-admin}
printf '%s' "$admin_username" | grep -Eq '^[A-Za-z0-9._-]{3,32}$' || { echo 'TSUB_ADMIN_USERNAME 格式无效' >&2; exit 1; }

random_hex() {
  byte_count=$1
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$byte_count"
  elif command -v od >/dev/null 2>&1 && [ -r /dev/urandom ]; then
    od -An -N "$byte_count" -tx1 /dev/urandom | tr -d ' \n'
  else
    echo '需要 openssl，或可读取 /dev/urandom 的 od 命令来生成安全随机值' >&2
    return 1
  fi
}

generated_password=false
if [ -n "${TSUB_ADMIN_PASSWORD:-}" ]; then
  [ "${#TSUB_ADMIN_PASSWORD}" -ge 12 ] || { echo '管理员密码至少需要 12 个字符' >&2; exit 1; }
  [ "$(printf '%s' "$TSUB_ADMIN_PASSWORD" | tr -d '\r\n')" = "$TSUB_ADMIN_PASSWORD" ] || { echo '管理员密码不能包含换行符' >&2; exit 1; }
  admin_password=$TSUB_ADMIN_PASSWORD
else
  admin_password=$(random_hex 16)
  generated_password=true
fi

deployment_secret=$(random_hex 32)
settings_secret=$(random_hex 32)
cookie_secret=$(random_hex 32)

output_dir=$(dirname "$OUTPUT_FILE")
[ -d "$output_dir" ] || { echo "配置目录不存在：$output_dir" >&2; exit 1; }
temporary_file=$(mktemp "$output_dir/.tsub-controller-env.XXXXXX")
cleanup() { rm -f "$temporary_file"; }
trap cleanup EXIT HUP INT TERM

quote_compose_env() {
  escaped_value=$(printf '%s' "$1" | sed "s/'/\\\\'/g")
  printf "'%s'" "$escaped_value"
}
quoted_admin_password=$(quote_compose_env "$admin_password")

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    TSUB_DOMAIN=*) printf 'TSUB_DOMAIN=%s\n' "$TSUB_DOMAIN" ;;
    TSUB_PUBLIC_URL=*) printf 'TSUB_PUBLIC_URL=https://%s\n' "$TSUB_DOMAIN" ;;
    DEPLOYMENT_SECRET_KEY=*) printf 'DEPLOYMENT_SECRET_KEY=%s\n' "$deployment_secret" ;;
    SETTINGS_SECRET_KEY=*) printf 'SETTINGS_SECRET_KEY=%s\n' "$settings_secret" ;;
    COOKIE_SECRET=*) printf 'COOKIE_SECRET=%s\n' "$cookie_secret" ;;
    ADMIN_USERNAME=*) printf 'ADMIN_USERNAME=%s\n' "$admin_username" ;;
    ADMIN_PASSWORD=*) printf 'ADMIN_PASSWORD=%s\n' "$quoted_admin_password" ;;
    *) printf '%s\n' "$line" ;;
  esac
done <"$TEMPLATE_FILE" >"$temporary_file"

chmod 600 "$temporary_file"
if ! ln "$temporary_file" "$OUTPUT_FILE"; then
  echo "无法创建配置文件，目标可能已存在：$OUTPUT_FILE" >&2
  exit 1
fi
rm -f "$temporary_file"
trap - EXIT HUP INT TERM

echo 'TSub Controller 环境配置已生成'
echo "配置文件：$OUTPUT_FILE"
echo "访问地址：https://$TSUB_DOMAIN"
echo "管理员账号：$admin_username"
if [ "$generated_password" = true ]; then
  echo "初始密码：$admin_password"
  echo '请立即保存，自动生成的密码只在本次初始化终端显示。'
else
  echo '已使用 TSUB_ADMIN_PASSWORD 指定的管理员密码。'
fi

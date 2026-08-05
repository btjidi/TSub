#!/bin/sh
set -eu
umask 077

PREFIX=${TSUB_CONTROLLER_PREFIX:-/opt/tsub-controller}
CONFIG_DIR=${TSUB_CONTROLLER_CONFIG_DIR:-/etc/tsub-controller}
DATA_DIR=${TSUB_CONTROLLER_DATA_DIR:-/var/lib/tsub-controller}
CONFIG_FILE=$CONFIG_DIR/controller.env
NEW_INSTALL=true
[ -f "$CONFIG_FILE" ] && NEW_INSTALL=false

[ "$(id -u)" -eq 0 ] || { echo '请使用 root 执行服务器主控安装器' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo '需要 Node.js 22 LTS 或更高版本' >&2; exit 1; }
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$node_major" -ge 22 ] || { echo 'Node.js 版本必须为 22 或更高' >&2; exit 1; }
if [ "$NEW_INSTALL" = true ]; then
  [ -n "${TSUB_DOMAIN:-}" ] || { echo '请通过 TSUB_DOMAIN 设置主控域名' >&2; exit 1; }
  printf '%s' "$TSUB_DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo 'TSUB_DOMAIN 格式无效' >&2; exit 1; }
  if [ -n "${TSUB_ADMIN_PASSWORD:-}" ]; then
    [ "${#TSUB_ADMIN_PASSWORD}" -ge 12 ] || { echo '管理员密码至少需要 12 个字符' >&2; exit 1; }
    [ "$(printf '%s' "$TSUB_ADMIN_PASSWORD" | tr -d '\r\n')" = "$TSUB_ADMIN_PASSWORD" ] || { echo '管理员密码不能包含换行符' >&2; exit 1; }
  fi
  printf '%s' "${TSUB_ADMIN_USERNAME:-admin}" | grep -Eq '^[A-Za-z0-9._-]{3,32}$' || { echo 'TSUB_ADMIN_USERNAME 格式无效' >&2; exit 1; }
fi

if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates openssl coreutils iproute2 procps libcap2-bin nftables iptables
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl ca-certificates openssl coreutils iproute2 procps libcap nftables iptables
else
  echo '裸机安装器仅支持 Debian/Ubuntu apt 或 Alpine apk' >&2
  exit 1
fi

if ! id tsub-controller >/dev/null 2>&1; then
  if command -v adduser >/dev/null 2>&1; then adduser --system --home "$DATA_DIR" --group tsub-controller >/dev/null 2>&1 || adduser -S -h "$DATA_DIR" tsub-controller
  else useradd --system --home-dir "$DATA_DIR" --create-home tsub-controller; fi
fi
mkdir -p "$PREFIX" "$CONFIG_DIR" "$DATA_DIR" /etc/tsub /run/tsub
cp -R dist functions server shared package.json package-lock.json "$PREFIX/"
mkdir -p "$PREFIX/src"
cp -R src/shared "$PREFIX/src/"
chmod 700 "$PREFIX/server/executor/tsub-local-executor.sh"
(cd "$PREFIX" && npm ci --omit=dev)

random_secret() { if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else od -An -N 32 -tx1 /dev/urandom | tr -d ' \n'; fi; }
quote_env() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
if [ "$NEW_INSTALL" = true ]; then
generated_admin_password=false
if [ -n "${TSUB_ADMIN_PASSWORD:-}" ]; then
  plain_admin_password=$TSUB_ADMIN_PASSWORD
else
  plain_admin_password=$(if command -v openssl >/dev/null 2>&1; then openssl rand -hex 16; else od -An -N 16 -tx1 /dev/urandom | tr -d ' \n'; fi)
  generated_admin_password=true
fi
admin_password=$(quote_env "$plain_admin_password")
cat >"$CONFIG_FILE" <<EOF
TSUB_PLATFORM=server
TSUB_STORAGE_TYPE=sqlite
TSUB_DATA_DIR=$DATA_DIR
TSUB_SQLITE_PATH=$DATA_DIR/tsub.sqlite
TSUB_STATIC_DIR=$PREFIX/dist
TSUB_LOCAL_EXECUTOR_SOCKET=/run/tsub/controller.sock
TSUB_TRUST_PROXY=loopback
TSUB_PUBLIC_URL=https://$TSUB_DOMAIN
DEPLOYMENT_SECRET_KEY=$(random_secret)
SETTINGS_SECRET_KEY=$(random_secret)
COOKIE_SECRET=$(random_secret)
ADMIN_USERNAME=${TSUB_ADMIN_USERNAME:-admin}
ADMIN_PASSWORD=$admin_password
TSUB_XRAY_VERSION=26.7.28
TSUB_XRAY_AMD64_URL=https://github.com/btjidi/TSub/releases/download/runtime-assets-v2/xray-26.7.28-amd64
TSUB_XRAY_AMD64_SHA256=64d46afb80adea1bf97a0d467e83f4a9ac1ebd0995891e84bca3f1a1d1affb1d
TSUB_XRAY_ARM64_URL=https://github.com/btjidi/TSub/releases/download/runtime-assets-v2/xray-26.7.28-arm64
TSUB_XRAY_ARM64_SHA256=4b8af237444801bf17b3dc10a1c5c24581fbe3d433eba3d78c6c3a0da1df56fc
TSUB_SINGBOX_VERSION=1.13.15
TSUB_SINGBOX_AMD64_URL=https://github.com/btjidi/TSub/releases/download/runtime-assets-v2/sing-box-1.13.15-amd64
TSUB_SINGBOX_AMD64_SHA256=fc3f1ff0d83d8d640e785fdd45ccd4d506ee6e8d67ba47b521382c448eee954a
TSUB_SINGBOX_AMD64_FORMAT=binary
TSUB_SINGBOX_AMD64_BINARY_SHA256=fc3f1ff0d83d8d640e785fdd45ccd4d506ee6e8d67ba47b521382c448eee954a
TSUB_SINGBOX_ARM64_URL=https://github.com/btjidi/TSub/releases/download/runtime-assets-v2/sing-box-1.13.15-arm64
TSUB_SINGBOX_ARM64_SHA256=62635ec87393e0860f24def24ecbc7415691c643dfdbc4faf7aa719263706096
TSUB_SINGBOX_ARM64_FORMAT=binary
TSUB_SINGBOX_ARM64_BINARY_SHA256=62635ec87393e0860f24def24ecbc7415691c643dfdbc4faf7aa719263706096
EOF
chmod 600 "$CONFIG_FILE"
else
  echo "保留现有配置与加密密钥：$CONFIG_FILE"
fi

# Provider metadata is public and immutable. Add newly supported providers on
# upgrades without replacing existing credentials or administrator overrides.
provider_defaults_tmp=$CONFIG_FILE.providers.$$
cp -p "$CONFIG_FILE" "$provider_defaults_tmp"
provider_defaults_changed=false
while IFS= read -r provider_setting; do
  provider_key=${provider_setting%%=*}
  if ! grep -q "^${provider_key}=" "$provider_defaults_tmp"; then
    printf '%s\n' "$provider_setting" >>"$provider_defaults_tmp"
    provider_defaults_changed=true
  fi
done <<'EOF'
TSUB_CLOUDFLARED_VERSION=2026.6.0
TSUB_CLOUDFLARED_AMD64_URL=https://github.com/cloudflare/cloudflared/releases/download/2026.6.0/cloudflared-linux-amd64
TSUB_CLOUDFLARED_AMD64_SHA256=08d27c4c5d3ed73ee3e98ef2ddceb4ad09fd4cfc28e243565a189538e8ccd706
TSUB_CLOUDFLARED_ARM64_URL=https://github.com/cloudflare/cloudflared/releases/download/2026.6.0/cloudflared-linux-arm64
TSUB_CLOUDFLARED_ARM64_SHA256=8482ebf1e74a2a4a1a9f1e090e17e3de08423f94100ece6789287cb26fb9480f
TSUB_WGCF_VERSION=2.2.22
TSUB_WGCF_AMD64_URL=https://github.com/ViRb3/wgcf/releases/download/v2.2.22/wgcf_2.2.22_linux_amd64
TSUB_WGCF_AMD64_SHA256=268d187e649870b603ad2e5c1b74a696251f6c2f6f075c726a174a0039b0b1e2
TSUB_WGCF_ARM64_URL=https://github.com/ViRb3/wgcf/releases/download/v2.2.22/wgcf_2.2.22_linux_arm64
TSUB_WGCF_ARM64_SHA256=e5ff08d3aae5374935211053b2d64d96daaa3f1aec8e9a1dab7418125585a011
TSUB_LEGO_VERSION=4.26.0
TSUB_LEGO_AMD64_URL=https://github.com/go-acme/lego/releases/download/v4.26.0/lego_v4.26.0_linux_amd64.tar.gz
TSUB_LEGO_AMD64_SHA256=9a5963e0b3961d5d2863c3055ea608340630815829d9a548ca882511b643d948
TSUB_LEGO_AMD64_FORMAT=tar.gz
TSUB_LEGO_AMD64_BINARY_SHA256=b295ce2a1872f7088366ac647c12f516bba990777d91132bfc360f3ff8e17d6c
TSUB_LEGO_ARM64_URL=https://github.com/go-acme/lego/releases/download/v4.26.0/lego_v4.26.0_linux_arm64.tar.gz
TSUB_LEGO_ARM64_SHA256=bcc781fe8c01291585e7eafb0a1539a33245cafac448775bdf0d45b6fedb703f
TSUB_LEGO_ARM64_FORMAT=tar.gz
TSUB_LEGO_ARM64_BINARY_SHA256=c50265f1b5c11300304946bc858d2eee6e1d84b49449eaaea8320af0c1eccd77
TSUB_BUSYBOX_VERSION=1.31.0-musl
TSUB_BUSYBOX_AMD64_URL=https://busybox.net/downloads/binaries/1.31.0-defconfig-multiarch-musl/busybox-x86_64
TSUB_BUSYBOX_AMD64_SHA256=51fcb60efbdf3e579550e9ab893730df56b33d0cc928a2a6467bd846cdfef7d8
TSUB_BUSYBOX_ARM64_URL=https://busybox.net/downloads/binaries/1.31.0-defconfig-multiarch-musl/busybox-armv8l
TSUB_BUSYBOX_ARM64_SHA256=141adb1b625a6f44c4b114f76b4387b4ea4f7ab802b88eb40e0d2f6adcccb1c3
EOF
if [ "$provider_defaults_changed" = true ]; then
  chmod 600 "$provider_defaults_tmp"
  mv -f "$provider_defaults_tmp" "$CONFIG_FILE"
  echo '已补齐服务器部署 Provider 固定资产配置。'
else
  rm -f "$provider_defaults_tmp"
fi
chmod 600 "$CONFIG_FILE"
chown -R tsub-controller:tsub-controller "$DATA_DIR" /run/tsub "$PREFIX"
mkdir -p /var/lib/tsub/bin
install -m 700 "$PREFIX/dist/proxy/v2/tsub-proxy.sh" /var/lib/tsub/bin/tsub-proxy.sh

if command -v systemctl >/dev/null 2>&1; then
  cp "$PREFIX/server/install/tsub-controller.service" /etc/systemd/system/tsub-controller.service
  cp "$PREFIX/server/install/tsub-executor.service" /etc/systemd/system/tsub-executor.service
  systemctl daemon-reload
  systemctl enable --now tsub-controller.service tsub-executor.service
elif command -v rc-update >/dev/null 2>&1; then
  cp "$PREFIX/server/install/tsub-controller.openrc" /etc/init.d/tsub-controller
  chmod 700 /etc/init.d/tsub-controller
  cp "$PREFIX/server/install/tsub-executor.openrc" /etc/init.d/tsub-executor
  chmod 700 /etc/init.d/tsub-executor
  rc-update add tsub-controller default >/dev/null 2>&1 || true
  rc-update add tsub-executor default >/dev/null 2>&1 || true
  rc-service tsub-controller restart
  rc-service tsub-executor restart
else
  echo '未找到 systemd 或 OpenRC，无法注册主控服务' >&2
  exit 1
fi

if [ "$NEW_INSTALL" = true ]; then
  echo 'TSub Controller 安装成功'
  echo "访问地址：https://$TSUB_DOMAIN"
  echo "管理员账号：${TSUB_ADMIN_USERNAME:-admin}"
  if [ "$generated_admin_password" = true ]; then
    echo "初始密码：$plain_admin_password"
    echo '请立即保存，自动生成的密码只在本次安装终端显示。'
  else
    echo '已使用 TSUB_ADMIN_PASSWORD 指定的管理员密码。'
  fi
  echo '请配置 Caddy 或 Nginx 后再开放公网访问。'
else
  echo 'TSub Controller 已升级，现有配置与加密密钥未更改。'
fi

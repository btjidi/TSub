[English](SERVER_DEPLOYMENT_EN.md)

# 服务器主控部署

本文部署的是 TSub 主控，不是单独的代理节点。服务器主控支持 SQLite 单实例、PostgreSQL 多实例、远程 Agent，以及可选的同机 root 执行器。

## 部署方式

| 方式 | Web 主控 | HTTPS | 本机直控 |
| --- | --- | --- | --- |
| Docker Compose | 非 root 容器 | Compose 内 Caddy | 默认不安装，需在宿主机额外安装执行器 |
| 裸机 | `tsub-controller` 用户 | 需安装 Caddy 或配置 Nginx | 安装器同时注册 root 执行器 |

远程 Agent 始终由节点主动连接主控，不需要保存 SSH 密码。只有控制主控所在宿主机的代理节点时，才需要本机执行器。

### 节点公网地址探测

代理部署命令会先通过主控探测节点地址。自托管主控无法提供 Cloudflare 客户端地址时，节点脚本会依次尝试 AWS Global API（`https://checkip.global.api.aws`）和 Akamai（`https://whatismyip.akamai.com`），分别使用 IPv4/IPv6 连接。外部服务只返回出口 IP，不接收部署 Token 或配置；NAT、代理和特殊云网络可能使出口 IP 与可入站地址不同，生产环境应在生成器中手动确认节点公网地址。

## 部署前检查

- 支持 `amd64` 和 `arm64` Linux。裸机安装支持 Debian/Ubuntu 的 systemd，以及 Alpine 的 OpenRC。
- Docker 方式需要 Docker Engine、Compose v2、建议至少 1 GB 可用内存和 2 GB 磁盘空间。
- 裸机方式需要 Node.js 22、npm、Git，以及能够构建前端和原生 SQLite 依赖的环境。
- 域名的 A/AAAA 记录指向主控服务器。首次签发证书时建议先使用 DNS-only，确认 HTTPS 后再启用 CDN 代理。
- 云防火墙和系统防火墙允许 `80/TCP`、`443/TCP`；需要 HTTP/3 时再允许 `443/UDP`。不要将内部 `8787` 端口开放到公网。
- 初始化脚本会生成强管理员密码，以及互不相同的 `COOKIE_SECRET`、`DEPLOYMENT_SECRET_KEY`、`SETTINGS_SECRET_KEY`；这些值必须长期保存。

## Docker Compose

本节命令中的 `tsub.example.com` 和后文的 `db.example.com` 都是示例值，必须替换为你自己的域名、数据库主机名或 IP；不要原样执行。

### 1. 获取源码

```bash
git clone https://github.com/btjidi/TSub.git
cd TSub
TSUB_DOMAIN=tsub.example.com sh scripts/init-controller-env.sh
```

初始化脚本根据完整模板生成权限为 `0600` 的 `.env`，并在当前终端显示一次随机管理员密码。请立即保存密码；已有 `.env` 时脚本会拒绝覆盖。

需要指定管理员账号或密码时，可在首次初始化时显式传入：

```bash
TSUB_DOMAIN=tsub.example.com \
TSUB_ADMIN_USERNAME=admin \
TSUB_ADMIN_PASSWORD='至少十二位的强密码' \
sh scripts/init-controller-env.sh
```

显式密码不会在终端回显。自动生成和显式填写的密码都会写入 `.env`，且不会进入镜像。

代理核心及 BusyBox 的公开下载地址、版本和 SHA-256 已由程序内置，服务器部署无需额外填写 `TSUB_XRAY_*`、`TSUB_SINGBOX_*` 或 `TSUB_BUSYBOX_*`。如需使用自定义镜像，必须为同一核心提供完整的版本、AMD64/ARM64 地址和校验值；不完整的覆盖配置会被拒绝。

### 2. 可选：手工配置 `.env`

如不使用初始化脚本，可复制模板后至少修改以下值：

```dotenv
TSUB_DOMAIN=tsub.example.com
TSUB_PUBLIC_URL=https://tsub.example.com
DEPLOYMENT_SECRET_KEY=独立随机值
SETTINGS_SECRET_KEY=另一个独立随机值
COOKIE_SECRET=第三个独立随机值
ADMIN_USERNAME=admin
ADMIN_PASSWORD=至少十二位的强密码
```

先执行 `cp server/controller.env.example .env && chmod 600 .env`，再使用 `openssl rand -hex 32` 分别生成三个 Secret。不要复用值，不要把 `.env` 提交到 Git。Docker 模板中的 `TSUB_STATIC_DIR` 必须保持 `/app/dist`。

### 3. 启动

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 controller caddy
```

Compose 只公开 80/443，主控 `8787` 仅存在于内部网络。Caddy 数据和 SQLite 数据保存在命名卷中，普通 `docker compose down` 不会删除。

### 4. 验证

```bash
curl -I https://tsub.example.com/login
docker compose exec controller node -v
docker compose logs --tail=100 controller
```

浏览器登录后，在“设置 → 系统设置”确认平台为服务器、活动存储为 SQLite，并立即导出第一份备份。

### 5. 可选：安装宿主机执行器

仅使用远程 Agent 时跳过本节。执行器以 root 运行，但只接受固定动作，不接受任意 Shell 字符串。

systemd 宿主机：

```bash
sudo install -d -m 700 /opt/tsub-controller/server/executor /var/lib/tsub/bin /var/lib/tsub-controller/executor /etc/tsub
sudo install -d -m 770 /run/tsub
sudo install -m 700 server/executor/tsub-local-executor.sh /opt/tsub-controller/server/executor/tsub-local-executor.sh
sudo install -m 700 public/proxy/v2/tsub-proxy.sh /var/lib/tsub/bin/tsub-proxy.sh
sudo install -m 644 server/install/tsub-executor.service /etc/systemd/system/tsub-executor.service
sudo systemctl daemon-reload
sudo systemctl enable --now tsub-executor.service
```

Alpine/OpenRC 宿主机：

```bash
doas install -d -m 700 /opt/tsub-controller/server/executor /var/lib/tsub/bin /var/lib/tsub-controller/executor /etc/tsub
doas install -d -m 770 /run/tsub
doas install -m 700 server/executor/tsub-local-executor.sh /opt/tsub-controller/server/executor/tsub-local-executor.sh
doas install -m 700 public/proxy/v2/tsub-proxy.sh /var/lib/tsub/bin/tsub-proxy.sh
doas install -m 700 server/install/tsub-executor.openrc /etc/init.d/tsub-executor
doas rc-update add tsub-executor default
doas rc-service tsub-executor start
```

在代理部署页面将部署绑定到本机执行器后，主控会生成权限 `0600` 的 `/run/tsub/executor.conf`。验证：

```bash
sudo test -S /run/tsub/controller.sock
sudo systemctl status tsub-executor.service --no-pager
sudo journalctl -u tsub-executor.service -n 100 --no-pager
```

OpenRC 使用 `rc-service tsub-executor status` 和 `/var/log/tsub-executor.log`。

## 裸机安装

本节命令中的 `tsub.example.com` 必须替换为你自己的域名；不要原样执行。

### 1. 安装依赖并构建

先按 Node.js 官方说明安装 Node.js 22。确认版本后构建：

```bash
node -v
npm -v
git clone https://github.com/btjidi/TSub.git
cd TSub
npm ci
npm run build
```

`node -v` 必须为 `v22` 或更高。不要从未审核的第三方脚本安装 Node.js。

### 2. 运行安装器

```bash
sudo env \
  TSUB_DOMAIN=tsub.example.com \
  TSUB_ADMIN_USERNAME=admin \
  sh scripts/install-controller.sh
```

未提供 `TSUB_ADMIN_PASSWORD` 时，安装器自动生成随机密码并仅在首次安装成功后显示一次。需要指定密码时，仍可在命令中加入 `TSUB_ADMIN_PASSWORD='至少十二位的强密码'`；显式密码不会回显。

首次安装会：

- 创建非 root 用户 `tsub-controller`。
- 安装到 `/opt/tsub-controller`。
- 生成 `/etc/tsub-controller/controller.env`，权限为 `0600`。
- 自动生成管理员密码和三个独立的加密 Secret。
- 创建 SQLite 数据目录 `/var/lib/tsub-controller`。
- 注册主控和本机执行器的 systemd/OpenRC 服务。

安装器不会安装或配置反向代理。主控只监听 `127.0.0.1:8787`。

### 3. 配置 Caddy

安装 Caddy 后，将下面内容写入 `/etc/caddy/Caddyfile`，把域名替换为实际值：

```caddyfile
tsub.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
    header {
        -Server
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }
}
```

验证并启动：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Alpine 使用 `rc-update add caddy default`、`rc-service caddy restart`。使用 Nginx 时也必须只代理到 `127.0.0.1:8787`，传递正确的 `Host`、`X-Forwarded-Proto` 和 `X-Forwarded-For`，并由 Nginx 管理证书。

### 4. 验证服务

systemd：

```bash
sudo systemctl status tsub-controller tsub-executor caddy --no-pager
sudo journalctl -u tsub-controller -n 100 --no-pager
sudo ss -lntp | grep -E ':(80|443|8787)\b'
curl -I http://127.0.0.1:8787/login
curl -I https://tsub.example.com/login
sudo stat -c '%a %U:%G %n' /etc/tsub-controller/controller.env /var/lib/tsub-controller/tsub.sqlite
```

OpenRC：

```bash
rc-service tsub-controller status
rc-service tsub-executor status
tail -n 100 /var/log/tsub-controller.log
```

## PostgreSQL

SQLite WAL 适合单个主控进程，也是默认选择。需要多个主控实例或更高并发时使用 PostgreSQL。

1. 在独立 PostgreSQL 中创建专用数据库和最小权限账号。
2. 将连接串写入 `.env` 或 `/etc/tsub-controller/controller.env`：

```dotenv
TSUB_POSTGRES_URL=postgresql://tsub:经过URL编码的密码@db.example.com:5432/tsub
TSUB_DATABASE_POOL_SIZE=10
```

3. 重启主控，让它连接并初始化 PostgreSQL 空结构。
4. 在“设置 → 系统设置”执行 SQLite→PostgreSQL 校验迁移。不要直接将 `TSUB_STORAGE_TYPE` 改成 `postgres` 来绕过迁移。

Compose 不内置 PostgreSQL。连接地址必须能从 `controller` 容器访问；容器中的 `127.0.0.1` 指向容器自身。

## 备份与恢复

- 首选主控内的导出备份或 WebDAV 计划备份，它们不依赖底层数据库文件。
- 三个加密 Secret 必须单独离线保存；只有数据库而没有原 Secret，部署和设置密文无法解密。
- SQLite 在线文件级备份使用 `sqlite3 /var/lib/tsub-controller/tsub.sqlite ".backup '/安全目录/tsub.sqlite'"`，不要直接复制正在写入的 WAL 文件。
- Docker 若要备份整个卷，应先停止 `controller`，再备份 `controller-data` 命名卷；不要执行 `docker compose down -v`。
- 恢复前先停止写入，保留当前数据快照，并确认备份版本与应用版本兼容。

## 升级与回滚

### 1.0.12 默认 TLS/Reality 目标与 Runtime 更新

TSub `1.0.12` 将新部署的 TLS/Reality 默认服务器名称改为 `www.cloudflare.com`，以提升 AWS 等云服务器的握手兼容性。已有部署不会自动修改，需在部署记录中更新服务器名称并执行“更新配置”。

### 1.0.13 部署请求体保护

TSub `1.0.13` 为部署创建、配置更新、默认配置和远程操作接口增加分接口请求体大小限制。已登录的后台操作不限制次数；Agent 心跳和回调使用独立限制。超大请求返回 `413`，非法 JSON 返回 `400`，不会回显请求内容或敏感信息。

### 1.0.11 Runtime 更新与回退

TSub `1.0.10` 会在“远程执行”中提供“更新版本”和“回退 Runtime”。更新版本会校验当前 Manifest、原子替换 Runtime 并重载 Agent；回退默认使用主控保留的 `1.0.9` 历史 Manifest，校验 SHA-256 后再替换。该过程不修改代理核心、节点配置或部署数据。

如果操作记录长时间停留在“等待执行”，先检查节点的 Agent 主控地址和部署 ID 是否仍指向当前主控；旧主控绑定的节点必须使用当前主控重新安装或重新绑定，不能重复使用旧命令。

Docker 升级：

```bash
git fetch --tags origin
git checkout main
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 controller caddy
```

裸机升级：

```bash
git pull --ff-only
npm ci
npm run build
sudo sh scripts/install-controller.sh
```

升级模式会保留现有 `/etc/tsub-controller/controller.env` 和三个加密 Secret。升级前仍应导出备份。回滚时检出之前确认可用的提交并重新构建；若新版本已经写入不兼容数据，需要同时恢复升级前备份。

## 卸载

先在主控中卸载由本机执行器管理的代理部署并导出备份。

- Docker：`docker compose down` 仅停止容器并保留数据卷。确认不再需要数据后，才可使用 `docker compose down -v` 删除 SQLite 和 Caddy 卷。
- systemd：停止并禁用 `tsub-controller`、`tsub-executor`，再删除对应 unit 并执行 `systemctl daemon-reload`。
- OpenRC：停止服务并从 default runlevel 移除，再删除 `/etc/init.d/tsub-controller` 和 `/etc/init.d/tsub-executor`。
- 只有确认备份可用后，才删除 `/opt/tsub-controller`、`/etc/tsub-controller` 和 `/var/lib/tsub-controller`。`/etc/tsub`、`/var/lib/tsub` 及代理防火墙规则属于节点 Runtime，应通过卸载部署清理，不要直接删除。

## 常见问题

- **页面 404，但 API 进程正常**：Docker 检查 `TSUB_STATIC_DIR=/app/dist`；裸机检查 `/opt/tsub-controller/dist/index.html`。
- **证书签发失败**：确认 DNS 指向当前服务器、80/443 可从公网访问、没有其他服务占用端口，并查看 Caddy 日志。
- **登录后立即失效**：确认 `COOKIE_SECRET` 没有变化，反向代理正确传递 HTTPS 协议。
- **旧部署无法解密**：恢复原 `DEPLOYMENT_SECRET_KEY` 和 `SETTINGS_SECRET_KEY`，不要重新生成。
- **SQLite 已被占用**：SQLite 只允许一个主控实例；停止重复进程或迁移 PostgreSQL。
- **本机执行器离线**：检查 Socket、`/run/tsub/executor.conf`、执行器服务和 Runtime 权限。
- **Compose 无法连接 PostgreSQL**：不要使用容器内的 `127.0.0.1`，改用可解析的数据库主机名或同一 Compose 网络中的服务名。

相关文档：[Cloudflare Pages 部署教程](../README.md#cloudflare-pages-部署教程) · [总体架构](ARCHITECTURE.md) · [安全模型](SECURITY.md) · [运维手册](OPERATIONS.md)

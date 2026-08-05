[English](QUICK_START_EN.md)

# 快速开始

## 前置条件

- Cloudflare 账号、Pages 项目，以及 KV 命名空间或 D1 数据库。
- Node.js 22 LTS 或更高版本，用于本地构建和服务器主控。
- 一个至少 8 位的管理员密码、稳定的 Cookie 密钥，以及独立的部署加密密钥。
- KV 模式下主控不会连接服务器；D1 与服务器完整模式可由服务器 Agent 主动轮询命令。

## Cloudflare Pages 公共步骤

1. Fork 或导入仓库，创建 Pages 项目。
2. 构建命令填写 `npm run build`，输出目录填写 `dist`。
3. 按下面三种方式之一绑定存储。
4. 配置以下变量或 Secret：

| 名称 | 必需 | 用途 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 否 | 管理员账号，默认 `admin` |
| `ADMIN_PASSWORD` | 是 | 初始管理员密码 |
| `COOKIE_SECRET` | 是 | 登录 Cookie 签名 |
| `DEPLOYMENT_SECRET_KEY` | 代理部署需要 | AES-GCM 部署配置密钥 |
| `SETTINGS_SECRET_KEY` | 建议 | WebDAV、Telegram、Cron 和 External API Secret 的独立 AES-GCM 密钥；缺失时兼容使用 `DEPLOYMENT_SECRET_KEY` |
| `TSUB_PUBLIC_URL` | 建议 | 主控公开 HTTPS 地址 |

代理核心的版本、下载地址和 SHA-256 变量见[代理部署](PROXY_DEPLOYMENT.md)。

### KV 基础直装

1. 创建 KV 命名空间，在 Pages 的设置 → 绑定中将它绑定为 `TSUB_KV`。
2. 不绑定 `TSUB_DB`，也不配置 `TSUB_INITIAL_STORAGE`。
3. 部署后系统直接使用 KV 基础模式。一次性命令、主动推送和订阅可用；远程 Agent、命令与实时心跳不可用。

### D1 完整直装

1. 创建一个空 D1 数据库，在 Pages 的设置 → 绑定中将它绑定为 `TSUB_DB`。
2. 不需要绑定 `TSUB_KV`，也不需要配置 `TSUB_INITIAL_STORAGE`。
3. 部署后首次请求会幂等创建缺失表和索引、写入唯一的 `storage_control`，并直接启用 D1 完整模式。

[schema.sql](../schema.sql) 可用于上线前审计或手工预初始化，但不是 D1 直装的必需步骤。若 D1 初始化失败，主控返回 `503 storage_initialization_failed` 和 `requestId`，不会降级到空存储。

### 已有 KV 迁移到 D1

1. 保留原 `TSUB_KV`，新建 D1 并绑定为 `TSUB_DB`，然后重新部署。
2. 先导出备份，再登录“设置 → 系统设置”，确认当前活动存储仍为 KV。
3. 点击迁移到 D1。系统会加写锁、复制数据和系统凭据、核对数量与 SHA-256 摘要，成功后才原子切换。
4. 验证登录、订阅、部署记录和 Cron 后再决定是否保留 KV 作为回切目标。未绑定 KV 时，“切回 KV”会禁用。

全新项目若同时绑定空 KV 和空 D1，默认选择 KV；可设置 `TSUB_INITIAL_STORAGE=d1` 选择 D1。该变量只用于首次双绑定选择：两侧数据冲突时必须明确设置 `kv` 或 `d1`，已有 `storage_control` 后它不再改变活动存储。不要通过普通设置或只修改环境变量迁移已有数据。

## 首次登录

部署完成后访问 `/login`。如果设置了自定义登录路径，则使用对应路径。输入管理员账号和密码；账号不区分大小写。首次进入建议：

1. 在“设置 → 系统设置”验证存储类型。
2. 修改管理员凭据并重新登录。
3. 配置 WebDAV 备份与通知。
4. 添加订阅源、节点和 Profile。
5. 需要文档演示时生成隔离演示数据；它不会进入公开订阅或备份。

## 服务器主控

服务器主控支持 Docker Compose 和裸机两种方式。Docker 自带 Caddy，但默认不安装宿主机执行器；裸机安装器同时注册非 root 主控和 root 执行器，但反向代理需单独配置。完整的 DNS、防火墙、HTTPS、数据库、本机执行器、备份、升级、回滚和卸载步骤见[服务器主控部署](SERVER_DEPLOYMENT.md)。

## 创建第一条订阅

在“订阅管理”添加上游 URL，刷新节点信息；在“节点管理”添加单条分享链接；然后在“我的订阅”新建 Profile 并选择来源。复制 Profile 链接时选择目标客户端。

## 创建代理部署

在“代理部署”填写部署名称，选择协议，端口可留空随机生成。确认风险后生成一次性部署命令，并在目标服务器的 Shell 中执行。安装完成后终端输出节点、服务器本地订阅和主控镜像地址；默认控制命令为 `tsub`。

## 本地验证

```bash
npm ci
npm run test:run
npm run runtime:check
npm run docs:check
npm run build
```

更多信息：[用户指南](USER_GUIDE.md) · [运维手册](OPERATIONS.md) · [安全模型](SECURITY.md)

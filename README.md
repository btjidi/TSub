[English](README_EN.md)

<p align="center"><img src="public/logo.svg" width="96" height="96" alt="TSub Logo"></p>

# TSub

TSub 是可部署在 Cloudflare Pages 或自有服务器上的订阅与代理节点管理平台，包含订阅管理、节点管理、Profile、多客户端转换、代理部署、远程 Agent、本机执行器、通知、备份和外部管理 API。

![TSub 仪表盘](docs/assets/screenshots/dashboard.png)

## 核心能力

- 管理 HTTP 订阅源、手动节点和可公开分享的 Profile。
- 输出 Base64、Clash/Mihomo、sing-box、Surge、Loon、Quantumult X 等格式。
- 使用操作符链、规则模板、节点筛选、排序、去重和名称处理构建订阅。
- 使用 TSub Proxy 在低内存服务器部署 Xray 或 sing-box，不保存 SSH 账号或私钥。
- 通过一次性 Bootstrap、加密部署配置、主动推送和 HTTPS 镜像同步节点及总流量。
- Cloudflare 支持 KV 基础模式与 D1 完整模式；服务器支持 SQLite WAL 单机模式与 PostgreSQL 多实例模式。
- 提供中英文界面、桌面和移动端布局，以及完全隔离的只读演示数据。

## 界面预览

| 订阅管理 | 节点管理 |
| --- | --- |
| ![订阅管理](docs/assets/screenshots/subscription-management.png) | ![节点管理](docs/assets/screenshots/node-management.png) |

| 我的订阅 | 代理部署记录 |
| --- | --- |
| ![我的订阅](docs/assets/screenshots/my-subscriptions.png) | ![代理部署记录](docs/assets/screenshots/proxy-deployment-records.png) |

| 代理部署生成器 | 设置 |
| --- | --- |
| ![代理部署生成器](docs/assets/screenshots/proxy-deployments.png) | ![设置](docs/assets/screenshots/settings.png) |

## Cloudflare Pages 部署教程

### 部署前准备

- Cloudflare 账号，并能创建 Workers 和 Pages 项目、D1 数据库和 KV 命名空间。
- GitHub 账号，建议将本仓库 Fork 到自己的账号并保持公开。
- 管理员密码至少 8 位；另准备三个互不相同的随机 Secret。
- D1 模式建议准备稳定的 HTTPS 公开地址。

### 1. Fork 仓库

打开本仓库 GitHub 页面，点击 **Fork**，选择自己的账号和仓库名称。Cloudflare 只会显示授权账号可访问的仓库；公开 Fork 是最简单的部署路径。

### 2. 创建 Pages 项目并授权 GitHub

进入 **Workers 和 Pages → 创建应用程序 → Pages → 导入现有 Git 存储库**。如果先显示 Worker 创建卡片，点击底部“想要部署 Pages？开始使用”。授权 GitHub 后选择 Fork，点击 **开始设置（Begin setup）**。

### 3. 填写构建设置

| 设置项（Cloudflare 中文界面） | 填写值 |
| --- | --- |
| 框架预设（Framework preset） | `Vite` 或 `None` |
| 构建命令（Build command） | `npm run build` |
| 构建输出目录（Build output directory） | `dist` |
| 根目录（Root directory） | 仓库根目录（留空或 `/`） |
| Node.js 版本（Node.js version） | `22` 或更高版本 |

![Pages 构建设置](docs/assets/screenshots/cloudflare/06-build-settings.png)

填写完成后点击页面底部 **保存并部署（Save and deploy）**。首次部署成功后，再进入项目设置配置 D1/KV 绑定；绑定和变量保存后还需要再次部署才能生效。

### 4. 创建并绑定存储

> [!CAUTION]
> 存储配置方式已改为 **Cloudflare 控制台绑定**。公共仓库不再提供生效的 `wrangler.toml`，因为 Pages 检测到该文件后会锁定控制台绑定。请在 Pages **设置 → 绑定** 中选择自己的 KV/D1 资源；旧 Fork 更新后也应删除原有 `wrangler.toml`。

绑定名称是 TSub 的运行时契约，必须严格使用 `TSUB_DB` 或 `TSUB_KV`。`wrangler.example.toml` 只供本地参考，每个 Fork 都必须在自己的 Cloudflare Pages 项目中完成绑定。

#### D1 完整模式（推荐）

1. 打开 **存储和数据库 → D1 SQLite 数据库**，点击 **创建数据库（Create database）**。
2. 在 Pages 项目 **设置 → 绑定** 中点击“添加”，选择 D1 数据库并命名为 `TSUB_DB`。
3. 不添加 `TSUB_KV`。首次请求会自动创建表和索引，无需手动执行 `schema.sql`。

D1 支持远程 Agent、部署命令、命令队列和实时心跳。

![创建 D1 数据库](docs/assets/screenshots/cloudflare/07-create-d1.png)
![绑定 D1 数据库](docs/assets/screenshots/cloudflare/08-bind-d1.png)

#### KV 基础模式

1. 打开 **存储和数据库 → Workers KV**，点击“创建命名空间”。
2. 在 Pages 项目 **设置 → 绑定** 中添加 KV 命名空间，变量名填写 `TSUB_KV`。
3. 不添加 `TSUB_DB`。

KV 支持订阅、节点、Profile、一次性命令和主动推送，但不支持远程 Agent、部署命令和实时心跳。

![创建 KV 命名空间](docs/assets/screenshots/cloudflare/09-create-kv.png)
![绑定 KV 命名空间](docs/assets/screenshots/cloudflare/10-bind-kv.png)

不要把已有生产 KV 直接改绑为 D1。应先备份，再绑定 `TSUB_DB`，重新部署后从 TSub **设置 → 系统设置** 执行迁移。

### 5. 配置变量和密钥

在 **设置 → 变量和密钥（Settings → Variables and Secrets）** 中选择 **生产（Production）**。密码和加密密钥选择 **密钥（Secret）**，不要把真实值写入 GitHub 或 `wrangler.toml`。

#### 方式 A：手动创建

点击 **添加变量（Add variable）**，逐项填写以下 6 项：

| 名称 | 说明 |
| --- | --- |
| `ADMIN_USERNAME` | 管理员账号名，3-32 位 |
| `ADMIN_PASSWORD` | 管理员密码，至少 8 位、最多 128 位 |
| `COOKIE_SECRET` | 登录 Cookie 签名密钥 |
| `DEPLOYMENT_SECRET_KEY` | 代理部署配置密钥 |
| `SETTINGS_SECRET_KEY` | 设置、通知和外部 API 密钥 |
| `TSUB_PUBLIC_URL` | 公开 HTTPS 地址 |

#### 方式 B：导入 `.env` 模板

点击 **导入 .env（Import .env）**，粘贴模板并替换所有占位符：

```dotenv
ADMIN_USERNAME=这里填写管理员账号名
ADMIN_PASSWORD=这里填写管理员密码（至少8位）
COOKIE_SECRET=这里填写随机Cookie密钥
DEPLOYMENT_SECRET_KEY=这里填写随机部署密钥
SETTINGS_SECRET_KEY=这里填写随机设置密钥
TSUB_PUBLIC_URL=这里填写公开HTTPS地址
```

导入后确认环境为生产，敏感项显示为 Secret；填写后的 `.env` 不得提交到仓库。

### 6. 部署和首次验证

点击 **保存并部署（Save and Deploy）**，等待依赖安装、`npm run build` 和 Functions 发布完成。打开 `https://你的项目.pages.dev/login`，使用管理员账号登录，再进入 TSub **设置 → 系统设置**确认活动存储。D1 模式还应显示远程 Agent 和部署命令能力。

### 常见问题

- GitHub 授权后看不到仓库：检查 GitHub **Settings → Applications** 中 Cloudflare 的授权范围。
- 构建失败：确认构建命令为 `npm run build`、输出目录为 `dist`、Node.js 为 22+。
- 修改变量后密码错误：确认变量在 Production 环境并重新部署；新变量不会注入旧部署。账号必须是 3-32 位小写字母、数字、点、下划线或连字符，未设置时使用 `admin`；密码为 8-128 位且不能有首尾空格。
- D1 首次访问返回 `storage_initialization_failed`：检查绑定名、D1 权限和部署日志。
- 从旧版本更新后仍提示资源不存在或控制台绑定被锁定：同步上游删除原有 `wrangler.toml`，等待一次部署完成，再在 Pages **设置 → 绑定** 中选择自己的资源并重新部署。

更多截图和迁移细节见 [QUICK_START.md](docs/QUICK_START.md)，英文版见 [QUICK_START_EN.md](docs/QUICK_START_EN.md)。

## 服务器部署

服务器部署运行的是完整的 TSub 主控，适合需要 SQLite/PostgreSQL、远程 Agent 或本机执行器的场景。支持 Docker Compose 和 Debian/Ubuntu/Alpine 裸机安装；Web 主控默认使用非 root 用户运行，root 执行器仅在启用本机代理控制时安装。

### Docker Compose（推荐）

要求 Linux `amd64`/`arm64`、Docker Engine、Compose v2，以及一个已经指向服务器的域名。先获取源码并生成 `.env`：

```bash
git clone https://github.com/btjidi/TSub.git
cd TSub
TSUB_DOMAIN=tsub.example.com sh scripts/init-controller-env.sh
docker compose config
docker compose up -d --build
docker compose ps
```

初始化脚本会生成管理员密码和三个独立加密密钥，并只在终端显示一次密码；请立即保存。Compose 对外提供 `80/443`，内部主控端口 `8787` 不应暴露到公网。验证部署：

```bash
curl -I https://tsub.example.com/login
docker compose logs --tail=100 controller caddy
```

### Debian/Ubuntu/Alpine 裸机

裸机方式需要 Node.js 22、npm、Git、SQLite 原生依赖和 systemd/OpenRC。安装器会创建受限的 `tsub-controller` 用户、生成环境文件并注册服务：

```bash
git clone https://github.com/btjidi/TSub.git
cd TSub
TSUB_DOMAIN=tsub.example.com sh scripts/install-controller.sh
```

部署前放行 `80/TCP`、`443/TCP`（需要 HTTP/3 时再放行 `443/UDP`），不要开放 `8787`。首次登录后在“设置 → 系统设置”确认活动存储，并立即导出备份。

完整的环境变量、HTTPS、执行器、PostgreSQL、多实例、升级和备份步骤见[服务器主控部署](docs/SERVER_DEPLOYMENT.md)，架构说明见[总体架构](docs/ARCHITECTURE.md)。

## 本地开发

```bash
npm ci
npm run dev
npm run test:run
npm run build
```

Pages Functions 本地联调：

```bash
npm run dev:server -- --ip 127.0.0.1 --kv TSUB_KV --persist-to .wrangler/state-local
```

## 文档

- [快速开始](docs/QUICK_START.md)
- [用户指南](docs/USER_GUIDE.md)
- [代理部署](docs/PROXY_DEPLOYMENT.md)
- [服务器主控部署](docs/SERVER_DEPLOYMENT.md)
- [总体架构](docs/ARCHITECTURE.md)
- [API 参考](docs/API_REFERENCE.md)
- [数据模型](docs/DATA_MODEL.md)
- [安全模型](docs/SECURITY.md)
- [运维手册](docs/OPERATIONS.md)
- [开发指南](docs/DEVELOPMENT.md)

许可证：[MIT](LICENSE) · 来源参考：[MiSub](https://github.com/imzyb/MiSub)

[English](QUICK_START_EN.md)

# GitHub 授权部署

本文面向没有现成 Cloudflare 项目的用户，指导你从 GitHub Fork 开始，通过 Cloudflare 控制台的 GitHub 授权部署 TSub。D1 完整模式是推荐路径；KV 基础模式适合只需要订阅管理的轻量场景。

## 部署前准备

- Cloudflare 账号，并能创建 Workers/Pages 项目、D1 数据库和 KV Namespace。
- GitHub 账号。建议将本仓库 Fork 到自己的账号，并保持仓库为公开仓库。
- 管理员密码至少 8 位；请另外准备三个互不相同的随机 Secret。
- 如果使用 D1 完整模式，建议准备一个稳定的 HTTPS 公开地址。

## 1. Fork 仓库

打开 <https://github.com/btjidi/TSub>，点击 **Fork**，选择自己的 GitHub 账号和仓库名称。部署前确认 Fork 仓库可以公开访问，例如直接打开 `https://github.com/<你的账号>/<你的仓库>`。

![Fork TSub 仓库](assets/screenshots/cloudflare/01-fork-repository.png)

Cloudflare 的 GitHub 授权只会显示授权账号能够访问的仓库。私有仓库需要额外的 GitHub 权限和 Cloudflare 计划支持；本教程按公开 Fork 编写。

## 2. 在 Cloudflare 创建项目

1. 登录 <https://dash.cloudflare.com/>。
2. 打开 **Workers & Pages → Create application → Pages → Import existing Git repository**（如果先显示 Worker 创建卡片，点击底部“想要部署 Pages？开始使用”）。界面也可能显示 **Continue with GitHub**。
3. 点击 GitHub 授权按钮，在 GitHub 授权页允许 Cloudflare 访问仓库列表；如果选择“仅选定仓库”，必须勾选你的 TSub Fork。
4. 返回 Cloudflare 后选择该 Fork，点击 **Begin setup** 或 **Install & deploy**。

![Cloudflare 控制台](assets/screenshots/cloudflare/02-cloudflare-dashboard.png)
![GitHub 授权结果](assets/screenshots/cloudflare/04-github-authorization.png)
![选择 TSub 仓库](assets/screenshots/cloudflare/05-select-repository.png)

授权只授予仓库读取和构建所需权限。部署完成后可以在 GitHub 的 **Settings → Applications** 中撤销 Cloudflare 授权。

## 3. 填写构建设置

在项目设置中填写：

| 设置 | 值 |
| --- | --- |
| Framework preset | `Vite` 或 `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | 仓库根目录（留空或填写 `/`） |
| Node.js version | `22` 或更高版本 |

保存后先不要急着部署，下一节先创建并绑定存储。若 Cloudflare 要求环境变量才能开始构建，可先保存项目，再从 **Settings → Variables and Secrets** 添加本教程列出的值。

![Pages 构建设置](assets/screenshots/cloudflare/06-build-settings.png)

## 4. 选择存储模式

每个绑定名称必须完全一致：应用代码读取的是 `TSUB_DB` 和 `TSUB_KV`。全新项目不要同时绑定空 D1 和空 KV，除非你明确设置首次存储策略。

### 推荐：D1 完整模式

1. 打开 Cloudflare **Storage & databases → D1**，点击 **Create database**，创建一个空数据库。
2. 回到 TSub 项目的 **Settings → Bindings**，添加 D1 Database binding。
3. 变量名填写 `TSUB_DB`，选择刚创建的数据库并保存。
4. 不添加 `TSUB_KV`，也不设置 `TSUB_INITIAL_STORAGE`。

![创建 D1 数据库](assets/screenshots/cloudflare/07-create-d1.png)
![绑定 D1 数据库](assets/screenshots/cloudflare/08-bind-d1.png)

部署后的首次请求会幂等创建缺失表、索引和唯一的 `storage_control` 记录，不需要手工执行 `schema.sql`。D1 完整模式支持代理部署、远程 Agent、命令队列和实时心跳。

### 可选：KV 基础模式

1. 打开 Cloudflare **Storage & databases → KV**，点击 **Create namespace**。
2. 回到 TSub 项目的 **Settings → Bindings**，添加 KV Namespace binding。
3. 变量名填写 `TSUB_KV`，选择刚创建的 Namespace 并保存。
4. 不添加 `TSUB_DB`，也不设置 `TSUB_INITIAL_STORAGE`。

![创建 KV Namespace](assets/screenshots/cloudflare/09-create-kv.png)
![绑定 KV Namespace](assets/screenshots/cloudflare/10-bind-kv.png)

KV 基础模式支持订阅、节点、Profile、一次性命令和主动推送，但不支持远程 Agent、部署命令和实时心跳。需要这些能力时请使用 D1。

### 已有 KV 迁移到 D1

不要只修改绑定名称或环境变量来切换已有数据。保留原 `TSUB_KV`，创建并绑定 `TSUB_DB` 后重新部署；登录 TSub，在 **设置 → 系统设置** 导出备份并执行 KV→D1 迁移。系统会加写锁、复制记录、核对数量和 SHA-256 摘要，校验成功后才原子切换。

## 5. 配置变量和 Secrets

在项目的 **Settings → Variables and Secrets** 中为生产环境添加以下值。敏感值选择 **Encrypt**，不要写入 GitHub 或 `wrangler.toml`。

| 名称 | 必需 | 建议值/用途 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 否 | 管理员账号，默认 `admin` |
| `ADMIN_PASSWORD` | 是 | 至少 8 位的初始管理员密码 |
| `COOKIE_SECRET` | 是 | 登录 Cookie 签名用的独立随机值 |
| `DEPLOYMENT_SECRET_KEY` | 代理部署需要 | AES-GCM 部署配置密钥，使用独立随机值 |
| `SETTINGS_SECRET_KEY` | 建议 | WebDAV、通知、Cron 和 External API Secret 的独立 AES-GCM 密钥 |
| `TSUB_PUBLIC_URL` | 建议 | TSub 的公开 HTTPS 地址，例如 `https://tsub.example.com` |

缺少 `SETTINGS_SECRET_KEY` 时，旧配置会兼容使用 `DEPLOYMENT_SECRET_KEY`，但新部署建议始终设置独立值。三个加密 Secret 必须离线保存；只有数据库而没有原 Secret，部署和设置密文无法恢复。

![配置变量和 Secrets](assets/screenshots/cloudflare/11-configure-secrets.png)

## 6. 部署和首次验证

1. 点击 **Save and Deploy**，等待依赖安装、`npm run build` 和 Pages/Workers 发布完成。
2. 打开 Cloudflare 分配的 `*.pages.dev` 地址，进入 `/login`。
3. 使用 `ADMIN_USERNAME`（未设置则为 `admin`）和 `ADMIN_PASSWORD` 登录。
4. 打开 **设置 → 系统设置**，确认活动存储为 D1 或 KV，并确认平台能力与所选模式一致。
5. 立即修改管理员凭据并重新登录，然后配置第一份备份、通知和公开页面设置。
6. 添加一个订阅源或手动节点，在“我的订阅”生成 Profile，验证输出链接可访问。

![部署开始](assets/screenshots/cloudflare/12-deploy-started.png)
![部署成功](assets/screenshots/cloudflare/13-deploy-success.png)
![首次登录](assets/screenshots/cloudflare/14-first-login.png)

D1 模式还应在“代理部署”中确认远程 Agent 和命令入口可用。KV 模式中这些入口应显示为不可用，而不是报告虚假的成功状态。

![存储类型验证](assets/screenshots/cloudflare/15-storage-verification.png)

## 7. Fork 与 `wrangler.toml` 资源 ID

仓库内的 `wrangler.toml` 包含示例生产账号的 KV/D1 ID，供维护者的受控发布脚本校验使用。Fork 到自己的账号后，不要直接执行维护者的 `npm run deploy:pages`，也不要把这些 ID 当作自己的资源。

通过 Cloudflare Git 集成部署时，以项目设置中的 `TSUB_DB`/`TSUB_KV` 绑定为准。若 Wrangler 报告资源不属于当前账号，请将 Fork 中的绑定 ID 替换为自己的资源，或移除旧绑定后完全使用 Cloudflare 控制台绑定，再重新部署。

## 常见问题

- **GitHub 授权后看不到仓库**：在 GitHub **Settings → Applications** 检查 Cloudflare 的授权范围，重新授予对 Fork 的访问权限。
- **构建失败**：确认根目录、`npm run build`、输出目录 `dist` 和 Node.js 22+；查看部署日志中的首个错误。
- **功能显示为基础模式**：检查绑定名称是否严格为 `TSUB_DB` 或 `TSUB_KV`，并确认修改后已重新部署。
- **D1 首次访问返回 `storage_initialization_failed`**：检查 D1 绑定、账号权限和部署日志；不要在没有备份的情况下切换到另一种存储。
- **登录后立即失效**：确认 `COOKIE_SECRET` 没有变化，公开地址使用 HTTPS，且反向代理正确传递协议。
- **公开链接地址不正确**：设置 `TSUB_PUBLIC_URL` 为实际公开 HTTPS 地址并重新部署，再在设置页检查公开页面配置。
- **Fork 部署引用了原账号资源**：替换或移除 `wrangler.toml` 中的示例资源 ID，使用自己的 Cloudflare 绑定。

## 截图清单

Cloudflare 控制台会随账号、地区和产品界面更新。截图按 `docs/assets/screenshots/cloudflare/cloudflare-screenshot-checklist.txt` 的清单提供，并已遮挡账号 ID、邮箱、密码、Token、Cookie 和私有 GitHub 信息。公开部署地址仅用于演示，生产环境请替换为自己的地址和 Secret。

更多信息：[用户指南](USER_GUIDE.md) · [运维手册](OPERATIONS.md) · [安全模型](SECURITY.md)

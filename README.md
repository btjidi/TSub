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

| 我的订阅 | 代理部署 |
| --- | --- |
| ![我的订阅](docs/assets/screenshots/my-subscriptions.png) | ![代理部署](docs/assets/screenshots/proxy-deployments.png) |

## Cloudflare GitHub 授权部署

推荐先 Fork 本仓库，再在 Cloudflare 中授权 GitHub 并选择自己的公开 Fork。完整的逐步配置、D1/KV 绑定、Secrets、首次登录和故障排查见[GitHub 授权部署教程](docs/QUICK_START.md)。

构建命令使用 `npm run build`，输出目录使用 `dist`，Node.js 版本使用 22 或更高。Fork 后必须在自己的 Cloudflare 账号中创建并绑定 `TSUB_DB` 或 `TSUB_KV`；仓库中的 `wrangler.toml` 资源 ID 属于示例生产账号，不能直接复用。

服务器主控支持 Docker Compose 和 Debian/Ubuntu/Alpine 裸机安装，默认由非 root Web 服务配合独立 root 执行器工作。参见[服务器主控部署](docs/SERVER_DEPLOYMENT.md)和[总体架构](docs/ARCHITECTURE.md)。

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

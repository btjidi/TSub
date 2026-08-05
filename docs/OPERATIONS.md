[English](OPERATIONS_EN.md)

# 运维手册

## 日常检查

- 仪表盘中的启用来源、节点、Profile 与流量是否符合预期。
- 主动推送最后时间是否超过周期三倍，流量后端是否降级。
- 部署状态、最近成功时间、资源档位、RSS 与 degraded 原因。
- Cron、Telegram 和 WebDAV 最近执行状态。
- KV/D1 配额与 Pages Functions 错误率，或服务器数据库、内部调度租约和磁盘状态。

## 备份与恢复

系统可导出数据备份，也可按计划写入 WebDAV。备份包括真实订阅、Profile、规则模板、部署密文和操作审计；不包括演示数据、明文部署秘密、WebDAV 密码或会话密钥。恢复前自动创建预恢复快照，恢复演示数据需重新在系统设置生成。

## Cron

外部 Cron 可请求 `/cron` 或认证管理触发接口，用于严格定时的订阅刷新、通知和 WebDAV 备份。普通管理访问只进行惰性到期检查。截图演示请求不会触发计划任务。

服务器主控使用内部调度器。SQLite 只运行一个主控进程；PostgreSQL 通过 `scheduler_leases` 保证多实例中只有一个实例执行同一周期任务。

## 存储迁移

Cloudflare 可在 KV 与 D1 间切换，服务器可在 SQLite 与 PostgreSQL 间切换。设置页依次执行预检、写锁、排空、复制、计数与 SHA-256 校验、原子切换和解锁；迁移期间读取继续使用源存储，写请求返回 `503` 和 `Retry-After`。不要通过普通设置修改 `storageType`。

纯 D1 项目只需绑定 `TSUB_DB`；首次请求自动补齐 Schema 和 `storage_control`。纯 KV 项目只绑定 `TSUB_KV`。双绑定全新项目默认 KV，可用 `TSUB_INITIAL_STORAGE` 指定首次选择；已有控制记录始终优先。两侧数据冲突且没有明确变量时，系统返回脱敏 503，不会猜测、覆盖或合并数据。

切回 KV 前必须等待已领取或运行中的远程命令完成，未领取命令会取消。服务器活动库记录在权限 `0600` 的 `/var/lib/tsub-controller/storage-control.json`；进程重启后仍按该文件选择数据库。迁移失败可继续调用同一迁移 ID 的 `advance`，摘要不一致时不会切换。

Cloudflare 与服务器之间使用密码保护迁移包。包以 PBKDF2-SHA256 600,000 次派生 AES-256-GCM 密钥；导入会用目标主控密钥重新加密部署秘密，并将 Agent 标记为待重新接入。普通备份不包含命令租约、心跳或 Agent 凭据。

## 升级

1. 导出备份并记录当前 Pages 部署版本。
2. 在分支运行单元测试、Runtime 检查、文档检查和生产构建。
3. 检查 `schema.sql` 与环境变量变化。
4. 部署预览环境，验证登录、订阅输出与部署命令。
5. 部署生产并观察错误日志。

Runtime 核心升级必须更新版本、URL 和 SHA-256。无变化 Apply 不下载、不重写配置、不重启；涉及核心升级时健康检查失败会恢复旧二进制和配置。

## 回滚

Pages 可回滚到上一成功部署。数据库兼容问题优先从部署前备份恢复。服务器使用部署操作中的 `rollback`；不要手工删除快照或旧二进制，直到稳定性确认。

## 常见问题

Cloudflare 主控可在“设置 → 系统设置 → 数据存储”启用 D1/KV 额度查询。创建限定当前账号的自定义 API Token，并仅授予 `Account Analytics: Read`、`D1: Read`、`Workers KV Storage: Read`；不要使用 Global API Key。检测权限后选择 TSub 对应的 D1 数据库和 KV 命名空间。页面按账号总量计算剩余额度，并单列当前 TSub 资源用量与最近 7 天 UTC 趋势。

- **401 登录失败**：确认账号已转为小写、密码没有首尾空格、`COOKIE_SECRET` 稳定，检查是否修改凭据导致旧会话失效。
- **存储不可用**：Cloudflare 检查活动模式对应的 `TSUB_KV` 或 `TSUB_DB` 绑定；初始化 503 使用 `requestId` 查询 Functions 日志。服务器检查 SQLite 文件权限或 `TSUB_POSTGRES_URL`。只有校验迁移完成后才切换。
- **本机执行器离线**：检查 `/run/tsub/controller.sock`、`/run/tsub/executor.conf` 权限、`tsub-executor` 服务和固定 Runtime 的 SHA-256。
- **主动推送过期**：在服务器运行 `tsub` 菜单立即推送，检查定时入口、DNS、系统时间和 Push Token 代次。
- **统计不可用**：检查 nftables/iptables 权限；无 `CAP_NET_ADMIN` 时确认核心统计接口仅监听回环并运行正常。
- **64MB 安装失败**：核对真实 cgroup 限制、磁盘下载峰值、PID 和单核心约束；不要通过创建 Swap 绕过规划器。
- **订阅为空**：检查来源状态和保护缓存，逐条查看非法节点统计，确认 Profile 关联未被禁用。

## 生产演示截图

```bash
TSUB_SCREENSHOT_URL=https://example.pages.dev \
TSUB_ADMIN_USERNAME=admin \
TSUB_ADMIN_PASSWORD='...' \
npm run docs:screenshots
```

脚本刷新独立演示数据，设置中文与亮色主题，并输出到 `docs/assets/screenshots/`。凭据不得写入命令历史、仓库或 CI 日志；推荐通过 CI Secret 注入。

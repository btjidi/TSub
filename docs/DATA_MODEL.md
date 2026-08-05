[English](DATA_MODEL_EN.md)

# 数据模型

## 业务集合

- `tsub_subscriptions_v1`：订阅源与手动节点。HTTP(S) URL 表示订阅源，分享协议 URL 表示节点。
- `tsub_profiles_v1`：Profile、来源 ID、手动节点 ID、转换和操作符配置。
- `worker_settings_v1`：界面、公开页、通知、转换、WebDAV 和 External API 设置。
- `tsub_rule_templates_v1`：自定义规则模板。
- `tsub_deployments_v2`：部署公开摘要、状态和 AES-GCM 配置密文。
- `tsub_deployment_operations_v2`：操作、事件、资源与审计结果。
- `tsub_deployment_defaults_v2`：AES-GCM 加密的生成器系统默认。
- `tsub_demo_data_v1`：独立、只读演示数据。

D1 将订阅和 Profile 保存为独立行，通用键值对象保存在 `settings` 表；KV 使用相同逻辑键。SQLite 与 PostgreSQL 使用相同 SQL schema。Cloudflare D1 直装会自动初始化结构；[schema.sql](../schema.sql) 可用于手工预初始化和审计。

完整模式还包含 `deployments`、`deployment_operations`、`deployment_events`、`deployment_snapshots`、`deployment_commands`、`deployment_agents`、`deployment_heartbeats`、`controller_transfers`、`storage_control`、`storage_migrations`、`schema_migrations` 和 `scheduler_leases`。事件逐条追加，API 只聚合最近 50 条；快照按部署、代次、序号和摘要条件更新。

## 订阅源

核心字段为 `id`、`name`、`url`、`enabled`、`nodeCount` 和可选 `userInfo`。部署来源还包含 `source.kind`、`deploymentId`、`serverAddress`、`lastPushAt`、`pushCount`、`pushHistory`、`pushIntervalMinutes` 与 `trafficBackend`。

## Profile

Profile 使用稳定 `id/customId`，通过 `subscriptions[]` 和 `manualNodes[]` 关联来源，不复制节点内容。公开输出只读取启用的真实 Profile。下载计数使用独立计数键。

## 部署

部署摘要不包含密码、私钥或 Token。随机端口、UUID、证书策略、推送密钥和完整 Runtime 配置均在创建时解析并写入 `encryptedConfig`。操作状态为 `pending`、`running`、`succeeded`、`failed`、`expired`，部署额外支持 `offline`。

命令包含 120 秒租约和默认 30 分钟过期时间；相同心跳最多每 60 秒落库，Runtime、核心、配置版本或轮询频率变化时立即更新。离线窗口至少为 150 秒，并随 Agent 轮询频率扩大到三个周期。删除部署依靠外键级联清理事件、快照、命令、Agent、心跳和转移凭据。

## 演示隔离

演示记录只存在 `tsub_demo_data_v1`，名称以“演示 ·”开头并带 `demo: true`。普通保存会丢弃客户端提交的演示记录与 `demo-*` 删除 Diff。公开订阅、Cron、通知、备份、External API 和机器回调不读取该键；删除或刷新它不改变任何业务集合。

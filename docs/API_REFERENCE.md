[English](API_REFERENCE_EN.md)

# API 参考

## 认证

管理接口使用 HttpOnly、SameSite Cookie。登录请求为 `POST /api/login`：

```json
{ "username": "admin", "password": "your-password" }
```

账号会去除首尾空格并转为小写。修改凭据后认证版本递增，旧会话立即失效。

## 管理接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/data` | 读取订阅、节点、Profile 与配置摘要 |
| POST | `/api/tsubs` | 保存真实订阅和 Profile |
| GET/POST | `/api/settings` | 读取或保存设置 |
| GET/PUT | `/api/settings/credentials` | 读取元数据或修改凭据 |
| POST | `/api/settings/credentials/reset` | 恢复环境凭据 |
| GET/POST/DELETE | `/api/demo-data` | 查看、生成/刷新、清除隔离演示数据 |
| GET/POST | `/api/deployments` | 列表或创建部署 |
| GET/PATCH/DELETE | `/api/deployments/:id` | 读取、修改或删除部署 |
| GET/POST | `/api/deployments/:id/operations` | 操作历史或创建运维命令 |
| POST | `/api/deployments/:id/commands` | 将固定动作加入 Agent 远程队列 |
| POST | `/api/deployments/:id/local-executor` | 服务器主控绑定本机执行器 |
| POST | `/api/deployments/:id/transfer-claim` | 在目标主控生成一次性转移凭据 |
| POST | `/api/deployments/:id/controller-transfer` | 从旧主控下发所有权转移 |
| DELETE/POST | `/api/deployments/:id/source` | 禁用或恢复部署来源 |
| GET/PUT/DELETE | `/api/deployment-defaults` | 管理加密部署默认值 |
| GET/POST | `/api/rule_templates` | 管理规则模板 |
| GET | `/api/logs` | 查看访问日志 |
| GET/POST | `/api/backup/*` | 导出、恢复和 WebDAV 操作 |
| GET | `/api/system/capabilities` | 查询平台、存储和可用控制能力 |
| GET | `/api/storage/status` | 查询活动存储与绑定 |
| POST | `/api/storage/migrations` | 创建可恢复存储迁移 |
| GET/POST | `/api/storage/migrations/:id[/advance]` | 查询或推进迁移状态机 |
| POST | `/api/backup/portable/export` | 生成密码加密的跨主控迁移包 |
| POST | `/api/backup/portable/import` | 导入并用目标密钥重新加密 |

`X-TSub-Demo-View: 1` 只用于认证后的文档截图：`/api/data` 和 `/api/deployments` 仅返回演示记录，设置与凭据响应脱敏。普通客户端不应设置它。

## 机器接口

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `/api/deploy/bootstrap` | 一次性 Bootstrap Bearer |
| POST | `/api/deploy/events` | Callback Bearer |
| POST | `/api/deploy/push/:deploymentId` | 部署 Push Bearer |
| GET | `/api/deploy/subscriptions/:deploymentId/:token` | 订阅 UUID |
| POST | `/api/deploy/agent/poll` | Agent Bearer |
| GET | `/api/deploy/agent/commands/:id/config` | Agent Bearer + 命令租约 |
| POST | `/api/deploy/agent/commands/:id/events` | Agent Bearer + 命令租约 |
| POST | `/api/deploy/agent/transfer/claim` | 一次性转移 Bearer |

推送正文是可流式处理的 `key=value` 文本，最大 256KiB、最多 1000 个节点。主控校验配置代次、递增序号、节点协议和内容哈希；相同重试幂等成功。

## External Management API

系统设置中启用后，可信自动化可使用 `Authorization: Bearer <token>` 访问 `/api/ext/v1` 下的订阅、节点和 Profile 路由。Token 只授予管理能力，不应用于浏览器登录。演示数据不会出现在 External API 中。

请求示例：

```bash
curl -H "Authorization: Bearer $TSUB_EXTERNAL_TOKEN" \
  https://example.pages.dev/api/ext/v1/subscriptions
```

## 错误

响应通常使用 `{ "success": false, "error": "..." }` 或 `message`。常见状态：`400` 校验错误、`401` 未登录、`403` Token 无效、`404` 不存在、`409` 状态冲突或只读记录、`413` 载荷过大、`503` 存储或部署资产不可用。

[English](ARCHITECTURE_EN.md)

# 总体架构

```text
浏览器
  ├─ 管理 Cookie API ─> 标准 Request/Response 应用核心
  │                        ├─ Cloudflare 适配器 ─> KV / D1
  │                        └─ Node 22 适配器 ───> SQLite / PostgreSQL
  ├─ 公开 Profile ───> 转换与操作符链 ─────────────> 客户端
  └─ 部署控制 ─────────> Manual Bootstrap / Remote Agent / Local Executor
                              └─ TSub Proxy ───────> Xray / sing-box
```

## 边界

- Web 前端位于 `src/`，生产静态文件由 Vite 输出到 `dist/`。
- Pages Functions 位于 `functions/`，负责认证、存储、转换、通知、备份和部署协议。
- `server/` 提供 Node 22 HTTP、可信反向代理、内部调度器、数据库连接和 Unix Socket 适配。
- Runtime 模块位于 `runtime/v2/modules/`，构建为 `public/proxy/v2/tsub-proxy.sh`。
- 主控与服务器 Runtime 通过短时 Bootstrap、Callback 和长期但可轮换的 Push Token 通信。
- 核心二进制来自固定、可追溯、带 SHA-256 的发布资产，不内嵌进 Pages。

## 数据路径

管理页面通过 `/api/data` 读取订阅源、手动节点、Profile 和设置摘要。公开订阅只读取真实 Profile 关联集合，经过节点解析、保护缓存、操作符和目标格式渲染后返回。演示数据使用独立键，只在管理读取场景合并。

代理部署配置在创建时解析所有随机值，然后 AES-GCM 加密保存。服务器领取一次性 Bootstrap 后执行事务安装；事件更新部署摘要与审计。主动推送使用稳定来源 ID 原子替换节点缓存。

## 能力与存储

前端只读取 `/api/system/capabilities`，不根据平台名推断功能。KV 保留一次性命令、订阅和主动推送；D1、SQLite、PostgreSQL 使用独立部署、操作、事件、快照、命令、Agent 和心跳记录。SQLite 开启 WAL、外键和 `busy_timeout` 且限制单实例；PostgreSQL 允许多实例并通过数据库租约去重计划任务。

同机控制由非 root Web 主控通过 `0660` Unix Socket 与独立 root 执行器通信。执行器只领取固定动作和校验后的 V2 配置，不接受任意 Shell、路径或环境变量。远程服务器只主动轮询主控，不需要主控保存 SSH 凭据。

## 可用性

Cloudflare 可仅绑定 KV 进入基础模式，也可仅绑定 D1 进入完整模式；D1 不再依赖 KV。服务器默认 SQLite，可迁移 PostgreSQL。保护性节点缓存避免上游短暂失败清空订阅。服务器无 init、TUN 或网络管理权限时按能力降级，不虚假报告成功。

相关文档：[数据模型](DATA_MODEL.md) · [安全模型](SECURITY.md) · [运维手册](OPERATIONS.md)

[English](SECURITY_EN.md)

# 安全模型

## 信任边界

浏览器管理端、主控适配层、存储、Agent/本机执行器、服务器 Runtime、代理核心和外部订阅均属于不同边界。KV 模式不连接服务器；完整模式由 Agent 主动出站轮询。服务器本地 HTTP 订阅不提供 TLS，只依靠高熵路径 Token，推荐客户端使用主控 HTTPS 镜像。

## 身份与会话

- 管理员账号 3–32 位，密码 8–128 位。
- 后台修改的密码使用 PBKDF2-SHA256 加盐保存，不保存明文。
- HttpOnly Cookie 使用稳定密钥签名，SameSite 限制跨站发送。
- 凭据版本变化会使所有旧会话失效。
- External API、Bootstrap、Callback、Push 和订阅 Token 互不复用。
- Agent Token 为独立 256 位随机值，主控只保存 SHA-256；命令租约 120 秒且同一部署只有一个活动修改命令。

## 部署秘密

`DEPLOYMENT_SECRET_KEY` 派生代理部署配置的 AES-256-GCM 密钥。WebDAV、Telegram、Cron 和 External API Secret 优先使用 `SETTINGS_SECRET_KEY` 独立加密，未配置时兼容回退 `DEPLOYMENT_SECRET_KEY`。旧明文设置会自动迁移到独立加密记录。数据库公开设置、管理列表、日志、备份和错误响应不返回密码、Reality/WARP 私钥、证书私钥或 Token。Bootstrap Token 只存 SHA-256 摘要并单次使用。

## 输入与网络

API 限制 JSON 和推送载荷大小，节点只接受支持的分享协议。外部 Fetch、订阅刷新和 WebDAV 均执行 URL/地址校验以降低 SSRF 风险。远程规则脚本和代理地址由管理员负责信任评估。

## 服务器权限

Runtime 优先最小权限；无 root 时使用用户目录并禁止低端口、系统防火墙和系统服务。配置与秘密文件使用 `0600`，目录使用 `0700`，临时文件按阶段删除。服务、配置和防火墙切换失败会事务回滚。

服务器 Web 主控使用独立非 root 用户。本机 root 执行器通过专用 Unix Socket 领取固定动作，只接受服务端已验证配置，不接受任意 Shell、路径或环境变量。Socket 为 `0660`，配置、Token 和临时文件为 `0600`；Docker 主控不得挂载 Docker Socket 或使用 `privileged`。

Node 适配层只采信 `TSUB_TRUST_PROXY` 明确允许来源的转发协议、主机和客户端地址。裸机默认只信任回环 Caddy/Nginx；Compose 使用隔离私网且主控端口不映射到宿主机。公网地址以 `TSUB_PUBLIC_URL` 为最终依据。

主控转移使用 30 分钟一次性领取凭据，目标只保存哈希。节点先验证目标 HTTPS 并领取新 Agent Token，原子写入本地配置后才通知旧主控吊销；目标注册失败不会替换旧主控。迁移包密码从不保存或写日志，AES-GCM 标签和规范化摘要共同检测篡改。

## 演示与截图

演示数据使用 RFC 5737 地址和 `.invalid` 域名。截图请求只返回演示记录与脱敏设置，不触发 Cron。演示 URL 不可复制，Profile 不可公开。截图脚本从环境变量读取凭据，并在保存前检查已知敏感值。

## 运维要求

定期轮换管理员密码、Cookie 密钥、部署密钥和 External API Token。更换部署密钥前需重新创建或迁移部署密文；丢失旧密钥无法解密。不要提交 `.dev.vars`、Cloudflare Token、服务器密码或真实订阅链接。

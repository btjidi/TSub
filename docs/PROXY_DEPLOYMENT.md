[English](PROXY_DEPLOYMENT_EN.md)

# 代理部署

TSub Proxy 是独立的 POSIX `/bin/sh` Runtime。主控不保存 SSH 凭据；基础模式使用一次性命令，完整模式还可由服务器 Agent 主动轮询或由同机特权执行器直控。

![代理部署记录](assets/screenshots/proxy-deployments.png)

## 工作流

1. 管理员创建 `schemaVersion: 2` 声明配置。
2. 主控解析随机端口、UUID、密码、订阅 Token 和内部统计端口，并以 AES-GCM 保存。
3. 主控签发 30 分钟有效、领取一次即失效的 Bootstrap Token。
4. 服务器下载 Bootstrap，再下载同域 Runtime 并校验 SHA-256。
5. Runtime 检测系统、架构、容器、init、cgroup、磁盘、PID、TUN 与网络权限。
6. Runtime 按需安装最小依赖，串行下载已锁定核心，原生校验配置并事务切换服务。
7. 成功后输出协议、完整节点、本地 HTTP 订阅、HTTPS 镜像及控制命令。
8. 启用主动推送时立即上报，此后按 5、15、30 或 60 分钟周期推送。

## Agent 与本机执行器

D1、SQLite 和 PostgreSQL 可为部署签发独立 Agent Token。Agent 默认每 30 秒领取一次命令、最多每 60 秒写心跳；KV 模式下不接收命令并退避到 5 分钟。同一部署仅允许一个活动修改命令，租约失效后可重新领取。

服务器主控可将一个部署绑定到本机执行器。Web 进程不以 root 运行，执行器通过 `/run/tsub/controller.sock` 领取 `apply/update/restart/repair/status/doctor/rollback/uninstall` 固定动作。更新、修复、重启和回滚由主控确认，卸载必须输入部署名称；一次性 Bootstrap 仍在服务器终端输入 `Y/y`。

主控所有权转移先在目标生成一次性领取凭据，再由旧主控下发 `transfer-controller`。节点只有在目标 HTTPS 注册成功后才原子替换 Agent 配置；失败继续使用旧主控。旧主控不可用时使用一次性 Update 命令人工重新绑定。

## 协议与核心

| 协议 | 核心 | 传输 | TLS |
| --- | --- | --- | --- |
| VLESS | Xray / sing-box | TCP、WebSocket、gRPC；XHTTP 仅 Xray | 无、TLS、Reality |
| VMess | Xray / sing-box | TCP、WebSocket、gRPC | 无、TLS |
| Trojan | Xray / sing-box | TCP、WebSocket、gRPC | 固定 TLS |
| Hysteria2 | Xray / sing-box | 原生 Hysteria2/QUIC | 固定 TLS |
| TUIC v5 | sing-box | 原生 TUIC/QUIC | 固定 TLS |
| AnyTLS | sing-box | 原生 AnyTLS/TCP | 固定 TLS |
| Shadowsocks 2022 / SOCKS5 | Xray / sing-box | 原生 TCP+UDP | 无 TLS |
| NaiveProxy | Naive | 原生 HTTPS/H2/H3 | 可信 TLS |

自动核心会计算全部入站的能力交集。统一传输和统一 TLS 只应用到兼容协议，协议原生传输不会被覆盖。Reality 仅允许 VLESS 的 TCP/RAW、gRPC 和 XHTTP，不支持 WebSocket；XHTTP H3 要求 TLS，并同时开放同端口 UDP，Reality + XHTTP 使用 H2/TCP。自签 TUIC 分享链接同时携带证书 SHA-256 (`pcs`) 和 SPKI SHA-256 (`spki`)；`target=singbox` 使用 SPKI 严格验证并关闭 `insecure`，v2rayN、Shadowrocket 和 Loon 为兼容连接保留跳过 CA 校验参数。旧快照缺少任一指纹时，主控暂时过滤 TUIC，并通过部署记录及 `X-TSub-TUIC-Pin-Status` / `X-TSub-TUIC-Pin-Filtered` 响应头提示更新配置。生产环境仍优先使用 ACME DNS-01 可信证书。

## 凭据与命名

- 统一 UUID 默认开启；留空时生成一次并供 UUID 入站共享。
- 关闭统一 UUID 后，每条 UUID 入站独立生成并持久化；订阅 Token 也使用独立 UUID。
- 统一密码可单独关闭；Shadowsocks 2022 始终使用符合算法长度的独立密钥。
- 单入站显式值优先于本次全局配置，再优先于系统默认和协议内置默认。
- 节点名称可显式填写，也可使用“部署-协议-端口”“前缀-协议-端口”或“协议-随机后缀”。
- Reality 密钥和自签证书由已校验核心生成，并在无变化 Apply、Repair、Update 中复用。

## 低内存运行

`tiny` 为不超过 96MB，`small` 为 97–192MB，`standard` 为超过 192MB。Tiny 档串行下载、校验和配置测试，只允许一个主核心；预计总 RSS 必须低于 cgroup 上限的 80%。Xray 和 sing-box 在 Tiny 档使用 Go 内存上限，核心和安装进程在 OOM 时优先于 SSH/Agent 被回收。安装器自身不依赖 Node、Python、jq、编译器或 unzip。

精确限制为 64MB 的节点必须使用已预解包并固定 SHA-256 的 `binary` 核心资产；Runtime 会在下载前拒绝峰值不可控的 `tar.gz` 解包。该限制不受宿主机可见内存或 Swap 数量影响，以 cgroup 的 `memory.max` 和原始当前占用为准。

Runtime 会检测宿主机 Swap 总量、可用量和使用量，并兼容上报 cgroup v2 `memory.swap.*` 与 cgroup v1 `memory.memsw.*`。这些指标仅用于部署记录诊断，不计入可用内存、资源档位或安装准入预算。

Runtime 支持 amd64/arm64，并按 systemd、OpenRC、runit/s6、rc.local、crontab、nohup+pidfile 选择服务入口；不能持久化时明确标记 degraded。当前兼容性验证级别如下：

| 系统/入口 | 验证级别 |
| --- | --- |
| Debian 13 + systemd | 真机完整验证 |
| Alpine + OpenRC | 真机完整验证 |
| Ubuntu 24.04、Debian Bookworm、Alpine 3.21 | CI/容器验证 |
| Rocky Linux 9 | CI/容器验证；包含 dnf 依赖与 SELinux 状态提示 |
| RHEL、AlmaLinux、Fedora | 与 Rocky 共用检测及依赖映射，尚未长期真机验证 |
| runit、s6、rc.local、crontab、nohup | 静态或模拟生命周期测试，尚未长期真机验证 |

RHEL 系在预检时显示 SELinux 状态；Enforcing 模式下若服务启动失败，应结合系统审计日志检查本机策略。

## 订阅与主动推送

服务器本地订阅由 BusyBox HTTP 服务提供，高熵 UUID 路径保护但没有 TLS。主动推送使用独立 256 位 Bearer Token、配置代次与单调序号；主控校验后原子替换缓存，并提供自身 HTTPS 镜像。主控不会回源服务器高端口。

推送失败不会停止代理。主控记录接受次数和最近五次时间；重复快照按幂等成功但不重复计数。关闭周期推送时保留安装快照。

## CDN、Argo Tunnel 与 WARP

- “已有橙云域名”要求源站入站使用 Cloudflare 支持的 HTTPS 端口和 TLS；Cloudflare 不提供任意端口映射。
- Quick Tunnel 仅允许一个 WebSocket 入站，用于临时测试。Runtime 只接受严格匹配 `*.trycloudflare.com` 的发现结果，域名变化后立即回传主控并重新生成节点。
- “TSub 托管固定 Tunnel”使用每部署独立 Tunnel、DNS CNAME 和仅指向 `127.0.0.1` 的 ingress。API Token 最小权限为 `Cloudflare Tunnel: Edit`、`Zone: Read`、`DNS: Edit`，不会复用用量查询的只读 Token。
- WebSocket 为正式支持；gRPC 和 XHTTP 经 CDN/Tunnel 标记为实验。原生 TCP、Reality、Hysteria2、TUIC 和 XHTTP H3 不支持免费 Cloudflare CDN 转发。
- 每个入站可选择仅直连、直连加 CDN 或仅 CDN。边缘节点始终使用入口域名作为 Host/SNI，并移除源站自签证书 Pin 与 `allowInsecure`。
- 卸载节点默认保留 Cloudflare 资源；删除部署记录前必须显式清理资源，或明确选择保留。资源清理要求再次输入部署名称。
- 自动 WARP 使用固定 SHA-256 的 `wgcf v2.2.22` 注册独立免费身份。账户和私钥只保存在服务器 `0600` 状态文件中，更新、修复和重启会复用；复用配置创建的新部署会重新注册。

## 流量统计

自动优先级为 `nftables → iptables → sing-box 核心统计 → Xray 核心统计 → unavailable`。防火墙后端只统计代理入站目标端口为上传、源端口为下载，并合并 IPv4/IPv6。核心后端使用仅监听 `127.0.0.1` 的受保护统计接口。固定状态文件小于 16KiB，每个推送周期 checkpoint 一次。

## 运维命令

`plan`、`apply`、`status`、`list`、`update`、`restart`、`repair`、`doctor`、`rollback`、`uninstall` 均由一次性操作命令触发。安装后的 `tsub` 菜单只提供查看节点/订阅和立即主动推送，不执行高风险操作。

## 核心资产变量

每个启用组件都要配置固定版本、amd64/arm64 的预解包 URL 与 64 位 SHA-256，例如：

```text
TSUB_XRAY_VERSION
TSUB_XRAY_AMD64_URL
TSUB_XRAY_AMD64_SHA256
TSUB_XRAY_ARM64_URL
TSUB_XRAY_ARM64_SHA256
TSUB_SINGBOX_VERSION
TSUB_SINGBOX_AMD64_URL
TSUB_SINGBOX_AMD64_SHA256
TSUB_SINGBOX_ARM64_URL
TSUB_SINGBOX_ARM64_SHA256
TSUB_BUSYBOX_VERSION
TSUB_BUSYBOX_AMD64_URL
TSUB_BUSYBOX_AMD64_SHA256
TSUB_BUSYBOX_ARM64_URL
TSUB_BUSYBOX_ARM64_SHA256
```

资产默认为预解包的 `binary`。若使用官方 `tar.gz`，还必须设置对应架构的 `*_FORMAT=tar.gz` 和 `*_BINARY_SHA256`；Runtime 会先校验压缩包，再校验唯一提取出的二进制文件。

可选组件使用同样的 `TSUB_CLOUDFLARED_*`、`TSUB_WGCF_*`、`TSUB_LEGO_*`、`TSUB_NAIVE_*` 结构。`latest` 通道使用独立 `*_LATEST_*` 变量；`pinned` 读取 `TSUB_PINNED_CORE_MANIFEST`。

上游脚本会修改服务、防火墙和端口。执行生成命令前应检查服务器备份、端口占用、服务权限和证书策略。

[简体中文](PROXY_DEPLOYMENT.md)

# Proxy Deployment

TSub Proxy is an independent POSIX `/bin/sh` runtime. The controller stores no SSH credentials. Basic mode uses one-time commands; full mode also supports outbound server agents and a same-host privileged executor.

![Proxy deployment records](assets/screenshots/proxy-deployments.png)

## Workflow

1. An administrator creates a declarative `schemaVersion: 2` configuration.
2. The control plane resolves random ports, credentials, subscription tokens, and internal statistics ports, then encrypts the result with AES-GCM.
3. It issues a one-time Bootstrap token with a 30-minute lifetime.
4. The server downloads Bootstrap, then fetches and verifies the same-origin Runtime.
5. Runtime detects OS, architecture, container, init, cgroup, disk, PID, TUN, and network capabilities.
6. It installs only missing required dependencies, downloads pinned cores serially, validates native configuration, and switches services transactionally.
7. Success output contains protocol summaries, complete nodes, local HTTP and control-plane HTTPS subscription URLs, and the control command.
8. Active push sends immediately and then every 5, 15, 30, or 60 minutes.

## Agents and local execution

D1, SQLite, and PostgreSQL can issue a dedicated agent token for a deployment. Agents claim commands every 30 seconds and write heartbeats no more than every 60 seconds. In KV mode they accept no commands and back off to five minutes. One mutating command may be active per deployment and expired leases can be reclaimed.

A server controller can bind one deployment to its local executor. The web process stays unprivileged; the executor claims fixed `apply/update/restart/repair/status/doctor/rollback/uninstall` actions over `/run/tsub/controller.sock`. Update, repair, restart, and rollback require controller confirmation; uninstall requires typing the deployment name. One-time Bootstrap still requires `Y/y` in the server terminal.

For ownership transfer, the target creates a one-time claim and the old controller queues `transfer-controller`. The node replaces its agent configuration only after successful target HTTPS registration. Failure keeps the old controller. If the old controller is lost, use a one-time Update command to rebind manually.

## Protocol and core matrix

| Protocol | Core | Transport | TLS |
| --- | --- | --- | --- |
| VLESS | Xray / sing-box | TCP, WebSocket, gRPC; XHTTP on Xray only | None, TLS, REALITY |
| VMess | Xray / sing-box | TCP, WebSocket, gRPC | None, TLS |
| Trojan | Xray / sing-box | TCP, WebSocket, gRPC | TLS only |
| Hysteria2 | Xray / sing-box | Native Hysteria2/QUIC | TLS only |
| TUIC v5 | sing-box | Native TUIC/QUIC | TLS only |
| AnyTLS | sing-box | Native AnyTLS/TCP | TLS only |
| Shadowsocks 2022 / SOCKS5 | Xray / sing-box | Native TCP+UDP | No TLS |
| NaiveProxy | Naive | Native HTTPS/H2/H3 | Trusted TLS |

Auto mode calculates the capability intersection across all inbounds. Shared transport and TLS values apply only to compatible protocols and never override a protocol-native transport. REALITY supports VLESS over TCP/RAW, gRPC, and XHTTP, but not WebSocket. XHTTP H3 requires TLS and opens UDP on the same port; REALITY with XHTTP uses H2/TCP. Self-signed TUIC links carry both the certificate SHA-256 (`pcs`) and SPKI SHA-256 (`spki`). `target=singbox` enforces the SPKI pin with `insecure` disabled, while v2rayN, Shadowrocket, and Loon retain CA-verification bypass flags for connectivity. The controller filters TUIC from legacy snapshots missing either pin and reports the condition in deployment records and the `X-TSub-TUIC-Pin-Status` / `X-TSub-TUIC-Pin-Filtered` response headers. A trusted ACME DNS-01 certificate remains preferred in production.

## Credentials and names

- Shared UUID is enabled by default and is generated once when empty.
- With shared UUID disabled, each UUID inbound receives a persisted unique UUID and the subscription token uses a separate UUID.
- Shared password can be disabled independently. Shadowsocks 2022 always receives a correctly sized independent key.
- Per-inbound values override deployment defaults, system defaults, and protocol built-ins in that order.
- Node names can be explicit or generated as deployment/protocol/port, prefix/protocol/port, or protocol/random suffix.
- Verified cores generate REALITY keys and self-signed certificates, which no-change Apply, Repair, and Update reuse.

## Low-memory operation

`tiny` is at most 96MB, `small` is 97–192MB, and `standard` is above 192MB. Tiny runs downloads, validation, and configuration tests serially and permits only one main core. Estimated RSS must remain below 80% of the cgroup limit. Xray and sing-box receive a Go memory limit on Tiny nodes, and the kernel is directed to reclaim the core or installer before SSH/Agent during OOM pressure. Runtime does not require Node, Python, jq, compilers, or unzip.

Nodes capped at exactly 64MB must use a pre-extracted `binary` core asset with a pinned SHA-256. Runtime rejects peak-sensitive `tar.gz` extraction before downloading. Visible host memory and Swap do not override this rule; `memory.max` and raw current cgroup usage are authoritative.

Runtime reports host Swap totals, free space, and usage, together with cgroup v2 `memory.swap.*` or cgroup v1 `memory.memsw.*` metrics when available. These values are diagnostic only and never increase available memory, the selected resource tier, or the installation admission budget.

The Runtime supports amd64/arm64 and selects persistence from systemd, OpenRC, runit/s6, rc.local, crontab, and nohup+pidfile. Missing persistence is reported as degraded. Validation levels are explicit:

| System/init | Validation level |
| --- | --- |
| Debian 13 + systemd | Full physical/VM host validation |
| Alpine + OpenRC | Full physical/VM host validation |
| Ubuntu 24.04, Debian Bookworm, Alpine 3.21 | CI/container validation |
| Rocky Linux 9 | CI/container validation, including dnf dependencies and the SELinux status notice |
| RHEL, AlmaLinux, Fedora | Shared Rocky detection and dependency mapping; no long-running host validation yet |
| runit, s6, rc.local, crontab, nohup | Static or simulated lifecycle coverage; no long-running host validation yet |

RHEL-family preflight output includes the SELinux state. If a service fails under Enforcing mode, inspect the host audit log for local policy denials.

## Subscription and active push

The server exposes a local subscription through BusyBox HTTP with a high-entropy UUID path but no TLS. Active push uses a separate 256-bit Bearer token, configuration generation, and monotonic sequence. After validation, the control plane atomically replaces its cache and serves an HTTPS mirror; it never fetches the server's high port.

Push failure does not stop the proxy. The control plane stores accepted count and five recent timestamps. Identical retries succeed idempotently without incrementing the count. Disabling periodic push keeps an installation snapshot.

## CDN, Argo Tunnel, and WARP

- Existing proxied hostnames require TLS on a Cloudflare HTTPS proxy port; Cloudflare does not map arbitrary origin ports.
- Quick Tunnel supports one WebSocket inbound for temporary testing. Runtime accepts only strict `*.trycloudflare.com` discovery results and recompiles nodes whenever the hostname changes.
- A TSub-managed named Tunnel creates a deployment-specific Tunnel, DNS CNAME, and loopback-only ingress. The edit token needs `Cloudflare Tunnel: Edit`, `Zone: Read`, and `DNS: Edit`, and is separate from the usage read token.
- WebSocket is supported. gRPC and XHTTP over CDN/Tunnel are experimental. Native TCP, REALITY, Hysteria2, TUIC, and XHTTP H3 are not presented as free Cloudflare CDN transports.
- Each inbound can publish direct only, direct plus CDN, or CDN-only nodes. Edge nodes always use the entry hostname for Host/SNI and never carry the origin self-signed pin or `allowInsecure`.
- Proxy uninstall keeps Cloudflare resources. Deleting a record requires explicit cleanup or an explicit choice to preserve those resources.
- Automatic WARP pins `wgcf v2.2.22` and its SHA-256. Account material and private keys remain in server-side `0600` files and are reused by update/repair/restart; cloned deployments register a new identity.

## Traffic

The automatic order is `nftables → iptables → sing-box core → Xray core → unavailable`. Firewall backends count proxy destination-port bytes as upload and source-port bytes as download across IPv4 and IPv6. Core APIs bind only to protected `127.0.0.1` ports. The fixed state file stays below 16KiB and checkpoints once per push interval.

## Operations

`plan`, `apply`, `status`, `list`, `update`, `restart`, `repair`, `doctor`, `rollback`, and `uninstall` use one-time operation commands. The installed `tsub` menu only displays nodes/subscriptions or triggers an immediate push.

## Core asset variables

Every component needs a pinned version plus pre-extracted amd64/arm64 URLs and SHA-256 values:

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

Assets default to a pre-extracted `binary`. When an official `tar.gz` is used, also set the matching `*_FORMAT=tar.gz` and `*_BINARY_SHA256`; the Runtime verifies the archive first and then the single extracted binary.

Optional components follow the same `TSUB_CLOUDFLARED_*`, `TSUB_WGCF_*`, `TSUB_LEGO_*`, and `TSUB_NAIVE_*` pattern. The latest channel uses separate `*_LATEST_*` variables; pinned versions use `TSUB_PINNED_CORE_MANIFEST`.

Deployment scripts modify services, firewall rules, and listening ports. Verify server backups, port conflicts, privileges, and certificate policy before running a generated command.

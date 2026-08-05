[简体中文](ARCHITECTURE.md)

# Architecture

```text
Browser
  ├─ Admin Cookie API ─> Standard Request/Response application core
  │                        ├─ Cloudflare adapter ─> KV / D1
  │                        └─ Node 22 adapter ────> SQLite / PostgreSQL
  ├─ Public Profile ───> Conversion and operators ─────> Client
  └─ Deployment control -> Manual Bootstrap / Remote Agent / Local Executor
                                └─ TSub Proxy ─────────> Xray / sing-box
```

## Boundaries

- The Vue frontend lives in `src/` and Vite emits production assets to `dist/`.
- Pages Functions in `functions/` implement authentication, storage, conversion, notifications, backups, and deployment protocols.
- `server/` provides the Node 22 HTTP, trusted-proxy, internal scheduler, database, and Unix-socket adapters.
- Runtime modules in `runtime/v2/modules/` build into `public/proxy/v2/tsub-proxy.sh`.
- The control plane and server communicate through short-lived Bootstrap and Callback tokens plus a rotatable deployment Push token.
- Core binaries are pinned, traceable, SHA-256-verified release assets and are not embedded in Pages.

## Data paths

The admin interface reads sources, manual nodes, Profiles, and a settings summary from `/api/data`. Public subscriptions read only real Profile relationships, then parse nodes, use protective caches, apply operators, and render the target format. Demo data lives under a separate key and is merged only into admin read scenarios.

Deployment creation resolves all random values once and stores an AES-GCM envelope. The server claims one-time Bootstrap and performs a transactional installation. Events update deployment summaries and audit history. Active push atomically replaces a stable source cache.

## Capabilities and storage

The frontend reads `/api/system/capabilities` and never infers features from a platform label. KV retains one-time commands, subscriptions, and active push. D1, SQLite, and PostgreSQL store deployments, operations, events, snapshots, commands, agents, and heartbeats as independent rows. SQLite enables WAL, foreign keys, and `busy_timeout` and permits one instance. PostgreSQL supports multiple instances and scheduler leases.

For same-host control, the unprivileged web controller talks over a `0660` Unix socket to a separate root executor. The executor accepts only fixed actions and validated V2 configuration, never arbitrary shell, paths, or environment. Remote servers poll outward; the controller stores no SSH credentials.

## Availability

Cloudflare can bind only KV for basic mode or only D1 for full mode; D1 no longer depends on KV. The server defaults to SQLite and can migrate to PostgreSQL. Protective caches prevent temporary upstream failures from emptying subscriptions. Missing init, TUN, or network permissions are reported as degraded.

Related: [Data Model](DATA_MODEL_EN.md) · [Security](SECURITY_EN.md) · [Operations](OPERATIONS_EN.md)

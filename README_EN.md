[简体中文](README.md)

<p align="center"><img src="public/logo.svg" width="96" height="96" alt="TSub Logo"></p>

# TSub

TSub is a subscription and proxy-node management platform for Cloudflare Pages or a self-hosted server. It includes Profiles, conversion, proxy deployment, remote agents, local execution, notifications, backups, and an external management API.

![TSub dashboard](docs/assets/screenshots/dashboard.png)

## Core capabilities

- Manage HTTP sources, manual nodes, and shareable Profiles.
- Produce Base64, Clash/Mihomo, sing-box, Surge, Loon, and Quantumult X output.
- Build subscriptions with operator chains, rule templates, filtering, sorting, deduplication, and renaming.
- Deploy Xray or sing-box to low-memory servers with TSub Proxy, without storing SSH credentials.
- Synchronize nodes and aggregate traffic through one-time Bootstrap tokens, encrypted deployment configuration, active push, and HTTPS mirrors.
- Use Cloudflare KV basic mode or D1 full mode; self-host with single-instance SQLite WAL or multi-instance PostgreSQL.
- Use the Chinese/English responsive interface and fully isolated read-only demo data.

## Interface preview

| Subscription management | Node management |
| --- | --- |
| ![Subscription management](docs/assets/screenshots/subscription-management.png) | ![Node management](docs/assets/screenshots/node-management.png) |

| My subscriptions | Proxy deployments |
| --- | --- |
| ![My subscriptions](docs/assets/screenshots/my-subscriptions.png) | ![Proxy deployments](docs/assets/screenshots/proxy-deployments.png) |

## Cloudflare quick deployment

1. Connect the repository to Cloudflare Pages.
2. Use `npm run build` and publish the `dist` directory.
3. Choose storage: bind only KV as `TSUB_KV` for basic mode, or only D1 as `TSUB_DB` for full mode. A D1-only installation creates its schema on the first request and needs neither KV nor a manual SQL step.
4. Set `ADMIN_PASSWORD`, `COOKIE_SECRET`, and `DEPLOYMENT_SECRET_KEY`; a separate `SETTINGS_SECRET_KEY` is recommended. `ADMIN_USERNAME` is optional.
5. Sign in after deployment and finish storage, notification, backup, and public-page configuration.

Do not switch an existing KV installation by changing bindings alone. Bind both `TSUB_KV` and `TSUB_DB`, redeploy, then run the verified KV-to-D1 migration under Settings → System. [schema.sql](schema.sql) remains available for optional pre-initialization and auditing.

See [Quick Start](docs/QUICK_START_EN.md) for the complete procedure.

The server controller supports Docker Compose and bare-metal Debian, Ubuntu, or Alpine. Its web process is unprivileged and delegates host changes to a separate root executor. See [Server Controller Deployment](docs/SERVER_DEPLOYMENT_EN.md) and [Architecture](docs/ARCHITECTURE_EN.md).

## Local development

```bash
npm ci
npm run dev
npm run test:run
npm run build
```

For local Pages Functions:

```bash
npm run dev:server -- --ip 127.0.0.1 --kv TSUB_KV --persist-to .wrangler/state-local
```

## Documentation

- [Quick Start](docs/QUICK_START_EN.md)
- [User Guide](docs/USER_GUIDE_EN.md)
- [Proxy Deployment](docs/PROXY_DEPLOYMENT_EN.md)
- [Server Controller Deployment](docs/SERVER_DEPLOYMENT_EN.md)
- [Architecture](docs/ARCHITECTURE_EN.md)
- [API Reference](docs/API_REFERENCE_EN.md)
- [Data Model](docs/DATA_MODEL_EN.md)
- [Security Model](docs/SECURITY_EN.md)
- [Operations](docs/OPERATIONS_EN.md)
- [Development](docs/DEVELOPMENT_EN.md)

License: [MIT](LICENSE) · Reference: [MiSub](https://github.com/imzyb/MiSub)

[简体中文](QUICK_START.md)

# Quick Start

## Prerequisites

- A Cloudflare account, a Pages project, and either a KV namespace or a D1 database.
- Node.js 22 LTS or later for local builds and the server controller.
- An administrator password of at least eight characters, a stable Cookie secret, and a separate deployment encryption key.
- In KV mode the control plane never connects to servers. In D1 and server full modes, server agents actively poll for commands.

## Cloudflare Pages common steps

1. Fork or import the repository and create a Pages project.
2. Set the build command to `npm run build` and the output directory to `dist`.
3. Bind storage using one of the three procedures below.
4. Configure these variables or secrets:

| Name | Required | Purpose |
| --- | --- | --- |
| `ADMIN_USERNAME` | No | Administrator username; defaults to `admin` |
| `ADMIN_PASSWORD` | Yes | Initial administrator password |
| `COOKIE_SECRET` | Yes | Login Cookie signing |
| `DEPLOYMENT_SECRET_KEY` | For deployments | AES-GCM deployment configuration key |
| `SETTINGS_SECRET_KEY` | Recommended | Separate AES-GCM key for WebDAV, Telegram, Cron, and External API secrets; falls back to `DEPLOYMENT_SECRET_KEY` |
| `TSUB_PUBLIC_URL` | Recommended | Public HTTPS control-plane URL |

See [Proxy Deployment](PROXY_DEPLOYMENT_EN.md) for core version, URL, and SHA-256 variables.

### KV basic installation

1. Create a KV namespace and bind it to the Pages project as `TSUB_KV`.
2. Do not bind `TSUB_DB` or set `TSUB_INITIAL_STORAGE`.
3. Deploy into KV basic mode. One-time commands, active push, and subscriptions are available; remote agents, commands, and live heartbeats are not.

### D1 full installation

1. Create an empty D1 database and bind it to the Pages project as `TSUB_DB`.
2. Neither `TSUB_KV` nor `TSUB_INITIAL_STORAGE` is required.
3. On the first request TSub idempotently creates missing tables and indexes, inserts the single `storage_control` record, and starts in D1 full mode.

[schema.sql](../schema.sql) remains available for pre-deployment auditing or optional manual initialization, but it is not required. If initialization fails, TSub returns `503 storage_initialization_failed` with a `requestId` and never falls back to empty storage.

### Migrate an existing KV installation to D1

1. Keep the existing `TSUB_KV`, create D1, bind it as `TSUB_DB`, and redeploy.
2. Export a backup, sign in, and confirm under Settings → System that KV remains active.
3. Start the D1 migration. TSub locks writes, copies business and system records, verifies counts and the SHA-256 digest, and switches atomically only after verification.
4. Verify sign-in, subscriptions, deployments, and Cron. Keep KV as a rollback target if desired. The switch-back action is disabled when `TSUB_KV` is not bound.

A new project with both empty bindings defaults to KV. Set `TSUB_INITIAL_STORAGE=d1` to choose D1. This variable is used only for the initial dual-binding decision; conflicting data requires an explicit `kv` or `d1`, while an existing `storage_control` always remains authoritative. Never migrate existing data by editing ordinary settings or environment variables alone.

## First sign-in

Open `/login` after deployment, or use the configured custom login path. Usernames are case-insensitive. Recommended first steps:

1. Verify storage under Settings → System.
2. Change administrator credentials and sign in again.
3. Configure WebDAV backup and notifications.
4. Add sources, nodes, and Profiles.
5. Generate isolated demo data only when documentation examples are needed.

## Server controller

The server controller supports Docker Compose and bare-metal deployment. Docker includes Caddy but does not install the host executor by default. The bare-metal installer registers the unprivileged controller and root executor, while the reverse proxy remains an explicit step. See [Server Controller Deployment](SERVER_DEPLOYMENT_EN.md) for DNS, firewall, HTTPS, database, executor, backup, upgrade, rollback, and uninstall procedures.

## Create a subscription

Add an upstream URL under Subscription Management and refresh its node metadata. Add individual share links under Node Management. Then create a Profile under My Subscriptions, select its sources, and copy an output link for the target client.

## Create a proxy deployment

Enter a deployment name, choose protocols, and leave ports empty for secure random assignment. Confirm the host-level risks, generate the one-time deployment command, and run it in the target server shell. The terminal prints nodes, the local server subscription, and the control-plane mirror. The default control command is `tsub`.

## Local verification

```bash
npm ci
npm run test:run
npm run runtime:check
npm run docs:check
npm run build
```

More: [User Guide](USER_GUIDE_EN.md) · [Operations](OPERATIONS_EN.md) · [Security](SECURITY_EN.md)

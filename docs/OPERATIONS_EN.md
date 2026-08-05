[简体中文](OPERATIONS.md)

# Operations

## Daily checks

- Confirm enabled source, node, Profile, and traffic counts on the dashboard.
- Check whether active push is older than three intervals and whether traffic collection is degraded.
- Review deployment state, last success, resource tier, RSS, and degraded reasons.
- Inspect recent Cron, Telegram, and WebDAV status.
- Monitor KV/D1 quotas and Pages Functions errors, or server database, scheduler lease, and disk health.

## Backup and restore

TSub supports local export and scheduled WebDAV backups. Backups include real sources, Profiles, rule templates, encrypted deployments, and operation audits. They exclude demo data, plaintext deployment secrets, WebDAV passwords, and session keys. Restore creates a pre-restore snapshot. Regenerate demo data from System Settings afterward.

## Cron

External Cron can request `/cron` or the authenticated management trigger for strict source refresh, notification, and WebDAV schedules. Normal admin traffic only performs lazy due checks. Screenshot demo requests never trigger scheduled work.

The server controller runs an internal scheduler. SQLite permits one controller process; PostgreSQL uses `scheduler_leases` so only one instance executes a given cycle.

## Storage migration

Cloudflare switches between KV and D1; the server switches between SQLite and PostgreSQL. System Settings runs preflight, write lock, drain, copy, count/SHA-256 verification, atomic switch, and unlock. Reads continue from the source while writes return `503` with `Retry-After`. Do not edit `storageType` through ordinary settings.

A D1-only project binds only `TSUB_DB`; the first request creates missing schema objects and `storage_control`. A KV-only project binds only `TSUB_KV`. A new dual-binding project defaults to KV and may use `TSUB_INITIAL_STORAGE` for its first selection. An existing control record is always authoritative. Conflicting data without an explicit selection returns a redacted 503 instead of guessing, overwriting, or merging.

Before switching to KV, claimed or running remote commands must finish and unclaimed commands are canceled. Server selection is persisted in `/var/lib/tsub-controller/storage-control.json` with mode `0600`. A failed migration can resume through the same migration ID; a digest mismatch never switches storage.

Cloudflare/server transfers use a password-protected package with PBKDF2-SHA256 at 600,000 iterations and AES-256-GCM. Import re-encrypts deployment secrets under the target key and marks agents for reconnection. Normal backups exclude command leases, heartbeats, and agent credentials.

## Upgrade

1. Export a backup and record the current Pages deployment.
2. Run unit tests, Runtime checks, documentation checks, and the production build on a branch.
3. Review `schema.sql` and environment-variable changes.
4. Validate login, subscription output, and deployment commands in a preview environment.
5. Deploy production and monitor errors.

A core upgrade must update version, URL, and SHA-256. No-change Apply downloads nothing and does not rewrite or restart. A failed core-upgrade health check restores the previous binary and configuration.

## Rollback

Cloudflare Pages can roll back to a previous successful deployment. Restore the pre-deployment backup for incompatible database changes. Use the server `rollback` operation and keep snapshots and old binaries until stability is confirmed.

## Troubleshooting

Cloudflare controllers can enable D1/KV quota monitoring under Settings → System Settings → Data Storage. Create a custom token restricted to the current account with only `Account Analytics: Read`, `D1: Read`, and `Workers KV Storage: Read`; never use a Global API Key. After checking permissions, select the D1 database and KV namespace used by TSub. Remaining quota uses account totals while the card also shows the selected TSub resources and seven-day UTC trends.

- **401 sign-in**: verify lowercase username normalization, no password edge whitespace, stable `COOKIE_SECRET`, and whether a credential change invalidated the session.
- **Storage unavailable**: verify the `TSUB_KV` or `TSUB_DB` binding for the active Cloudflare mode; use the initialization `requestId` to inspect Functions logs. On a server, verify SQLite permissions and `TSUB_POSTGRES_URL`. Switch only through a verified migration.
- **Local executor offline**: inspect `/run/tsub/controller.sock`, `/run/tsub/executor.conf`, the `tsub-executor` service, and the pinned Runtime digest.
- **Stale active push**: trigger an immediate push from the `tsub` menu and inspect persistence, DNS, clock, and Push generation.
- **Traffic unavailable**: inspect nftables/iptables permissions; without `CAP_NET_ADMIN`, verify the loopback core API.
- **64MB install failure**: inspect actual cgroup, disk peak, PID, and single-core limits. Do not bypass planning with Swap.
- **Empty subscription**: inspect source state, protective cache, rejected-line statistics, and Profile references.

## Production demo screenshots

```bash
TSUB_SCREENSHOT_URL=https://example.pages.dev \
TSUB_ADMIN_USERNAME=admin \
TSUB_ADMIN_PASSWORD='...' \
npm run docs:screenshots
```

The script refreshes isolated demos, selects Chinese and light theme, and writes `docs/assets/screenshots/`. Inject credentials through CI secrets rather than repository files or logs.

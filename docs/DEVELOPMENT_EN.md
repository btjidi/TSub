[简体中文](DEVELOPMENT.md)

# Development

## Layout

| Path | Purpose |
| --- | --- |
| `src/` | Vue 3, Pinia, routing, components, and i18n |
| `functions/` | Cloudflare Pages Functions and services |
| `server/` | Node 22 adapter, databases, scheduler, local executor, and install assets |
| `runtime/v2/modules/` | POSIX Shell Runtime source modules |
| `public/proxy/v2/` | Runtime build output and manifest |
| `tests/unit/` | Vitest unit and Miniflare D1 tests |
| `tests/e2e/` | Playwright browser tests |
| `scripts/` | Runtime, documentation, and screenshot tools |

## Commands

```bash
npm ci
npm run dev
npm run test:run
npm run test:e2e
npm run runtime:build
npm run runtime:check
npm run docs:check
npm run build
npm run pages:verify
npm run deploy:pages
```

After changing Runtime source, run `runtime:build` and commit the generated script, manifest, and SHA-256 together. Do not edit the generated script manually.

## Conventions

- Every user-facing frontend string needs both `zh-CN` and `en-US`.
- Business values use stable English IDs rather than display labels.
- Structured data uses parsers and Web APIs instead of fragile string manipulation.
- Shared secret controls mask sensitive fields; logs and errors contain summaries only.
- New storage keys use the `tsub_` namespace. D1 changes update [schema.sql](../schema.sql).
- Demo data may be merged only through its independent admin read path and never into real business writes.

## Testing strategy

Repository contracts must run against KV, D1, SQLite, and PostgreSQL. Miniflare verifies D1 conditional writes; real SQLite verifies WAL and locking; PostgreSQL CI verifies transactions, multi-instance leases, and SQL compatibility. Authentication covers unauthenticated requests, session invalidation, and limits. Deployment covers matrices, tokens, replay prevention, command leases, agent heartbeats, Unix sockets, and Runtime snapshots. Frontend tests cover both locales, desktop/390px layout, and capability gating.

## Documentation rules

Formal documents exist in language pairs and link to each other at the top. `npm run docs:check` checks pairing, links, old documents, and source references. `npm run docs:screenshots` generates screenshots without real data.

## Release checklist

1. `git diff --check`
2. `npm run test:run`
3. Runtime Shell tests and `npm run runtime:check`
4. `npm run docs:check`
5. `npm run build`
6. Run Node HTTP smoke, `docker compose config`, Docker build, and PostgreSQL tests
7. Run ShellCheck, dash/BusyBox ash, executor permission, and secret scans
8. Publish Pages through `npm run deploy:pages`; it verifies the production Account ID, project subdomain, KV ID, and D1 ID first. Do not invoke bare `wrangler pages deploy`
9. Generate demo data and screenshots, then inspect desktop/mobile output
10. Commit and push `origin/main`

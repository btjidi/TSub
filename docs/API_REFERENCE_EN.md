[简体中文](API_REFERENCE.md)

# API Reference

## Authentication

Admin endpoints use an HttpOnly SameSite Cookie. Sign in with `POST /api/login`:

```json
{ "username": "admin", "password": "your-password" }
```

Usernames are trimmed and lowercased. A credential update increments the authentication version and invalidates every old session.

## Admin endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/data` | Read sources, nodes, Profiles, and configuration summary |
| POST | `/api/tsubs` | Save real sources and Profiles |
| GET/POST | `/api/settings` | Read or save settings |
| GET/PUT | `/api/settings/credentials` | Read metadata or update credentials |
| POST | `/api/settings/credentials/reset` | Restore environment credentials |
| GET/POST/DELETE | `/api/demo-data` | Inspect, seed/refresh, or clear isolated demos |
| GET/POST | `/api/deployments` | List or create deployments |
| GET/PATCH/DELETE | `/api/deployments/:id` | Read, update, or delete a deployment |
| GET/POST | `/api/deployments/:id/operations` | Read history or create an operation command |
| POST | `/api/deployments/:id/commands` | Queue a fixed action for an agent |
| POST | `/api/deployments/:id/local-executor` | Bind the server controller's local executor |
| POST | `/api/deployments/:id/transfer-claim` | Create a one-time claim on the target controller |
| POST | `/api/deployments/:id/controller-transfer` | Queue ownership transfer from the old controller |
| DELETE/POST | `/api/deployments/:id/source` | Disable or restore a deployment source |
| GET/PUT/DELETE | `/api/deployment-defaults` | Manage encrypted deployment defaults |
| GET/POST | `/api/rule_templates` | Manage rule templates |
| GET | `/api/logs` | Read access logs |
| GET/POST | `/api/backup/*` | Export, restore, and WebDAV operations |
| GET | `/api/system/capabilities` | Read platform, storage, and control capabilities |
| GET | `/api/storage/status` | Read active storage and configured bindings |
| POST | `/api/storage/migrations` | Start a resumable storage migration |
| GET/POST | `/api/storage/migrations/:id[/advance]` | Inspect or advance migration state |
| POST | `/api/backup/portable/export` | Create a password-encrypted controller package |
| POST | `/api/backup/portable/import` | Import and re-encrypt with target keys |

`X-TSub-Demo-View: 1` is reserved for authenticated documentation screenshots. It makes `/api/data` and `/api/deployments` demo-only and redacts settings and credential metadata.

## Machine endpoints

| Method | Path | Authentication |
| --- | --- | --- |
| GET | `/api/deploy/bootstrap` | One-time Bootstrap Bearer |
| POST | `/api/deploy/events` | Callback Bearer |
| POST | `/api/deploy/push/:deploymentId` | Deployment Push Bearer |
| GET | `/api/deploy/subscriptions/:deploymentId/:token` | Subscription UUID |
| POST | `/api/deploy/agent/poll` | Agent Bearer |
| GET | `/api/deploy/agent/commands/:id/config` | Agent Bearer and command lease |
| POST | `/api/deploy/agent/commands/:id/events` | Agent Bearer and command lease |
| POST | `/api/deploy/agent/transfer/claim` | One-time transfer Bearer |

Push bodies use streamable `key=value` text, limited to 256KiB and 1000 nodes. The server validates configuration generation, monotonic sequence, protocol, and content hash. Identical retries are idempotent.

## External Management API

After it is enabled in System Settings, trusted automation can use `Authorization: Bearer <token>` with subscription, node, and Profile routes under `/api/ext/v1`. This token is not a browser login credential. Demo records are excluded.

```bash
curl -H "Authorization: Bearer $TSUB_EXTERNAL_TOKEN" \
  https://example.pages.dev/api/ext/v1/subscriptions
```

## Errors

Responses generally use `{ "success": false, "error": "..." }` or `message`. Common statuses are `400` validation, `401` unauthenticated, `403` invalid token, `404` missing record, `409` state conflict/read-only record, `413` oversized payload, and `503` unavailable storage or runtime assets.

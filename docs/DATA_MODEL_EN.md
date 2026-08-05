[简体中文](DATA_MODEL.md)

# Data Model

## Business collections

- `tsub_subscriptions_v1`: sources and manual nodes. HTTP(S) URLs are sources; share-protocol URLs are nodes.
- `tsub_profiles_v1`: Profiles, source IDs, manual node IDs, conversion, and operator configuration.
- `worker_settings_v1`: UI, public page, notifications, conversion, WebDAV, and External API settings.
- `tsub_rule_templates_v1`: custom rule templates.
- `tsub_deployments_v2`: public deployment summaries, status, and AES-GCM configuration envelopes.
- `tsub_deployment_operations_v2`: operations, events, resources, and audit results.
- `tsub_deployment_defaults_v2`: AES-GCM-encrypted generator defaults.
- `tsub_demo_data_v1`: isolated read-only demo data.

D1 stores subscriptions and Profiles as rows and generic keyed objects in `settings`. KV uses the same logical keys. SQLite and PostgreSQL share the SQL schema. A Cloudflare D1 direct installation initializes the schema automatically; [schema.sql](../schema.sql) remains available for manual pre-initialization and auditing.

Full mode also has `deployments`, `deployment_operations`, `deployment_events`, `deployment_snapshots`, `deployment_commands`, `deployment_agents`, `deployment_heartbeats`, `controller_transfers`, `storage_control`, `storage_migrations`, `schema_migrations`, and `scheduler_leases`. Events append independently and APIs aggregate the latest 50. Snapshot updates are conditional on deployment, generation, sequence, and digest.

## Sources

Core fields include `id`, `name`, `url`, `enabled`, `nodeCount`, and optional `userInfo`. Deployment sources add `source.kind`, `deploymentId`, `serverAddress`, `lastPushAt`, `pushCount`, `pushHistory`, `pushIntervalMinutes`, and `trafficBackend`.

## Profiles

A Profile has stable `id/customId` values and references `subscriptions[]` and `manualNodes[]` without copying node content. Public output reads enabled real Profiles only. Download counts use separate counter keys.

## Deployments

Public summaries contain no passwords, private keys, or tokens. Random ports, UUIDs, certificate policy, push credentials, and complete Runtime configuration are resolved at creation and stored in `encryptedConfig`. Operation states are `pending`, `running`, `succeeded`, `failed`, and `expired`; deployments also support `offline`.

Commands use 120-second leases and expire after 30 minutes by default. Unchanged heartbeats are persisted at most once per 60 seconds; Runtime, core, configuration revision, or polling interval changes persist immediately. The offline window is at least 150 seconds and expands to three polling intervals.

Commands have 120-second leases and expire after 30 minutes by default. Heartbeats write at most every 60 seconds and are offline after 150 seconds. Deployment deletion cascades through events, snapshots, commands, agents, heartbeats, and transfer claims.

## Demo isolation

Demo records exist only in `tsub_demo_data_v1`, use names prefixed with “演示 ·”, and carry `demo: true`. Normal saves drop submitted demo records and `demo-*` removal diffs. Public subscriptions, Cron, notifications, backups, the External API, and machine callbacks never read this key. Refreshing or deleting it cannot change business collections.

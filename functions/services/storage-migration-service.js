import { DataMigrator, SettingsCache, StorageFactory, STORAGE_TYPES, ensureD1Schema } from '../storage-adapter.js';
import { createDeploymentRepository } from './deployment-repository.js';

const CONTROL_ID = 'main';
const VALID_TARGETS = new Set(Object.values(STORAGE_TYPES));

function randomId() { return `migration_${crypto.randomUUID().replace(/-/g, '')}`; }
function parse(value, fallback = {}) { try { return JSON.parse(value); } catch { return fallback; } }

export async function readStorageControl(env) {
  const db = env?.TSUB_DB || env?.TSUB_SQL_DB;
  if (!db) return null;
  try {
    const row = await db.prepare('SELECT active_storage, state, epoch, data, updated_at FROM storage_control WHERE id = ?').bind(CONTROL_ID).first();
    return row ? { activeStorage: row.active_storage, state: row.state, epoch: Number(row.epoch || 1), data: parse(row.data), updatedAt: row.updated_at } : null;
  } catch { return null; }
}

export async function isStorageWriteLocked(env) {
  const control = await readStorageControl(env);
  return control?.state === 'migrating' ? control : null;
}

async function writeControl(db, control) {
  await db.prepare(`INSERT INTO storage_control (id, active_storage, state, epoch, data, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET active_storage = excluded.active_storage, state = excluded.state,
    epoch = excluded.epoch, data = excluded.data, updated_at = CURRENT_TIMESTAMP`)
    .bind(CONTROL_ID, control.activeStorage, control.state, control.epoch, JSON.stringify(control.data || {})).run();
}

async function readMigration(db, id) {
  const row = await db.prepare('SELECT * FROM storage_migrations WHERE id = ?').bind(id).first();
  return row ? { id: row.id, source: row.source, target: row.target, phase: row.phase, data: parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

async function writeMigration(db, migration) {
  await db.prepare(`INSERT INTO storage_migrations (id, source, target, phase, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, data = excluded.data, updated_at = CURRENT_TIMESTAMP`)
    .bind(migration.id, migration.source, migration.target, migration.phase, JSON.stringify(migration.data || {}), migration.createdAt || null).run();
}

export async function getStorageStatus(env) {
  const activeStorage = await StorageFactory.getStorageType(env);
  const control = await readStorageControl(env);
  let migration = null;
  let migrationStatus = 'idle';
  if (control?.state === 'migrating') {
    migration = control.data?.migrationId
      ? await readMigration(env.TSUB_DB || env.TSUB_SQL_DB, control.data.migrationId)
      : null;
    migrationStatus = migration ? 'running' : 'missing';
  }
  return {
    platform: env.TSUB_PLATFORM === 'server' ? 'server' : 'cloudflare',
    activeStorage,
    control: control || { activeStorage, state: 'idle', epoch: 1 },
    migration,
    migrationStatus,
    bindings: {
      kv: Boolean(StorageFactory.resolveKV(env)), d1: Boolean(env.TSUB_DB),
      sqlite: Boolean(env.TSUB_PLATFORM === 'server' && env.TSUB_SERVER_DATABASES?.sqlite),
      postgres: Boolean(env.TSUB_PLATFORM === 'server' && env.TSUB_SERVER_DATABASES?.postgres)
    }
  };
}

export async function startStorageMigration(env, target) {
  if (!VALID_TARGETS.has(target)) throw Object.assign(new Error('Unsupported storage target'), { status: 400 });
  const db = env.TSUB_DB || env.TSUB_SQL_DB;
  if (!db) throw Object.assign(new Error('Transactional database binding is required'), { status: 400 });
  await ensureD1Schema(db);
  const source = await StorageFactory.getStorageType(env);
  if (source === target) throw Object.assign(new Error('Target storage is already active'), { status: 409 });
  if (['kv', 'd1'].includes(target) && env.TSUB_PLATFORM === 'server') throw Object.assign(new Error('Cloud storage is unavailable on server platform'), { status: 400 });
  if (target === 'kv' && !StorageFactory.resolveKV(env)) throw Object.assign(new Error('KV binding is missing'), { status: 400 });
  if (target === 'd1' && !env.TSUB_DB) throw Object.assign(new Error('D1 binding is missing'), { status: 400 });
  if (env.TSUB_PLATFORM === 'server' && !env.TSUB_SERVER_DATABASES?.[target]) {
    throw Object.assign(new Error(`Server storage ${target} is not configured`), { status: 400 });
  }
  const currentControl = await readStorageControl(env);
  if (currentControl?.state === 'migrating') {
    const activeMigration = currentControl.data?.migrationId
      ? await readMigration(db, currentControl.data.migrationId)
      : null;
    const resumablePhases = new Set(['preflight', 'drain', 'copy', 'verify', 'switch']);
    if (activeMigration?.target === target && resumablePhases.has(activeMigration.phase)) {
      // A browser refresh or interrupted poll can leave the migration lock in
      // place. Returning the active record lets the caller resume its advance
      // loop without copying data a second time or discarding the lock.
      return activeMigration;
    }
    throw Object.assign(new Error('Another storage migration is running'), { status: 409 });
  }
  const id = randomId();
  const now = new Date().toISOString();
  const migration = { id, source, target, phase: 'preflight', createdAt: now, data: { counts: null, digest: null } };
  await writeMigration(db, migration);
  await writeControl(db, { activeStorage: source, state: 'migrating', epoch: currentControl?.epoch || 1, data: { migrationId: id } });
  SettingsCache.clear();
  return migration;
}

export async function getStorageMigration(env, id) {
  const db = env.TSUB_DB || env.TSUB_SQL_DB;
  if (!db) return null;
  return readMigration(db, id);
}

export async function advanceStorageMigration(env, id) {
  const db = env.TSUB_DB || env.TSUB_SQL_DB;
  if (!db) throw Object.assign(new Error('Transactional database binding is required'), { status: 400 });
  const migration = await readMigration(db, id);
  if (!migration) throw Object.assign(new Error('Migration not found'), { status: 404 });
  const control = await readStorageControl(env);
  if (control?.data?.migrationId !== id && migration.phase !== 'complete') throw Object.assign(new Error('Migration lock is no longer owned'), { status: 409 });
  const drainMs = Number(env.TSUB_MIGRATION_DRAIN_MS ?? (migration.source === 'kv' || migration.target === 'kv' ? 60_000 : 1_000));

  if (migration.phase === 'preflight') {
    migration.phase = 'drain';
    migration.data.notBefore = new Date(Date.now() + Math.max(0, drainMs)).toISOString();
  } else if (migration.phase === 'drain') {
    if (Date.parse(migration.data.notBefore) > Date.now()) return migration;
    migration.phase = 'copy';
  } else if (migration.phase === 'copy') {
    if (migration.target === 'kv') {
      const active = await countActiveCommands(db);
      if (active > 0) throw Object.assign(new Error('Running remote commands must finish before switching to KV'), { status: 409 });
      await cancelPendingCommandsForKv(db);
    }
    const result = migration.source === 'kv' && migration.target === 'd1'
      ? await DataMigrator.copyKVToD1(env, { switchStorage: false })
      : migration.source === 'd1' && migration.target === 'kv'
        ? await DataMigrator.copyD1ToKV(env, { switchStorage: false })
        : await copyServerDatabase(env, migration.source, migration.target);
    migration.data.counts = result.counts;
    migration.data.digest = result.digest;
    migration.phase = 'verify';
  } else if (migration.phase === 'verify') {
    const verification = migration.target === 'd1'
      ? await DataMigrator.describeD1(env)
      : migration.target === 'kv'
        ? await DataMigrator.describeKV(env)
        : await describeServerDatabase(env.TSUB_SERVER_DATABASES?.[migration.target]);
    if (migration.data.digest && verification.digest !== migration.data.digest) throw Object.assign(new Error('Migration digest mismatch'), { status: 409 });
    migration.data.verifiedAt = new Date().toISOString();
    migration.phase = 'switch';
  } else if (migration.phase === 'switch') {
    const nextControl = { activeStorage: migration.target, state: 'idle', epoch: Number(control?.epoch || 1) + 1, data: { lastMigrationId: id } };
    let stateDb = db;
    if (env.TSUB_PLATFORM === 'server') {
      const targetDb = env.TSUB_SERVER_DATABASES?.[migration.target];
      await writeMigration(targetDb, migration);
      await writeControl(targetDb, nextControl);
      await writeControl(db, { activeStorage: migration.source, state: 'idle', epoch: Number(control?.epoch || 1), data: { switchedTo: migration.target, lastMigrationId: id } });
      await env.TSUB_SWITCH_SERVER_STORAGE(migration.target);
      stateDb = targetDb;
    } else {
      await writeControl(db, nextControl);
    }
    migration.phase = 'complete';
    migration.data.completedAt = new Date().toISOString();
    SettingsCache.clear();
    await writeMigration(stateDb, migration);
    return migration;
  }
  await writeMigration(db, migration);
  return migration;
}

const SERVER_TABLES = [
  ['settings', 'key', ['key', 'value', 'created_at', 'updated_at']],
  ['subscriptions', 'id', ['id', 'data', 'created_at', 'updated_at']],
  ['profiles', 'id', ['id', 'data', 'created_at', 'updated_at']],
  ['deployments', 'id', ['id', 'status', 'config_revision', 'data', 'created_at', 'updated_at']],
  ['deployment_operations', 'id', ['id', 'deployment_id', 'action', 'status', 'data', 'created_at', 'updated_at', 'expires_at']],
  ['deployment_events', 'id', ['id', 'operation_id', 'data', 'created_at']],
  ['deployment_snapshots', 'deployment_id', ['deployment_id', 'push_generation', 'sequence', 'snapshot_hash', 'data', 'updated_at']],
  ['deployment_commands', 'id', ['id', 'deployment_id', 'operation_id', 'action', 'status', 'lease_id', 'lease_expires_at', 'expires_at', 'data', 'created_at', 'updated_at']],
  ['deployment_agents', 'deployment_id', ['deployment_id', 'token_hash', 'generation', 'revoked_at', 'created_at', 'updated_at']],
  ['deployment_heartbeats', 'deployment_id', ['deployment_id', 'data', 'last_seen_at']],
  ['controller_transfers', 'id', ['id', 'deployment_id', 'token_hash', 'status', 'expires_at', 'data', 'created_at', 'updated_at']],
  ['schema_migrations', 'version', ['version', 'applied_at']]
];

function resultRows(result) { return result?.results || result?.rows || []; }
function normalizeSqlValue(value, column = '') {
  if (value instanceof Date) return value.toISOString();
  if (value && /(?:^|_)at$/.test(column)) {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value))
      ? `${String(value).replace(' ', 'T')}Z`
      : String(value);
    const timestamp = Date.parse(normalized);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value;
}

async function databaseSnapshot(db) {
  if (!db) throw Object.assign(new Error('Server database is unavailable'), { status: 400 });
  const data = {};
  for (const [table, primaryKey, columns] of SERVER_TABLES) {
    const rows = resultRows(await db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${primaryKey}`).all());
    data[table] = rows.map(row => Object.fromEntries(columns.map(column => [column, normalizeSqlValue(row[column], column)])));
  }
  return data;
}

async function describeServerDatabase(db) {
  const data = await databaseSnapshot(db);
  return {
    counts: Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length])),
    digest: await DataMigrator._digest(data)
  };
}

async function copyServerDatabase(env, source, target) {
  const sourceDb = env.TSUB_SERVER_DATABASES?.[source];
  const targetDb = env.TSUB_SERVER_DATABASES?.[target];
  if (!sourceDb || !targetDb) throw Object.assign(new Error('Both server databases must be configured'), { status: 400 });
  await ensureD1Schema(targetDb);
  const snapshot = await databaseSnapshot(sourceDb);
  for (const [table] of [...SERVER_TABLES].reverse()) await targetDb.prepare(`DELETE FROM ${table}`).run();
  for (const [table, primaryKey, columns] of SERVER_TABLES) {
    const updates = columns.filter(column => column !== primaryKey).map(column => `${column} = excluded.${column}`).join(', ');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(${primaryKey}) DO UPDATE SET ${updates}`;
    for (const row of snapshot[table]) {
      await targetDb.prepare(sql).bind(...columns.map(column => row[column] ?? null)).run();
    }
  }
  return describeServerDatabase(sourceDb);
}

export async function cancelPendingCommandsForKv(db) {
  await db.prepare(`UPDATE deployment_commands SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'`).run();
}

export async function countActiveCommands(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM deployment_commands WHERE status IN ('claimed','running')`).first();
  return Number(row?.count || 0);
}

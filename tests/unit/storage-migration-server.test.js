// @vitest-environment node

import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureD1Schema, SettingsCache } from '../../functions/storage-adapter.js';
import { advanceStorageMigration, getStorageMigration, getStorageStatus, startStorageMigration } from '../../functions/services/storage-migration-service.js';

describe('server storage migration', () => {
  let miniflare; let sqlite; let postgres; let env;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['SQLITE', 'POSTGRES']
    });
    sqlite = await miniflare.getD1Database('SQLITE');
    postgres = await miniflare.getD1Database('POSTGRES');
    await ensureD1Schema(sqlite);
    await ensureD1Schema(postgres);
    await sqlite.prepare(`INSERT INTO storage_control (id, active_storage, state, epoch, data)
      VALUES ('main', 'sqlite', 'idle', 1, '{}')`).run();
    await sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('worker_settings_v1', JSON.stringify({ language: 'zh-CN' })).run();
    await sqlite.prepare('INSERT INTO subscriptions (id, data) VALUES (?, ?)').bind('sub-1', JSON.stringify({ id: 'sub-1', name: 'Source' })).run();
    await sqlite.prepare('INSERT INTO deployments (id, status, config_revision, data) VALUES (?, ?, ?, ?)')
      .bind('deploy-1', 'succeeded', 2, JSON.stringify({ id: 'deploy-1', status: 'succeeded', configRevision: 2 })).run();
    env = {
      TSUB_PLATFORM: 'server', TSUB_STORAGE_TYPE: 'sqlite', TSUB_SQL_DB: sqlite,
      TSUB_SERVER_DATABASES: { sqlite, postgres }, TSUB_MIGRATION_DRAIN_MS: 0,
      TSUB_SWITCH_SERVER_STORAGE: async target => {
        env.TSUB_STORAGE_TYPE = target;
        env.TSUB_SQL_DB = env.TSUB_SERVER_DATABASES[target];
      }
    };
  });

  afterEach(async () => { SettingsCache.clear(); await miniflare.dispose(); });

  async function finish(id) {
    let migration;
    for (let index = 0; index < 8; index += 1) {
      migration = await advanceStorageMigration(env, id);
      if (migration.phase === 'complete') return migration;
    }
    throw new Error(`migration did not complete: ${migration?.phase}`);
  }

  it('copies independent records and atomically switches SQLite to PostgreSQL', async () => {
    const started = await startStorageMigration(env, 'postgres');
    const completed = await finish(started.id);
    expect(completed.phase).toBe('complete');
    expect(env.TSUB_STORAGE_TYPE).toBe('postgres');
    expect(await postgres.prepare('SELECT data FROM subscriptions WHERE id = ?').bind('sub-1').first()).toBeTruthy();
    expect(await postgres.prepare('SELECT data FROM deployments WHERE id = ?').bind('deploy-1').first()).toBeTruthy();
    expect((await getStorageMigration(env, started.id))?.phase).toBe('complete');
  }, 30_000);

  it('supports a verified switch back to SQLite', async () => {
    const first = await startStorageMigration(env, 'postgres');
    await finish(first.id);
    await postgres.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').bind('profile-1', JSON.stringify({ id: 'profile-1' })).run();
    const second = await startStorageMigration(env, 'sqlite');
    await finish(second.id);
    expect(env.TSUB_STORAGE_TYPE).toBe('sqlite');
    expect(await sqlite.prepare('SELECT data FROM profiles WHERE id = ?').bind('profile-1').first()).toBeTruthy();
  }, 30_000);

  it('resumes an interrupted migration for the same target', async () => {
    const first = await startStorageMigration(env, 'postgres');
    const resumed = await startStorageMigration(env, 'postgres');
    expect(resumed.id).toBe(first.id);
    expect(resumed.phase).toBe('preflight');
    await finish(resumed.id);
    expect(env.TSUB_STORAGE_TYPE).toBe('postgres');
  }, 30_000);

  it('exposes the active migration in storage status', async () => {
    const started = await startStorageMigration(env, 'postgres');
    const status = await getStorageStatus(env);
    expect(status.migrationStatus).toBe('running');
    expect(status.migration).toMatchObject({ id: started.id, source: 'sqlite', target: 'postgres', phase: 'preflight' });
  });
});

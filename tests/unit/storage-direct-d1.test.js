// @vitest-environment node

import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DataMigrator,
  SettingsCache,
  StorageFactory,
  ensureD1Schema,
  initializeCloudflareStorage
} from '../../functions/storage-adapter.js';
import {
  getAdminCredentialMetadata,
  getCookieSecret,
  saveAdminCredentials,
  verifyAdminCredentials
} from '../../functions/modules/utils.js';

function createKv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : JSON.stringify(value)
  ]));
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    }
  };
}

describe('Cloudflare D1 direct installation', { timeout: 30_000 }, () => {
  let miniflare;

  async function database() {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['TSUB_DB']
    });
    return miniflare.getD1Database('TSUB_DB');
  }

  afterEach(async () => {
    SettingsCache.clear();
    await miniflare?.dispose();
    miniflare = null;
  });

  it('automatically creates the schema and selects D1 when it is the only binding', async () => {
    const db = await database();
    const env = { TSUB_DB: db };

    await expect(initializeCloudflareStorage(env)).resolves.toMatchObject({ activeStorage: 'd1', initialized: true });
    expect(await StorageFactory.getStorageType(env)).toBe('d1');
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deployments'").first()).toBeTruthy();
    expect(await db.prepare("SELECT active_storage, state FROM storage_control WHERE id = 'main'").first())
      .toMatchObject({ active_storage: 'd1', state: 'idle' });

    const storage = await StorageFactory.getActiveAdapter(env);
    await storage.put('tsub_direct_install_probe', { ok: true });
    await expect(storage.get('tsub_direct_install_probe')).resolves.toEqual({ ok: true });
  });

  it('ignores the initial-storage variable when only D1 is bound', async () => {
    const db = await database();
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_INITIAL_STORAGE: 'invalid' }))
      .resolves.toMatchObject({ activeStorage: 'd1' });
  });

  it('converges concurrent first requests on one D1 control record', async () => {
    const db = await database();
    const env = { TSUB_DB: db };

    const results = await Promise.all(Array.from({ length: 8 }, () => initializeCloudflareStorage(env)));
    expect(results.every(result => result.activeStorage === 'd1')).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM storage_control WHERE id = 'main'").first()).count).toBe(1);
  });

  it('repairs missing tables even when a schema version record already exists', async () => {
    const db = await database();
    await db.prepare('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME)').run();
    await db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();

    await ensureD1Schema(db);

    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_control'").first())
      .toMatchObject({ name: 'storage_control' });
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").first())
      .toMatchObject({ name: 'settings' });
  });

  it('keeps KV-only installations in basic mode', async () => {
    const env = { TSUB_KV: createKv() };
    expect(await StorageFactory.getStorageType(env)).toBe('kv');
  });

  it('does not silently fall back when D1 is selected but its binding is missing', () => {
    expect(() => StorageFactory.createAdapter({ TSUB_KV: createKv() }, 'd1'))
      .toThrow(expect.objectContaining({ code: 'ACTIVE_STORAGE_BINDING_MISSING', status: 503 }));
  });

  it('uses the explicit initial storage only when both empty bindings need a choice', async () => {
    const db = await database();
    const kv = createKv();
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_KV: kv })).resolves.toMatchObject({ activeStorage: 'kv' });

    await db.prepare("DELETE FROM storage_control WHERE id = 'main'").run();
    SettingsCache.clear();
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_KV: kv, TSUB_INITIAL_STORAGE: 'd1' }))
      .resolves.toMatchObject({ activeStorage: 'd1' });
  });

  it('prefers the only populated side over the initial-storage variable', async () => {
    const db = await database();
    const kv = createKv({ worker_settings_v1: { storageType: 'kv', siteName: 'existing' } });
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_KV: kv, TSUB_INITIAL_STORAGE: 'd1' }))
      .resolves.toMatchObject({ activeStorage: 'kv' });
  });

  it('ignores an invalid initial-storage variable when only one side contains data', async () => {
    const db = await database();
    const kv = createKv({ worker_settings_v1: { storageType: 'kv', siteName: 'existing' } });
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_KV: kv, TSUB_INITIAL_STORAGE: 'invalid' }))
      .resolves.toMatchObject({ activeStorage: 'kv' });
  });

  it('uses a consistent stored marker and rejects unresolved conflicting data', async () => {
    const db = await database();
    await ensureD1Schema(db);
    await db.prepare("INSERT INTO settings (key, value) VALUES ('main', ?)")
      .bind(JSON.stringify({ storageType: 'd1' })).run();
    const matchingKv = createKv({
      worker_settings_v1: { storageType: 'd1' },
      tsub_subscriptions_v1: [{ id: 'kv-source' }]
    });
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_KV: matchingKv }))
      .resolves.toMatchObject({ activeStorage: 'd1' });

    await db.prepare("DELETE FROM storage_control WHERE id = 'main'").run();
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'main'")
      .bind(JSON.stringify({ storageType: 'd1' })).run();
    SettingsCache.clear();
    const conflictingKv = createKv({
      worker_settings_v1: { storageType: 'kv' },
      tsub_subscriptions_v1: [{ id: 'kv-source' }]
    });
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_KV: conflictingKv }))
      .rejects.toMatchObject({ code: 'STORAGE_SELECTION_AMBIGUOUS', status: 503 });
  });

  it('treats an existing control record as authoritative', async () => {
    const db = await database();
    await ensureD1Schema(db);
    await db.prepare("INSERT INTO storage_control (id, active_storage, state, epoch, data) VALUES ('main','d1','idle',4,'{}')").run();
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_KV: createKv(), TSUB_INITIAL_STORAGE: 'invalid' }))
      .resolves.toMatchObject({ activeStorage: 'd1', initialized: false });
  });

  it('rejects an invalid initial-storage value when initialization needs it', async () => {
    const db = await database();
    await expect(initializeCloudflareStorage({ TSUB_DB: db, TSUB_KV: createKv(), TSUB_INITIAL_STORAGE: 'invalid' }))
      .rejects.toMatchObject({ code: 'INITIAL_STORAGE_INVALID', status: 503 });
  });

  it('persists cookie and administrator credential changes without KV', async () => {
    const db = await database();
    const env = {
      TSUB_DB: db,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'original-password',
      COOKIE_SECRET: 'stable-cookie-secret'
    };
    await initializeCloudflareStorage(env);

    expect(await getCookieSecret(env)).toBe('stable-cookie-secret');
    await saveAdminCredentials(env, 'original-password', 'direct-admin', 'changed-password');
    await expect(verifyAdminCredentials(env, 'direct-admin', 'changed-password')).resolves.toBe(true);
    await expect(getAdminCredentialMetadata(env)).resolves.toMatchObject({
      username: 'direct-admin', usernameSource: 'd1', passwordSource: 'd1', canPersist: true
    });
    expect(await (await StorageFactory.getActiveAdapter(env)).get('SYSTEM_COOKIE_SECRET')).toBe('stable-cookie-secret');
  }, 30_000);

  it('copies and verifies system records in both KV and D1 migration directions', async () => {
    const db = await database();
    const sourceKv = createKv({
      worker_settings_v1: { storageType: 'kv', siteName: 'migration-source' },
      tsub_subscriptions_v1: [{ id: 'tsub_airport_deploy_1', name: 'Source' }],
      tsub_profiles_v1: [{ id: 'profile-1', subscriptions: ['tsub_airport_deploy_1'] }],
      SYSTEM_COOKIE_SECRET: 'cookie-secret',
      SYSTEM_ADMIN_CREDENTIALS_V1: { schemaVersion: 1, mode: 'override', username: 'admin' },
      SYSTEM_ADMIN_PASSWORD: 'legacy-password',
      cron_last_execution: { timestamp: '2026-08-02T00:00:00.000Z', expiresAt: 2000000000000 }
    });
    const sourceEnv = { TSUB_DB: db, TSUB_KV: sourceKv };

    const copied = await DataMigrator.copyKVToD1(sourceEnv, { switchStorage: false });
    const d1Snapshot = await DataMigrator.describeD1(sourceEnv);
    expect(d1Snapshot.digest).toBe(copied.digest);
    const d1 = StorageFactory.createAdapter(sourceEnv, 'd1');
    await expect(d1.get('SYSTEM_COOKIE_SECRET')).resolves.toBe('cookie-secret');
    await expect(d1.get('SYSTEM_ADMIN_CREDENTIALS_V1')).resolves.toMatchObject({ username: 'admin' });
    await expect(d1.get('SYSTEM_ADMIN_PASSWORD')).resolves.toBe('legacy-password');
    await expect(d1.get('cron_last_execution')).resolves.toMatchObject({ expiresAt: 2000000000000 });

    const targetKv = createKv();
    const targetEnv = { TSUB_DB: db, TSUB_KV: targetKv };
    const copiedBack = await DataMigrator.copyD1ToKV(targetEnv, { switchStorage: false });
    const kvSnapshot = await DataMigrator.describeKV(targetEnv);
    expect(kvSnapshot.digest).toBe(copiedBack.digest);
    expect(JSON.parse(await targetKv.get('SYSTEM_ADMIN_CREDENTIALS_V1'))).toMatchObject({ username: 'admin' });
    expect(await targetKv.get('SYSTEM_COOKIE_SECRET')).toBe('cookie-secret');
    expect(JSON.parse(await targetKv.get('cron_last_execution'))).toMatchObject({ expiresAt: 2000000000000 });
  }, 30_000);
});

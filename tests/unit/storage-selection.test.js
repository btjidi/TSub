// @vitest-environment node

import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureD1Schema, SettingsCache } from '../../functions/storage-adapter.js';

describe('active storage selection', { timeout: 30_000 }, () => {
  let miniflare;

  afterEach(async () => {
    SettingsCache.clear();
    await miniflare?.dispose();
  });

  it('reads settings only from the storage selected by the control record', async () => {
    miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['TSUB_DB'] });
    const database = await miniflare.getD1Database('TSUB_DB');
    await ensureD1Schema(database);
    await database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .bind('main', JSON.stringify({ source: 'd1' })).run();
    await database.prepare(`INSERT INTO storage_control (id, active_storage, state, epoch, data)
      VALUES ('main', 'kv', 'idle', 1, '{}')`).run();
    const kv = {
      async get(key) { return key === 'worker_settings_v1' ? JSON.stringify({ source: 'kv' }) : null; },
      async put() {}, async delete() {}
    };
    const env = { TSUB_DB: database, TSUB_KV: kv };

    expect(await SettingsCache.get(env)).toMatchObject({ source: 'kv' });
    await database.prepare("UPDATE storage_control SET active_storage = 'd1' WHERE id = 'main'").run();
    SettingsCache.clear();
    expect(await SettingsCache.get(env)).toMatchObject({ source: 'd1' });
  });
});

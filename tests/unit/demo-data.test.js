// @vitest-environment node

import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import { handleAdminCredentials, handleDataRequest, handleSettingsGet, handleTsubsSave } from '../../functions/modules/api-handler.js';
import { handleDemoDataRequest, DEMO_DATA_KEY } from '../../functions/modules/demo-data-handler.js';
import { handleDeploymentsRequest } from '../../functions/modules/deployment-handler.js';
import { buildBackupPayload } from '../../functions/modules/webdav-backup-handler.js';
import { SettingsCache } from '../../functions/storage-adapter.js';

function createKv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    dump(key) {
      const value = values.get(key);
      return value == null ? null : JSON.parse(value);
    }
  };
}

function kvEnv() {
  return {
    ADMIN_PASSWORD: 'test-password',
    COOKIE_SECRET: 'test-cookie-secret',
    TSUB_KV: createKv({
      worker_settings_v1: { storageType: 'kv' },
      tsub_subscriptions_v1: [{ id: 'real-sub', name: 'Real source', url: 'https://real.example/sub' }],
      tsub_profiles_v1: [{ id: 'real-profile', name: 'Real profile', subscriptions: ['real-sub'], manualNodes: [] }],
      tsub_deployments_v2: [{ id: 'real-deploy', schemaVersion: 2, name: 'Real deployment', status: 'succeeded' }]
    })
  };
}

const request = (path, method = 'GET', body, headers = {}) => new Request(`https://tsub.example/api${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});

afterEach(() => SettingsCache.clear());

describe('isolated production demo data', () => {
  it('requires an authenticated admin session through the API router', async () => {
    const response = await handleApiRequest(request('/demo-data'), kvEnv());
    expect(response.status).toBe(401);
  });

  it('seeds, refreshes, summarizes, and clears the KV key without changing real records', async () => {
    const env = kvEnv();
    const first = await (await handleDemoDataRequest(request('/demo-data', 'POST'), env)).json();
    expect(first.data.counts).toMatchObject({ subscriptions: 3, nodes: 8, profiles: 2, deployments: 2, operations: 3 });
    const seeded = env.TSUB_KV.dump(DEMO_DATA_KEY);
    expect(seeded.subscriptions.every(item => item.demo && item.name.startsWith('演示 ·'))).toBe(true);
    expect(new Set(seeded.nodes.map(item => item.url.split(':', 1)[0]))).toEqual(new Set(['vless', 'trojan', 'vmess', 'hysteria2', 'tuic', 'anytls', 'ss', 'socks5']));

    const refreshed = await (await handleDemoDataRequest(request('/demo-data', 'POST'), env)).json();
    expect(refreshed.data.counts).toEqual(first.data.counts);
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')).toHaveLength(1);

    const cleared = await (await handleDemoDataRequest(request('/demo-data', 'DELETE'), env)).json();
    expect(cleared.data.counts.subscriptions).toBe(0);
    expect(env.TSUB_KV.dump(DEMO_DATA_KEY)).toBeNull();
    expect(env.TSUB_KV.dump('tsub_profiles_v1')[0].id).toBe('real-profile');
  });

  it('merges demos for normal admin views and returns only demos for screenshot views', async () => {
    const env = kvEnv();
    await handleDemoDataRequest(request('/demo-data', 'POST'), env);

    const mixed = await (await handleDataRequest(env, null, request('/data'))).json();
    expect(mixed.tsubs.some(item => item.id === 'real-sub')).toBe(true);
    expect(mixed.tsubs.filter(item => item.demo)).toHaveLength(11);

    const demoOnly = await (await handleDataRequest(env, null, request('/data', 'GET', undefined, { 'X-TSub-Demo-View': '1' }))).json();
    expect(demoOnly.tsubs).toHaveLength(11);
    expect(demoOnly.tsubs.every(item => item.demo)).toBe(true);
    expect(demoOnly.profiles.every(item => item.demo)).toBe(true);
    expect(demoOnly.ruleTemplates).toEqual([]);
    expect(demoOnly.config.externalApi).toEqual({ enabled: false, tokens: [] });

    const settings = await (await handleSettingsGet(env, request('/settings', 'GET', undefined, { 'X-TSub-Demo-View': '1' }))).json();
    expect(settings.externalApi).toEqual({ enabled: false, tokens: [] });
    const credentials = await (await handleAdminCredentials(request('/settings/credentials', 'GET', undefined, { 'X-TSub-Demo-View': '1' }), env)).json();
    expect(credentials.data).toMatchObject({ username: 'demo-admin', canPersist: false });

    const backup = await buildBackupPayload(env, { scope: 'dataAndSettings' });
    expect(JSON.stringify(backup)).not.toContain('demo-sub-push-sg');
    expect(backup.data.subscriptions).toHaveLength(1);
  });

  it('drops demo records from ordinary saves and exposes demo operation history as read-only', async () => {
    const env = kvEnv();
    await handleDemoDataRequest(request('/demo-data', 'POST'), env);
    const demo = env.TSUB_KV.dump(DEMO_DATA_KEY);
    const saveResponse = await handleTsubsSave(request('/tsubs', 'POST', {
      tsubs: [env.TSUB_KV.dump('tsub_subscriptions_v1')[0], demo.subscriptions[0]],
      profiles: [env.TSUB_KV.dump('tsub_profiles_v1')[0], demo.profiles[0]]
    }), env);
    expect(saveResponse.status).toBe(200);
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1').every(item => !item.demo)).toBe(true);
    expect(env.TSUB_KV.dump('tsub_profiles_v1').every(item => !item.demo)).toBe(true);

    const list = await (await handleDeploymentsRequest(request('/deployments', 'GET', undefined, { 'X-TSub-Demo-View': '1' }), env, '/deployments')).json();
    expect(list.data).toHaveLength(2);
    expect(list.data.every(item => item.demo)).toBe(true);
    const operations = await (await handleDeploymentsRequest(request('/deployments/demo-deploy-sg/operations'), env, '/deployments/demo-deploy-sg/operations')).json();
    expect(operations.data).toHaveLength(2);
    const blocked = await handleDeploymentsRequest(request('/deployments/demo-deploy-sg', 'DELETE'), env, '/deployments/demo-deploy-sg');
    expect(blocked.status).toBe(409);
  });

  it('stores the same isolated payload in D1 settings storage', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['TSUB_DB']
    });
    try {
      const database = await miniflare.getD1Database('TSUB_DB');
      await database.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);');
      await database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('worker_settings_v1', JSON.stringify({ storageType: 'd1' })).run();
      const env = { TSUB_DB: database, TSUB_KV: createKv({ worker_settings_v1: { storageType: 'd1' } }) };
      const seeded = await (await handleDemoDataRequest(request('/demo-data', 'POST'), env)).json();
      expect(seeded.data.counts.nodes).toBe(8);
      const row = await database.prepare('SELECT value FROM settings WHERE key = ?').bind(DEMO_DATA_KEY).first();
      expect(JSON.parse(row.value).deployments).toHaveLength(2);
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);
});

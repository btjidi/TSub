import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCloudflareResources, handleCloudflareUsage } from '../../functions/services/cloudflare-usage-service.js';

function kvWith(value) {
  const data = new Map([['worker_settings_v1', JSON.stringify(value)]]);
  return { async get(key) { return data.get(key) || null; }, async put(key, next) { data.set(key, String(next)); }, async delete(key) { data.delete(key); }, async list() { return { keys: [] }; } };
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
const accountId = 'a'.repeat(32);
const databaseId = '11111111-1111-4111-8111-111111111111';
const namespaceId = '2'.repeat(32);
const settings = { cloudflareUsage: { enabled: true, accountId, apiToken: 'test-cloudflare-token', d1DatabaseId: databaseId, kvNamespaceId: namespaceId } };

function mockCloudflare() {
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/graphql')) {
      const query = JSON.parse(init.body).query;
      if (query.includes('limit: 1,')) return json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } });
      const today = new Date().toISOString().slice(0, 10);
      return json({ data: { viewer: { accounts: [{
        d1AnalyticsAdaptiveGroups: [{ dimensions: { date: today, databaseId }, sum: { rowsRead: 200, rowsWritten: 20, readQueries: 10, writeQueries: 2 } }],
        kvOperationsAdaptiveGroups: [{ dimensions: { date: today, namespaceId, actionType: 'read' }, sum: { requests: 30 } }],
        kvStorageAdaptiveGroups: [{ dimensions: { namespaceId }, max: { byteCount: 9000, keyCount: 3 } }]
      }] } } });
    }
    if (target.includes('/d1/database')) return json({ success: true, result: [{ uuid: databaseId, name: 'tsub-production', file_size: 10000 }], result_info: { total_pages: 1 } });
    if (target.includes('/storage/kv/namespaces')) return json({ success: true, result: [{ id: namespaceId, title: 'tsub-production' }], result_info: { total_pages: 1 } });
    throw new Error(`unexpected URL ${target}`);
  }));
}

describe('Cloudflare storage quota service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('checks permissions and returns selectable resources without exposing the token', async () => {
    mockCloudflare();
    const env = { TSUB_KV: kvWith(settings), SETTINGS_SECRET_KEY: 'settings-secret-key-for-tests' };
    const response = await handleCloudflareResources(new Request('https://example.com/api/storage/cloudflare/resources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, apiToken: 'temporary-token' }) }), env);
    const body = await response.json();
    expect(body.data.checks).toEqual({ analytics: { ok: true }, d1: { ok: true }, kv: { ok: true } });
    expect(body.data.d1[0]).toMatchObject({ id: databaseId, name: 'tsub-production' });
    expect(body.data.kv[0]).toMatchObject({ id: namespaceId, name: 'tsub-production' });
    expect(JSON.stringify(body)).not.toContain('temporary-token');
  });

  it('aggregates account and selected resource usage into seven UTC days', async () => {
    mockCloudflare();
    const env = { TSUB_KV: kvWith(settings), SETTINGS_SECRET_KEY: 'settings-secret-key-for-tests' };
    const body = await (await handleCloudflareUsage(new Request('https://example.com/api/storage/cloudflare/usage?days=7'), env)).json();
    expect(body.success).toBe(true);
    expect(body.data.daily).toHaveLength(7);
    expect(body.data.summary.d1.rowsRead).toMatchObject({ used: 200, limit: 5000000, remaining: 4999800 });
    expect(body.data.summary.d1.selected).toMatchObject({ rowsRead: 200, rowsWritten: 20, storageBytes: 10000 });
    expect(body.data.summary.d1.selected.storage).toMatchObject({ used: 10000, limit: 500000000 });
    expect(body.data.summary.kv.read.used).toBe(30);
    expect(body.data.summary.kv.accountKeyCount).toBe(3);
    expect(body.data.summary.kv.selected).toMatchObject({ read: 30, storageBytes: 9000, keyCount: 3 });
  });

  it('returns accessible resources when one permission is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith('/graphql')) return json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } });
      if (target.includes('/d1/database')) return json({ success: false, errors: [{ code: 10000 }] }, 403);
      if (target.includes('/storage/kv/namespaces')) return json({ success: true, result: [{ id: namespaceId, title: 'tsub-kv' }], result_info: { total_pages: 1 } });
      throw new Error(`unexpected URL ${target} ${init.method || 'GET'}`);
    }));
    const response = await handleCloudflareResources(new Request('https://example.com/api/storage/cloudflare/resources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, apiToken: 'partial-token' })
    }), { TSUB_KV: kvWith({}), SETTINGS_SECRET_KEY: 'settings-secret-key-for-tests' });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.checks.d1).toEqual({ ok: false, error: 'permission_required' });
    expect(body.data.checks.kv).toEqual({ ok: true });
    expect(body.data.kv).toEqual([{ id: namespaceId, name: 'tsub-kv' }]);
    expect(JSON.stringify(body)).not.toContain('partial-token');
  });

  it('reports invalid credentials without exposing Cloudflare errors or tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: false, errors: [{ message: 'raw upstream detail' }] }, 401)));
    const response = await handleCloudflareResources(new Request('https://example.com/api/storage/cloudflare/resources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, apiToken: 'invalid-secret-token' })
    }), { TSUB_KV: kvWith({}), SETTINGS_SECRET_KEY: 'settings-secret-key-for-tests' });
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(403);
    expect(serialized).toContain('invalid_token');
    expect(serialized).not.toContain('invalid-secret-token');
    expect(serialized).not.toContain('raw upstream detail');
  });

  it('queries only KV analytics when only a KV namespace is selected', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const target = String(url); requests.push(target);
      if (target.endsWith('/graphql')) {
        const query = JSON.parse(init.body).query;
        expect(query).toContain('kvOperationsAdaptiveGroups');
        expect(query).not.toContain('d1AnalyticsAdaptiveGroups');
        return json({ data: { viewer: { accounts: [{ kvOperationsAdaptiveGroups: [], kvStorageAdaptiveGroups: [] }] } } });
      }
      throw new Error(`unexpected URL ${target}`);
    }));
    const kvOnlySettings = { cloudflareUsage: { enabled: true, accountId, apiToken: 'kv-only-token', d1DatabaseId: '', kvNamespaceId: namespaceId } };
    const response = await handleCloudflareUsage(new Request('https://example.com/api/storage/cloudflare/usage?days=invalid'), {
      TSUB_KV: kvWith(kvOnlySettings), SETTINGS_SECRET_KEY: 'settings-secret-key-for-tests'
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.daily).toHaveLength(7);
    expect(requests.some(url => url.includes('/d1/database'))).toBe(false);
  });

  it('rejects server controllers without contacting Cloudflare', async () => {
    const response = await handleCloudflareUsage(new Request('https://example.com/api/storage/cloudflare/usage'), { TSUB_PLATFORM: 'server' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, error: 'cloudflare_platform_required' });
  });
});

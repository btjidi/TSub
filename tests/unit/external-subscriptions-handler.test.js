import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';

function createKv(initial = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
  );
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    }
  };
}

function createEnv({ settings = {}, subscriptions = [], profiles = [] } = {}) {
  return {
    TSUB_KV: createKv({
      worker_settings_v1: { externalApi: { enabled: true, tokens: [{ name: 'default', token: 'tsub_ok' }] }, ...settings },
      tsub_subscriptions_v1: subscriptions,
      tsub_profiles_v1: profiles
    }),
    COOKIE_SECRET: 'stable-cookie-secret',
    ADMIN_PASSWORD: 'secret-password'
  };
}

function createRequest(path, { method = 'GET', body } = {}) {
  return new Request(`https://example.com/api/ext/v1${path}`, {
    method,
    headers: {
      Authorization: 'Bearer tsub_ok',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

describe('external subscriptions handler', () => {
  it('lists only remote subscriptions on /subscriptions', async () => {
    const env = createEnv({
      subscriptions: [
        { id: 'sub-1', name: 'Airport A', url: 'https://example.com/sub-a', enabled: true, group: 'A' },
        { id: 'node-1', name: 'HK 01', url: 'vless://uuid@example.com:443#HK01', enabled: true, group: 'HK' }
      ]
    });

    const response = await handleApiRequest(createRequest('/subscriptions'), env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: 'sub-1', type: 'subscription' });
    expect(body.data[0]).not.toHaveProperty('protocol');
  });

  it('creates a remote subscription and rejects node protocols on subscription endpoints', async () => {
    const env = createEnv();

    const created = await handleApiRequest(createRequest('/subscriptions', {
      method: 'POST',
      body: { name: 'Airport B', url: 'https://example.com/sub-b', trafficQuotaOverrideBytes: 107374182400 }
    }), env);
    const createdBody = await created.json();

    expect(created.status).toBe(201);
    expect(createdBody.data).toMatchObject({
      type: 'subscription', name: 'Airport B', url: 'https://example.com/sub-b', trafficQuotaOverrideBytes: 107374182400
    });

    const invalid = await handleApiRequest(createRequest('/subscriptions', {
      method: 'POST',
      body: { name: 'Bad Node', url: 'vless://uuid@example.com:443#Bad' }
    }), env);
    const invalidBody = await invalid.json();

    expect(invalid.status).toBe(400);
    expect(invalidBody.error.code).toBe('invalid_subscription_url');
  });

  it('updates quota overrides and protects managed subscription system fields', async () => {
    const env = createEnv({
      subscriptions: [
        { id: 'sub-1', name: 'Regular', url: 'https://example.com/sub', enabled: true },
        { id: 'managed-1', name: 'Managed', url: 'https://example.com/mirror', enabled: true, source: { kind: 'tsub-deployment-push', deploymentId: 'deploy-1' } }
      ]
    });

    const patched = await handleApiRequest(createRequest('/subscriptions/sub-1', {
      method: 'PATCH', body: { trafficQuotaOverrideBytes: 5000 }
    }), env);
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.trafficQuotaOverrideBytes).toBe(5000);

    const managedQuota = await handleApiRequest(createRequest('/subscriptions/managed-1', {
      method: 'PATCH', body: { trafficQuotaOverrideBytes: 6000, notes: 'editable' }
    }), env);
    expect(managedQuota.status).toBe(200);
    expect((await managedQuota.json()).data.trafficQuotaOverrideBytes).toBe(6000);

    const managedName = await handleApiRequest(createRequest('/subscriptions/managed-1', {
      method: 'PATCH', body: { name: 'Forged' }
    }), env);
    expect(managedName.status).toBe(409);
    expect((await managedName.json()).error.code).toBe('managed_subscription_readonly');

    const managedDelete = await handleApiRequest(createRequest('/subscriptions/managed-1', {
      method: 'DELETE'
    }), env, '/subscriptions/managed-1');
    expect(managedDelete.status).toBe(409);
    expect((await managedDelete.json()).error.code).toBe('managed_subscription_readonly');

    const invalid = await handleApiRequest(createRequest('/subscriptions/sub-1', {
      method: 'PATCH', body: { trafficQuotaOverrideBytes: 0 }
    }), env);
    expect(invalid.status).toBe(400);
  });

  it('deletes subscriptions and removes them from profile subscription references', async () => {
    const env = createEnv({
      subscriptions: [
        { id: 'sub-1', name: 'Airport A', url: 'https://example.com/sub-a', enabled: true },
        { id: 'sub-2', name: 'Airport B', url: 'https://example.com/sub-b', enabled: true }
      ],
      profiles: [
        { id: 'profile-1', name: 'Main', subscriptions: ['sub-1'], manualNodes: [] },
        { id: 'profile-2', name: 'Backup', subscriptions: ['sub-1', 'sub-2'], manualNodes: [] }
      ]
    });

    const response = await handleApiRequest(createRequest('/subscriptions/sub-1', { method: 'DELETE' }), env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.deleted).toBe(true);
    expect(body.data.removedFromProfiles).toEqual(['profile-1', 'profile-2']);

    const profilesResponse = await handleApiRequest(createRequest('/profiles'), env);
    const profilesBody = await profilesResponse.json();
    expect(profilesBody.data).toEqual([
      expect.objectContaining({ id: 'profile-1', subscriptionIds: [], manualNodeIds: [] }),
      expect.objectContaining({ id: 'profile-2', subscriptionIds: ['sub-2'], manualNodeIds: [] })
    ]);
  });
});

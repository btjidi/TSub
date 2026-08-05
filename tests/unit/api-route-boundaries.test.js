import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';

function createKv(initial = {}) {
  const values = new Map(Object.entries(initial));
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

describe('API route access boundaries', () => {
  it('routes invalid one-time deployment script URLs to a uniform 404', async () => {
    const response = await handleApiRequest(new Request('https://example.com/api/deploy/run/invalid.sh'), {});
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });

  it('serves the generic deployment runner without authentication or embedded credentials', async () => {
    const response = await handleApiRequest(new Request('https://example.com/api/deploy/run.sh'), {});
    const script = await response.text();
    expect(response.status).toBe(200);
    expect(script).toContain('TSUB_TOKEN=${1-}');
    expect(script).toContain('/api/deploy/prepare');
    expect(script).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it('keeps documented public read endpoints reachable without an admin session', async () => {
    const env = { TSUB_KV: createKv() };

    const publicConfig = await handleApiRequest(new Request('https://example.com/api/public_config'), env);
    const publicProfiles = await handleApiRequest(new Request('https://example.com/api/public/profiles'), env);
    const publicClients = await handleApiRequest(new Request('https://example.com/api/clients'), env);

    expect(publicConfig.status).toBe(200);
    expect(publicProfiles.status).toBe(200);
    expect(publicClients.status).toBe(200);
  });

  it('returns unauthenticated metadata for /api/data without exposing management data', async () => {
    const env = {
      TSUB_KV: createKv({
        tsub_subscriptions_v1: JSON.stringify([{ id: 'secret-sub', name: 'Private Sub', url: 'https://airport.example/sub' }]),
        tsub_profiles_v1: JSON.stringify([{ id: 'secret-profile', name: 'Private Profile' }])
      }),
      COOKIE_SECRET: 'stable-cookie-secret',
      ADMIN_PASSWORD: 'secret-password'
    };

    const response = await handleApiRequest(new Request('https://example.com/api/data'), env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ authenticated: false, message: 'Not logged in' });
    expect(JSON.stringify(body)).not.toContain('secret-sub');
    expect(JSON.stringify(body)).not.toContain('Private Profile');
    expect(JSON.stringify(body)).not.toContain('airport.example');
  });

  it('requires an admin session for management routes before dispatching handlers', async () => {
    const env = {
      TSUB_KV: createKv(),
      COOKIE_SECRET: 'stable-cookie-secret',
      ADMIN_PASSWORD: 'secret-password'
    };

    const protectedRequests = [
      new Request('https://example.com/api/settings'),
      new Request('https://example.com/api/tsubs', { method: 'POST', body: JSON.stringify({ tsubs: [], profiles: [] }) }),
      new Request('https://example.com/api/system/export', { method: 'POST', body: JSON.stringify({}) }),
      new Request('https://example.com/api/deployments')
    ];

    for (const request of protectedRequests) {
      const response = await handleApiRequest(request, env);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body).toEqual({ error: 'Unauthorized' });
    }
  });
});

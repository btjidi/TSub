import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCloudflareEdgePermissions, cleanupManagedTunnel, ensureManagedTunnel, resolveCloudflareZone } from '../../functions/services/cloudflare-edge-service.js';

const ok = result => new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const denied = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403, headers: { 'Content-Type': 'application/json' } });
const missing = () => new Response(JSON.stringify({ success: false, errors: [{ code: 81044 }] }), { status: 404, headers: { 'Content-Type': 'application/json' } });
const invalidToken = () => new Response(JSON.stringify({ success: false, errors: [{ code: 1000 }] }), { status: 400, headers: { 'Content-Type': 'application/json' } });
const resolvedZone = (url, accountId = 'a'.repeat(32), zoneName = 'example.com', zoneId = 'b'.repeat(32)) => {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith('/zones')) return null;
  return ok(parsed.searchParams.get('name') === zoneName ? [{ id: zoneId, name: zoneName, account: { id: accountId } }] : []);
};
const config = () => ({
  edge: {
    mode: 'managed', hostname: 'edge.example.com',
    cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), apiToken: 'edit-token' }, managed: {}
  },
  inbounds: [
    { id: 'ws', edgeMode: 'append', port: 8443, transport: 'ws', tls: { mode: 'tls' }, transportOptions: { path: '/ws' } },
    { id: 'grpc', edgeMode: 'only', port: 2053, transport: 'grpc', tls: { mode: 'tls' }, transportOptions: { serviceName: 'rpc' } }
  ],
  tunnels: []
});

describe('Cloudflare managed edge service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports each required permission independently', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/zones/') && !String(url).includes('/dns_records') ? denied() : ok([])));
    const result = await checkCloudflareEdgePermissions({ accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), apiToken: 'token' });
    expect(result).toEqual({ checks: {
      tunnel: { ok: true, error: '' }, zone: { ok: false, error: 'cloudflare_edge_permission_required' },
      dns: { ok: false, error: 'cloudflare_edge_permission_required' },
      ssl: { ok: false, error: 'cloudflare_edge_permission_required' }
    }, zone: null });
  });

  it('returns the detected zone with independent Tunnel, Zone and DNS checks', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/settings/ssl') ? ok({ value: 'strict' }) : (resolvedZone(url) || ok([]))));
    const result = await checkCloudflareEdgePermissions({
      accountId: 'a'.repeat(32), apiToken: 'token', hostname: 'edge.example.com'
    });
    expect(result).toEqual({
      checks: {
        tunnel: { ok: true, error: '' }, zone: { ok: true, error: '' }, dns: { ok: true, error: '' }, ssl: { ok: true, error: '' }
      },
      zone: { id: 'b'.repeat(32), name: 'example.com', sslMode: 'strict' }
    });
  });

  it('detects the longest accessible zone from the entry hostname', async () => {
    const names = [];
    vi.stubGlobal('fetch', vi.fn(async url => {
      const parsed = new URL(url); names.push(parsed.searchParams.get('name'));
      if (parsed.searchParams.get('name') === 'sub.example.com') return ok([{ id: 'c'.repeat(32), name: 'sub.example.com', account: { id: 'a'.repeat(32) } }]);
      if (parsed.searchParams.get('name') === 'example.com') return ok([{ id: 'b'.repeat(32), name: 'example.com', account: { id: 'a'.repeat(32) } }]);
      return ok([]);
    }));
    await expect(resolveCloudflareZone({ accountId: 'a'.repeat(32), apiToken: 'token', hostname: 'node.sub.example.com' }))
      .resolves.toEqual({ id: 'c'.repeat(32), name: 'sub.example.com' });
    expect(names).toEqual(['node.sub.example.com', 'sub.example.com']);
  });

  it('returns safe errors for invalid tokens, account mismatch, missing zones and timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => invalidToken()));
    await expect(resolveCloudflareZone({ accountId: 'a'.repeat(32), apiToken: 'bad', hostname: 'edge.example.com' }))
      .rejects.toMatchObject({ code: 'cloudflare_edge_invalid_token', status: 400 });

    vi.stubGlobal('fetch', vi.fn(async url => resolvedZone(url, 'd'.repeat(32)) || ok([])));
    await expect(resolveCloudflareZone({ accountId: 'a'.repeat(32), apiToken: 'token', hostname: 'edge.example.com' }))
      .rejects.toMatchObject({ code: 'cloudflare_edge_account_mismatch', status: 400 });

    vi.stubGlobal('fetch', vi.fn(async () => ok([])));
    await expect(resolveCloudflareZone({ accountId: 'a'.repeat(32), apiToken: 'token', hostname: 'edge.example.com' }))
      .rejects.toMatchObject({ code: 'cloudflare_edge_zone_not_found', status: 404 });

    vi.stubGlobal('fetch', vi.fn(async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }));
    await expect(resolveCloudflareZone({ accountId: 'a'.repeat(32), apiToken: 'token', hostname: 'edge.example.com' }))
      .rejects.toMatchObject({ code: 'cloudflare_edge_timeout', status: 504 });
  });

  it('creates a dedicated tunnel, loopback-only ingress and DNS record', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname; calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      const zone = resolvedZone(url); if (zone) return zone;
      if (path.endsWith('/cfd_tunnel') && !init.method) return ok([]);
      if (path.endsWith('/cfd_tunnel') && init.method === 'POST') return ok({ id: 'tunnel-id' });
      if (path.endsWith('/configurations') && !init.method) return ok({ config: { ingress: [{ service: 'http_status:404' }] } });
      if (path.endsWith('/configurations')) return ok({});
      if (path.endsWith('/dns_records') && !init.method) return ok([]);
      if (path.endsWith('/dns_records') && init.method === 'POST') return ok({ id: 'dns-id' });
      if (path.endsWith('/token')) return ok('dedicated-tunnel-token');
      throw new Error(`Unexpected request ${path}`);
    }));
    const result = await ensureManagedTunnel(config(), { id: 'deploy_123' });
    expect(result.config.edge.managed).toMatchObject({ tunnelId: 'tunnel-id', dnsRecordId: 'dns-id', tunnelToken: 'dedicated-tunnel-token', managedByTsub: true });
    expect(result.config.tunnels).toEqual([{ type: 'named', hostname: 'edge.example.com', token: 'dedicated-tunnel-token' }]);
    const ingress = calls.find(call => call.path.endsWith('/configurations') && call.method === 'PUT').body.config.ingress;
    expect(ingress.at(-1)).toEqual({ service: 'http_status:404' });
    expect(ingress.slice(0, -1).every(item => /^https:\/\/127\.0\.0\.1:/.test(item.service))).toBe(true);
    expect(ingress[1].originRequest).toMatchObject({ http2Origin: true, noTLSVerify: true });
  });

  it('rolls back DNS, ingress and a newly-created tunnel when token retrieval fails', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname; const method = init.method || 'GET'; calls.push(`${method} ${path}`);
      const zone = resolvedZone(url); if (zone) return zone;
      if (path.endsWith('/cfd_tunnel') && method === 'GET') return ok([]);
      if (path.endsWith('/cfd_tunnel') && method === 'POST') return ok({ id: 'new-tunnel' });
      if (path.endsWith('/configurations') && method === 'GET') return ok({ config: { ingress: [{ service: 'http_status:404' }] } });
      if (path.endsWith('/configurations') && method === 'PUT') return ok({});
      if (path.endsWith('/dns_records') && method === 'GET') return ok([]);
      if (path.endsWith('/dns_records') && method === 'POST') return ok({ id: 'new-dns' });
      if (path.endsWith('/token')) return denied();
      if (method === 'DELETE') return ok({});
      throw new Error(`Unexpected request ${method} ${path}`);
    }));
    await expect(ensureManagedTunnel(config(), { id: 'deploy_fail' })).rejects.toMatchObject({ code: 'cloudflare_edge_permission_required' });
    expect(calls).toContain('DELETE /client/v4/zones/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/dns_records/new-dns');
    expect(calls).toContain('DELETE /client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cfd_tunnel/new-tunnel');
    expect(calls.filter(value => value.endsWith('/configurations'))).toHaveLength(3);
  });

  it('deletes a newly-created tunnel when the first ingress write fails', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname; const method = init.method || 'GET'; calls.push(`${method} ${path}`);
      const zone = resolvedZone(url); if (zone) return zone;
      if (path.endsWith('/cfd_tunnel') && method === 'GET') return ok([]);
      if (path.endsWith('/cfd_tunnel') && method === 'POST') return ok({ id: 'orphan-candidate' });
      if (path.endsWith('/configurations') && method === 'GET') return ok({ config: { ingress: [{ service: 'http_status:404' }] } });
      if (path.endsWith('/dns_records') && method === 'GET') return ok([]);
      if (path.endsWith('/configurations') && method === 'PUT') return denied();
      if (path.endsWith('/cfd_tunnel/orphan-candidate') && method === 'DELETE') return ok({});
      throw new Error(`Unexpected request ${method} ${path}`);
    }));
    await expect(ensureManagedTunnel(config(), { id: 'deploy_ingress_fail' })).rejects.toMatchObject({ code: 'cloudflare_edge_permission_required' });
    expect(calls).toContain('DELETE /client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cfd_tunnel/orphan-candidate');
  });

  it('refuses to overwrite an unrelated DNS record with the requested hostname', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname; const method = init.method || 'GET'; calls.push(`${method} ${path}`);
      const zone = resolvedZone(url); if (zone) return zone;
      if (path.endsWith('/cfd_tunnel')) return ok([{ id: 'existing-tunnel', name: 'tsub-deploy-conflict' }]);
      if (path.endsWith('/configurations')) return ok({ config: { ingress: [{ service: 'http_status:404' }] } });
      if (path.endsWith('/dns_records')) return ok([{ id: 'user-dns', name: 'edge.example.com', content: 'user-origin.example.net' }]);
      throw new Error(`Unexpected request ${method} ${path}`);
    }));
    await expect(ensureManagedTunnel(config(), { id: 'deploy_conflict' })).rejects.toMatchObject({ status: 409, code: 'cloudflare_edge_dns_conflict' });
    expect(calls.some(value => value.startsWith('PUT '))).toBe(false);
  });

  it('updates a previously managed DNS record by ID when the hostname changes', async () => {
    const value = config();
    value.edge.hostname = 'new-edge.example.com';
    value.edge.managed = { tunnelId: 'managed-tunnel', dnsRecordId: 'managed-dns', tunnelToken: 'managed-token', managedByTsub: true };
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname; const method = init.method || 'GET';
      requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
      const zone = resolvedZone(url); if (zone) return zone;
      if (path.endsWith('/configurations') && method === 'GET') return ok({ config: { ingress: [{ service: 'http_status:404' }] } });
      if (path.endsWith('/configurations') && method === 'PUT') return ok({});
      if (path.endsWith('/dns_records/managed-dns') && method === 'GET') return ok({ id: 'managed-dns', type: 'CNAME', name: 'old-edge.example.com', content: 'managed-tunnel.cfargotunnel.com', proxied: true, ttl: 1 });
      if (path.endsWith('/dns_records/managed-dns') && method === 'PUT') return ok({ id: 'managed-dns' });
      throw new Error(`Unexpected request ${method} ${path}`);
    }));
    await ensureManagedTunnel(value, { id: 'deploy_rename' });
    expect(requests.find(item => item.path.endsWith('/dns_records/managed-dns') && item.method === 'PUT').body.name).toBe('new-edge.example.com');
  });

  it('moves a managed DNS record to a newly detected zone without leaving the old record', async () => {
    const value = config();
    value.edge.hostname = 'edge.example.net';
    value.edge.managed = { tunnelId: 'managed-tunnel', dnsRecordId: 'old-dns', zoneId: 'b'.repeat(32), tunnelToken: 'managed-token', managedByTsub: true };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const parsed = new URL(url); const path = parsed.pathname; const method = init.method || 'GET'; calls.push(`${method} ${path}`);
      if (path.endsWith('/zones')) {
        const name = parsed.searchParams.get('name');
        return ok(name === 'example.net' ? [{ id: 'c'.repeat(32), name, account: { id: 'a'.repeat(32) } }] : []);
      }
      if (path.endsWith('/configurations') && method === 'GET') return ok({ config: { ingress: [{ service: 'http_status:404' }] } });
      if (path.endsWith('/configurations') && method === 'PUT') return ok({});
      if (path === `/client/v4/zones/${'c'.repeat(32)}/dns_records` && method === 'GET') return ok([]);
      if (path === `/client/v4/zones/${'c'.repeat(32)}/dns_records` && method === 'POST') return ok({ id: 'new-dns' });
      if (path === `/client/v4/zones/${'b'.repeat(32)}/dns_records/old-dns` && method === 'DELETE') return ok({});
      throw new Error(`Unexpected request ${method} ${path}`);
    }));
    const result = await ensureManagedTunnel(value, { id: 'deploy_move' });
    expect(value.edge.cloudflare).toMatchObject({ zoneId: 'c'.repeat(32), zoneName: 'example.net' });
    expect(value.edge.managed).toMatchObject({
      dnsRecordId: 'new-dns', zoneId: 'c'.repeat(32), previousDnsRecordId: 'old-dns', previousDnsZoneId: 'b'.repeat(32)
    });
    expect(calls).not.toContain(`DELETE /client/v4/zones/${'b'.repeat(32)}/dns_records/old-dns`);
    await result.finalize();
    expect(calls).toContain(`DELETE /client/v4/zones/${'b'.repeat(32)}/dns_records/old-dns`);
  });

  it('treats an already deleted DNS record as idempotent during cleanup', async () => {
    const value = config();
    value.edge.managed = { tunnelId: 'managed-tunnel', dnsRecordId: 'missing-dns', managedByTsub: true };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname; const method = init.method || 'GET'; calls.push(`${method} ${path}`);
      if (path.endsWith('/dns_records/missing-dns')) return missing();
      if (path.endsWith('/cfd_tunnel/managed-tunnel') && method === 'DELETE') return ok({});
      throw new Error(`Unexpected request ${method} ${path}`);
    }));
    await expect(cleanupManagedTunnel(value)).resolves.toEqual({ deleted: true, tunnelId: 'managed-tunnel' });
  });

  it('cascades active Tunnel cleanup and treats an already deleted Tunnel as idempotent', async () => {
    const value = config();
    value.edge.managed = { tunnelId: 'missing-tunnel', dnsRecordId: '', managedByTsub: true };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const parsed = new URL(url); calls.push(`${init.method || 'GET'} ${parsed.pathname}?${parsed.searchParams}`);
      return missing();
    }));
    await expect(cleanupManagedTunnel(value)).resolves.toEqual({ deleted: true, tunnelId: 'missing-tunnel' });
    expect(calls).toContain('DELETE /client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cfd_tunnel/missing-tunnel?cascade=true');
  });

  it('cleans DNS from the zone recorded with the managed resource', async () => {
    const value = config();
    value.edge.managed = { tunnelId: 'managed-tunnel', dnsRecordId: 'managed-dns', zoneId: 'c'.repeat(32), managedByTsub: true };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname; calls.push(`${init.method || 'GET'} ${path}`); return ok({});
    }));
    await cleanupManagedTunnel(value);
    expect(calls[0]).toBe(`DELETE /client/v4/zones/${'c'.repeat(32)}/dns_records/managed-dns`);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleDeployAddressProbe, handleDeployBootstrap, handleDeployEvents, handleDeployPrepare, handleDeployPush, handleDeployQuickTunnelCallback, handleDeployRunScript, handleDeploySubscription, handleDeploymentDefaultsRequest, handleDeploymentsRequest, normalizeDeploymentClientNodeUrl } from '../../functions/modules/deployment-handler.js';
import { decryptDeploymentConfig, encryptDeploymentConfig } from '../../functions/modules/deployment-crypto.js';

function createKv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  return { async get(key) { return values.get(key) ?? null; }, async put(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); }, dump(key) { const value = values.get(key); return value ? JSON.parse(value) : null; } };
}

function createEnv() {
  return {
    DEPLOYMENT_SECRET_KEY: 'test-deployment-secret-key-32-bytes',
    TSUB_XRAY_VERSION: 'test',
    TSUB_XRAY_AMD64_URL: 'https://example.com/xray-amd64', TSUB_XRAY_AMD64_SHA256: 'a'.repeat(64),
    TSUB_XRAY_ARM64_URL: 'https://example.com/xray-arm64', TSUB_XRAY_ARM64_SHA256: 'b'.repeat(64),
    TSUB_SINGBOX_VERSION: 'test',
    TSUB_SINGBOX_AMD64_URL: 'https://example.com/singbox-amd64', TSUB_SINGBOX_AMD64_SHA256: 'e'.repeat(64),
    TSUB_SINGBOX_ARM64_URL: 'https://example.com/singbox-arm64', TSUB_SINGBOX_ARM64_SHA256: 'f'.repeat(64),
    TSUB_BUSYBOX_VERSION: 'test',
    TSUB_BUSYBOX_AMD64_URL: 'https://example.com/busybox-amd64', TSUB_BUSYBOX_AMD64_SHA256: 'c'.repeat(64),
    TSUB_BUSYBOX_ARM64_URL: 'https://example.com/busybox-arm64', TSUB_BUSYBOX_ARM64_SHA256: 'd'.repeat(64),
    TSUB_CLOUDFLARED_VERSION: 'test',
    TSUB_CLOUDFLARED_AMD64_URL: 'https://example.com/cloudflared-amd64', TSUB_CLOUDFLARED_AMD64_SHA256: '1'.repeat(64),
    TSUB_CLOUDFLARED_ARM64_URL: 'https://example.com/cloudflared-arm64', TSUB_CLOUDFLARED_ARM64_SHA256: '2'.repeat(64),
    TSUB_KV: createKv({ worker_settings_v1: { storageType: 'kv' }, tsub_subscriptions_v1: [], tsub_profiles_v1: [{ id: 'profile-1', name: 'Main', subscriptions: [], manualNodes: [] }] })
  };
}

const config = (overrides = {}) => ({
  schemaVersion: 2,
  inbounds: [{ id: 'vless-main', protocol: 'vless', port: 443, transport: 'tcp', outbound: 'direct', credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' }, tls: { mode: 'reality', serverName: 'www.example.com', realityPrivateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', realityPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', shortId: 'a1b2c3d4' } }],
  runtime: { tier: 'auto', core: 'auto', channel: 'stable' }, firewall: { enabled: true },
  subscription: { hostname: 'node.example.com', namePrefix: 'HK' }, ...overrides
});

function jsonRequest(path, method, body) {
  return new Request(`https://tsub.example/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
function bearerFromCommand(command) {
  return command.match(/\| sh -s -- '([A-Za-z0-9_-]{43})'$/)?.[1]
    || command.match(/Bearer ([A-Za-z0-9_-]+)/)?.[1];
}
function callbackFromScript(script) { const encoded = script.match(/^callback_token_b64=([A-Za-z0-9+/=]+)$/m)?.[1]; return encoded ? atob(encoded) : ''; }
function configValue(script, key) { return script.match(new RegExp(`^${key}=([^\\r\\n]*)$`, 'm'))?.[1] || ''; }

async function createAndBootstrap(env, inputConfig = config()) {
  const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'HK VPS', nodeGroup: 'HK', profileId: 'profile-1', config: inputConfig }), env, '/deployments');
  const body = await created.json();
  const bootstrapToken = bearerFromCommand(body.data.command);
  const bootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${bootstrapToken}` } }), env);
  const script = await bootstrap.text();
  return { created, body, bootstrapToken, bootstrap, script, callbackToken: callbackFromScript(script) };
}

describe('TSub V2 deployment handler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('detects and persists the managed Tunnel zone while ignoring a submitted Zone ID', async () => {
    const env = createEnv();
    vi.stubGlobal('fetch', vi.fn(async url => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/zones')) throw new Error(`Unexpected request ${parsed.pathname}`);
      const name = parsed.searchParams.get('name');
      const result = name === 'example.com'
        ? [{ id: 'b'.repeat(32), name, account: { id: 'a'.repeat(32) } }]
        : [];
      return new Response(JSON.stringify({ success: true, result }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const managed = config({
      inbounds: [{
        id: 'managed-ws', protocol: 'vless', port: 8443, transport: 'ws', edgeMode: 'only', outbound: 'direct',
        credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' }, tls: { mode: 'tls', serverName: 'origin.example.com' },
        transportOptions: { path: '/managed' }
      }],
      edge: {
        mode: 'managed', hostname: 'node.example.com', endpoints: [],
        cloudflare: { accountId: 'a'.repeat(32), zoneId: 'f'.repeat(32), apiToken: 'managed-edit-token' },
        managed: { tunnelId: 'existing-tunnel', dnsRecordId: 'existing-dns', tunnelToken: 'existing-dedicated-tunnel-token', managedByTsub: true }
      },
      tunnels: [{ type: 'named', hostname: 'node.example.com', token: 'existing-dedicated-tunnel-token' }],
      certificate: { mode: 'self-signed' }
    });
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Managed Edge', config: managed }), env, '/deployments');
    expect(created.status).toBe(201);
    const record = env.TSUB_KV.dump('tsub_deployments_v2')[0];
    const saved = await decryptDeploymentConfig(record.encryptedConfig, env);
    expect(saved.edge.cloudflare).toMatchObject({ zoneId: 'b'.repeat(32), zoneName: 'example.com', apiToken: 'managed-edit-token' });

    const template = (await (await handleDeploymentsRequest(jsonRequest(`/deployments/${record.id}/template`, 'GET'), env, `/deployments/${record.id}/template`)).json()).data;
    template.config.edge.hostname = 'new.example.com';
    template.config.edge.cloudflare.zoneId = 'e'.repeat(32);
    const updated = await handleDeploymentsRequest(jsonRequest(`/deployments/${record.id}/operations`, 'POST', {
      action: 'update', configRevision: template.configRevision, config: template.config
    }), env, `/deployments/${record.id}/operations`);
    expect(updated.status).toBe(200);
    const updatedConfig = await decryptDeploymentConfig(env.TSUB_KV.dump('tsub_deployments_v2')[0].encryptedConfig, env);
    expect(updatedConfig.edge.cloudflare).toMatchObject({ zoneId: 'b'.repeat(32), zoneName: 'example.com', apiToken: 'managed-edit-token' });
  });

  it('rejects a managed Tunnel before saving when Cloudflare zone detection fails', async () => {
    const env = createEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1000 }] }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })));
    const managed = config({
      inbounds: [{
        id: 'managed-ws', protocol: 'vless', port: 8443, transport: 'ws', edgeMode: 'only', outbound: 'direct',
        credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' }, tls: { mode: 'tls', serverName: 'origin.example.com' }, transportOptions: { path: '/managed' }
      }],
      edge: { mode: 'managed', hostname: 'node.example.com', endpoints: [], cloudflare: { accountId: 'a'.repeat(32), apiToken: 'invalid-token' } },
      certificate: { mode: 'self-signed' }
    });
    const response = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Rejected Edge', config: managed }), env, '/deployments');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('cloudflare_edge_invalid_token');
    expect(env.TSUB_KV.dump('tsub_deployments_v2')).toBeNull();
  });

  it('waits for a strictly validated Quick Tunnel hostname before compiling edge nodes', async () => {
    const env = createEnv();
    const quick = config({
      inbounds: [{
        id: 'quick-ws', name: 'Quick WS', protocol: 'vless', port: 8443, transport: 'ws', edgeMode: 'only', outbound: 'direct',
        credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' },
        tls: { mode: 'tls', serverName: 'origin.example' }, transportOptions: { path: '/quick', host: 'origin.example' }
      }],
      certificate: { mode: 'self-signed' },
      edge: { mode: 'quick', quickInboundId: 'quick-ws', endpoints: [] },
      subscription: { hostname: 'origin.example', namePrefix: 'Quick', server: { enabled: true, pushEnabled: false } }
    });
    const result = await createAndBootstrap(env, quick);
    expect(result.bootstrap.status).toBe(200);
    expect(result.script).toContain('edge_mode=quick');
    expect(result.script).toContain('tunnel_count=1');
    expect(result.script).toContain('quick_tunnel_callback_url=https://tsub.example/api/deploy/edge/quick');
    expect(atob(configValue(result.script, 'nodes_b64'))).toBe('');
    const pushToken = atob(configValue(result.script, 'push_token_b64'));
    const invalid = await handleDeployQuickTunnelCallback(new Request('https://tsub.example/api/deploy/edge/quick', {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deploymentId: result.body.data.deployment.id, hostname: 'evil.example.com' })
    }), env);
    expect(invalid.status).toBe(400);
    const callback = await handleDeployQuickTunnelCallback(new Request('https://tsub.example/api/deploy/edge/quick', {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}`, 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify({ deploymentId: result.body.data.deployment.id, hostname: 'fresh-name.trycloudflare.com' })
    }), env);
    expect(callback.status).toBe(200);
    const node = (await callback.text()).trim();
    expect(node).toContain('@fresh-name.trycloudflare.com:443');
    expect(node).toContain('sni=fresh-name.trycloudflare.com');
    expect(node).toContain('host=fresh-name.trycloudflare.com');
    expect(node).not.toMatch(/(?:pcs|allowInsecure|insecure)=/);
    const updated = env.TSUB_KV.dump('tsub_deployments_v2')[0];
    expect(updated.edgeHostname).toBe('fresh-name.trycloudflare.com');
    expect(updated.nodeCount).toBe(1);
  });

  it('keeps auto-detected direct nodes when a Quick Tunnel hostname becomes available', async () => {
    const env = createEnv();
    const quick = config({
      runtime: { tier: 'auto', core: 'sing-box', channel: 'stable' },
      inbounds: [
        {
          id: 'quick-vless', name: 'Quick VLESS', protocol: 'vless', port: 51232, transport: 'ws', edgeMode: 'only', outbound: 'direct',
          credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' }, tls: { mode: 'none', serverName: '' }, transportOptions: { path: '/quick', host: '' }
        },
        {
          id: 'direct-vmess', name: 'Direct VMess', protocol: 'vmess', port: 51233, transport: 'ws', edgeMode: 'direct', outbound: 'direct',
          credentials: { uuid: '8b950176-f41d-4bd8-91ef-c7047ef4bbc6' }, tls: { mode: 'none', serverName: '' }, transportOptions: { path: '/vmess', host: '' }
        },
        {
          id: 'direct-hy2', name: 'Direct HY2', protocol: 'hysteria2', port: 51234, transport: 'hysteria', edgeMode: 'direct', outbound: 'direct',
          credentials: { password: 'synthetic-hy2-password' }, tls: { mode: 'tls', serverName: 'www.example.com' }, transportOptions: {}
        },
        {
          id: 'direct-tuic', name: 'Direct TUIC', protocol: 'tuic', port: 51235, transport: 'quic', edgeMode: 'direct', outbound: 'direct',
          credentials: { uuid: 'eb233e16-2f3f-42bd-91af-cfb93faf9fa9', password: 'synthetic-tuic-password' }, tls: { mode: 'tls', serverName: 'www.example.com' }, transportOptions: {}
        },
        {
          id: 'direct-socks', name: 'Direct SOCKS', protocol: 'socks5', port: 51236, transport: 'tcp', edgeMode: 'direct', outbound: 'direct',
          credentials: { username: 'synthetic-user', password: 'synthetic-socks-password' }, tls: { mode: 'none', serverName: '' }, transportOptions: {}
        }
      ],
      certificate: { mode: 'self-signed' },
      edge: { mode: 'quick', quickInboundId: 'quick-vless', endpoints: [] },
      subscription: { hostname: '', addressMode: 'auto', namePrefix: 'Quick Auto', server: { enabled: true, pushEnabled: true } }
    });
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Quick Auto', config: quick }), env, '/deployments');
    const createdBody = await created.json();
    const bootstrapToken = bearerFromCommand(createdBody.data.command);
    const operationId = createdBody.data.operation.id;
    const deploymentId = createdBody.data.deployment.id;
    const probe = new Request(`https://tsub.example/api/deploy/address/${operationId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${bootstrapToken}`, 'CF-Connecting-IP': '198.51.100.42' }
    });
    Object.defineProperty(probe, 'cf', { value: {} });
    expect((await handleDeployAddressProbe(probe, env, operationId)).status).toBe(200);
    const bootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${bootstrapToken}` } }), env);
    const script = await bootstrap.text();
    const pushToken = atob(configValue(script, 'push_token_b64'));
    const callback = await handleDeployQuickTunnelCallback(new Request('https://tsub.example/api/deploy/edge/quick', {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}`, 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify({ deploymentId, hostname: 'auto-five.trycloudflare.com' })
    }), env);
    expect(callback.status).toBe(200);
    const nodes = (await callback.text()).trim().split('\n');
    expect(nodes).toHaveLength(5);
    expect(nodes.map(node => node.slice(0, node.indexOf('://')))).toEqual(['vless', 'vmess', 'hysteria2', 'tuic', 'socks5']);
    expect(nodes[0]).toContain('@auto-five.trycloudflare.com:443');
    expect(JSON.parse(atob(nodes[1].slice('vmess://'.length))).add).toBe('198.51.100.42');
    for (const node of nodes.slice(2)) expect(node).toContain('198.51.100.42');
    const stored = env.TSUB_KV.dump('tsub_deployments_v2')[0];
    const storedConfig = await decryptDeploymentConfig(stored.encryptedConfig, env);
    expect(storedConfig.subscription.hostname).toBe('');
    expect(stored.nodeCount).toBe(5);
    const sourceId = `tsub_airport_${deploymentId}`;
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')[0]).toMatchObject({ id: sourceId, nodeCount: 5 });
    expect(env.TSUB_KV.dump(`node_cache_subscription_${encodeURIComponent(sourceId)}`)).toMatchObject({
      nodes, nodeCount: 5, source: 'tsub-deployment-quick-tunnel'
    });
    const staleCallback = await handleDeployQuickTunnelCallback(new Request('https://tsub.example/api/deploy/edge/quick', {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deploymentId, hostname: 'stale.trycloudflare.com', configRevision: stored.configRevision - 1 })
    }), env);
    expect(staleCallback.status).toBe(409);
  });

  it('restores dual-stack direct nodes without requiring an address for edge-only configurations', async () => {
    const env = createEnv();
    const quick = config({
      defaults: { deployment: { addressMode: 'dual' } },
      inbounds: [
        {
          id: 'quick-only', protocol: 'vless', port: 8443, transport: 'ws', edgeMode: 'only', outbound: 'direct',
          credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' }, tls: { mode: 'none', serverName: '' }, transportOptions: { path: '/quick', host: '' }
        },
        {
          id: 'dual-direct', protocol: 'vmess', port: 51233, transport: 'ws', edgeMode: 'direct', outbound: 'direct',
          credentials: { uuid: '8b950176-f41d-4bd8-91ef-c7047ef4bbc6' }, tls: { mode: 'none', serverName: '' }, transportOptions: { path: '/dual', host: '' }
        }
      ],
      edge: { mode: 'quick', quickInboundId: 'quick-only', endpoints: [] },
      certificate: { mode: 'self-signed' },
      subscription: { hostname: '', addressMode: 'dual', namePrefix: 'Quick Dual', server: { enabled: true, pushEnabled: true } }
    });
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Quick Dual', config: quick }), env, '/deployments');
    const body = await created.json();
    const bootstrapToken = bearerFromCommand(body.data.command);
    const operationId = body.data.operation.id;
    for (const address of ['198.51.100.43', '2001:db8::43']) {
      const probe = new Request(`https://tsub.example/api/deploy/address/${operationId}`, {
        method: 'POST', headers: { Authorization: `Bearer ${bootstrapToken}`, 'CF-Connecting-IP': address }
      });
      Object.defineProperty(probe, 'cf', { value: {} });
      expect((await handleDeployAddressProbe(probe, env, operationId)).status).toBe(200);
    }
    const bootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${bootstrapToken}` } }), env);
    const pushToken = atob(configValue(await bootstrap.text(), 'push_token_b64'));
    const callback = await handleDeployQuickTunnelCallback(new Request('https://tsub.example/api/deploy/edge/quick', {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}`, 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify({ deploymentId: body.data.deployment.id, hostname: 'dual.trycloudflare.com' })
    }), env);
    expect(callback.status).toBe(200);
    const nodes = (await callback.text()).trim().split('\n');
    expect(nodes).toHaveLength(3);
    expect(JSON.parse(atob(nodes[1].slice('vmess://'.length))).add).toBe('198.51.100.43');
    expect(JSON.parse(atob(nodes[2].slice('vmess://'.length))).add).toBe('2001:db8::43');

    const stored = env.TSUB_KV.dump('tsub_deployments_v2')[0];
    const storedConfig = await decryptDeploymentConfig(stored.encryptedConfig, env);
    storedConfig.inbounds = storedConfig.inbounds.filter(inbound => inbound.edgeMode === 'only');
    storedConfig.subscription.addressMode = 'auto';
    storedConfig.subscription.hostname = '';
    stored.encryptedConfig = await encryptDeploymentConfig(storedConfig, env);
    stored.resolvedAddresses = {};
    stored.resolvedHostname = '';
    stored.pushServerAddress = '';
    await env.TSUB_KV.put('tsub_deployments_v2', JSON.stringify([stored]));
    const edgeOnly = await handleDeployQuickTunnelCallback(new Request('https://tsub.example/api/deploy/edge/quick', {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}`, 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify({ deploymentId: stored.id, hostname: 'edge-only.trycloudflare.com' })
    }), env);
    expect(edgeOnly.status).toBe(200);
    expect((await edgeOnly.text()).trim().split('\n')).toHaveLength(1);
  });

  it('does not replace Quick Tunnel nodes when a required direct address is unavailable', async () => {
    const env = createEnv();
    const quick = config({
      inbounds: [
        {
          id: 'quick-only', protocol: 'vless', port: 8443, transport: 'ws', edgeMode: 'only', outbound: 'direct',
          credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' }, tls: { mode: 'none', serverName: '' }, transportOptions: { path: '/quick', host: '' }
        },
        {
          id: 'direct-vmess', protocol: 'vmess', port: 51233, transport: 'ws', edgeMode: 'direct', outbound: 'direct',
          credentials: { uuid: '8b950176-f41d-4bd8-91ef-c7047ef4bbc6' }, tls: { mode: 'none', serverName: '' }, transportOptions: { path: '/direct', host: '' }
        }
      ],
      edge: { mode: 'quick', quickInboundId: 'quick-only', endpoints: [] },
      certificate: { mode: 'self-signed' },
      subscription: { hostname: 'initial.example.com', namePrefix: 'Quick Missing', server: { enabled: true, pushEnabled: true } }
    });
    const result = await createAndBootstrap(env, quick);
    const pushToken = atob(configValue(result.script, 'push_token_b64'));
    const deploymentId = result.body.data.deployment.id;
    const first = await handleDeployQuickTunnelCallback(new Request('https://tsub.example/api/deploy/edge/quick', {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}`, 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify({ deploymentId, hostname: 'initial.trycloudflare.com' })
    }), env);
    expect(first.status).toBe(200);
    const before = env.TSUB_KV.dump('tsub_deployments_v2')[0];
    const beforeCount = before.nodeCount;
    const savedConfig = await decryptDeploymentConfig(before.encryptedConfig, env);
    savedConfig.subscription.hostname = '';
    before.encryptedConfig = await encryptDeploymentConfig(savedConfig, env);
    before.resolvedAddresses = {};
    before.resolvedHostname = '';
    before.pushServerAddress = '';
    await env.TSUB_KV.put('tsub_deployments_v2', JSON.stringify([before]));
    const missing = await handleDeployQuickTunnelCallback(new Request('https://tsub.example/api/deploy/edge/quick', {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}`, 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify({ deploymentId, hostname: 'missing.trycloudflare.com' })
    }), env);
    expect(missing.status).toBe(503);
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0].nodeCount).toBe(beforeCount);
  });

  it('records trusted IPv4 and IPv6 probes before producing a dual-stack bootstrap', async () => {
    const env = createEnv();
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', {
      name: 'Dual Stack',
      config: {
        defaults: { deployment: { addressMode: 'dual' } },
        inbounds: [{ protocol: 'vless', port: 51231, name: 'Dual' }]
      }
    }), env, '/deployments');
    const body = await created.json();
    const token = bearerFromCommand(body.data.command);
    const operationId = body.data.operation.id;
    const probe = address => {
      const request = new Request(`https://tsub.example/api/deploy/address/${operationId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': address } });
      Object.defineProperty(request, 'cf', { value: {} });
      return handleDeployAddressProbe(request, env, operationId);
    };
    expect((await probe('198.51.100.20')).status).toBe(200);
    expect((await probe('2001:db8::20')).status).toBe(200);
    const bootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${token}` } }), env);
    const script = await bootstrap.text();
    expect(script).toContain('subscription_address_mode=dual');
    expect(script).toContain('subscription_ipv4=198.51.100.20');
    expect(script).toContain('subscription_ipv6=2001:db8::20');
    const nodes = atob(configValue(script, 'nodes_b64')).split('\n');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toContain('@198.51.100.20:51231');
    expect(nodes[1]).toContain('@[2001:db8::20]:51231');
  });

  it('encrypts configuration, masks summaries, and emits a verified POSIX bootstrap once', async () => {
    const env = createEnv();
    const result = await createAndBootstrap(env);
    expect(result.created.status).toBe(201);
    expect(result.body.data.deployment).not.toHaveProperty('encryptedConfig');
    expect(result.body.data.command).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(result.body.data.command).toMatch(/^curl -fsSL 'https:\/\/tsub\.example\/api\/deploy\/run\.sh' \| sh -s -- '[A-Za-z0-9_-]{43}'$/);
    expect(result.body.data.wgetCommand).toMatch(/^wget -O- 'https:\/\/tsub\.example\/api\/deploy\/run\.sh' \| sh -s -- '[A-Za-z0-9_-]{43}'$/);
    expect(new URL(result.body.data.command.match(/'(https:[^']+)'/)?.[1]).pathname).toBe('/api/deploy/run.sh');
    expect(result.body.data.diagnosticCommand).toContain('-o "$TSUB_BOOTSTRAP"');
    expect(result.body.data.diagnosticCommand).toContain('TSUB_ATTEMPT');
    expect(result.body.data.diagnosticCommand).not.toContain('| /bin/sh');
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0].encryptedConfig.ciphertext).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(result.script).toContain('/proxy/v2/tsub-proxy.sh');
    expect(result.script.indexOf('TSub Proxy 系统预检')).toBeLessThan(result.script.indexOf('download ||'));
    expect(result.script).toMatch(/\?v=[a-f0-9]{64}/);
    expect(result.script).toContain('runtime_core=xray');
    expect(result.script).toContain('runtime_tier_mode=auto');
    expect(result.script).toContain('control_command=tsub');
    expect(result.script).toContain('agent_poll_interval_seconds=30');
    expect(result.script).toContain('config_revision=1');
    expect(result.script).toMatch(/^traffic_core_api_port=\d+$/m);
    expect(result.script).toMatch(/^traffic_core_api_secret_b64=[A-Za-z0-9+/=]+$/m);
    expect(atob(configValue(result.script, 'inbound_summary_b64'))).toBe('VLESS 443/TCP - tcp');
    expect(atob(configValue(result.script, 'subscription_mirror_url_b64'))).toMatch(
      new RegExp(`^https://tsub\\.example/api/deploy/subscriptions/${result.body.data.deployment.id}/[0-9a-f-]{36}$`)
    );
    expect(result.script).toContain('TSUB_CONFIG="$CONFIG" /bin/sh "$RUNTIME"');
    expect(result.callbackToken).toBeTruthy();
    const replay = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${result.bootstrapToken}` } }), env);
    expect(replay.status).toBe(401);
  });

  it('emits UDP firewall and traffic metadata for XHTTP H3', async () => {
    const env = createEnv();
    const h3Config = config({
      inbounds: [{
        id: 'vless-h3', protocol: 'vless', port: 443, transport: 'xhttp', outbound: 'direct',
        credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' },
        tls: { mode: 'tls', serverName: 'h3.example.com', certificatePath: '/cert', keyPath: '/key' },
        transportOptions: { path: '/xh', xhttpMode: 'stream-one', xhttpVersion: 'h3' }
      }],
      runtime: { tier: 'auto', core: 'xray', channel: 'stable' },
      certificate: { mode: 'existing' }
    });
    const result = await createAndBootstrap(env, h3Config);
    expect(result.bootstrap.status).toBe(200);
    expect(result.script).toContain('inbound_ports=443/udp');
  });

  it('emits transactional UDP hop metadata for Xray Hysteria2', async () => {
    const env = createEnv();
    const result = await createAndBootstrap(env, config({
      inbounds: [{
        id: 'hy2-main', protocol: 'hysteria2', port: 51231, transport: 'hysteria', outbound: 'direct',
        credentials: { password: 'hy2-secret' },
        tls: { mode: 'tls', serverName: 'hy.example.com', certificatePath: '/cert', keyPath: '/key' },
        transportOptions: { udpHopPorts: '51232-51235,51240', udpHopInterval: 30 }
      }],
      runtime: { tier: 'auto', core: 'xray', channel: 'stable' },
      certificate: { mode: 'existing' }
    }));
    expect(result.bootstrap.status).toBe(200);
    expect(result.script).toContain('inbound_ports=51231/udp');
    expect(result.script).toContain('udp_hop_rules=51231:51232-51235+51240');
  });

  it('accepts running events then atomically synchronizes nodes on success', async () => {
    const env = createEnv(); const result = await createAndBootstrap(env);
    const event = body => handleDeployEvents(new Request('https://tsub.example/api/deploy/events', { method: 'POST', headers: { Authorization: `Bearer ${result.callbackToken}`, 'Content-Type': 'text/plain' }, body }), env);
    const runningPayload = 'status=running\nstage=plan\nresourceTier=tiny\ncontainer=lxc\ninit=none\ntun=false\nfirewall=false\nswapReported=true\nswapTotalMb=512\nswapFreeMb=384\nswapUsedMb=128\ncgroupSwapReported=true\ncgroupSwapCurrentMb=32\ncgroupSwapLimitMb=-1\ncontrolCommand=tsub-2';
    expect((await event(runningPayload)).status).toBe(200);
    expect((await event(runningPayload)).status).toBe(200);
    const operationsBeforeFinal = env.TSUB_KV.dump('tsub_deployment_operations_v2');
    expect(operationsBeforeFinal[0].events).toHaveLength(1);
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0].capabilities.controlCommand).toBe('tsub-2');
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0].capabilities).toMatchObject({
      swapReported: true, swapTotalMb: 512, swapFreeMb: 384, swapUsedMb: 128,
      cgroupSwapReported: true, cgroupSwapCurrentMb: 32, cgroupSwapLimitMb: -1
    });
    const final = await event('status=succeeded\nstage=apply\nhostname=hk-01\nmessage=ok\nnode=vless://uuid@node.example.com:443#HK\nnode=invalid://bad');
    expect((await final.json()).data).toMatchObject({ accepted: 1, rejected: 1, final: true });
    const nodes = env.TSUB_KV.dump('tsub_subscriptions_v1');
    expect(nodes).toHaveLength(1); expect(nodes[0].tags).toContain('tsub-proxy-v2');
    expect(env.TSUB_KV.dump('tsub_profiles_v1')[0].manualNodes).toEqual([nodes[0].id]);
    const storedDeployments = env.TSUB_KV.dump('tsub_deployments_v2');
    expect(storedDeployments[0].deployedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(storedDeployments[0].configUpdatedAt).toBe(storedDeployments[0].deployedAt);
    const completedAt = env.TSUB_KV.dump('tsub_deployment_operations_v2')[0].completedAt;
    delete storedDeployments[0].deployedAt;
    await env.TSUB_KV.put('tsub_deployments_v2', JSON.stringify(storedDeployments));
    const legacyList = await handleDeploymentsRequest(jsonRequest('/deployments', 'GET'), env, '/deployments');
    expect((await legacyList.json()).data[0].deployedAt).toBe(completedAt);
    expect((await event('status=succeeded')).status).toBe(401);
  });

  it('registers an enabled VPS endpoint as an airport subscription without creating manual nodes', async () => {
    const env = createEnv();
    const result = await createAndBootstrap(env, config({
      subscription: {
        hostname: 'node.example.com', namePrefix: 'HK',
        server: { enabled: true, port: 51250, traffic: { enabled: true, quotaBytes: 1024 ** 3 } }
      }
    }));
    expect(result.script).toContain('subscription_server_enabled=true');
    expect(result.script).toContain('subscription_server_port=51250');
    expect(atob(configValue(result.script, 'subscription_mirror_url_b64'))).toMatch(
      new RegExp(`^https://tsub\\.example/api/deploy/subscriptions/${result.body.data.deployment.id}/[0-9a-f-]{36}$`)
    );
    const response = await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${result.callbackToken}` },
      body: 'status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=2\ncacheNode=vless://uuid@node.example.com:443#HK\ncacheNode=invalid://bad'
    }), env);
    expect(response.status).toBe(200);
    expect(await response.clone().json()).toMatchObject({ data: { cacheAccepted: 1, cacheRejected: 1 } });
    const sources = env.TSUB_KV.dump('tsub_subscriptions_v1');
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      enabled: true, enableNodeCache: true, nodeCount: 1,
      source: { kind: 'tsub-deployment-push', deploymentId: result.body.data.deployment.id }
    });
    expect(sources[0].url).toMatch(new RegExp(`^https://tsub\\.example/api/deploy/subscriptions/${result.body.data.deployment.id}/[0-9a-f-]{36}$`));
    expect(sources[0].localUrl).toMatch(/^http:\/\/node\.example\.com:51250\/cgi-bin\/[0-9a-f-]{36}$/);
    expect(env.TSUB_KV.dump(`node_cache_subscription_${encodeURIComponent(sources[0].id)}`)).toMatchObject({
      nodes: ['vless://uuid@node.example.com:443#HK'], nodeCount: 1, source: 'tsub-deployment-callback'
    });
    const profile = env.TSUB_KV.dump('tsub_profiles_v1')[0];
    expect(profile.manualNodes).toEqual([]);
    expect(profile.subscriptions).toEqual([sources[0].id]);

    const deletion = await handleDeploymentsRequest(jsonRequest(`/deployments/${result.body.data.deployment.id}/source`, 'DELETE'), env, `/deployments/${result.body.data.deployment.id}/source`);
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toMatchObject({ success: true, data: { deleted: true, id: sources[0].id } });
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')).toEqual([]);
    expect(env.TSUB_KV.dump('tsub_profiles_v1')[0].subscriptions).toEqual([]);
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).toMatchObject({ subscriptionSourceDisabled: true, subscriptionId: null });

    const ignoredPush = await handleDeployPush(new Request(`https://tsub.example/api/deploy/push/${result.body.data.deployment.id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${atob(configValue(result.script, 'push_token_b64'))}` }, body: ''
    }), env, result.body.data.deployment.id);
    expect(await ignoredPush.json()).toMatchObject({ success: true, data: { ignored: true, reason: 'subscription-source-disabled' } });
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')).toEqual([]);

    const restoration = await handleDeploymentsRequest(jsonRequest(`/deployments/${result.body.data.deployment.id}/source`, 'POST'), env, `/deployments/${result.body.data.deployment.id}/source`);
    expect(restoration.status).toBe(200);
    expect(await restoration.json()).toMatchObject({ success: true, data: { restored: true, source: { id: sources[0].id, enabled: true } } });
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')).toHaveLength(1);
    expect(env.TSUB_KV.dump('tsub_profiles_v1')[0].subscriptions).toEqual([sources[0].id]);
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).toMatchObject({ subscriptionSourceDisabled: false, subscriptionId: sources[0].id });
    expect(env.TSUB_KV.dump(`node_cache_subscription_${encodeURIComponent(sources[0].id)}`)).toMatchObject({ nodeCount: 1 });
  });

  it('stores an installation snapshot when active push is disabled', async () => {
    const env = createEnv();
    const result = await createAndBootstrap(env, config({
      subscription: {
        hostname: 'node.example.com',
        server: { enabled: true, port: 51250, pushEnabled: false, pushIntervalMinutes: 60, traffic: { enabled: true } }
      }
    }));
    expect(result.script).toContain('push_enabled=false');
    expect(result.script).toContain('push_interval_minutes=60');
    expect(configValue(result.script, 'push_token_b64')).toBe('');
    const response = await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${result.callbackToken}` },
      body: 'status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=1\ncacheNode=vless://uuid@node.example.com:443#HK'
    }), env);
    expect(response.status).toBe(200);
    const source = env.TSUB_KV.dump('tsub_subscriptions_v1')[0];
    expect(source).toMatchObject({
      nodeCount: 1, pushIntervalMinutes: 60,
      source: { kind: 'tsub-deployment-snapshot', mode: 'snapshot' }
    });
    expect(env.TSUB_KV.dump(`node_cache_subscription_${encodeURIComponent(source.id)}`)).toMatchObject({ source: 'tsub-deployment-snapshot' });
  });

  it('deletes an orphaned managed source even when its deployment record is missing', async () => {
    const env = createEnv();
    const sourceId = 'tsub_airport_missing-deployment';
    env.TSUB_KV = createKv({
      worker_settings_v1: { storageType: 'kv' },
      tsub_subscriptions_v1: [{
        id: sourceId, name: 'Orphaned push', url: 'https://tsub.example/sub', enabled: true,
        source: { kind: 'tsub-deployment-push', deploymentId: 'missing-deployment' }
      }],
      tsub_profiles_v1: [{ id: 'profile-1', subscriptions: [sourceId], manualNodes: [] }],
      [`node_cache_subscription_${encodeURIComponent(sourceId)}`]: { nodes: ['vless://example'], nodeCount: 1 }
    });

    const response = await handleDeploymentsRequest(
      jsonRequest('/deployments/missing-deployment/source', 'DELETE'),
      env,
      '/deployments/missing-deployment/source'
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { deleted: true, orphaned: true, id: sourceId } });
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')).toEqual([]);
    expect(env.TSUB_KV.dump('tsub_profiles_v1')[0].subscriptions).toEqual([]);
    expect(env.TSUB_KV.dump(`node_cache_subscription_${encodeURIComponent(sourceId)}`)).toBeNull();
  });

  it('accepts idempotent active pushes and serves the HTTPS mirror with traffic headers', async () => {
    const env = createEnv();
    const result = await createAndBootstrap(env, config({ subscription: { hostname: 'node.example.com', server: { enabled: true, port: 51250, traffic: { enabled: true, quotaBytes: 1000 } } } }));
    const deploymentId = result.body.data.deployment.id;
    const pushToken = atob(configValue(result.script, 'push_token_b64'));
    const generation = configValue(result.script, 'push_generation');
    const subscriptionToken = atob(configValue(result.script, 'subscription_server_token_b64'));
    const storedDeployments = env.TSUB_KV.dump('tsub_deployments_v2');
    storedDeployments[0].capabilities = { degradedReason: '未找到 nftables/iptables，已跳过防火墙; 首次主动推送失败' };
    storedDeployments[0].resolvedHostname = '104.28.194.104';
    storedDeployments[0].resolvedAddresses = { ipv4: '104.28.194.104' };
    storedDeployments[0].pushServerAddress = '104.28.194.104';
    await env.TSUB_KV.put('tsub_deployments_v2', JSON.stringify(storedDeployments));
    const profiles = env.TSUB_KV.dump('tsub_profiles_v1');
    profiles[0].customId = 'main-profile';
    await env.TSUB_KV.put('tsub_profiles_v1', JSON.stringify(profiles));
    await env.TSUB_KV.put('node_cache_profile_profile-1', JSON.stringify({ nodes: 'stale-id' }));
    await env.TSUB_KV.put('node_cache_profile_main-profile', JSON.stringify({ nodes: 'stale-custom-id' }));
    await env.TSUB_KV.put('node_cache_token_auto', JSON.stringify({ nodes: 'stale-main' }));
    const payload = `pushGeneration=${generation}\nsequence=1\nupload=10\ndownload=20\ntrafficBackend=core-singbox\nserverAddress=node.example.com\nsubscriptionPort=51250\nsubscriptionReady=true\nsubscriptionNodeCount=1\nnode=vless://uuid@node.example.com:443#HK`;
    const push = body => handleDeployPush(new Request(`https://tsub.example/api/deploy/push/${deploymentId}`, { method: 'POST', headers: { Authorization: `Bearer ${pushToken}` }, body }), env, deploymentId);
    expect((await push(payload)).status).toBe(200);
    expect(await env.TSUB_KV.get('node_cache_profile_profile-1')).toBeNull();
    expect(await env.TSUB_KV.get('node_cache_profile_main-profile')).toBeNull();
    expect(await env.TSUB_KV.get('node_cache_token_auto')).toBeNull();
    expect(await (await push(payload)).json()).toMatchObject({ data: { duplicate: true } });
    expect((await push(payload.replace('sequence=1', 'sequence=0'))).status).toBe(400);
    const sourceWithOverride = env.TSUB_KV.dump('tsub_subscriptions_v1');
    sourceWithOverride[0].trafficQuotaOverrideBytes = 500;
    await env.TSUB_KV.put('tsub_subscriptions_v1', JSON.stringify(sourceWithOverride));
    expect((await push(payload.replace('sequence=1', 'sequence=2').replace('download=20', 'download=25'))).status).toBe(200);
    const mirror = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`), env, deploymentId, subscriptionToken);
    expect(mirror.status).toBe(200);
    expect(mirror.headers.get('Subscription-Userinfo')).toBe('upload=10; download=25; total=500; expire=0');
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')[0]).toMatchObject({
      trafficBackend: 'core-singbox', serverAddress: 'node.example.com', subscriptionPort: 51250, subscriptionReady: true,
      localUrl: `http://node.example.com:51250/cgi-bin/${subscriptionToken}`, pushCount: 2, trafficQuotaOverrideBytes: 500
    });
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0].capabilities.degradedReason).toBe('未找到 nftables/iptables，已跳过防火墙');
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).toMatchObject({
      resolvedHostname: 'node.example.com', resolvedAddresses: {}, pushServerAddress: 'node.example.com'
    });
    expect(await mirror.text()).toContain('vless://uuid@node.example.com:443#HK');
    const shadowrocket = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`, {
      headers: { 'User-Agent': 'Shadowrocket/2.2.68' }
    }), env, deploymentId, subscriptionToken);
    expect(shadowrocket.headers.get('X-TSub-Mode')).toBe('deployment-base64');
    expect(atob(await shadowrocket.text())).toContain('vless://uuid@node.example.com:443#HK');
    const v2rayn = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`, {
      headers: { 'User-Agent': 'v2rayN/7.23' }
    }), env, deploymentId, subscriptionToken);
    expect(v2rayn.headers.get('X-TSub-Mode')).toBe('deployment-base64');
    const v2raynNodes = atob(await v2rayn.text());
    expect(v2raynNodes).toContain('vless://uuid@node.example.com:443#HK');
    expect(v2raynNodes).not.toContain('encryption=none');
    const loon = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`, {
      headers: { 'User-Agent': 'Loon/3.2.4' }
    }), env, deploymentId, subscriptionToken);
    expect(loon.headers.get('X-TSub-Mode')).toBe('deployment-loon');
    expect(await loon.text()).toContain('[Proxy]');
    expect(await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/bad`), env, deploymentId, 'bad')).toHaveProperty('status', 404);
    expect((await push(payload.replace('sequence=1', 'sequence=3').replace('trafficBackend=core-singbox', 'trafficBackend=forged'))).status).toBe(400);
    expect((await push(payload.replace('sequence=1', 'sequence=3').replace('serverAddress=node.example.com', 'serverAddress=forged.example'))).status).toBe(409);
    expect((await push(payload.replace('sequence=1', 'sequence=3').replace('subscriptionPort=51250', 'subscriptionPort=51251'))).status).toBe(409);
    expect((await push(`pushGeneration=wrong\nevent=uninstall`)).status).toBe(409);
    expect(await (await push(`pushGeneration=${generation}\nevent=uninstall`)).json()).toMatchObject({ data: { offline: true } });
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).toMatchObject({ status: 'offline', subscriptionSourceDisabled: true });
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')[0]).toMatchObject({ enabled: false, lastError: 'Deployment uninstalled' });
    expect((await push(payload.replace('sequence=1', 'sequence=3'))).status).toBe(409);
  });

  it('normalizes legacy deployment nodes for current clients', () => {
    const tuic = normalizeDeploymentClientNodeUrl('tuic://uuid:password@203.0.113.7:443?sni=www.cloudflare.com&alpn=h3&allow_insecure=1#TUIC');
    expect(tuic).toContain('alpn=h3');
    expect(tuic).toContain('congestion_control=bbr');
    expect(tuic).toContain('udp_relay_mode=native');
    expect(tuic).toContain('insecure=1');
    expect(tuic).toContain('allowInsecure=1');
    expect(normalizeDeploymentClientNodeUrl('vless://uuid@203.0.113.7:443?type=ws#VLESS')).toContain('encryption=none');
  });

  it('filters unpinned self-signed TUIC snapshots and restores client-specific output after a pinned push', async () => {
    const env = createEnv();
    const tuicDeployment = config({
      inbounds: [{
        id: 'tuic-main', name: 'Japan TUIC', protocol: 'tuic', port: 51235, transport: 'quic', outbound: 'direct',
        credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'tuic-secret' },
        tls: { mode: 'tls', serverName: 'www.cloudflare.com' }
      }],
      runtime: { tier: 'auto', core: 'sing-box', channel: 'stable' },
      certificate: { mode: 'self-signed' },
      subscription: { hostname: 'node.example.com', namePrefix: 'Japan', server: { enabled: true, port: 51250, pushEnabled: true, traffic: { enabled: true, quotaBytes: 1024 } } }
    });
    const install = await createAndBootstrap(env, tuicDeployment);
    const deploymentId = install.body.data.deployment.id;
    const subscriptionToken = atob(configValue(install.script, 'subscription_server_token_b64'));
    const missingTuic = 'tuic://79411d85-b0dc-4cd2-b46c-01789a18c650:tuic-secret@node.example.com:51235?sni=www.cloudflare.com&alpn=h3&allow_insecure=1#Japan-TUIC';
    const vless = 'vless://79411d85-b0dc-4cd2-b46c-01789a18c650@node.example.com:443?encryption=none&type=tcp#Japan-VLESS';
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${install.callbackToken}` },
      body: `status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=2\ncacheNode=${missingTuic}\ncacheNode=${vless}\ntrafficBackend=core-singbox`
    }), env);

    const missing = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`), env, deploymentId, subscriptionToken);
    expect(missing.headers.get('X-TSub-TUIC-Pin-Status')).toBe('missing');
    expect(missing.headers.get('X-TSub-TUIC-Pin-Filtered')).toBe('1');
    expect(await missing.text()).toContain('vless://');
    const missingBody = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`), env, deploymentId, subscriptionToken);
    expect(await missingBody.text()).not.toContain('tuic://');
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0].capabilities.tuicCertificatePinStatus).toBe('missing');

    const pcs = 'ab'.repeat(32);
    const spki = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
    const pinnedTuic = `tuic://79411d85-b0dc-4cd2-b46c-01789a18c650:tuic-secret@node.example.com:51235?sni=www.cloudflare.com&alpn=h3&allow_insecure=1&pcs=${pcs}&spki=${encodeURIComponent(spki)}#Japan-TUIC`;
    const pushToken = atob(configValue(install.script, 'push_token_b64'));
    const generation = configValue(install.script, 'push_generation');
    const push = await handleDeployPush(new Request(`https://tsub.example/api/deploy/push/${deploymentId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${pushToken}` },
      body: `pushGeneration=${generation}\nsequence=1\nupload=10\ndownload=20\ntrafficBackend=core-singbox\nserverAddress=node.example.com\nsubscriptionPort=51250\nsubscriptionReady=true\nsubscriptionNodeCount=2\nnode=${pinnedTuic}\nnode=${vless}`
    }), env, deploymentId);
    expect(push.status).toBe(200);
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0].capabilities.tuicCertificatePinStatus).toBe('ready');

    const v2rayn = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`, {
      headers: { 'User-Agent': 'v2rayN/7.23' }
    }), env, deploymentId, subscriptionToken);
    const v2raynNodes = atob(await v2rayn.text());
    const v2raynTuic = new URL(v2raynNodes.split('\n').find(node => node.startsWith('tuic://')));
    expect(v2raynTuic.searchParams.get('allow_insecure')).toBe('1');
    expect(v2raynTuic.searchParams.get('pcs')).toBe(pcs);
    expect(v2raynTuic.searchParams.get('spki')).toBe(spki);

    const loon = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`, {
      headers: { 'User-Agent': 'Loon/3.2.4' }
    }), env, deploymentId, subscriptionToken);
    const loonBody = await loon.text();
    expect(loonBody).toContain('skip-cert-verify=true');
    expect(loonBody).toContain('alpn=h3');

    const singbox = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}?target=singbox`), env, deploymentId, subscriptionToken);
    const singboxConfig = await singbox.json();
    const singboxTuic = singboxConfig.outbounds.find(outbound => outbound.type === 'tuic');
    expect(singboxTuic.tls).toMatchObject({
      insecure: false,
      server_name: 'www.cloudflare.com',
      alpn: ['h3'],
      certificate_public_key_sha256: [spki]
    });
    expect(singbox.headers.get('X-TSub-TUIC-Pin-Status')).toBe('ready');
    expect(singbox.headers.get('X-TSub-TUIC-Pin-Filtered')).toBe('0');
    expect(singbox.headers.get('X-TSub-Node-Total')).toBe('2');
    expect(singbox.headers.get('X-TSub-Node-Rendered')).toBe('2');
    expect(singbox.headers.get('X-TSub-Node-Omitted')).toBe('0');
    expect(singboxConfig.route.default_domain_resolver).toBe('dns-ali');

    const diagnostics = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}?target=singbox&diagnostics=1`), env, deploymentId, subscriptionToken);
    expect(diagnostics.headers.get('Content-Type')).toContain('application/json');
    expect(await diagnostics.json()).toMatchObject({ target: 'singbox', total: 2, rendered: 2, omitted: 0, rawTarget: 'nodes' });
  });

  it('keeps trusted-certificate TUIC nodes without requiring deployment pins', async () => {
    const env = createEnv();
    const install = await createAndBootstrap(env, config({
      inbounds: [{
        id: 'tuic-trusted', name: 'Trusted TUIC', protocol: 'tuic', port: 51236, transport: 'quic', outbound: 'direct',
        credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'trusted-secret' },
        tls: { mode: 'tls', serverName: 'tuic.example.com', certificatePath: '/cert', keyPath: '/key' }
      }],
      runtime: { tier: 'auto', core: 'sing-box', channel: 'stable' },
      certificate: { mode: 'existing' },
      subscription: { hostname: 'node.example.com', namePrefix: 'Trusted', server: { enabled: true, port: 51250 } }
    }));
    const deploymentId = install.body.data.deployment.id;
    const subscriptionToken = atob(configValue(install.script, 'subscription_server_token_b64'));
    const trustedTuic = 'tuic://79411d85-b0dc-4cd2-b46c-01789a18c650:trusted-secret@node.example.com:51236?sni=tuic.example.com&alpn=h3#Trusted-TUIC';
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${install.callbackToken}` },
      body: `status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=1\ncacheNode=${trustedTuic}\ntrafficBackend=core-singbox`
    }), env);

    const subscription = await handleDeploySubscription(new Request(`https://tsub.example/api/deploy/subscriptions/${deploymentId}/${subscriptionToken}`), env, deploymentId, subscriptionToken);
    expect(subscription.headers.get('X-TSub-TUIC-Pin-Status')).toBe('not-required');
    expect(subscription.headers.get('X-TSub-TUIC-Pin-Filtered')).toBe('0');
    expect(await subscription.text()).toContain('tuic://');
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0].capabilities.tuicCertificatePinStatus).toBe('not-required');
  });

  it('counts accepted snapshots and keeps the latest five push timestamps across source restore', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-30T00:00:00Z'));
      const env = createEnv();
      const result = await createAndBootstrap(env, config({ subscription: { hostname: 'node.example.com', server: { enabled: true, port: 51250 } } }));
      const deploymentId = result.body.data.deployment.id;
      const pushToken = atob(configValue(result.script, 'push_token_b64'));
      const generation = configValue(result.script, 'push_generation');
      const push = (sequence, suffix = '') => handleDeployPush(new Request(`https://tsub.example/api/deploy/push/${deploymentId}`, {
        method: 'POST', headers: { Authorization: `Bearer ${pushToken}` },
        body: `pushGeneration=${generation}\nsequence=${sequence}\nupload=${sequence}\ndownload=${sequence}\ntrafficBackend=core-singbox\nserverAddress=node.example.com\nsubscriptionPort=51250\nsubscriptionReady=true\nsubscriptionNodeCount=1\nnode=vless://uuid@node.example.com:443#HK${suffix}`
      }), env, deploymentId);

      for (let sequence = 1; sequence <= 6; sequence++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 6, 30, 0, sequence, 0)));
        expect((await push(sequence, String(sequence))).status).toBe(200);
      }
      expect(await (await push(6, '6')).json()).toMatchObject({ data: { duplicate: true } });
      vi.setSystemTime(new Date('2026-07-30T00:07:00Z'));
      expect((await push(7, '7').then(response => response.status))).toBe(200);

      const source = env.TSUB_KV.dump('tsub_subscriptions_v1')[0];
      const deployment = env.TSUB_KV.dump('tsub_deployments_v2')[0];
      expect(source.pushCount).toBe(7);
      expect(deployment.pushCount).toBe(7);
      expect(source.pushHistory).toHaveLength(5);
      expect(source.pushHistory).toEqual(deployment.pushHistory);
      expect(source.pushHistory[0]).toBe('2026-07-30T00:07:00.000Z');
      expect(source.pushHistory.at(-1)).toBe('2026-07-30T00:03:00.000Z');

      expect((await handleDeploymentsRequest(jsonRequest(`/deployments/${deploymentId}/source`, 'DELETE'), env, `/deployments/${deploymentId}/source`)).status).toBe(200);
      expect((await handleDeploymentsRequest(jsonRequest(`/deployments/${deploymentId}/source`, 'POST'), env, `/deployments/${deploymentId}/source`)).status).toBe(200);
      expect(env.TSUB_KV.dump('tsub_subscriptions_v1')[0]).toMatchObject({ pushCount: 7, pushHistory: deployment.pushHistory });
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates protocol dependencies and requires a deployment encryption key', async () => {
    const env = createEnv(); delete env.DEPLOYMENT_SECRET_KEY;
    const noKey = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Bad', config: config() }), env, '/deployments');
    expect(noKey.status).toBe(503);
    const noAssets = createEnv(); delete noAssets.TSUB_SINGBOX_AMD64_SHA256;
    expect((await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'No assets', config: config({ runtime: { tier: 'auto', core: 'sing-box', channel: 'stable' } }) }), noAssets, '/deployments')).status).toBe(503);
    const env2 = createEnv();
    const invalid = config({ inbounds: [{ protocol: 'hysteria2', port: 443, transport: 'tcp', outbound: 'direct', credentials: { password: 'x' }, tls: { mode: 'none' } }] });
    expect((await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Bad', config: invalid }), env2, '/deployments')).status).toBe(400);
  });

  it('emits separately pinned archive and extracted-binary hashes', async () => {
    const env = createEnv();
    Object.assign(env, {
      TSUB_SINGBOX_VERSION: '1.13.15',
      TSUB_SINGBOX_AMD64_URL: 'https://example.com/sing-box-amd64.tar.gz',
      TSUB_SINGBOX_AMD64_SHA256: '1'.repeat(64),
      TSUB_SINGBOX_AMD64_FORMAT: 'tar.gz',
      TSUB_SINGBOX_AMD64_BINARY_SHA256: '2'.repeat(64),
      TSUB_SINGBOX_ARM64_URL: 'https://example.com/sing-box-arm64.tar.gz',
      TSUB_SINGBOX_ARM64_SHA256: '3'.repeat(64),
      TSUB_SINGBOX_ARM64_FORMAT: 'tar.gz',
      TSUB_SINGBOX_ARM64_BINARY_SHA256: '4'.repeat(64)
    });
    const result = await createAndBootstrap(env, config({
      inbounds: [{ protocol: 'anytls', port: 443 }],
      runtime: { tier: 'auto', core: 'sing-box', channel: 'stable' }
    }));
    expect(result.created.status).toBe(201);
    expect(result.script).toContain('sing-box_amd64_format=tar.gz');
    expect(result.script).toContain(`sing-box_amd64_sha256=${'1'.repeat(64)}`);
    expect(result.script).toContain(`sing-box_amd64_binary_sha256=${'2'.repeat(64)}`);
  });

  it('rejects expired and forged bootstrap tokens', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const env = createEnv();
      const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Expired', config: config() }), env, '/deployments');
      const token = bearerFromCommand((await created.json()).data.command);
      vi.setSystemTime(new Date('2026-01-01T00:31:00Z'));
      expect((await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${token}` } }), env)).status).toBe(410);
      expect((await handleDeployPrepare(new Request('https://tsub.example/api/deploy/prepare', { headers: { Authorization: `Bearer ${token}` } }), env)).status).toBe(404);
      expect((await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', { method: 'POST', headers: { Authorization: 'Bearer forged' }, body: 'status=succeeded' }), env)).status).toBe(401);
    } finally { vi.useRealTimers(); }
  });

  it('serves token-free runner and prepare scripts without consuming the bootstrap token', async () => {
    const env = createEnv();
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Short command', config: config() }), env, '/deployments');
    const body = await created.json();
    const token = bearerFromCommand(body.data.wgetCommand);
    const runUrl = 'https://tsub.example/api/deploy/run.sh';

    const runnerResponse = await handleDeployRunScript(new Request(runUrl));
    const runner = await runnerResponse.text();
    expect(runnerResponse.status).toBe(200);
    expect(runnerResponse.headers.get('Content-Type')).toContain('text/x-shellscript');
    expect(runnerResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(runnerResponse.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(runner).toMatch(/^#!\/bin\/sh/);
    expect(runner).toContain('TSUB_TOKEN=${1-}');
    expect(runner).toContain('/api/deploy/prepare');
    expect(runner).not.toContain(token);
    expect(runner).not.toContain('Short command');

    const prepareRequest = () => new Request('https://tsub.example/api/deploy/prepare', { headers: { Authorization: `Bearer ${token}` } });
    const prepareResponse = await handleDeployPrepare(prepareRequest(), env);
    const launcher = await prepareResponse.text();
    expect(prepareResponse.status).toBe(200);
    expect(prepareResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(launcher).toContain('read -r TSUB_CONFIRM </dev/tty');
    expect(launcher.indexOf('输入 Y 确认')).toBeLessThan(launcher.indexOf('/api/deploy/bootstrap'));
    expect(launcher).toContain('Short command');
    expect(launcher).not.toContain(token);

    const bootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', {
      headers: { Authorization: `Bearer ${token}` }
    }), env);
    expect(bootstrap.status).toBe(200);
    expect((await handleDeployPrepare(prepareRequest(), env)).status).toBe(404);
    expect((await handleDeployPrepare(new Request('https://tsub.example/api/deploy/prepare', { headers: { Authorization: 'Bearer invalid' } }), env)).status).toBe(404);
  });

  it('rejects oversized events', async () => {
    const response = await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', { method: 'POST', headers: { 'Content-Length': String(256 * 1024 + 1), Authorization: 'Bearer ignored' } }), createEnv());
    expect(response.status).toBe(413);
  });

  it('disables nodes after a successful uninstall operation', async () => {
    const env = createEnv(); const install = await createAndBootstrap(env);
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', { method: 'POST', headers: { Authorization: `Bearer ${install.callbackToken}` }, body: 'status=succeeded\nstage=apply\nnode=vless://uuid@node.example.com:443#HK' }), env);
    const id = install.body.data.deployment.id;
    const command = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', { action: 'uninstall' }), env, `/deployments/${id}/operations`);
    const bootToken = bearerFromCommand((await command.json()).data.command);
    const bootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${bootToken}` } }), env);
    const callback = callbackFromScript(await bootstrap.text());
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', { method: 'POST', headers: { Authorization: `Bearer ${callback}` }, body: 'status=succeeded\nstage=uninstall' }), env);
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')[0]).toMatchObject({ enabled: false, lastError: 'Deployment uninstalled' });
  });

  it('optionally deletes the active-push subscription with its deployment record', async () => {
    const pushConfig = () => config({
      subscription: { hostname: 'node.example.com', namePrefix: 'HK', server: { enabled: true, port: 51250, pushEnabled: true } }
    });
    const keepEnv = createEnv();
    const kept = await createAndBootstrap(keepEnv, pushConfig());
    const keptId = kept.body.data.deployment.id;
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${kept.callbackToken}` },
      body: 'status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=1\ncacheNode=vless://uuid@node.example.com:443#HK'
    }), keepEnv);
    const keepResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${keptId}`, 'DELETE'), keepEnv, `/deployments/${keptId}`);
    expect((await keepResponse.json()).data).toMatchObject({ deleted: true, subscriptionDeleted: false });
    expect(keepEnv.TSUB_KV.dump('tsub_subscriptions_v1')).toEqual([expect.objectContaining({ id: `tsub_airport_${keptId}`, enabled: false })]);

    const deleteEnv = createEnv();
    const removed = await createAndBootstrap(deleteEnv, pushConfig());
    const removedId = removed.body.data.deployment.id;
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${removed.callbackToken}` },
      body: 'status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=1\ncacheNode=vless://uuid@node.example.com:443#HK'
    }), deleteEnv);
    const deleteResponse = await handleDeploymentsRequest(
      jsonRequest(`/deployments/${removedId}?deleteSubscriptionSource=true`, 'DELETE'), deleteEnv, `/deployments/${removedId}`
    );
    expect((await deleteResponse.json()).data).toMatchObject({ deleted: true, subscriptionDeleted: true });
    expect(deleteEnv.TSUB_KV.dump('tsub_subscriptions_v1')).toEqual([]);
  });

  it('allows reinstalling a running initial install and revokes its callback', async () => {
    const env = createEnv();
    const install = await createAndBootstrap(env);
    const id = install.body.data.deployment.id;

    const running = await handleDeploymentsRequest(jsonRequest('/deployments', 'GET'), env, '/deployments');
    expect((await running.json()).data[0]).toMatchObject({ id, status: 'running', reinstallable: true });
    const template = (await (await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/template`, 'GET'), env, `/deployments/${id}/template`)).json()).data;
    const reinstall = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'reinstall', configRevision: template.configRevision, config: template.config
    }), env, `/deployments/${id}/operations`);
    expect(reinstall.status).toBe(200);

    const oldApply = env.TSUB_KV.dump('tsub_deployment_operations_v2').find(item => item.action === 'apply');
    expect(oldApply).toMatchObject({ status: 'failed', message: 'Operation superseded by reinstall' });
    expect(oldApply.events.at(-1)).toMatchObject({ status: 'failed', stage: 'superseded' });
    const staleCallback = await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${install.callbackToken}` }, body: 'status=succeeded\nstage=apply'
    }), env);
    expect(staleCallback.status).toBe(401);
  });

  it('marks every non-demo V2 deployment as reinstallable regardless of lifecycle state', async () => {
    const pendingEnv = createEnv();
    const pendingCreate = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Pending', config: config() }), pendingEnv, '/deployments');
    expect(pendingCreate.status).toBe(201);
    const pendingList = await handleDeploymentsRequest(jsonRequest('/deployments', 'GET'), pendingEnv, '/deployments');
    expect((await pendingList.json()).data[0].reinstallable).toBe(true);

    const failedEnv = createEnv();
    const failedInstall = await createAndBootstrap(failedEnv);
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${failedInstall.callbackToken}` }, body: 'status=failed\nstage=apply\nmessage=install failed'
    }), failedEnv);
    const failedList = await handleDeploymentsRequest(jsonRequest('/deployments', 'GET'), failedEnv, '/deployments');
    expect((await failedList.json()).data[0]).toMatchObject({ status: 'failed', reinstallable: true });
    const failedId = failedInstall.body.data.deployment.id;
    const failedTemplate = (await (await handleDeploymentsRequest(jsonRequest(`/deployments/${failedId}/template`, 'GET'), failedEnv, `/deployments/${failedId}/template`)).json()).data;
    const failedReinstall = await handleDeploymentsRequest(jsonRequest(`/deployments/${failedId}/operations`, 'POST', {
      action: 'reinstall', configRevision: failedTemplate.configRevision, config: failedTemplate.config
    }), failedEnv, `/deployments/${failedId}/operations`);
    expect(failedReinstall.status).toBe(200);

    const deployedEnv = createEnv();
    const deployed = await createAndBootstrap(deployedEnv);
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${deployed.callbackToken}` }, body: 'status=succeeded\nstage=apply'
    }), deployedEnv);
    const id = deployed.body.data.deployment.id;
    const template = (await (await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/template`, 'GET'), deployedEnv, `/deployments/${id}/template`)).json()).data;
    const update = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'update', configRevision: template.configRevision, config: template.config
    }), deployedEnv, `/deployments/${id}/operations`);
    const updateToken = bearerFromCommand((await update.json()).data.command);
    const updateBootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${updateToken}` } }), deployedEnv);
    const updateCallback = callbackFromScript(await updateBootstrap.text());
    let deployedList = await handleDeploymentsRequest(jsonRequest('/deployments', 'GET'), deployedEnv, '/deployments');
    expect((await deployedList.json()).data[0]).toMatchObject({ status: 'running', reinstallable: true });
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${updateCallback}` }, body: 'status=failed\nstage=update\nmessage=update failed'
    }), deployedEnv);
    deployedList = await handleDeploymentsRequest(jsonRequest('/deployments', 'GET'), deployedEnv, '/deployments');
    expect((await deployedList.json()).data[0]).toMatchObject({ status: 'failed', reinstallable: true });
    const rejected = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'reinstall', configRevision: template.configRevision + 1, config: template.config
    }), deployedEnv, `/deployments/${id}/operations`);
    expect(rejected.status).toBe(200);
  });

  it('makes a deployment reinstallable as soon as an uninstall command is generated', async () => {
    const env = createEnv();
    const install = await createAndBootstrap(env, config({
      subscription: { hostname: 'node.example.com', server: { enabled: true, port: 51250, pushEnabled: true } }
    }));
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${install.callbackToken}` },
      body: 'status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=1\ncacheNode=vless://uuid@node.example.com:443#HK'
    }), env);
    const id = install.body.data.deployment.id;
    const uninstall = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', { action: 'uninstall' }), env, `/deployments/${id}/operations`);
    const uninstallBody = await uninstall.json();
    const uninstallToken = bearerFromCommand(uninstallBody.data.command);

    const list = await handleDeploymentsRequest(jsonRequest('/deployments', 'GET'), env, '/deployments');
    expect((await list.json()).data[0]).toMatchObject({ status: 'succeeded', pendingReason: 'uninstall', reinstallable: true });
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')[0]).toMatchObject({ enabled: true, nodeCount: 1 });

    const template = (await (await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/template`, 'GET'), env, `/deployments/${id}/template`)).json()).data;
    const reinstall = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'reinstall', configRevision: template.configRevision, config: template.config
    }), env, `/deployments/${id}/operations`);
    expect(reinstall.status).toBe(200);
    const staleUninstall = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', {
      headers: { Authorization: `Bearer ${uninstallToken}` }
    }), env);
    expect(staleUninstall.status).toBe(401);
    const oldUninstall = env.TSUB_KV.dump('tsub_deployment_operations_v2').find(item => item.id === uninstallBody.data.operation.id);
    expect(oldUninstall).toMatchObject({ status: 'failed', message: 'Operation superseded by reinstall' });
  });

  it('reinstalls an offline deployment with its retained configuration and restores its subscription', async () => {
    const env = createEnv();
    const install = await createAndBootstrap(env, config({
      subscription: { hostname: 'node.example.com', server: { enabled: true, port: 51250, pushEnabled: true, traffic: { enabled: true, quotaBytes: 1024 } } }
    }));
    const id = install.body.data.deployment.id;
    const originalPushToken = atob(configValue(install.script, 'push_token_b64'));
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${install.callbackToken}` },
      body: 'status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=1\ncacheNode=vless://uuid@node.example.com:443#HK\ntrafficBackend=core-xray'
    }), env);

    const activeTemplate = (await (await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/template`, 'GET'), env, `/deployments/${id}/template`)).json()).data;
    const activeReinstall = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'reinstall', configRevision: activeTemplate.configRevision, config: activeTemplate.config
    }), env, `/deployments/${id}/operations`);
    expect(activeReinstall.status).toBe(200);

    const uninstall = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', { action: 'uninstall' }), env, `/deployments/${id}/operations`);
    const uninstallToken = bearerFromCommand((await uninstall.json()).data.command);
    const uninstallBootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${uninstallToken}` } }), env);
    const uninstallCallback = callbackFromScript(await uninstallBootstrap.text());
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${uninstallCallback}` }, body: 'status=succeeded\nstage=uninstall\ntrafficBackend=unavailable'
    }), env);
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).toMatchObject({ status: 'offline', subscriptionSourceDisabled: true });

    const offlineTemplateResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/template`, 'GET'), env, `/deployments/${id}/template`);
    expect(offlineTemplateResponse.status).toBe(200);
    const offlineTemplate = (await offlineTemplateResponse.json()).data;
    const reinstall = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'reinstall', name: 'HK Reinstalled', configRevision: offlineTemplate.configRevision, config: offlineTemplate.config
    }), env, `/deployments/${id}/operations`);
    expect(reinstall.status).toBe(200);
    const reinstallBody = await reinstall.json();
    expect(reinstallBody.data.operation.action).toBe('reinstall');
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).toMatchObject({ name: 'HK Reinstalled', status: 'pending', pendingReason: 'reinstall', configRevision: 3 });

    const reinstallBootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', {
      headers: { Authorization: `Bearer ${bearerFromCommand(reinstallBody.data.command)}` }
    }), env);
    const reinstallScript = await reinstallBootstrap.text();
    expect(reinstallScript).toContain('TSUB_CONFIG="$CONFIG" /bin/sh "$RUNTIME" \'apply\'');
    expect(atob(configValue(reinstallScript, 'push_token_b64'))).toBe(originalPushToken);
    const failedCallback = callbackFromScript(reinstallScript);
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${failedCallback}` }, body: 'status=failed\nstage=apply\nmessage=probe failed\ntrafficBackend=unavailable'
    }), env);
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).toMatchObject({ status: 'offline', pendingReason: 'reinstall', lastError: 'probe failed' });

    const retry = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'reinstall'
    }), env, `/deployments/${id}/operations`);
    const retryBody = await retry.json();
    const retryBootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', {
      headers: { Authorization: `Bearer ${bearerFromCommand(retryBody.data.command)}` }
    }), env);
    const retryScript = await retryBootstrap.text();
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${callbackFromScript(retryScript)}` },
      body: 'status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=1\ncacheNode=vless://uuid@node.example.com:443#HK\ntrafficBackend=core-xray'
    }), env);

    const restored = env.TSUB_KV.dump('tsub_deployments_v2')[0];
    expect(restored).toMatchObject({ id, status: 'succeeded', subscriptionSourceDisabled: false, configRevision: 3, deployedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(restored).not.toHaveProperty('pendingReason');
    expect(env.TSUB_KV.dump('tsub_subscriptions_v1')[0]).toMatchObject({ enabled: true, nodeCount: 1 });
  });

  it('encrypts deployment defaults and returns only the UUID in clear text', async () => {
    const env = createEnv();
    const saved = await handleDeploymentDefaultsRequest(jsonRequest('/deployment-defaults', 'PUT', { defaults: { credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'secret' }, tunnel: { token: 'token-secret' } } }), env);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ data: { credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: '********' }, tunnel: { token: '********' } } });
    const stored = env.TSUB_KV.dump('tsub_deployment_defaults_v2');
    expect(stored.ciphertext).not.toContain('secret');
    const reset = await handleDeploymentDefaultsRequest(jsonRequest('/deployment-defaults', 'DELETE'), env);
    expect((await reset.json()).data.credentials.uuid).toBe('');
  });

  it('uses a Cloudflare-provided source address but rejects a forged direct header', async () => {
    const env = createEnv();
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Auto host', config: { inbounds: [{ protocol: 'vless' }] } }), env, '/deployments');
    const token = bearerFromCommand((await created.json()).data.command);
    const forged = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '203.0.113.9' } }), env);
    expect(forged.status).toBe(400);

    const createdAgain = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Auto host 2', config: { inbounds: [{ protocol: 'vless' }] } }), env, '/deployments');
    const tokenAgain = bearerFromCommand((await createdAgain.json()).data.command);
    const trusted = new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${tokenAgain}`, 'CF-Connecting-IP': '2001:db8::9' } });
    Object.defineProperty(trusted, 'cf', { value: { colo: 'SIN' } });
    const bootstrap = await handleDeployBootstrap(trusted, env);
    expect(bootstrap.status).toBe(200);
    const script = await bootstrap.text();
    const encodedNodes = script.match(/^nodes_b64=(.+)$/m)?.[1];
    expect(atob(encodedNodes)).toContain('@[2001:db8::9]:');
  });

  it('marks a succeeded deployment pending when its encrypted configuration changes', async () => {
    const env = createEnv(); const result = await createAndBootstrap(env);
    await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', { method: 'POST', headers: { Authorization: `Bearer ${result.callbackToken}` }, body: 'status=succeeded\nstage=apply' }), env);
    const id = result.body.data.deployment.id;
    const updated = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}`, 'PATCH', { config: config({ subscription: { hostname: 'updated.example.com' } }) }), env, `/deployments/${id}`);
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({ status: 'pending', configSummary: { schemaVersion: 2 } });
  });

  it('returns a masked editable template and atomically updates an existing deployment by revision', async () => {
    const env = createEnv();
    const source = await createAndBootstrap(env, config({ subscription: { hostname: 'node.example.com', server: { enabled: true, port: 51250, pushEnabled: true, traffic: { enabled: true, quotaBytes: 1024 } } } }));
    const id = source.body.data.deployment.id;
    const originalPushToken = atob(configValue(source.script, 'push_token_b64'));
    const originalGeneration = configValue(source.script, 'push_generation');
    const originalTrafficSecret = atob(configValue(source.script, 'traffic_core_api_secret_b64'));
    const originalSubscriptionToken = atob(configValue(source.script, 'subscription_server_token_b64'));

    const templateResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/template`, 'GET'), env, `/deployments/${id}/template`);
    expect(templateResponse.status).toBe(200);
    const template = (await templateResponse.json()).data;
    expect(template).toMatchObject({ configRevision: 1, retainedSecrets: true, editor: { sharedUuidEnabled: true, runtime: { core: 'auto', tier: 'auto' } }, deployment: { id, configRevision: 1 } });
    const serialized = JSON.stringify(template.config);
    expect(serialized).not.toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');
    expect(serialized).not.toContain(originalPushToken);
    expect(serialized).not.toContain(originalTrafficSecret);
    expect(template.config.inbounds[0].credentials.uuid).toBe('********');
    expect(template.config.inbounds[0].tls.realityPrivateKey).toBe('********');
    expect(template.config.subscription.server.token).toBe('********');

    const updateResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'update', name: 'HK Updated', nodeGroup: 'Updated', profileId: 'profile-1', configRevision: 1, config: template.config
    }), env, `/deployments/${id}/operations`);
    expect(updateResponse.status).toBe(200);
    const updateBody = await updateResponse.json();
    const storedPending = env.TSUB_KV.dump('tsub_deployments_v2')[0];
    expect(storedPending).toMatchObject({ id, name: 'HK Updated', nodeGroup: 'Updated', configRevision: 2, status: 'pending', pendingReason: 'config' });

    const conflict = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'update', configRevision: 1, config: template.config
    }), env, `/deployments/${id}/operations`);
    expect(conflict.status).toBe(409);

    const updateBootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${bearerFromCommand(updateBody.data.command)}` } }), env);
    const updateScript = await updateBootstrap.text();
    expect(atob(configValue(updateScript, 'push_token_b64'))).toBe(originalPushToken);
    expect(configValue(updateScript, 'push_generation')).toBe(originalGeneration);
    expect(atob(configValue(updateScript, 'traffic_core_api_secret_b64'))).toBe(originalTrafficSecret);
    expect(atob(configValue(updateScript, 'subscription_server_token_b64'))).toBe(originalSubscriptionToken);

    const callbackToken = callbackFromScript(updateScript);
    const completed = await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
      method: 'POST', headers: { Authorization: `Bearer ${callbackToken}` }, body: 'status=succeeded\nstage=update\ntrafficBackend=core-xray'
    }), env);
    expect(completed.status).toBe(200);
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).not.toHaveProperty('pendingReason');
  });

  it('accepts an unchanged self-signed template when updating a deployment', async () => {
    const env = createEnv();
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', {
      name: 'Self-signed HY2',
      config: config({
        inbounds: [{
          id: 'hy2-main', protocol: 'hysteria2', port: 51232, transport: 'hysteria', outbound: 'direct',
          credentials: { password: 'hy2-secret' },
          tls: { mode: 'tls', serverName: 'hy.example.com' }
        }],
        certificate: { mode: 'self-signed' }
      })
    }), env, '/deployments');
    const createdBody = await created.json();
    const id = createdBody.data.deployment.id;
    const templateResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/template`, 'GET'), env, `/deployments/${id}/template`);
    const template = (await templateResponse.json()).data;

    expect(template.config.inbounds[0].tls.certificatePath).toBe('__TSUB_CERT_DIR__/hy.example.com.crt');
    const updated = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'update', configRevision: template.configRevision, config: template.config
    }), env, `/deployments/${id}/operations`);

    expect(updated.status).toBe(200);
    expect((await updated.json()).data.operation.action).toBe('update');
    expect(env.TSUB_KV.dump('tsub_deployments_v2')[0]).toMatchObject({
      configRevision: 2, status: 'pending', pendingReason: 'config', configUpdatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    });
  });

  it('clones node and subscription credentials while rotating machine-only secrets', async () => {
    const env = createEnv();
    const source = await createAndBootstrap(env, config({
      defaults: { tunnel: { mode: 'named', hostname: 'legacy.example.com', token: 'legacy-tunnel-token-secret' } },
      edge: {
        mode: 'disabled', hostname: 'old-edge.example.com', endpoints: [{ id: 'edge-1', label: 'Preferred', address: '198.51.100.8' }],
        cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), apiToken: 'cloudflare-edit-token' },
        managed: { tunnelId: 'old-tunnel', dnsRecordId: 'old-dns', tunnelToken: 'old-managed-token', managedByTsub: true }
      },
      warp: { provisioning: 'manual', privateKey: 'warp-private', peerPublicKey: 'warp-peer', ipv4: '172.16.0.2/32', ipv6: '2606:4700:110:8::2/128' },
      subscription: { hostname: 'node.example.com', server: { enabled: true, port: 51250, pushEnabled: true, traffic: { enabled: true } } }
    }));
    const sourceId = source.body.data.deployment.id;
    const template = (await (await handleDeploymentsRequest(jsonRequest(`/deployments/${sourceId}/template`, 'GET'), env, `/deployments/${sourceId}/template`)).json()).data;
    const sourceNodeName = template.config.inbounds[0].name;
    const cloned = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', {
      name: 'HK Clone', cloneFromDeploymentId: sourceId, configRevision: template.configRevision,
      resetInheritedNodeNames: true, config: template.config
    }), env, '/deployments');
    expect(cloned.status).toBe(201);
    const cloneBody = await cloned.json();
    const cloneRecord = env.TSUB_KV.dump('tsub_deployments_v2').find(item => item.id === cloneBody.data.deployment.id);
    const cloneConfig = await decryptDeploymentConfig(cloneRecord.encryptedConfig, env);
    expect(cloneConfig.edge).toMatchObject({
      mode: 'disabled', hostname: '', endpoints: [{ id: 'edge-1', label: 'Preferred', address: '198.51.100.8', port: null }],
      cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), apiToken: 'cloudflare-edit-token' }, managed: {}
    });
    expect(cloneConfig.warp).toMatchObject({ provisioning: 'manual', privateKey: '', peerPublicKey: '', ipv4: '', ipv6: '' });
    expect(cloneConfig.tunnels).toEqual([]);
    const cloneBootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${bearerFromCommand(cloneBody.data.command)}` } }), env);
    const cloneScript = await cloneBootstrap.text();
    const clonedNodes = decodeURIComponent(atob(configValue(cloneScript, 'nodes_b64')));
    expect(atob(configValue(cloneScript, 'subscription_server_token_b64'))).toBe(atob(configValue(source.script, 'subscription_server_token_b64')));
    expect(clonedNodes).toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');
    expect(clonedNodes).toContain('HK Clone-vless-443');
    expect(clonedNodes).not.toContain(sourceNodeName);
    expect(atob(configValue(cloneScript, 'push_token_b64'))).not.toBe(atob(configValue(source.script, 'push_token_b64')));
    expect(configValue(cloneScript, 'push_generation')).not.toBe(configValue(source.script, 'push_generation'));
    expect(atob(configValue(cloneScript, 'traffic_core_api_secret_b64'))).not.toBe(atob(configValue(source.script, 'traffic_core_api_secret_b64')));
  });

  it('does not copy a deleted inbound secret into a newly added inbound', async () => {
    const env = createEnv();
    const source = await createAndBootstrap(env, config({
      defaults: { credentials: { sharedUuidEnabled: false } },
      subscription: { hostname: 'node.example.com', server: { enabled: false } }
    }));
    const id = source.body.data.deployment.id;
    const template = (await (await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/template`, 'GET'), env, `/deployments/${id}/template`)).json()).data;
    expect(template.editor.sharedUuidEnabled).toBe(false);
    template.config.inbounds.push({
      id: 'vless-new', name: 'New VLESS', protocol: 'vless', port: 444, transport: 'tcp', outbound: 'direct', credentials: {},
      tls: { mode: 'reality', serverName: 'www.example.com', realityPrivateKey: '', realityPublicKey: '' }
    });
    const updated = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'update', configRevision: 1, config: { ...template.config, defaults: { credentials: { sharedUuidEnabled: false } } }
    }), env, `/deployments/${id}/operations`);
    const updateBody = await updated.json();
    const bootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', { headers: { Authorization: `Bearer ${bearerFromCommand(updateBody.data.command)}` } }), env);
    const nodes = atob(configValue(await bootstrap.text(), 'nodes_b64'));
    const uuids = [...nodes.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi)].map(match => match[0]);
    expect(new Set(uuids).size).toBe(2);
    expect(uuids).toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');
  });

  it('places confirmation before token redemption only for mutating commands', async () => {
    const env = createEnv();
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', { name: 'Confirm Test', config: config() }), env, '/deployments');
    const createdBody = await created.json();
    expect(createdBody.data.diagnosticCommand).toContain('输入 Y 确认');
    const token = bearerFromCommand(createdBody.data.command);
    const launcher = await (await handleDeployPrepare(new Request('https://tsub.example/api/deploy/prepare', { headers: { Authorization: `Bearer ${token}` } }), env)).text();
    expect(launcher).toContain('输入 Y 确认');
    expect(launcher.indexOf('输入 Y 确认')).toBeLessThan(launcher.indexOf('/api/deploy/bootstrap'));
    const id = createdBody.data.deployment.id;
    for (const action of ['update', 'repair', 'restart', 'rollback', 'uninstall']) {
      const response = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', { action }), env, `/deployments/${id}/operations`);
      expect((await response.json()).data.diagnosticCommand).toContain('输入 Y 确认');
    }
    for (const action of ['plan', 'status', 'list', 'doctor']) {
      const response = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', { action }), env, `/deployments/${id}/operations`);
      expect((await response.json()).data.diagnosticCommand).not.toContain('输入 Y 确认');
    }
  });

  it('persists and normalizes the requested Runtime output language', async () => {
    const env = createEnv();
    const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', {
      name: 'English Runtime', config: config(), outputLanguage: 'en-US'
    }), env, '/deployments');
    const createdBody = await created.json();
    expect(createdBody.data.operation).toMatchObject({ action: 'apply', outputLanguage: 'en-US' });
    expect(createdBody.data.diagnosticCommand).toContain('Enter Y to confirm');
    expect(createdBody.data.diagnosticCommand).not.toContain('输入 Y 确认');

    const token = bearerFromCommand(createdBody.data.command);
    const prepare = await handleDeployPrepare(new Request('https://tsub.example/api/deploy/prepare', {
      headers: { Authorization: `Bearer ${token}` }
    }), env);
    const launcher = await prepare.text();
    expect(launcher).toContain('Enter Y to confirm');
    expect(launcher).toContain('Operation canceled.');
    expect(launcher).not.toContain('输入 Y 确认');

    const bootstrap = await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', {
      headers: { Authorization: `Bearer ${token}` }
    }), env);
    const script = await bootstrap.text();
    expect(script).toContain('runtime_output_language=en-US');
    expect(script).toContain('Downloading the TSub Runtime, please wait');
    expect(script).not.toContain('正在下载 TSub Runtime');
    expect(atob(configValue(script, 'node_details_b64'))).toContain(' (VLESS)');

    const id = createdBody.data.deployment.id;
    const fallback = await handleDeploymentsRequest(jsonRequest(`/deployments/${id}/operations`, 'POST', {
      action: 'status', outputLanguage: 'unsupported'
    }), env, `/deployments/${id}/operations`);
    expect((await fallback.json()).data.operation.outputLanguage).toBe('zh-CN');
  });
});

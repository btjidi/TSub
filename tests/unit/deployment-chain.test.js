import { describe, expect, it } from 'vitest';
import { compileSingBoxChainOutbound, compileXrayChainOutbound, normalizeChainNodeUrl, publicChainSummary } from '../../functions/modules/deployment-chain.js';
import { compileCoreConfig, normalizeV2Config, publicV2Config } from '../../functions/modules/deployment-v2-config.js';
import { handleDeploymentsRequest } from '../../functions/modules/deployment-handler.js';
import { decryptDeploymentConfig, encryptDeploymentConfig } from '../../functions/modules/deployment-crypto.js';
import { buildSubscriptionNodeCacheKey } from '../../functions/services/subscription-service.js';

function createKv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { values.delete(key); },
    dump(key) { const value = values.get(key); return value ? JSON.parse(value) : null; }
  };
}

const vlessUrl = 'vless://79411d85-b0dc-4cd2-b46c-01789a18c650@upstream.example.com:443?type=ws&security=tls&sni=cdn.example.com&host=cdn.example.com&path=%2Fedge#Upstream';

function request(path, method = 'GET', body) {
  return new Request(`https://tsub.example/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function inbound(chain) {
  return {
    id: 'entry', protocol: 'vless', port: 443, transport: 'tcp', outbound: 'chain',
    credentials: { uuid: 'd45f73a5-3135-4fe6-aac7-eb2f8ad2f7df' },
    tls: { mode: 'reality', serverName: 'www.cloudflare.com', realityPrivateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', realityPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    chain
  };
}

describe('single-hop chain proxy', () => {
  const snapshot = (protocol, credentials = {}, overrides = {}) => ({
    source: { type: 'url', label: protocol },
    snapshot: {
      protocol, name: protocol, server: `${protocol}.example.com`, port: 443,
      transport: { type: 'tcp', path: '/', host: '', serviceName: '' },
      tls: { enabled: ['https', 'hysteria2', 'tuic', 'anytls', 'naive'].includes(protocol), mode: ['https', 'hysteria2', 'tuic', 'anytls', 'naive'].includes(protocol) ? 'tls' : 'none', serverName: `${protocol}.example.com` },
      credentials, options: {}, ...overrides
    }
  });

  it.each([
    ['vless', { uuid: 'uuid' }, 'vless'], ['vmess', { uuid: 'uuid' }, 'vmess'], ['trojan', { password: 'secret' }, 'trojan'],
    ['shadowsocks', { password: 'secret', method: '2022-blake3-aes-128-gcm' }, 'shadowsocks'],
    ['socks5', { username: 'user', password: 'secret' }, 'socks'], ['http', { username: 'user', password: 'secret' }, 'http'],
    ['https', { username: 'user', password: 'secret' }, 'http'], ['hysteria2', { password: 'secret' }, 'hysteria'],
    ['wireguard', { privateKey: 'private', publicKey: 'public' }, 'wireguard']
  ])('compiles the %s upstream for Xray', (protocol, credentials, expected) => {
    expect(compileXrayChainOutbound(snapshot(protocol, credentials), `chain-${protocol}`).protocol).toBe(expected);
  });

  it.each([
    ['vless', { uuid: 'uuid' }, 'vless'], ['vmess', { uuid: 'uuid' }, 'vmess'], ['trojan', { password: 'secret' }, 'trojan'],
    ['shadowsocks', { password: 'secret', method: '2022-blake3-aes-128-gcm' }, 'shadowsocks'],
    ['socks5', { username: 'user', password: 'secret' }, 'socks'], ['http', { username: 'user', password: 'secret' }, 'http'],
    ['https', { username: 'user', password: 'secret' }, 'http'], ['hysteria2', { password: 'secret' }, 'hysteria2'],
    ['wireguard', { privateKey: 'private', publicKey: 'public' }, 'wireguard'],
    ['tuic', { uuid: 'uuid', password: 'secret' }, 'tuic'], ['anytls', { password: 'secret' }, 'anytls'],
    ['naive', { username: 'user', password: 'secret' }, 'naive'], ['snell', { psk: 'secret' }, 'snell']
  ])('compiles the %s upstream for sing-box', (protocol, credentials, expected) => {
    expect(compileSingBoxChainOutbound(snapshot(protocol, credentials), `chain-${protocol}`).type).toBe(expected);
  });

  it('normalizes a node URL, compiles an exact inbound route, and hides credentials publicly', () => {
    const chain = normalizeChainNodeUrl(vlessUrl, { type: 'url', label: 'test upstream' });
    const config = normalizeV2Config({ inbounds: [inbound(chain)], runtime: { core: 'xray' } });
    const compiled = compileCoreConfig(config);
    expect(compiled.outbounds.find(item => item.tag === 'chain-entry')).toMatchObject({
      protocol: 'vless', settings: { vnext: [{ address: 'upstream.example.com', port: 443 }] }
    });
    expect(compiled.routing.rules).toContainEqual({ type: 'field', inboundTag: ['entry'], outboundTag: 'chain-entry' });
    expect(compiled.routing.rules.find(item => item.inboundTag?.includes('entry'))?.outboundTag).not.toBe('direct');
    const publicConfig = publicV2Config(config);
    expect(publicConfig.inbounds[0].chain.snapshot).not.toHaveProperty('credentials');
    expect(JSON.stringify(publicConfig)).not.toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');
    expect(publicChainSummary(chain)).toMatchObject({ retainedCredentials: true, snapshot: { protocol: 'vless', server: 'upstream.example.com' } });
  });

  it('selects sing-box for a TUIC chain upstream and rejects SSR', () => {
    const chain = normalizeChainNodeUrl('tuic://79411d85-b0dc-4cd2-b46c-01789a18c650:secret@tuic.example.com:443?sni=tuic.example.com#TUIC', { type: 'url' });
    const config = normalizeV2Config({ inbounds: [inbound(chain)], runtime: { core: 'auto' } });
    expect(config.runtime.core).toBe('sing-box');
    expect(compileCoreConfig(config).outbounds.find(item => item.tag === 'chain-entry')).toMatchObject({ type: 'tuic', server: 'tuic.example.com' });
    expect(() => normalizeChainNodeUrl('ssr://Zm9v', { type: 'url' })).toThrow(/SSR\/SSD|无法解析/);
  });

  it('lists manual sources and previews pasted links without leaking secrets', async () => {
    const manual = { id: 'manual-1', name: 'Manual Upstream', url: vlessUrl, enabled: true };
    const env = {
      DEPLOYMENT_SECRET_KEY: 'test-deployment-secret-key-32-bytes',
      TSUB_KV: createKv({ worker_settings_v1: { storageType: 'kv' }, tsub_subscriptions_v1: [manual], tsub_profiles_v1: [] })
    };
    const listed = await handleDeploymentsRequest(new Request('https://tsub.example/api/deployments/chain-sources?source=manual'), env, '/deployments/chain-sources');
    const listedBody = await listed.json();
    expect(listedBody.data.items[0]).toMatchObject({ sourceType: 'manual', protocol: 'vless', address: 'upstream.example.com' });
    expect(JSON.stringify(listedBody)).not.toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');
    const preview = await handleDeploymentsRequest(new Request('https://tsub.example/api/deployments/chain-sources/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: vlessUrl })
    }), env, '/deployments/chain-sources/preview');
    const previewBody = await preview.json();
    expect(previewBody.data).toMatchObject({ protocol: 'vless', address: 'upstream.example.com' });
    expect(JSON.stringify(previewBody)).not.toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');
  });

  it('resolves a pasted source into the encrypted deployment snapshot and keeps the public template redacted', async () => {
    const kv = createKv({ worker_settings_v1: { storageType: 'kv' }, tsub_subscriptions_v1: [], tsub_profiles_v1: [] });
    const env = { DEPLOYMENT_SECRET_KEY: 'test-deployment-secret-key-32-bytes', TSUB_KV: kv };
    const created = await handleDeploymentsRequest(request('/deployments', 'POST', {
      name: 'Chained entry',
      config: {
        schemaVersion: 2,
        inbounds: [{ ...inbound(), chain: { source: { type: 'url', url: vlessUrl, label: 'Pasted upstream' } } }],
        runtime: { core: 'auto', tier: 'auto', channel: 'stable' },
        subscription: { hostname: 'entry.example.com' }
      }
    }), env, '/deployments');
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const deploymentId = createdBody.data.deployment.id;
    const stored = kv.dump('tsub_deployments_v2').find(item => item.id === deploymentId);
    const decrypted = await decryptDeploymentConfig(stored.encryptedConfig, env);
    expect(decrypted.inbounds[0].chain).toMatchObject({
      source: { type: 'url', label: 'Pasted upstream' },
      snapshot: { protocol: 'vless', server: 'upstream.example.com', credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' } }
    });
    const template = await handleDeploymentsRequest(request(`/deployments/${deploymentId}/template`), env, `/deployments/${deploymentId}/template`);
    const templateBody = await template.json();
    expect(templateBody.data.config.inbounds[0].chain).toMatchObject({ retainedCredentials: true, snapshot: { protocol: 'vless', server: 'upstream.example.com' } });
    expect(JSON.stringify(templateBody)).not.toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');

    const cloneConfig = structuredClone(templateBody.data.config);
    cloneConfig.inbounds[0].id = 'clone-entry';
    cloneConfig.inbounds[0].credentials.uuid = 'b43e70bf-1002-44b3-9335-bca8f242b8f1';
    cloneConfig.inbounds[0].tls.realityPrivateKey = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    cloneConfig.inbounds[0].tls.realityPublicKey = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    cloneConfig.subscription.server.token = 'e1299db4-771c-4e02-a12c-28d65a9f343e';
    cloneConfig.subscription.server.pushToken = '';
    cloneConfig.subscription.server.pushGeneration = '';
    cloneConfig.subscription.server.traffic.apiSecret = '';
    const cloned = await handleDeploymentsRequest(request('/deployments', 'POST', {
      name: 'Chained entry clone',
      cloneFromDeploymentId: deploymentId,
      configRevision: 1,
      createCommand: false,
      config: cloneConfig,
      selectiveCloneOptions: {
        chainUpstream: true,
        inboundIndexes: [0],
        inboundMappings: [{ targetId: 'clone-entry', sourceIndex: 0 }]
      }
    }), env, '/deployments');
    const clonedBody = await cloned.json();
    expect({ status: cloned.status, body: clonedBody }).toMatchObject({ status: 201, body: { success: true } });
    const clonedStored = kv.dump('tsub_deployments_v2').find(item => item.id === clonedBody.data.deployment.id);
    const clonedConfig = await decryptDeploymentConfig(clonedStored.encryptedConfig, env);
    expect(clonedConfig.inbounds[0].chain.snapshot.credentials.uuid).toBe('79411d85-b0dc-4cd2-b46c-01789a18c650');
    expect(clonedConfig.inbounds[0].chain.source).toMatchObject({ type: 'url', label: 'Pasted upstream' });

    const injectedConfig = structuredClone(cloneConfig);
    injectedConfig.inbounds[0].id = 'injected-entry';
    injectedConfig.inbounds[0].chain = normalizeChainNodeUrl(vlessUrl.replace('upstream.example.com', 'injected.example.com'), { type: 'url' });
    const injected = await handleDeploymentsRequest(request('/deployments', 'POST', {
      name: 'Rejected clone injection',
      cloneFromDeploymentId: deploymentId,
      configRevision: 1,
      createCommand: false,
      config: injectedConfig,
      selectiveCloneOptions: { chainUpstream: false, inboundMappings: [{ targetId: 'injected-entry', sourceIndex: 0 }] }
    }), env, '/deployments');
    expect(injected.status).toBe(400);
    expect((await injected.json()).error).toMatch(/粘贴链式上游节点链接/);
  });

  it('rejects a client-supplied plaintext snapshot that did not come from a selected source', async () => {
    const env = {
      DEPLOYMENT_SECRET_KEY: 'test-deployment-secret-key-32-bytes',
      TSUB_KV: createKv({ worker_settings_v1: { storageType: 'kv' }, tsub_subscriptions_v1: [], tsub_profiles_v1: [] })
    };
    const supplied = normalizeChainNodeUrl(vlessUrl, { type: 'url', label: 'untrusted snapshot' });
    const response = await handleDeploymentsRequest(request('/deployments', 'POST', {
      name: 'Rejected snapshot',
      config: {
        schemaVersion: 2, inbounds: [inbound(supplied)], runtime: { core: 'auto', tier: 'auto', channel: 'stable' },
        subscription: { hostname: 'entry.example.com' }
      }
    }), env, '/deployments');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/粘贴链式上游节点链接/);
  });

  it('excludes the current deployment and deployments that already use a chain', async () => {
    const env = { DEPLOYMENT_SECRET_KEY: 'test-deployment-secret-key-32-bytes' };
    const directConfig = normalizeV2Config({ inbounds: [{ ...inbound(), outbound: 'direct', chain: undefined }], runtime: { core: 'auto' } });
    const chainedConfig = normalizeV2Config({ inbounds: [inbound(normalizeChainNodeUrl(vlessUrl, { type: 'url' }))], runtime: { core: 'auto' } });
    const deployments = [
      { id: 'direct-source', name: 'Direct source', schemaVersion: 2, encryptedConfig: await encryptDeploymentConfig(directConfig, env) },
      { id: 'chained-source', name: 'Chained source', schemaVersion: 2, encryptedConfig: await encryptDeploymentConfig(chainedConfig, env) }
    ];
    env.TSUB_KV = createKv({
      worker_settings_v1: { storageType: 'kv' }, tsub_deployments_v2: deployments, tsub_profiles_v1: [],
      tsub_subscriptions_v1: [
        { id: 'direct-node', name: 'Direct source node', url: vlessUrl, enabled: true, source: { kind: 'tsub-deployment', deploymentId: 'direct-source' } },
        { id: 'chained-node', name: 'Chained source node', url: vlessUrl.replace('upstream', 'nested'), enabled: true, source: { kind: 'tsub-deployment', deploymentId: 'chained-source' } }
      ]
    });
    const listed = await handleDeploymentsRequest(request('/deployments/chain-sources?source=deployment&deploymentId=current'), env, '/deployments/chain-sources');
    const data = (await listed.json()).data.items;
    expect(data.map(item => item.sourceId)).toEqual(['direct-source']);
    const groups = await handleDeploymentsRequest(request('/deployments/chain-sources?view=groups&source=deployment&deploymentId=current'), env, '/deployments/chain-sources');
    const groupBody = await groups.json();
    expect(groupBody.data.items).toEqual([expect.objectContaining({
      sourceType: 'deployment', sourceId: 'direct-source', name: 'Direct source', nodeCount: 1, protocols: ['vless']
    })]);
    expect(JSON.stringify(groupBody)).not.toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');
    const selectedNodes = await handleDeploymentsRequest(request('/deployments/chain-sources?view=nodes&source=deployment&sourceId=direct-source&deploymentId=current'), env, '/deployments/chain-sources');
    expect((await selectedNodes.json()).data.items).toEqual([expect.objectContaining({ sourceId: 'direct-source', address: 'upstream.example.com' })]);
    const missingSelection = await handleDeploymentsRequest(request('/deployments/chain-sources?view=nodes&source=deployment'), env, '/deployments/chain-sources');
    expect(missingSelection.status).toBe(400);
    expect((await missingSelection.json()).error).toMatch(/选择部署/);
    const currentExcluded = await handleDeploymentsRequest(request('/deployments/chain-sources?source=deployment&deploymentId=direct-source'), env, '/deployments/chain-sources');
    expect((await currentExcluded.json()).data.items).toEqual([]);
  });

  it('excludes deployment-generated subscriptions from ordinary subscription sources', async () => {
    const ordinary = { id: 'ordinary-sub', name: 'Provider', url: 'https://provider.example/sub', enabled: true };
    const generated = {
      id: 'generated-sub', name: 'Deployment subscription', url: 'https://controller.example/sub', enabled: true,
      source: { kind: 'tsub-deployment-subscription', deploymentId: 'deploy-1' }
    };
    const env = {
      DEPLOYMENT_SECRET_KEY: 'test-deployment-secret-key-32-bytes',
      TSUB_KV: createKv({
        worker_settings_v1: { storageType: 'kv' },
        tsub_subscriptions_v1: [ordinary, generated],
        tsub_profiles_v1: [],
        [buildSubscriptionNodeCacheKey(ordinary)]: { nodes: [vlessUrl] },
        [buildSubscriptionNodeCacheKey(generated)]: { nodes: [vlessUrl.replace('upstream', 'generated')] }
      })
    };
    const response = await handleDeploymentsRequest(request('/deployments/chain-sources?source=subscription'), env, '/deployments/chain-sources');
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ sourceType: 'subscription', sourceId: 'ordinary-sub', address: 'upstream.example.com' });
    const groups = await handleDeploymentsRequest(request('/deployments/chain-sources?view=groups&source=subscription'), env, '/deployments/chain-sources');
    expect((await groups.json()).data.items).toEqual([expect.objectContaining({
      sourceType: 'subscription', sourceId: 'ordinary-sub', name: 'Provider', nodeCount: 1, protocols: ['vless']
    })]);
    const selectedNodes = await handleDeploymentsRequest(request('/deployments/chain-sources?view=nodes&source=subscription&sourceId=ordinary-sub'), env, '/deployments/chain-sources');
    expect((await selectedNodes.json()).data.items).toEqual([expect.objectContaining({ sourceId: 'ordinary-sub', address: 'upstream.example.com' })]);
  });
});

// @vitest-environment node

import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  handleDeployAgentCommandConfig, handleDeployAgentCommandEvents, handleDeployAgentPoll,
  handleDeployBootstrap, handleDeployEvents, handleDeployPush, handleDeploymentsRequest
} from '../../functions/modules/deployment-handler.js';
import { SettingsCache } from '../../functions/storage-adapter.js';

const SCHEMA = `
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`;

function jsonRequest(path, method, body) {
  return new Request(`https://tsub.example/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function extractToken(command) {
  return command.match(/\| sh -s -- '([A-Za-z0-9_-]{43})'$/)?.[1]
    || command.match(/Bearer ([A-Za-z0-9_-]+)/)?.[1];
}

const V2_CONFIG = {
  schemaVersion: 2,
  inbounds: [{ protocol: 'vless', port: 443, transport: 'tcp', outbound: 'direct', credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' }, tls: { mode: 'reality', serverName: 'www.example.com', realityPrivateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', realityPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } }],
  runtime: { tier: 'auto', core: 'auto', channel: 'stable' },
  subscription: { hostname: 'd1.example', namePrefix: 'D1', server: { enabled: true, port: 51250, traffic: { enabled: true, quotaBytes: 0 } } }
};

describe('TSub deployment handler with D1', () => {
  it('synchronizes a VPS airport subscription and profile references through Miniflare D1', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['TSUB_DB']
    });

    try {
      const database = await miniflare.getD1Database('TSUB_DB');
      await database.exec(SCHEMA);
      await database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .bind('worker_settings_v1', JSON.stringify({ storageType: 'd1' })).run();
      await database.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)')
        .bind('profile-d1', JSON.stringify({ id: 'profile-d1', name: 'D1', subscriptions: [], manualNodes: [] })).run();
      SettingsCache.clear();
      const env = {
        DEPLOYMENT_SECRET_KEY: 'd1-test-deployment-secret-key-32',
        TSUB_XRAY_VERSION: 'test',
        TSUB_XRAY_AMD64_URL: 'https://example.com/xray-amd64',
        TSUB_XRAY_AMD64_SHA256: 'a'.repeat(64),
        TSUB_XRAY_ARM64_URL: 'https://example.com/xray-arm64',
        TSUB_XRAY_ARM64_SHA256: 'b'.repeat(64),
        TSUB_SINGBOX_VERSION: 'test',
        TSUB_SINGBOX_AMD64_URL: 'https://example.com/singbox-amd64',
        TSUB_SINGBOX_AMD64_SHA256: 'e'.repeat(64),
        TSUB_SINGBOX_ARM64_URL: 'https://example.com/singbox-arm64',
        TSUB_SINGBOX_ARM64_SHA256: 'f'.repeat(64),
        TSUB_BUSYBOX_VERSION: 'test',
        TSUB_BUSYBOX_AMD64_URL: 'https://example.com/busybox-amd64',
        TSUB_BUSYBOX_AMD64_SHA256: 'c'.repeat(64),
        TSUB_BUSYBOX_ARM64_URL: 'https://example.com/busybox-arm64',
        TSUB_BUSYBOX_ARM64_SHA256: 'd'.repeat(64),
        TSUB_DB: database,
        TSUB_KV: {
          async get(key) {
            return key === 'worker_settings_v1' ? JSON.stringify({ storageType: 'd1' }) : null;
          },
          async put() {},
          async delete() {}
        }
      };

      const created = await handleDeploymentsRequest(jsonRequest('/deployments', 'POST', {
        name: 'D1 VPS', profileId: 'profile-d1', config: V2_CONFIG
      }), env, '/deployments');
      const createdBody = await created.json();
      const token = extractToken(createdBody.data.command);
      const script = await (await handleDeployBootstrap(new Request('https://tsub.example/api/deploy/bootstrap', {
        headers: { Authorization: `Bearer ${token}` }
      }), env)).text();
      const encodedCallbackToken = script.match(/^callback_token_b64=([A-Za-z0-9+/=]+)$/m)?.[1];
      const callbackToken = encodedCallbackToken ? atob(encodedCallbackToken) : '';
      const callback = await handleDeployEvents(new Request('https://tsub.example/api/deploy/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${callbackToken}`, 'Content-Type': 'text/plain' },
        body: 'status=succeeded\nstage=apply\nsubscriptionReady=true\nsubscriptionNodeCount=1'
      }), env);

      expect(callback.status).toBe(200);
      const pushTokenEncoded = script.match(/^push_token_b64=([A-Za-z0-9+/=]+)$/m)?.[1];
      const pushGeneration = script.match(/^push_generation=(.+)$/m)?.[1];
      await database.prepare('INSERT INTO settings (key, value) VALUES (?, ?), (?, ?)')
        .bind('node_cache_profile_profile-d1', JSON.stringify({ nodes: 'stale-profile' }), 'node_cache_token_auto', JSON.stringify({ nodes: 'stale-main' })).run();
      const pushBody = sequence => `pushGeneration=${pushGeneration}\nsequence=${sequence}\nupload=1\ndownload=2\ntrafficBackend=core-singbox\nserverAddress=d1.example\nsubscriptionPort=51250\nsubscriptionReady=true\nsubscriptionNodeCount=1\nnode=vless://uuid@d1.example:443#D1`;
      const sendPush = body => handleDeployPush(new Request(`https://tsub.example/api/deploy/push/${createdBody.data.deployment.id}`, {
        method: 'POST', headers: { Authorization: `Bearer ${atob(pushTokenEncoded)}` }, body
      }), env, createdBody.data.deployment.id);
      const push = await sendPush(pushBody(1));
      expect(push.status).toBe(200);
      expect(await database.prepare('SELECT value FROM settings WHERE key = ?').bind('node_cache_profile_profile-d1').first()).toBeNull();
      expect(await database.prepare('SELECT value FROM settings WHERE key = ?').bind('node_cache_token_auto').first()).toBeNull();
      const nodeRows = await database.prepare('SELECT data FROM subscriptions').all();
      const nodes = nodeRows.results.map(row => JSON.parse(row.data));
      expect(nodes).toHaveLength(1);
      expect(nodes[0].source).toMatchObject({ kind: 'tsub-deployment-push', deploymentId: createdBody.data.deployment.id });
      expect(nodes[0]).toMatchObject({ pushCount: 1, pushHistory: [expect.stringMatching(/^\d{4}-/)] });
      expect(nodes[0].url).toMatch(new RegExp(`^https://tsub\\.example/api/deploy/subscriptions/${createdBody.data.deployment.id}/`));
      expect(await database.prepare('SELECT sequence FROM deployment_snapshots WHERE deployment_id = ?').bind(createdBody.data.deployment.id).first()).toMatchObject({ sequence: 1 });
      expect(JSON.parse((await database.prepare('SELECT data FROM deployments WHERE id = ?').bind(createdBody.data.deployment.id).first()).data)).toMatchObject({ nodeCount: 1, pushCount: 1 });
      expect((await sendPush(pushBody(1))).status).toBe(200);
      expect((await sendPush(`${pushBody(1)}\ndegradedReason=changed`)).status).toBe(409);
      expect((await sendPush(pushBody(3))).status).toBe(200);
      const stalePush = await sendPush(pushBody(2));
      expect(stalePush.status).toBe(409);
      expect(await stalePush.json()).toMatchObject({ code: 'STALE_PUSH_SEQUENCE', data: { expectedSequence: 4 } });
      const profileRow = await database.prepare('SELECT data FROM profiles WHERE id = ?').bind('profile-d1').first();
      expect(JSON.parse(profileRow.data)).toMatchObject({ manualNodes: [], subscriptions: [nodes[0].id] });

      const agentTokenEncoded = script.match(/^agent_token_b64=([A-Za-z0-9+/=]+)$/m)?.[1];
      const agentToken = agentTokenEncoded ? atob(agentTokenEncoded) : '';
      const agentRequest = (path, options = {}) => new Request(`https://tsub.example/api/deploy/agent/${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${agentToken}`, ...(options.headers || {}) }
      });
      expect((await handleDeployAgentPoll(agentRequest('poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtimeVersion: '2.3.8', hostname: 'd1-server' })
      }), env)).status).toBe(200);
      const templateResponse = await handleDeploymentsRequest(
        new Request(`https://tsub.example/api/deployments/${createdBody.data.deployment.id}/template`),
        env,
        `/deployments/${createdBody.data.deployment.id}/template`
      );
      const template = (await templateResponse.json()).data;
      const remoteConfig = structuredClone(template.config);
      remoteConfig.subscription.hostname = '';
      remoteConfig.subscription.addressMode = 'auto';
      remoteConfig.inbounds[0].port = 8443;
      remoteConfig.inbounds[0].transport = 'ws';
      remoteConfig.inbounds[0].transportOptions = { path: '/probe' };
      remoteConfig.inbounds[0].tls = { mode: 'tls', serverName: 'cdn.example.com' };
      remoteConfig.inbounds[0].edgeMode = 'append';
      remoteConfig.edge = {
        mode: 'manual', hostname: 'cdn.example.com', quickInboundId: '',
        endpoints: [{ id: 'preferred-ip', label: 'Preferred', address: '203.0.113.8', port: 8443 }],
        cloudflare: { accountId: '', zoneId: '', zoneName: '', sslMode: '', apiToken: '' }
      };
      const addressAwareDeployment = JSON.parse((await database.prepare('SELECT data FROM deployments WHERE id = ?').bind(createdBody.data.deployment.id).first()).data);
      addressAwareDeployment.resolvedAddresses = { ipv4: '203.0.113.10' };
      await database.prepare('UPDATE deployments SET data = ? WHERE id = ?').bind(JSON.stringify(addressAwareDeployment), createdBody.data.deployment.id).run();
      remoteConfig.inbounds.push({
        id: 'trojan-remote', name: 'D1-Trojan', protocol: 'trojan', port: 2087, transport: 'tcp', outbound: 'direct',
        credentials: { password: 'remote-test-password' }, tls: { mode: 'tls', serverName: 'd1.example' }, transportOptions: {}
      });
      const bootstrapTokensBefore = (await database.prepare(`SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'tsub_bootstrap_token_v2:%'`).first()).count;
      const remoteResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/commands`, 'POST', {
        action: 'update', delivery: 'agent', name: 'D1 Remote Updated', nodeGroup: 'D1', profileId: 'profile-d1',
        configRevision: template.configRevision, config: remoteConfig
      }), env, `/deployments/${createdBody.data.deployment.id}/commands`);
      const remoteBody = await remoteResponse.json();
      expect(remoteResponse.status).toBe(202);
      expect(remoteBody.data).not.toHaveProperty('command.command');
      expect((await database.prepare(`SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'tsub_bootstrap_token_v2:%'`).first()).count).toBe(bootstrapTokensBefore);
      const storedRemote = JSON.parse((await database.prepare('SELECT data FROM deployments WHERE id = ?').bind(createdBody.data.deployment.id).first()).data);
      expect(storedRemote).toMatchObject({
        name: 'D1 Remote Updated', configRevision: template.configRevision + 1, status: 'pending', pendingReason: 'config',
        pendingOperationId: remoteBody.data.operation.id, configUpdatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      });
      expect(storedRemote.configSummary.protocols.map(item => item.protocol)).toEqual(['vless', 'trojan']);

      const claimedResponse = await handleDeployAgentPoll(agentRequest('poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }), env);
      const claimed = (await claimedResponse.json()).data.command;
      expect(claimed).toMatchObject({ id: remoteBody.data.command.id, action: 'update' });
      const commandConfig = await handleDeployAgentCommandConfig(agentRequest(`commands/${claimed.id}/config`, {
        headers: { 'X-TSub-Lease': claimed.leaseId }
      }), env, claimed.id);
      const compiled = await commandConfig.text();
      const remoteNodes = atob(compiled.match(/^nodes_b64=([^\r\n]*)$/m)?.[1] || '');
      expect(remoteNodes).toContain('@203.0.113.10:');
      expect(remoteNodes).toContain('trojan://');
      const eventResponse = await handleDeployAgentCommandEvents(agentRequest(`commands/${claimed.id}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TSub-Lease': claimed.leaseId },
        body: JSON.stringify({ status: 'succeeded', stage: 'update', message: 'configuration applied' })
      }), env, claimed.id);
      expect(eventResponse.status).toBe(200);
      const applied = JSON.parse((await database.prepare('SELECT data FROM deployments WHERE id = ?').bind(createdBody.data.deployment.id).first()).data);
      expect(applied).toMatchObject({ status: 'succeeded', configRevision: template.configRevision + 1 });
      expect(applied).not.toHaveProperty('pendingReason');
      expect(applied).not.toHaveProperty('pendingOperationId');

      const probeResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/edge-probes`, 'POST', {
        inboundId: remoteConfig.inbounds[0].id, endpointId: 'preferred-ip', configRevision: applied.configRevision, runner: 'auto'
      }), env, `/deployments/${createdBody.data.deployment.id}/edge-probes`);
      const probeBody = await probeResponse.json();
      expect(probeResponse.status).toBe(202);
      expect(probeBody.data).toMatchObject({ runner: 'agent', operation: { action: 'edge-probe', status: 'pending' } });
      const probeClaim = await handleDeployAgentPoll(agentRequest('poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }), env);
      const probeCommand = (await probeClaim.json()).data.command;
      expect(probeCommand).toMatchObject({ action: 'edge-probe' });
      const probeConfigResponse = await handleDeployAgentCommandConfig(agentRequest(`commands/${probeCommand.id}/config`, {
        headers: { 'X-TSub-Lease': probeCommand.leaseId }
      }), env, probeCommand.id);
      const probeConfig = await probeConfigResponse.text();
      expect(probeConfig).toContain('edge_probe_hostname=cdn.example.com');
      expect(atob(probeConfig.match(/^edge_probe_address_b64=(.+)$/m)[1])).toBe('203.0.113.8');
      expect(atob(probeConfig.match(/^edge_probe_path_b64=(.+)$/m)[1])).toBe('/probe');
      await handleDeployAgentCommandEvents(agentRequest(`commands/${probeCommand.id}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TSub-Lease': probeCommand.leaseId },
        body: JSON.stringify({ status: 'succeeded', stage: 'edge-probe', message: 'edge probe passed', resources: {
          edgeProbe: { ok: true, checks: { dns: true, tcp: true, tls: true, hostSni: true, websocket101: true }, latencyMs: 31 }
        } })
      }), env, probeCommand.id);
      expect(JSON.parse((await database.prepare('SELECT data FROM deployment_operations WHERE id = ?').bind(probeBody.data.operation.id).first()).data))
        .toMatchObject({ status: 'succeeded' });
      expect(JSON.parse((await database.prepare('SELECT data FROM deployment_events WHERE operation_id = ? ORDER BY created_at DESC LIMIT 1').bind(probeBody.data.operation.id).first()).data))
        .toMatchObject({ resources: { edgeProbe: expect.objectContaining({ ok: true }) } });

      const forgedProbe = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/edge-probes`, 'POST', {
        inboundId: remoteConfig.inbounds[0].id, endpointId: 'attacker-target', configRevision: applied.configRevision
      }), env, `/deployments/${createdBody.data.deployment.id}/edge-probes`);
      expect(forgedProbe.status).toBe(409);
      expect(await forgedProbe.json()).toMatchObject({ error: 'edge_probe_endpoint_unavailable' });
      const staleProbe = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/edge-probes`, 'POST', {
        inboundId: remoteConfig.inbounds[0].id, endpointId: 'preferred-ip', configRevision: applied.configRevision - 1
      }), env, `/deployments/${createdBody.data.deployment.id}/edge-probes`);
      expect(staleProbe.status).toBe(409);
      expect(await staleProbe.json()).toMatchObject({ error: 'REVISION_CONFLICT' });
      const genericProbe = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/commands`, 'POST', {
        action: 'edge-probe', delivery: 'agent'
      }), env, `/deployments/${createdBody.data.deployment.id}/commands`);
      expect(genericProbe.status).toBe(400);

      const updateOperationsBefore = (await database.prepare(`SELECT COUNT(*) AS count FROM deployment_operations WHERE deployment_id = ? AND action = 'update'`).bind(createdBody.data.deployment.id).first()).count;
      const staleResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/commands`, 'POST', {
        action: 'update', delivery: 'agent', name: 'Stale Update', configRevision: template.configRevision, config: remoteConfig
      }), env, `/deployments/${createdBody.data.deployment.id}/commands`);
      expect(staleResponse.status).toBe(409);
      expect(await staleResponse.json()).toMatchObject({ error: 'REVISION_CONFLICT' });
      expect((await database.prepare(`SELECT COUNT(*) AS count FROM deployment_operations WHERE deployment_id = ? AND action = 'update'`).bind(createdBody.data.deployment.id).first()).count).toBe(updateOperationsBefore);

      await database.prepare('UPDATE deployment_heartbeats SET last_seen_at = ? WHERE deployment_id = ?')
        .bind(new Date(Date.now() - 10 * 60_000).toISOString(), createdBody.data.deployment.id).run();
      const offlineResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/commands`, 'POST', {
        action: 'update', delivery: 'agent', name: 'Offline Update', configRevision: applied.configRevision, config: remoteConfig
      }), env, `/deployments/${createdBody.data.deployment.id}/commands`);
      expect(offlineResponse.status).toBe(409);
      expect(await offlineResponse.json()).toMatchObject({ error: 'agent_offline' });
      expect(JSON.parse((await database.prepare('SELECT data FROM deployments WHERE id = ?').bind(createdBody.data.deployment.id).first()).data).name).toBe('D1 Remote Updated');

      await database.prepare('UPDATE deployment_heartbeats SET last_seen_at = ? WHERE deployment_id = ?')
        .bind(new Date().toISOString(), createdBody.data.deployment.id).run();
      const blockingResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/commands`, 'POST', {
        action: 'status', delivery: 'agent'
      }), env, `/deployments/${createdBody.data.deployment.id}/commands`);
      expect(blockingResponse.status).toBe(202);
      const blockedResponse = await handleDeploymentsRequest(jsonRequest(`/deployments/${createdBody.data.deployment.id}/commands`, 'POST', {
        action: 'update', delivery: 'agent', name: 'Blocked Update', configRevision: applied.configRevision, config: remoteConfig
      }), env, `/deployments/${createdBody.data.deployment.id}/commands`);
      expect(blockedResponse.status).toBe(409);
      expect(await blockedResponse.json()).toMatchObject({ error: 'command_active' });
      expect(JSON.parse((await database.prepare('SELECT data FROM deployments WHERE id = ?').bind(createdBody.data.deployment.id).first()).data).name).toBe('D1 Remote Updated');
    } finally {
      SettingsCache.clear();
      await miniflare.dispose();
    }
  }, 30_000);
});

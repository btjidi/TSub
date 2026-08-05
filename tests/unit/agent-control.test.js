// @vitest-environment node

import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureD1Schema, SettingsCache, StorageFactory } from '../../functions/storage-adapter.js';
import { createDeploymentRepository } from '../../functions/services/deployment-repository.js';
import { cleanupAgentControl, ensureDeploymentAgent, listAgentState, pollAgent, queueAgentCommand, reportAgentCommand } from '../../functions/services/agent-control-service.js';

describe('deployment agent control plane', { timeout: 15_000 }, () => {
  let miniflare; let database; let env; let storage; let repository;

  beforeEach(async () => {
    miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['TSUB_DB'] });
    database = await miniflare.getD1Database('TSUB_DB');
    await ensureD1Schema(database);
    await database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('main', JSON.stringify({ storageType: 'd1' })).run();
    await database.prepare(`INSERT INTO storage_control (id, active_storage, state, epoch, data) VALUES ('main','d1','idle',1,'{}')`).run();
    env = { TSUB_DB: database, TSUB_MIGRATION_DRAIN_MS: 0 };
    SettingsCache.clear();
    storage = StorageFactory.createAdapter(env, 'd1');
    repository = createDeploymentRepository(storage);
    await repository.putDeployment({
      id: 'deploy-agent', name: 'Agent', status: 'succeeded', configRevision: 1, nodeCount: 0, lastError: 'old failure',
      configSummary: { protocols: [{ protocol: 'vless' }, { protocol: 'vmess' }], addressMode: 'dual' },
      createdAt: new Date().toISOString()
    });
  });

  afterEach(async () => { SettingsCache.clear(); await miniflare.dispose(); });

  it('activates an agent, records heartbeats, and leases one command exactly once', async () => {
    const provisioned = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    expect(provisioned.token).toHaveLength(43);
    const request = () => new Request('https://example.com/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}` }
    });
    const first = await pollAgent(request(), env, storage, { runtimeVersion: '2.4.1', hostname: 'server' });
    expect(first.command).toBeNull();
    expect(first.nextPollSeconds).toBe(30);
    expect(await listAgentState(storage, 'deploy-agent')).toMatchObject({ available: true, online: true });

    const operation = { id: 'op-agent', deploymentId: 'deploy-agent', action: 'repair', status: 'pending', events: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await repository.putOperation(operation);
    const command = await queueAgentCommand(storage, { id: 'deploy-agent' }, operation);
    const claimed = await pollAgent(request(), env, storage, { hostname: 'server' });
    expect(claimed.command).toMatchObject({ id: command.id, action: 'repair' });
    const second = await pollAgent(request(), env, storage, { hostname: 'server' });
    expect(second.command).toBeNull();

    const eventRequest = new Request('https://example.com/events', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}`, 'X-TSub-Lease': claimed.command.leaseId }
    });
    const reported = await reportAgentCommand(eventRequest, env, storage, command.id, { status: 'succeeded', stage: 'repair', message: 'done', resources: { nodeCount: 7 } });
    expect(reported.status).toBe('succeeded');
    expect(await repository.getOperation('op-agent')).toMatchObject({ status: 'succeeded', hostname: 'server', message: 'done', events: [expect.objectContaining({ message: 'done' })] });
    expect(await repository.getDeployment('deploy-agent')).toMatchObject({ status: 'succeeded', nodeCount: 7, lastError: '' });
  });

  it('renews a running command lease without adding duplicate operation events', async () => {
    const provisioned = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    const request = lease => new Request('https://example.com/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}`, ...(lease ? { 'X-TSub-Lease': lease } : {}) }
    });
    await pollAgent(request(), env, storage, { hostname: 'lease-host' });
    const operation = { id: 'op-renew', deploymentId: 'deploy-agent', action: 'repair', status: 'pending', events: [], createdAt: new Date().toISOString() };
    await repository.putOperation(operation);
    const command = await queueAgentCommand(storage, { id: 'deploy-agent' }, operation);
    const claimed = await pollAgent(request(), env, storage, { hostname: 'lease-host' });
    await reportAgentCommand(request(claimed.command.leaseId), env, storage, command.id, {
      status: 'running', stage: 'repair', message: 'command started'
    });
    const shortened = new Date(Date.now() + 10_000).toISOString();
    await database.prepare('UPDATE deployment_commands SET lease_expires_at = ? WHERE id = ?').bind(shortened, command.id).run();

    const renewed = await reportAgentCommand(request(claimed.command.leaseId), env, storage, command.id, {
      status: 'running', stage: 'repair', leaseRenewal: true
    });

    expect(Date.parse(renewed.leaseExpiresAt)).toBeGreaterThan(Date.parse(shortened));
    expect((await repository.getOperation(operation.id)).events).toHaveLength(1);
  });

  it('fails an abandoned running command after its lease expires', async () => {
    const provisioned = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    const request = lease => new Request('https://example.com/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}`, ...(lease ? { 'X-TSub-Lease': lease } : {}) }
    });
    await pollAgent(request(), env, storage, { hostname: 'abandoned-host' });
    const operation = { id: 'op-abandoned', deploymentId: 'deploy-agent', action: 'repair', status: 'pending', events: [], createdAt: new Date().toISOString() };
    await repository.putOperation(operation);
    const command = await queueAgentCommand(storage, { id: 'deploy-agent' }, operation);
    const claimed = await pollAgent(request(), env, storage, { hostname: 'abandoned-host' });
    await reportAgentCommand(request(claimed.command.leaseId), env, storage, command.id, {
      status: 'running', stage: 'repair', message: 'command started'
    });
    await database.prepare('UPDATE deployment_commands SET lease_expires_at = ?, expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() - 500).toISOString(), command.id).run();

    const next = await pollAgent(request(), env, storage, { hostname: 'abandoned-host' });

    expect(next.command).toBeNull();
    expect(await database.prepare('SELECT status FROM deployment_commands WHERE id = ?').bind(command.id).first()).toMatchObject({ status: 'failed' });
    expect(await repository.getOperation(operation.id)).toMatchObject({
      status: 'failed', hostname: 'abandoned-host', message: 'Agent command lease expired before completion',
      events: [expect.objectContaining({ status: 'running' }), expect.objectContaining({ status: 'failed' })]
    });
    expect(await repository.getDeployment('deploy-agent')).toMatchObject({ status: 'failed', lastError: 'Agent command lease expired before completion' });
  }, 15_000);

  it('uses the configured polling interval and widens the online window', async () => {
    const provisioned = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    const request = () => new Request('https://example.com/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}` }
    });
    const slow = await pollAgent(request(), env, storage, { pollIntervalSeconds: 300 });
    expect(slow.nextPollSeconds).toBe(300);
    expect(await listAgentState(storage, 'deploy-agent')).toMatchObject({ online: true, heartbeat: { pollIntervalSeconds: 300 } });

    await database.prepare('UPDATE deployment_heartbeats SET last_seen_at = ? WHERE deployment_id = ?')
      .bind(new Date(Date.now() - 5 * 60_000).toISOString(), 'deploy-agent').run();
    expect(await listAgentState(storage, 'deploy-agent')).toMatchObject({ online: true });
    await database.prepare('UPDATE deployment_heartbeats SET last_seen_at = ? WHERE deployment_id = ?')
      .bind(new Date(Date.now() - 16 * 60_000).toISOString(), 'deploy-agent').run();
    expect(await listAgentState(storage, 'deploy-agent')).toMatchObject({ online: false });

    await database.prepare('DELETE FROM deployment_heartbeats WHERE deployment_id = ?').bind('deploy-agent').run();
    expect((await pollAgent(request(), env, storage, { pollIntervalSeconds: 999 })).nextPollSeconds).toBe(30);
  });

  it('persists changed heartbeat metadata immediately inside the write throttle window', async () => {
    const provisioned = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    const request = () => new Request('https://example.com/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}` }
    });
    await pollAgent(request(), env, storage, {
      runtimeVersion: '2.3.11', core: 'xray', coreVersion: '26.7.28', configRevision: 3, pollIntervalSeconds: 15
    });
    const first = await database.prepare('SELECT last_seen_at FROM deployment_heartbeats WHERE deployment_id = ?').bind('deploy-agent').first();
    await new Promise(resolve => setTimeout(resolve, 5));
    await pollAgent(request(), env, storage, {
      runtimeVersion: '2.3.11', core: 'sing-box', coreVersion: '1.13.15', coreIdentity: 'sing-box-1.13.15-amd64-sha256',
      osId: 'debian', osVersion: '13\n', osPrettyName: 'Debian GNU/Linux 13 (trixie)\u0000', configRevision: 4, pollIntervalSeconds: 300,
      cgroupLimitMb: 976, memoryAvailableMb: 901, rssMb: 88, coreRssMb: 43, cloudflaredRssMb: 45,
      swapReported: true, swapTotalMb: 512, swapFreeMb: 384, swapUsedMb: 128,
      cgroupSwapReported: true, cgroupSwapCurrentMb: 32, cgroupSwapLimitMb: 256,
      estimatedCoreRssMb: 44, estimatedCloudflaredRssMb: 45
    });
    const state = await listAgentState(storage, 'deploy-agent');
    expect(state.lastSeenAt).not.toBe(first.last_seen_at);
    expect(state.heartbeat).toEqual(expect.objectContaining({
      runtimeVersion: '2.3.11', core: 'sing-box', coreVersion: '1.13.15', coreIdentity: 'sing-box-1.13.15-amd64-sha256',
      osId: 'debian', osVersion: '13', osPrettyName: 'Debian GNU/Linux 13 (trixie)', configRevision: 4, pollIntervalSeconds: 300,
      cgroupLimitMb: 976, memoryAvailableMb: 901, rssMb: 88, coreRssMb: 43, cloudflaredRssMb: 45,
      swapReported: true, swapTotalMb: 512, swapFreeMb: 384, swapUsedMb: 128,
      cgroupSwapReported: true, cgroupSwapCurrentMb: 32, cgroupSwapLimitMb: 256,
      estimatedCoreRssMb: 44, estimatedCloudflaredRssMb: 45
    }));
  });

  it('reissues an unactivated token without leaving an unusable credential', async () => {
    const first = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    const second = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    expect(second.token).not.toBe(first.token);
    const rejected = await pollAgent(new Request('https://example.com/poll', { method: 'POST', headers: { Authorization: `Bearer ${first.token}` } }), env, storage, {});
    expect(rejected.error?.code).toBe('unauthorized');
    const accepted = await pollAgent(new Request('https://example.com/poll', { method: 'POST', headers: { Authorization: `Bearer ${second.token}` } }), env, storage, {});
    expect(accepted.deploymentId).toBe('deploy-agent');
  });

  it('revokes the old agent only after a controller transfer succeeds', async () => {
    const provisioned = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    const agentRequest = lease => new Request('https://old.example/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}`, ...(lease ? { 'X-TSub-Lease': lease } : {}) }
    });
    await pollAgent(agentRequest(), env, storage, {});
    const operation = { id: 'op-transfer', deploymentId: 'deploy-agent', action: 'transfer-controller', status: 'pending', events: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await repository.putOperation(operation);
    const command = await queueAgentCommand(storage, { id: 'deploy-agent' }, operation, { encryptedTransfer: 'encrypted' });
    const claimed = await pollAgent(agentRequest(), env, storage, {});
    const result = await reportAgentCommand(agentRequest(claimed.command.leaseId), env, storage, command.id, { status: 'succeeded', stage: 'transfer-controller' });
    expect(result.status).toBe('succeeded');
    expect((await pollAgent(agentRequest(), env, storage, {})).error?.code).toBe('unauthorized');
  });

  it('revokes a remote agent after uninstall succeeds so bootstrap can provision a replacement', async () => {
    const provisioned = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    const agentRequest = lease => new Request('https://example.com/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}`, ...(lease ? { 'X-TSub-Lease': lease } : {}) }
    });
    await pollAgent(agentRequest(), env, storage, {});
    const operation = { id: 'op-uninstall', deploymentId: 'deploy-agent', action: 'uninstall', status: 'pending', events: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await repository.putOperation(operation);
    const command = await queueAgentCommand(storage, { id: 'deploy-agent' }, operation);
    const claimed = await pollAgent(agentRequest(), env, storage, {});

    await reportAgentCommand(agentRequest(claimed.command.leaseId), env, storage, command.id, { status: 'succeeded', stage: 'uninstall' });

    expect(await repository.getDeployment('deploy-agent')).toMatchObject({ status: 'offline' });
    expect((await pollAgent(agentRequest(), env, storage, {})).error?.code).toBe('unauthorized');
    const replacement = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    expect(replacement.token).toHaveLength(43);
  });

  it('keeps the local executor credential after uninstall succeeds', async () => {
    const deployment = await repository.getDeployment('deploy-agent');
    deployment.controlTransport = 'local-executor';
    await repository.putDeployment(deployment);
    const provisioned = await ensureDeploymentAgent(storage, deployment);
    const agentRequest = lease => new Request('https://example.com/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}`, ...(lease ? { 'X-TSub-Lease': lease } : {}) }
    });
    await pollAgent(agentRequest(), env, storage, {});
    const operation = { id: 'op-local-uninstall', deploymentId: 'deploy-agent', action: 'uninstall', status: 'pending', events: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await repository.putOperation(operation);
    const command = await queueAgentCommand(storage, deployment, operation);
    const claimed = await pollAgent(agentRequest(), env, storage, {});

    await reportAgentCommand(agentRequest(claimed.command.leaseId), env, storage, command.id, { status: 'succeeded', stage: 'uninstall' });

    expect(await repository.getDeployment('deploy-agent')).toMatchObject({ status: 'offline' });
    expect((await pollAgent(agentRequest(), env, storage, {})).deploymentId).toBe('deploy-agent');
  });

  it('expires ISO timestamp commands on time and removes old terminal records', async () => {
    const provisioned = await ensureDeploymentAgent(storage, { id: 'deploy-agent' });
    await pollAgent(new Request('https://example.com/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${provisioned.token}` }
    }), env, storage, {});
    const oldOperation = { id: 'op-old', deploymentId: 'deploy-agent', action: 'repair', status: 'pending', events: [], createdAt: new Date().toISOString() };
    await repository.putOperation(oldOperation);
    await database.prepare(`INSERT INTO deployment_commands
      (id, deployment_id, operation_id, action, status, expires_at, data, created_at, updated_at)
      VALUES (?, ?, ?, 'repair', 'pending', ?, '{}', ?, ?)`)
      .bind('cmd-old', 'deploy-agent', oldOperation.id, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()).run();
    await database.prepare(`INSERT INTO deployment_commands
      (id, deployment_id, operation_id, action, status, expires_at, data, created_at, updated_at)
      VALUES (?, ?, ?, 'repair', 'failed', ?, '{}', ?, ?)`)
      .bind('cmd-terminal', 'deploy-agent', oldOperation.id, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()).run();
    const operation = { id: 'op-new', deploymentId: 'deploy-agent', action: 'status', status: 'pending', events: [], createdAt: new Date().toISOString() };
    await repository.putOperation(operation);
    await expect(queueAgentCommand(storage, { id: 'deploy-agent' }, operation)).resolves.toMatchObject({ action: 'status' });
    await cleanupAgentControl(storage, new Date());
    expect(await database.prepare('SELECT status FROM deployment_commands WHERE id = ?').bind('cmd-old').first()).toMatchObject({ status: 'expired' });
    expect(await database.prepare('SELECT id FROM deployment_commands WHERE id = ?').bind('cmd-terminal').first()).toBeNull();
  });
});

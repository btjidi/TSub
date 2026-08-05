// @vitest-environment node

import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureD1Schema, SettingsCache, StorageFactory } from '../../functions/storage-adapter.js';
import { createDeploymentRepository } from '../../functions/services/deployment-repository.js';
import { claimControllerTransfer, createControllerTransferClaim, validateTransferTarget } from '../../functions/services/controller-transfer-service.js';
import { pollAgent } from '../../functions/services/agent-control-service.js';

describe('controller ownership transfer', () => {
  let miniflare; let database; let env; let storage;

  beforeEach(async () => {
    miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['TSUB_DB'] });
    database = await miniflare.getD1Database('TSUB_DB');
    await ensureD1Schema(database);
    await database.prepare(`INSERT INTO storage_control (id, active_storage, state, epoch, data) VALUES ('main','d1','idle',1,'{}')`).run();
    env = { TSUB_DB: database };
    storage = StorageFactory.createAdapter(env, 'd1');
    await createDeploymentRepository(storage).putDeployment({ id: 'deploy-transfer', schemaVersion: 2, status: 'succeeded', configRevision: 1 });
  });

  afterEach(async () => { SettingsCache.clear(); await miniflare.dispose(); });

  it('issues a one-time claim and activates only the newly returned agent token', async () => {
    const claim = await createControllerTransferClaim(env, storage, 'deploy-transfer');
    expect(claim.token).toHaveLength(43);
    const request = () => new Request('https://target.example/api/deploy/agent/transfer/claim', {
      method: 'POST', headers: { Authorization: `Bearer ${claim.token}` }
    });
    const accepted = await claimControllerTransfer(request(), env, storage);
    expect(accepted.controllerUrl).toBe('https://target.example/api/deploy/agent');
    expect(accepted.config).not.toContain(claim.token);
    const replay = await claimControllerTransfer(request(), env, storage);
    expect(replay.error).toMatchObject({ status: 404, code: 'transfer_not_found' });
    const poll = await pollAgent(new Request('https://target.example/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${accepted.token}` }
    }), env, storage, {});
    expect(poll.deploymentId).toBe('deploy-transfer');
  });

  it('accepts only clean HTTPS controller origins', () => {
    expect(validateTransferTarget('https://controller.example/path')).toBe('https://controller.example');
    expect(() => validateTransferTarget('http://controller.example')).toThrow(/HTTPS/);
    expect(() => validateTransferTarget('https://user:pass@controller.example')).toThrow(/HTTPS/);
  });

  it('rejects an expired ISO timestamp claim within the same day', async () => {
    const claim = await createControllerTransferClaim(env, storage, 'deploy-transfer');
    await database.prepare('UPDATE controller_transfers SET expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), claim.id).run();
    const result = await claimControllerTransfer(new Request('https://target.example/api/deploy/agent/transfer/claim', {
      method: 'POST', headers: { Authorization: `Bearer ${claim.token}` }
    }), env, storage);
    expect(result.error).toMatchObject({ status: 404, code: 'transfer_not_found' });
  });
});

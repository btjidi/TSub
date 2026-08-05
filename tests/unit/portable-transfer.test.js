// @vitest-environment node

import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsCache, StorageFactory } from '../../functions/storage-adapter.js';
import { createDeploymentRepository } from '../../functions/services/deployment-repository.js';
import { decryptDeploymentConfig, encryptDeploymentConfig } from '../../functions/modules/deployment-crypto.js';
import { exportPortablePackage, importPortablePackage } from '../../functions/services/portable-transfer.js';

describe('portable controller transfer package', () => {
  let miniflare;
  afterEach(async () => { SettingsCache.clear(); await miniflare?.dispose(); });

  it('re-encrypts deployment and settings secrets under the target keys', async () => {
    miniflare = new Miniflare({
      modules: true, script: 'export default { fetch() { return new Response("ok"); } }',
      kvNamespaces: ['SOURCE', 'TARGET']
    });
    const sourceKv = await miniflare.getKVNamespace('SOURCE');
    const targetKv = await miniflare.getKVNamespace('TARGET');
    const sourceEnv = {
      TSUB_KV: sourceKv,
      DEPLOYMENT_SECRET_KEY: 'source-deployment-secret-key-32',
      SETTINGS_SECRET_KEY: 'source-settings-secret-key-32'
    };
    const targetEnv = {
      TSUB_KV: targetKv,
      DEPLOYMENT_SECRET_KEY: 'target-deployment-secret-key-32',
      SETTINGS_SECRET_KEY: 'target-settings-secret-key-32'
    };
    const sourceStorage = StorageFactory.createAdapter(sourceEnv, 'kv');
    await sourceStorage.put('worker_settings_v1', {
      storageType: 'kv', cronSecret: 'cron-portable-secret',
      webdavBackup: { password: 'webdav-portable-secret' },
      externalApi: { enabled: true, tokens: [{ id: 'external-1', name: 'automation', token: 'external-portable-token' }] }
    });
    await createDeploymentRepository(sourceStorage).putDeployment({
      id: 'deploy-portable', schemaVersion: 2, status: 'succeeded',
      encryptedConfig: await encryptDeploymentConfig({ schemaVersion: 2, secret: 'deployment-portable-secret' }, sourceEnv)
    });

    SettingsCache.clear();
    const envelope = await exportPortablePackage(sourceEnv, 'portable-passphrase-strong');
    expect(JSON.stringify(envelope)).not.toContain('portable-secret');
    SettingsCache.clear();
    await importPortablePackage(targetEnv, envelope, 'portable-passphrase-strong');

    const targetStorage = StorageFactory.createAdapter(targetEnv, 'kv');
    const settings = await targetStorage.get('worker_settings_v1');
    expect(settings).toMatchObject({
      cronSecret: 'cron-portable-secret',
      webdavBackup: { password: 'webdav-portable-secret' },
      externalApi: { tokens: [expect.objectContaining({ token: 'external-portable-token' })] }
    });
    const deployment = await createDeploymentRepository(targetStorage).getDeployment('deploy-portable');
    expect(await decryptDeploymentConfig(deployment.encryptedConfig, targetEnv)).toMatchObject({ secret: 'deployment-portable-secret' });
    expect(deployment.agentReconnectRequired).toBe(true);
  }, 30_000);
});

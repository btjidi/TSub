import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsCache, StorageFactory } from '../../functions/storage-adapter.js';
import { mergeSettingsUpdate, redactSettingsForClient, SETTINGS_SECRETS_KEY } from '../../functions/modules/settings-secrets.js';
import { handleSettingsGet, handleSettingsSave } from '../../functions/modules/api-handler.js';

function createKv(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  return {
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async put(key, value) { data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...data.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })) }; },
    dump(key) { return data.get(key); }
  };
}

function createD1(initialSettings = {}) {
  const rows = new Map(Object.entries(initialSettings).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (/FROM settings/i.test(sql)) return rows.has(args[0]) ? { data: rows.get(args[0]) } : null;
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (/INSERT OR REPLACE INTO settings/i.test(sql)) rows.set(args[0], args[1]);
          if (/DELETE FROM settings/i.test(sql)) rows.delete(args[0]);
          return { success: true };
        }
      };
    },
    row(key) { return rows.get(key); }
  };
}

const secretSettings = {
  FileName: 'TSub',
  cronSecret: 'cron-secret-value',
  BotToken: 'telegram-notify-token',
  telegram_push_config: { bot_token: 'telegram-push-token', webhook_secret: 'webhook-secret' },
  webdavBackup: { username: 'tester', password: 'webdav-password' },
  externalApi: { enabled: true, tokens: [{ name: 'default', token: 'external-token-value' }] },
  cloudflareUsage: { enabled: true, accountId: 'a'.repeat(32), apiToken: 'cloudflare-secret-token', d1DatabaseId: 'b'.repeat(32), kvNamespaceId: '', limits: { d1: { rowsReadDaily: 5000000 }, kv: { readsDaily: 100000 } } }
};

describe('encrypted settings secrets', () => {
  beforeEach(() => SettingsCache.clear());

  it('migrates legacy plaintext into an encrypted envelope and returns merged settings internally', async () => {
    const kv = createKv({ worker_settings_v1: secretSettings });
    const env = { TSUB_KV: kv, DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests' };
    const adapter = StorageFactory.createAdapter(env, 'kv');
    const settings = await adapter.get('worker_settings_v1');

    expect(settings.cronSecret).toBe('cron-secret-value');
    const publicRecord = JSON.parse(kv.dump('worker_settings_v1'));
    expect(publicRecord.cronSecret).toBe('');
    expect(publicRecord.externalApi.tokens[0].token).toBe('');
    expect(publicRecord.cloudflareUsage.apiToken).toBe('');
    const envelope = JSON.parse(kv.dump(SETTINGS_SECRETS_KEY));
    expect(envelope).toMatchObject({ version: 1, algorithm: 'A256GCM' });
    expect(JSON.stringify(envelope)).not.toContain('cron-secret-value');
    expect(JSON.stringify(envelope)).not.toContain('cloudflare-secret-token');
  });

  it('redacts all client secrets while exposing configured metadata', () => {
    const result = redactSettingsForClient(secretSettings);
    expect(result.cronSecret).toBe('');
    expect(result.BotToken).toBe('');
    expect(result.telegram_push_config.bot_token).toBe('');
    expect(result.webdavBackup.password).toBe('');
    expect(result.externalApi.tokens[0].token).toBe('');
    expect(result.cloudflareUsage.apiToken).toBe('');
    expect(result.secretStatus['cloudflareUsage.apiToken']).toBe(true);
    expect(result.secretStatus.cronSecret).toBe(true);
    expect(Object.values(result.secretStatus.externalApiTokens)).toEqual([true]);
  });

  it('preserves blank secrets and supports explicit clearing', () => {
    const oldSettings = { ...secretSettings, externalApi: { tokens: [{ id: 'external-1', name: 'default', token: 'old-token' }] } };
    const preserved = mergeSettingsUpdate(oldSettings, {
      cronSecret: '',
      externalApi: { tokens: [{ id: 'external-1', name: 'default', token: '' }] }
    });
    expect(preserved.cronSecret).toBe('cron-secret-value');
    expect(preserved.externalApi.tokens[0].token).toBe('old-token');

    const cleared = mergeSettingsUpdate(oldSettings, {
      secretActions: { clearPaths: ['cronSecret'], clearExternalTokenIds: ['external-1'] },
      externalApi: { tokens: [{ id: 'external-1', name: 'default', token: '' }] }
    });
    expect(cleared.cronSecret).toBe('');
    expect(cleared.externalApi.tokens[0].token).toBe('');

    const replacedAfterClear = mergeSettingsUpdate(oldSettings, {
      cronSecret: 'replacement-cron-secret',
      secretActions: { clearPaths: ['cronSecret'], clearExternalTokenIds: ['external-1'] },
      externalApi: { tokens: [{ id: 'external-1', name: 'default', token: 'replacement-token' }] }
    });
    expect(replacedAfterClear.cronSecret).toBe('replacement-cron-secret');
    expect(replacedAfterClear.externalApi.tokens[0].token).toBe('replacement-token');
  });

  it('does not allow clearing the Cloudflare token while quota monitoring remains enabled', async () => {
    const kv = createKv();
    const env = { TSUB_KV: kv, DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests' };
    await StorageFactory.createAdapter(env, 'kv').put('worker_settings_v1', secretSettings);
    const response = await handleSettingsSave(new Request('https://example.com/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cloudflareUsage: { ...secretSettings.cloudflareUsage, apiToken: '' },
        secretActions: { clearPaths: ['cloudflareUsage.apiToken'] }
      })
    }), env);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('Cloudflare API Token');
    expect((await StorageFactory.createAdapter(env, 'kv').get('worker_settings_v1')).cloudflareUsage.apiToken).toBe('cloudflare-secret-token');
  });

  it('uses SETTINGS_SECRET_KEY first and can read deployment-key fallback envelopes', async () => {
    const kv = createKv();
    const fallbackEnv = { TSUB_KV: kv, DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests' };
    await StorageFactory.createAdapter(fallbackEnv, 'kv').put('worker_settings_v1', secretSettings);
    const upgradedEnv = {
      TSUB_KV: kv,
      SETTINGS_SECRET_KEY: 'dedicated-settings-secret-key',
      DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests'
    };
    expect((await StorageFactory.createAdapter(upgradedEnv, 'kv').get('worker_settings_v1')).BotToken).toBe('telegram-notify-token');
  });

  it('preserves leading and trailing characters in encryption keys', async () => {
    const kv = createKv();
    const exactEnv = { TSUB_KV: kv, SETTINGS_SECRET_KEY: '  dedicated-settings-secret-key  ' };
    const trimmedEnv = { TSUB_KV: kv, SETTINGS_SECRET_KEY: 'dedicated-settings-secret-key' };
    const exactAdapter = StorageFactory.createAdapter(exactEnv, 'kv');

    await exactAdapter.put('worker_settings_v1', secretSettings);
    await expect(StorageFactory.createAdapter(trimmedEnv, 'kv').get('worker_settings_v1')).rejects.toThrow('无法解密设置 Secret');
    expect((await exactAdapter.get('worker_settings_v1')).cronSecret).toBe('cron-secret-value');
  });

  it('stores the same encrypted split in D1 settings rows', async () => {
    const db = createD1();
    const env = { TSUB_DB: db, SETTINGS_SECRET_KEY: 'dedicated-settings-secret-key' };
    const adapter = StorageFactory.createAdapter(env, 'd1');
    await adapter.put('worker_settings_v1', secretSettings);
    expect(JSON.parse(db.row('main')).cronSecret).toBe('');
    expect(JSON.parse(db.row(SETTINGS_SECRETS_KEY))).toMatchObject({ version: 1, algorithm: 'A256GCM' });
    expect((await adapter.get('worker_settings_v1')).cronSecret).toBe('cron-secret-value');
  });

  it('never returns saved secret values from the settings API and preserves blank updates', async () => {
    const kv = createKv({ worker_settings_v1: { FileName: 'TSub', cronSecret: 'cron-secret-value' } });
    const env = { TSUB_KV: kv, DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests' };
    const getResponse = await handleSettingsGet(env);
    const exposed = await getResponse.json();
    expect(exposed.cronSecret).toBe('');
    expect(exposed.secretStatus.cronSecret).toBe(true);
    expect(JSON.stringify(exposed)).not.toContain('cron-secret-value');

    const saveResponse = await handleSettingsSave(new Request('https://example.com/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cronSecret: '', FileName: 'Updated' })
    }), env);
    expect(saveResponse.status).toBe(200);
    SettingsCache.clear();
    const internal = await StorageFactory.createAdapter(env, 'kv').get('worker_settings_v1');
    expect(internal.cronSecret).toBe('cron-secret-value');
    expect(internal.FileName).toBe('Updated');
    expect(JSON.parse(kv.dump('worker_settings_v1')).cronSecret).toBe('');
  });

  it('normalizes traffic node labels and rejects an enabled empty combination', async () => {
    const kv = createKv();
    const env = { TSUB_KV: kv, DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests' };
    const emptyDisplay = Object.fromEntries(['upload', 'download', 'total', 'remaining'].map(key => [key, { enabled: false, label: 'invalid' }]));
    const rejected = await handleSettingsSave(new Request('https://example.com/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableTrafficNode: true, trafficNodeDisplay: emptyDisplay })
    }), env);
    expect(rejected.status).toBe(400);

    const accepted = await handleSettingsSave(new Request('https://example.com/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableTrafficNode: true, trafficNodeDisplay: { upload: { enabled: true, label: 'full' } } })
    }), env);
    expect(accepted.status).toBe(200);
    SettingsCache.clear();
    const saved = await StorageFactory.createAdapter(env, 'kv').get('worker_settings_v1');
    expect(saved.trafficNodeDisplay.upload).toEqual({ enabled: true, label: 'full', customLabel: '' });
    expect(saved.trafficNodeDisplay.download).toEqual({ enabled: true, label: 'symbol', customLabel: '' });
    expect(saved.trafficNodeDisplay.layout).toBe('two');
  });

  it('rejects an unknown data submission mode', async () => {
    const kv = createKv();
    const response = await handleSettingsSave(new Request('https://example.com/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataCommitMode: 'delayed' })
    }), { TSUB_KV: kv, DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests' });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe('数据提交方式无效');
  });

  it('rejects a non-boolean direct submission success preference', async () => {
    const kv = createKv();
    const response = await handleSettingsSave(new Request('https://example.com/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directCommitSilentSuccess: 'false' })
    }), { TSUB_KV: kv, DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests' });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe('自动提交成功提示设置无效');
  });

  it('validates and sanitizes enabled custom traffic node labels', async () => {
    const kv = createKv();
    const env = { TSUB_KV: kv, DEPLOYMENT_SECRET_KEY: 'deployment-secret-key-for-tests' };
    const saveDisplay = display => handleSettingsSave(new Request('https://example.com/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableTrafficNode: true, trafficNodeDisplay: display })
    }), env);

    const empty = await saveDisplay({ upload: { enabled: true, label: 'custom', customLabel: ' \u0000 ' } });
    expect(empty.status).toBe(400);
    expect((await empty.json()).message).toContain('上行流量的自定义名称不能为空');

    const tooLong = await saveDisplay({ download: { enabled: true, label: 'custom', customLabel: '长'.repeat(25) } });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).message).toContain('不能超过 24 个字符');

    const accepted = await saveDisplay({
      upload: { enabled: true, label: 'custom', customLabel: '  上传\u0000  ' },
      download: { enabled: false, label: 'custom', customLabel: '' }
    });
    expect(accepted.status).toBe(200);
    SettingsCache.clear();
    const saved = await StorageFactory.createAdapter(env, 'kv').get('worker_settings_v1');
    expect(saved.trafficNodeDisplay.upload).toEqual({ enabled: true, label: 'custom', customLabel: '上传' });
    expect(saved.trafficNodeDisplay.download).toEqual({ enabled: false, label: 'symbol', customLabel: '' });
  });
});

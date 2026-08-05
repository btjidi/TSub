// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServerDatabase } from '../../server/database.mjs';
import { ensureD1Schema, SettingsCache, StorageFactory } from '../../functions/storage-adapter.js';
import { createDeploymentRepository } from '../../functions/services/deployment-repository.js';
import { ensureDeploymentAgent, pollAgent, queueAgentCommand } from '../../functions/services/agent-control-service.js';
import { advanceStorageMigration, startStorageMigration } from '../../functions/services/storage-migration-service.js';

const postgresUrl = process.env.TSUB_TEST_POSTGRES_URL;
const suite = postgresUrl ? describe : describe.skip;

suite('PostgreSQL controller contract', () => {
  let postgres;
  let sqlite;
  let directory;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'tsub-postgres-test-'));
    postgres = await createServerDatabase({ type: 'postgres', url: postgresUrl, poolSize: 2 });
    sqlite = await createServerDatabase({ type: 'sqlite', dataDir: directory, path: path.join(directory, 'source.sqlite') });
    await postgres.binding.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ensureD1Schema(postgres.binding);
    await ensureD1Schema(sqlite.binding);
  }, 30_000);

  afterAll(async () => {
    SettingsCache.clear();
    await postgres?.binding.close();
    sqlite?.binding.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('initializes portable schema version metadata', async () => {
    const row = await postgres.binding.prepare('SELECT MAX(version) AS version FROM schema_migrations').first();
    expect(Number(row?.version)).toBeGreaterThan(0);
  });

  it('stores independent records and enforces one active command per deployment', async () => {
    const env = { TSUB_PLATFORM: 'server', TSUB_STORAGE_TYPE: 'postgres', TSUB_SQL_DB: postgres.binding };
    const storage = StorageFactory.createAdapter(env, 'postgres');
    const repository = createDeploymentRepository(storage);
    const deployment = { id: 'deploy-pg', schemaVersion: 2, name: 'PostgreSQL', status: 'succeeded', configRevision: 1, createdAt: new Date().toISOString() };
    await repository.putDeployment(deployment);
    const agent = await ensureDeploymentAgent(storage, deployment);
    const request = () => new Request('https://controller.example/api/deploy/agent/poll', {
      method: 'POST', headers: { Authorization: `Bearer ${agent.token}` }
    });
    await pollAgent(request(), env, storage, { runtimeVersion: 'test' });
    const operation = { id: 'op-pg', deploymentId: deployment.id, action: 'repair', status: 'pending', events: [], createdAt: new Date().toISOString() };
    await repository.putOperation(operation);
    await expect(queueAgentCommand(storage, deployment, operation)).resolves.toMatchObject({ action: 'repair' });
    const second = { ...operation, id: 'op-pg-second' };
    await repository.putOperation(second);
    await expect(queueAgentCommand(storage, deployment, second)).rejects.toMatchObject({ code: 'command_active' });
  }, 30_000);

  it('migrates SQLite rows to PostgreSQL with a verified canonical digest', async () => {
    await sqlite.binding.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('main', JSON.stringify({ language: 'zh-CN' })).run();
    await sqlite.binding.prepare('INSERT INTO subscriptions (id, data) VALUES (?, ?)').bind('sub-sqlite', JSON.stringify({ id: 'sub-sqlite' })).run();
    const env = {
      TSUB_PLATFORM: 'server', TSUB_STORAGE_TYPE: 'sqlite', TSUB_SQL_DB: sqlite.binding,
      TSUB_SERVER_DATABASES: { sqlite: sqlite.binding, postgres: postgres.binding }, TSUB_MIGRATION_DRAIN_MS: 0,
      TSUB_SWITCH_SERVER_STORAGE: async target => {
        env.TSUB_STORAGE_TYPE = target;
        env.TSUB_SQL_DB = env.TSUB_SERVER_DATABASES[target];
      }
    };
    const migration = await startStorageMigration(env, 'postgres');
    let current = migration;
    for (let index = 0; index < 8 && current.phase !== 'complete'; index += 1) current = await advanceStorageMigration(env, migration.id);
    expect(current.phase).toBe('complete');
    expect(await postgres.binding.prepare('SELECT data FROM subscriptions WHERE id = ?').bind('sub-sqlite').first()).toBeTruthy();
  }, 30_000);
});

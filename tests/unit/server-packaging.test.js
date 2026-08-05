// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServerDatabase } from '../../server/database.mjs';
import { ensureD1Schema } from '../../functions/storage-adapter.js';
import { createDeploymentRepository } from '../../functions/services/deployment-repository.js';
import { queueAgentConfigurationUpdate } from '../../functions/services/agent-control-service.js';

describe('server controller packaging', () => {
  it('ships shared runtime modules in Docker and bare-metal packages', async () => {
    const [dockerfile, dockerignore, installer, environmentInitializer, executorUnit, environmentExample] = await Promise.all([
      readFile('Dockerfile', 'utf8'),
      readFile('.dockerignore', 'utf8'),
      readFile('scripts/install-controller.sh', 'utf8'),
      readFile('scripts/init-controller-env.sh', 'utf8'),
      readFile('server/install/tsub-executor.service', 'utf8'),
      readFile('server/controller.env.example', 'utf8')
    ]);
    expect(dockerfile).toContain('COPY --from=build /app/shared ./shared');
    expect(dockerfile).toContain('COPY --from=build /app/src/shared ./src/shared');
    expect(dockerignore.split(/\r?\n/)).toContain('.env');
    expect(dockerignore.split(/\r?\n/)).toContain('.env.*');
    expect(installer).toContain('cp -R dist functions server shared package.json package-lock.json "$PREFIX/"');
    expect(installer).toContain('cp -R src/shared "$PREFIX/src/"');
    expect(executorUnit).not.toContain('Requires=tsub-controller.service');
    expect(executorUnit).toContain('ConfigurationDirectory=tsub');
    expect(executorUnit).toContain('ReadWritePaths=-/etc/tsub');
    expect(installer).toContain('/etc/tsub /run/tsub');
    expect(installer).toContain('chmod 700 "$PREFIX/server/executor/tsub-local-executor.sh"');
    expect(installer).toContain('[ -f "$CONFIG_FILE" ] && NEW_INSTALL=false');
    expect(installer).toContain('保留现有配置与加密密钥');
    expect(installer).toContain('provider_defaults_tmp=$CONFIG_FILE.providers.$$');
    expect(installer).toContain('mv -f "$provider_defaults_tmp" "$CONFIG_FILE"');
    expect(installer).toContain('generated_admin_password=false');
    expect(installer).toContain('初始密码：$plain_admin_password');
    expect(environmentInitializer).toContain('[ -e "$OUTPUT_FILE" ] || [ -L "$OUTPUT_FILE" ]');
    expect(environmentInitializer).toContain('ln "$temporary_file" "$OUTPUT_FILE"');
    expect(environmentInitializer).toContain('chmod 600 "$temporary_file"');
    expect(environmentInitializer).toContain('初始密码：$admin_password');
    expect(environmentExample).toContain('TSUB_STATIC_DIR=/app/dist');
    for (const content of [installer, environmentExample]) {
      expect(content).toMatch(/TSUB_XRAY_AMD64_URL=https:\/\/github\.com\/btjidi\/TSub\/releases\/download\//);
      expect(content).toMatch(/TSUB_XRAY_AMD64_SHA256=[a-f0-9]{64}/);
      expect(content).toMatch(/TSUB_SINGBOX_AMD64_URL=https:\/\/github\.com\/btjidi\/TSub\/releases\/download\/runtime-assets-v2\/sing-box-1\.13\.15-amd64/);
      expect(content).toMatch(/TSUB_SINGBOX_AMD64_SHA256=[a-f0-9]{64}/);
      expect(content).toContain('TSUB_SINGBOX_AMD64_FORMAT=binary');
      expect(content).toMatch(/TSUB_SINGBOX_AMD64_BINARY_SHA256=[a-f0-9]{64}/);
      expect(content).toMatch(/TSUB_CLOUDFLARED_AMD64_URL=https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\//);
      expect(content).toMatch(/TSUB_CLOUDFLARED_AMD64_SHA256=[a-f0-9]{64}/);
      expect(content).toMatch(/TSUB_LEGO_AMD64_URL=https:\/\/github\.com\/go-acme\/lego\/releases\/download\//);
      expect(content).toContain('TSUB_LEGO_AMD64_FORMAT=tar.gz');
      expect(content).toMatch(/TSUB_LEGO_AMD64_BINARY_SHA256=[a-f0-9]{64}/);
      expect(content).toMatch(/TSUB_BUSYBOX_AMD64_URL=https:\/\/busybox\.net\/downloads\/binaries\//);
      expect(content).toMatch(/TSUB_BUSYBOX_AMD64_SHA256=[a-f0-9]{64}/);
      expect(content).toMatch(/TSUB_BUSYBOX_ARM64_SHA256=[a-f0-9]{64}/);
    }
  });

  it('loads the persistent controller environment under OpenRC', async () => {
    const service = await readFile('server/install/tsub-controller.openrc', 'utf8');
    expect(service).toContain('. /etc/tsub-controller/controller.env');
    expect(service).toContain('set -a');
  });

  it('creates a private SQLite database', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tsub-sqlite-mode-'));
    const databasePath = path.join(directory, 'controller.sqlite');
    const database = await createServerDatabase({ type: 'sqlite', dataDir: directory, path: databasePath });
    try {
      await ensureD1Schema(database.binding);
      expect(await database.binding.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'").first())
        .toMatchObject({ name: 'subscriptions' });
      expect(await database.binding.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_subscriptions_updated_at'").first())
        .toMatchObject({ name: 'idx_subscriptions_updated_at' });
      const mode = (await stat(databasePath)).mode & 0o777;
      if (process.platform !== 'win32') expect(mode).toBe(0o600);
      else expect(mode).toBeGreaterThan(0);
    } finally {
      database.binding.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('atomically stores a SQLite configuration revision and its remote command', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tsub-sqlite-remote-update-'));
    const databasePath = path.join(directory, 'controller.sqlite');
    const database = await createServerDatabase({ type: 'sqlite', dataDir: directory, path: databasePath });
    try {
      await database.binding.exec(await readFile('schema.sql', 'utf8'));
      const storage = { type: 'sqlite', db: database.binding };
      const repository = createDeploymentRepository(storage);
      const current = { id: 'deploy-sqlite', name: 'Old', schemaVersion: 2, status: 'succeeded', configRevision: 2, createdAt: new Date().toISOString() };
      await repository.putDeployment(current);
      await database.binding.prepare(`INSERT INTO deployment_agents (deployment_id, token_hash, generation) VALUES (?, ?, 1)`)
        .bind(current.id, 'a'.repeat(64)).run();
      await database.binding.prepare(`INSERT INTO deployment_heartbeats (deployment_id, data, last_seen_at) VALUES (?, '{}', ?)`)
        .bind(current.id, new Date().toISOString()).run();
      const operation = {
        id: 'op-sqlite-update', deploymentId: current.id, action: 'update', delivery: 'agent', status: 'pending', events: [],
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      const next = { ...current, name: 'Updated', status: 'pending', pendingReason: 'config', pendingOperationId: operation.id, configRevision: 3 };
      const command = await queueAgentConfigurationUpdate(storage, current, next, operation, 2);
      expect(await repository.getDeployment(current.id)).toMatchObject({ name: 'Updated', configRevision: 3, pendingOperationId: operation.id });
      expect(await repository.getOperation(operation.id)).toMatchObject({ action: 'update', delivery: 'agent', status: 'pending' });
      expect(await database.binding.prepare('SELECT status FROM deployment_commands WHERE id = ?').bind(command.id).first()).toMatchObject({ status: 'pending' });
    } finally {
      database.binding.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

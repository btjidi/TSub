// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { loadPagesTarget, pagesTargetFromEnv, verifyPagesTarget, wranglerDeployCommand } from '../../scripts/deploy-pages.mjs';

const target = {
  accountId: 'a'.repeat(32), projectName: 'tsub', projectSubdomain: 'tsub-2b3.pages.dev',
  kvBinding: 'TSUB_KV', kvNamespaceId: 'k'.repeat(32), d1Binding: 'TSUB_DB',
  d1DatabaseName: 'tsub-production', d1DatabaseId: 'd'.repeat(36)
};
const project = (overrides = {}) => ({
  subdomain: target.projectSubdomain,
  deployment_configs: { production: {
    kv_namespaces: { TSUB_KV: { namespace_id: target.kvNamespaceId } },
    d1_databases: { TSUB_DB: { id: target.d1DatabaseId } }
  } },
  ...overrides
});

function requestFor(projectValue = project()) {
  return vi.fn(async pathname => {
    if (pathname.includes('/pages/projects/')) return projectValue;
    if (pathname.includes('/storage/kv/')) return { id: target.kvNamespaceId };
    if (pathname.includes('/d1/database/')) return { uuid: target.d1DatabaseId, name: target.d1DatabaseName };
    throw new Error('unexpected request');
  });
}

describe('Pages production target protection', () => {
  it('runs the local Wrangler CLI through Node without a platform-specific command shim', () => {
    expect(wranglerDeployCommand('/repo', '/node')).toEqual({
      command: '/node',
      args: [expect.stringMatching(/node_modules[\\/]wrangler[\\/]bin[\\/]wrangler\.js$/), 'pages', 'deploy', 'dist']
    });
  });

  it('loads a local target file and accepts an exact remote target', async () => {
    const read = vi.fn(async () => JSON.stringify(target));
    await expect(loadPagesTarget({ rootDir: '/repo', env: {}, read })).resolves.toEqual(target);
    await expect(verifyPagesTarget({ target, accountId: target.accountId, token: 'token', request: requestFor() }))
      .resolves.toMatchObject({ projectName: 'tsub', subdomain: target.projectSubdomain });
  });

  it('loads the production target from environment variables', () => {
    expect(pagesTargetFromEnv({
      CLOUDFLARE_ACCOUNT_ID: target.accountId,
      TSUB_PAGES_PROJECT_NAME: target.projectName,
      TSUB_PAGES_PROJECT_SUBDOMAIN: target.projectSubdomain,
      TSUB_KV_NAMESPACE_ID: target.kvNamespaceId,
      TSUB_D1_DATABASE_ID: target.d1DatabaseId,
      TSUB_D1_DATABASE_NAME: target.d1DatabaseName
    })).toEqual(target);
  });

  it('blocks incomplete local configuration, the wrong account and project subdomain', async () => {
    await expect(loadPagesTarget({ rootDir: '/repo', env: {}, read: async () => '{}' })).rejects.toThrow(/incomplete/);
    await expect(verifyPagesTarget({ target, accountId: 'b'.repeat(32), token: 'token', request: requestFor() })).rejects.toThrow(/Account ID/);
    await expect(verifyPagesTarget({ target, accountId: target.accountId, token: 'token', request: requestFor(project({ subdomain: 'other.pages.dev' })) })).rejects.toThrow(/subdomain/);
  });

  it('blocks missing or mismatched production bindings', async () => {
    const missingKv = project(); delete missingKv.deployment_configs.production.kv_namespaces.TSUB_KV;
    await expect(verifyPagesTarget({ target, accountId: target.accountId, token: 'token', request: requestFor(missingKv) })).rejects.toThrow(/KV binding is missing/);
    const wrongD1 = project(); wrongD1.deployment_configs.production.d1_databases.TSUB_DB.id = 'wrong';
    await expect(verifyPagesTarget({ target, accountId: target.accountId, token: 'token', request: requestFor(wrongD1) })).rejects.toThrow(/D1 binding is missing/);
  });

  it('forwards the proxy value to every Cloudflare request without putting the token in paths', async () => {
    const request = requestFor();
    await verifyPagesTarget({ target, accountId: target.accountId, token: 'private-token', proxy: 'http://127.0.0.1:10808', request });
    expect(request).toHaveBeenCalledTimes(3);
    for (const [pathname, token, proxy] of request.mock.calls) {
      expect(pathname).not.toContain('private-token'); expect(token).toBe('private-token'); expect(proxy).toBe('http://127.0.0.1:10808');
    }
  });
});

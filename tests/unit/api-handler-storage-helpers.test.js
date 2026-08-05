import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getAllSubscriptions = vi.fn();
const getAllProfiles = vi.fn();
const get = vi.fn();
const put = vi.fn();
const putSubscription = vi.fn();
const putProfile = vi.fn();
const deleteSubscriptionById = vi.fn();
const deleteProfileById = vi.fn();
const createAdapter = vi.fn();
const getStorageType = vi.fn();
const settingsCacheGet = vi.fn();
const clearAllNodeCaches = vi.fn();

vi.mock('../../functions/storage-adapter.js', () => ({
  StorageFactory: {
    createAdapter: (...args) => createAdapter(...args),
    getStorageType: (...args) => getStorageType(...args),
    resolveKV: () => ({})
  },
  SettingsCache: {
    get: (...args) => settingsCacheGet(...args),
    clear: vi.fn()
  },
  STORAGE_TYPES: {
    KV: 'kv',
    D1: 'd1'
  }
}));

vi.mock('../../functions/modules/utils.js', () => ({
  getCookieSecret: vi.fn(),
  getAdminPassword: vi.fn(),
  setAdminPassword: vi.fn(),
  isUsingDefaultPassword: vi.fn().mockResolvedValue(false),
  createJsonResponse: (data, status = 200) => new Response(JSON.stringify(data), { status }),
  createErrorResponse: (data, status = 500) => new Response(JSON.stringify({ error: String(data) }), { status }),
  migrateProfileIds: vi.fn().mockReturnValue(false),
  JSON_BODY_LIMITS: { auth: 16 * 1024, small: 128 * 1024, normal: 1024 * 1024, large: 5 * 1024 * 1024 },
  readJsonWithLimit: async request => request.json()
}));

vi.mock('../../functions/modules/auth-middleware.js', () => ({
  authMiddleware: vi.fn(),
  handleLogin: vi.fn(),
  handleLogout: vi.fn(),
  createUnauthorizedResponse: vi.fn()
}));

vi.mock('../../functions/modules/notifications.js', () => ({
  sendTgNotification: vi.fn(),
  checkAndNotify: vi.fn().mockResolvedValue(null)
}));

vi.mock('../../functions/services/node-cache-service.js', () => ({
  clearAllNodeCaches: (...args) => clearAllNodeCaches(...args)
}));

describe('api-handler storage helper usage', () => {
  let infoSpy;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    getAllSubscriptions.mockReset();
    getAllProfiles.mockReset();
    get.mockReset();
    put.mockReset();
    putSubscription.mockReset();
    putProfile.mockReset();
    deleteSubscriptionById.mockReset();
    deleteProfileById.mockReset();
    createAdapter.mockReset();
    getStorageType.mockReset();
    settingsCacheGet.mockReset();
    clearAllNodeCaches.mockReset();

    getStorageType.mockResolvedValue('d1');
    settingsCacheGet.mockResolvedValue({});
    clearAllNodeCaches.mockResolvedValue({ cleared: 0, failed: 0, skipped: 0 });
    createAdapter.mockReturnValue({
      getAllSubscriptions,
      getAllProfiles,
      get,
      put,
      putSubscription,
      putProfile,
      deleteSubscriptionById,
      deleteProfileById
    });
    get.mockResolvedValue(null);
    putSubscription.mockResolvedValue(true);
    putProfile.mockResolvedValue(true);
    deleteSubscriptionById.mockResolvedValue(true);
    deleteProfileById.mockResolvedValue(true);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('handleDataRequest prefers getAll helper APIs', async () => {
    const { handleDataRequest } = await import('../../functions/modules/api-handler.js');

    getAllSubscriptions.mockResolvedValue([{ id: 'sub-1', name: 'Sub One' }]);
    getAllProfiles.mockResolvedValue([{ id: 'profile-1', name: 'Profile One' }]);

    const response = await handleDataRequest({ TSUB_DB: {} });
    const payload = await response.json();

    expect(getAllSubscriptions).toHaveBeenCalled();
    expect(getAllProfiles).toHaveBeenCalled();
    expect(payload.tsubs).toHaveLength(1);
    expect(payload.profiles).toHaveLength(1);
  });

  it('defaults data submission to manual on Cloudflare and direct on server controllers', async () => {
    const { handleDataRequest } = await import('../../functions/modules/api-handler.js');
    getAllSubscriptions.mockResolvedValue([]);
    getAllProfiles.mockResolvedValue([]);

    const cloudflare = await (await handleDataRequest({ TSUB_DB: {} })).json();
    const server = await (await handleDataRequest({ TSUB_DB: {}, TSUB_PLATFORM: 'server' })).json();

    expect(cloudflare.config.dataCommitMode).toBe('manual');
    expect(server.config.dataCommitMode).toBe('direct');
  });

  it('preserves an explicit data submission preference over the platform default', async () => {
    const { handleDataRequest } = await import('../../functions/modules/api-handler.js');
    getAllSubscriptions.mockResolvedValue([]);
    getAllProfiles.mockResolvedValue([]);
    settingsCacheGet.mockResolvedValue({ dataCommitMode: 'manual' });

    const payload = await (await handleDataRequest({ TSUB_DB: {}, TSUB_PLATFORM: 'server' })).json();

    expect(payload.config.dataCommitMode).toBe('manual');
  });

  it('handleTsubsSave diff mode reads current data through getAll helper APIs', async () => {
    const { handleTsubsSave } = await import('../../functions/modules/api-handler.js');

    getAllSubscriptions.mockResolvedValue([{ id: 'sub-1', name: 'Sub One', url: 'https://a.example.com' }]);
    getAllProfiles.mockResolvedValue([{ id: 'profile-1', name: 'Profile One', subscriptions: [], manualNodes: [] }]);
    get.mockResolvedValue({});
    put.mockResolvedValue(true);

    const request = {
      async json() {
        return {
          diff: {
            subscriptions: [],
            profiles: []
          }
        };
      }
    };

    const response = await handleTsubsSave(request, { TSUB_DB: {} });

    expect(response.status).toBe(200);
    expect(getAllSubscriptions).toHaveBeenCalled();
    expect(getAllProfiles).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('[API] Processing Diff Patch...');
    expect(infoSpy).toHaveBeenCalledWith('[API] Cleared 0 node caches after subscription update, preserved 0');
  });

  it('handleTsubsSave preserves protective caches only for subscriptions with node cache enabled', async () => {
    const { handleTsubsSave } = await import('../../functions/modules/api-handler.js');

    getAllSubscriptions.mockResolvedValue([]);
    getAllProfiles.mockResolvedValue([]);
    get.mockResolvedValue({});
    put.mockResolvedValue(true);

    const request = {
      async json() {
        return {
          tsubs: [
            { id: 'sub-enabled', name: 'Enabled', url: 'https://a.example.com', enableNodeCache: true },
            { id: 'sub-disabled', name: 'Disabled', url: 'https://b.example.com', enableNodeCache: false }
          ],
          profiles: []
        };
      }
    };

    const response = await handleTsubsSave(request, { TSUB_DB: {} });

    expect(response.status).toBe(200);
    expect(clearAllNodeCaches).toHaveBeenCalledWith(
      expect.any(Object),
      { preserveKeys: ['node_cache_subscription_sub-enabled'] }
    );
    expect(infoSpy).toHaveBeenCalledWith('[API] Cleared 0 node caches after subscription update, preserved 0');
  });

  it('handleTsubsSave uses row-level helpers for simple diffs', async () => {
    const { handleTsubsSave } = await import('../../functions/modules/api-handler.js');

    get.mockResolvedValue({});
    const request = {
      async json() {
        return {
          diff: {
            subscriptions: {
              added: [{ id: 'sub-1', name: 'Sub One', url: 'https://a.example.com' }],
              updated: [{ id: 'sub-2', name: 'Sub Two', url: 'https://b.example.com' }],
              removed: ['sub-3']
            },
            profiles: {
              added: [{ id: 'profile-1', name: 'Profile One', subscriptions: [], manualNodes: [] }],
              updated: [],
              removed: ['profile-2']
            }
          }
        };
      }
    };

    const response = await handleTsubsSave(request, { TSUB_DB: {} });

    expect(response.status).toBe(200);
    expect(putSubscription).toHaveBeenCalledTimes(2);
    expect(deleteSubscriptionById).toHaveBeenCalledWith('sub-3');
    expect(putProfile).toHaveBeenCalledTimes(1);
    expect(deleteProfileById).toHaveBeenCalledWith('profile-2');
    expect(put).not.toHaveBeenCalledWith('tsub_subscriptions_v1', expect.anything());
    expect(put).not.toHaveBeenCalledWith('tsub_profiles_v1', expect.anything());
    expect(infoSpy).toHaveBeenCalledWith('[API] Processing Diff Patch...');
    expect(infoSpy).toHaveBeenCalledWith('[API] Cleared 0 node caches after subscription update, preserved 0');
  });

  it('handleTsubsSave full save uses row-level sync when helper APIs are available', async () => {
    const { handleTsubsSave } = await import('../../functions/modules/api-handler.js');

    getAllSubscriptions.mockResolvedValue([{ id: 'sub-legacy', name: 'Legacy', url: 'https://old.example.com' }]);
    getAllProfiles.mockResolvedValue([{ id: 'profile-legacy', name: 'Legacy Profile', subscriptions: [], manualNodes: [] }]);
    get.mockResolvedValue({});

    const request = {
      async json() {
        return {
          tsubs: [{ id: 'sub-new', name: 'Sub New', url: 'https://new.example.com' }],
          profiles: [{ id: 'profile-new', name: 'Profile New', subscriptions: [], manualNodes: [] }]
        };
      }
    };

    const response = await handleTsubsSave(request, { TSUB_DB: {} });

    expect(response.status).toBe(200);
    expect(putSubscription).toHaveBeenCalledWith({
      id: 'sub-new',
      name: 'Sub New',
      url: 'https://new.example.com',
      sortIndex: 0,
    });
    expect(deleteSubscriptionById).toHaveBeenCalledWith('sub-legacy');
    expect(putProfile).toHaveBeenCalledWith({
      id: 'profile-new',
      name: 'Profile New',
      subscriptions: [],
      manualNodes: [],
      enabled: true,
      isPublic: false,
      downloadCount: 0,
      sortIndex: 0,
    });
    expect(deleteProfileById).toHaveBeenCalledWith('profile-legacy');
    expect(put).not.toHaveBeenCalledWith('tsub_subscriptions_v1', expect.anything());
    expect(put).not.toHaveBeenCalledWith('tsub_profiles_v1', expect.anything());
    expect(infoSpy).toHaveBeenCalledWith('[API] Cleared 0 node caches after subscription update, preserved 0');
  });

  it('preserves managed deployment fields while accepting safe preferences and quota', async () => {
    const { handleTsubsSave } = await import('../../functions/modules/api-handler.js');
    const current = {
      id: 'managed-1', name: 'Deployment Name', url: 'https://controller.example/mirror', enabled: true,
      enableNodeCache: true, pushCount: 9, pushHistory: ['latest'], userInfo: { upload: 10, download: 20, total: 1000 },
      source: { kind: 'tsub-deployment-push', deploymentId: 'deploy-1' }
    };
    getAllSubscriptions.mockResolvedValue([current]);
    getAllProfiles.mockResolvedValue([]);
    get.mockResolvedValue({});

    const response = await handleTsubsSave({
      async json() {
        return {
          tsubs: [{
            ...current,
            name: 'Forged Name', url: 'https://attacker.example/sub', enableNodeCache: false,
            pushCount: 0, pushHistory: [], userInfo: null, exclude: 'HK', excludeTraffic: true,
            website: 'https://provider.example', notes: 'memo', trafficQuotaOverrideBytes: 500
          }],
          profiles: []
        };
      }
    }, { TSUB_DB: {} });

    expect(response.status).toBe(200);
    expect(putSubscription).toHaveBeenCalledWith(expect.objectContaining({
      id: 'managed-1', name: 'Deployment Name', url: 'https://controller.example/mirror',
      enableNodeCache: true, pushCount: 9, pushHistory: ['latest'],
      userInfo: { upload: 10, download: 20, total: 1000 },
      exclude: 'HK', excludeTraffic: true, website: 'https://provider.example', notes: 'memo',
      trafficQuotaOverrideBytes: 500, source: { kind: 'tsub-deployment-push', deploymentId: 'deploy-1' }
    }));
  });

  it('preserves managed quota omitted by an older client and managed sources missing from a stale full save', async () => {
    const { handleTsubsSave } = await import('../../functions/modules/api-handler.js');
    const managed = {
      id: 'managed-latest', name: 'Managed Latest', url: 'https://controller.example/latest',
      trafficQuotaOverrideBytes: 9000, pushCount: 12,
      source: { kind: 'tsub-deployment-push', deploymentId: 'deploy-latest' }
    };
    getAllSubscriptions.mockResolvedValue([managed]);
    getAllProfiles.mockResolvedValue([]);
    get.mockResolvedValue({});

    const response = await handleTsubsSave({ async json() { return {
      tsubs: [{ id: 'sub-1', name: 'Regular', url: 'https://example.com/sub' }], profiles: []
    }; } }, { TSUB_DB: {} });

    expect(response.status).toBe(200);
    expect(putSubscription).toHaveBeenCalledWith(expect.objectContaining({
      id: 'managed-latest', trafficQuotaOverrideBytes: 9000, pushCount: 12
    }));
    expect(deleteSubscriptionById).not.toHaveBeenCalledWith('managed-latest');

    vi.clearAllMocks();
    getAllSubscriptions.mockResolvedValue([managed]);
    getAllProfiles.mockResolvedValue([]);
    get.mockResolvedValue({});
    const olderClientResponse = await handleTsubsSave({ async json() { return {
      tsubs: [{ ...managed, trafficQuotaOverrideBytes: undefined }].map(item => {
        delete item.trafficQuotaOverrideBytes;
        return item;
      }), profiles: []
    }; } }, { TSUB_DB: {} });

    expect(olderClientResponse.status).toBe(200);
    expect(putSubscription).toHaveBeenCalledWith(expect.objectContaining({
      id: 'managed-latest', trafficQuotaOverrideBytes: 9000
    }));
  });

  it('rejects invalid and stale managed subscription updates', async () => {
    const { handleTsubsSave } = await import('../../functions/modules/api-handler.js');
    getAllSubscriptions.mockResolvedValue([]);
    getAllProfiles.mockResolvedValue([]);

    const invalidQuota = await handleTsubsSave({ async json() { return {
      tsubs: [{ id: 'sub-1', url: 'https://example.com', trafficQuotaOverrideBytes: 0 }], profiles: []
    }; } }, { TSUB_DB: {} });
    expect(invalidQuota.status).toBe(400);

    const staleManaged = await handleTsubsSave({ async json() { return {
      tsubs: [{ id: 'managed-missing', url: 'https://example.com', source: { kind: 'tsub-deployment-push' } }], profiles: []
    }; } }, { TSUB_DB: {} });
    expect(staleManaged.status).toBe(409);
  });
});

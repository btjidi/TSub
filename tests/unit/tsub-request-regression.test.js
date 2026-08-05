import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createAdapter = vi.fn();
const getStorageType = vi.fn();

vi.mock('../../functions/storage-adapter.js', () => ({
    StorageFactory: {
        createAdapter: (...args) => createAdapter(...args),
        getStorageType: (...args) => getStorageType(...args),
        resolveKV: (env) => env?.TSUB_KV || null
    },
    STORAGE_TYPES: { KV: 'kv', D1: 'd1' }
}));

function createStorageAdapter({ settings = {}, subscriptions = [], profiles = [] } = {}) {
    const store = new Map([
        ['worker_settings_v1', settings],
        ['tsub_subscriptions_v1', subscriptions],
        ['tsub_profiles_v1', profiles]
    ]);

    return {
        store,
        get: vi.fn(async (key) => store.has(key) ? store.get(key) : null),
        put: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        getAllSubscriptions: vi.fn(async () => subscriptions),
        getAllProfiles: vi.fn(async () => profiles),
        getSubscriptionsByIds: vi.fn(async (ids) => subscriptions.filter(item => ids.includes(item.id)))
    };
}

function silenceExpectedRequestLogs() {
    return vi.spyOn(console, 'log').mockImplementation(() => {});
}

function extractTrafficNodeNames(content) {
    return content.split('\n').flatMap(line => {
        if (line.startsWith('vmess://')) {
            try {
                const payload = JSON.parse(Buffer.from(line.slice('vmess://'.length), 'base64').toString('utf8'));
                return payload.add === '127.0.0.1' ? [payload.ps] : [];
            } catch {
                return [];
            }
        }
        return line.includes('@127.0.0.1:443#')
            ? [decodeURIComponent(line.slice(line.indexOf('#') + 1))]
            : [];
    });
}

describe('handleTsubRequest regression coverage', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        getStorageType.mockResolvedValue('kv');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('uses the real storage adapter for per-subscription protective node cache', async () => {
        const subscriptions = [{
            id: 'sub-a',
            name: '鏈哄満A',
            url: 'https://airport.example/sub',
            enabled: true,
            enableNodeCache: true
        }];
        const adapter = createStorageAdapter({
            settings: { mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: false },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 })));

        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=nodes&refresh=1', {
                    headers: { 'User-Agent': 'ClashMeta' }
                }),
                env: {},
                waitUntil: vi.fn()
            });
            const text = await response.text();

            expect(response.status).toBe(200);
            expect(text).toContain('trojan://pass@example.com:443#');
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[TSub Request]'));
            expect(logSpy).toHaveBeenCalledWith('[TSub UA] ClashMeta');
            expect(logSpy).toHaveBeenCalledWith('[TSub Nodes] Count/Length: 68');
            expect(adapter.put).toHaveBeenCalledWith(
                'node_cache_subscription_sub-a',
                expect.objectContaining({
                    nodes: ['trojan://pass@example.com:443#HK'],
                    nodeCount: 1
                })
            );
        } finally {
            logSpy.mockRestore();
        }
    }, 15_000);

    it('normalizes external converter hosts and uses the current base64 subscription as its data source', async () => {
        const subscriptions = [{
            id: 'sub-a',
            name: '鏈哄満A',
            url: 'https://airport.example/sub',
            enabled: true
        }];
        const adapter = createStorageAdapter({
            settings: {
                mytoken: 'stable-token',
                enableFlagEmoji: false,
                enableTrafficNode: false,
                subconverter: { engineMode: 'external', defaultBackend: 'sub.example' }
            },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 })));

        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const initialResponse = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=clash&refresh=1', {
                    headers: { 'User-Agent': 'ClashMeta' }
                }),
                env: {},
                waitUntil: vi.fn()
            });
            const redirectUrl = new URL(initialResponse.headers.get('Location'));
            const dataSourceUrl = new URL(redirectUrl.searchParams.get('url'));

            expect(initialResponse.status).toBe(302);
            expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://sub.example/sub');
            expect(redirectUrl.searchParams.get('target')).toBe('clash');
            expect(dataSourceUrl.origin + dataSourceUrl.pathname).toBe('https://tsub.example/stable-token');
            expect(dataSourceUrl.searchParams.has('base64')).toBe(true);
            expect(dataSourceUrl.searchParams.get('callback_token')).toBe('external');
            expect(dataSourceUrl.searchParams.has('target')).toBe(false);
            expect(dataSourceUrl.searchParams.has('refresh')).toBe(false);
            expect(redirectUrl.searchParams.get('url')).not.toContain('trojan://pass@example.com');
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[TSub Request]'));
            expect(logSpy).toHaveBeenCalledWith('[TSub Nodes] Count/Length: 68');
        } finally {
            logSpy.mockRestore();
        }
    }, 15_000);

    it('uses the current base64 subscription for large external redirects without callback secrets or temporary writes', async () => {
        const subscriptions = [{
            id: 'sub-a',
            name: 'Airport A',
            url: 'https://airport.example/sub',
            enabled: true
        }];
        const adapter = createStorageAdapter({
            settings: {
                mytoken: 'stable-token',
                enableFlagEmoji: false,
                enableTrafficNode: false,
                subconverter: { engineMode: 'external', defaultBackend: 'sub.example' }
            },
            subscriptions
        });
        const kvWrites = new Map();
        const env = {
            TSUB_KV: {
                get: vi.fn(async (key) => kvWrites.get(key) || null),
                put: vi.fn(async (key, value) => {
                    kvWrites.set(key, value);
                }),
                delete: vi.fn(async (key) => {
                    kvWrites.delete(key);
                })
            }
        };
        createAdapter.mockReturnValue(adapter);
        const bigNodeList = Array.from({ length: 90 }, (_, index) => `trojan://pass${index}@example.com:443#HK-${index}`).join('\n');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(bigNodeList, { status: 200 })));

        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=clash&refresh=1', {
                    headers: { 'User-Agent': 'ClashMeta' }
                }),
                env,
                waitUntil: vi.fn()
            });
            const redirectUrl = new URL(response.headers.get('Location'));
            const dataSourceUrl = new URL(redirectUrl.searchParams.get('url'));

            expect(response.status).toBe(302);
            expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://sub.example/sub');
            expect(redirectUrl.searchParams.get('target')).toBe('clash');
            expect(dataSourceUrl.origin + dataSourceUrl.pathname).toBe('https://tsub.example/stable-token');
            expect(dataSourceUrl.searchParams.has('base64')).toBe(true);
            expect(dataSourceUrl.searchParams.get('callback_token')).toBe('external');
            expect(dataSourceUrl.searchParams.has('target')).toBe(false);
            expect(dataSourceUrl.searchParams.has('refresh')).toBe(false);
            expect(redirectUrl.searchParams.get('url')).not.toContain('trojan://pass0@example.com');
            const externalNodeCacheWrites = [...kvWrites.entries()].filter(([key]) => key.startsWith('tmp_external_nodes:'));
            expect(externalNodeCacheWrites).toHaveLength(0);
            expect(response.headers.get('X-TSub-Mode')).toBe('external-redirect-v2');
        } finally {
            logSpy.mockRestore();
        }
    });

    it.each([
        ['bare default backend', 'subapi.cmliussss.net', 'https://subapi.cmliussss.net/sub'],
        ['legacy default backend URL', 'https://subapi.cmliussss.net/sub?', 'https://subapi.cmliussss.net/sub'],
        ['FatSheep backend host', 'api.v1.mk', 'https://api.v1.mk/sub'],
        ['FatSheep legacy URL', 'https://api.v1.mk/sub?', 'https://api.v1.mk/sub']
    ])('normalizes %s for external converter redirects', async (_label, backend, expectedEndpoint) => {
        const subscriptions = [{
            id: 'sub-a',
            name: 'Airport A',
            url: 'https://airport.example/sub',
            enabled: true
        }];
        const adapter = createStorageAdapter({
            settings: {
                mytoken: 'stable-token',
                enableFlagEmoji: false,
                enableTrafficNode: false,
                subconverter: { engineMode: 'external', defaultBackend: backend }
            },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 })));

        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=clash&refresh=1', {
                    headers: { 'User-Agent': 'ClashMeta' }
                }),
                env: {},
                waitUntil: vi.fn()
            });
            const redirectUrl = new URL(response.headers.get('Location'));
            const dataSourceUrl = new URL(redirectUrl.searchParams.get('url'));

            expect(response.status).toBe(302);
            expect(redirectUrl.origin + redirectUrl.pathname).toBe(expectedEndpoint);
            expect(redirectUrl.searchParams.get('target')).toBe('clash');
            expect(dataSourceUrl.origin + dataSourceUrl.pathname).toBe('https://tsub.example/stable-token');
            expect(dataSourceUrl.searchParams.has('base64')).toBe(true);
            expect(dataSourceUrl.searchParams.get('callback_token')).toBe('external');
            expect(dataSourceUrl.searchParams.has('target')).toBe(false);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[TSub Request]'));
            expect(logSpy).toHaveBeenCalledWith('[TSub Nodes] Count/Length: 51');
        } finally {
            logSpy.mockRestore();
        }
    });

    it('returns current fetch traffic header on the first builtin response', async () => {
        const subscriptions = [{
            id: 'sub-a',
            name: 'Airport A',
            url: 'https://airport.example/sub',
            enabled: true,
            userInfo: null
        }];
        const adapter = createStorageAdapter({
            settings: { mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: false },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', {
            status: 200,
            headers: {
                'subscription-userinfo': 'upload=10; download=20; total=1000; expire=2000'
            }
        })));

        const waitUntilPromises = [];
        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=clash&refresh=1&builtin=true', {
                    headers: { 'User-Agent': 'ClashMeta' }
                }),
                env: {},
                waitUntil: promise => waitUntilPromises.push(promise)
            });
            const text = await response.text();

            expect(response.status).toBe(200);
            expect(text).toContain('proxies:');
            expect(response.headers.get('Subscription-Userinfo')).toBe('upload=10; download=20; total=1000; expire=2000');
            expect(waitUntilPromises.length).toBeGreaterThan(0);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[TSub Request]'));
            expect(logSpy).toHaveBeenCalledWith('[TSub Nodes] Count/Length: 51');
        } finally {
            logSpy.mockRestore();
        }
    });

    it('keeps unlimited VPS traffic visible when the upstream total is zero', async () => {
        const subscriptions = [{ id: 'vps-sub', name: 'VPS', url: 'http://203.0.113.8:51250/cgi-bin/token', enabled: true }];
        const adapter = createStorageAdapter({
            settings: { mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: false },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', {
            status: 200,
            headers: { 'subscription-userinfo': 'upload=125; download=240; total=0; expire=0' }
        })));
        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=nodes&refresh=1', { headers: { 'User-Agent': 'ClashMeta' } }),
                env: {}, waitUntil: vi.fn()
            });
            expect(response.headers.get('Subscription-Userinfo')).toBe('upload=125; download=240; total=0; expire=0');
        } finally {
            logSpy.mockRestore();
        }
    });

    it('adds upload and download nodes without a quota for legacy enabled settings', async () => {
        const subscriptions = [{ id: 'vps-sub', name: 'Server', url: 'https://server.example/sub', enabled: true }];
        const adapter = createStorageAdapter({
            settings: { mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: true },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#Node', {
            status: 200,
            headers: { 'subscription-userinfo': 'upload=125; download=240; total=0; expire=0' }
        })));
        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=nodes&refresh=1', { headers: { 'User-Agent': 'ClashMeta' } }),
                env: {}, waitUntil: vi.fn()
            });
            const content = await response.text();
            expect(content).toMatch(/^vmess:\/\//m);
            expect(extractTrafficNodeNames(content)).toEqual(['↑ 125 B · ↓ 240 B']);
        } finally {
            logSpy.mockRestore();
        }
    });

    it('applies metric combinations, label styles, quotas and excludeTraffic', async () => {
        const subscriptions = [
            { id: 'included', name: 'Included', url: 'https://included.example/sub', enabled: true, trafficQuotaOverrideBytes: 2000 },
            { id: 'excluded', name: 'Excluded', url: 'https://excluded.example/sub', enabled: true, excludeTraffic: true }
        ];
        const adapter = createStorageAdapter({
            settings: {
                mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: true,
                trafficNodeDisplay: {
                    layout: 'two',
                    upload: { enabled: false, label: 'symbol' },
                    download: { enabled: true, label: 'custom', customLabel: '下载' },
                    total: { enabled: true, label: 'full' },
                    remaining: { enabled: true, label: 'custom', customLabel: '可用' }
                }
            },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async input => {
            const excluded = String(input).includes('excluded.example');
            return new Response(`trojan://pass@${excluded ? 'excluded' : 'included'}.example:443#Node`, {
                status: 200,
                headers: { 'subscription-userinfo': excluded
                    ? 'upload=10000; download=20000; total=100000; expire=0'
                    : 'upload=100; download=200; total=1000; expire=0' }
            });
        }));
        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=nodes&refresh=1', { headers: { 'User-Agent': 'ClashMeta' } }),
                env: {}, waitUntil: vi.fn()
            });
            expect(extractTrafficNodeNames(await response.text())).toEqual([
                '下载 200 B', '总计流量 1.95 KB · 可用 1.66 KB'
            ]);
            expect(response.headers.get('Subscription-Userinfo')).toBe('upload=100; download=200; total=2000; expire=0');
        } finally {
            logSpy.mockRestore();
        }
    });

    it.each([
        ['one', ['上传 1 KB · ↓ 2 KB · 总额度 10 KB · REM 7 KB']],
        ['four', ['上传 1 KB', '↓ 2 KB', '总额度 10 KB', 'REM 7 KB']]
    ])('generates the expected virtual node count for %s-row layout', async (layout, expectedNames) => {
        const subscriptions = [{ id: 'sub-a', name: 'Airport', url: 'https://airport.example/sub', enabled: true }];
        const adapter = createStorageAdapter({
            settings: {
                mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: true,
                trafficNodeDisplay: {
                    layout,
                    upload: { enabled: true, label: 'custom', customLabel: '上传' }, download: { enabled: true, label: 'symbol' },
                    total: { enabled: true, label: 'custom', customLabel: '总额度' }, remaining: { enabled: true, label: 'symbol' }
                }
            },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#Node', {
            status: 200,
            headers: { 'subscription-userinfo': 'upload=1024; download=2048; total=10240; expire=0' }
        })));
        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=nodes&refresh=1', { headers: { 'User-Agent': 'ClashMeta' } }),
                env: {}, waitUntil: vi.fn()
            });
            expect(extractTrafficNodeNames(await response.text())).toEqual(expectedNames);
        } finally {
            logSpy.mockRestore();
        }
    });

    it.each([
        ['base64', 'v2rayN'],
        ['clash', 'ClashMeta']
    ])('keeps traffic nodes in %s output', async (target, userAgent) => {
        const subscriptions = [{ id: 'sub-a', name: 'Airport', url: 'https://airport.example/sub', enabled: true }];
        const adapter = createStorageAdapter({
            settings: { mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: true },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#Node', {
            status: 200,
            headers: { 'subscription-userinfo': 'upload=1024; download=2048; total=10240; expire=0' }
        })));
        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request(`https://tsub.example/stable-token?target=${target}&refresh=1`, { headers: { 'User-Agent': userAgent } }),
                env: {}, waitUntil: vi.fn()
            });
            const raw = await response.text();
            const decodedOutput = target === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw;
            const content = target === 'base64' ? decodeURIComponent(decodedOutput) : decodedOutput;
            if (target === 'base64') {
                expect(extractTrafficNodeNames(content)).toEqual(['↑ 1 KB · ↓ 2 KB', 'TOT 10 KB · REM 7 KB']);
            } else {
                expect(content).toContain('↑ 1 KB · ↓ 2 KB');
                expect(content).toContain('TOT 10 KB · REM 7 KB');
            }
            expect(response.headers.get('Subscription-Userinfo')).toBe('upload=1024; download=2048; total=10240; expire=0');
            expect(response.headers.get('Profile-Update-Interval')).toBe('24');
        } finally {
            logSpy.mockRestore();
        }
    });

    it('does not return stale traffic header when current external pull has zero nodes with protective cache disabled', async () => {
        const subscriptions = [{
            id: 'sub-a',
            name: 'Airport A',
            url: 'https://airport.example/sub',
            enabled: true,
            enableNodeCache: false,
            nodeCount: 86,
            userInfo: { upload: 10, download: 20, total: 1000, expire: 2000 }
        }];
        const adapter = createStorageAdapter({
            settings: { mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: false },
            subscriptions
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));

        const waitUntilPromises = [];
        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/stable-token?target=nodes&refresh=1', {
                    headers: { 'User-Agent': 'ClashMeta' }
                }),
                env: {},
                waitUntil: promise => waitUntilPromises.push(promise)
            });
            const text = await response.text();

            expect(response.status).toBe(200);
            expect(text.trim()).toBe('');
            expect(response.headers.get('Subscription-Userinfo')).toBeNull();
            expect(waitUntilPromises.length).toBeGreaterThan(0);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[TSub Request]'));
            expect(logSpy).toHaveBeenCalledWith('[TSub Nodes] Count/Length: 0');

            await Promise.all(waitUntilPromises);

            const [updatedSub] = adapter.store.get('tsub_subscriptions_v1');
            expect(updatedSub.nodeCount).toBe(0);
            expect(updatedSub.userInfo).toBeNull();
        } finally {
            logSpy.mockRestore();
        }
    });


    it('serves disguise content before token validation for unauthenticated browser subscription visits', async () => {
        const adapter = createStorageAdapter({
            settings: {
                mytoken: 'stable-token',
                enableFlagEmoji: false,
                enableTrafficNode: false,
                disguise: { enabled: true, type: 'notfound' }
            },
            subscriptions: [{
                id: 'sub-a',
                name: 'Airport A',
                url: 'https://airport.example/sub',
                enabled: true
            }]
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 })));

        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request('https://tsub.example/wrong-token?target=nodes', {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
                        Accept: 'text/html'
                    }
                }),
                env: {},
                waitUntil: vi.fn()
            });
            const text = await response.text();

            expect(response.status).toBe(404);
            expect(response.headers.get('Content-Type')).toContain('text/html');
            expect(text).not.toContain('Invalid Token');
            expect(text).not.toContain('trojan://pass@example.com');
            expect(globalThis.fetch).not.toHaveBeenCalled();
        } finally {
            logSpy.mockRestore();
        }
    });

    it.each(['refresh', 'nocache', 'debug'])('bypasses fresh aggregate cache when %s is present', async (paramName) => {
        const subscriptions = [{
            id: 'sub-a',
            name: 'Airport A',
            url: 'https://airport.example/sub',
            enabled: true
        }];
        const adapter = createStorageAdapter({
            settings: { mytoken: 'stable-token', enableFlagEmoji: false, enableTrafficNode: false },
            subscriptions
        });
        adapter.store.set('node_cache_token_stable-token', {
            nodes: 'trojan://cached@example.com:443#Cached\n',
            timestamp: Date.now(),
            nodeCount: 1,
            sources: ['Airport A']
        });
        createAdapter.mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://fresh@example.com:443#Fresh', { status: 200 })));

        const logSpy = silenceExpectedRequestLogs();
        try {
            const { handleTsubRequest } = await import('../../functions/modules/subscription/main-handler.js');
            const response = await handleTsubRequest({
                request: new Request(`https://tsub.example/stable-token?target=nodes&${paramName}=1`, {
                    headers: { 'User-Agent': 'ClashMeta' }
                }),
                env: {},
                waitUntil: vi.fn()
            });
            const text = await response.text();

            expect(response.status).toBe(200);
            expect(text).toContain('trojan://fresh@example.com:443#');
            expect(text).not.toContain('trojan://cached@example.com:443#');
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        } finally {
            logSpy.mockRestore();
        }
    });
});

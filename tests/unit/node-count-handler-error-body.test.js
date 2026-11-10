import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNodeCountRequest } from '../../functions/modules/handlers/node-handler.js';
import { StorageFactory } from '../../functions/storage-adapter.js';
import { buildSubscriptionNodeCacheKey } from '../../functions/services/subscription-service.js';

function createAdapter({ settings = {}, subscriptions = [] } = {}) {
    const store = new Map([
        ['worker_settings_v1', settings],
        ['tsub_subscriptions_v1', subscriptions]
    ]);
    return {
        get: vi.fn(async key => store.get(key)),
        put: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        updateSubscriptionById: vi.fn(async (id, updater) => {
            const all = store.get('tsub_subscriptions_v1') || [];
            const index = all.findIndex(item => item.id === id);
            if (index === -1) return false;
            all[index] = updater(all[index]);
            store.set('tsub_subscriptions_v1', all);
            return true;
        }),
        store
    };
}

describe('handleNodeCountRequest error body handling', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('treats HTTP 200 upstream error text as a failed manual node update', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const errorText = 'failed to fetch remote profile with status 400 Bad Request';
        const adapter = createAdapter({
            settings: { builtinSkipCertVerify: false },
            subscriptions: [{ id: 'sub-a', url: 'https://airport.example/sub' }]
        });
        vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('kv');
        vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(adapter);

        vi.stubGlobal('fetch', vi.fn(async () => new Response(errorText, { status: 200 })));

        const request = new Request('http://local/api/node_count', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://airport.example/sub' })
        });

        try {
            const response = await handleNodeCountRequest(request, {});
            const data = await response.json();

            expect(data.success).toBe(false);
            expect(data.errorType).toBe('server');
            expect(data.error).toContain('HTTP 400');
            expect(data.count).toBe(0);
            const logs = JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls]);
            expect(logs).toContain('HTTP 400');
            expect(logs).toContain('airport.example');
            expect(logs).not.toContain(errorText);
            expect(logs).not.toContain('https://airport.example/sub');
            expect(adapter.updateSubscriptionById).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    it('preserves the existing subscription cache when the refresh response is an error body', async () => {
        const subscription = { id: 'sub-preserve', url: 'https://airport.example/sub', enableNodeCache: true };
        const adapter = createAdapter({ settings: {}, subscriptions: [subscription] });
        const previousCache = { nodes: ['trojan://cached@example.com:443#Cached'], nodeCount: 1 };
        adapter.store.set(buildSubscriptionNodeCacheKey(subscription), previousCache);
        vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('kv');
        vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('failed to fetch remote profile with status 400 Bad Request', { status: 200 })));

        const response = await handleNodeCountRequest(new Request('http://local/api/node_count', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: subscription.url })
        }), {});

        expect((await response.json()).success).toBe(false);
        expect(adapter.store.get(buildSubscriptionNodeCacheKey(subscription))).toEqual(previousCache);
    });

    it('does not skip certificate verification for node count by default', async () => {
        const adapter = createAdapter({
            settings: { builtinSkipCertVerify: false },
            subscriptions: [{ id: 'sub-a', url: 'https://airport.example/sub' }]
        });
        vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('kv');
        vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(adapter);

        const fetchSpy = vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);

        const request = new Request('http://local/api/node_count', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://airport.example/sub' })
        });

        const response = await handleNodeCountRequest(request, {});
        const data = await response.json();

        expect(data.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        for (const [, options] of fetchSpy.mock.calls) {
            expect(options?.cf?.insecureSkipVerify).not.toBe(true);
        }
    });

    it('only skips certificate verification for node count when enabled in settings', async () => {
        const adapter = createAdapter({
            settings: { builtinSkipCertVerify: true },
            subscriptions: [{ id: 'sub-a', url: 'https://airport.example/sub' }]
        });
        vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('kv');
        vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(adapter);

        const fetchSpy = vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);

        const request = new Request('http://local/api/node_count', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://airport.example/sub' })
        });

        const response = await handleNodeCountRequest(request, {});
        const data = await response.json();

        expect(data.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        for (const [, options] of fetchSpy.mock.calls) {
            expect(options?.cf?.insecureSkipVerify).toBe(true);
        }
    });

    it('writes parsed nodes to the subscription cache when protective caching is enabled', async () => {
        const subscription = { id: 'sub-cache', name: '魔戒', url: 'https://airport.example/sub', enableNodeCache: true };
        const adapter = createAdapter({
            settings: { builtinSkipCertVerify: false },
            subscriptions: [subscription]
        });
        vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('kv');
        vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 })));

        const response = await handleNodeCountRequest(new Request('http://local/api/node_count', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: subscription.url })
        }), {});

        expect((await response.json()).success).toBe(true);
        expect(adapter.store.get(buildSubscriptionNodeCacheKey(subscription))).toMatchObject({
            nodes: ['trojan://pass@example.com:443#HK'], nodeCount: 1, sourceId: 'sub-cache', sourceName: '魔戒'
        });
    });

    it('does not write a subscription cache when protective caching is disabled', async () => {
        const subscription = { id: 'sub-no-cache', name: 'No cache', url: 'https://airport.example/sub', enableNodeCache: false };
        const adapter = createAdapter({ settings: {}, subscriptions: [subscription] });
        vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('kv');
        vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(adapter);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 })));

        await handleNodeCountRequest(new Request('http://local/api/node_count', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: subscription.url })
        }), {});

        expect(adapter.store.has(buildSubscriptionNodeCacheKey(subscription))).toBe(false);
    });
});

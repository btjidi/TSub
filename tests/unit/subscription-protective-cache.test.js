import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildSubscriptionNodeCacheKey,
    generateCombinedNodeList,
    isRealProxyNode,
    parseSubscriptionUserInfoHeader
} from '../../functions/services/subscription-service.js';

function createMemoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        store,
        async get(key) {
            return store.has(key) ? store.get(key) : null;
        },
        async put(key, value) {
            store.set(key, value);
            return true;
        },
        async delete(key) {
            store.delete(key);
            return true;
        }
    };
}

describe('subscription protective node cache', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('识别真实代理节点，排除系统伪节点', () => {
        expect(isRealProxyNode('trojan://pass@example.com:443#HK')).toBe(true);
        expect(isRealProxyNode('vmess://eyJhZGQiOiJleGFtcGxlLmNvbSJ9')).toBe(true);
        expect(isRealProxyNode('127.0.0.1:8080#剩余流量')).toBe(false);
        expect(isRealProxyNode('到期时间：2099-01-01')).toBe(false);
        expect(isRealProxyNode('')).toBe(false);
    });

    it('解析机场返回的 subscription-userinfo 响应头', () => {
        expect(parseSubscriptionUserInfoHeader('upload=1; download=2; total=100; expire=200')).toEqual({
            upload: 1,
            download: 2,
            total: 100,
            expire: 200
        });
        expect(parseSubscriptionUserInfoHeader('')).toBeNull();
    });

    it('enableNodeCache 开启时，成功拉取真实节点后写入单机场缓存', async () => {
        const storage = createMemoryStorage();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 })));

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [{ id: 'sub-a', name: '机场A', url: 'https://example.com/sub', enabled: true, enableNodeCache: true }],
            '',
            { enableSubscriptions: false },
            false
        );

        const cache = await storage.get(buildSubscriptionNodeCacheKey({ id: 'sub-a', url: 'https://example.com/sub' }));
        expect(result.trim()).toBe('trojan://pass@example.com:443#HK');
        expect(cache.nodes).toEqual(['trojan://pass@example.com:443#HK']);
        expect(cache.nodeCount).toBe(1);
    });

    it('enableNodeCache 开启且拉取失败时，使用该机场上次成功缓存', async () => {
        const storage = createMemoryStorage({
            [buildSubscriptionNodeCacheKey({ id: 'sub-a', url: 'https://example.com/sub' })]: {
                nodes: ['trojan://cached@example.com:443#Cached'],
                nodeCount: 1,
                updatedAt: '2026-01-01T00:00:00.000Z'
            }
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [{ id: 'sub-a', name: '机场A', url: 'https://example.com/sub', enabled: true, enableNodeCache: true }],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('trojan://cached@example.com:443#Cached');
    });

    it('enableNodeCache 开启时，新结果只有伪节点不得覆盖旧缓存，并 fallback 旧缓存', async () => {
        const cacheKey = buildSubscriptionNodeCacheKey({ id: 'sub-a', url: 'https://example.com/sub' });
        const storage = createMemoryStorage({
            [cacheKey]: {
                nodes: ['trojan://cached@example.com:443#Cached'],
                nodeCount: 1,
                updatedAt: '2026-01-01T00:00:00.000Z'
            }
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('127.0.0.1:8080#剩余流量', { status: 200 })));

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [{ id: 'sub-a', name: '机场A', url: 'https://example.com/sub', enabled: true, enableNodeCache: true }],
            '',
            { enableSubscriptions: false },
            false
        );

        const cache = await storage.get(cacheKey);
        expect(result.trim()).toBe('trojan://cached@example.com:443#Cached');
        expect(cache.nodes).toEqual(['trojan://cached@example.com:443#Cached']);
    });

    it('外部拉取成功时，异步同步节点数和流量到前端订阅数据', async () => {
        const sub = { id: 'sub-a', name: '机场A', url: 'https://example.com/sub', enabled: true, enableNodeCache: true };
        const storage = createMemoryStorage({
            tsub_subscriptions_v1: [{ ...sub, nodeCount: 0, userInfo: null }]
        });
        const waitUntilPromises = [];
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://pass@example.com:443#HK', {
            status: 200,
            headers: {
                'subscription-userinfo': 'upload=1; download=2; total=100; expire=200'
            }
        })));
        const context = {
            storage,
            waitUntil: promise => waitUntilPromises.push(promise)
        };

        const result = await generateCombinedNodeList(
            context,
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [sub],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('trojan://pass@example.com:443#HK');
        expect(waitUntilPromises).toHaveLength(1);
        expect(context.currentSubscriptionRuntimeInfo[sub.id].userInfo).toEqual({
            upload: 1,
            download: 2,
            total: 100,
            expire: 200
        });

        await Promise.all(waitUntilPromises);

        const [updatedSub] = await storage.get('tsub_subscriptions_v1');
        expect(updatedSub.nodeCount).toBe(1);
        expect(updatedSub.userInfo).toEqual({
            upload: 1,
            download: 2,
            total: 100,
            expire: 200
        });
        expect(updatedSub.lastError).toBeNull();
        expect(typeof updatedSub.lastUpdate).toBe('string');
    });

    it('does not overwrite authoritative deployment snapshots with a profile-filtered result', async () => {
        const sub = {
            id: 'tsub_airport_deploy-1',
            name: 'Managed push',
            url: 'https://controller.example/api/deploy/subscriptions/deploy-1/token',
            enabled: true,
            enableNodeCache: true,
            nodeCount: 2,
            source: { kind: 'tsub-deployment-push', deploymentId: 'deploy-1' }
        };
        const cacheKey = buildSubscriptionNodeCacheKey(sub);
        const originalNodes = [
            'trojan://first@example.com:443#First',
            'trojan://second@example.com:443#Second'
        ];
        const storage = createMemoryStorage({
            [cacheKey]: { nodes: originalNodes, nodeCount: 2, sequence: 8, pushGeneration: 'generation-1' },
            tsub_subscriptions_v1: [{ ...sub }]
        });
        const waitUntilPromises = [];
        vi.stubGlobal('fetch', vi.fn(async () => new Response('trojan://filtered@example.com:443#Filtered', {
            status: 200,
            headers: { 'subscription-userinfo': 'upload=9; download=10; total=100' }
        })));

        const result = await generateCombinedNodeList(
            { storage, waitUntil: promise => waitUntilPromises.push(promise) },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [sub],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('trojan://filtered@example.com:443#Filtered');
        expect(await storage.get(cacheKey)).toEqual({ nodes: originalNodes, nodeCount: 2, sequence: 8, pushGeneration: 'generation-1' });
        expect(waitUntilPromises).toHaveLength(0);
        const [storedSubscription] = await storage.get('tsub_subscriptions_v1');
        expect(storedSubscription.nodeCount).toBe(2);
        expect(storedSubscription).not.toHaveProperty('userInfo');
    });

    it('enableNodeCache 关闭时，拉取失败不使用旧缓存', async () => {
        const storage = createMemoryStorage({
            [buildSubscriptionNodeCacheKey({ id: 'sub-a', url: 'https://example.com/sub' })]: {
                nodes: ['trojan://cached@example.com:443#Cached'],
                nodeCount: 1,
                updatedAt: '2026-01-01T00:00:00.000Z'
            }
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [{ id: 'sub-a', name: '机场A', url: 'https://example.com/sub', enabled: true, enableNodeCache: false }],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('');
    });

    it('clears stored runtime info when protective node cache is disabled and external fetch fails', async () => {
        const sub = {
            id: 'sub-a',
            name: 'Airport A',
            url: 'https://example.com/sub',
            enabled: true,
            enableNodeCache: false,
            nodeCount: 86,
            userInfo: { upload: 1, download: 2, total: 100, expire: 200 }
        };
        const storage = createMemoryStorage({
            tsub_subscriptions_v1: [{ ...sub }]
        });
        const waitUntilPromises = [];
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));
        const context = {
            storage,
            waitUntil: promise => waitUntilPromises.push(promise)
        };

        const result = await generateCombinedNodeList(
            context,
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [sub],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('');
        expect(context.currentSubscriptionRuntimeInfo[sub.id]).toEqual({
            nodeCount: 0,
            userInfo: null
        });
        expect(waitUntilPromises).toHaveLength(1);

        await Promise.all(waitUntilPromises);

        const [updatedSub] = await storage.get('tsub_subscriptions_v1');
        expect(updatedSub.nodeCount).toBe(0);
        expect(updatedSub.userInfo).toBeNull();
        expect(updatedSub.lastError).toBeNull();
        expect(typeof updatedSub.lastUpdate).toBe('string');
    });
});

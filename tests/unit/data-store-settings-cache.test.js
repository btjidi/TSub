import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { useSettingsStore } from '../../src/stores/settings.js';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function createStore() {
    setActivePinia(createPinia());
    return useDataStore();
}

describe('Data store settings cache', () => {
    beforeEach(() => {
        sessionStorage.clear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        sessionStorage.clear();
    });

    it('updates the session data cache config after saving settings', async () => {
        const initialData = {
            tsubs: [],
            profiles: [],
            ruleTemplates: [],
            config: {
                siteName: 'old site',
                enablePublicPage: false,
                transformConfig: 'https://example.com/old.ini'
            }
        };
        const nextSettings = {
            siteName: 'new site',
            enablePublicPage: true,
            transformConfig: 'https://example.com/new.ini'
        };

        vi.stubGlobal('fetch', vi.fn(async (url) => {
            if (url === '/api/settings') {
                return jsonResponse({ success: true });
            }
            throw new Error(`Unexpected request: ${url}`);
        }));

        const dataStore = createStore();
        expect(dataStore.hydrateFromData(initialData)).toBe(true);

        await dataStore.saveSettings(nextSettings);

        const cachedData = JSON.parse(sessionStorage.getItem('tsub_data_cache_v2'));
        expect(cachedData.config).toMatchObject(nextSettings);

        const reloadedStore = createStore();
        await reloadedStore.fetchData(false);

        const settingsStore = useSettingsStore();
        expect(settingsStore.config.siteName).toBe('new site');
        expect(settingsStore.config.enablePublicPage).toBe(true);
        expect(settingsStore.config.transformConfig).toBe('https://example.com/new.ini');
    });

    it('ignores the legacy cache after production data is reset', async () => {
        sessionStorage.setItem('tsub_data_cache', JSON.stringify({
            tsubs: [{ id: 'stale-source', url: 'https://stale.example/sub' }],
            profiles: [],
            ruleTemplates: [],
            config: {}
        }));
        sessionStorage.setItem('tsub_data_cache_ts', String(Date.now()));
        vi.stubGlobal('fetch', vi.fn(async url => {
            if (url === '/api/data') return jsonResponse({ tsubs: [], profiles: [], ruleTemplates: [], config: {} });
            throw new Error(`Unexpected request: ${url}`);
        }));

        const dataStore = createStore();
        await dataStore.fetchData(false);

        expect(dataStore.subscriptions).toEqual([]);
        expect(fetch).toHaveBeenCalledWith('/api/data', expect.any(Object));
    });
});

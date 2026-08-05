import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { useToastStore } from '../../src/stores/toast.js';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createStore(mode = 'manual', silentSuccess = true) {
  setActivePinia(createPinia());
  const store = useDataStore();
  store.hydrateFromData({ tsubs: [], profiles: [], ruleTemplates: [], config: { dataCommitMode: mode, directCommitSilentSuccess: silentSuccess } });
  return store;
}

describe('Data store direct submission mode', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('keeps the existing dirty prompt flow in manual mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = createStore('manual');

    store.addSubscription({ id: 'manual-1', name: 'Manual', url: 'https://example.com/sub' });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.isDirty).toBe(true);
    expect(store.directCommitFailed).toBe(false);
  });

  it('submits a complete action immediately and caches only the accepted response', async () => {
    const fetchMock = vi.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      return response({ success: true, data: payload });
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = createStore('direct');

    store.addSubscription({ id: 'direct-1', name: 'Direct', url: 'https://example.com/sub' });

    await vi.waitFor(() => expect(store.isDirty).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tsubs');
    expect(store.saveState).toBe('idle');
    expect(useToastStore().toasts).toHaveLength(0);
    const cached = JSON.parse(sessionStorage.getItem('tsub_data_cache_v2'));
    expect(cached.tsubs).toEqual([expect.objectContaining({ id: 'direct-1' })]);
  });

  it('shows the existing success notice when silent direct submission is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      return response({ success: true, data: payload });
    }));
    const store = createStore('direct', false);

    store.addSubscription({ id: 'visible-success', name: 'Visible', url: 'https://example.com/sub' });

    await vi.waitFor(() => expect(store.isDirty).toBe(false));
    expect(store.saveState).toBe('idle');
    expect(useToastStore().toasts).toEqual([
      expect.objectContaining({ type: 'success' })
    ]);
  });

  it('serializes consecutive submissions without replacing newer local changes', async () => {
    const first = deferred();
    const second = deferred();
    const payloads = [];
    const fetchMock = vi.fn((_url, options) => {
      payloads.push(JSON.parse(options.body));
      return payloads.length === 1 ? first.promise : second.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = createStore('direct');

    store.addSubscription({ id: 'queued-1', name: 'First', url: 'https://example.com/sub' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    store.updateSubscription('queued-1', { name: 'Second' });
    first.resolve(response({ success: true, data: payloads[0] }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(store.subscriptions[0].name).toBe('Second');
    expect(payloads[1].tsubs[0].name).toBe('Second');
    second.resolve(response({ success: true, data: payloads[1] }));
    await vi.waitFor(() => expect(store.isDirty).toBe(false));
  });

  it('keeps failed direct changes out of the browser cache and allows manual retry', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (_url, options) => {
      attempt += 1;
      if (attempt === 1) return response({ message: 'temporary failure' }, 500);
      const payload = JSON.parse(options.body);
      return response({ success: true, data: payload });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore('direct');
    const cachedBefore = sessionStorage.getItem('tsub_data_cache_v2');

    store.addSubscription({ id: 'failed-1', name: 'Retry', url: 'https://example.com/sub' });
    await vi.waitFor(() => expect(store.directCommitFailed).toBe(true));

    expect(store.isDirty).toBe(true);
    expect(sessionStorage.getItem('tsub_data_cache_v2')).toBe(cachedBefore);
    await store.saveData();
    expect(store.isDirty).toBe(false);
    expect(store.directCommitFailed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

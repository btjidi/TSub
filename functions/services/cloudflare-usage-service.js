import { StorageFactory } from '../storage-adapter.js';
import { KV_KEY_SETTINGS } from '../modules/config.js';
import { createJsonResponse, JSON_BODY_LIMITS, readJsonWithLimit } from '../modules/utils.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const GRAPHQL_URL = `${API_BASE}/graphql`;
const CACHE_FRESH_MS = 5 * 60 * 1000;
const CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const memoryCache = new Map();

export const CLOUDFLARE_FREE_LIMITS = Object.freeze({
  d1: { rowsReadDaily: 5_000_000, rowsWrittenDaily: 100_000, storageBytes: 5_000_000_000, databaseStorageBytes: 500_000_000 },
  kv: { readsDaily: 100_000, writesDaily: 1_000, deletesDaily: 1_000, listsDaily: 1_000, storageBytes: 1_000_000_000 }
});

function clean(value, max = 512) { return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max); }
function validAccountId(value) { return /^[a-f0-9]{32}$/i.test(value); }
function validResourceId(value) { return /^[a-f0-9-]{32,36}$/i.test(value); }
function tokenHeaders(token) { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }
function statusCode(error) { return Number(error?.status || 0); }
function permissionState(result) {
  if (result.status === 'fulfilled') return { ok: true };
  const status = statusCode(result.reason);
  return { ok: false, error: status === 401 ? 'invalid_token' : status === 403 ? 'permission_required' : 'cloudflare_unavailable' };
}

async function cloudflareFetch(url, token, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, headers: { ...tokenHeaders(token), ...(init.headers || {}) }, signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error('Cloudflare request failed'), { status: response.status });
    const body = await response.json();
    if (body?.success === false || body?.errors?.length) throw Object.assign(new Error('Cloudflare request failed'), { status: url === GRAPHQL_URL ? 403 : 502 });
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('Cloudflare request timed out'), { status: 504 });
    throw error;
  } finally { clearTimeout(timeout); }
}

async function listPaged(path, token) {
  const items = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const body = await cloudflareFetch(`${API_BASE}${path}${separator}page=${page}&per_page=100`, token);
    items.push(...(Array.isArray(body.result) ? body.result : []));
    const totalPages = Number(body.result_info?.total_pages || 1);
    if (page >= totalPages) break;
  }
  return items;
}

async function analyticsQuery(accountId, token, query) {
  const body = await cloudflareFetch(GRAPHQL_URL, token, { method: 'POST', body: JSON.stringify({ query }) });
  if (body.errors?.length || !body.data?.viewer?.accounts?.[0]) throw Object.assign(new Error('Analytics unavailable'), { status: 403 });
  return body.data.viewer.accounts[0];
}

async function readConfig(env) {
  const storageType = await StorageFactory.getStorageType(env);
  const storage = StorageFactory.createAdapter(env, storageType);
  return (await storage.get(KV_KEY_SETTINGS))?.cloudflareUsage || {};
}

function resolveCredentials(input, saved) {
  const accountId = clean(input?.accountId || saved?.accountId, 32);
  const apiToken = clean(input?.apiToken || saved?.apiToken, 1024);
  if (!validAccountId(accountId)) throw Object.assign(new Error('invalid_account_id'), { status: 400, code: 'invalid_account_id' });
  if (!apiToken) throw Object.assign(new Error('cloudflare_token_required'), { status: 400, code: 'cloudflare_token_required' });
  return { accountId, apiToken };
}

async function detectResources(accountId, token) {
  const analytics = analyticsQuery(accountId, token, `query { viewer { accounts(filter: {accountTag: "${accountId}"}) { d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: "${new Date().toISOString().slice(0, 10)}"}) { sum { rowsRead } } } } }`);
  const d1 = listPaged(`/accounts/${accountId}/d1/database`, token);
  const kv = listPaged(`/accounts/${accountId}/storage/kv/namespaces`, token);
  const [analyticsResult, d1Result, kvResult] = await Promise.allSettled([analytics, d1, kv]);
  return {
    checks: { analytics: permissionState(analyticsResult), d1: permissionState(d1Result), kv: permissionState(kvResult) },
    d1: d1Result.status === 'fulfilled' ? d1Result.value.map(item => ({ id: clean(item.uuid, 36), name: clean(item.name, 120) })) : [],
    kv: kvResult.status === 'fulfilled' ? kvResult.value.map(item => ({ id: clean(item.id, 36), name: clean(item.title, 120) })) : []
  };
}

export async function handleCloudflareResources(request, env) {
  if (env.TSUB_PLATFORM === 'server') return createJsonResponse({ success: false, error: 'cloudflare_platform_required' }, 409);
  try {
    const input = await readJsonWithLimit(request, JSON_BODY_LIMITS.small);
    const saved = await readConfig(env);
    const { accountId, apiToken } = resolveCredentials(input, saved);
    const result = await detectResources(accountId, apiToken);
    const allDenied = Object.values(result.checks).every(item => !item.ok && ['invalid_token', 'permission_required'].includes(item.error));
    return createJsonResponse({ success: true, data: { accountId, ...result } }, allDenied ? 403 : 200);
  } catch (error) {
    return createJsonResponse({ success: false, error: error.code || (statusCode(error) === 401 ? 'invalid_token' : 'cloudflare_resource_check_failed') }, error.status >= 400 && error.status < 500 ? error.status : 502);
  }
}

function utcDates(days) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => new Date(today.getTime() - (days - index - 1) * 86400000).toISOString().slice(0, 10));
}
function emptyDay(date) {
  return { date, d1: { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 }, kv: { read: 0, write: 0, delete: 0, list: 0 }, selected: { d1: { rowsRead: 0, rowsWritten: 0 }, kv: { read: 0, write: 0, delete: 0, list: 0 } } };
}
function add(target, source, keys) { for (const key of keys) target[key] += Number(source?.[key] || 0); }
function metric(used, limit) {
  const normalizedUsed = Math.max(0, Number(used || 0));
  const normalizedLimit = Math.max(1, Number(limit || 1));
  return { used: normalizedUsed, limit: normalizedLimit, remaining: Math.max(0, normalizedLimit - normalizedUsed), percent: normalizedUsed / normalizedLimit * 100, exceeded: normalizedUsed > normalizedLimit };
}
function normalizeLimits(value = {}) {
  const result = structuredClone(CLOUDFLARE_FREE_LIMITS);
  for (const section of ['d1', 'kv']) for (const key of Object.keys(result[section])) {
    const candidate = Number(value?.[section]?.[key]);
    if (Number.isSafeInteger(candidate) && candidate > 0) result[section][key] = candidate;
  }
  return result;
}

async function collectUsage(config, days) {
  const includeD1 = validResourceId(config.d1DatabaseId);
  const includeKv = validResourceId(config.kvNamespaceId);
  const dates = utcDates(days);
  const start = `${dates[0]}T00:00:00Z`;
  const end = new Date().toISOString();
  const analyticsFields = [
    includeD1 ? `d1AnalyticsAdaptiveGroups(limit: 10000, filter: {datetime_geq: "${start}", datetime_leq: "${end}"}) { dimensions { date databaseId } sum { rowsRead rowsWritten readQueries writeQueries } }` : '',
    includeKv ? `kvOperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: "${start}", datetime_leq: "${end}"}) { dimensions { date namespaceId actionType } sum { requests } }` : '',
    includeKv ? `kvStorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: "${dates.at(-1)}T00:00:00Z", datetime_leq: "${end}"}) { dimensions { namespaceId } max { byteCount keyCount } }` : ''
  ].filter(Boolean).join('\n');
  const query = `query { viewer { accounts(filter: {accountTag: "${config.accountId}"}) {
    ${analyticsFields}
  } } }`;
  const [analytics, databases] = await Promise.all([
    analyticsQuery(config.accountId, config.apiToken, query),
    includeD1 ? listPaged(`/accounts/${config.accountId}/d1/database`, config.apiToken) : Promise.resolve([])
  ]);
  const daily = Object.fromEntries(dates.map(date => [date, emptyDay(date)]));
  for (const row of analytics.d1AnalyticsAdaptiveGroups || []) {
    const day = daily[row.dimensions?.date]; if (!day) continue;
    add(day.d1, row.sum, ['rowsRead', 'rowsWritten', 'readQueries', 'writeQueries']);
    if (row.dimensions?.databaseId === config.d1DatabaseId) add(day.selected.d1, row.sum, ['rowsRead', 'rowsWritten']);
  }
  for (const row of analytics.kvOperationsAdaptiveGroups || []) {
    const day = daily[row.dimensions?.date]; const action = String(row.dimensions?.actionType || '').toLowerCase();
    if (!day || !Object.hasOwn(day.kv, action)) continue;
    day.kv[action] += Number(row.sum?.requests || 0);
    if (String(row.dimensions?.namespaceId || '').replace(/-/g, '') === String(config.kvNamespaceId || '').replace(/-/g, '')) day.selected.kv[action] += Number(row.sum?.requests || 0);
  }
  const kvStorage = (analytics.kvStorageAdaptiveGroups || []).map(row => ({ id: String(row.dimensions?.namespaceId || '').replace(/-/g, ''), bytes: Number(row.max?.byteCount || 0), keys: Number(row.max?.keyCount || 0) }));
  const d1Storage = databases.map(item => ({ id: item.uuid, bytes: Number(item.file_size || 0) }));
  const limits = normalizeLimits(config.limits);
  const today = daily[dates.at(-1)];
  const selectedD1Storage = d1Storage.find(item => item.id === config.d1DatabaseId)?.bytes || 0;
  const selectedKvStorage = kvStorage.find(item => item.id === String(config.kvNamespaceId || '').replace(/-/g, ''));
  const summary = {
    d1: {
      rowsRead: metric(today.d1.rowsRead, limits.d1.rowsReadDaily), rowsWritten: metric(today.d1.rowsWritten, limits.d1.rowsWrittenDaily),
      storage: metric(d1Storage.reduce((sum, item) => sum + item.bytes, 0), limits.d1.storageBytes),
      selected: { ...today.selected.d1, storageBytes: selectedD1Storage, storage: metric(selectedD1Storage, limits.d1.databaseStorageBytes) }
    },
    kv: {
      read: metric(today.kv.read, limits.kv.readsDaily), write: metric(today.kv.write, limits.kv.writesDaily), delete: metric(today.kv.delete, limits.kv.deletesDaily), list: metric(today.kv.list, limits.kv.listsDaily),
      storage: metric(kvStorage.reduce((sum, item) => sum + item.bytes, 0), limits.kv.storageBytes),
      accountKeyCount: kvStorage.reduce((sum, item) => sum + item.keys, 0),
      selected: { ...today.selected.kv, storageBytes: selectedKvStorage?.bytes || 0, keyCount: selectedKvStorage?.keys || 0 }
    }
  };
  return { period: { start: dates[0], end: dates.at(-1), timezone: 'UTC', nextResetAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString() }, summary, daily: Object.values(daily), limits, fetchedAt: new Date().toISOString(), stale: false };
}

function cacheKey(config, days) { return `${config.accountId}:${config.d1DatabaseId || '-'}:${config.kvNamespaceId || '-'}:${days}:${JSON.stringify(config.limits || {})}`; }
function cacheRequest(key) { return new Request(`https://tsub-cache.invalid/cloudflare-usage/${encodeURIComponent(key)}`); }
async function readUsageCache(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  try {
    const response = await globalThis.caches?.default?.match(cacheRequest(key));
    if (response) { const value = await response.json(); memoryCache.set(key, value); return value; }
  } catch {}
  return null;
}
async function writeUsageCache(key, value) {
  memoryCache.set(key, value);
  try {
    await globalThis.caches?.default?.put(cacheRequest(key), new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' } }));
  } catch {}
}

export async function handleCloudflareUsage(request, env) {
  if (env.TSUB_PLATFORM === 'server') return createJsonResponse({ success: false, error: 'cloudflare_platform_required' }, 409);
  try {
    const config = await readConfig(env);
    if (!config.enabled) return createJsonResponse({ success: false, error: 'cloudflare_usage_not_configured' }, 409);
    const { accountId, apiToken } = resolveCredentials({}, config);
    if (!validResourceId(config.d1DatabaseId) && !validResourceId(config.kvNamespaceId)) return createJsonResponse({ success: false, error: 'cloudflare_resource_required' }, 409);
    const requestedDays = Number(new URL(request.url).searchParams.get('days') || 7);
    const days = Number.isInteger(requestedDays) ? Math.min(7, Math.max(1, requestedDays)) : 7;
    const refresh = new URL(request.url).searchParams.get('refresh') === '1';
    const key = cacheKey(config, days); const cached = await readUsageCache(key); const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
    if (cached && (!refresh && age < CACHE_FRESH_MS || refresh && age < 60_000)) return createJsonResponse({ success: true, data: cached });
    try {
      const data = await collectUsage({ ...config, accountId, apiToken }, days); await writeUsageCache(key, data);
      return createJsonResponse({ success: true, data });
    } catch (error) {
      if (cached && age < CACHE_STALE_MS) return createJsonResponse({ success: true, data: { ...cached, stale: true } });
      throw error;
    }
  } catch (error) {
    const status = [400, 401, 403, 409].includes(statusCode(error)) ? statusCode(error) : 502;
    return createJsonResponse({ success: false, error: error.code || (status === 403 ? 'cloudflare_permission_required' : 'cloudflare_usage_unavailable') }, status);
  }
}

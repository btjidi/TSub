/**
 * API处理模块
 * 处理各种API请求
 */

import { StorageFactory, SettingsCache, STORAGE_TYPES } from '../storage-adapter.js';
import { getCookieSecret, getAdminCredentialMetadata, saveAdminCredentials, resetAdminCredentials, isUsingDefaultPassword, createJsonResponse, createErrorResponse, migrateProfileIds, JSON_BODY_LIMITS, readJsonWithLimit } from './utils.js';
import { authMiddleware, handleLogin, handleLogout, createUnauthorizedResponse } from './auth-middleware.js';
import { sendTgNotification, checkAndNotify } from './notifications.js';
import { clearAllNodeCaches } from '../services/node-cache-service.js';
import { buildSubscriptionNodeCacheKey } from '../services/subscription-service.js';
import { maybeRunScheduledTasks } from './scheduled-task-runner.js';

import { COOKIE_NAME, KV_KEY_SUBS, KV_KEY_PROFILES, KV_KEY_SETTINGS, DEFAULT_SETTINGS as defaultSettings } from './config.js';
import { listRuleTemplates } from './rule-template-handler.js';
import { isDemoView, readDemoData } from './demo-data-handler.js';
import { mergeSettingsUpdate, redactSettingsForClient } from './settings-secrets.js';
import { hasEnabledTrafficNode, normalizeTrafficNodeDisplay, validateTrafficNodeCustomLabels } from './traffic-node-settings.js';
import { validateTrafficQuotaOverride } from './traffic-quota.js';

const PROFILE_DOWNLOAD_COUNT_PREFIX = 'tsub_profile_download_count_';
const TRAFFIC_NODE_METRIC_NAMES = Object.freeze({
    upload: '上行流量',
    download: '下行流量',
    total: '总计流量',
    remaining: '剩余流量'
});
const MANAGED_SUBSCRIPTION_KINDS = new Set(['tsub-deployment-push', 'tsub-deployment-snapshot']);
const MANAGED_SUBSCRIPTION_EDITABLE_FIELDS = [
    'enabled', 'exclude', 'excludeTraffic', 'website', 'notes', 'trafficQuotaOverrideBytes'
];

function isManagedSubscription(item) {
    return MANAGED_SUBSCRIPTION_KINDS.has(item?.source?.kind);
}

function mergeManagedSubscriptionPreferences(current, submitted) {
    const merged = { ...current };
    for (const key of MANAGED_SUBSCRIPTION_EDITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(submitted, key)) merged[key] = submitted[key];
    }
    return merged;
}

function normalizeProfile(profile = {}) {
    const normalized = { ...profile };
    normalized.subscriptions = Array.isArray(profile.subscriptions) ? profile.subscriptions : [];
    normalized.manualNodes = Array.isArray(profile.manualNodes) ? profile.manualNodes : [];
    normalized.enabled = profile.enabled !== false;
    normalized.isPublic = profile.isPublic === true;
    normalized.downloadCount = Number(profile.downloadCount) || 0;
    return normalized;
}

function normalizeSettings(settings = {}) {
    const cloudflareUsage = settings.cloudflareUsage && typeof settings.cloudflareUsage === 'object' ? settings.cloudflareUsage : {};
    return {
        ...defaultSettings,
        ...settings,
        cloudflareUsage: {
            ...defaultSettings.cloudflareUsage,
            ...cloudflareUsage,
            limits: {
                d1: { ...defaultSettings.cloudflareUsage.limits.d1, ...(cloudflareUsage.limits?.d1 || {}) },
                kv: { ...defaultSettings.cloudflareUsage.limits.kv, ...(cloudflareUsage.limits?.kv || {}) }
            }
        },
        directCommitSilentSuccess: settings.directCommitSilentSuccess !== false,
        publicUrl: String(settings.publicUrl || '').trim(),
        trafficNodeDisplay: normalizeTrafficNodeDisplay(settings.trafficNodeDisplay)
    };
}

function resolveDataCommitMode(settings = {}, env = {}) {
    if (['manual', 'direct'].includes(settings.dataCommitMode)) return settings.dataCommitMode;
    return env.TSUB_PLATFORM === 'server' ? 'direct' : 'manual';
}

function withResolvedDataCommitMode(settings = {}, env = {}) {
    return { ...settings, dataCommitMode: resolveDataCommitMode(settings, env) };
}

function validateCloudflareUsage(value = {}, tokenConfigured = false) {
    if (!value || typeof value !== 'object') return null;
    const accountId = String(value.accountId || '').trim();
    const d1Id = String(value.d1DatabaseId || '').trim();
    const kvId = String(value.kvNamespaceId || '').trim();
    if (value.enabled) {
        if (!/^[a-f0-9]{32}$/i.test(accountId)) return 'Cloudflare 账号 ID 必须是 32 位十六进制字符';
        if (!value.apiToken && !tokenConfigured) return '请填写 Cloudflare API Token';
        if (!/^[a-f0-9-]{32,36}$/i.test(d1Id) && !/^[a-f0-9-]{32,36}$/i.test(kvId)) return '请至少选择一个 D1 数据库或 KV 命名空间';
    }
    for (const section of ['d1', 'kv']) for (const candidate of Object.values(value.limits?.[section] || {})) {
        if (!Number.isSafeInteger(Number(candidate)) || Number(candidate) <= 0) return 'Cloudflare 自定义额度必须是正整数';
    }
    return null;
}

async function attachProfileDownloadCounts(storageAdapter, profiles) {
    if (!Array.isArray(profiles) || profiles.length === 0) return profiles;

    const counts = await Promise.all(
        profiles.map(profile => storageAdapter.get(`${PROFILE_DOWNLOAD_COUNT_PREFIX}${profile.customId || profile.id}`))
    );

    return profiles.map((profile, index) => normalizeProfile({
        ...profile,
        downloadCount: Number(counts[index]) || Number(profile.downloadCount) || 0,
    }));
}

function isStorageUnavailableError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('kv storage is paused')
        || message.includes('storage is paused')
        || message.includes('namespace is paused');
}

/**
 * 获取存储适配器实例
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Object>} 存储适配器实例
 */
async function getStorageAdapter(env) {
    const storageType = await StorageFactory.getStorageType(env);
    return StorageFactory.createAdapter(env, storageType);
}

function isSimpleArrayDiff(diff) {
    if (!diff || typeof diff !== 'object') return false;
    const allowedKeys = ['added', 'updated', 'removed'];
    if (!Object.keys(diff).every(key => allowedKeys.includes(key))) return false;
    return ['added', 'updated', 'removed'].every(key => Array.isArray(diff[key] || []));
}

async function applyRowLevelDiff(storageAdapter, type, diff) {
    const isProfile = type === 'profiles';
    const putItem = isProfile ? storageAdapter.putProfile?.bind(storageAdapter) : storageAdapter.putSubscription?.bind(storageAdapter);
    const deleteItem = isProfile ? storageAdapter.deleteProfileById?.bind(storageAdapter) : storageAdapter.deleteSubscriptionById?.bind(storageAdapter);

    if (!putItem || !deleteItem || !isSimpleArrayDiff(diff)) {
        return false;
    }

    // KV 模式下不支持行级 Diff，必须使用全量覆盖以保证原子性
    if (storageAdapter.type === STORAGE_TYPES.KV) {
        return false;
    }

    const { added = [], updated = [], removed = [] } = diff;

    await Promise.all([
        ...added.map(item => putItem(item)),
        ...updated.map(item => putItem(item)),
        ...removed.map(id => deleteItem(id))
    ]);

    return true;
}

async function syncCollectionRowLevel(storageAdapter, type, finalItems) {
    const isProfile = type === 'profiles';
    const getAll = isProfile ? storageAdapter.getAllProfiles?.bind(storageAdapter) : storageAdapter.getAllSubscriptions?.bind(storageAdapter);
    const putItem = isProfile ? storageAdapter.putProfile?.bind(storageAdapter) : storageAdapter.putSubscription?.bind(storageAdapter);
    const deleteItem = isProfile ? storageAdapter.deleteProfileById?.bind(storageAdapter) : storageAdapter.deleteSubscriptionById?.bind(storageAdapter);

    if (!getAll || !putItem || !deleteItem || !Array.isArray(finalItems)) {
        return false;
    }

    // KV 模式下不支持行级同步，必须使用全量覆盖以保证原子性
    if (storageAdapter.type === STORAGE_TYPES.KV) {
        return false;
    }

    const currentItems = await getAll();
    const currentMap = new Map(currentItems.map(item => [item.id, item]));
    const finalMap = new Map(finalItems.map(item => [item.id, item]));

    const puts = [];
    const deletes = [];

    for (const item of finalItems) {
        const existing = currentMap.get(item.id);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(item)) {
            puts.push(putItem(item));
        }
    }

    for (const existing of currentItems) {
        if (!finalMap.has(existing.id)) {
            deletes.push(deleteItem(existing.id));
        }
    }

    await Promise.all([...puts, ...deletes]);
    return true;
}

/**
 * 处理数据获取API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleDataRequest(env, context = null, request = null) {
    let storageType = 'unknown';
    try {
        storageType = await StorageFactory.getStorageType(env);
        if (storageType === 'd1' && !env.TSUB_DB) {
            console.error('[API Error /data] D1 binding missing while storageType=d1');
        }
        if (storageType === 'kv' && !StorageFactory.resolveKV(env)) {
            console.error('[API Error /data] KV binding missing while storageType=kv');
        }
        const storageAdapter = StorageFactory.createAdapter(env, storageType);
        const cachedSettings = await SettingsCache.get(env);
        const [tsubs, rawProfiles, settings, ruleTemplates] = await Promise.all([
            typeof storageAdapter.getAllSubscriptions === 'function'
                ? storageAdapter.getAllSubscriptions()
                : storageAdapter.get(KV_KEY_SUBS).then(res => res || []),
            typeof storageAdapter.getAllProfiles === 'function'
                ? storageAdapter.getAllProfiles()
                : storageAdapter.get(KV_KEY_PROFILES).then(res => res || []),
            Promise.resolve(cachedSettings || {}).then(res => res || {}),
            listRuleTemplates(storageAdapter).catch(error => {
                console.warn('[API /data] Failed to load custom rule templates:', error?.message || error);
                return [];
            })
        ]);
        const profiles = await attachProfileDownloadCounts(storageAdapter, rawProfiles);
        const demoData = await readDemoData(storageAdapter).catch(() => null);
        const demoOnly = isDemoView(request);
        const managedTsubs = [...(demoOnly ? [] : tsubs), ...(demoData?.subscriptions || []), ...(demoData?.nodes || [])];
        const managedProfiles = [...(demoOnly ? [] : profiles), ...(demoData?.profiles || [])];

        // 自动迁移旧版 profile ID（去除 'profile_' 前缀）
        if (migrateProfileIds(profiles)) {
            storageAdapter.put(KV_KEY_PROFILES, profiles).catch(err =>
                console.error('[Migration] Failed to persist migrated profile IDs:', err)
            );
        }
        const config = demoOnly
            ? withResolvedDataCommitMode({
                ...defaultSettings,
                storageType,
                externalApi: { enabled: false, tokens: [] },
                isDefaultPassword: false
            }, env)
            : withResolvedDataCommitMode({
                ...normalizeSettings(settings),
                isDefaultPassword: await isUsingDefaultPassword(env)
            }, env);
        try {
            if (!demoOnly) {
                const taskContext = context || { env };
                const runPromise = maybeRunScheduledTasks(taskContext, { source: 'admin-api' });
                if (typeof taskContext.waitUntil !== 'function') {
                    runPromise.catch(error => console.warn('[ScheduledTasks] lazy check failed:', error?.message || error));
                }
            }
        } catch (taskError) {
            console.warn('[ScheduledTasks] lazy check init failed:', taskError?.message || taskError);
        }
        return createJsonResponse({ tsubs: managedTsubs, profiles: managedProfiles, ruleTemplates: demoOnly ? [] : ruleTemplates, config });
    } catch (e) {
        console.error('[API Error /data] Failed to read from storage', {
            error: e?.message,
            storageType,
            hasKv: !!StorageFactory.resolveKV(env),
            hasD1: !!env?.TSUB_DB
        });
        return createErrorResponse(e, 500);
    }
}

/**
 * 处理订阅和配置保存API
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
import { applyPatch } from './patch-utils.js';

// ... (existing imports)

/**
 * 处理订阅和配置保存API
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleTsubsSave(request, env) {
    try {
        // 步骤1: 解析请求体
        let requestData;
        try {
            requestData = await readJsonWithLimit(request, JSON_BODY_LIMITS.large);
        } catch (parseError) {
            console.error('[API Error /tsubs] JSON解析失败:', parseError);
            return createJsonResponse({
                success: false,
                message: parseError.status === 413 ? parseError.message : '请求数据格式错误，请检查数据格式'
            }, parseError.status || 400);
        }

        const { tsubs, profiles, diff } = requestData;
        const storageAdapter = await getStorageAdapter(env);

        let finalTsubs = tsubs;
        let finalProfiles = profiles;

        // 步骤1.5: 检查是否为 Diff 模式
        if (diff) {
            console.info('[API] Processing Diff Patch...');
            // 获取当前数据
            const [currentTsubs, currentProfiles] = await Promise.all([
                typeof storageAdapter.getAllSubscriptions === 'function'
                    ? storageAdapter.getAllSubscriptions()
                    : storageAdapter.get(KV_KEY_SUBS).then(res => res || []),
                typeof storageAdapter.getAllProfiles === 'function'
                    ? storageAdapter.getAllProfiles()
                    : storageAdapter.get(KV_KEY_PROFILES).then(res => res || [])
            ]);

            // 应用补丁
            if (diff.subscriptions) {
                finalTsubs = applyPatch(currentTsubs, diff.subscriptions);
            } else {
                finalTsubs = currentTsubs; // 无变动
            }

            if (diff.profiles) {
                finalProfiles = applyPatch(currentProfiles, diff.profiles);
            } else {
                finalProfiles = currentProfiles; // 无变动
            }

            if (!Array.isArray(finalTsubs) || !Array.isArray(finalProfiles)) {
                return createJsonResponse({
                    success: false,
                    message: '增量更新结果格式错误，请检查补丁数据'
                }, 400);
            }
        } else {
            // 步骤2: 验证必需字段 (仅在非Diff模式下)
            if (typeof tsubs === 'undefined' || typeof profiles === 'undefined') {
                return createJsonResponse({
                    success: false,
                    message: '请求体中缺少 tsubs 或 profiles 字段'
                }, 400);
            }

            // 步骤3: 验证数据类型
            if (!Array.isArray(tsubs) || !Array.isArray(profiles)) {
                return createJsonResponse({
                    success: false,
                    message: 'tsubs 和 profiles 必须是数组格式'
                }, 400);
            }
        }

        if (Array.isArray(finalProfiles)) finalProfiles = finalProfiles.filter(item => item?.demo !== true);
        if (Array.isArray(finalTsubs)) finalTsubs = finalTsubs.filter(item => item?.demo !== true);
        if (diff?.subscriptions) {
            diff.subscriptions.added = (diff.subscriptions.added || []).filter(item => item?.demo !== true);
            diff.subscriptions.updated = (diff.subscriptions.updated || []).filter(item => item?.demo !== true);
            diff.subscriptions.removed = (diff.subscriptions.removed || []).filter(id => !String(id).startsWith('demo-'));
        }
        if (diff?.profiles) {
            diff.profiles.added = (diff.profiles.added || []).filter(item => item?.demo !== true);
            diff.profiles.updated = (diff.profiles.updated || []).filter(item => item?.demo !== true);
            diff.profiles.removed = (diff.profiles.removed || []).filter(id => !String(id).startsWith('demo-'));
        }

        if (Array.isArray(finalTsubs)) {
            const currentSubscriptions = typeof storageAdapter.getAllSubscriptions === 'function'
                ? await storageAdapter.getAllSubscriptions()
                : await storageAdapter.get(KV_KEY_SUBS).then(result => result || []);
            const currentItems = Array.isArray(currentSubscriptions) ? currentSubscriptions : [];
            const currentById = new Map(currentItems.map(item => [item?.id, item]));
            const submittedIds = new Set(finalTsubs.map(item => item?.id));
            const removedIds = new Set(diff?.subscriptions?.removed || []);
            if (currentItems.some(item => isManagedSubscription(item) && removedIds.has(item.id))) {
                return createJsonResponse({ success: false, message: '托管订阅已变化，请刷新页面后重试' }, 409);
            }
            const protectedSubscriptions = [];
            for (const submitted of finalTsubs) {
                const hasQuotaOverride = Object.prototype.hasOwnProperty.call(submitted || {}, 'trafficQuotaOverrideBytes');
                const quota = validateTrafficQuotaOverride(hasQuotaOverride ? submitted.trafficQuotaOverrideBytes : undefined);
                if (!quota.valid) {
                    return createJsonResponse({ success: false, message: '流量额度必须是有效的正整数' }, 400);
                }
                const normalized = { ...submitted };
                if (hasQuotaOverride) normalized.trafficQuotaOverrideBytes = quota.value;
                const current = currentById.get(submitted?.id);
                if (isManagedSubscription(current)) {
                    protectedSubscriptions.push(mergeManagedSubscriptionPreferences(current, normalized));
                } else if (isManagedSubscription(submitted)) {
                    return createJsonResponse({ success: false, message: '托管订阅已变化，请刷新页面后重试' }, 409);
                } else {
                    protectedSubscriptions.push(normalized);
                }
            }
            for (const current of currentItems) {
                if (isManagedSubscription(current) && !submittedIds.has(current.id)) {
                    protectedSubscriptions.push(current);
                }
            }
            finalTsubs = protectedSubscriptions;
        }

        if (Array.isArray(finalProfiles)) {
            finalProfiles = finalProfiles.map((p, index) => ({
                ...normalizeProfile(p),
                sortIndex: index
            }));
            
            // [Fix] Sync sortIndex back to diff for correct row-level persistence
            if (diff?.profiles) {
                const profileMap = new Map(finalProfiles.map(p => [p.id, p]));
                if (diff.profiles.added) diff.profiles.added = diff.profiles.added.map(p => ({ ...p, sortIndex: profileMap.get(p.id)?.sortIndex }));
                if (diff.profiles.updated) diff.profiles.updated = diff.profiles.updated.map(p => ({ ...p, sortIndex: profileMap.get(p.id)?.sortIndex }));
            }
        }

        if (Array.isArray(finalTsubs)) {
            finalTsubs = finalTsubs.map((s, index) => ({
                ...s,
                sortIndex: index
            }));

            // [Fix] Sync sortIndex back to diff for correct row-level persistence
            if (diff?.subscriptions) {
                const subMap = new Map(finalTsubs.map(s => [s.id, s]));
                if (diff.subscriptions.added) diff.subscriptions.added = diff.subscriptions.added.map(s => subMap.get(s.id) || s);
                if (diff.subscriptions.updated) diff.subscriptions.updated = diff.subscriptions.updated.map(s => subMap.get(s.id) || s);
            }
        }

        // 步骤4: 获取设置（带错误处理）
        let settings;
        try {
            settings = await storageAdapter.get(KV_KEY_SETTINGS) || defaultSettings;
        } catch (settingsError) {
            settings = defaultSettings; // 使用默认设置继续
        }

        // 步骤5: 处理通知（非阻塞，错误不影响保存）
        // 仅在有订阅数据时处理
        if (finalTsubs && finalTsubs.length > 0) {
            try {
                const notificationPromises = finalTsubs
                    .filter(sub => sub && sub.url && sub.url.startsWith('http'))
                    .map(sub => checkAndNotify(sub, settings, env).catch(notifyError => {
                        console.warn('[API] Notification failed for subscription:', sub?.name || sub?.url, notifyError);
                    }));

                // 并行处理通知，但不等待完成
                Promise.all(notificationPromises).catch(e => {
                    console.warn('[API] Notification batch error:', e);
                });
            } catch (notificationError) {
                console.warn('[API] Notification system error:', notificationError);
            }
        }

        // 步骤6: 保存数据到存储（使用存储适配器）
        try {
            if (diff) {
                const [subsHandled, profilesHandled] = await Promise.all([
                    diff.subscriptions ? applyRowLevelDiff(storageAdapter, 'subscriptions', diff.subscriptions) : false,
                    diff.profiles ? applyRowLevelDiff(storageAdapter, 'profiles', diff.profiles) : false
                ]);

                const saveTasks = [];
                if (!subsHandled) saveTasks.push(storageAdapter.put(KV_KEY_SUBS, finalTsubs));
                if (!profilesHandled) saveTasks.push(storageAdapter.put(KV_KEY_PROFILES, finalProfiles));
                if (saveTasks.length > 0) {
                    await Promise.all(saveTasks);
                }
            } else {
                const [subsHandled, profilesHandled] = await Promise.all([
                    syncCollectionRowLevel(storageAdapter, 'subscriptions', finalTsubs),
                    syncCollectionRowLevel(storageAdapter, 'profiles', finalProfiles)
                ]);

                const saveTasks = [];
                if (!subsHandled) saveTasks.push(storageAdapter.put(KV_KEY_SUBS, finalTsubs));
                if (!profilesHandled) saveTasks.push(storageAdapter.put(KV_KEY_PROFILES, finalProfiles));
                if (saveTasks.length > 0) {
                    await Promise.all(saveTasks);
                }
            }
        } catch (storageError) {
            console.error('[API Error /tsubs] Storage put failed:', storageError);
            return createJsonResponse({
                success: false,
                message: `数据保存失败: ${storageError.message || '存储服务暂时不可用，请稍后重试'}`
            }, 500);
        }

        // 步骤6.5: 清除节点缓存（订阅变动后确保拉取最新数据）
        try {
            const preserveKeys = (Array.isArray(finalTsubs) ? finalTsubs : [])
                .filter(sub => sub?.enableNodeCache === true)
                .map(sub => buildSubscriptionNodeCacheKey(sub));
            const cacheResult = await clearAllNodeCaches(storageAdapter, { preserveKeys });
            console.info(`[API] Cleared ${cacheResult.cleared} node caches after subscription update, preserved ${cacheResult.skipped || 0}`);
        } catch (cacheError) {
            // 缓存清除失败不影响保存结果
            console.warn('[API] Failed to clear node caches:', cacheError.message);
        }

        // 步骤7: 返回保存后的数据，确保前端能更新状态
        return createJsonResponse({
            success: true,
            message: diff ? '增量更新已保存' : '订阅源及订阅组已保存',
            data: {
                tsubs: finalTsubs,
                profiles: finalProfiles
            }
        });

    } catch (e) {
        console.error('[API Error /tsubs] Uncaught error:', e);
        return createJsonResponse({
            success: false,
            message: `保存失败: ${e.message || '服务器内部错误，请稍后重试'}`
        }, 500);
    }
}

/**
 * 处理设置获取API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
function redactSettingsForResponse(settings = {}, env = {}) {
    const redacted = redactSettingsForClient(settings);
    redacted.secretStatus.keySource = env.SETTINGS_SECRET_KEY
        ? 'settings'
        : (env.DEPLOYMENT_SECRET_KEY ? 'deployment-fallback' : 'unavailable');
    return redacted;
}

export async function handleSettingsGet(env, request = null) {
    try {
        if (isDemoView(request)) {
            return createJsonResponse(redactSettingsForResponse(withResolvedDataCommitMode({
                ...defaultSettings,
                storageType: await StorageFactory.getStorageType(env),
                externalApi: { enabled: false, tokens: [] },
                webdavBackup: { ...defaultSettings.webdavBackup, endpoint: '', username: '', password: '', enabled: false }
            }, env), env));
        }
        const settings = await SettingsCache.get(env) || {};
        return createJsonResponse(redactSettingsForResponse(withResolvedDataCommitMode({ ...normalizeSettings(settings), storageType: await StorageFactory.getStorageType(env) }, env), env));
    } catch (e) {
        if (isStorageUnavailableError(e)) {
            return createJsonResponse(withResolvedDataCommitMode({
                ...defaultSettings,
                storageType: 'kv',
                storageUnavailable: true
            }, env));
        }
        return createErrorResponse('读取设置失败', 500);
    }
}

/**
 * 处理设置保存API
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleSettingsSave(request, env) {
    try {
        const newSettings = await readJsonWithLimit(request, JSON_BODY_LIMITS.large);
        if (newSettings.dataCommitMode !== undefined && !['manual', 'direct'].includes(newSettings.dataCommitMode)) {
            return createJsonResponse({ success: false, message: '数据提交方式无效' }, 400);
        }
        if (newSettings.directCommitSilentSuccess !== undefined && typeof newSettings.directCommitSilentSuccess !== 'boolean') {
            return createJsonResponse({ success: false, message: '自动提交成功提示设置无效' }, 400);
        }

        const reservedPathRoots = new Set([
            'settings', 'login', 'groups', 'nodes', 'subscriptions', 'dashboard',
            'api', 'explore', 'sub', 'cron', 'assets', '@vite', 'public', 'profile',
            'logout', 'auth_debug', 'auth_check', 'data', 'kv_test',
            'clients', 'system', 'github', 'telegram', 'test_notification',
            'tsubs', 'node_count', 'nodes', 'fetch_external_url', 'batch_update_nodes',
            'subscription_nodes', 'debug_subscription', 'preview'
        ]);

        const normalizePathRoot = (value) => {
            if (typeof value !== 'string') return '';
            return value.trim().replace(/^\/+/, '').split('/')[0].toLowerCase();
        };

        const rejectReservedValue = (value, fieldLabel) => {
            const pathRoot = normalizePathRoot(value);
            if (pathRoot && reservedPathRoots.has(pathRoot)) {
                return createJsonResponse({
                    success: false,
                    message: `"/${pathRoot}" 是系统保留路径，不可用作${fieldLabel}`
                }, 400);
            }
            return null;
        };

        // 校验 customLoginPath 是否为系统保留路径
        if (newSettings.customLoginPath) {
            const rejected = rejectReservedValue(newSettings.customLoginPath, '自定义登录路径');
            if (rejected) return rejected;
        }

        // 订阅 Token 也不能使用会和路由冲突的保留路径
        if (newSettings.mytoken && newSettings.mytoken !== 'auto') {
            const rejected = rejectReservedValue(newSettings.mytoken, '自定义订阅Token');
            if (rejected) return rejected;
        }
        if (newSettings.profileToken && newSettings.profileToken !== 'profiles') {
            const rejected = rejectReservedValue(newSettings.profileToken, '订阅组分享Token');
            if (rejected) return rejected;
        }

        if (newSettings.trafficNodeDisplay !== undefined) {
            const customLabelValidation = validateTrafficNodeCustomLabels(newSettings.trafficNodeDisplay);
            if (!customLabelValidation.valid) {
                const metricName = TRAFFIC_NODE_METRIC_NAMES[customLabelValidation.key] || '流量节点';
                const message = customLabelValidation.reason === 'tooLong'
                    ? `${metricName}的自定义名称不能超过 24 个字符`
                    : `${metricName}的自定义名称不能为空`;
                return createJsonResponse({ success: false, message }, 400);
            }
        }

        const storageAdapter = await getStorageAdapter(env);
        const oldSettings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
        const clearingCloudflareToken = newSettings.secretActions?.clearPaths?.includes('cloudflareUsage.apiToken') && !newSettings.cloudflareUsage?.apiToken;
        const cloudflareValidation = validateCloudflareUsage(newSettings.cloudflareUsage, Boolean(oldSettings.cloudflareUsage?.apiToken) && !clearingCloudflareToken);
        if (cloudflareValidation) return createJsonResponse({ success: false, message: cloudflareValidation }, 400);
        const finalSettings = mergeSettingsUpdate(oldSettings, newSettings);
        finalSettings.publicUrl = String(finalSettings.publicUrl || '').trim();
        if (finalSettings.publicUrl) {
            try {
                const publicUrl = new URL(finalSettings.publicUrl);
                if (!['http:', 'https:'].includes(publicUrl.protocol) || !publicUrl.hostname) throw new Error('invalid');
            } catch {
                return createJsonResponse({ success: false, message: 'TSUB_PUBLIC_URL 必须是有效的 HTTP 或 HTTPS 地址' }, 400);
            }
        }
        finalSettings.cloudflareUsage = normalizeSettings(finalSettings).cloudflareUsage;
        finalSettings.storageType = await StorageFactory.getStorageType(env);
        finalSettings.enableTrafficNode = finalSettings.enableTrafficNode === true || finalSettings.enableTrafficNode === 'true';
        finalSettings.directCommitSilentSuccess = finalSettings.directCommitSilentSuccess !== false;
        finalSettings.trafficNodeDisplay = normalizeTrafficNodeDisplay(finalSettings.trafficNodeDisplay);
        if (finalSettings.enableTrafficNode === true && !hasEnabledTrafficNode(finalSettings.trafficNodeDisplay)) {
            return createJsonResponse({
                success: false,
                message: '显示流量统计节点开启时至少需要选择一个统计项目'
            }, 400);
        }

        // 使用存储适配器保存设置
        try {
            await storageAdapter.put(KV_KEY_SETTINGS, finalSettings);
        } catch (storageError) {
            if (isStorageUnavailableError(storageError)) {
                return createJsonResponse({
                    success: false,
                    message: 'KV 存储已暂停，设置当前无法保存。请先恢复 KV 绑定，或配置 D1 后切换到 D1 存储。'
                }, 503);
            }
            throw storageError;
        }

        SettingsCache.clear();

        // 清除节点缓存（设置变更可能影响节点处理逻辑）
        try {
            await clearAllNodeCaches(storageAdapter);
        } catch (cacheError) {
            console.warn('[API] Failed to clear node caches:', cacheError.message);
        }

        const message = `⚙️ *TSub 设置更新* ⚙️\n\n您的 TSub 应用设置已成功更新。`;
        await sendTgNotification(finalSettings, message);

        return createJsonResponse({ success: true, message: '设置已保存', data: redactSettingsForResponse(withResolvedDataCommitMode(finalSettings, env), env) });
    } catch (e) {
        return createErrorResponse('保存设置失败', 500);
    }
}

/**
 * 处理设置重置API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleSettingsReset(env) {
    try {
        const storageAdapter = await getStorageAdapter(env);
        
        // 使用存储适配器删除设置（会自动处理 KV 和 D1 映射）
        await storageAdapter.delete(KV_KEY_SETTINGS);

        // 清除内存缓存
        SettingsCache.clear();

        return createJsonResponse({ 
            success: true, 
            message: '设置已恢复出厂状态',
            data: withResolvedDataCommitMode(defaultSettings, env)
        });
    } catch (e) {
        console.error('[API Error /settings/reset]', e);
        return createErrorResponse('重置设置失败', 500);
    }
}


/**
 * 处理公开订阅组获取API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handlePublicProfilesRequest(env) {
    try {
        const storageAdapter = await getStorageAdapter(env);
        const cachedSettings = await SettingsCache.get(env);
        const [profiles, settings] = await Promise.all([
            typeof storageAdapter.getAllProfiles === 'function'
                ? storageAdapter.getAllProfiles()
                : storageAdapter.get(KV_KEY_PROFILES).then(res => res || []),
            Promise.resolve(cachedSettings || {}).then(res => res || {})
        ]);

        const profileToken = settings.profileToken || 'profiles';

        // 获取公告配置（仅当启用时返回）
        const announcement = settings.announcement?.enabled ? {
            enabled: true, // [修复] 必须包含此字段，否则前端 v-if 判断会失败
            title: settings.announcement.title || '',
            content: settings.announcement.content || '',
            type: settings.announcement.type || 'info',
            dismissible: settings.announcement.dismissible !== false,
            updatedAt: settings.announcement.updatedAt
        } : null;

        // Hero Configuration
        const hero = {
            title1: settings.heroTitle1 || '发现',
            title2: settings.heroTitle2 || '优质订阅',
            description: settings.heroDescription || '浏览并获取由管理员分享的精选订阅组合，一键导入到您的客户端。'
        };


        // Guestbook Config (Safe subset)
        const guestbook = {
            enabled: settings.guestbook?.enabled,
            requireAudit: settings.guestbook?.requireAudit,
            allowAnonymous: settings.guestbook?.allowAnonymous,
        };

        // 过滤出公开且启用的订阅组
        const publicProfiles = profiles
            .map(normalizeProfile)
            .filter(p => p.isPublic && p.enabled)
            .map(p => ({
                id: p.id,
                name: p.name,
                description: p.description || '',
                customId: p.customId,
                updatedAt: p.updatedAt,
                subscriptionCount: (p.subscriptions || []).length,
                manualNodeCount: (p.manualNodes || []).length,
            }));

        // Custom Page Config
        const customPage = {
            enabled: settings.customPage?.enabled || false,
            type: settings.customPage?.type || 'html',
            content: settings.customPage?.content || '',
            css: settings.customPage?.css || '',
            useDefaultLayout: settings.customPage?.useDefaultLayout !== false,
            allowExternalStylesheets: settings.customPage?.allowExternalStylesheets === true,
            allowScripts: settings.customPage?.allowScripts === true,
            hideBranding: settings.customPage?.hideBranding === true,
            hideHeader: settings.customPage?.hideHeader === true,
            hideFooter: settings.customPage?.hideFooter === true
        };
        
        return createJsonResponse({
            success: true,
            data: publicProfiles,
            config: {
                profileToken,
                announcement,
                hero,
                guestbook,
                customPage
            }
        });
    } catch (e) {
        console.error('[API Error /public/profiles]', e);
        return createErrorResponse('获取公开订阅组失败', 500);
    }
}

/**
 * 处理公开配置获取API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handlePublicConfig(env) {
    try {
        const storageAdapter = await getStorageAdapter(env);
        const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};

        // Merge with default settings to ensure enablePublicPage exists
        const mergedSettings = { ...defaultSettings, ...settings };

        return createJsonResponse({
            enablePublicPage: mergedSettings.enablePublicPage,
            customLoginPath: mergedSettings.customLoginPath,
            customPage: {
                enabled: mergedSettings.customPage?.enabled || false,
                useDefaultLayout: mergedSettings.customPage?.useDefaultLayout !== false,
                allowExternalStylesheets: mergedSettings.customPage?.allowExternalStylesheets === true,
                allowScripts: mergedSettings.customPage?.allowScripts === true,
                hideBranding: mergedSettings.customPage?.hideBranding === true,
                hideHeader: mergedSettings.customPage?.hideHeader === true,
                hideFooter: mergedSettings.customPage?.hideFooter === true
            }
        });
    } catch (e) {
        console.error('[API Error /public/config]', e);
        return createErrorResponse('获取公开配置失败', 500);
    }
}

/**
 * 处理密码更新API
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
function expiredAuthCookie(request) {
    const secure = request.url.startsWith('https:') ? ' Secure;' : '';
    return `${COOKIE_NAME}=; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=0`;
}

export async function handleAdminCredentials(request, env, action = 'credentials') {
    if (action === 'credentials' && request.method === 'GET') {
        if (isDemoView(request)) {
            return createJsonResponse({ success: true, data: { username: 'demo-admin', usernameSource: 'demo', passwordSource: 'demo', canPersist: false } });
        }
        return createJsonResponse({ success: true, data: await getAdminCredentialMetadata(env) });
    }
    try {
        const payload = await readJsonWithLimit(request, JSON_BODY_LIMITS.auth);
        let data;
        if (action === 'credentials' && request.method === 'PUT') {
            data = await saveAdminCredentials(env, payload?.currentPassword, payload?.username, payload?.newPassword || '');
        } else if (action === 'reset' && request.method === 'POST') {
            data = await resetAdminCredentials(env, payload?.currentPassword);
        } else {
            return createErrorResponse('Method Not Allowed', 405);
        }
        return createJsonResponse({ success: true, data, reauthenticate: true }, 200, { 'Set-Cookie': expiredAuthCookie(request) });
    } catch (error) {
        const message = String(error?.message || '管理员凭据更新失败');
        const status = /当前密码错误|账号必须|密码必须/.test(message) ? 400 : (/没有可用持久化存储/.test(message) ? 503 : 500);
        console.error('[API Error /settings/credentials]', { message });
        return createErrorResponse(message, status);
    }
}

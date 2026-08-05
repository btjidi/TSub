import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useToastStore } from './toast';
import { useSettingsStore } from './settings';
import { useEditorStore } from './editor';
import { createStorageCache } from '../utils/cache-helper.js';
import { DEFAULT_SETTINGS } from '../constants/default-settings.js';
import { TIMING } from '../constants/timing.js';
import { api } from '../lib/http.js';
import { t } from '../i18n/index.js';

const isDev = import.meta.env.DEV;

// Initialize Cache
// Bump the cache namespace when persisted server data is reset so stale data
// from an already-open browser session cannot repopulate the empty UI.
const dataCache = createStorageCache('tsub_data_cache_v2', TIMING.CACHE_TTL_MS);

export const useDataStore = defineStore('data', () => {
    const { showToast } = useToastStore();
    const settingsStore = useSettingsStore();
    const editorStore = useEditorStore();

    // --- State ---
    const subscriptions = ref([]);
    const profiles = ref([]);
    const ruleTemplates = ref([]);
    const settings = computed(() => settingsStore.config);

    // Store Status
    const isLoading = ref(false);
    const saveState = ref('idle');
    const directCommitFailed = ref(false);
    const lastUpdated = ref(null);
    const hasDataLoaded = computed(() => !!lastUpdated.value);

    // Derived Dirty State (from Editor)
    const isDirty = computed(() => editorStore.isDirty);
    const isDirectCommitMode = computed(() => settings.value?.dataCommitMode === 'direct');

    let changeRevision = 0;
    let directCommitScheduled = false;
    let directCommitInFlight = false;
    let directCommitRequested = false;

    // --- Getters ---
    const activeSubscriptions = computed(() => subscriptions.value.filter(sub => sub.enabled));
    const activeProfiles = computed(() => profiles.value.filter(profile => profile.enabled));

    // --- Internal: Snapshot for rollback/diffing ---
    let lastSavedData = {
        subscriptions: [],
        profiles: [],
        ruleTemplates: []
    };

    // --- Actions ---

    // Data Hydration (avoid re-fetching if passed from outside)
    function hydrateFromData(data) {
        if (!data) return false;

        try {
            const cleanSubs = (data.tsubs || []).map(sub => ({ ...sub, isUpdating: false }));
            subscriptions.value = cleanSubs;
            profiles.value = data.profiles || [];
            ruleTemplates.value = data.ruleTemplates || [];
            settingsStore.setConfig({ ...DEFAULT_SETTINGS, ...data.config });

            updateSnapshot();
            lastUpdated.value = new Date();
            dataCache.set(data);
            return true;
        } catch (error) {
            console.error('hydrateFromData failed:', error);
            return false;
        }
    }

    async function fetchData(forceRefresh = false) {
        if (isLoading.value) return;

        // Effective Cache Check
        if (hasDataLoaded.value && !forceRefresh) return;

        if (!forceRefresh) {
            const cachedData = dataCache.get();
            if (cachedData) {
                hydrateFromData(cachedData);
                return;
            }
        }

        isLoading.value = true;
        try {
            const data = await api.get('/api/data');

            if (data.error) {
                throw new Error(data.error);
            }

            hydrateFromData(data); // Re-use hydration logic
            pruneInvalidReferences(); // 数据拉取后执行自愈
            clearDirty();

        } catch (error) {
            console.error('Failed to fetch data:', error);
            showToast(t('store.fetchDataFailed', { message: error.message }), 'error');
            throw error;
        } finally {
            isLoading.value = false;
        }
    }

    async function saveData(options = {}) {
        const directCommit = options.directCommit === true;
        if (isLoading.value) {
            if (directCommit) directCommitRequested = true;
            else showToast(t('store.tooFrequent'), 'warning');
            return false;
        }

        isLoading.value = true;
        saveState.value = 'saving';
        
        // 保存前执行数据自愈，确保发往后端的数据是干净的
        pruneInvalidReferences();

        const saveRevision = changeRevision;

        try {
            const demoSubscriptions = subscriptions.value.filter(sub => sub?.demo === true);
            const demoProfiles = profiles.value.filter(profile => profile?.demo === true);
            const sanitizedSubs = subscriptions.value.filter(sub => sub?.demo !== true).map(sub => {
                const { isUpdating, ...rest } = sub;
                return rest;
            });

            const payload = {
                tsubs: sanitizedSubs,
                profiles: profiles.value.filter(profile => profile?.demo !== true).map(profile => {
                    const normalizedProfile = { ...profile };
                    normalizedProfile.ruleLevel = normalizedProfile.ruleLevel || normalizedProfile.clashRuleLevel || '';
                    delete normalizedProfile.clashRuleLevel;
                    return normalizedProfile;
                })
            };

            const result = await api.post('/api/tsubs', payload);

            if (!result.success) {
                throw new Error(result.message || t('store.saveFailed'));
            }

            const hasNewerDirectChanges = directCommit && changeRevision !== saveRevision;
            if (!hasNewerDirectChanges) {
                // Update local state with backend response (Source of Truth)
                if (result.data) {
                    if (result.data.tsubs) subscriptions.value = [...demoSubscriptions, ...result.data.tsubs];
                    if (result.data.profiles) profiles.value = [...demoProfiles, ...result.data.profiles];
                }

                updateSnapshot();
                lastUpdated.value = new Date();
                clearDirty();

                // Persist browser cache only after the controller accepts the save.
                dataCache.set({
                    tsubs: subscriptions.value.map(s => {
                        const { isUpdating, ...rest } = s;
                        return rest;
                    }),
                    profiles: profiles.value,
                    ruleTemplates: ruleTemplates.value,
                    config: settingsStore.config
                });
            }

            directCommitFailed.value = false;
            const silentSuccess = options.silentSuccess === true
                || (directCommit && settings.value?.directCommitSilentSuccess !== false);
            if (directCommit) {
                if (!silentSuccess) showToast(t('store.dataSaved'), 'success');
                saveState.value = 'idle';
            } else if (silentSuccess) {
                saveState.value = 'idle';
            } else {
                showToast(t('store.dataSaved'), 'success');
                saveState.value = 'success';
                setTimeout(() => {
                    if (saveState.value === 'success') saveState.value = 'idle';
                }, 2000);
            }
            return true;

        } catch (error) {
            console.error('[Store] Failed to save data:', error);
            showToast(t('store.saveDataFailed', { message: error.message }), 'error');
            saveState.value = 'idle';
            if (directCommit) {
                directCommitFailed.value = true;
                return false;
            }
            throw error;
        } finally {
            isLoading.value = false;
            if (directCommitRequested && isDirectCommitMode.value && !directCommitFailed.value) {
                scheduleDirectCommit();
            }
        }
    }

    function scheduleDirectCommit() {
        if (!isDirectCommitMode.value || directCommitFailed.value) return;
        directCommitRequested = true;
        if (directCommitScheduled || directCommitInFlight) return;
        directCommitScheduled = true;
        queueMicrotask(async () => {
            directCommitScheduled = false;
            if (isLoading.value) return;
            await runDirectCommitQueue();
        });
    }

    async function runDirectCommitQueue() {
        if (directCommitInFlight || isLoading.value || directCommitFailed.value) return;
        directCommitInFlight = true;
        try {
            while (directCommitRequested && isDirectCommitMode.value && !directCommitFailed.value) {
                directCommitRequested = false;
                if (!isDirty.value) continue;
                const saved = await saveData({ directCommit: true });
                if (!saved) break;
                if (isDirty.value) directCommitRequested = true;
            }
        } finally {
            directCommitInFlight = false;
            if (directCommitRequested && isDirectCommitMode.value && !directCommitFailed.value) {
                scheduleDirectCommit();
            }
        }
    }

    async function saveSettings(newSettings) {
        editorStore.setLoading(true);
        try {
            const result = await api.post('/api/settings', newSettings);

            if (!result.success) {
                throw new Error(result.message || t('store.saveSettingsFailed'));
            }

            settingsStore.updateConfig(newSettings);
            syncCachedConfig(settingsStore.config);
            showToast(t('store.settingsUpdated'), 'success');

        } catch (error) {
            console.error('Failed to save settings:', error);
            showToast(t('store.saveSettingsFailedWithMessage', { message: error.message }), 'error');
            throw error;
        } finally {
            editorStore.setLoading(false);
        }
    }

    async function fetchRuleTemplates() {
        const result = await api.get('/api/rule_templates');
        ruleTemplates.value = Array.isArray(result?.data) ? result.data : [];
        lastSavedData.ruleTemplates = JSON.parse(JSON.stringify(ruleTemplates.value));
        return ruleTemplates.value;
    }

    async function saveRuleTemplates(items = ruleTemplates.value) {
        editorStore.setLoading(true);
        try {
            const result = await api.post('/api/rule_templates', { templates: items });
            if (!result.success) {
                throw new Error(result.message || t('store.saveRuleTemplatesFailed'));
            }
            ruleTemplates.value = Array.isArray(result.data) ? result.data : [];
            lastSavedData.ruleTemplates = JSON.parse(JSON.stringify(ruleTemplates.value));
            showToast(t('store.ruleTemplatesSaved'), 'success');
            return ruleTemplates.value;
        } catch (error) {
            console.error('Failed to save rule templates:', error);
            showToast(t('store.saveRuleTemplatesFailedWithMessage', { message: error.message }), 'error');
            throw error;
        } finally {
            editorStore.setLoading(false);
        }
    }

    // --- Helpers ---

    function updateSnapshot() {
        lastSavedData = {
            subscriptions: JSON.parse(JSON.stringify(subscriptions.value)),
            profiles: JSON.parse(JSON.stringify(profiles.value)),
            ruleTemplates: JSON.parse(JSON.stringify(ruleTemplates.value))
        };
    }

    function clearCachedData() {
        dataCache.clear();
    }

    function syncCachedConfig(nextConfig) {
        const cachedData = dataCache.get();
        if (!cachedData) return;

        dataCache.set({
            ...cachedData,
            config: {
                ...(cachedData.config || {}),
                ...(nextConfig || {})
            }
        });
    }

    // --- Proxy Actions (Mutators) ---
    function addSubscription(subscription) {
        subscriptions.value.unshift(subscription);
        markDirty();
    }

    function overwriteSubscriptions(items) {
        subscriptions.value = items;
    }

    function removeSubscription(id) {
        const index = subscriptions.value.findIndex(s => s.id === id);
        if (index !== -1) {
            subscriptions.value.splice(index, 1);
        }
    }

    function updateSubscription(id, updates) {
        const index = subscriptions.value.findIndex(s => s.id === id);
        if (index !== -1) {
            subscriptions.value[index] = { ...subscriptions.value[index], ...updates };
            markDirty();
        }
    }

    function addProfile(profile) {
        profiles.value.unshift(profile);
    }

    function overwriteProfiles(items) {
        profiles.value = items;
    }

    function removeProfile(id) {
        const index = profiles.value.findIndex(p => p.id === id || p.customId === id);
        if (index !== -1) {
            profiles.value.splice(index, 1);
        }
    }

    function removeManualNodeFromProfiles(nodeIds) {
        const idsToRemove = Array.isArray(nodeIds) ? new Set(nodeIds) : new Set([nodeIds]);
        if (idsToRemove.size === 0) return;

        let modified = false;
        profiles.value.forEach(profile => {
            if (Array.isArray(profile.manualNodes) && profile.manualNodes.length > 0) {
                const originalLength = profile.manualNodes.length;
                profile.manualNodes = profile.manualNodes.filter(id => !idsToRemove.has(id));
                if (profile.manualNodes.length !== originalLength) {
                    modified = true;
                }
            }
        });

        if (modified) {
            profiles.value = [...profiles.value]; // 强制触发响应式更新
            if (isDev) {
                console.debug('[DataStore] Cleaned up manual node references from profiles');
            }
        }
    }

    function removeSubscriptionFromProfiles(subIds) {
        const idsToRemove = Array.isArray(subIds) ? new Set(subIds) : new Set([subIds]);
        if (idsToRemove.size === 0) return;

        let modified = false;
        profiles.value.forEach(profile => {
            if (Array.isArray(profile.subscriptions) && profile.subscriptions.length > 0) {
                const originalLength = profile.subscriptions.length;
                profile.subscriptions = profile.subscriptions.filter(item => !idsToRemove.has(item && typeof item === 'object' ? item.id : item));
                if (profile.subscriptions.length !== originalLength) {
                    modified = true;
                }
            }
        });

        if (modified) {
            profiles.value = [...profiles.value]; // 强制触发响应式更新
            if (isDev) {
                console.debug('[DataStore] Cleaned up subscription references from profiles');
            }
        }
    }

    /**
     * 数据自愈：清理订阅组中不存在的节点/订阅引用
     * 同时处理可能存在的重复 ID
     */
    function pruneInvalidReferences() {
        if (!profiles.value || profiles.value.length === 0) return;

        // 收集所有当前存在的订阅和手动节点 ID
        const validIds = new Set(subscriptions.value.map(item => item.id));
        
        let modified = false;
        profiles.value.forEach(profile => {
            // 1. 处理手动节点引用
            if (Array.isArray(profile.manualNodes) && profile.manualNodes.length > 0) {
                const originalLength = profile.manualNodes.length;
                const seenIds = new Set();
                profile.manualNodes = profile.manualNodes.filter(id => {
                    // ID 必须存在且未被重复记录
                    if (validIds.has(id) && !seenIds.has(id)) {
                        seenIds.add(id);
                        return true;
                    }
                    return false;
                });
                if (profile.manualNodes.length !== originalLength) {
                    modified = true;
                }
            }

            // 2. 处理订阅源引用
            if (Array.isArray(profile.subscriptions) && profile.subscriptions.length > 0) {
                const originalLength = profile.subscriptions.length;
                const seenIds = new Set();
                profile.subscriptions = profile.subscriptions.filter(item => {
                    const id = item && typeof item === 'object' ? item.id : item;
                    if (validIds.has(id) && !seenIds.has(id)) {
                        seenIds.add(id);
                        return true;
                    }
                    return false;
                });
                if (profile.subscriptions.length !== originalLength) {
                    modified = true;
                }
            }
        });

        if (modified) {
            profiles.value = [...profiles.value]; // 强制触发响应式
            if (isDev) {
                console.info('[DataStore] Cleaned up stale IDs or duplicates in profiles');
            }
        }
    }

    // --- Dirty State Proxies ---
    function markDirty() {
        changeRevision += 1;
        if (saveState.value === 'success') {
            saveState.value = 'idle';
        }
        editorStore.markDirty();
        scheduleDirectCommit();
    }

    function clearDirty() {
        editorStore.clearDirty();
        directCommitFailed.value = false;
        directCommitRequested = false;
    }

    return {
        // State
        subscriptions,
        profiles,
        ruleTemplates,
        settings,
        isLoading,
        saveState,
        directCommitFailed,
        lastUpdated,
        hasDataLoaded,
        isDirty,
        isDirectCommitMode,

        // Getters
        activeSubscriptions,
        activeProfiles,

        // Actions
        fetchData,
        saveData,
        saveSettings,
        fetchRuleTemplates,
        saveRuleTemplates,
        hydrateFromData,
        clearCachedData,

        // Helpers
        addSubscription,
        overwriteSubscriptions,
        removeSubscription,
        updateSubscription,
        addProfile,
        overwriteProfiles,
        removeProfile,
        removeManualNodeFromProfiles,
        removeSubscriptionFromProfiles,
        markDirty,
        clearDirty
    };
});

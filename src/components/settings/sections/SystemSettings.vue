<script setup>
import { computed, onMounted, ref } from 'vue';
import { useToastStore } from '../../../stores/toast.js';
import { useSessionStore } from '../../../stores/session.js';
import Input from '../../ui/Input.vue';
import Switch from '../../ui/Switch.vue';
import CloudflareUsageCard from './CloudflareUsageCard.vue';
import { useI18n } from '../../../i18n/index.js';

const props = defineProps({
    category: {
        type: String,
        default: 'security',
        validator: value => ['data', 'security'].includes(value)
    },
    settings: {
        type: Object,
        required: true
    },
    exportBackup: Function,
    importBackup: Function,
    handleReset: Function
});

const { showToast } = useToastStore();
const sessionStore = useSessionStore();
const { t } = useI18n();

const credentialForm = ref({
  currentPassword: '',
  username: 'admin',
  newPassword: '',
  confirmPassword: ''
});
const credentialMeta = ref({ usernameSource: 'default', passwordSource: 'default', canPersist: false });
const isUpdatingCredentials = ref(false);
const demoData = ref({ version: 1, seededAt: null, counts: { subscriptions: 0, nodes: 0, profiles: 0, deployments: 0, operations: 0 } });
const isUpdatingDemoData = ref(false);
const storageStatus = ref({ platform: 'cloudflare', activeStorage: props.settings.storageType || 'kv', bindings: {} });
const isSwitchingStorage = ref(false);
const storageOptions = computed(() => storageStatus.value.platform === 'server'
  ? [{ value: 'sqlite', label: t('systemSettings.sqliteStorage') }, { value: 'postgres', label: t('systemSettings.postgresStorage') }]
  : [{ value: 'kv', label: t('systemSettings.kvStorage') }, { value: 'd1', label: t('systemSettings.d1DatabaseRecommended') }]);

const loadStorageStatus = async () => {
  try {
    const statusResponse = await fetch('/api/storage/status');
    const statusBody = await statusResponse.json();
    const data = statusBody?.data;
    if (statusResponse.ok && statusBody.success && data && !Array.isArray(data) && typeof data.activeStorage === 'string') {
      storageStatus.value = { ...storageStatus.value, ...data, bindings: data.bindings && typeof data.bindings === 'object' ? data.bindings : {} };
    }
  } catch {}
};

const switchStorage = async target => {
  if (!window.confirm(t('systemSettings.storageSwitchConfirm', { target: target.toUpperCase() }))) return;
  isSwitchingStorage.value = true;
  try {
    const startResponse = await fetch('/api/storage/migrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
    const startBody = await startResponse.json();
    if (!startResponse.ok || !startBody.success) throw new Error(startBody.message || startBody.error || t('systemSettings.updateFailed'));
    let migration = startBody.data;
    for (let attempt = 0; attempt < 180 && migration.phase !== 'complete'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await fetch(`/api/storage/migrations/${encodeURIComponent(migration.id)}/advance`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.message || body.error || t('systemSettings.updateFailed'));
      migration = body.data;
    }
    if (migration.phase !== 'complete') throw new Error(t('systemSettings.storageSwitchTimeout'));
    showToast(t('systemSettings.storageSwitchSuccess', { target: target.toUpperCase() }), 'success');
    window.location.reload();
  } catch (error) { showToast(t('systemSettings.requestFailed', { message: error.message }), 'error'); }
  finally { isSwitchingStorage.value = false; }
};

const loadCredentialMetadata = async () => {
  try {
    const response = await fetch('/api/settings/credentials');
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || t('systemSettings.updateFailed'));
    credentialMeta.value = body.data;
    credentialForm.value.username = body.data.username || 'admin';
  } catch (error) {
    showToast(t('systemSettings.requestFailed', { message: error.message }), 'error');
  }
};

const loadDemoData = async () => {
  try {
    const response = await fetch('/api/demo-data');
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || t('systemSettings.updateFailed'));
    demoData.value = body.data;
  } catch (error) {
    showToast(t('systemSettings.requestFailed', { message: error.message }), 'error');
  }
};

const seedDemoData = async () => {
  isUpdatingDemoData.value = true;
  try {
    const response = await fetch('/api/demo-data', { method: 'POST' });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || t('systemSettings.updateFailed'));
    demoData.value = body.data;
    showToast(t('systemSettings.demoDataSeeded'), 'success');
  } catch (error) {
    showToast(t('systemSettings.requestFailed', { message: error.message }), 'error');
  } finally {
    isUpdatingDemoData.value = false;
  }
};

const clearDemoData = async () => {
  if (!window.confirm(t('systemSettings.demoDataClearConfirm'))) return;
  isUpdatingDemoData.value = true;
  try {
    const response = await fetch('/api/demo-data', { method: 'DELETE' });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || t('systemSettings.updateFailed'));
    demoData.value = body.data;
    showToast(t('systemSettings.demoDataCleared'), 'success');
  } catch (error) {
    showToast(t('systemSettings.requestFailed', { message: error.message }), 'error');
  } finally {
    isUpdatingDemoData.value = false;
  }
};

onMounted(() => props.category === 'data'
  ? Promise.all([loadDemoData(), loadStorageStatus()])
  : loadCredentialMetadata());

const ensureExternalApiDefaults = (settings) => {
  if (!settings.externalApi || typeof settings.externalApi !== 'object') {
    settings.externalApi = { enabled: false, tokens: [{ name: 'default', token: '' }] };
    return;
  }

  if (!Array.isArray(settings.externalApi.tokens) || settings.externalApi.tokens.length === 0) {
    settings.externalApi.tokens = [{ name: 'default', token: '' }];
    return;
  }

  settings.externalApi.tokens = settings.externalApi.tokens.map((item, index) => ({
    id: String(item?.id || `external-${index + 1}`),
    name: String(item?.name || `token-${index + 1}`).trim() || `token-${index + 1}`,
    token: String(item?.token || '').trim(),
    configured: Boolean(item?.configured || settings.secretStatus?.externalApiTokens?.[item?.id])
  }));
};

const ensureSecretActions = (settings) => {
  if (!settings.secretActions) settings.secretActions = { clearPaths: [], clearExternalTokenIds: [] };
  if (!Array.isArray(settings.secretActions.clearPaths)) settings.secretActions.clearPaths = [];
  if (!Array.isArray(settings.secretActions.clearExternalTokenIds)) settings.secretActions.clearExternalTokenIds = [];
  return settings.secretActions;
};

const buildExternalApiToken = () => {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(18);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
};

ensureExternalApiDefaults(props.settings);

const handleGenerateExternalApiToken = (settings) => {
  ensureExternalApiDefaults(settings);
  settings.externalApi.tokens[0].token = buildExternalApiToken();
  settings.externalApi.tokens[0].configured = true;
  const actions = ensureSecretActions(settings);
  actions.clearExternalTokenIds = actions.clearExternalTokenIds.filter(id => id !== settings.externalApi.tokens[0].id);
  showToast(t('systemSettings.externalApiTokenGenerated'), 'success');
};

const handleClearExternalApiToken = (settings) => {
  ensureExternalApiDefaults(settings);
  const item = settings.externalApi.tokens[0];
  item.token = '';
  item.configured = false;
  const actions = ensureSecretActions(settings);
  if (!actions.clearExternalTokenIds.includes(item.id)) actions.clearExternalTokenIds.push(item.id);
  showToast(t('systemSettings.secretClearedAfterSave'), 'success');
};

const handleCopyExternalApiToken = async (settings) => {
  ensureExternalApiDefaults(settings);
  const token = settings.externalApi.tokens[0]?.token || '';
  if (!token) {
    showToast(t('systemSettings.externalApiTokenEmpty'), 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(token);
    showToast(t('systemSettings.externalApiTokenCopied'), 'success');
  } catch (error) {
    showToast(t('systemSettings.copyFailedManual'), 'error');
  }
};

const redirectToLogin = () => {
  const rawPath = sessionStore.publicConfig?.customLoginPath;
  const normalized = String(rawPath || 'login').trim().replace(/^\/+/, '') || 'login';
  window.location.assign(`/${normalized}`);
};

const handleUpdateCredentials = async () => {
  if (credentialForm.value.newPassword !== credentialForm.value.confirmPassword) {
    showToast(t('systemSettings.passwordMismatch'), 'error');
    return;
  }
  if (credentialForm.value.newPassword && credentialForm.value.newPassword.length < 8) {
    showToast(t('systemSettings.passwordTooShort'), 'error');
    return;
  }

  isUpdatingCredentials.value = true;
  try {
    const res = await fetch('/api/settings/credentials', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: credentialForm.value.currentPassword,
        username: credentialForm.value.username,
        newPassword: credentialForm.value.newPassword
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(t('systemSettings.credentialsUpdated'), 'success');
      redirectToLogin();
    } else {
      showToast(data.error || t('systemSettings.updateFailed'), 'error');
    }
  } catch (e) {
    showToast(t('systemSettings.requestFailed', { message: e.message }), 'error');
  } finally {
    isUpdatingCredentials.value = false;
  }
};

const handleResetCredentials = async () => {
  if (!window.confirm(t('systemSettings.resetCredentialsConfirm'))) return;
  isUpdatingCredentials.value = true;
  try {
    const response = await fetch('/api/settings/credentials/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: credentialForm.value.currentPassword })
    });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || t('systemSettings.updateFailed'));
    showToast(t('systemSettings.credentialsReset'), 'success');
    redirectToLogin();
  } catch (error) {
    showToast(t('systemSettings.requestFailed', { message: error.message }), 'error');
  } finally {
    isUpdatingCredentials.value = false;
  }
};

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_updated_at ON subscriptions(updated_at);
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
CREATE INDEX IF NOT EXISTS idx_settings_updated_at ON settings(updated_at);`;

const copySchema = async () => {
    try {
        await navigator.clipboard.writeText(SCHEMA_SQL);
        showToast(t('systemSettings.schemaCopied'), 'success');
    } catch (err) {
        showToast(t('systemSettings.copyFailedManual'), 'error');
    }
};

</script>

<template>
    <div class="space-y-8">
        <div v-if="category === 'security' && settings.secretStatus?.keySource === 'deployment-fallback'" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200">
            {{ t('systemSettings.settingsSecretFallback') }}
        </div>
        <div v-else-if="category === 'security' && settings.secretStatus?.keySource === 'unavailable'" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
            {{ t('systemSettings.settingsSecretUnavailable') }}
        </div>
        <div v-if="category === 'data'" data-testid="demo-data-settings" class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
            <div class="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                <div class="flex min-w-0 items-start gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a2 2 0 012-2h12a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V5z" />
                        </svg>
                    </div>
                    <div class="min-w-0 space-y-1">
                        <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('systemSettings.demoDataTitle') }}</h3>
                        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('systemSettings.demoDataDesc') }}</p>
                        <p class="text-xs text-gray-500 dark:text-gray-400">
                            <template v-if="demoData.seededAt">{{ t('systemSettings.demoDataStatus', {
                                subscriptions: demoData.counts.subscriptions,
                                nodes: demoData.counts.nodes,
                                profiles: demoData.counts.profiles,
                                deployments: demoData.counts.deployments
                            }) }} · {{ new Date(demoData.seededAt).toLocaleString() }}</template>
                            <template v-else>{{ t('systemSettings.demoDataEmpty') }}</template>
                        </p>
                    </div>
                </div>
                <div class="flex shrink-0 flex-wrap gap-3">
                    <button data-testid="seed-demo-data" type="button" :disabled="isUpdatingDemoData" class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50" @click="seedDemoData">
                        {{ demoData.seededAt ? t('systemSettings.demoDataRefresh') : t('systemSettings.demoDataGenerate') }}
                    </button>
                    <button data-testid="clear-demo-data" type="button" :disabled="isUpdatingDemoData || !demoData.seededAt" class="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/50 dark:hover:bg-red-950/30" @click="clearDemoData">
                        {{ t('systemSettings.demoDataClear') }}
                    </button>
                </div>
            </div>
        </div>

        <div v-if="category === 'data'" class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
            <div class="mb-5 flex items-start gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/10 text-orange-600 dark:text-orange-300">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                </svg>
                </div>
                <div class="space-y-1">
                    <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('systemSettings.storageTypeTitle') }}</h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('systemSettings.storageTypeDesc') }}</p>
                </div>
            </div>
            <div class="space-y-3">
                <div v-for="option in storageOptions" :key="option.value" class="flex items-center">
                    <input type="radio" :value="option.value" :checked="storageStatus.activeStorage === option.value" disabled class="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800">
                    <span class="ml-3 text-sm dark:text-gray-300">{{ option.label }}</span>
                </div>

                <p v-if="storageStatus.platform === 'cloudflare' && storageStatus.activeStorage === 'kv'" class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">{{ t('systemSettings.kvBasicModeHint') }}</p>
                <div v-if="storageStatus.platform === 'cloudflare' && storageStatus.activeStorage === 'kv'" class="mt-4 p-4 bg-blue-50/80 dark:bg-blue-900/20 tsub-radius-lg border border-blue-100/80 dark:border-blue-800/60">
                    <h4 class="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">{{ t('systemSettings.migrateToD1') }}</h4>
                    <p class="text-xs text-blue-600 dark:text-blue-400 mb-3">{{ t('systemSettings.d1MigrationDesc') }}</p>
                    <ol class="list-decimal list-inside text-xs text-blue-600 dark:text-blue-400 mb-3 space-y-1">
                        <li><span v-html="t('systemSettings.d1StepCreate')"></span></li>
                        <li><span v-html="t('systemSettings.d1StepSchema')"></span></li>
                        <li>{{ t('systemSettings.d1StepMigrate') }}</li>
                    </ol>
                    <div class="flex flex-col sm:flex-row gap-3">
                        <button type="button" :disabled="isSwitchingStorage || !storageStatus.bindings?.d1" @click="switchStorage('d1')" class="px-4 py-2 text-sm font-medium text-white tsub-radius-lg transition-colors duration-200 bg-blue-600 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center min-w-[120px] shadow-sm">
                            {{ t('systemSettings.startMigration') }}
                        </button>
                        <button @click="copySchema" class="px-4 py-2 text-sm font-medium text-blue-700 dark:text-blue-300 bg-white/80 dark:bg-gray-900/60 border border-blue-200 dark:border-blue-700/70 tsub-radius-lg hover:bg-blue-50 dark:hover:bg-blue-900/40 transition-colors flex items-center justify-center gap-2 shadow-sm">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                            </svg>
                            {{ t('systemSettings.copySchemaSql') }}
                        </button>
                    </div>
                </div>
                <div v-else-if="storageStatus.platform === 'cloudflare' && storageStatus.activeStorage === 'd1'" class="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
                    <p class="text-sm font-medium text-emerald-800 dark:text-emerald-200">{{ t('systemSettings.d1FullModeHint') }}</p>
                    <p v-if="!storageStatus.bindings?.kv" class="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{{ t('systemSettings.kvBindingRequiredForRollback') }}</p>
                    <button type="button" class="mt-3 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-gray-900 dark:hover:bg-white/5" :disabled="isSwitchingStorage || !storageStatus.bindings?.kv" @click="switchStorage('kv')">{{ t('systemSettings.switchBackToKv') }}</button>
                </div>
                <div v-else class="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
                    <p>{{ storageStatus.activeStorage.toUpperCase() }} · {{ t('systemSettings.serverFullModeHint') }}</p>
                    <button v-if="storageStatus.activeStorage === 'sqlite'" type="button" class="mt-3 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-white/15 dark:bg-gray-900 dark:hover:bg-white/5" :disabled="isSwitchingStorage || !storageStatus.bindings?.postgres" @click="switchStorage('postgres')">{{ t('systemSettings.switchToPostgres') }}</button>
                    <button v-else type="button" class="mt-3 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-white/15 dark:bg-gray-900 dark:hover:bg-white/5" :disabled="isSwitchingStorage || !storageStatus.bindings?.sqlite" @click="switchStorage('sqlite')">{{ t('systemSettings.switchToSqlite') }}</button>
                </div>
            </div>
        </div>

        <div v-if="category === 'data'" data-testid="data-commit-mode-card" class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
            <div class="flex items-start justify-between gap-4">
                <div class="min-w-0 space-y-1">
                    <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('systemSettings.dataCommitTitle') }}</h3>
                    <p class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ t('systemSettings.dataCommitDirect') }}</p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('systemSettings.dataCommitDesc') }}</p>
                </div>
                <Switch
                  data-testid="data-commit-mode-switch"
                  :model-value="settings.dataCommitMode === 'direct'"
                  :aria-label="t('systemSettings.dataCommitDirect')"
                  @update:modelValue="value => { settings.dataCommitMode = value ? 'direct' : 'manual'; }"
                />
            </div>
            <div class="mt-4 rounded-lg border border-gray-200/80 bg-gray-50/80 p-3 text-xs leading-5 text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
                <p>{{ settings.dataCommitMode === 'direct' ? t('systemSettings.dataCommitDirectHint') : t('systemSettings.dataCommitManualHint') }}</p>
                <p v-if="storageStatus.platform === 'cloudflare'" class="mt-2 text-amber-700 dark:text-amber-300">{{ t('systemSettings.dataCommitCloudflareHint') }}</p>
            </div>
            <div class="mt-4 flex items-start justify-between gap-4 border-t border-gray-100 pt-4 dark:border-white/10">
                <div class="min-w-0 space-y-1">
                    <p class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ t('systemSettings.dataCommitSilentSuccess') }}</p>
                    <p class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ t('systemSettings.dataCommitSilentSuccessHint') }}</p>
                </div>
                <Switch
                  data-testid="data-commit-silent-success-switch"
                  v-model="settings.directCommitSilentSuccess"
                  :disabled="settings.dataCommitMode !== 'direct'"
                  :aria-label="t('systemSettings.dataCommitSilentSuccess')"
                />
            </div>
        </div>

        <CloudflareUsageCard v-if="category === 'data'" :settings="settings" :platform="storageStatus.platform" />

        <div v-if="category === 'security'" class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
            <div class="mb-5 flex items-start gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2h-1V7a5 5 0 00-10 0v4H6a2 2 0 00-2 2v6a2 2 0 002 2h6z" />
                    </svg>
                </div>
                <div class="space-y-1 flex-1">
                    <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('systemSettings.externalApiTitle') }}</h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('systemSettings.externalApiDesc') }}</p>
                </div>
                <Switch v-model="settings.externalApi.enabled" @update:modelValue="ensureExternalApiDefaults(settings)" />
            </div>

            <div class="space-y-4 rounded-xl border border-violet-100 bg-violet-50/50 p-4 dark:border-violet-900/30 dark:bg-violet-900/10">
                <p class="text-xs leading-5 text-violet-700 dark:text-violet-300">{{ t('systemSettings.externalApiHint') }}</p>
                <p class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ t('systemSettings.externalApiPathHint') }}</p>

                <div class="grid gap-4 md:grid-cols-2">
                    <Input
                      :label="t('systemSettings.externalApiTokenName')"
                      v-model="settings.externalApi.tokens[0].name"
                      :placeholder="t('systemSettings.externalApiTokenNamePlaceholder')"
                    />
                    <Input
                      :label="t('systemSettings.externalApiTokenValue')"
                      v-model="settings.externalApi.tokens[0].token"
                      :placeholder="t('systemSettings.externalApiTokenValuePlaceholder')"
                    />
                </div>

                <div class="flex flex-wrap gap-3">
                    <p v-if="settings.externalApi.tokens[0].configured && !settings.externalApi.tokens[0].token" class="w-full text-xs text-emerald-700 dark:text-emerald-300">{{ t('systemSettings.secretConfigured') }}</p>
                    <button @click="handleGenerateExternalApiToken(settings)" class="px-4 py-2 text-sm font-medium text-white rounded-lg bg-violet-600 hover:bg-violet-700 transition-colors">
                        {{ t('systemSettings.externalApiGenerateToken') }}
                    </button>
                    <button @click="handleCopyExternalApiToken(settings)" class="px-4 py-2 text-sm font-medium rounded-lg border border-violet-200 text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-900/30 transition-colors">
                        {{ t('systemSettings.externalApiCopyToken') }}
                    </button>
                    <button v-if="settings.externalApi.tokens[0].configured" @click="handleClearExternalApiToken(settings)" class="px-4 py-2 text-sm font-medium rounded-lg border border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-900/20 transition-colors">
                        {{ t('systemSettings.clearSecret') }}
                    </button>
                </div>
            </div>
        </div>

        <div v-if="category === 'data'" class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
            <div class="mb-5 flex items-start gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                </div>
                <div class="space-y-1">
                    <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('systemSettings.backupRestoreTitle') }}</h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('systemSettings.backupRestoreDesc') }}</p>
                </div>
            </div>
            <div class="flex gap-4">
                <button @click="exportBackup" class="px-4 py-2 text-sm font-medium text-white tsub-radius-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed bg-green-600 hover:bg-green-700">{{ t('systemSettings.exportBackup') }}</button>
                <button @click="importBackup" class="px-4 py-2 text-sm font-medium text-white tsub-radius-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed bg-orange-500 hover:bg-orange-600">{{ t('systemSettings.importBackup') }}</button>
            </div>
        </div>

        <div v-if="category === 'security'" class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
            <div class="mb-5 flex items-start gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-300">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                </div>
                <div class="space-y-1">
                    <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('systemSettings.adminSecurityTitle') }}</h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('systemSettings.adminSecurityDesc') }}</p>
                </div>
            </div>

            <div class="space-y-5 bg-white/70 dark:bg-gray-900/50 p-6 tsub-radius-lg border border-gray-200/70 dark:border-white/10">
                <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Input :label="t('systemSettings.currentPassword')" v-model="credentialForm.currentPassword" type="password" :placeholder="t('systemSettings.currentPasswordPlaceholder')" autocomplete="current-password" />
                    <Input :label="t('systemSettings.adminUsername')" v-model="credentialForm.username" type="text" :placeholder="t('systemSettings.adminUsernamePlaceholder')" autocomplete="username" />
                    <Input :label="t('systemSettings.newPassword')" v-model="credentialForm.newPassword" type="password" :placeholder="t('systemSettings.newPasswordOptionalPlaceholder')" autocomplete="new-password" />
                    <Input :label="t('systemSettings.confirmPassword')" v-model="credentialForm.confirmPassword" type="password" :placeholder="t('systemSettings.confirmPasswordPlaceholder')" autocomplete="new-password" />
                </div>
                <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('systemSettings.credentialSource', { username: credentialMeta.usernameSource, password: credentialMeta.passwordSource }) }}</p>
                <div class="flex flex-wrap gap-3">
                <button @click="handleUpdateCredentials" :disabled="isUpdatingCredentials || !credentialForm.currentPassword || !credentialForm.username" class="px-6 py-2.5 tsub-radius-lg text-white text-sm font-medium shadow-sm transition-all flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    <svg v-if="isUpdatingCredentials" class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>{{ isUpdatingCredentials ? t('systemSettings.updating') : t('systemSettings.updateCredentials') }}</span>
                </button>
                <button @click="handleResetCredentials" :disabled="isUpdatingCredentials || !credentialMeta.canPersist || !credentialForm.currentPassword" class="px-5 py-2.5 tsub-radius-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/5">{{ t('systemSettings.resetCredentials') }}</button>
                </div>
            </div>
        </div>

        <div v-if="category === 'security'" class="rounded-xl border border-red-200/60 bg-red-50/30 p-6 shadow-sm dark:border-red-900/30 dark:bg-red-900/10">
            <div class="mb-5 flex items-start gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                </div>
                <div class="space-y-1">
                    <h3 class="text-base font-semibold text-red-900 dark:text-red-300">{{ t('systemSettings.dangerZoneTitle') }}</h3>
                    <p class="text-sm text-red-600/80 dark:text-red-400/80">{{ t('systemSettings.dangerZoneDesc') }}</p>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white/50 dark:bg-gray-900/40 p-6 tsub-radius-lg border border-red-100 dark:border-red-900/20">
                <div class="space-y-2">
                    <h4 class="text-sm font-medium text-gray-900 dark:text-white">{{ t('systemSettings.factoryResetTitle') }}</h4>
                    <p class="text-xs text-gray-500 dark:text-gray-400"><span v-html="t('systemSettings.factoryResetDesc')"></span></p>
                </div>
                <div class="flex items-center sm:justify-end">
                    <button @click="handleReset" class="px-5 py-2.5 tsub-radius-lg text-red-600 dark:text-red-400 text-sm font-medium border border-red-200 dark:border-red-900/50 hover:bg-red-600 hover:text-white dark:hover:bg-red-600 dark:hover:text-white transition-all active:scale-95">
                        {{ t('systemSettings.factoryResetTitle') }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

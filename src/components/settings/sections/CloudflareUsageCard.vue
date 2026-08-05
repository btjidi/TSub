<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from '../../../i18n/index.js';
import { useToastStore } from '../../../stores/toast.js';
import Input from '../../ui/Input.vue';
import Switch from '../../ui/Switch.vue';

const props = defineProps({ settings: { type: Object, required: true }, platform: { type: String, default: 'cloudflare' } });
const { t } = useI18n();
const { showToast } = useToastStore();
const defaults = {
  d1: { rowsReadDaily: 5000000, rowsWrittenDaily: 100000, storageBytes: 5000000000, databaseStorageBytes: 500000000 },
  kv: { readsDaily: 100000, writesDaily: 1000, deletesDaily: 1000, listsDaily: 1000, storageBytes: 1000000000 }
};
if (!props.settings.cloudflareUsage) props.settings.cloudflareUsage = { enabled: false, accountId: '', apiToken: '', d1DatabaseId: '', kvNamespaceId: '', limits: structuredClone(defaults) };
if (!props.settings.cloudflareUsage.limits) props.settings.cloudflareUsage.limits = structuredClone(defaults);
for (const section of ['d1', 'kv']) props.settings.cloudflareUsage.limits[section] = { ...defaults[section], ...(props.settings.cloudflareUsage.limits[section] || {}) };

const config = props.settings.cloudflareUsage;
const resources = reactive({ d1: [], kv: [] });
const checks = reactive({ analytics: null, d1: null, kv: null });
const usage = ref(null);
const loadingResources = ref(false);
const loadingUsage = ref(false);
const showCustomLimits = ref(false);
const tokenConfigured = computed(() => Boolean(props.settings.secretStatus?.['cloudflareUsage.apiToken']));
const permissionList = 'Account Analytics: Read\nD1: Read\nWorkers KV Storage: Read';

const errorText = code => t(`systemSettings.cloudflareErrors.${code || 'unknown'}`);
const formatNumber = value => new Intl.NumberFormat(undefined, { notation: Number(value) >= 1000000 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(Number(value || 0));
const formatBytes = value => {
  const bytes = Number(value || 0); const units = ['B', 'KB', 'MB', 'GB', 'TB']; let current = bytes; let index = 0;
  while (current >= 1000 && index < units.length - 1) { current /= 1000; index += 1; }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(current)} ${units[index]}`;
};
const progressClass = metric => metric?.percent >= 90 ? 'bg-red-500' : metric?.percent >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
const progressWidth = metric => `${Math.min(100, Math.max(0, Number(metric?.percent || 0)))}%`;
const dailyWidth = (used, limit) => `${Math.max(2, Math.min(100, Number(used || 0) / Math.max(1, Number(limit || 1)) * 100))}%`;
const visibleGroups = computed(() => [config.d1DatabaseId ? 'd1' : '', config.kvNamespaceId ? 'kv' : ''].filter(Boolean));
const metricEntries = group => group === 'd1'
  ? [['rowsRead', t('systemSettings.cloudflareRowsRead')], ['rowsWritten', t('systemSettings.cloudflareRowsWritten')], ['storage', t('systemSettings.cloudflareStorage')]]
  : [['read', t('systemSettings.cloudflareReads')], ['write', t('systemSettings.cloudflareWrites')], ['delete', t('systemSettings.cloudflareDeletes')], ['list', t('systemSettings.cloudflareLists')], ['storage', t('systemSettings.cloudflareStorage')]];

async function detectResources() {
  loadingResources.value = true;
  try {
    const response = await fetch('/api/storage/cloudflare/resources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: config.accountId, apiToken: config.apiToken }) });
    const body = await response.json();
    if (!body.data) throw new Error(errorText(body.error));
    resources.d1 = body.data.d1 || []; resources.kv = body.data.kv || [];
    Object.assign(checks, body.data.checks || {});
    showToast(t('systemSettings.cloudflareResourcesDetected'), Object.values(checks).every(item => item?.ok) ? 'success' : 'warning');
  } catch (error) { showToast(error.message, 'error'); }
  finally { loadingResources.value = false; }
}

async function loadUsage(refresh = false) {
  if (!config.enabled) return;
  loadingUsage.value = true;
  try {
    const response = await fetch(`/api/storage/cloudflare/usage?days=7${refresh ? '&refresh=1' : ''}`);
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(errorText(body.error));
    usage.value = body.data;
  } catch (error) { showToast(error.message, 'error'); }
  finally { loadingUsage.value = false; }
}

async function copyPermissions() {
  try { await navigator.clipboard.writeText(permissionList); showToast(t('systemSettings.cloudflarePermissionsCopied'), 'success'); }
  catch { showToast(t('systemSettings.copyFailedManual'), 'error'); }
}
function clearToken() {
  config.apiToken = '';
  if (!props.settings.secretActions) props.settings.secretActions = { clearPaths: [], clearExternalTokenIds: [] };
  if (!Array.isArray(props.settings.secretActions.clearPaths)) props.settings.secretActions.clearPaths = [];
  if (!props.settings.secretActions.clearPaths.includes('cloudflareUsage.apiToken')) props.settings.secretActions.clearPaths.push('cloudflareUsage.apiToken');
  showToast(t('systemSettings.secretClearedAfterSave'), 'success');
}
function resetLimits() { config.limits = structuredClone(defaults); }
onMounted(() => { if (config.enabled && tokenConfigured.value) loadUsage(); });
</script>

<template>
  <section v-if="platform === 'cloudflare'" data-testid="cloudflare-usage-card" class="rounded-xl border border-cyan-100 bg-white/90 p-4 shadow-sm sm:p-6 dark:border-cyan-900/40 dark:bg-gray-900/70">
    <div class="flex items-start justify-between gap-4">
      <div><h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('systemSettings.cloudflareUsageTitle') }}</h3><p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('systemSettings.cloudflareUsageDesc') }}</p></div>
      <Switch v-model="config.enabled" />
    </div>

    <details class="mt-4 rounded-lg border border-cyan-200 bg-cyan-50/70 p-3 text-sm dark:border-cyan-800/60 dark:bg-cyan-950/20">
      <summary class="cursor-pointer font-medium text-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:text-cyan-200">{{ t('systemSettings.cloudflarePermissionGuide') }}</summary>
      <ol class="mt-3 list-decimal space-y-1 pl-5 text-xs leading-5 text-cyan-800 dark:text-cyan-200">
        <li v-for="step in 6" :key="step">{{ t(`systemSettings.cloudflarePermissionStep${step}`) }}</li>
      </ol>
      <p class="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">{{ t('systemSettings.cloudflarePermissionWarning') }}</p>
      <button type="button" class="mt-3 rounded-md border border-cyan-300 px-3 py-1.5 text-xs font-medium text-cyan-800 hover:bg-cyan-100 focus:ring-2 focus:ring-cyan-500 dark:border-cyan-700 dark:text-cyan-200 dark:hover:bg-cyan-900/30" @click="copyPermissions">{{ t('systemSettings.cloudflareCopyPermissions') }}</button>
    </details>

    <div class="mt-4 grid gap-4 md:grid-cols-2">
      <Input v-model="config.accountId" :label="t('systemSettings.cloudflareAccountId')" placeholder="32-character Account ID" />
      <div><Input v-model="config.apiToken" type="password" autocomplete="new-password" :label="t('systemSettings.cloudflareApiToken')" :placeholder="tokenConfigured ? t('systemSettings.secretConfigured') : 'Cloudflare API Token'" /><div class="mt-2 flex items-center justify-between gap-3"><p v-if="tokenConfigured && !config.apiToken" class="text-xs text-emerald-700 dark:text-emerald-300">{{ t('systemSettings.secretConfigured') }}</p><button v-if="tokenConfigured" type="button" class="ml-auto text-xs text-red-600 dark:text-red-300" @click="clearToken">{{ t('systemSettings.clearSecret') }}</button></div></div>
    </div>
    <button data-testid="cloudflare-detect-resources" type="button" :disabled="loadingResources || !config.accountId || (!config.apiToken && !tokenConfigured)" class="mt-4 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50" @click="detectResources">{{ loadingResources ? t('common.loading') : t('systemSettings.cloudflareDetectResources') }}</button>
    <div v-if="Object.values(checks).some(Boolean)" class="mt-3 flex flex-wrap gap-2">
      <span v-for="key in ['analytics','d1','kv']" :key="key" class="rounded-full border px-2.5 py-1 text-xs" :class="checks[key]?.ok ? 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300' : 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300'">{{ key === 'analytics' ? 'Analytics' : key.toUpperCase() }} · {{ checks[key]?.ok ? t('systemSettings.cloudflarePermissionPassed') : t('systemSettings.cloudflarePermissionMissing') }}</span>
    </div>
    <div class="mt-4 grid gap-4 md:grid-cols-2">
      <label class="text-sm text-gray-700 dark:text-gray-300">{{ t('systemSettings.cloudflareD1Resource') }}<select v-model="config.d1DatabaseId" class="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-gray-900"><option value="">{{ t('common.disabled') }}</option><option v-if="config.d1DatabaseId && !resources.d1.some(item => item.id === config.d1DatabaseId)" :value="config.d1DatabaseId">{{ config.d1DatabaseId.slice(0, 8) }}…</option><option v-for="item in resources.d1" :key="item.id" :value="item.id">{{ item.name }} · {{ item.id.slice(0, 8) }}</option></select></label>
      <label class="text-sm text-gray-700 dark:text-gray-300">{{ t('systemSettings.cloudflareKvResource') }}<select v-model="config.kvNamespaceId" class="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-gray-900"><option value="">{{ t('common.disabled') }}</option><option v-if="config.kvNamespaceId && !resources.kv.some(item => item.id === config.kvNamespaceId)" :value="config.kvNamespaceId">{{ config.kvNamespaceId.slice(0, 8) }}…</option><option v-for="item in resources.kv" :key="item.id" :value="item.id">{{ item.name }} · {{ item.id.slice(0, 8) }}</option></select></label>
    </div>

    <div class="mt-4"><button type="button" class="text-sm font-medium text-cyan-700 dark:text-cyan-300" @click="showCustomLimits = !showCustomLimits">{{ t('systemSettings.cloudflareCustomLimits') }} {{ showCustomLimits ? '−' : '+' }}</button></div>
    <div v-if="showCustomLimits" class="mt-3 rounded-lg border border-gray-200 p-3 dark:border-white/10"><div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label v-for="item in [
      ['d1','rowsReadDaily','D1 rows read/day'],['d1','rowsWrittenDaily','D1 rows written/day'],['d1','storageBytes','D1 account bytes'],['d1','databaseStorageBytes','D1 database bytes'],['kv','readsDaily','KV reads/day'],['kv','writesDaily','KV writes/day'],['kv','deletesDaily','KV deletes/day'],['kv','listsDaily','KV lists/day'],['kv','storageBytes','KV account bytes']
    ]" :key="item.join('.')" class="text-xs text-gray-600 dark:text-gray-300">{{ item[2] }}<input v-model.number="config.limits[item[0]][item[1]]" type="number" min="1" step="1" class="mt-1 w-full rounded-md border border-gray-200 bg-transparent px-2 py-2 dark:border-white/10" /></label></div><button type="button" class="mt-3 text-xs font-medium text-cyan-700 dark:text-cyan-300" @click="resetLimits">{{ t('systemSettings.cloudflareResetLimits') }}</button></div>

    <div v-if="config.enabled" class="mt-5 border-t border-gray-100 pt-5 dark:border-white/10">
      <div class="flex items-center justify-between gap-3"><h4 class="font-medium text-gray-900 dark:text-white">{{ t('systemSettings.cloudflareTodayUsage') }}</h4><button type="button" :disabled="loadingUsage" class="rounded-md border border-gray-200 px-3 py-1.5 text-xs dark:border-white/10" @click="loadUsage(true)">{{ loadingUsage ? t('common.loading') : t('systemSettings.cloudflareRefresh') }}</button></div>
      <p v-if="usage" class="mt-1 text-xs text-gray-500">{{ t('systemSettings.cloudflareUpdatedAt', { time: new Date(usage.fetchedAt).toLocaleString() }) }}<span v-if="usage.stale" class="ml-2 text-amber-600">{{ t('systemSettings.cloudflareStale') }}</span></p>
      <div v-if="usage" class="mt-4 grid gap-4 lg:grid-cols-2">
        <div v-for="group in visibleGroups" :key="group" class="rounded-lg border border-gray-200 p-3 dark:border-white/10"><h5 class="font-semibold uppercase">{{ group }}</h5><div class="mt-3 space-y-3"><div v-for="entry in metricEntries(group)" :key="entry[0]"><div class="flex flex-wrap justify-between gap-x-2 text-xs"><span>{{ entry[1] }}</span><span class="text-right">{{ entry[0] === 'storage' ? formatBytes(usage.summary[group][entry[0]].used) : formatNumber(usage.summary[group][entry[0]].used) }} / {{ entry[0] === 'storage' ? formatBytes(usage.summary[group][entry[0]].limit) : formatNumber(usage.summary[group][entry[0]].limit) }} · {{ usage.summary[group][entry[0]].percent.toFixed(2) }}%<br><span class="text-gray-500">{{ t('systemSettings.cloudflareRemaining') }} {{ entry[0] === 'storage' ? formatBytes(usage.summary[group][entry[0]].remaining) : formatNumber(usage.summary[group][entry[0]].remaining) }}</span></span></div><div class="mt-1 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-white/10"><div class="h-full rounded-full" :class="progressClass(usage.summary[group][entry[0]])" :style="{ width: progressWidth(usage.summary[group][entry[0]]) }"></div></div></div><p class="text-xs text-gray-500">{{ t('systemSettings.cloudflareSelectedUsage') }}: {{ group === 'd1' ? `${formatNumber(usage.summary.d1.selected.rowsRead)} / ${formatNumber(usage.summary.d1.selected.rowsWritten)} · ${formatBytes(usage.summary.d1.selected.storageBytes)} / ${formatBytes(usage.summary.d1.selected.storage.limit)}` : `${formatNumber(usage.summary.kv.selected.read)} / ${formatNumber(usage.summary.kv.selected.write)} · ${formatBytes(usage.summary.kv.selected.storageBytes)} · ${usage.summary.kv.selected.keyCount} ${t('systemSettings.cloudflareKeys')}` }}</p><p v-if="group === 'kv'" class="text-xs text-gray-500">{{ t('systemSettings.cloudflareAccountKeys') }}: {{ formatNumber(usage.summary.kv.accountKeyCount) }}</p></div></div>
      </div>
      <div v-if="usage" class="mt-5"><h4 class="text-sm font-medium">{{ t('systemSettings.cloudflareSevenDayTrend') }}</h4><div class="mt-3 grid gap-4 lg:grid-cols-2"><div v-for="group in visibleGroups" :key="group" class="rounded-lg border border-gray-100 p-3 dark:border-white/10"><h5 class="mb-3 text-xs font-semibold uppercase">{{ group }}</h5><div class="space-y-3"><div v-for="day in usage.daily" :key="day.date" class="grid grid-cols-[4rem_1fr] items-start gap-2 text-[11px]"><span>{{ day.date.slice(5) }}</span><div class="space-y-1"><div v-for="entry in group === 'd1' ? [['rowsRead','rowsReadDaily','bg-cyan-500','R'],['rowsWritten','rowsWrittenDaily','bg-emerald-500','W']] : [['read','readsDaily','bg-cyan-500','R'],['write','writesDaily','bg-emerald-500','W'],['delete','deletesDaily','bg-red-500','D'],['list','listsDaily','bg-amber-500','L']]" :key="entry[0]" class="grid grid-cols-[1rem_1fr] items-center gap-1"><span>{{ entry[3] }}</span><div class="h-2 rounded bg-gray-100 dark:bg-white/10" tabindex="0" :aria-label="`${day.date} ${group} ${entry[0]} ${formatNumber(day[group][entry[0]])}`"><div class="h-full rounded" :class="entry[2]" :style="{width: dailyWidth(day[group][entry[0]], usage.limits[group][entry[1]])}" :title="`${entry[0]} ${formatNumber(day[group][entry[0]])}`"></div></div></div></div></div></div></div></div><p class="mt-3 text-xs text-gray-500">{{ t('systemSettings.cloudflareUtcHint') }}</p></div>
    </div>
  </section>
</template>

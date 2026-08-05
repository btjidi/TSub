<script setup>
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { formatBytes } from '../../lib/utils.js';
import { TIMING } from '../../constants/timing.js';
import Switch from './Switch.vue';
import { useI18n } from '@/i18n/index.js';
import { useToastStore } from '@/stores/toast.js';
import { hasTrafficUsage, resolveEffectiveTrafficTotal, resolveTrafficQuotaOverride } from '../../utils/traffic-quota.js';

const props = defineProps({
  tsub: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['delete', 'change', 'update', 'edit', 'preview', 'qrcode', 'history']);
const { locale, t } = useI18n();
const { showToast } = useToastStore();

const copySubscriptionUrl = async (url) => {
  if (!url) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(url);
    showToast(t('subscriptions.linkCopied'), 'success');
  } catch {
    showToast(t('subscriptions.linkCopyFailed'), 'error');
  }
};

const getProtocol = (url) => {
  try {
    if (!url) return 'unknown';
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.startsWith('https://')) return 'https';
    if (lowerUrl.startsWith('http://')) return 'http';
    if (lowerUrl.includes('clash')) return 'clash';
  } catch {
    return 'unknown';
  }
  return 'unknown';
};

const protocol = computed(() => getProtocol(props.tsub.url));
const isDemo = computed(() => props.tsub?.demo === true);
const isPushSource = computed(() => ['tsub-deployment-push', 'tsub-demo-push'].includes(props.tsub?.source?.kind));
const isSnapshotSource = computed(() => ['tsub-deployment-snapshot', 'tsub-demo-snapshot'].includes(props.tsub?.source?.kind));
const isManagedDeploymentSource = computed(() => isPushSource.value || isSnapshotSource.value);
const switchInfoId = `subscription-enabled-help-${useId()}`;
const switchInfoRoot = ref(null);
const switchInfoButton = ref(null);
const switchInfoOpen = ref(false);
const switchInfoPinned = ref(false);
let suppressSwitchInfoFocus = false;
const switchInfoText = computed(() => {
  if (isPushSource.value) return t('subscriptions.enabledHelpPush');
  if (isSnapshotSource.value) return t('subscriptions.enabledHelpSnapshot');
  return t('subscriptions.enabledHelpRegular');
});

const closeSwitchInfo = (restoreFocus = false) => {
  switchInfoOpen.value = false;
  switchInfoPinned.value = false;
  if (restoreFocus && switchInfoButton.value && document.activeElement !== switchInfoButton.value) {
    suppressSwitchInfoFocus = true;
    switchInfoButton.value.focus();
    queueMicrotask(() => { suppressSwitchInfoFocus = false; });
  }
};
const showSwitchInfoPreview = () => {
  if (!suppressSwitchInfoFocus) switchInfoOpen.value = true;
};
const hideSwitchInfoPreview = () => {
  if (!switchInfoPinned.value) switchInfoOpen.value = false;
};
const toggleSwitchInfo = () => {
  if (switchInfoPinned.value) closeSwitchInfo();
  else {
    switchInfoPinned.value = true;
    switchInfoOpen.value = true;
  }
};
const handleSwitchInfoOutside = (event) => {
  if (!switchInfoRoot.value?.contains(event.target)) closeSwitchInfo();
};
const handleSwitchInfoKeydown = (event) => {
  if (event.key === 'Escape') closeSwitchInfo(true);
};
const removeSwitchInfoListeners = () => {
  if (typeof document === 'undefined') return;
  document.removeEventListener('pointerdown', handleSwitchInfoOutside);
  document.removeEventListener('keydown', handleSwitchInfoKeydown);
};
watch(switchInfoOpen, (open) => {
  removeSwitchInfoListeners();
  if (open && typeof document !== 'undefined') {
    document.addEventListener('pointerdown', handleSwitchInfoOutside);
    document.addEventListener('keydown', handleSwitchInfoKeydown);
  }
});
const localSubscriptionUrls = computed(() => {
  const values = Array.isArray(props.tsub.localUrls) && props.tsub.localUrls.length ? props.tsub.localUrls : [props.tsub.localUrl];
  return [...new Set(values.filter(Boolean))];
});
const now = ref(Date.now());
let clockTimer;
onMounted(() => {
  clockTimer = window.setInterval(() => { now.value = Date.now(); }, 30_000);
});
onBeforeUnmount(() => {
  window.clearInterval(clockTimer);
  removeSwitchInfoListeners();
});
const pushIntervalMinutes = computed(() => {
  const interval = Number(props.tsub.pushIntervalMinutes);
  return [5, 15, 30, 60].includes(interval) ? interval : 15;
});
const lastPushTimestamp = computed(() => Date.parse(props.tsub.lastPushAt || ''));
const nextPushTimestamp = computed(() => Number.isFinite(lastPushTimestamp.value)
  ? lastPushTimestamp.value + pushIntervalMinutes.value * 60 * 1000
  : NaN);
const pushStale = computed(() => {
  return isPushSource.value && (!Number.isFinite(lastPushTimestamp.value)
    || now.value - lastPushTimestamp.value > pushIntervalMinutes.value * 3 * 60 * 1000);
});
const pushWaiting = computed(() => isPushSource.value && Number.isFinite(nextPushTimestamp.value)
  && now.value > nextPushTimestamp.value && !pushStale.value);
const pushTime = computed(() => props.tsub.lastPushAt ? new Date(props.tsub.lastPushAt).toLocaleString(locale.value) : '');
const nextPushTime = computed(() => Number.isFinite(nextPushTimestamp.value)
  ? new Date(nextPushTimestamp.value).toLocaleString(locale.value)
  : '');
const trafficBackendLabel = computed(() => {
  const backend = props.tsub.trafficBackend;
  if (backend === 'nftables' || backend === 'iptables') return t('subscriptions.trafficBackendPort', { backend });
  if (backend === 'core-singbox') return t('subscriptions.trafficBackendCore', { core: 'sing-box' });
  if (backend === 'core-xray') return t('subscriptions.trafficBackendCore', { core: 'Xray' });
  if (backend === 'unavailable') return t('subscriptions.trafficBackendUnavailable');
  return '';
});

const protocolStyle = computed(() => {
  const p = protocol.value;
  switch (p) {
    case 'https': return { text: 'HTTPS', style: 'bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20' };
    case 'clash': return { text: 'CLASH', style: 'bg-primary-500/10 text-primary-600 dark:text-primary-400 border border-primary-500/20' };
    case 'http': return { text: 'HTTP', style: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20' };
    default: return { text: 'SUB', style: 'bg-gray-500/10 text-gray-500 dark:text-gray-400 border border-gray-500/20' };
  }
});

const trafficInfo = computed(() => {
  const info = props.tsub.userInfo;
  const REASONABLE_TRAFFIC_LIMIT_BYTES = 10 * 1024 * 1024 * 1024 * 1024 * 1024; // 10 PB
  if (
    !info ||
    !hasTrafficUsage(info) ||
    resolveEffectiveTrafficTotal(props.tsub, info) >= REASONABLE_TRAFFIC_LIMIT_BYTES
  ) {
    return null;
  }  
  const total = resolveEffectiveTrafficTotal(props.tsub, info);
  const used = info.download + info.upload;
  const percentage = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  return {
    used: formatBytes(used),
    total: formatBytes(total),
    percentage: percentage,
  };
});
const quotaOnlyInfo = computed(() => {
  if (trafficInfo.value) return null;
  const override = resolveTrafficQuotaOverride(props.tsub);
  return override ? { total: formatBytes(override) } : null;
});

const expiryInfo = computed(() => {
    const expireTimestamp = props.tsub.userInfo?.expire;
    if (!expireTimestamp) return null;
    const REASONABLE_EXPIRY_LIMIT_DAYS = 365 * 10;
    const expiryDate = new Date(expireTimestamp * TIMING.SECOND_IN_MS);
    const now = new Date();
    expiryDate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    if (diffDays > REASONABLE_EXPIRY_LIMIT_DAYS) {
        return null;
    }  
    let style = 'text-gray-500 dark:text-gray-400';
    if (diffDays < 0) style = 'text-red-500 font-bold';
    else if (diffDays <= 7) style = 'text-orange-500 font-semibold';
    return {
        date: expiryDate.toLocaleDateString(locale.value),
        daysRemaining: diffDays < 0 ? t('subscriptions.expired') : (diffDays === 0 ? t('subscriptions.expiresToday') : t('subscriptions.expiresInDays', { count: diffDays })),
        style: style
    };
});

const normalizeWebsiteUrl = (value) => {
  const website = (value || '').trim();
  if (!website) return null;
  if (/^https?:\/\//i.test(website)) return website;
  return `https://${website}`;
};

const websiteUrl = computed(() => {
  const explicitWebsite = normalizeWebsiteUrl(props.tsub.website);
  if (explicitWebsite) return explicitWebsite;

  const notes = props.tsub.notes;
  if (!notes) return null;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = notes.match(urlRegex);
  return matches ? matches[0] : null;
});

const noteWithoutUrl = computed(() => {
  const notes = props.tsub.notes;
  if (!notes) return '';
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return notes.replace(urlRegex, '').trim();
});

const hasFooterMeta = computed(() => Boolean(noteWithoutUrl.value || websiteUrl.value));
</script>

<template>
  <div 
    class="group relative flex h-full min-h-[200px] flex-col overflow-hidden rounded-xl border border-gray-100 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary-500/5 dark:border-white/10 dark:bg-gray-900/70"
    :class="{ 
      'opacity-75 grayscale-[0.8]': !tsub.enabled,
    }"
  >
    <div class="relative z-10 flex flex-col h-full">
      <!-- Header -->
      <div data-testid="subscription-card-header" class="mb-4 flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-3">
        <div class="flex w-full min-w-0 flex-col lg:flex-1">
          <div data-testid="subscription-card-badges" class="mt-1.5 flex flex-wrap items-center gap-2 lg:mb-1.5 lg:mt-0">
            <span class="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" :class="protocolStyle.style">
              {{ protocolStyle.text }}
            </span>
            <span v-if="isPushSource" data-testid="push-source-badge" class="shrink-0 whitespace-nowrap rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">{{ t('subscriptions.activePush') }}</span>
            <span v-if="isSnapshotSource" data-testid="snapshot-source-badge" class="shrink-0 whitespace-nowrap rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-600 dark:text-sky-400">{{ t('subscriptions.installSnapshot') }}</span>
            <span v-if="pushStale" data-testid="push-stale-badge" class="shrink-0 whitespace-nowrap rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">{{ t('subscriptions.pushStale') }}</span>
            <span v-if="expiryInfo" class="shrink-0 whitespace-nowrap rounded-full border border-transparent bg-gray-100 px-2 py-0.5 text-[10px] font-medium dark:bg-white/5" :class="expiryInfo.style">
              {{ expiryInfo.daysRemaining }}
            </span>
          </div>
          <h3 class="order-first truncate text-lg font-semibold leading-tight text-gray-900 lg:order-none dark:text-white" :title="tsub.name || t('subscriptions.unnamed')">
            {{ tsub.name || t('subscriptions.unnamed') }}
          </h3>
        </div>
        
	<!-- Action Buttons (Visible on Hover/Touch) -->
	<div data-testid="subscription-card-actions" class="-my-2 flex w-full shrink-0 items-center justify-end gap-1 opacity-100 transition-opacity duration-200 lg:my-0 lg:w-auto lg:opacity-0 lg:group-hover:opacity-100">
		<button v-if="!isDemo" @click.stop="emit('preview')" class="p-2.5 rounded-full hover:bg-primary-50 dark:hover:bg-white/10 text-gray-400 hover:text-primary-500 transition-colors min-w-[44px] min-h-[44px] lg:min-w-0 lg:min-h-0 flex items-center justify-center" :title="t('actions.previewNodes')" :aria-label="t('actions.previewNodes')">
			<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
		</button>
		<button v-if="!isDemo" @click.stop="emit('qrcode')" class="p-2.5 rounded-full hover:bg-primary-50 dark:hover:bg-white/10 text-gray-400 hover:text-primary-500 transition-colors min-w-[44px] min-h-[44px] lg:min-w-0 lg:min-h-0 flex items-center justify-center" :title="t('actions.showQrCode')" :aria-label="t('actions.showQrCode')">
			<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z" />
				<path stroke-linecap="round" stroke-linejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z" />
			</svg>
		</button>
		<button v-if="isPushSource" data-testid="push-history-button" @click.stop="emit('history')" class="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full p-2.5 text-gray-400 transition-colors hover:bg-primary-50 hover:text-primary-500 dark:hover:bg-white/10 lg:min-h-0 lg:min-w-0" :title="t('pushHistory.open')" :aria-label="t('pushHistory.open')">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>
		</button>
		<button v-if="!isDemo" data-testid="edit-subscription" @click.stop="emit('edit')" class="p-2.5 rounded-full hover:bg-primary-50 dark:hover:bg-white/10 text-gray-400 hover:text-primary-500 transition-colors min-w-[44px] min-h-[44px] lg:min-w-0 lg:min-h-0 flex items-center justify-center" :title="t('actions.edit')" :aria-label="t('actions.edit')">
			<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.536L16.732 3.732z" /></svg>
		</button>
		<button v-if="!isDemo" data-testid="delete-subscription" @click.stop="emit('delete')" class="p-2.5 rounded-full hover:bg-red-50 dark:hover:bg-red-500/20 text-gray-400 hover:text-red-500 transition-colors min-w-[44px] min-h-[44px] lg:min-w-0 lg:min-h-0 flex items-center justify-center" :title="isManagedDeploymentSource ? t('subscriptions.deleteManagedSource') : t('actions.delete')" :aria-label="t('actions.delete')">
			<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
		</button>
	</div>
      </div>
      <div v-if="isPushSource" data-testid="push-schedule" class="-mt-2 mb-3 space-y-1 text-xs" :class="pushStale || pushWaiting ? 'text-amber-600 dark:text-amber-300' : 'text-gray-400'">
        <p>{{ pushTime ? t('subscriptions.lastPushAt', { time: pushTime }) : t('subscriptions.waitingPush') }}<span v-if="trafficBackendLabel"> · {{ trafficBackendLabel }}</span></p>
        <p>{{ t('subscriptions.pushFrequency', { minutes: pushIntervalMinutes }) }} · {{ t('subscriptions.pushCount', { count: Number(tsub.pushCount || 0) }) }}<span v-if="nextPushTime"> · {{ t('subscriptions.nextPushAt', { time: nextPushTime }) }}</span><span v-if="pushWaiting"> · {{ t('subscriptions.pushWaiting') }}</span></p>
      </div>
      <p v-if="isSnapshotSource" class="-mt-2 mb-3 text-xs text-gray-400">{{ t('subscriptions.snapshotNotUpdating') }}<span v-if="trafficBackendLabel"> · {{ trafficBackendLabel }}</span></p>
      <p v-if="isManagedDeploymentSource && tsub.serverAddress" data-testid="push-server-address" class="-mt-1 mb-3 break-all text-xs text-gray-500 dark:text-gray-400">{{ t('subscriptions.pushServerAddress', { address: tsub.serverAddress }) }}</p>

      <!-- URL Display -->
      <div v-if="isManagedDeploymentSource && !isDemo" class="mb-4 grid min-w-0 gap-2">
        <label class="min-w-0 text-[11px] text-gray-500 dark:text-gray-400">
          {{ t('subscriptions.mirrorSubscriptionUrl') }}
          <span class="relative mt-1 block min-w-0">
            <input data-testid="push-mirror-url" type="text" :value="tsub.url" readonly class="w-full min-w-0 rounded-lg border border-gray-100 bg-gray-50/80 py-2 pl-3 pr-11 font-mono text-xs text-gray-500 dark:border-white/5 dark:bg-black/20 dark:text-gray-400" />
            <button data-testid="copy-push-mirror-url" type="button" @click.stop="copySubscriptionUrl(tsub.url)" class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-lg text-gray-400 transition-colors hover:bg-primary-50 hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500/40 active:bg-primary-100 dark:hover:bg-white/10 dark:active:bg-white/15" :title="t('subscriptions.copyMirrorUrl')" :aria-label="t('subscriptions.copyMirrorUrl')"><svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V5a2 2 0 012-2h7a2 2 0 012 2v7a2 2 0 01-2 2h-2M7 8h7a2 2 0 012 2v7a2 2 0 01-2 2H7a2 2 0 01-2-2v-7a2 2 0 012-2z" /></svg></button>
          </span>
        </label>
        <label v-for="(localUrl, localIndex) in localSubscriptionUrls" :key="localUrl" class="min-w-0 text-[11px] text-gray-500 dark:text-gray-400">
          {{ t('subscriptions.vpsSubscriptionUrl') }}<span v-if="localSubscriptionUrls.length > 1"> · {{ localUrl.includes('[') ? 'IPv6' : 'IPv4' }}</span>
          <span class="relative mt-1 block min-w-0">
            <input :data-testid="localIndex === 0 ? 'push-local-url' : `push-local-url-${localIndex}`" type="text" :value="localUrl" readonly class="w-full min-w-0 rounded-lg border border-gray-100 bg-gray-50/80 py-2 pl-3 pr-11 font-mono text-xs text-gray-500 dark:border-white/5 dark:bg-black/20 dark:text-gray-400" />
            <button :data-testid="localIndex === 0 ? 'copy-push-local-url' : `copy-push-local-url-${localIndex}`" type="button" @click.stop="copySubscriptionUrl(localUrl)" class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-lg text-gray-400 transition-colors hover:bg-primary-50 hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500/40 active:bg-primary-100 dark:hover:bg-white/10 dark:active:bg-white/15" :title="t('subscriptions.copyLocalUrl')" :aria-label="t('subscriptions.copyLocalUrl')"><svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V5a2 2 0 012-2h7a2 2 0 012 2v7a2 2 0 01-2 2h-2M7 8h7a2 2 0 012 2v7a2 2 0 01-2 2H7a2 2 0 01-2-2v-7a2 2 0 012-2z" /></svg></button>
          </span>
        </label>
      </div>
      <div v-else-if="!isDemo" class="relative mb-4">
          <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <svg class="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
          </div>
        <div class="relative min-w-0">
          <input data-testid="subscription-url" type="text" :value="tsub.url" readonly class="w-full min-w-0 rounded-lg border border-gray-100 bg-gray-50/80 py-2 pl-9 pr-11 font-mono text-xs text-gray-500 transition-all focus:border-primary-500/30 focus:bg-white focus:outline-none dark:border-white/5 dark:bg-black/20 dark:text-gray-400 dark:focus:bg-black/40" />
          <button data-testid="copy-subscription-url" type="button" @click.stop="copySubscriptionUrl(tsub.url)" class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-lg text-gray-400 transition-colors hover:bg-primary-50 hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500/40 active:bg-primary-100 dark:hover:bg-white/10 dark:active:bg-white/15" :title="t('subscriptions.copySubscriptionUrl')" :aria-label="t('subscriptions.copySubscriptionUrl')"><svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V5a2 2 0 012-2h7a2 2 0 012 2v7a2 2 0 01-2 2h-2M7 8h7a2 2 0 012 2v7a2 2 0 01-2 2H7a2 2 0 01-2-2v-7a2 2 0 012-2z" /></svg></button>
        </div>
      </div>

      <div class="grid gap-3 rounded-lg border border-gray-100 bg-gray-50/80 p-3 dark:border-white/10 dark:bg-white/5">
        <div v-if="trafficInfo" class="space-y-2">
          <div class="flex items-end justify-between text-xs">
            <span class="text-gray-500 dark:text-gray-400">{{ t('subscriptions.usedTraffic') }} <span class="font-semibold text-gray-700 dark:text-gray-200">{{ trafficInfo.used }}</span></span>
            <span class="text-gray-400">{{ trafficInfo.total }}</span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-white/10">
            <div class="h-full rounded-full bg-gradient-to-r from-primary-400 to-cyan-400 transition-all duration-500" :style="{ width: trafficInfo.percentage + '%' }"></div>
          </div>
        </div>
        <div v-else-if="quotaOnlyInfo" class="flex items-center justify-between gap-2 text-xs">
          <span class="text-gray-500 dark:text-gray-400">{{ t('subscriptions.customQuota') }}</span>
          <span class="text-right font-semibold text-gray-700 dark:text-gray-200">{{ quotaOnlyInfo.total }} · {{ t('subscriptions.trafficUsageUnavailable') }}</span>
        </div>
        <div v-else class="text-xs text-gray-400">
          {{ t('subscriptions.noTrafficData') }}
        </div>
        <div class="flex items-center justify-between text-xs">
          <span class="text-gray-500 dark:text-gray-400">{{ t('subscriptions.nodeCountLabel') }}</span>
          <span class="font-semibold text-gray-700 dark:text-gray-200">
            {{ tsub.isUpdating ? t('subscriptions.updating') : t('subscriptions.nodeCount', { count: tsub.nodeCount || 0 }) }}
          </span>
        </div>
      </div>

      <!-- Notes / Website -->
      <div v-if="hasFooterMeta" data-testid="subscription-footer-meta" class="mt-3 flex items-center gap-1 truncate text-[10px] text-gray-400">
        <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg>
        <a
          v-if="websiteUrl"
          data-testid="subscription-website-link"
          :href="websiteUrl"
          target="_blank"
          rel="noopener noreferrer"
          @click.stop
          class="flex items-center gap-0.5 text-primary-500 hover:text-primary-600 font-medium transition-colors cursor-pointer"
          :title="t('subscriptions.visitWebsite')"
        >
          {{ t('subscriptions.website') }}
          <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
        </a>
        <span v-if="noteWithoutUrl" data-testid="subscription-notes" class="truncate">{{ noteWithoutUrl }}</span>
      </div>

      <!-- Footer Actions -->
      <div data-testid="subscription-footer" class="mt-auto flex items-center justify-end border-t border-gray-100 pt-3 dark:border-white/10">
        <div data-testid="subscription-footer-actions" class="flex items-center gap-3">
          <button v-if="!isDemo && !isManagedDeploymentSource" @click.stop="emit('update')" :disabled="tsub.isUpdating" class="p-1.5 rounded-full hover:bg-primary-50 dark:hover:bg-white/10 text-gray-400 hover:text-primary-500 transition-colors disabled:opacity-50" :title="tsub.isUpdating ? t('subscriptions.updating') : t('subscriptions.updateNodeInfo')">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" :class="{'animate-spin text-primary-500': tsub.isUpdating}" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd" />
            </svg>
          </button>
          <div v-if="!isDemo" data-testid="subscription-enabled-switch" class="flex items-center">
            <Switch
              v-model="tsub.enabled"
              @change="emit('change')"
            />
          </div>
          <div
            v-if="!isDemo"
            ref="switchInfoRoot"
            data-testid="subscription-enabled-help-container"
            class="relative"
            @mouseenter="showSwitchInfoPreview"
            @mouseleave="hideSwitchInfoPreview"
          >
            <button
              ref="switchInfoButton"
              data-testid="subscription-enabled-help"
              type="button"
              class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-colors duration-150 hover:bg-primary-50 hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 active:bg-primary-100 dark:hover:bg-white/10 dark:hover:text-primary-400"
              :aria-label="t('subscriptions.enabledHelpLabel')"
              :aria-expanded="switchInfoOpen"
              :aria-controls="switchInfoId"
              :aria-describedby="switchInfoOpen ? switchInfoId : undefined"
              @focus="showSwitchInfoPreview"
              @blur="hideSwitchInfoPreview"
              @click.stop="toggleSwitchInfo"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path stroke-linecap="round" d="M12 11v5" />
                <path stroke-linecap="round" d="M12 8h.01" />
              </svg>
            </button>
            <div
              v-show="switchInfoOpen"
              :id="switchInfoId"
              data-testid="subscription-enabled-tooltip"
              role="tooltip"
              class="absolute bottom-full right-0 z-30 mb-2 w-[min(17rem,calc(100vw-3rem))] rounded-lg bg-gray-900 px-3 py-2 text-left text-xs leading-5 text-white shadow-xl dark:border dark:border-white/10 dark:bg-gray-700"
            >
              {{ switchInfoText }}
              <span class="absolute right-2.5 top-full h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-gray-900 dark:border-t-gray-700" aria-hidden="true"></span>
            </div>
          </div>
        </div>

      </div>

    </div>
  </div>
</template>

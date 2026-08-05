<script setup>
import { computed } from 'vue';
import Modal from '../forms/Modal.vue';
import { useI18n } from '@/i18n/index.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  record: { type: Object, default: () => ({}) }
});

const emit = defineEmits(['update:show']);
const { locale, t } = useI18n();
const interval = computed(() => {
  const value = Number(props.record.pushIntervalMinutes ?? props.record.configSummary?.subscriptionServer?.pushIntervalMinutes);
  return [5, 15, 30, 60].includes(value) ? value : 15;
});
const history = computed(() => (Array.isArray(props.record.pushHistory) ? props.record.pushHistory : [])
  .filter(value => Number.isFinite(Date.parse(value)))
  .slice(0, 5));
const lastPushAt = computed(() => props.record.lastPushAt || history.value[0] || '');
const pushStatus = computed(() => {
  if (!lastPushAt.value) return t('pushHistory.statusWaiting');
  const age = Date.now() - Date.parse(lastPushAt.value);
  return age > interval.value * 3 * 60 * 1000 ? t('pushHistory.statusOverdue') : t('pushHistory.statusNormal');
});
const formatDate = value => new Date(value).toLocaleString(locale.value);
</script>

<template>
  <Modal :show="show" size="md" @update:show="emit('update:show', $event)">
    <template #title><h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ t('pushHistory.title') }}</h3></template>
    <template #body>
      <div class="space-y-4" data-testid="push-history-modal">
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-white/10 dark:bg-white/5"><p class="text-xs text-gray-500">{{ t('pushHistory.total') }}</p><p class="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{{ Number(record.pushCount || 0) }}</p></div>
          <div class="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-white/10 dark:bg-white/5"><p class="text-xs text-gray-500">{{ t('pushHistory.frequency') }}</p><p class="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{{ t('pushHistory.everyMinutes', { minutes: interval }) }}</p></div>
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('pushHistory.currentStatus') }}：<span class="font-medium text-gray-800 dark:text-gray-200">{{ pushStatus }}</span></p>
        <div>
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('pushHistory.recentTitle') }}</h4>
          <ol v-if="history.length" class="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-100 dark:divide-white/10 dark:border-white/10">
            <li v-for="(time, index) in history" :key="time" class="flex items-center gap-3 px-3 py-2.5 text-sm"><span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-50 text-xs font-semibold text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">{{ index + 1 }}</span><time :datetime="time" class="text-gray-700 dark:text-gray-200">{{ formatDate(time) }}</time></li>
          </ol>
          <p v-else class="mt-2 rounded-lg border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500 dark:border-white/10">{{ t('pushHistory.empty') }}</p>
        </div>
      </div>
    </template>
    <template #footer><button type="button" class="cursor-pointer rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700" @click="emit('update:show', false)">{{ t('actions.close') }}</button></template>
  </Modal>
</template>

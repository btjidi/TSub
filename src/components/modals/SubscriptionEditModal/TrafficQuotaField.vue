<script setup>
import { computed } from 'vue';
import { useI18n } from '../../../i18n/index.js';
import { trafficQuotaFormToBytes } from '../../../utils/traffic-quota.js';

const props = defineProps({
  editingSubscription: {
    type: Object,
    required: true
  }
});

const { t } = useI18n();
const hasValue = computed(() => String(props.editingSubscription._trafficQuotaValue ?? '').trim() !== '');
const isInvalid = computed(() => hasValue.value && !trafficQuotaFormToBytes(
  props.editingSubscription._trafficQuotaValue,
  props.editingSubscription._trafficQuotaUnit
).valid);
</script>

<template>
  <div>
    <label for="sub-edit-traffic-quota" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
      {{ t('subscriptions.trafficQuotaLabel') }}
      <span class="ml-2 text-xs font-normal text-gray-500">{{ t('subscriptions.optionalDefault') }}</span>
    </label>
    <div class="mt-1 grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
      <input
        id="sub-edit-traffic-quota"
        v-model="editingSubscription._trafficQuotaValue"
        data-testid="subscription-traffic-quota-value"
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        :placeholder="t('subscriptions.trafficQuotaPlaceholder')"
        :aria-invalid="isInvalid"
        class="min-w-0 rounded-lg border bg-white px-3 py-2 text-sm text-gray-800 transition focus:outline-none focus:ring-2 dark:bg-gray-800 dark:text-white"
        :class="isInvalid ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20 dark:border-red-500' : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500/20 dark:border-gray-600'"
      />
      <select
        v-model="editingSubscription._trafficQuotaUnit"
        data-testid="subscription-traffic-quota-unit"
        :aria-label="t('subscriptions.trafficQuotaUnit')"
        class="cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 transition hover:border-primary-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
      >
        <option value="GB">GB</option>
        <option value="TB">TB</option>
      </select>
    </div>
    <p v-if="isInvalid" class="mt-1 text-xs text-red-500" role="alert">{{ t('subscriptions.trafficQuotaInvalid') }}</p>
    <p v-else class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ t('subscriptions.trafficQuotaHint') }}</p>
  </div>
</template>

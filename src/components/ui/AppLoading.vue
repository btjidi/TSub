<script setup>
import { useI18n } from '../../i18n/index.js';

const { t } = useI18n();
</script>

<template>
  <div
    class="flex min-h-[60vh] flex-col items-center justify-center p-8"
    role="status"
    aria-live="polite"
  >
    <div class="relative mb-5">
      <div class="h-16 w-16 animate-pulse rounded-full border-4 border-primary-200 dark:border-primary-800"></div>
      <div class="absolute inset-0 h-16 w-16 animate-spin rounded-full border-4 border-transparent border-t-primary-500"></div>
    </div>
    <p class="text-sm font-medium text-gray-500 dark:text-gray-400">{{ t('common.loading') }}</p>
  </div>
</template>

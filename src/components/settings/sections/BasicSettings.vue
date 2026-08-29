<script setup>
import SectionHeader from '../SectionHeader.vue';
const props = defineProps({
  settings: {
    type: Object,
    required: true
  },
  disguiseConfig: {
    type: Object,
    required: true
  }
});

import Input from '../../ui/Input.vue';
import Switch from '../../ui/Switch.vue';
import { watch, computed } from 'vue';
import { useToastStore } from '../../../stores/toast';
import { useI18n } from '../../../i18n/index.js';
import {
  normalizeTrafficNodeDisplay,
  sanitizeTrafficNodeCustomLabel,
  TRAFFIC_NODE_CUSTOM_LABEL_MAX_LENGTH,
  TRAFFIC_NODE_KEYS,
  TRAFFIC_NODE_LABEL_OPTIONS,
  TRAFFIC_NODE_LAYOUTS
} from '../../../constants/traffic-node-settings.js';

const { showToast } = useToastStore();
const { t } = useI18n();

props.settings.trafficNodeDisplay = normalizeTrafficNodeDisplay(props.settings.trafficNodeDisplay);

const trafficNodeItems = computed(() => TRAFFIC_NODE_KEYS.map(key => ({
  key,
  title: t(`settings.trafficNodeMetric${key[0].toUpperCase()}${key.slice(1)}`),
  options: TRAFFIC_NODE_LABEL_OPTIONS[key].map(option => option.value === 'custom'
    ? { ...option, text: t('settings.trafficNodeLabelCustom') }
    : option)
})));

const trafficNodeLayouts = computed(() => TRAFFIC_NODE_LAYOUTS.map(layout => ({
  value: layout,
  label: t(`settings.trafficNodeLayout${layout[0].toUpperCase()}${layout.slice(1)}`)
})));

const toggleTrafficNodeMetric = (key, checked, input) => {
  const display = props.settings.trafficNodeDisplay;
  const enabledCount = TRAFFIC_NODE_KEYS.filter(itemKey => display[itemKey].enabled).length;
  if (!checked && display[key].enabled && enabledCount === 1) {
    if (input) input.checked = true;
    showToast(t('settings.trafficNodeAtLeastOne'), 'warning');
    return;
  }
  display[key].enabled = checked;
};

const normalizeCustomTrafficNodeLabel = (key) => {
  const item = props.settings.trafficNodeDisplay[key];
  item.customLabel = sanitizeTrafficNodeCustomLabel(item.customLabel);
};

// 系统保留路径列表，这些路径会与前端路由或后端 API 冲突
const RESERVED_PATHS = [
  'settings', 'login', 'groups', 'nodes', 'subscriptions', 'dashboard',
  'api', 'explore', 'sub', 'cron', 'assets', '@vite', 'public', 'profile', 'offline',
  'logout', 'auth_debug', 'auth_check', 'data', 'kv_test',
  'clients', 'system', 'github', 'telegram', 'test_notification',
  'tsubs', 'node_count', 'fetch_external_url', 'batch_update_nodes',
  'subscription_nodes', 'debug_subscription', 'preview'
];

const getPathSegment = (value) => value.replace(/^\/+/, '').split('/')[0].toLowerCase();
const hasInvalidTokenChars = (value) => /[\s\/?#]/.test(value);
const generateSubscriptionToken = () => {
  props.settings.mytoken = crypto.randomUUID();
};

const customLoginPathError = computed(() => {
  const value = props.settings.customLoginPath;
  if (!value) return '';

  if (/[^a-zA-Z0-9-_\/]/.test(value)) {
    return t('settings.reservedPathChars');
  }

  const pathSegment = getPathSegment(value);
  if (RESERVED_PATHS.includes(pathSegment)) {
    return t('settings.reservedPathCustomLogin', { path: pathSegment });
  }

  return '';
});

const myTokenError = computed(() => {
  const value = props.settings.mytoken;
  if (!value) return '';

  if (hasInvalidTokenChars(value)) {
    return t('settings.reservedTokenChars');
  }

  const pathSegment = getPathSegment(value);
  return RESERVED_PATHS.includes(pathSegment) ? t('settings.reservedPathSubscriptionToken') : '';
});

const profileTokenError = computed(() => {
  const value = props.settings.profileToken;
  if (!value) return '';

  if (hasInvalidTokenChars(value)) {
    return t('settings.reservedTokenChars');
  }

  const pathSegment = getPathSegment(value);
  return RESERVED_PATHS.includes(pathSegment) ? t('settings.reservedPathProfileToken') : '';
});

// 监听自定义登录路径，保留输入并通过提示引导修正
watch(() => props.settings.customLoginPath, (val) => {
  if (!val) return;
  
  // 仅允许字母、数字、下划线、中划线和斜杠
  const sanitized = val.replace(/[^a-zA-Z0-9-_\/]/g, '');
  
  if (sanitized !== val) {
    props.settings.customLoginPath = sanitized;
    showToast(t('settings.reservedPathCharsToast'), 'warning');
    return;
  }
});

watch(() => props.settings.mytoken, (val) => {
  if (!val) return;
  if (hasInvalidTokenChars(val)) {
    showToast(t('settings.reservedTokenChars'), 'error');
    return;
  }
  const pathSegment = getPathSegment(val);
  if (RESERVED_PATHS.includes(pathSegment)) {
    showToast(t('settings.reservedPathSubscriptionToken'), 'error');
  }
});

watch(() => props.settings.profileToken, (val) => {
  if (!val) return;
  if (hasInvalidTokenChars(val)) {
    showToast(t('settings.reservedTokenChars'), 'error');
    return;
  }
  const pathSegment = getPathSegment(val);
  if (RESERVED_PATHS.includes(pathSegment)) {
    showToast(t('settings.reservedPathProfileToken'), 'error');
  }
});


</script>

<template>
  <div class="space-y-8 flex flex-col">
    <!-- 默认显示语言 -->
    <div class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
      <SectionHeader :title="t('settings.defaultLanguageTitle')" :description="t('settings.defaultLanguageDesc')" tone="amber">
        <template #icon>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m5 8 6 6" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4 14 6-6 2-3" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 5h12" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 2h1" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m22 22-5-10-5 10" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 18h6" />
          </svg>
        </template>
      </SectionHeader>
      <div class="max-w-xs">
        <select
          v-model="settings.defaultLocale"
          class="block w-full px-3 py-2.5 bg-white/80 dark:bg-gray-900/60 border border-gray-200/80 dark:border-white/10 tsub-radius-lg shadow-sm focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 sm:text-sm dark:text-white transition-colors"
        >
          <option value="zh-CN">{{ t('settings.defaultLanguageZh') }}</option>
          <option value="en-US">{{ t('settings.defaultLanguageEn') }}</option>
        </select>
      </div>
    </div>

    <!-- 订阅基本信息配置 -->
    <div class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
      <SectionHeader :title="t('settings.subscriptionConfigTitle')" :description="t('settings.subscriptionConfigDesc')" tone="indigo">
        <template #icon>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </template>
      </SectionHeader>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div>
          <Input 
            :label="t('settings.customFileName')"
            v-model="settings.FileName"
            class="tsub-radius-lg"
          />
        </div>
        <div>
          <label for="custom-subscription-token" class="mb-1.5 ml-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('settings.customToken') }}</label>
          <div class="relative group">
            <input
              id="custom-subscription-token"
              v-model="settings.mytoken"
              data-testid="custom-subscription-token"
              type="text"
              autocomplete="off"
              class="tsub-radius-md w-full border border-gray-200 bg-white py-2 pl-3 pr-16 font-mono text-sm text-gray-900 transition-colors duration-150 placeholder:text-gray-400 focus:border-primary-500/70 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-white/10 dark:bg-white/[0.035] dark:text-[#f7f8f8] dark:placeholder:text-gray-500"
              :class="myTokenError ? 'border-red-500 focus:border-red-500 focus:ring-red-500/50' : ''"
            />
            <button
              data-testid="generate-custom-subscription-token"
              type="button"
              class="absolute inset-y-px right-px cursor-pointer border-0 border-l border-gray-200 bg-gray-50 px-3 text-xs font-medium text-primary-600 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 active:bg-primary-100 dark:border-white/10 dark:bg-gray-900 dark:text-primary-400 dark:hover:bg-white/10"
              :title="t('settings.generateSubscriptionToken')"
              :aria-label="t('settings.generateSubscriptionToken')"
              @click="generateSubscriptionToken"
            >{{ t('settings.generate') }}</button>
          </div>
          <p v-if="myTokenError" class="ml-1 mt-1 text-xs text-red-500">{{ myTokenError }}</p>
        </div>
        <div>
          <Input 
            :label="t('settings.profileToken')"
            v-model="settings.profileToken"
            :placeholder="t('settings.profileTokenPlaceholder')"
            :error="profileTokenError"
            class="tsub-radius-lg"
        />
      </div>
    </div>
    </div>

    <!-- 功能开关区域 -->
    <div class="rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
      <SectionHeader :title="t('settings.featureControlTitle')" :description="t('settings.featureControlDesc')" tone="green">
        <template #icon>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        </template>
      </SectionHeader>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- 订阅自动更新间隔 -->
        <div
          class="p-4 bg-white/70 dark:bg-gray-900/50 border border-gray-200/70 dark:border-white/10 tsub-radius-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-gray-200">{{ t('settings.autoUpdateInterval') }}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settings.autoUpdateDesc') }}</p>
            </div>
          </div>
          <div class="mt-3 flex flex-wrap gap-3">
            <div class="flex items-center gap-2">
              <input
                type="number"
                :value="![0, 30, 60, 120].includes(settings.autoUpdateInterval) ? settings.autoUpdateInterval : ''"
                @input="e => { const v = parseInt(e.target.value); if (v >= 5) settings.autoUpdateInterval = v; }"
                :placeholder="t('settings.customInterval')"
                min="5"
                class="w-24 px-2.5 py-2 text-sm bg-white/70 dark:bg-black/20 border border-gray-200/80 dark:border-white/10 tsub-radius-md text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500 outline-none transition-all"
              >
              <span class="text-xs text-gray-500 dark:text-gray-400">{{ t('settings.minutes') }}</span>
            </div>
            <span class="text-xs text-gray-400 dark:text-gray-500 self-center">{{ t('settings.quickSelect') }}</span>
            <button
              v-for="option in [
                { value: 0, label: t('settings.disabledOption') },
                { value: 30, label: t('settings.option30Minutes') },
                { value: 60, label: t('settings.option1Hour') }
              ]"
              :key="option.value"
              @click="settings.autoUpdateInterval = option.value"
              :aria-pressed="settings.autoUpdateInterval === option.value"
              :class="[
                'px-3 py-2 text-xs font-medium tsub-radius-md border transition-colors',
                settings.autoUpdateInterval === option.value
                  ? 'bg-primary-600 text-white border-primary-600 shadow-sm shadow-primary-500/30'
                  : 'bg-white/70 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300 border-gray-200/70 dark:border-white/10 hover:bg-white dark:hover:bg-gray-800'
              ]"
            >
              {{ option.label }}
            </button>
          </div>
          <p v-if="settings.autoUpdateInterval === 0" class="text-xs text-amber-600 dark:text-amber-400 mt-2">
            {{ t('settings.autoUpdateDisabledHint') }}
          </p>
        </div>

        <!-- 访问日志 -->
        <div
          class="flex items-center justify-between p-4 bg-white/70 dark:bg-gray-900/50 border border-gray-200/70 dark:border-white/10 tsub-radius-lg">
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-gray-200">{{ t('settings.accessLogTitle') }}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settings.accessLogDesc') }}</p>
            <p class="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
              {{ t('settings.accessLogQuotaHint') }}
            </p>
          </div>
          <Switch 
            v-model="settings.enableAccessLog"
          />
        </div>

        <div
          v-if="settings.enableAccessLog"
          class="p-4 bg-white/70 dark:bg-gray-900/50 border border-gray-200/70 dark:border-white/10 tsub-radius-lg space-y-2">
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-gray-200">{{ t('settings.accessLogMode') }}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settings.accessLogModeDesc') }}</p>
          </div>
          <select
            v-model="settings.accessLogPersistenceMode"
            class="block w-full px-3 py-2 bg-white/80 dark:bg-gray-900/60 border border-gray-200/80 dark:border-white/10 tsub-radius-lg shadow-sm focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 sm:text-sm dark:text-white transition-colors"
          >
            <option value="light">{{ t('settings.accessLogLight') }}</option>
            <option value="full">{{ t('settings.accessLogFull') }}</option>
          </select>
        </div>

        <!-- 流量统计节点 -->
        <div class="overflow-hidden bg-white/70 dark:bg-gray-900/50 border border-gray-200/70 dark:border-white/10 tsub-radius-lg">
          <div class="flex items-center justify-between gap-4 p-4">
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-gray-200">{{ t('settings.trafficNodeTitle') }}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settings.trafficNodeDesc') }}</p>
            </div>
            <Switch v-model="settings.enableTrafficNode" />
          </div>
          <div
            v-if="settings.enableTrafficNode"
            class="border-t border-gray-200/70 p-3 dark:border-white/10"
          >
            <p class="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">{{ t('settings.trafficNodeLayoutTitle') }}</p>
            <div
              class="grid grid-cols-3 overflow-hidden rounded-md border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-gray-950/60"
              role="radiogroup"
              :aria-label="t('settings.trafficNodeLayoutTitle')"
              data-testid="traffic-node-layout"
            >
              <button
                v-for="layout in trafficNodeLayouts"
                :key="layout.value"
                type="button"
                role="radio"
                :aria-checked="settings.trafficNodeDisplay.layout === layout.value"
                :data-testid="`traffic-node-layout-${layout.value}`"
                class="cursor-pointer border-r border-gray-200 px-2 py-2 text-sm font-medium text-gray-600 transition last:border-r-0 hover:bg-blue-50 hover:text-blue-700 focus:relative focus:z-10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 active:bg-blue-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-blue-500/15 dark:hover:text-blue-300"
                :class="settings.trafficNodeDisplay.layout === layout.value ? 'bg-blue-600 text-white shadow-sm hover:bg-blue-700 hover:text-white dark:bg-blue-600 dark:text-white dark:hover:bg-blue-500' : ''"
                @click="settings.trafficNodeDisplay.layout = layout.value"
              >
                {{ layout.label }}
              </button>
            </div>
          </div>
          <div
            v-if="settings.enableTrafficNode"
            class="grid grid-cols-1 border-t border-gray-200/70 dark:border-white/10 sm:grid-cols-2 xl:grid-cols-4"
            data-testid="traffic-node-options"
          >
            <div
              v-for="item in trafficNodeItems"
              :key="item.key"
              class="min-w-0 border-b border-gray-200/60 p-3 last:border-b-0 dark:border-white/10 sm:[&:nth-last-child(-n+2)]:border-b-0 sm:odd:border-r xl:border-b-0 xl:border-r xl:last:border-r-0"
            >
              <label class="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 transition focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed dark:border-gray-600 dark:bg-gray-800"
                  :checked="settings.trafficNodeDisplay[item.key].enabled"
                  :data-testid="`traffic-node-enabled-${item.key}`"
                  @change="toggleTrafficNodeMetric(item.key, $event.target.checked, $event.target)"
                />
                {{ item.title }}
              </label>
              <select
                v-model="settings.trafficNodeDisplay[item.key].label"
                :disabled="!settings.trafficNodeDisplay[item.key].enabled"
                :aria-label="t('settings.trafficNodeLabelStyle', { metric: item.title })"
                :data-testid="`traffic-node-label-${item.key}`"
                class="mt-2 block w-full cursor-pointer rounded-md border border-gray-200 bg-white/90 px-2.5 py-2 text-sm text-gray-800 transition hover:border-blue-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-gray-950/70 dark:text-gray-100 dark:hover:border-blue-500"
              >
                <option v-for="option in item.options" :key="option.value" :value="option.value">{{ option.text }}</option>
              </select>
              <input
                v-if="settings.trafficNodeDisplay[item.key].label === 'custom'"
                v-model="settings.trafficNodeDisplay[item.key].customLabel"
                type="text"
                :maxlength="TRAFFIC_NODE_CUSTOM_LABEL_MAX_LENGTH"
                :disabled="!settings.trafficNodeDisplay[item.key].enabled"
                :placeholder="t('settings.trafficNodeCustomLabelPlaceholder')"
                :aria-label="t('settings.trafficNodeCustomLabelAria', { metric: item.title })"
                :data-testid="`traffic-node-custom-label-${item.key}`"
                class="mt-2 block w-full rounded-md border border-gray-200 bg-white/90 px-2.5 py-2 text-sm text-gray-800 transition placeholder:text-gray-400 hover:border-blue-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-gray-950/70 dark:text-gray-100 dark:placeholder:text-gray-500 dark:hover:border-blue-500"
                @blur="normalizeCustomTrafficNodeLabel(item.key)"
              />
            </div>
          </div>
        </div>

        <!-- 合并到期时间策略 -->
        <div
          class="p-4 bg-white/70 dark:bg-gray-900/50 border border-gray-200/70 dark:border-white/10 tsub-radius-lg space-y-2">
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-gray-200">{{ t('settings.mergeExpireStrategyTitle') }}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settings.mergeExpireStrategyDesc') }}</p>
          </div>
          <select
            v-model="settings.mergeExpireStrategy"
            class="block w-full px-3 py-2 bg-white/80 dark:bg-gray-900/60 border border-gray-200/80 dark:border-white/10 tsub-radius-lg shadow-sm focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 sm:text-sm dark:text-white transition-colors"
          >
            <option value="max">{{ t('settings.mergeExpireMax') }}</option>
            <option value="min">{{ t('settings.mergeExpireMin') }}</option>
          </select>
        </div>
      </div>
    </div>



    <!-- Web 访问控制 -->
    <div class="order-first rounded-xl border border-gray-100/80 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
      <SectionHeader :title="t('settings.webAccessTitle')" :description="t('settings.webAccessDesc')" tone="blue">
        <template #icon>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
          </svg>
        </template>
      </SectionHeader>

      <div class="mb-5 rounded-lg border border-gray-200/70 bg-white/70 p-4 dark:border-white/10 dark:bg-gray-900/50">
        <Input
          :label="t('settings.publicUrlTitle')"
          v-model="settings.publicUrl"
          type="url"
          placeholder="https://example.com"
          autocomplete="url"
          class="tsub-radius-lg"
        />
        <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{{ t('settings.publicUrlDesc') }}</p>
      </div>

      <div
        class="bg-white/70 dark:bg-gray-900/50 border border-gray-200/70 dark:border-white/10 tsub-radius-lg divide-y divide-gray-200/60 dark:divide-white/10 overflow-hidden">
        <!-- 公开页访问 -->
        <div
          class="p-4 flex items-center justify-between hover:bg-gray-50/80 dark:hover:bg-white/5 transition-colors">
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-gray-200">{{ t('settings.publicPageAccessTitle') }}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settings.publicPageAccessDesc') }}</p>
          </div>
          <Switch 
            v-model="settings.enablePublicPage"
          />
        </div>

        <!-- 伪装页面 -->
        <div class="p-4 space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-gray-200">{{ t('settings.disguisePageTitle') }}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settings.disguisePageDesc') }}</p>
            </div>
            <Switch 
              v-model="disguiseConfig.enabled"
            />
          </div>

          <!-- 自定义登录路径设置 -->
          <div class="pt-4 border-t border-gray-200/70 dark:border-white/10">
             <div class="max-w-md">
                <!-- 隐藏的诱饵输入框，吸收浏览器自动填充 -->
                <input type="text" name="fake_user_for_autofill" autocomplete="username" style="display:none" tabindex="-1" aria-hidden="true" />
                <input type="password" name="fake_pass_for_autofill" autocomplete="current-password" style="display:none" tabindex="-1" aria-hidden="true" />
                 <Input 
                   :label="t('settings.customAdminPath')"
                   v-model="settings.customLoginPath"
                   :error="customLoginPathError"
                   :placeholder="t('settings.customAdminPathPlaceholder')"
                   prefix="/"
                  autocomplete="off"
                  name="custom_admin_path_setting_no_autofill"
                  type="search"
                />
             </div>
             <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
               {{ t('settings.customAdminPathHint') }}
             </p>
              <p class="text-xs text-amber-600 dark:text-amber-400 mt-1">
                {{ t('settings.reservedPathListHint') }}
              </p>
           </div>

            <div v-show="disguiseConfig.enabled"
            class="bg-white/80 dark:bg-gray-900/60 tsub-radius-lg p-4 space-y-4 border border-gray-200/70 dark:border-white/10 transition-all duration-300">
            <div>
              <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 block">{{ t('settings.disguiseStrategy') }}</label>
              <div class="flex flex-col sm:flex-row gap-4">
                <label class="flex items-center cursor-pointer group">
                  <input type="radio" value="default" v-model="disguiseConfig.pageType"
                    class="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800">
                  <div class="ml-3">
                    <span
                      class="block text-sm font-medium text-gray-900 dark:text-gray-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-400">{{ t('settings.disguiseDefault404') }}</span>
                    <span class="block text-xs text-gray-500">{{ t('settings.disguiseDefault404Desc') }}</span>
                  </div>
                </label>
                <label class="flex items-center cursor-pointer group">
                  <input type="radio" value="redirect" v-model="disguiseConfig.pageType"
                    class="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800">
                  <div class="ml-3">
                    <span
                      class="block text-sm font-medium text-gray-900 dark:text-gray-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-400">{{ t('settings.disguiseRedirect') }}</span>
                    <span class="block text-xs text-gray-500">{{ t('settings.disguiseRedirectDesc') }}</span>
                  </div>
                </label>
              </div>
            </div>

            <div v-if="disguiseConfig.pageType === 'redirect'" class="animate-fade-in-down">
              <div>
                <Input 
                  :label="t('settings.disguiseTargetUrl')"
                  v-model="disguiseConfig.redirectUrl"
                  placeholder="www.example.com"
                  type="url"
                />
              </div>
            </div>

            <div
              class="flex items-start gap-2 text-xs text-blue-600 dark:text-blue-400 bg-blue-50/80 dark:bg-blue-900/20 p-2.5 tsub-radius-md">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 flex-shrink-0 mt-0.5" viewBox="0 0 20 20"
                fill="currentColor">
                <path fill-rule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                  clip-rule="evenodd" />
              </svg>
              <span>{{ t('settings.disguiseBrowserOnlyHint') }}</span>
            </div>
      </div>
      </div>
    </div>
  </div>



  </div>
</template>

<style scoped>
/* Toggle Switch CSS */


.animate-fade-in-down {
  animation: fadeInDown 0.3s ease-out;
}

@keyframes fadeInDown {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>

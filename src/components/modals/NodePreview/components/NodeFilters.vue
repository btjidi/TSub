<script setup>
import { computed } from 'vue';
import { useI18n } from '@/i18n/index.js';

const { t } = useI18n();

const props = defineProps({
  searchQuery: {
    type: String,
    default: ''
  },
  protocolFilter: {
    type: String,
    default: 'all'
  },
  regionFilter: {
    type: String,
    default: 'all'
  },
  viewMode: {
    type: String,
    default: 'list'
  },
  showProcessed: {
    type: Boolean,
    default: false
  },
  availableProtocols: {
    type: Array,
    default: () => []
  },
  availableRegions: {
    type: Array,
    default: () => []
  },
  profileId: {
    type: String,
    default: ''
  },
  apiEndpoint: {
    type: String,
    default: ''
  }
});

const emit = defineEmits([
  'update:searchQuery',
  'update:protocolFilter',
  'update:regionFilter',
  'update:viewMode',
  'update:showProcessed'
]);

const searchModel = computed({
  get: () => props.searchQuery,
  set: (val) => emit('update:searchQuery', val)
});

const protocolModel = computed({
  get: () => props.protocolFilter,
  set: (val) => emit('update:protocolFilter', val)
});

const regionModel = computed({
  get: () => props.regionFilter,
  set: (val) => emit('update:regionFilter', val)
});

const isProcessedToggleVisible = computed(() => {
  return props.profileId && props.apiEndpoint !== '/api/public/preview';
});
</script>

<template>
  <!-- 响应式网格布局 -->
  <div class="rounded-xl border border-gray-100 bg-white/40 p-2.5 shadow-sm backdrop-blur-sm dark:border-white/5 dark:bg-gray-900/20 sm:p-3 lg:px-5 lg:py-3">
    <div class="flex flex-col gap-2.5 sm:gap-3 lg:grid lg:grid-cols-4 lg:items-end">
    <!-- 搜索 (移动端置顶) -->
    <div class="w-full">
      <label class="mb-1 block pl-1 text-[10px] font-black uppercase tracking-widest text-gray-400 dark:text-gray-500">
        {{ t('nodePreview.nodeSearch') }}
      </label>
      <div class="flex gap-2">
        <div class="relative flex-1 group">
          <input
            v-model="searchModel"
            type="text"
            :placeholder="t('nodePreview.searchPlaceholder')"
            class="w-full rounded-1.5xl border border-gray-100 bg-white/50 px-4 py-1.5 pr-10 text-sm text-gray-900 shadow-sm transition-all placeholder-gray-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 dark:border-white/5 dark:bg-gray-800/50 dark:text-white"
          />
          <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none transition-colors group-focus-within:text-indigo-500 text-gray-400">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
            </svg>
          </div>
        </div>
 
        <!-- 处理模式 toggler (仅移动端、订阅组且非公开页显示) -->
        <button
          v-if="isProcessedToggleVisible"
          @click="emit('update:showProcessed', !showProcessed)"
          :class="showProcessed ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'bg-gray-100 dark:bg-gray-700/50 text-gray-400 border-transparent'"
          class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-1.5xl transition-all hover:scale-105 active:scale-95 lg:hidden"
        >
          <svg v-if="!showProcessed" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path>
          </svg>
          <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
          </svg>
        </button>
      </div>
    </div>

    <!-- 筛选器组 (移动端并排) -->
    <div class="grid grid-cols-2 gap-2.5 sm:gap-3 lg:contents">
      <!-- 协议筛选 -->
      <div>
        <label class="mb-1 block pl-1 text-[10px] font-black uppercase tracking-widest text-gray-400 dark:text-gray-500">
          {{ t('nodePreview.type') }}
        </label>
        <select
          v-model="protocolModel"
          class="w-full appearance-none rounded-1.5xl border border-gray-100 bg-white/50 px-4 py-1.5 text-sm text-gray-900 shadow-sm transition-all focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 dark:border-white/5 dark:bg-gray-800/50 dark:text-white"
        >
          <option value="all">{{ t('nodePreview.allProtocols') }}</option>
          <option v-for="protocol in availableProtocols" :key="protocol" :value="protocol">
            {{ protocol.toUpperCase() }}
          </option>
        </select>
      </div>
 
      <!-- 地区筛选 -->
      <div>
        <label class="mb-1 block pl-1 text-[10px] font-black uppercase tracking-widest text-gray-400 dark:text-gray-500">
          {{ t('nodePreview.region') }}
        </label>
        <select
          v-model="regionModel"
          class="w-full appearance-none rounded-1.5xl border border-gray-100 bg-white/50 px-4 py-1.5 text-sm text-gray-900 shadow-sm transition-all focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 dark:border-white/5 dark:bg-gray-800/50 dark:text-white"
        >
          <option value="all">{{ t('nodePreview.allRegions') }}</option>
          <option v-for="region in availableRegions" :key="region" :value="region">
            {{ region }}
          </option>
        </select>
      </div>
    </div>

    <!-- 视图切换 & 规则处理 (Desktop Combined) -->
    <div class="hidden lg:flex gap-8">
      <!-- 视图切换 -->
      <div>
        <label class="block text-[10px] uppercase font-black text-gray-400 dark:text-gray-500 mb-2 tracking-widest pl-1">
          {{ t('nodePreview.layout') }}
        </label>
        <div class="flex items-center gap-2">
          <button
            @click="emit('update:viewMode', 'list')"
            :class="viewMode === 'list' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'bg-gray-100 text-gray-500 dark:bg-gray-700/50 dark:text-gray-400'"
            class="flex h-11 w-11 items-center justify-center rounded-1.5xl text-sm font-medium transition-all hover:scale-105 active:scale-95"
            :title="t('nodePreview.listView')"
            :aria-label="t('nodePreview.listView')"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 6h16M4 10h16M4 14h16"></path>
            </svg>
          </button>
          <button
            @click="emit('update:viewMode', 'card')"
            :class="viewMode === 'card' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'bg-gray-100 text-gray-500 dark:bg-gray-700/50 dark:text-gray-400'"
            class="flex h-11 w-11 items-center justify-center rounded-1.5xl text-sm font-medium transition-all hover:scale-105 active:scale-95"
            :title="t('nodePreview.cardView')"
            :aria-label="t('nodePreview.cardView')"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"></path>
            </svg>
          </button>
        </div>
      </div>

      <!-- 规则处理 -->
      <div v-if="isProcessedToggleVisible">
        <label class="block text-[10px] uppercase font-black text-gray-400 dark:text-gray-500 mb-2 tracking-widest pl-1">
          {{ t('nodePreview.optimization') }}
        </label>
        <div class="flex items-center gap-2">
          <button
            @click="emit('update:showProcessed', !showProcessed)"
            :class="showProcessed ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'bg-gray-100 text-gray-500 dark:bg-gray-700/50 dark:text-gray-400'"
            class="flex h-11 w-11 items-center justify-center rounded-1.5xl text-sm font-medium transition-all hover:scale-105 active:scale-95"
            :title="t('nodePreview.toggleProcessed')"
            :aria-label="t('nodePreview.toggleProcessed')"
          >
            <!-- 魔法棒 Icon (处理后) -->
            <svg v-if="showProcessed" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
            </svg>
            <!-- 原材料 Icon (原始) -->
            <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup>
// SettingsLayout.vue
// 统一的设置界面布局容器，供页面视图和悬浮模态框复用
</script>

<template>
  <div class="relative flex h-full w-full flex-col gap-4">
    
    <!-- Top settings navigation -->
    <aside data-testid="settings-tabs-panel" class="shrink-0 rounded-xl border border-gray-100/80 bg-white/85 p-1.5 shadow-sm dark:border-white/10 dark:bg-gray-900/70">
      <slot name="sidebar"></slot>
    </aside>

    <!-- Main Content Area -->
    <main class="relative flex min-h-[520px] min-w-0 flex-1 flex-col">
      
      <!-- Scrollable Content -->
      <div class="flex-1 overflow-y-auto">
        <slot></slot>
      </div>

      <!-- Sticky Footer Area -->
      <div data-bottom-action-anchor aria-hidden="true" class="h-0 shrink-0"></div>
      <div data-testid="settings-save-panel" class="bottom-action-panel sticky bottom-20 z-40 mt-4 flex w-full shrink-0 justify-end rounded-xl border border-gray-100/80 bg-white/85 px-4 py-3 shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-gray-900/80 md:px-5 lg:bottom-4">
        <slot name="footer"></slot>
      </div>

    </main>
  </div>
</template>

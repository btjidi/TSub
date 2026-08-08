<script setup>
import { ref } from 'vue';

defineProps({
  testId: { type: String, default: '' }
});

const open = ref(false);

function handlePointerDown(event) {
  if (event.target?.disabled) return;
  open.value = true;
}

function handleKeydown(event) {
  if (event.target?.disabled) return;
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) open.value = true;
  if (event.key === 'Escape' || event.key === 'Tab') open.value = false;
}

function close() {
  open.value = false;
}
</script>

<template>
  <div
    class="deployment-select-shell relative mt-1 min-w-0"
    :data-testid="testId || undefined"
    @pointerdown="handlePointerDown"
    @keydown="handleKeydown"
    @change="close"
    @focusout="close"
  >
    <slot />
    <svg
      data-testid="deployment-select-chevron"
      aria-hidden="true"
      class="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500 transition-transform duration-150 dark:text-gray-400"
      :class="open ? 'rotate-180' : ''"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="2"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  </div>
</template>

<style scoped>
.deployment-select-shell :deep(select) {
  width: 100%;
  min-width: 0;
  margin-top: 0;
  padding-right: 2rem !important;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background-image: none !important;
  appearance: none;
  -webkit-appearance: none;
}

.deployment-select-shell:has(select:disabled) svg {
  opacity: 0.45;
}
</style>

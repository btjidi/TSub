<script setup>
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  label: { type: String, required: true },
  testId: { type: String, default: '' }
});
const emit = defineEmits(['update:open']);
const root = ref(null);
const button = ref(null);
const tooltip = ref(null);
const pinned = ref(false);
const restoringFocus = ref(false);
const tooltipLeft = ref(0);
const tooltipTop = ref(0);
const arrowLeft = ref(10);
const placement = ref('top');
const tooltipId = `deployment-info-${useId()}`;
let previewCloseTimer;
let positionFrame;
function setOpen(value) { emit('update:open', value); }
function clearPreviewClose() {
  if (previewCloseTimer) window.clearTimeout(previewCloseTimer);
  previewCloseTimer = undefined;
}
function showPreview() {
  clearPreviewClose();
  if (!restoringFocus.value) setOpen(true);
}
function hidePreview() {
  clearPreviewClose();
  if (!pinned.value) previewCloseTimer = window.setTimeout(() => setOpen(false), 80);
}
function toggle() {
  if (props.open && pinned.value) {
    pinned.value = false;
    setOpen(false);
    return;
  }
  pinned.value = true;
  setOpen(true);
}
function close(restoreFocus = false) {
  clearPreviewClose();
  pinned.value = false;
  setOpen(false);
  if (restoreFocus) {
    restoringFocus.value = true;
    button.value?.focus({ preventScroll: true });
    queueMicrotask(() => { restoringFocus.value = false; });
  }
}
function handleOutside(event) {
  if (!root.value?.contains(event.target) && !tooltip.value?.contains(event.target)) close();
}
function handleKeydown(event) { if (event.key === 'Escape') close(true); }
function positionTooltip() {
  if (!button.value || !tooltip.value || typeof window === 'undefined') return;
  const buttonRect = button.value.getBoundingClientRect();
  const tooltipRect = tooltip.value.getBoundingClientRect();
  const tooltipWidth = tooltipRect.width;
  const tooltipHeight = tooltipRect.height;
  const viewportMargin = 16;
  const tooltipGap = 8;
  const desiredLeft = buttonRect.left + (buttonRect.width / 2) - (tooltipWidth / 2);
  const maxLeft = Math.max(viewportMargin, window.innerWidth - viewportMargin - tooltipWidth);
  const viewportLeft = Math.min(Math.max(desiredLeft, viewportMargin), maxLeft);
  const availableAbove = buttonRect.top - viewportMargin - tooltipGap;
  const availableBelow = window.innerHeight - buttonRect.bottom - viewportMargin - tooltipGap;
  const placeAbove = availableAbove >= tooltipHeight || availableAbove >= availableBelow;
  placement.value = placeAbove ? 'top' : 'bottom';
  tooltipLeft.value = viewportLeft;
  tooltipTop.value = placeAbove
    ? Math.max(viewportMargin, buttonRect.top - tooltipGap - tooltipHeight)
    : Math.min(window.innerHeight - viewportMargin - tooltipHeight, buttonRect.bottom + tooltipGap);
  arrowLeft.value = Math.min(Math.max(buttonRect.left + (buttonRect.width / 2) - viewportLeft, 10), tooltipWidth - 10);
}
function schedulePosition() {
  if (typeof window === 'undefined') return;
  if (positionFrame) window.cancelAnimationFrame(positionFrame);
  positionFrame = window.requestAnimationFrame(positionTooltip);
}
function removeListeners() {
  if (typeof document === 'undefined') return;
  document.removeEventListener('pointerdown', handleOutside);
  document.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('resize', schedulePosition);
  window.removeEventListener('scroll', schedulePosition, true);
  if (positionFrame) window.cancelAnimationFrame(positionFrame);
  positionFrame = undefined;
}
watch(() => props.open, open => {
  removeListeners();
  if (!open) pinned.value = false;
  else if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleKeydown);
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('scroll', schedulePosition, true);
    nextTick(schedulePosition);
  }
});
onBeforeUnmount(() => {
  clearPreviewClose();
  removeListeners();
});
</script>

<template>
  <span ref="root" class="relative ml-1 inline-flex shrink-0" @mouseenter="showPreview" @mouseleave="hidePreview">
    <button
      ref="button"
      type="button"
      :data-testid="testId || undefined"
      class="relative flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-colors duration-150 hover:bg-primary-50 hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 active:bg-primary-100 dark:hover:bg-white/10 dark:hover:text-primary-400"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="tooltipId"
      :aria-describedby="open ? tooltipId : undefined"
      @focus="showPreview"
      @blur="hidePreview"
      @click.stop="toggle"
    >
      <slot name="icon">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path stroke-linecap="round" d="M12 11v5" />
          <path stroke-linecap="round" d="M12 8h.01" />
        </svg>
      </slot>
    </button>
    <Teleport to="body">
      <span
        v-show="open"
        ref="tooltip"
        :id="tooltipId"
        role="tooltip"
        class="fixed z-[120] block w-[min(21rem,calc(100vw-2rem))] text-left text-xs leading-5 text-white"
        :style="{ left: `${tooltipLeft}px`, top: `${tooltipTop}px` }"
        @mouseenter="showPreview"
        @mouseleave="hidePreview"
      >
        <span class="block max-h-[60vh] overflow-y-auto rounded-lg bg-gray-950 px-3 py-2.5 shadow-xl dark:border dark:border-white/10 dark:bg-gray-700">
          <strong class="mb-1 block font-semibold text-white">{{ label }}</strong>
          <slot />
        </span>
        <span
          class="absolute h-0 w-0 -translate-x-1/2 border-x-4 border-x-transparent"
          :class="placement === 'top' ? 'top-full border-t-4 border-t-gray-950 dark:border-t-gray-700' : 'bottom-full border-b-4 border-b-gray-950 dark:border-b-gray-700'"
          :style="{ left: `${arrowLeft}px` }"
          aria-hidden="true"
        ></span>
      </span>
    </Teleport>
  </span>
</template>

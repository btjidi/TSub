<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

defineProps({
  testId: { type: String, default: '' }
});

const shellRef = ref(null);
const menuRef = ref(null);
const open = ref(false);
const options = ref([]);
const activeIndex = ref(-1);
const menuStyle = ref({});
const menuId = `deployment-select-${Math.random().toString(36).slice(2, 10)}`;

function selectElement() {
  return shellRef.value?.querySelector('select') || null;
}

function syncOptions() {
  const select = selectElement();
  options.value = select ? Array.from(select.options).map((option, index) => ({
    index,
    label: option.textContent?.trim() || '',
    disabled: option.disabled,
    selected: option.selected
  })) : [];
  activeIndex.value = Math.max(0, options.value.findIndex(option => option.selected));
}

function updatePosition() {
  const select = selectElement();
  const menu = menuRef.value;
  if (!select || !menu) return;
  const rect = select.getBoundingClientRect();
  const viewportGap = 8;
  const menuGap = 6;
  const compactNavigation = window.innerWidth < 1024;
  const viewportTop = compactNavigation ? 64 : viewportGap;
  const viewportBottom = window.innerHeight - (compactNavigation ? 80 : viewportGap);
  const width = Math.min(Math.max(rect.width, 160), window.innerWidth - viewportGap * 2);
  const measuredHeight = Math.min(menu.scrollHeight, 288);
  const spaceBelow = viewportBottom - rect.bottom;
  const spaceAbove = rect.top - viewportTop;
  const openUpward = spaceBelow < Math.min(measuredHeight, 180) && spaceAbove > spaceBelow;
  const left = Math.min(Math.max(viewportGap, rect.left), window.innerWidth - width - viewportGap);
  const top = openUpward
    ? Math.max(viewportTop, rect.top - measuredHeight - menuGap)
    : Math.min(rect.bottom + menuGap, viewportBottom - measuredHeight);
  menuStyle.value = { left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: '18rem' };
}

async function openMenu() {
  const select = selectElement();
  if (!select || select.disabled) return;
  syncOptions();
  open.value = true;
  select.setAttribute('aria-expanded', 'true');
  select.setAttribute('aria-controls', menuId);
  await nextTick();
  updatePosition();
}

function close() {
  open.value = false;
  const select = selectElement();
  select?.setAttribute('aria-expanded', 'false');
}

function handlePointerDown(event) {
  const select = event.target?.closest?.('select');
  if (!select || !shellRef.value?.contains(select) || select.disabled) return;
  event.preventDefault();
  select.focus({ preventScroll: true });
  if (open.value) close();
  else openMenu();
}

function handleClick(event) {
  if (event.target?.closest?.('select')) event.preventDefault();
}

function nextEnabledIndex(start, direction) {
  if (!options.value.length) return -1;
  let index = start;
  for (let count = 0; count < options.value.length; count += 1) {
    index = (index + direction + options.value.length) % options.value.length;
    if (!options.value[index].disabled) return index;
  }
  return -1;
}

function handleKeydown(event) {
  const select = event.target?.closest?.('select');
  if (!select || select.disabled) return;
  if (event.key === 'Escape') {
    if (open.value) event.preventDefault();
    close();
    return;
  }
  if (event.key === 'Tab') {
    close();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if (!open.value) {
    openMenu();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    activeIndex.value = nextEnabledIndex(activeIndex.value, event.key === 'ArrowDown' ? 1 : -1);
    menuRef.value?.querySelector(`[data-option-index="${activeIndex.value}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  chooseOption(activeIndex.value);
}

function chooseOption(index) {
  const select = selectElement();
  const option = options.value[index];
  if (!select || !option || option.disabled) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  select.focus({ preventScroll: true });
  close();
}

function handleDocumentPointerDown(event) {
  if (shellRef.value?.contains(event.target) || menuRef.value?.contains(event.target)) return;
  close();
}

function handleViewportChange() {
  if (open.value) updatePosition();
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('scroll', handleViewportChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', handleViewportChange, true);
});
</script>

<template>
  <div
    ref="shellRef"
    class="deployment-select-shell relative mt-1 min-w-0"
    :data-testid="testId || undefined"
    @pointerdown.capture="handlePointerDown"
    @click.capture="handleClick"
    @keydown.capture="handleKeydown"
    @change="close"
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

    <Teleport to="body">
      <Transition name="deployment-select-menu">
        <div
          v-if="open"
          :id="menuId"
          ref="menuRef"
          data-testid="deployment-select-menu"
          role="listbox"
          class="fixed z-[1000] overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-gray-900"
          :style="menuStyle"
          @pointerdown.prevent
        >
          <button
            v-for="option in options"
            :key="option.index"
            type="button"
            role="option"
            :aria-selected="option.selected"
            :disabled="option.disabled"
            :data-option-index="option.index"
            class="flex min-h-9 w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:text-gray-400 dark:disabled:text-gray-600"
            :class="[
              option.index === activeIndex ? 'bg-gray-100 dark:bg-white/10' : 'hover:bg-gray-50 dark:hover:bg-white/5',
              option.selected ? 'font-medium text-primary-700 dark:text-primary-300' : 'text-gray-700 dark:text-gray-200'
            ]"
            @pointerenter="!option.disabled && (activeIndex = option.index)"
            @click="chooseOption(option.index)"
          >
            <span class="min-w-0 truncate">{{ option.label }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
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

.deployment-select-menu-enter-active,
.deployment-select-menu-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
  transform-origin: top center;
}

.deployment-select-menu-enter-from,
.deployment-select-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>

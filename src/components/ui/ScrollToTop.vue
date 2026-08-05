<script setup>
import { computed, nextTick, ref, onMounted, onUnmounted, watch } from 'vue';
import { useI18n } from '../../i18n/index.js';
import { isRouteNavigationPending } from '../../state/routeNavigation.js';

const { t } = useI18n();

const props = defineProps({
  avoidBottomAction: {
    type: Boolean,
    default: false
  },
  refreshKey: {
    type: Number,
    default: 0
  },
  bottomActionKind: {
    type: String,
    default: '',
    validator: value => ['', 'settings', 'deployment'].includes(value)
  }
});

const emit = defineEmits(['refresh']);

const isVisible = ref(false);
const isBottomActionStuck = ref(false);
const scrollShowThreshold = 300;
const scrollHideThreshold = 200;
const scrollSettleDelay = 180;
let activeBottomPanel = null;
let scrollSettleTimer = null;

const setActiveBottomPanel = (panel, stuck) => {
  if (activeBottomPanel && activeBottomPanel !== panel) {
    activeBottomPanel.classList.remove('bottom-action-panel-stuck');
  }
  activeBottomPanel = panel;
  panel?.classList.toggle('bottom-action-panel-stuck', stuck);
};

const updateBottomActionPosition = () => {
  if (!props.avoidBottomAction || window.innerWidth >= 1024) {
    isBottomActionStuck.value = false;
    if (activeBottomPanel) setActiveBottomPanel(activeBottomPanel, false);
    return;
  }

  const panel = document.querySelector('[data-testid="settings-save-panel"], [data-testid="deployment-submit-panel"]');
  const navigation = document.querySelector('nav.mobile-nav-glass');
  if (!panel || !navigation) {
    isBottomActionStuck.value = false;
    if (activeBottomPanel) setActiveBottomPanel(activeBottomPanel, false);
    return;
  }

  const panelRect = panel.getBoundingClientRect();
  const anchor = panel.previousElementSibling?.matches('[data-bottom-action-anchor]')
    ? panel.previousElementSibling
    : null;
  const marginTop = Number.parseFloat(window.getComputedStyle(panel).marginTop) || 0;
  const naturalViewportTop = anchor
    ? anchor.getBoundingClientRect().top + marginTop
    : panelRect.top;
  isBottomActionStuck.value = panelRect.top < naturalViewportTop - 1;
  setActiveBottomPanel(panel, isBottomActionStuck.value);
};

const applySettledScrollState = () => {
  isVisible.value = isVisible.value
    ? window.scrollY > scrollHideThreshold
    : window.scrollY > scrollShowThreshold;
  updateBottomActionPosition();
};

const handleScroll = () => {
  if (scrollSettleTimer !== null) window.clearTimeout(scrollSettleTimer);
  scrollSettleTimer = window.setTimeout(() => {
    scrollSettleTimer = null;
    window.requestAnimationFrame(applySettledScrollState);
  }, scrollSettleDelay);
};

const actionPositionClass = computed(() => {
  if (isBottomActionStuck.value && props.bottomActionKind === 'deployment') return 'bottom-[9.625rem] lg:bottom-24';
  if (isBottomActionStuck.value && props.bottomActionKind === 'settings') return 'bottom-[9.375rem] lg:bottom-24';
  if (props.avoidBottomAction) return 'bottom-24';
  return 'bottom-24 lg:bottom-8';
});

const scrollToTop = () => {
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
};

const refreshPage = () => {
  emit('refresh');
};

const scheduleBottomActionPositionUpdate = async () => {
  await nextTick();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(updateBottomActionPosition);
  });
};

watch(
  [() => props.refreshKey, () => isRouteNavigationPending.value],
  ([, navigationPending]) => {
    if (!navigationPending) scheduleBottomActionPositionUpdate();
  },
  { flush: 'post' }
);

onMounted(() => {
  applySettledScrollState();
  scheduleBottomActionPositionUpdate();
  window.addEventListener('scroll', handleScroll, { passive: true });
  window.addEventListener('resize', updateBottomActionPosition, { passive: true });
});

onUnmounted(() => {
  if (scrollSettleTimer !== null) window.clearTimeout(scrollSettleTimer);
  if (activeBottomPanel) setActiveBottomPanel(activeBottomPanel, false);
  window.removeEventListener('scroll', handleScroll);
  window.removeEventListener('resize', updateBottomActionPosition);
});
</script>

<template>
  <div
    data-testid="page-action-buttons"
    :data-avoid-bottom-action="avoidBottomAction"
    :data-bottom-action-stuck="isBottomActionStuck"
    class="fixed right-4 z-50 flex flex-col items-end gap-3 md:right-8"
    :class="actionPositionClass"
  >
    <button
      type="button"
      data-testid="refresh-page"
      class="border border-gray-950/15 bg-gradient-to-r from-primary-600 to-primary-500 p-3 text-white shadow-lg shadow-primary-500/30 backdrop-blur-sm transition-all duration-300 tsub-radius-lg hover:scale-110 hover:shadow-xl hover:shadow-primary-500/40 active:scale-95 dark:border-white/15"
      :aria-label="t('actions.refresh')"
      :title="t('actions.refresh')"
      @click="refreshPage"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M20 11a8.1 8.1 0 00-15.5-2M4 4v5h5m-5 4a8.1 8.1 0 0015.5 2M20 20v-5h-5" />
      </svg>
    </button>

    <button
      v-show="isVisible"
      type="button"
      data-testid="scroll-to-top"
      class="border border-gray-950/15 bg-gradient-to-r from-primary-600 to-primary-500 p-3 text-white shadow-lg shadow-primary-500/30 backdrop-blur-sm transition-all duration-200 tsub-radius-lg hover:scale-110 hover:shadow-xl hover:shadow-primary-500/40 active:scale-95 dark:border-white/15"
      :aria-hidden="!isVisible"
      :tabindex="isVisible ? 0 : -1"
      :aria-label="t('common.scrollToTop')"
      :title="t('common.scrollToTop')"
      @click="scrollToTop"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
      </svg>
    </button>
  </div>
</template>

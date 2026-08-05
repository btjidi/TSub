import { ref } from 'vue';

export const isRouteNavigationPending = ref(false);
export const isRouteNavigationLoadingVisible = ref(false);
export const pendingRoutePath = ref('');

let navigationSequence = 0;
const loadedRoutePaths = new Set();

export function beginRouteNavigation(path) {
  navigationSequence += 1;
  pendingRoutePath.value = path;
  isRouteNavigationPending.value = true;
  isRouteNavigationLoadingVisible.value = !loadedRoutePaths.has(path);
}

export function finishRouteNavigation(path = '', failed = false) {
  if (path && pendingRoutePath.value && path !== pendingRoutePath.value) return;
  if (!failed && path) loadedRoutePaths.add(path);
  pendingRoutePath.value = '';
  isRouteNavigationPending.value = false;
  isRouteNavigationLoadingVisible.value = false;
}

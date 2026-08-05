import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import SettingsSidebar from '../../src/components/settings/SettingsSidebar.vue';
import { createI18n } from '../../src/i18n/index.js';
import { messages } from '../../src/i18n/messages.js';

describe('navigation and settings layout', () => {
  it('uses subscription and node management names in both locales', () => {
    expect(messages['zh-CN'].nav.groups).toBe('订阅管理');
    expect(messages['zh-CN'].nav.nodes).toBe('节点管理');
    expect(messages['en-US'].nav.groups).toBe('Subscription Management');
    expect(messages['en-US'].nav.nodes).toBe('Node Management');
  });
  it('renders all settings sections in a wrapping top grid', () => {
    const wrapper = mount(SettingsSidebar, {
      props: { activeTab: 'basic' },
      global: { plugins: [createI18n({ initialLocale: 'zh-CN' })] }
    });
    expect(wrapper.findAll('button')).toHaveLength(8);
    expect(wrapper.find('nav').classes()).toEqual(expect.arrayContaining(['grid-cols-3', 'sm:grid-cols-4', 'lg:grid-cols-8']));
    expect(wrapper.text()).toContain('基础设置');
    expect(wrapper.text()).toContain('公开页设置');
    expect(wrapper.text()).toContain('数据/备份');
    expect(wrapper.text()).toContain('系统设置');
    const activeIndicator = wrapper.find('button span');
    expect(activeIndicator.classes()).toEqual(expect.arrayContaining(['left-0', 'bg-blue-500']));
    expect(activeIndicator.classes()).not.toContain('bottom-0');
  });

  it('keeps the brand and primary navigation in the desktop left group', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/components/layout/NavBar.vue'), 'utf8');
    const brand = readFileSync(path.join(process.cwd(), 'src/components/layout/BrandLogo.vue'), 'utf8');
    expect(source).toContain('hidden lg:block');
    expect(source).toContain('lg:hidden mobile-nav-glass');
    expect(brand).toContain('>T-Sub</span>');
    const desktop = source.slice(source.indexOf('hidden lg:block'));
    expect(desktop.indexOf('<BrandLogo')).toBeLessThan(desktop.indexOf('<nav :aria-label="t(\'nav.main\')"'));
    expect(desktop.indexOf('<nav :aria-label="t(\'nav.main\')"')).toBeLessThan(desktop.indexOf('<NavActionGroup'));
  });

  it('uses one routed layout without a layout switch action', () => {
    const appSource = readFileSync(path.join(process.cwd(), 'src/App.vue'), 'utf8');
    const actionsSource = readFileSync(path.join(process.cwd(), 'src/components/layout/NavActionGroup.vue'), 'utf8');
    const uiStoreSource = readFileSync(path.join(process.cwd(), 'src/stores/ui.js'), 'utf8');

    expect(appSource).not.toContain('layoutMode');
    expect(appSource).not.toContain('<Dashboard v-else');
    expect(actionsSource).not.toContain('toggleLayout');
    expect(uiStoreSource).not.toContain('toggleLayout');
    expect(uiStoreSource).not.toContain("localStorage.getItem('layoutMode')");
  });

  it('places the settings navigation above the content instead of in a desktop sidebar', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/components/layout/SettingsLayout.vue'), 'utf8');
    const viewSource = readFileSync(path.join(process.cwd(), 'src/views/SettingsView.vue'), 'utf8');
    expect(source).not.toContain('md:flex-row');
    expect(source.indexOf('<aside')).toBeLessThan(source.indexOf('<main'));
    expect(source).toContain('data-testid="settings-tabs-panel"');
    expect(source).toContain('data-testid="settings-save-panel"');
    expect(source).toContain('data-bottom-action-anchor');
    expect(source).toContain('bottom-action-panel sticky');
    expect(source).toContain('flex w-full');
    expect(source).not.toContain('md:rounded-b-2xl');
    expect(viewSource).not.toContain('onActivated');
  });

  it('keeps scroll-to-top above mobile navigation and the settings save panel', () => {
    const appSource = readFileSync(path.join(process.cwd(), 'src/App.vue'), 'utf8');
    const scrollSource = readFileSync(path.join(process.cwd(), 'src/components/ui/ScrollToTop.vue'), 'utf8');
    expect(appSource).toContain(':avoid-bottom-action="avoidScrollTopBottomAction"');
    expect(appSource).toContain(':bottom-action-kind="scrollTopBottomActionKind"');
    expect(appSource).toContain("'/dashboard/deployments'");
    expect(appSource).toContain("isLoggedIn ? 'pb-56 lg:pb-6' : 'pb-40 lg:pb-6'");
    expect(appSource).toContain('<KeepAlive include="SettingsView" :max="2">');
    expect(scrollSource).toContain('panelRect.top < naturalViewportTop - 1');
    expect(scrollSource).toContain("classList.toggle('bottom-action-panel-stuck', stuck)");
    expect(scrollSource).toContain('const scrollShowThreshold = 300');
    expect(scrollSource).toContain('const scrollHideThreshold = 200');
    expect(scrollSource).toContain('const scrollSettleDelay = 180');
    expect(scrollSource).toContain('window.clearTimeout(scrollSettleTimer)');
    expect(scrollSource).not.toContain('window.innerHeight - positionedPanelRect.top');
    expect(scrollSource).not.toContain(':style="actionPositionStyle"');
    expect(scrollSource).toContain("return 'bottom-[9.625rem] lg:bottom-24'");
    expect(scrollSource).toContain("return 'bottom-[9.375rem] lg:bottom-24'");
    expect(scrollSource).toContain("if (props.avoidBottomAction) return 'bottom-24'");
    expect(scrollSource).toContain("return 'bottom-24 lg:bottom-8'");
    expect(scrollSource).toContain('data-testid="refresh-page"');
    expect(scrollSource).toContain('v-show="isVisible"');
    expect(scrollSource).toContain(':aria-hidden="!isVisible"');
    expect(scrollSource).toContain(':tabindex="isVisible ? 0 : -1"');
    expect(scrollSource).not.toContain('v-if="isVisible"');
    expect(scrollSource).toContain("t('actions.refresh')");
    expect(scrollSource).toContain("emit('refresh')");
    expect(scrollSource).toContain('isRouteNavigationPending.value');
    expect(scrollSource).toContain('scheduleBottomActionPositionUpdate');
    expect(scrollSource).toContain('window.requestAnimationFrame(updateBottomActionPosition)');
    expect(scrollSource).not.toContain('window.location.reload()');
    expect(appSource).toContain('@refresh="refreshCurrentRoute"');
    expect(appSource).toContain('isLoggedIn.value ? dataStore.fetchData(true)');
    expect(appSource).toContain('window.setTimeout(resolve, 300)');
    expect(appSource).toContain(':key="`${route.fullPath}:${routeRefreshKey}`"');
    expect(scrollSource).not.toContain('md:bottom-8');
  });

  it('keeps a labelled loading state until the async dashboard route resolves', () => {
    const appSource = readFileSync(path.join(process.cwd(), 'src/App.vue'), 'utf8');
    const loadingSource = readFileSync(path.join(process.cwd(), 'src/components/ui/AppLoading.vue'), 'utf8');
    const htmlSource = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    const routerSource = readFileSync(path.join(process.cwd(), 'src/router/index.js'), 'utf8');
    const navigationSource = readFileSync(path.join(process.cwd(), 'src/state/routeNavigation.js'), 'utf8');
    const navBarSource = readFileSync(path.join(process.cwd(), 'src/components/layout/NavBar.vue'), 'utf8');
    const mainSource = readFileSync(path.join(process.cwd(), 'src/main.js'), 'utf8');

    expect(appSource).toContain('<Suspense timeout="0" @pending="handleRoutePending" @resolve="handleRouteResolved">');
    expect(appSource).toContain("isSessionLoading.value && route.path.startsWith('/dashboard')");
    expect(appSource).toContain('<template #fallback>');
    expect(appSource).toContain('<AppLoading v-if="showRouteLoading" />');
    expect(appSource).toContain('isRouteComponentPending.value');
    expect(appSource).toContain(':class="{ hidden: showRouteLoading }"');
    expect(appSource).toContain("document.getElementById('tsub-boot-loader')");
    expect(loadingSource).toContain("t('common.loading')");
    expect(loadingSource).toContain('role="status"');
    expect(htmlSource).toContain('id="tsub-boot-loader" class="tsub-boot-loading"');
    expect(htmlSource).toContain('<span>加载中...</span>');
    expect(htmlSource).toContain('@keyframes tsub-boot-spin');
    expect(htmlSource).toContain('.tsub-boot-loading-leave');
    expect(htmlSource).toContain('body:has(#app .app-nav-bar) .tsub-boot-loading');
    expect(htmlSource).toContain('bottom: calc(4rem + max(env(safe-area-inset-bottom, 0px), 12px))');
    expect(htmlSource).not.toContain('family=Inter');
    expect(mainSource).toContain('family=Inter');
    expect(mainSource).toContain("window.requestIdleCallback(loadWebFonts, { timeout: 1500 })");
    expect(routerSource).toContain('beginRouteNavigation(to.path)');
    expect(routerSource).toContain('finishRouteNavigation(to.path, Boolean(failure))');
    expect(navigationSource).toContain('const loadedRoutePaths = new Set()');
    expect(navigationSource).toContain('isRouteNavigationLoadingVisible.value = !loadedRoutePaths.has(path)');
    expect(navigationSource).not.toContain('minimumLoadingDuration');
    expect(navBarSource).toContain('isRouteNavigationPending.value && pendingRoutePath.value');
  });
});

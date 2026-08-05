import { expect, test } from '@playwright/test';

const sources = [
  { id: 'source-1', name: 'Ordinary Source', url: 'https://example.com/sub', enabled: true, nodeCount: 1, userInfo: {} },
  {
    id: 'source-2', name: '独角鲸日本软银', url: 'https://controller.example/sub', localUrl: 'http://vps.example:51250/sub',
    enabled: true, nodeCount: 1, userInfo: {}, source: { kind: 'tsub-deployment-push', deploymentId: 'deployment-1' },
    lastPushAt: '2026-01-01T00:00:00.000Z', pushIntervalMinutes: 15
  }
];

const previewNodes = Array.from({ length: 24 }, (_, index) => ({
  id: `preview-${index + 1}`,
  name: `Preview Node ${index + 1}`,
  url: `vless://demo-${index + 1}@127.0.0.1:${51000 + index}#Preview-${index + 1}`,
  protocol: index % 2 ? 'tuic' : 'hysteria2',
  server: '127.0.0.1',
  port: 51000 + index,
  region: '日本'
}));

async function mockController(page, onRequest = () => {}) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    onRequest(path);
    let body = { success: true, data: [] };
    if (path === '/api/data') body = { tsubs: sources, profiles: [], ruleTemplates: [], config: {} };
    else if (path === '/api/public_config') body = { enablePublicPage: true, customLoginPath: 'login', customPage: { enabled: false } };
    else if (path === '/api/settings') body = {};
    else if (path === '/api/settings/credentials') body = { success: true, data: { username: 'admin', usernameSource: 'env', passwordSource: 'env', canPersist: true, authVersion: 1 } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function openClientRoute(page, path) {
  await page.goto('/');
  await page.evaluate(target => {
    history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('dashboard refresh loader stays between tablet navigation bars', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/settings');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await page.evaluate(() => {
    const loader = document.createElement('div');
    loader.id = 'tsub-boot-loader-test';
    loader.className = 'tsub-boot-loading';
    loader.innerHTML = '<div class="tsub-boot-spinner"></div><span>加载中...</span>';
    document.body.appendChild(loader);
  });

  const loader = page.locator('#tsub-boot-loader-test');
  const topNavigation = page.locator('header[aria-label="顶部导航栏"]');
  const bottomNavigation = page.locator('nav[aria-label="底部主导航"]');
  await expect(loader).toBeVisible();
  await expect(topNavigation).toBeVisible();
  await expect(bottomNavigation).toBeVisible();
  const [loaderBox, topBox, bottomBox] = await Promise.all([loader, topNavigation, bottomNavigation].map(locator => locator.boundingBox()));
  expect(loaderBox.y).toBeGreaterThanOrEqual(topBox.y + topBox.height - 1);
  expect(loaderBox.y + loaderBox.height).toBeLessThanOrEqual(bottomBox.y + 1);
});

test('tablet navigation gives immediate feedback while a lazy page chunk loads', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  let settingsRequests = 0;
  await mockController(page, path => {
    if (path === '/api/settings') settingsRequests += 1;
  });
  let releaseChunk;
  const chunkGate = new Promise(resolve => { releaseChunk = resolve; });
  await page.route(/\/assets\/js\/SubscriptionGroupsView-[^/]+\.js$/, async route => {
    await chunkGate;
    await route.continue();
  });
  await openClientRoute(page, '/dashboard/settings');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await expect(page.getByText('正在加载设置...', { exact: true })).toHaveCount(0);
  expect(settingsRequests).toBe(1);

  const groupsLink = page.locator('nav[aria-label="底部主导航"] a[href="/dashboard/groups"]');
  await groupsLink.dispatchEvent('click');
  await expect(groupsLink).toHaveClass(/nav-mobile-item-active/);
  const routeLoading = page.getByRole('status').filter({ hasText: '加载中...' });
  await expect(routeLoading).toBeVisible();
  await expect(routeLoading).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '设置' })).not.toBeVisible();

  releaseChunk();
  await expect(page.getByRole('heading', { name: '订阅管理' })).toBeVisible();
  await expect(routeLoading).toHaveCount(0);

  const settingsLink = page.locator('nav[aria-label="底部主导航"] a[href="/dashboard/settings"]');
  await settingsLink.dispatchEvent('click');
  await expect(settingsLink).toHaveClass(/nav-mobile-item-active/);
  await expect(routeLoading).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await expect(page.getByText('正在加载设置...', { exact: true })).toHaveCount(0);
  expect(settingsRequests).toBe(1);
});

test('deployment floating actions recalculate immediately after menu navigation', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/settings');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect(page.getByTestId('scroll-to-top')).toBeVisible();

  const deploymentsLink = page.locator('nav[aria-label="底部主导航"] a[href="/dashboard/deployments"]');
  await deploymentsLink.dispatchEvent('click');
  await expect(page.getByRole('heading', { name: '代理部署' })).toBeVisible();

  const actionButtons = page.getByTestId('page-action-buttons');
  const submitPanel = page.getByTestId('deployment-submit-panel');
  await expect(submitPanel).toHaveClass(/bottom-action-panel-stuck/);
  await expect.poll(async () => {
    const [actionBox, submitBox] = await Promise.all([actionButtons, submitPanel].map(locator => locator.boundingBox()));
    return Math.round(submitBox.y - (actionBox.y + actionBox.height));
  }).toBe(12);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'compact-desktop', width: 1024, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
]) {
  test(`${viewport.name}: navigation and settings tabs do not overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
    await mockController(page);
    await openClientRoute(page, '/dashboard/settings');
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.getByText('管理站点、订阅、服务集成和系统行为。')).toBeVisible();
    await expect(page.getByTestId('settings-page-header')).toHaveCSS('border-radius', '12px');
    await expect(page.getByTestId('settings-tabs-panel')).toHaveCSS('border-radius', '12px');
    await expect(page.getByTestId('settings-save-panel')).toHaveCSS('border-radius', '12px');

    const settingsTabs = page.locator('aside nav button');
    await expect(settingsTabs).toHaveCount(8);
    const rows = await settingsTabs.evaluateAll(buttons => [...new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top)))]);
    expect(rows.length).toBeLessThanOrEqual(viewport.width < 640 ? 3 : 2);

    if (viewport.width >= 1024) {
      const desktopHeader = page.locator('header[aria-label="主导航"]');
      await expect(desktopHeader).toBeVisible();
      const brand = await desktopHeader.locator('.nav-brand-wrap').boundingBox();
      const firstTab = await desktopHeader.locator('nav a').first().boundingBox();
      expect(brand.x).toBeLessThan(firstTab.x);
      expect(firstTab.x - (brand.x + brand.width)).toBeLessThan(40);
    } else {
      await expect(page.locator('nav[aria-label="底部主导航"]')).toBeVisible();
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test('subscription cards copy every displayed source URL', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'en-US'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/groups');

  await expect(page.getByRole('heading', { name: 'Subscription Management' })).toBeVisible();
  await expect(page.getByTestId('subscription-file-import')).toBeVisible();

  await page.getByTestId('copy-subscription-url').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/sub');
  await page.getByTestId('copy-push-mirror-url').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://controller.example/sub');
  await page.getByTestId('copy-push-local-url').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('http://vps.example:51250/sub');
});

test('node preview keeps a stable frame and stays above tablet floating UI', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await page.route('**/api/subscription_nodes', async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        nodes: previewNodes,
        stats: { protocols: { hysteria2: 12, tuic: 12 }, regions: { 日本: 24 } }
      })
    });
  });
  await openClientRoute(page, '/dashboard/groups');

  await page.getByRole('button', { name: '预览节点' }).first().click();
  const panel = page.getByTestId('modal-panel');
  const loadingBox = await panel.boundingBox();
  await expect(page.getByText('Preview Node 24', { exact: true })).toBeAttached();
  const loadedBox = await panel.boundingBox();
  expect(Math.abs(loadedBox.width - loadingBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(loadedBox.height - loadingBox.height)).toBeLessThanOrEqual(1);

  const nodeScroll = page.getByTestId('node-list-scroll');
  await nodeScroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const lastRow = page.getByTestId('node-list-row').filter({ hasText: 'Preview Node 24' });
  await expect(lastRow).toBeVisible();
  const [scrollBox, lastRowBox] = await Promise.all([nodeScroll, lastRow].map(locator => locator.boundingBox()));
  expect(lastRowBox.y).toBeGreaterThanOrEqual(scrollBox.y - 1);
  expect(lastRowBox.y + lastRowBox.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height + 1);

  await page.getByRole('button', { name: '关闭' }).click();
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addStyleTag({ content: 'body::after { content: ""; display: block; height: 1000px; }' });
  await page.getByRole('button', { name: '预览节点' }).first().click();
  await expect(page.getByTestId('modal-backdrop')).toHaveCSS('z-index', '90');
  await page.evaluate(() => window.scrollTo(0, 500));
  const scrollTop = page.getByTestId('scroll-to-top');
  await expect(scrollTop).toBeVisible();
  const [modalLayer, navigationLayer, scrollTopLayer] = await Promise.all([
    page.getByTestId('modal-backdrop'),
    page.locator('nav[aria-label="底部主导航"]'),
    page.getByTestId('page-action-buttons')
  ].map(locator => locator.evaluate(element => Number(getComputedStyle(element).zIndex))));
  const layerValues = { modal: modalLayer, navigation: navigationLayer, scrollTop: scrollTopLayer };
  expect(layerValues.modal).toBeGreaterThan(layerValues.navigation);
  expect(layerValues.modal).toBeGreaterThan(layerValues.scrollTop);
});

test('settings data and security sections stay separated', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/settings');

  await page.getByRole('button', { name: '数据/备份' }).click();
  await expect(page.getByText('数据存储类型', { exact: true })).toBeVisible();
  await expect(page.getByText('备份与恢复', { exact: true })).toBeVisible();
  await expect(page.getByText('外部管理 API', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '系统设置' }).click();
  await expect(page.getByText('外部管理 API', { exact: true })).toBeVisible();
  await expect(page.getByText('管理员安全设置', { exact: true })).toBeVisible();
  await expect(page.getByText('危险区域 (Danger Zone)', { exact: true })).toBeVisible();
  await expect(page.getByText('数据存储类型', { exact: true })).toHaveCount(0);
});

test('mobile push status and actions do not squeeze the subscription title', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/groups');

  const card = page.getByText('独角鲸日本软银', { exact: true }).locator('xpath=ancestor::div[@data-testid="subscription-card-header"]/..');
  const header = card.getByTestId('subscription-card-header');
  const badges = card.getByTestId('subscription-card-badges');
  const activePush = card.getByTestId('push-source-badge');
  const stale = card.getByTestId('push-stale-badge');
  const title = card.getByRole('heading', { name: '独角鲸日本软银' });
  const actions = card.getByTestId('subscription-card-actions');
  const schedule = card.getByTestId('push-schedule');

  await expect(activePush).toHaveText('主动推送');
  await expect(stale).toHaveText('上报超时');
  await expect(actions.locator('button')).toHaveCount(5);

  const layout = await Promise.all([header, badges, activePush, stale, title, actions, schedule].map(locator => locator.boundingBox()));
  const [headerBox, badgesBox, activePushBox, staleBox, titleBox, actionsBox, scheduleBox] = layout;
  expect(activePushBox.height).toBeLessThanOrEqual(24);
  expect(staleBox.height).toBeLessThanOrEqual(24);
  expect(activePushBox.y).toBe(staleBox.y);
  expect(badgesBox.width).toBeGreaterThan(activePushBox.width + staleBox.width);
  expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(badgesBox.y);
  expect(actionsBox.y).toBeGreaterThanOrEqual(badgesBox.y + badgesBox.height);
  expect(actionsBox.y - (badgesBox.y + badgesBox.height)).toBeLessThanOrEqual(4);
  expect(scheduleBox.y - (actionsBox.y + actionsBox.height)).toBeLessThanOrEqual(4);
  expect(actionsBox.x).toBeGreaterThanOrEqual(headerBox.x);
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test('desktop subscription header keeps its horizontal layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockController(page);
  await openClientRoute(page, '/dashboard/groups');

  const header = page.getByText('独角鲸日本软银', { exact: true }).locator('xpath=ancestor::div[@data-testid="subscription-card-header"]');
  await expect(header).toHaveCSS('flex-direction', 'row');
});

test('tablet subscription header keeps the stacked mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/groups');

  const card = page.getByText('独角鲸日本软银', { exact: true }).locator('xpath=ancestor::div[@data-testid="subscription-card-header"]/..');
  const header = card.getByTestId('subscription-card-header');
  const title = card.getByRole('heading', { name: '独角鲸日本软银' });
  const badges = card.getByTestId('subscription-card-badges');
  const actions = card.getByTestId('subscription-card-actions');
  await expect(header).toHaveCSS('flex-direction', 'column');

  const [titleBox, badgesBox, actionsBox] = await Promise.all([title, badges, actions].map(locator => locator.boundingBox()));
  expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(badgesBox.y);
  expect(actionsBox.y).toBeGreaterThanOrEqual(badgesBox.y + badgesBox.height);
  await expect(actions).toHaveCSS('opacity', '1');
  await expect(actions.locator('button')).toHaveCount(5);
  await expect(title).toHaveText('独角鲸日本软银');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test('tablet settings actions stay above the bottom navigation without overlapping', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/settings');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await expect(page.getByTestId('refresh-page')).toBeVisible();
  await expect(page.getByTestId('scroll-to-top')).not.toBeVisible();
  const initialRefreshBox = await page.getByTestId('refresh-page').boundingBox();
  await page.evaluate(() => { window.__tsubInternalRefreshMarker = 'kept'; });
  await page.getByTestId('refresh-page').click();
  const routeLoading = page.getByRole('status').filter({ hasText: '加载中...' });
  await expect(routeLoading).toBeVisible();
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  expect(await page.evaluate(() => window.__tsubInternalRefreshMarker)).toBe('kept');
  await page.evaluate(() => window.scrollTo(0, 500));

  const refreshPage = page.getByTestId('refresh-page');
  const scrollTop = page.getByTestId('scroll-to-top');
  const actionButtons = page.getByTestId('page-action-buttons');
  const savePanel = page.getByTestId('settings-save-panel');
  const bottomNav = page.locator('nav[aria-label="底部主导航"]');
  await expect(refreshPage).toBeVisible();
  await expect(scrollTop).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(savePanel).toHaveClass(/bottom-action-panel-stuck/);
  await expect(actionButtons).toHaveCSS('bottom', '150px');
  await expect.poll(async () => {
    const [refreshBox, scrollBox, saveBox] = await Promise.all([refreshPage, scrollTop, savePanel].map(locator => locator.boundingBox()));
    return {
      buttonGap: Math.round(scrollBox.y - (refreshBox.y + refreshBox.height)),
      panelGap: Math.round(saveBox.y - (scrollBox.y + scrollBox.height))
    };
  }).toEqual({ buttonGap: 12, panelGap: 12 });
  const [refreshBox, scrollBox, saveBox, navBox] = await Promise.all([refreshPage, scrollTop, savePanel, bottomNav].map(locator => locator.boundingBox()));
  expect(initialRefreshBox.y - refreshBox.y).toBeGreaterThan(50);
  expect(scrollBox.y - (refreshBox.y + refreshBox.height)).toBeCloseTo(12, 0);
  expect(saveBox.y - (scrollBox.y + scrollBox.height)).toBeCloseTo(12, 0);
  expect(saveBox.width).toBeLessThan(240);
  expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(navBox.y + 1);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(savePanel).not.toHaveClass(/bottom-action-panel-stuck/);
  await expect(actionButtons).toHaveCSS('bottom', '96px');
  expect((await savePanel.boundingBox()).width).toBeGreaterThan(500);
});

test('mobile page actions stay fixed during rapid scroll direction changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/deployments');
  await expect(page.getByRole('heading', { name: '代理部署' })).toBeVisible();

  const refreshPage = page.getByTestId('refresh-page');
  const scrollTop = page.getByTestId('scroll-to-top');
  const hiddenY = Math.round((await refreshPage.boundingBox()).y);

  await page.evaluate(() => {
    window.scrollTo(0, 360);
    window.scrollTo(0, 520);
    window.scrollTo(0, 700);
  });
  await expect(scrollTop).not.toBeVisible();
  expect(Math.round((await refreshPage.boundingBox()).y)).toBe(hiddenY);

  await page.waitForTimeout(220);
  await expect(scrollTop).toBeVisible();
  const visibleY = Math.round((await refreshPage.boundingBox()).y);
  expect(hiddenY - visibleY).toBeGreaterThan(50);

  await page.evaluate(() => {
    window.scrollTo(0, 650);
    window.scrollTo(0, 600);
    window.scrollTo(0, 550);
  });
  expect(Math.round((await refreshPage.boundingBox()).y)).toBe(visibleY);
  await page.waitForTimeout(220);
  expect(Math.round((await refreshPage.boundingBox()).y)).toBe(visibleY);

  await page.evaluate(() => window.scrollTo(0, 100));
  await expect(scrollTop).toBeVisible();
  await page.waitForTimeout(220);
  await expect(scrollTop).not.toBeVisible();
  expect(Math.round((await refreshPage.boundingBox()).y)).toBe(hiddenY);
});

test('tablet deployment scroll action stays above the sticky submit panel', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/deployments');
  await expect(page.getByRole('heading', { name: '代理部署' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 700));

  const scrollTop = page.getByTestId('scroll-to-top');
  const actionButtons = page.getByTestId('page-action-buttons');
  const submitPanel = page.getByTestId('deployment-submit-panel');
  await expect(scrollTop).toBeVisible();
  await expect(submitPanel).toBeVisible();
  await expect(submitPanel).toHaveClass(/bottom-action-panel-stuck/);
  await expect(actionButtons).toHaveCSS('bottom', '154px');
  await expect.poll(async () => {
    const [scrollBox, submitBox] = await Promise.all([scrollTop, submitPanel].map(locator => locator.boundingBox()));
    return submitBox.y - (scrollBox.y + scrollBox.height);
  }).toBeCloseTo(12, 0);
  const [scrollBox, submitBox] = await Promise.all([scrollTop, submitPanel].map(locator => locator.boundingBox()));
  expect(submitBox.y - (scrollBox.y + scrollBox.height)).toBeCloseTo(12, 0);
  expect(submitBox.width).toBeLessThan(260);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(submitPanel).not.toHaveClass(/bottom-action-panel-stuck/);
  await expect(actionButtons).toHaveCSS('bottom', '96px');
  expect((await submitPanel.boundingBox()).width).toBeGreaterThan(500);
});

test('subscription management file action fits on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('tsub:locale', 'zh-CN'));
  await mockController(page);
  await openClientRoute(page, '/dashboard/groups');

  await expect(page.getByRole('heading', { name: '订阅管理' })).toBeVisible();
  await expect(page.getByTestId('subscription-file-import')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000, dark: false },
  { name: 'mobile-dark', width: 390, height: 844, dark: true }
]) {
  test(`${viewport.name}: subscription enable help stays readable and inside the viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(({ dark }) => {
      localStorage.setItem('tsub:locale', 'zh-CN');
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    }, { dark: viewport.dark });
    await mockController(page);
    await openClientRoute(page, '/dashboard/groups');

    const helpButtons = page.getByTestId('subscription-enabled-help');
    await expect(helpButtons).toHaveCount(2);
    await helpButtons.nth(1).click();
    const tooltip = page.getByTestId('subscription-enabled-tooltip').nth(1);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('不会停止服务器主动推送');
    await expect(helpButtons.nth(1)).toHaveAttribute('aria-expanded', 'true');

    const bounds = await tooltip.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    if (viewport.dark) {
      expect(await page.locator('html').getAttribute('class')).toContain('dark');
      expect(await tooltip.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    }

    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

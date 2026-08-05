import { expect, test } from '@playwright/test';

const accountId = 'a'.repeat(32); const databaseId = '1'.repeat(32); const namespaceId = '2'.repeat(32);
function usage() {
  const metric = (used, limit) => ({ used, limit, remaining: limit - used, percent: used / limit * 100, exceeded: false });
  const dates = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10));
  return { fetchedAt: '2026-08-07T12:00:00Z', stale: false, limits: { d1: { rowsReadDaily: 5000000, rowsWrittenDaily: 100000 }, kv: { readsDaily: 100000 } }, summary: {
    d1: { rowsRead: metric(55000, 5000000), rowsWritten: metric(2500, 100000), storage: metric(330000, 5000000000), selected: { rowsRead: 55000, rowsWritten: 2500, storageBytes: 330000, storage: metric(330000, 500000000) } },
    kv: { read: metric(9, 100000), write: metric(1, 1000), delete: metric(0, 1000), list: metric(0, 1000), storage: metric(90000, 1000000000), accountKeyCount: 23, selected: { read: 9, write: 1, storageBytes: 90000, keyCount: 23 } }
  }, daily: dates.map((date, index) => ({ date, d1: { rowsRead: index * 1000 }, kv: { read: index }, selected: { d1: {}, kv: {} } })) };
}
async function mockController(page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = { success: true, data: [] };
    if (path === '/api/public_config') body = { enablePublicPage: true, customLoginPath: 'login', customPage: { enabled: false } };
    else if (path === '/api/data') body = { tsubs: [], profiles: [], ruleTemplates: [], config: {} };
    else if (path === '/api/settings') body = { storageType: 'd1', secretStatus: { keySource: 'settings', 'cloudflareUsage.apiToken': true }, cloudflareUsage: { enabled: true, accountId, apiToken: '', d1DatabaseId: databaseId, kvNamespaceId: namespaceId } };
    else if (path === '/api/storage/status') body = { success: true, data: { platform: 'cloudflare', activeStorage: 'd1', bindings: { d1: true, kv: true } } };
    else if (path === '/api/storage/cloudflare/usage') body = { success: true, data: usage() };
    else if (path === '/api/settings/credentials') body = { success: true, data: { username: 'admin', canPersist: true } };
    else if (path === '/api/demo-data') body = { success: true, data: { counts: {} } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}
async function openSettings(page) {
  await page.goto('/');
  await page.evaluate(() => { history.pushState({}, '', '/dashboard/settings'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByRole('button', { name: '系统设置' }).click();
}

for (const scenario of [{ name: 'desktop-light', width: 1440, height: 1000, dark: false }, { name: 'mobile-dark', width: 390, height: 844, dark: true }]) {
  test(`${scenario.name}: Cloudflare quota card is readable without overflow`, async ({ page }) => {
    await page.setViewportSize(scenario);
    await page.addInitScript(dark => { localStorage.setItem('tsub:locale', 'zh-CN'); localStorage.setItem('theme', dark ? 'dark' : 'light'); }, scenario.dark);
    await mockController(page); await openSettings(page);
    const card = page.getByTestId('cloudflare-usage-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Cloudflare D1 / KV 额度');
    await expect(card).toContainText('今日账号用量');
    await expect(card).toContainText('最近 7 天趋势');
    await card.getByText('如何创建最小权限 API Token').click();
    await expect(card).toContainText('不要使用 Global API Key');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
}

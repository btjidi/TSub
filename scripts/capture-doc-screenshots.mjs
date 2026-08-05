import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = String(process.env.TSUB_SCREENSHOT_URL || '').replace(/\/+$/, '');
const username = process.env.TSUB_ADMIN_USERNAME || '';
const password = process.env.TSUB_ADMIN_PASSWORD || '';
if (!baseUrl || !username || !password) {
  throw new Error('Set TSUB_SCREENSHOT_URL, TSUB_ADMIN_USERNAME, and TSUB_ADMIN_PASSWORD.');
}

const outputDir = path.resolve('docs/assets/screenshots');
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: 'light',
  locale: 'zh-CN',
  reducedMotion: 'reduce'
});
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`));
page.on('console', message => {
  if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
});
page.on('response', response => {
  if (response.url().startsWith(baseUrl) && response.status() >= 400) {
    browserErrors.push(`response: ${response.status()} ${response.url()}`);
  }
});

const settle = async () => {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    localStorage.setItem('tsub:locale', 'zh-CN');
    localStorage.setItem('theme', 'light');
    await document.fonts?.ready;
  });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  await page.waitForTimeout(250);
};

const publicConfigResponse = await context.request.get(`${baseUrl}/api/public/config`);
const publicConfig = publicConfigResponse.ok() ? await publicConfigResponse.json() : {};
const loginPath = `/${String(publicConfig.customLoginPath || 'login').replace(/^\/+/, '')}`;
await page.goto(`${baseUrl}${loginPath}`, { waitUntil: 'networkidle' });
await page.locator('input[autocomplete="username"]').fill(username);
await page.locator('input[autocomplete="current-password"]').fill(password);
await Promise.all([
  page.waitForURL(url => url.pathname.startsWith('/dashboard')),
  page.locator('form button[type="submit"]').click()
]);

const forbidden = [
  password,
  process.env.CLOUDFLARE_ACCOUNT_ID,
  process.env.CLOUDFLARE_API_TOKEN,
  ...String(process.env.TSUB_SCREENSHOT_FORBIDDEN || '').split(',')
].filter(Boolean);

const assertSafe = async () => {
  const content = await page.locator('body').innerText();
  for (const value of forbidden) {
    if (content.includes(value)) throw new Error('Sensitive production value detected in screenshot view.');
  }
  if (/cfat_[A-Za-z0-9_-]+/.test(content)) throw new Error('Cloudflare API token detected in screenshot view.');
};

const capture = async (route, filename, action) => {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
  await settle();
  if (action) {
    await action();
    await settle();
  }
  await assertSafe();
  await page.screenshot({ path: path.join(outputDir, filename), fullPage: false });
};

// Capture the first-run dashboards before demo data exists.
await capture('/dashboard', 'dashboard.png');
await page.setViewportSize({ width: 390, height: 844 });
await capture('/dashboard', 'mobile-dashboard.png');
await page.setViewportSize({ width: 1440, height: 1000 });

// Seed demo data through the same settings interaction users follow.
await page.goto(`${baseUrl}/dashboard/settings`, { waitUntil: 'networkidle' });
await settle();
await page.getByRole('button', { name: '数据/备份', exact: true }).click();
const seedButton = page.getByTestId('seed-demo-data');
await seedButton.waitFor({ state: 'visible' });
const [seedResponse] = await Promise.all([
  page.waitForResponse(response => new URL(response.url()).pathname === '/api/demo-data' && response.request().method() === 'POST'),
  seedButton.click()
]);
const seedBody = await seedResponse.json();
if (!seedResponse.ok() || !seedBody?.success) throw new Error('Failed to seed local demo data through Settings.');
await page.waitForFunction(() => {
  const card = document.querySelector('[data-testid="demo-data-settings"]');
  return card && !card.textContent.includes('尚未生成演示数据') && card.textContent.includes('个订阅源');
});
await settle();

await page.setExtraHTTPHeaders({ 'X-TSub-Demo-View': '1' });
await capture('/dashboard/groups', 'subscription-management.png');
await capture('/dashboard/nodes', 'node-management.png');
await capture('/dashboard/subscriptions', 'my-subscriptions.png');
await capture('/dashboard/deployments', 'proxy-deployments.png', async () => {
  await page.getByRole('button', { name: '部署记录', exact: true }).click();
});
await capture('/dashboard/settings', 'settings.png', async () => {
  await page.getByRole('button', { name: '数据/备份', exact: true }).click();
  await page.locator('[data-testid="demo-data-settings"]').evaluate(element => {
    const dataSettings = element.parentElement;
    if (dataSettings?.previousElementSibling) dataSettings.previousElementSibling.style.display = 'none';
  });
  await page.evaluate(() => window.scrollTo(0, 0));
});
if (browserErrors.length) throw new Error(`Browser errors detected:\n${browserErrors.join('\n')}`);
await browser.close();

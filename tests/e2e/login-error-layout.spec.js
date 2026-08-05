import { expect, test } from '@playwright/test';

async function mockLoggedOutController(page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/public_config') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enablePublicPage: true, customLoginPath: 'login', customPage: { enabled: false } })
      });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unauthorized' })
    });
  });
}

for (const scenario of [
  { name: 'desktop light', width: 1440, height: 1000, theme: 'light' },
  { name: 'mobile dark', width: 390, height: 844, theme: 'dark' }
]) {
  test(`${scenario.name}: login error remains above the submit button`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('theme', theme);
      localStorage.setItem('tsub:locale', 'zh-CN');
    }, { theme: scenario.theme });
    await mockLoggedOutController(page);
    await page.goto('/login');

    await page.locator('input[autocomplete="current-password"]').fill('wrong-password');
    await page.getByRole('button', { name: '授权登录' }).click();

    const alert = page.getByRole('alert');
    const submit = page.getByRole('button', { name: '授权登录' });
    await expect(alert).toHaveText('登录失败，请检查账号和密码');
    await expect(alert).toBeVisible();

    const [alertBox, submitBox] = await Promise.all([alert.boundingBox(), submit.boundingBox()]);
    expect(alertBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    expect(alertBox.y + alertBox.height).toBeLessThanOrEqual(submitBox.y);

    const passwordInput = page.locator('input[autocomplete="current-password"]');
    const leadingIcon = page.getByTestId('password-leading-icon');
    const trailingIcon = page.getByRole('button', { name: '显示密码' });
    const [inputBox, leadingBox, trailingBox] = await Promise.all([
      passwordInput.boundingBox(), leadingIcon.boundingBox(), trailingIcon.boundingBox()
    ]);
    const inputCenter = inputBox.y + inputBox.height / 2;
    expect(Math.abs(leadingBox.y + leadingBox.height / 2 - inputCenter)).toBeLessThanOrEqual(1);
    expect(Math.abs(trailingBox.y + trailingBox.height / 2 - inputCenter)).toBeLessThanOrEqual(1);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

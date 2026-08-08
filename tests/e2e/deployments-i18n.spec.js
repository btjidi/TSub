import { expect, test } from '@playwright/test';

async function mockController(page, deploymentFixture = null) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = { success: true, data: [] };
    if (path === '/api/data') {
      body = { tsubs: [], profiles: [], ruleTemplates: [], config: {} };
    } else if (path === '/api/public_config') {
      body = { enablePublicPage: true, customLoginPath: 'login', customPage: { enabled: false } };
    } else if (path === '/api/deployment-defaults') {
      body = { success: true, data: {} };
    } else if (path === '/api/system/capabilities') {
      body = { success: true, data: { mode: 'full', features: { remoteCommands: true, heartbeats: true, localExecutor: false } } };
    } else if (path === '/api/deployments' && deploymentFixture) {
      body = { success: true, data: [deploymentFixture.deployment] };
    } else if (path === `/api/deployments/${deploymentFixture?.deployment.id}/template`) {
      body = { success: true, data: deploymentFixture };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const deploymentFixture = {
  deployment: {
    id: 'deploy-e2e', name: '演示 · 新加坡边缘', schemaVersion: 2, configRevision: 3, status: 'succeeded',
    deployedAt: '2026-08-01T04:30:31.000Z', configUpdatedAt: '2026-08-03T04:30:31.000Z', nodeCount: 4,
    nodeGroup: 'Singapore', profileId: '',
    agent: { online: true, lastSeenAt: '2026-08-03T04:30:31.000Z', heartbeat: { runtimeVersion: '2.3.15', core: 'xray', coreVersion: '26.8.1', osId: 'debian', osVersion: '13', osPrettyName: 'Debian GNU/Linux 13 (trixie)', pollIntervalSeconds: 30, hostname: 'a-very-long-edge-hostname', configRevision: 3 } },
    capabilities: { container: 'podman', init: 'openrc', memoryMb: 256, rssMb: 43, trafficBackend: 'core-xray', controlCommand: 'tsub', degradedReason: '缺少 CAP_NET_ADMIN，已跳过防火墙' },
    configSummary: { runtime: { core: 'xray', tier: 'auto' }, selfSigned: true, subscriptionServer: { enabled: true, port: 51235, trafficEnabled: true }, protocols: [{ protocol: 'vless', port: 443 }, { protocol: 'hysteria2', port: 51233 }] }
  },
  configRevision: 3, retainedSecrets: true,
  editor: { sharedUuidEnabled: true, sharedPasswordEnabled: true, randomPorts: { min: 10000, max: 65535 }, nodeNameMode: 'deployment-protocol-port' },
  config: {
    schemaVersion: 2, runtime: { tier: 'auto', core: 'xray', channel: 'stable', controlCommand: 'tsub' },
    certificate: { mode: 'self-signed' }, warp: {}, firewall: { enabled: true }, tunnels: [],
    subscription: { hostname: 'node.example.invalid', namePrefix: 'TSub', addressMode: 'auto', server: { enabled: true, port: 51250, token: '********', pushEnabled: true, pushIntervalMinutes: 15, pushAddressMode: 'auto', traffic: { enabled: true, quotaBytes: 0 } } },
    inbounds: [{ id: 'vless-main', name: '新加坡-VLESS', protocol: 'vless', port: 443, transport: 'tcp', outbound: 'direct', credentials: { uuid: '********' }, tls: { mode: 'reality', serverName: 'www.example.com', realityPrivateKey: '********', realityPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', shortId: 'a1b2c3d4' }, transportOptions: { path: '/', serviceName: 'tsub' } }]
  }
};

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'desktop-narrow', width: 1280, height: 900 },
  { name: 'compact-desktop', width: 1024, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 }
]) {
  test(`${viewport.name}: deployment controls remain usable and bilingual`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem('tsub:locale', 'zh-CN');
      localStorage.setItem('theme', 'light');
    });
    await mockController(page);
    await page.goto('/');
    await page.evaluate(() => {
      history.pushState({}, '', '/dashboard/deployments');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await expect(page.getByRole('heading', { name: '代理部署' })).toBeVisible();
    await expect(page.getByTestId('deployment-page-header')).toHaveCSS('border-radius', '12px');
    await expect(page.getByTestId('deployment-global-settings')).toHaveCSS('border-radius', '12px');
    await expect(page.getByTestId('deployment-control-command')).toHaveCSS('border-radius', '12px');
    await expect(page.getByTestId('control-command-input')).toHaveValue('tsub');
    await expect(page.getByText('资源与 Agent', { exact: true })).toBeVisible();
    await expect(page.getByText('协议全局配置', { exact: true })).toBeVisible();
    await expect(page.getByTestId('deployment-global-toggle')).toHaveCount(0);
    await expect(page.getByTestId('global-username')).toBeVisible();
    await expect(page.getByText('CDN、Argo 与 WARP', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '一次性部署命令' })).toBeVisible();
    await expect(page.getByTestId('deployment-submit')).toHaveText('生成安装命令');

    await page.getByTestId('deployment-runtime-toggle').click();
    await expect(page.getByTestId('deployment-runtime-settings')).toBeVisible();
    const agentHelp = page.getByTestId('agent-poll-interval-help');
    await agentHelp.scrollIntoViewIfNeeded();
    await agentHelp.click();
    const generatorTooltip = page.locator('[role="tooltip"]:visible');
    await expect(generatorTooltip).toContainText('频率越高，远程命令响应越快，但会增加主控请求量');
    await expect(agentHelp).toHaveAttribute('aria-expanded', 'true');
    const tooltipBox = await generatorTooltip.boundingBox();
    expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press('Escape');
    await expect(generatorTooltip).toBeHidden();

    const warpHelp = page.getByTestId('warp-help');
    await warpHelp.scrollIntoViewIfNeeded();
    await warpHelp.click();
    const overflowTooltip = page.locator('[role="tooltip"]:visible');
    await expect(overflowTooltip).toContainText('WARP');
    const overflowTooltipBox = await overflowTooltip.boundingBox();
    expect(overflowTooltipBox.x).toBeGreaterThanOrEqual(16);
    expect(overflowTooltipBox.x + overflowTooltipBox.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(overflowTooltipBox.y).toBeGreaterThanOrEqual(16);
    expect(overflowTooltipBox.y + overflowTooltipBox.height).toBeLessThanOrEqual(viewport.height - 16);
    await page.keyboard.press('Escape');

    const commandPanel = page.getByTestId('deployment-command-panel');
    if (viewport.width >= 1280) {
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, 500);
      });
      const navBox = await page.locator('header[aria-label="主导航"]').boundingBox();
      const commandBox = await commandPanel.boundingBox();
      expect(commandBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height + 12);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(50);
    } else {
      await expect(commandPanel).toHaveCSS('position', 'static');
    }
    const neutralButton = page.getByTestId('save-deployment-defaults');
    const neutralBefore = await neutralButton.evaluate(element => getComputedStyle(element).backgroundColor);
    if (viewport.width >= 1024) {
      await neutralButton.hover();
      await expect(neutralButton).toHaveCSS('background-color', 'rgb(243, 244, 246)');
      const neutralAfter = await neutralButton.evaluate(element => getComputedStyle(element).backgroundColor);
      expect(neutralAfter).not.toBe(neutralBefore);
    } else {
      await expect(neutralButton).toHaveCSS('cursor', 'pointer');
    }

    const submitPanel = page.getByTestId('deployment-submit-panel');
    const submitButton = page.getByTestId('deployment-submit');
    await expect(submitPanel).toHaveCSS('position', 'sticky');
    await submitButton.scrollIntoViewIfNeeded();
    const primaryBefore = await submitButton.evaluate(element => getComputedStyle(element).backgroundColor);
    await submitButton.hover();
    await expect(submitButton).toHaveCSS('background-color', 'rgb(29, 78, 216)');
    const primaryAfter = await submitButton.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(primaryAfter).not.toBe(primaryBefore);
    const submitPanelBox = await submitPanel.boundingBox();
    const submitButtonBox = await submitButton.boundingBox();
    expect(submitPanelBox.x + submitPanelBox.width - (submitButtonBox.x + submitButtonBox.width)).toBeLessThanOrEqual(24);
    expect(submitButtonBox.y + submitButtonBox.height).toBeLessThanOrEqual(viewport.height - (viewport.width < 1024 ? 64 : 0));

    const globalBox = await page.getByTestId('deployment-global-settings').boundingBox();
    const edgeBox = await page.getByTestId('edge-warp-settings').boundingBox();
    const inboundHeaderBox = await page.getByTestId('deployment-inbounds-header').boundingBox();
    const subscriptionBox = await page.getByTestId('vps-subscription-settings').boundingBox();
    expect(edgeBox.y - (globalBox.y + globalBox.height)).toBeLessThanOrEqual(24);
    expect(inboundHeaderBox.y - (edgeBox.y + edgeBox.height)).toBeLessThanOrEqual(24);
    expect(subscriptionBox.y - (inboundHeaderBox.y + inboundHeaderBox.height)).toBeLessThanOrEqual(24);
    const sharedTransportBox = await page.getByTestId('global-shared-transport').boundingBox();
    const sharedTlsBox = await page.getByTestId('global-shared-tls').boundingBox();
    const sharedOutboundBox = await page.getByTestId('global-shared-outbound').boundingBox();
    const sharedServerNameBox = await page.locator('#global-shared-server-name').boundingBox();
    const globalUsernameBox = await page.getByTestId('global-username').boundingBox();
    if (viewport.width < 1024) {
      expect(Math.max(sharedTransportBox.y, sharedTlsBox.y, sharedOutboundBox.y) - Math.min(sharedTransportBox.y, sharedTlsBox.y, sharedOutboundBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(sharedServerNameBox.y - globalUsernameBox.y)).toBeLessThanOrEqual(2);
      expect(sharedServerNameBox.y).toBeGreaterThan(sharedTransportBox.y + sharedTransportBox.height);
    }
    expect(Number.parseFloat(await page.getByTestId('global-shared-transport').evaluate(element => getComputedStyle(element).paddingRight))).toBeGreaterThanOrEqual(32);
    await page.getByTestId('global-shared-transport').click();
    await expect(page.getByTestId('global-shared-transport-shell').getByTestId('deployment-select-chevron')).toHaveClass(/rotate-180/);
    const selectMenu = page.getByTestId('deployment-select-menu');
    await expect(selectMenu).toBeVisible();
    await expect(selectMenu.getByRole('option')).toHaveCount(5);
    const [selectMenuBox, selectMenuStyle] = await Promise.all([
      selectMenu.boundingBox(),
      selectMenu.evaluate(element => {
        const style = getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow };
      })
    ]);
    expect(selectMenuBox.x).toBeGreaterThanOrEqual(8);
    expect(selectMenuBox.x + selectMenuBox.width).toBeLessThanOrEqual(viewport.width - 8);
    if (viewport.width < 1024) {
      expect(selectMenuBox.y).toBeGreaterThanOrEqual(64);
      expect(selectMenuBox.y + selectMenuBox.height).toBeLessThanOrEqual(viewport.height - 80);
    }
    expect(Number.parseFloat(selectMenuStyle.borderRadius)).toBeGreaterThanOrEqual(8);
    expect(selectMenuStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(selectMenuStyle.boxShadow).not.toBe('none');
    await selectMenu.getByRole('option', { name: 'WebSocket', exact: true }).click();
    await expect(page.getByTestId('global-shared-transport')).toHaveValue('ws');
    await expect(page.getByTestId('global-shared-transport-shell').getByTestId('deployment-select-chevron')).not.toHaveClass(/rotate-180/);
    await expect(selectMenu).toHaveCount(0);
    await page.getByTestId('global-shared-transport').selectOption('');
    if (viewport.width >= 1024) {
      const protocolBox = await page.getByTestId('inbound-protocol').boundingBox();
      const portBox = await page.getByTestId('inbound-port').boundingBox();
      const transportBox = await page.getByTestId('inbound-transport-0').boundingBox();
      const outboundBox = await page.getByTestId('inbound-outbound-0').boundingBox();
      expect(portBox.width).toBeLessThan(protocolBox.width);
      expect(Math.abs(transportBox.width - outboundBox.width)).toBeLessThanOrEqual(2);
      const moreButton = page.getByTestId('inbound-more-0');
      const deleteButton = page.getByTestId('inbound-delete-0');
      await expect(moreButton).toHaveCSS('white-space', 'nowrap');
      await expect(deleteButton).toHaveText('删除');
      expect((await moreButton.boundingBox()).height).toBeLessThanOrEqual(42);
      const inboundItemBox = await page.getByTestId('deployment-inbound-item').first().boundingBox();
      const deleteButtonBox = await deleteButton.boundingBox();
      expect(deleteButtonBox.x + deleteButtonBox.width).toBeLessThanOrEqual(inboundItemBox.x + inboundItemBox.width);
    } else if (viewport.width >= 640) {
      const protocolBox = await page.getByTestId('inbound-protocol').boundingBox();
      const portBox = await page.getByTestId('inbound-port').boundingBox();
      const nodeNameBox = await page.getByTestId('inbound-node-name').boundingBox();
      const moreButtonBox = await page.getByTestId('inbound-more-0').boundingBox();
      const deleteButtonBox = await page.getByTestId('inbound-delete-0').boundingBox();
      const transportBox = await page.getByTestId('inbound-transport-0').boundingBox();
      const outboundBox = await page.getByTestId('inbound-outbound-0').boundingBox();
      expect(Math.max(protocolBox.y, portBox.y, nodeNameBox.y) - Math.min(protocolBox.y, portBox.y, nodeNameBox.y)).toBeLessThanOrEqual(2);
      expect(Math.max(transportBox.y, outboundBox.y, moreButtonBox.y, deleteButtonBox.y) - Math.min(transportBox.y, outboundBox.y, moreButtonBox.y, deleteButtonBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(transportBox.width - outboundBox.width)).toBeLessThanOrEqual(2);
      await expect(page.getByTestId('inbound-delete-0')).toHaveText('删除');
      expect(deleteButtonBox.width).toBeGreaterThanOrEqual(44);
      expect(deleteButtonBox.width).toBeLessThanOrEqual(64);
      expect(moreButtonBox.width).toBeLessThan(76);
      const subscriptionPortBox = await page.getByTestId('vps-subscription-port-field').boundingBox();
      const subscriptionTokenBox = await page.getByTestId('vps-subscription-token-field').boundingBox();
      expect(Math.abs(subscriptionPortBox.y - subscriptionTokenBox.y)).toBeLessThanOrEqual(2);
      const subscriptionIntervalBox = await page.getByTestId('vps-push-interval-field').boundingBox();
      const subscriptionQuotaBox = await page.getByTestId('vps-traffic-quota-field').boundingBox();
      const subscriptionAddressBox = await page.getByTestId('vps-push-address-field').boundingBox();
      expect(Math.max(subscriptionIntervalBox.y, subscriptionQuotaBox.y, subscriptionAddressBox.y) - Math.min(subscriptionIntervalBox.y, subscriptionQuotaBox.y, subscriptionAddressBox.y)).toBeLessThanOrEqual(2);
      expect(subscriptionIntervalBox.y).toBeGreaterThan(subscriptionPortBox.y + subscriptionPortBox.height);
    } else {
      await expect(page.getByTestId('inbound-mobile-actions')).toBeVisible();
      const protocolBox = await page.getByTestId('inbound-protocol').boundingBox();
      const portBox = await page.getByTestId('inbound-port').boundingBox();
      const deleteButton = page.getByTestId('inbound-delete-mobile-0');
      const deleteButtonBox = await deleteButton.boundingBox();
      expect(Math.max(protocolBox.y, portBox.y, deleteButtonBox.y) - Math.min(protocolBox.y, portBox.y, deleteButtonBox.y)).toBeLessThanOrEqual(2);
      await expect(deleteButton).toHaveText('删除');
      const moreButton = page.getByTestId('inbound-more-mobile-0');
      const moreButtonBox = await moreButton.boundingBox();
      const transportBox = await page.getByTestId('inbound-transport-0').boundingBox();
      const outboundBox = await page.getByTestId('inbound-outbound-0').boundingBox();
      expect(Math.max(transportBox.y, outboundBox.y, moreButtonBox.y) - Math.min(transportBox.y, outboundBox.y, moreButtonBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(transportBox.width - outboundBox.width)).toBeLessThanOrEqual(2);
      expect(moreButtonBox.width).toBeLessThanOrEqual(68);
      expect(deleteButtonBox.width).toBeGreaterThanOrEqual(59);
      expect(deleteButtonBox.width).toBeLessThanOrEqual(68);
      await expect(moreButton).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('inbound-more-icon-mobile-0')).not.toHaveClass(/rotate-180/);
      await moreButton.click();
      await expect(moreButton).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('inbound-more-icon-mobile-0')).toHaveClass(/rotate-180/);
      await page.getByTestId('vps-subscription-details').scrollIntoViewIfNeeded();
      const subscriptionPortBox = await page.getByTestId('vps-subscription-port-field').boundingBox();
      const subscriptionAddressBox = await page.getByTestId('vps-push-address-field').boundingBox();
      const subscriptionTokenBox = await page.getByTestId('vps-subscription-token-field').boundingBox();
      const subscriptionQuotaBox = await page.getByTestId('vps-traffic-quota-field').boundingBox();
      const subscriptionIntervalBox = await page.getByTestId('vps-push-interval-field').boundingBox();
      expect(Math.abs(subscriptionPortBox.y - subscriptionAddressBox.y)).toBeLessThanOrEqual(2);
      expect(subscriptionTokenBox.y).toBeGreaterThan(subscriptionPortBox.y + subscriptionPortBox.height);
      expect(Math.abs(subscriptionQuotaBox.y - subscriptionIntervalBox.y)).toBeLessThanOrEqual(2);
      expect(subscriptionQuotaBox.y).toBeGreaterThan(subscriptionTokenBox.y + subscriptionTokenBox.height);
      const trafficToggleBox = await page.getByTestId('vps-traffic-enabled').boundingBox();
      const pushToggleBox = await page.getByTestId('vps-push-enabled').boundingBox();
      expect(pushToggleBox.y).toBeGreaterThan(trafficToggleBox.y + trafficToggleBox.height);
    }
    await expect(page.getByTestId('vps-push-enabled')).toBeChecked();
    await expect(page.getByTestId('vps-subscription-enabled').locator('..')).toContainText('生成订阅链接');
    await expect(page.getByTestId('vps-push-interval')).toHaveValue('15');
    await page.getByTestId('vps-push-interval').selectOption('5');
    await expect(page.getByText(/每 5 分钟主动推送/)).toBeVisible();
    await page.getByTestId('edge-mode').selectOption('manual');
    await expect(page.getByTestId('edge-hostname')).toBeVisible();
    await page.getByTestId('edge-hostname').fill('edge.example.com');
    await page.getByTestId('add-edge-endpoint').click();
    await page.locator('input[placeholder="198.51.100.10"]').fill('203.0.113.8');
    await page.getByTestId('warp-settings').getByLabel('手工导入').check();
    await expect(page.getByText('WARP Peer 公钥', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByTestId('warp-settings').getByLabel('服务器自动注册').check();
    await page.getByTestId('edge-mode').selectOption('disabled');

    await page.getByTestId('edge-mode').selectOption('quick');
    const quickDialog = page.getByTestId('quick-inbound-dialog');
    await expect(quickDialog).toContainText('需要 WebSocket 入站');
    await expect(quickDialog).toContainText('前往配置');
    await expect(quickDialog).toContainText('自动新增');
    await quickDialog.getByText('VMESS', { exact: true }).click();
    await quickDialog.getByTestId('quick-auto-add').click();
    await expect(page.getByTestId('quick-inbound')).not.toHaveValue('');
    await expect(page.locator('select[data-testid^="inbound-edge-mode-"]').last()).toHaveValue('only');
    await page.getByTestId('edge-mode').selectOption('disabled');

    await page.getByTestId('global-runtime-core').selectOption('xray');
    await page.locator('article select').first().selectOption('tuic');
    const nativeTransport = page.getByTestId('inbound-transport-0');
    await expect(nativeTransport).toContainText('TUIC / QUIC');
    expect(await nativeTransport.evaluate(element => element.tagName)).toBe('OUTPUT');
    await expect(page.getByText(/xray 核心不支持 TUIC v5/)).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    const deploymentName = page.locator('input[placeholder="HK Edge"]');
    await deploymentName.fill('暗色模式草稿');
    await page.getByRole('button', { name: '切换到暗色模式' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(deploymentName).toHaveValue('暗色模式草稿');
    await expect(page.getByTestId('deployment-page-header')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.035)');
    await expect(deploymentName).toHaveCSS('color', 'rgb(247, 248, 248)');
    await expect(deploymentName).toHaveCSS('border-color', 'rgba(255, 255, 255, 0.12)');
    await agentHelp.click();
    await expect(page.locator('[role="tooltip"]:visible > span').first()).toHaveCSS('background-color', 'oklch(0.373 0.034 259.733)');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: '部署记录' }).click();
    await expect(page.getByText('暂无部署记录')).toBeVisible();
    await page.getByRole('button', { name: '操作记录' }).click();
    await expect(page.getByText('暂无操作记录')).toBeVisible();
    await expect(page.locator('[data-testid="deployment-tabs"]')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.035)');

    await page.getByRole('button', { name: '生成器' }).click();
    await page.getByTestId('global-runtime-core').selectOption('auto');
    await page.getByTestId('inbound-protocol').first().selectOption('vless');
    await page.getByTestId('deployment-submit').click();
    await expect(page.getByTestId('deployment-risk-panel')).toHaveCSS('background-color', 'rgb(15, 16, 17)');
    await expect(page.getByTestId('deployment-risk-panel')).toHaveCSS('color', 'rgb(247, 248, 248)');
    await page.getByRole('button', { name: '取消' }).click();

    await page.getByRole('button', { name: '切换到 English' }).first().click();
    await expect(page.getByRole('heading', { name: 'Proxy Deployments' })).toBeVisible();
    await expect(page.getByText('CDN, Argo and WARP', { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(/Proxy Deployments - TSub/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  });
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${viewport.name}: update, reuse, and uninstall deployment modes`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem('tsub:locale', 'zh-CN');
      localStorage.setItem('theme', 'dark');
    });
    await mockController(page, deploymentFixture);
    await page.goto('/');
    await page.evaluate(() => {
      history.pushState({}, '', '/dashboard/deployments');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByTestId('deployment-runtime-toggle').click();
    await page.getByTestId('control-command-input').fill('edge-menu');
    await page.getByTestId('global-runtime-core').selectOption('sing-box');
    await page.getByTestId('inbound-protocol').selectOption('trojan');
    await page.getByTestId('inbound-node-name').fill('Current-Trojan');
    await page.getByRole('button', { name: '部署记录' }).click();
    await expect(page.getByTestId('deployment-time-row')).toContainText('部署时间 2026/8/1 · 更新时间 2026/8/3');
    await expect(page.getByTestId('deployment-system-row')).toContainText('Xray · auto · 4 个节点 · Debian 13 · Runtime 2.3.15');
    await expect(page.getByTestId('deployment-heartbeat-row')).toContainText('Agent 在线');
    for (const rowId of ['deployment-time-row', 'deployment-system-row', 'deployment-heartbeat-row']) {
      const lineCount = await page.getByTestId(rowId).locator(':scope > p').evaluate(element => Math.round(element.scrollHeight / Number.parseFloat(getComputedStyle(element).lineHeight)));
      expect(lineCount).toBe(1);
    }
    for (const [rowId, infoId] of [
      ['deployment-time-row', 'deployment-time-info-deploy-e2e'],
      ['deployment-system-row', 'deployment-system-info-deploy-e2e'],
      ['deployment-heartbeat-row', 'deployment-heartbeat-info-deploy-e2e']
    ]) {
      const row = page.getByTestId(rowId);
      const infoIcon = page.getByTestId(infoId).locator('svg');
      const [textBox, iconBox] = await Promise.all([
        row.locator(':scope > p').boundingBox(),
        page.getByTestId(infoId).boundingBox()
      ]);
      await expect(infoIcon.locator('circle[cx="12"][cy="12"][r="9"]')).toHaveCount(1);
      await expect(infoIcon.locator('path[stroke-linecap="round"]')).toHaveCount(2);
      expect(iconBox.x - (textBox.x + textBox.width)).toBeGreaterThanOrEqual(0);
      expect(iconBox.x - (textBox.x + textBox.width)).toBeLessThanOrEqual(8);
    }
    const compactRows = await Promise.all(['deployment-time-row', 'deployment-system-row', 'deployment-heartbeat-row'].map(rowId => page.getByTestId(rowId).boundingBox()));
    expect(compactRows.every(box => box.height <= 20)).toBe(true);
    expect(compactRows[1].y - (compactRows[0].y + compactRows[0].height)).toBeLessThanOrEqual(2);
    expect(compactRows[2].y - (compactRows[1].y + compactRows[1].height)).toBeLessThanOrEqual(2);
    if (viewport.width >= 1440) {
      const layout = page.getByTestId('deployment-record-layout');
      const [infoBox, actionsBox] = await Promise.all([layout.locator(':scope > div').nth(0).boundingBox(), layout.locator(':scope > div').nth(1).boundingBox()]);
      expect(actionsBox.width / infoBox.width).toBeGreaterThan(1.9);
      expect(actionsBox.width / infoBox.width).toBeLessThan(2.1);
    }

    const timeInfo = page.getByTestId('deployment-time-info-deploy-e2e');
    await timeInfo.hover();
    await expect(page.locator('[role="tooltip"]:visible')).toContainText('2026/8/1');
    await timeInfo.click();
    const systemInfo = page.getByTestId('deployment-system-info-deploy-e2e');
    await systemInfo.click({ force: true });
    await expect(timeInfo).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[role="tooltip"]:visible')).toContainText('缺少 CAP_NET_ADMIN');
    await page.getByTestId('deployment-page-header').click({ position: { x: 5, y: 5 } });
    await expect(systemInfo).toHaveAttribute('aria-expanded', 'false');

    const heartbeatInfo = page.getByTestId('deployment-heartbeat-info-deploy-e2e');
    await heartbeatInfo.click();
    const [infoBox, tooltipBox] = await Promise.all([heartbeatInfo.boundingBox(), page.locator('[role="tooltip"]:visible').boundingBox()]);
    expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(viewport.width);
    expect(infoBox.x + infoBox.width).toBeLessThanOrEqual(viewport.width);
    await page.getByTestId('deployment-page-header').click({ position: { x: 5, y: 5 } });
    await expect(heartbeatInfo).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    const remoteTrigger = page.getByTestId('deployment-remote-trigger');
    const updateButton = page.getByRole('button', { name: '更新配置' }).first();
    await expect(remoteTrigger).toHaveAttribute('aria-disabled', 'false');
    const [remoteStyle, updateStyle] = await Promise.all([
      remoteTrigger.evaluate(element => {
        const style = getComputedStyle(element);
        return { height: style.height, borderRadius: style.borderRadius, fontSize: style.fontSize, borderWidth: style.borderWidth, transitionDuration: style.transitionDuration };
      }),
      updateButton.evaluate(element => {
        const style = getComputedStyle(element);
        return { height: style.height, borderRadius: style.borderRadius, fontSize: style.fontSize, borderWidth: style.borderWidth, transitionDuration: style.transitionDuration };
      })
    ]);
    expect(remoteStyle).toEqual(updateStyle);
    await remoteTrigger.click();
    const remoteUpdateButton = page.getByTestId('remote-update-config');
    await expect(remoteUpdateButton).toBeVisible();
    const [remoteTriggerBox, remoteMenuBox] = await Promise.all([
      remoteTrigger.boundingBox(),
      page.getByTestId('deployment-remote-menu').boundingBox()
    ]);
    expect(remoteMenuBox.x).toBeGreaterThanOrEqual(8);
    expect(remoteMenuBox.x + remoteMenuBox.width).toBeLessThanOrEqual(viewport.width - 8);
    const leftAligned = Math.abs(remoteMenuBox.x - remoteTriggerBox.x) <= 2;
    const rightAligned = Math.abs((remoteMenuBox.x + remoteMenuBox.width) - (remoteTriggerBox.x + remoteTriggerBox.width)) <= 2;
    expect(leftAligned || rightAligned).toBe(true);
    if (viewport.width >= 640) expect(rightAligned).toBe(true);
    const remoteButtons = remoteUpdateButton.locator('..').getByRole('button');
    await expect(remoteButtons.first()).toHaveText('更新配置');
    await remoteUpdateButton.click();
    await expect(page.getByTestId('load-config-dialog')).toBeVisible();
    await page.getByRole('button', { name: '载入配置' }).click();
    await expect(page.getByTestId('deployment-submit')).toHaveText('保存并远程应用');
    await expect(page.getByTestId('deployment-command-panel')).toHaveCount(0);
    await page.getByTestId('deployment-submit').click();
    await expect(page.getByRole('heading', { name: '确认保存并远程应用' })).toBeVisible();
    const remoteRequestPromise = page.waitForRequest(request => request.url().endsWith('/api/deployments/deploy-e2e/commands') && request.method() === 'POST');
    await page.getByTestId('deployment-risk-panel').getByRole('button', { name: '保存并远程应用' }).click();
    const remoteRequest = await remoteRequestPromise;
    expect(remoteRequest.postDataJSON()).toMatchObject({ action: 'update', delivery: 'agent', configRevision: 3 });
    await expect(page.getByRole('button', { name: '操作记录' })).toHaveClass(/border-primary-200/);

    await page.getByRole('button', { name: '生成器' }).click();
    await page.getByTestId('deployment-runtime-toggle').click();
    await page.getByTestId('control-command-input').fill('edge-menu');
    await page.getByTestId('global-runtime-core').selectOption('sing-box');
    await page.getByTestId('inbound-protocol').selectOption('trojan');
    await page.getByTestId('inbound-node-name').fill('Current-Trojan');
    await page.getByRole('button', { name: '部署记录' }).click();
    await page.getByRole('button', { name: '更新配置' }).first().click();
    await expect(page.getByTestId('load-config-dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: '取消' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重新配置' })).toBeVisible();
    await expect(page.getByRole('button', { name: '载入配置' })).toBeVisible();
    await page.getByRole('button', { name: '重新配置' }).click();
    await expect(page.getByTestId('deployment-mode-update')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('target-deployment-select')).toHaveValue('deploy-e2e');
    await expect(page.locator('input[placeholder="HK Edge"]')).toHaveValue('演示 · 新加坡边缘');
    await expect(page.getByTestId('control-command-input')).toHaveValue('edge-menu');
    await expect(page.getByTestId('global-runtime-core')).toHaveValue('sing-box');
    await expect(page.getByTestId('inbound-protocol')).toHaveValue('trojan');
    await expect(page.getByTestId('inbound-node-name')).toHaveValue('Current-Trojan');

    await page.getByRole('button', { name: '部署记录' }).click();
    await page.getByRole('button', { name: '更新配置' }).first().click();
    await page.getByRole('button', { name: '载入配置' }).click();
    await expect(page.getByTestId('deployment-mode-update')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('target-deployment-select')).toHaveValue('deploy-e2e');
    await expect(page.locator('input[placeholder="HK Edge"]')).toHaveValue('演示 · 新加坡边缘');
    await expect(page.getByTestId('deployment-submit')).toHaveText('保存配置并生成更新命令');

    await page.getByRole('button', { name: '部署记录' }).click();
    await page.getByRole('button', { name: '复用配置' }).click();
    await expect(page.getByTestId('deployment-mode-install')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('reuse-config-notice')).toContainText('创建一条全新部署记录');
    await expect(page.getByTestId('global-node-group')).toHaveValue('');
    await expect(page.getByTestId('global-profile')).toHaveValue('');

    await page.getByTestId('deployment-mode-uninstall').click();
    await page.getByTestId('target-deployment-select').selectOption('deploy-e2e');
    await expect(page.getByTestId('uninstall-target-summary')).toContainText('演示 · 新加坡边缘');
    await expect(page.getByTestId('deployment-basic-settings')).toHaveCount(0);
    await expect(page.getByTestId('deployment-submit')).toHaveText('生成卸载命令');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('../../src/lib/deployments.js', () => ({
  createDeployment: vi.fn(), createDeploymentCommand: vi.fn(), createRemoteDeploymentCommand: vi.fn(), deleteDeployment: vi.fn(), restoreDeploymentSource: vi.fn(),
  checkDeploymentEdgePermissions: vi.fn(), cleanupDeploymentCloudflareResources: vi.fn(),
  probeDeploymentEdge: vi.fn(),
  getDeploymentTemplate: vi.fn(),
  getDeploymentDefaults: vi.fn(() => Promise.resolve({ success: true, data: {} })),
  listDeploymentOperations: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  listDeployments: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  resetDeploymentDefaults: vi.fn(), saveDeploymentDefaults: vi.fn()
}));

import DeploymentsView from '../../src/views/DeploymentsView.vue';
import { checkDeploymentEdgePermissions, createDeployment, createDeploymentCommand, createRemoteDeploymentCommand, deleteDeployment, getDeploymentTemplate, listDeploymentOperations, listDeployments, probeDeploymentEdge, restoreDeploymentSource, saveDeploymentDefaults } from '../../src/lib/deployments.js';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { createI18n } from '../../src/i18n/index.js';

describe('TSub Proxy simplified deployment generator', () => {
  let wrapper;
  const mountView = (locale = 'zh-CN') => mount(DeploymentsView, {
    attachTo: document.body,
    global: { plugins: [createI18n({ initialLocale: locale })] }
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    const dataStore = useDataStore();
    dataStore.fetchData = vi.fn(() => Promise.resolve());
    dataStore.profiles = [];
    listDeployments.mockResolvedValue({ success: true, data: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    wrapper?.unmount();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('shows common global and inbound fields initially while keeping advanced overrides collapsed', async () => {
    wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[data-testid="deployment-page-header"]').classes()).toContain('deployment-surface');
    expect(wrapper.get('[data-testid="deployment-tabs"]').classes()).toContain('deployment-surface');
    expect(wrapper.get('[data-testid="deployment-basic-settings"]').classes()).toContain('deployment-surface');
    expect(wrapper.get('[data-testid="deployment-global-settings"]').classes()).toContain('deployment-surface');
    expect(wrapper.get('[data-testid="deployment-control-command"]').classes()).toContain('deployment-surface');
    const controlCard = wrapper.get('[data-testid="deployment-control-command"]');
    expect(controlCard.find('[data-testid="deployment-runtime-settings"]').exists()).toBe(true);
    expect(controlCard.find('[data-testid="vps-subscription-settings"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="deployment-control-command"]').classes()).toContain('order-3');
    expect(wrapper.get('[data-testid="deployment-global-settings"]').classes()).toContain('order-4');
    expect(wrapper.get('[data-testid="vps-subscription-settings"]').classes()).toContain('order-5');
    expect(wrapper.get('[data-testid="deployment-runtime-toggle"]').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="deployment-runtime-toggle-icon"]').classes()).not.toContain('rotate-180');
    expect(wrapper.find('[data-testid="deployment-global-toggle"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="global-username"]').element.value).toBe('tsub');
    expect(wrapper.find('[data-testid="deployment-certificate-settings"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="deployment-runtime-settings"]').isVisible()).toBe(false);
    expect(wrapper.get('[data-testid="deployment-global-settings"]').find('[data-testid="agent-poll-interval"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="control-command-input"]').element.value).toBe('tsub');
    const commandPanel = wrapper.get('[data-testid="deployment-command-panel"]');
    expect(commandPanel.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'xl:sticky', 'xl:top-24']));
    expect(wrapper.text()).toContain('节点公网地址（可选）');
    expect(wrapper.text()).toContain('统一 UUID');
    expect(wrapper.text()).toContain('证书策略');
    expect(wrapper.text()).toContain('核心');
    expect(wrapper.get('[data-testid="global-runtime-core"]').element.value).toBe('auto');
    expect(wrapper.get('[data-testid="global-runtime-core"]').find('option[value="auto"]').text()).toBe('自动（优先 Xray）');
    expect(wrapper.get('[data-testid="deployment-control-command"]').text()).toContain('资源与 Agent');
    await wrapper.get('[data-testid="deployment-runtime-toggle"]').trigger('click');
    expect(wrapper.get('[data-testid="deployment-runtime-toggle"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="deployment-runtime-settings"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-testid="agent-poll-interval"]').element.value).toBe('30');
    expect(wrapper.get('[data-testid="agent-poll-interval"]').findAll('option').map(option => option.element.value)).toEqual(['15', '30', '60', '120', '180', '300']);
    const resourceHelp = wrapper.get('[data-testid="deployment-resource-tier-help"]');
    await resourceHelp.trigger('click');
    expect(document.getElementById(resourceHelp.attributes('aria-controls')).textContent).toContain('cgroup 上限：等待服务器上报');
    expect(wrapper.text()).toContain('传输');
    expect(wrapper.text()).toContain('出站');
    expect(wrapper.get('[data-testid="deployment-global-actions"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-testid="save-deployment-defaults"]').classes()).toContain('deploy-btn-neutral');
    expect(wrapper.get('[data-testid="reset-deployment-defaults"]').classes()).toContain('deploy-btn-danger');
    const submitPanel = wrapper.get('[data-testid="deployment-submit-panel"]');
    expect(submitPanel.classes()).toEqual(expect.arrayContaining(['bottom-action-panel', 'sticky', 'bottom-20', 'w-full', 'justify-end', 'backdrop-blur-sm', 'lg:bottom-4']));
    const submit = wrapper.get('[data-testid="deployment-submit"]');
    expect(submit.text()).toBe('生成安装命令');
    expect(submit.classes()).toEqual(expect.arrayContaining(['deploy-btn-primary', 'bg-primary-600', 'shadow-sm']));
    expect(wrapper.find('[data-testid="apply-deployment-defaults"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="save-deployment-defaults"]').text()).toBe('保存为系统默认');
    expect(wrapper.get('[data-testid="reset-deployment-defaults"]').text()).toBe('重置');
    expect(wrapper.text()).toContain('统一密码');
    expect(wrapper.text()).not.toContain('UUID 覆盖');

    const globalUuid = wrapper.find('input[placeholder="留空自动生成并共享"]');
    expect(globalUuid.attributes('type')).toBe('text');

    const advanced = wrapper.get('[data-testid="inbound-more-0"]');
    await advanced.trigger('click');
    const inboundUuid = wrapper.find('input[placeholder="留空使用统一 UUID；统一 UUID 为空时自动生成"]');
    expect(inboundUuid.attributes('type')).toBe('text');
    const advancedPanel = wrapper.get('[data-testid="inbound-advanced-0"]');
    expect(advancedPanel.findAll('select')).toHaveLength(2);
    const privateKey = {};
    const publicKey = {};
    vi.spyOn(crypto.subtle, 'generateKey').mockResolvedValue({ privateKey, publicKey });
    vi.spyOn(crypto.subtle, 'exportKey').mockImplementation((format, key) => Promise.resolve(key === privateKey ? { d: 'private-reality-key' } : { x: 'public-reality-key' }));
    expect(wrapper.get('[data-testid="reality-private-key"]').attributes('type')).toBe('password');
    await wrapper.get('[data-testid="toggle-reality-private-key"]').trigger('click');
    expect(wrapper.get('[data-testid="reality-private-key"]').attributes('type')).toBe('text');
    await wrapper.get('[data-testid="generate-reality-key"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="reality-private-key"]').element.value).toBe('private-reality-key');
    expect(wrapper.get('[data-testid="reality-public-key"]').element.value).toBe('public-reality-key');
    expect(wrapper.text()).toContain('NaiveProxy');
    expect(wrapper.get('[data-testid="generate-global-uuid"]').classes()).toContain('absolute');
    expect(wrapper.get('[data-testid="generate-inbound-uuid"]').classes()).toContain('absolute');
    expect(wrapper.get('[data-testid="generate-subscription-token"]').classes()).toContain('absolute');
    const sharedToggle = wrapper.get('[data-testid="shared-uuid-enabled"]');
    expect(sharedToggle.element.checked).toBe(true);
    await sharedToggle.setValue(false);
    expect(wrapper.get('[data-testid="global-uuid"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="global-uuid"]').attributes('placeholder')).toBe('每个 UUID 入站独立生成');
    expect(wrapper.get('[data-testid="inbound-uuid"]').attributes('placeholder')).toBe('留空为当前入站独立生成 UUID');
    expect(wrapper.find('input[placeholder="HK Edge"]').classes()).toContain('keep-square');
    expect(wrapper.get('[data-testid="inbound-port"]').classes()).not.toContain('keep-square');
    const sharedOptions = wrapper.get('[data-testid="deployment-shared-options"]');
    expect(sharedOptions.classes()).toEqual(expect.arrayContaining(['grid-cols-6', 'lg:grid-cols-5']));
    expect(wrapper.find('[data-testid="deployment-shared-protocol-settings"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="global-shared-transport-shell"]').classes()).toContain('deployment-select-shell');
    const sharedTransportChevron = wrapper.get('[data-testid="global-shared-transport-shell"] [data-testid="deployment-select-chevron"]');
    expect(sharedTransportChevron.classes()).not.toContain('rotate-180');
    await wrapper.get('[data-testid="global-shared-transport"]').trigger('pointerdown');
    expect(sharedTransportChevron.classes()).toContain('rotate-180');
    await wrapper.get('[data-testid="global-shared-transport"]').trigger('change');
    expect(sharedTransportChevron.classes()).not.toContain('rotate-180');
    const inboundGrid = wrapper.get('[data-testid="inbound-basic-row"]').classes().join(' ');
    expect(inboundGrid).toContain('minmax(104px,0.8fr)');
    expect(inboundGrid).toContain('minmax(80px,0.45fr)');
    expect(inboundGrid).toContain('minmax(152px,1.2fr)');
    expect(inboundGrid).toContain('minmax(126px,0.95fr)');
    const inboundCard = wrapper.get('[data-testid="deployment-inbounds-header"]');
    expect(wrapper.get('[data-testid="vps-subscription-settings"]').classes()).toContain('order-5');
    expect(wrapper.get('[data-testid="edge-warp-settings"]').classes()).toContain('order-6');
    expect(inboundCard.classes()).toEqual(expect.arrayContaining(['deployment-surface', 'order-7', 'overflow-hidden']));
    expect(inboundCard.findAll('[data-testid="deployment-inbound-item"]')).toHaveLength(1);
    expect(inboundCard.get('[data-testid="deployment-inbound-item"]').classes()).not.toContain('deployment-surface');
    expect(inboundCard.get('[data-testid="inbound-mobile-actions"]').classes()).toContain('sm:hidden');
    expect(advanced.classes()).toEqual(expect.arrayContaining(['w-fit', 'shrink-0', 'justify-self-end', 'whitespace-nowrap', 'px-2', 'sm:col-start-5', 'sm:row-start-2']));
    expect(advanced.classes()).not.toContain('min-w-[4.75rem]');
    expect(wrapper.get('[data-testid="inbound-delete-0"]').classes()).toEqual(expect.arrayContaining(['w-fit', 'px-2', 'sm:col-start-6', 'sm:row-start-2']));
    expect(wrapper.get('[data-testid="inbound-delete-0"]').text()).toBe('删除');
    expect(wrapper.get('[data-testid="inbound-delete-mobile-0"]').text()).toBe('删除');
    expect(wrapper.get('[data-testid="inbound-more-mobile-0"]').classes()).toEqual(expect.arrayContaining(['col-start-5', 'row-start-3']));
    expect(wrapper.get('[data-testid="inbound-more-mobile-0"]').classes()).not.toContain('col-span-2');
    expect(wrapper.get('[data-testid="inbound-delete-mobile-0"]').classes()).toEqual(expect.arrayContaining(['col-start-5', 'row-start-1', 'min-w-[3.75rem]']));
    expect(wrapper.get('[data-testid="vps-subscription-enabled"]').element.parentElement.textContent).toContain('生成订阅链接');
    expect(wrapper.get('[data-testid="vps-subscription-token-field"]').classes()).toEqual(expect.arrayContaining(['col-span-2', 'row-start-2', 'sm:col-span-4', 'sm:col-start-3', 'sm:row-start-1']));
    expect(wrapper.get('[data-testid="vps-push-address-field"]').classes()).toEqual(expect.arrayContaining(['col-start-2', 'row-start-1', 'sm:col-start-5', 'sm:row-start-2']));
    expect(wrapper.get('[data-testid="vps-push-interval-field"]').classes()).toEqual(expect.arrayContaining(['col-start-2', 'row-start-3', 'sm:col-start-1', 'sm:row-start-2']));
    expect(wrapper.get('[data-testid="vps-traffic-quota-control"]').classes()).toEqual(expect.arrayContaining(['relative', 'overflow-hidden']));
    expect(wrapper.get('[data-testid="vps-traffic-quota-control"] select').classes()).toEqual(expect.arrayContaining(['absolute', 'right-px', 'border-l', 'rounded-none']));
    expect(wrapper.get('[data-testid="deployment-global-actions"]').classes()).toContain('justify-end');
    const moreIcon = wrapper.get('[data-testid="inbound-more-icon-0"]');
    expect(moreIcon.classes()).toContain('rotate-180');
    await advanced.trigger('click');
    expect(advanced.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="inbound-more-icon-0"]').classes()).not.toContain('rotate-180');
    expect(wrapper.get('[data-testid="inbound-node-name"]').attributes('placeholder')).toContain('部署名称-vless-随机端口');
    await wrapper.get('[data-testid="deployment-runtime-toggle"]').trigger('click');
    expect(wrapper.get('[data-testid="node-name-mode"]').element.value).toBe('deployment-protocol-port');
    const firewallMode = wrapper.get('[data-testid="global-firewall-mode"]');
    expect(firewallMode.element.value).toBe('true');
    expect(firewallMode.findAll('option').map(option => option.text())).toEqual(['自动管理（推荐）', '不管理']);
    await firewallMode.setValue('false');
    expect(firewallMode.element.value).toBe('false');
    expect(wrapper.html()).not.toContain('mt-32');
  });

  it('shows certificate inputs next to the selected certificate strategy', async () => {
    wrapper = mountView();
    await flushPromises();

    const certificateMode = wrapper.get('[data-testid="global-certificate-mode"]');
    expect(wrapper.find('[data-testid="deployment-certificate-settings"]').exists()).toBe(false);

    await certificateMode.setValue('acme-http01');
    expect(wrapper.get('[data-testid="deployment-certificate-settings"]').exists()).toBe(true);
    expect(wrapper.find('#global-acme-email').exists()).toBe(true);
    expect(wrapper.find('#global-certificate-api-token').exists()).toBe(false);

    await certificateMode.setValue('cloudflare-dns01');
    expect(wrapper.find('#global-acme-email').exists()).toBe(true);
    expect(wrapper.find('#global-certificate-api-token').exists()).toBe(true);

    await certificateMode.setValue('existing');
    expect(wrapper.find('#global-acme-email').exists()).toBe(false);
    expect(wrapper.find('[data-testid="global-certificate-path"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="global-certificate-key-path"]').exists()).toBe(true);

    await certificateMode.setValue('self-signed');
    expect(wrapper.find('[data-testid="deployment-certificate-settings"]').exists()).toBe(false);
  });

  it('shows accessible generator help on preview or click and keeps one popover open', async () => {
    wrapper = mountView();
    await flushPromises();

    const agentHelp = wrapper.get('[data-testid="agent-poll-interval-help"]');
    const agentTooltip = document.getElementById(agentHelp.attributes('aria-controls'));
    expect(agentHelp.attributes('aria-expanded')).toBe('false');
    expect(agentTooltip.style.display).toBe('none');
    expect(agentTooltip.textContent).toContain('频率越高，远程命令响应越快，但会增加主控请求量；最长可能等待一个所选周期。');
    expect(document.querySelector('label[for="agent-poll-interval"]').textContent).toBe('Agent 连接频率');

    agentHelp.element.parentElement.dispatchEvent(new MouseEvent('mouseenter'));
    await flushPromises();
    expect(agentHelp.attributes('aria-expanded')).toBe('true');
    agentHelp.element.parentElement.dispatchEvent(new MouseEvent('mouseleave'));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(agentHelp.attributes('aria-expanded')).toBe('false');

    await agentHelp.trigger('focus');
    expect(agentHelp.attributes('aria-expanded')).toBe('true');
    expect(agentTooltip.style.display).not.toBe('none');
    await agentHelp.trigger('click');
    await agentHelp.trigger('blur');
    expect(agentHelp.attributes('aria-expanded')).toBe('true');

    const hostnameHelp = wrapper.get('[data-testid="deployment-hostname-help"]');
    await hostnameHelp.trigger('click');
    expect(agentHelp.attributes('aria-expanded')).toBe('false');
    expect(hostnameHelp.attributes('aria-expanded')).toBe('true');
    expect(document.querySelector('label[for="deployment-hostname"]').textContent).toBe('节点公网地址（可选）');
    expect(document.querySelector('label[for="inbound-transport-0"]').textContent).toBe('传输');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(hostnameHelp.attributes('aria-expanded')).toBe('false');

    await wrapper.get('[data-testid="inbound-outbound-help-0"]').trigger('click');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(wrapper.get('[data-testid="inbound-outbound-help-0"]').attributes('aria-expanded')).toBe('false');
  });

  it('expands the runtime group when a hidden runtime field fails validation', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.find('input[placeholder="HK Edge"]').setValue('Invalid Runtime');
    await wrapper.get('[data-testid="control-command-input"]').setValue('INVALID COMMAND');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-runtime-toggle"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="deployment-runtime-settings"]').isVisible()).toBe(true);
  });

  it('adds help only to curated complex generator fields', async () => {
    wrapper = mountView();
    await flushPromises();
    for (const testId of [
      'deployment-hostname-help', 'deployment-address-mode-help', 'deployment-resource-tier-help',
      'deployment-core-channel-help', 'agent-poll-interval-help', 'vps-traffic-enabled-help',
      'vps-push-enabled-help', 'vps-subscription-token-help', 'vps-traffic-quota-help',
      'push-address-mode-help', 'shared-uuid-help', 'certificate-mode-help', 'global-core-help',
      'edge-mode-help', 'warp-help', 'inbound-transport-help-0', 'inbound-outbound-help-0'
    ]) expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(true);
    expect(wrapper.find('[data-testid="inbound-port-help-0"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="inbound-node-name-help-0"]').exists()).toBe(false);

    await wrapper.findAll('button').find(button => button.text().includes('更多设置')).trigger('click');
    for (const testId of ['shared-password-help', 'node-name-mode-help', 'global-profile-help', 'shared-transport-help', 'shared-tls-help', 'shared-outbound-help', 'shared-server-name-help', 'firewall-help']) {
      expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(true);
    }

    await wrapper.findAll('button').find(button => button.text().includes('更多') && !button.text().includes('设置')).trigger('click');
    for (const testId of ['inbound-edge-mode-help-0', 'inbound-tls-help-0', 'inbound-server-name-help-0']) {
      expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(true);
    }

    await wrapper.get('[data-testid="edge-mode"]').setValue('quick');
    expect(wrapper.find('[data-testid="quick-inbound-help"]').exists()).toBe(true);
    await wrapper.get('[data-testid="edge-mode"]').setValue('manual');
    expect(wrapper.find('[data-testid="edge-endpoints-help"]').exists()).toBe(true);
  });

  it('detects the managed Tunnel zone automatically with Cloudflare dashboard terminology', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.get('[data-testid="edge-mode"]').setValue('managed');

    expect(document.querySelector('label[for="edge-cloudflare-account-id"]').textContent).toBe('Cloudflare 帐户 ID（Account ID）');
    expect(document.querySelector('label[for="edge-cloudflare-api-token"]').textContent).toBe('Cloudflare API 令牌（API Token）');
    expect(wrapper.find('[data-testid="edge-cloudflare-zone-id"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('主控会自动识别 Zone ID');

    const accountHelp = wrapper.get('[data-testid="edge-account-id-help"]');
    await accountHelp.trigger('click');
    expect(document.getElementById(accountHelp.attributes('aria-controls')).textContent).toContain('不是令牌');
    expect(wrapper.find('[data-testid="edge-api-token-help"]').exists()).toBe(true);

    checkDeploymentEdgePermissions.mockResolvedValue({ data: {
      checks: { tunnel: { ok: true }, zone: { ok: true }, dns: { ok: true }, ssl: { ok: true } },
      zone: { id: 'b'.repeat(32), name: 'example.com', sslMode: 'strict' }
    } });
    vi.useFakeTimers();
    await wrapper.get('[data-testid="edge-hostname"]').setValue('node.example.com');
    await wrapper.get('[data-testid="edge-cloudflare-account-id"]').setValue('a'.repeat(32));
    await wrapper.get('[data-testid="edge-cloudflare-api-token"]').setValue('edit-token');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(599);
    expect(checkDeploymentEdgePermissions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(checkDeploymentEdgePermissions).toHaveBeenCalledWith({ accountId: 'a'.repeat(32), apiToken: 'edit-token', hostname: 'node.example.com' });
    expect(wrapper.get('[data-testid="edge-zone-detected"]').text()).toContain('已识别区域：example.com · Zone ID bbbb…bbbb');
    expect(wrapper.get('[data-testid="edge-ssl-mode"]').text()).toContain('完全（严格）');
    expect(wrapper.find('[data-testid="edge-strict-certificate-warning"]').exists()).toBe(false);
    await wrapper.get('[data-testid="edge-mode"]').setValue('manual');
    expect(wrapper.get('[data-testid="edge-strict-certificate-warning"]').text()).toContain('可信证书');
    await wrapper.get('[data-testid="edge-strict-certificate-warning"] button').trigger('click');
    expect(wrapper.get('[data-testid="global-certificate-mode"]').element.value).toBe('cloudflare-dns01');
    expect(wrapper.find('#global-acme-email').exists()).toBe(true);
    expect(wrapper.text()).toContain('Argo Tunnel (Legacy)');
  });

  it('discards a stale automatic Zone ID response after the inputs change', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.get('[data-testid="edge-mode"]').setValue('managed');
    let resolveFirst; let resolveSecond;
    checkDeploymentEdgePermissions
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    vi.useFakeTimers();
    await wrapper.get('[data-testid="edge-cloudflare-account-id"]').setValue('a'.repeat(32));
    await wrapper.get('[data-testid="edge-cloudflare-api-token"]').setValue('edit-token');
    await wrapper.get('[data-testid="edge-hostname"]').setValue('old.example.com');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(600);
    expect(checkDeploymentEdgePermissions).toHaveBeenCalledTimes(1);

    await wrapper.get('[data-testid="edge-hostname"]').setValue('new.example.net');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(600);
    expect(checkDeploymentEdgePermissions).toHaveBeenCalledTimes(2);
    resolveSecond({ data: { checks: { zone: { ok: true } }, zone: { id: 'c'.repeat(32), name: 'example.net' } } });
    await flushPromises();
    expect(wrapper.get('[data-testid="edge-zone-detected"]').text()).toContain('example.net');
    resolveFirst({ data: { checks: { zone: { ok: true } }, zone: { id: 'b'.repeat(32), name: 'example.com' } } });
    await flushPromises();
    expect(wrapper.get('[data-testid="edge-zone-detected"]').text()).toContain('example.net');
    expect(wrapper.get('[data-testid="edge-zone-detected"]').text()).not.toContain('example.com');
  });

  it('shows a safe automatic Zone ID detection error and allows a manual retry', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.get('[data-testid="edge-mode"]').setValue('managed');
    checkDeploymentEdgePermissions.mockResolvedValue({ data: {
      checks: { tunnel: { ok: false, error: 'cloudflare_edge_invalid_token' }, zone: { ok: false, error: 'cloudflare_edge_invalid_token' }, dns: { ok: false, error: 'cloudflare_edge_invalid_token' } },
      zone: null
    } });
    vi.useFakeTimers();
    await wrapper.get('[data-testid="edge-hostname"]').setValue('node.example.com');
    await wrapper.get('[data-testid="edge-cloudflare-account-id"]').setValue('a'.repeat(32));
    await wrapper.get('[data-testid="edge-cloudflare-api-token"]').setValue('invalid-token');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    expect(wrapper.get('[data-testid="edge-zone-error"]').text()).toContain('API 令牌无效或已失效');
    expect(wrapper.get('[data-testid="detect-edge-zone"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="detect-edge-zone"]').trigger('click');
    await flushPromises();
    expect(checkDeploymentEdgePermissions).toHaveBeenCalledTimes(2);
  });

  it('renders English generator help text', async () => {
    wrapper = mountView('en');
    await flushPromises();
    const help = wrapper.get('[data-testid="agent-poll-interval-help"]');
    await help.trigger('click');
    const tooltip = document.getElementById(help.attributes('aria-controls'));
    expect(tooltip.textContent).toContain('Shorter intervals improve remote command response time but increase controller requests.');
  });

  it('defines dark theme surfaces, form controls, status badges, and dialogs', async () => {
    const source = readFileSync(path.join(process.cwd(), 'src/views/DeploymentsView.vue'), 'utf8');

    expect(source).toContain('background: var(--surface-card-dark)');
    expect(source).toContain('border-color: var(--border-standard-dark)');
    expect(source).toContain(':global(.dark .deployments-page select option)');
    expect(source).toContain('box-shadow: var(--focus-ring)');
    expect(source).toContain(':global(.dark .deployment-risk-panel)');
    expect(source).toContain('dark:border-emerald-400/35 dark:text-emerald-300');
    expect(source).toContain('dark:border-red-400/35 dark:text-red-300');
  });

  it('sends the server control command only with the current deployment', async () => {
    createDeployment.mockResolvedValue({ data: { deployment: { id: 'deploy-control' }, command: 'curl short', wgetCommand: 'wget short', diagnosticCommand: 'curl diagnostic', diagnosticWgetCommand: 'wget diagnostic', expiresAt: '' } });
    saveDeploymentDefaults.mockResolvedValue({ data: {} });
    wrapper = mountView();
    await flushPromises();
    await wrapper.find('input[placeholder="HK Edge"]').setValue('Control VPS');
    await wrapper.get('[data-testid="inbound-node-name"]').setValue('新加坡-HY2');
    await wrapper.get('[data-testid="control-command-input"]').setValue('proxy-menu');
    await wrapper.findAll('button').find(button => button.text().includes('更多设置')).trigger('click');
    await wrapper.findAll('button').find(button => button.text() === '保存为系统默认').trigger('click');
    await flushPromises();
    expect(saveDeploymentDefaults.mock.calls[0][0].runtime).not.toHaveProperty('controlCommand');
    await wrapper.get('[data-testid="global-runtime-core"]').setValue('xray');
    await wrapper.get('[data-testid="agent-poll-interval"]').setValue('120');

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const confirm = document.querySelector('[data-testid="deployment-risk-panel"] button:last-child');
    confirm.click();
    await flushPromises();
    expect(createDeployment.mock.calls[0][0].config.runtime).toMatchObject({ core: 'xray', tier: 'auto', channel: 'stable', agentPollIntervalSeconds: 120, controlCommand: 'proxy-menu' });
    expect(createDeployment.mock.calls[0][0].config.inbounds[0].name).toBe('新加坡-HY2');
    expect(wrapper.find('[data-testid="deployment-command-panel"] textarea').element.value).toBe('wget short');
    await wrapper.findAll('[data-testid="deployment-command-panel"] button').find(button => button.text() === '显示排障命令').trigger('click');
    expect(wrapper.find('[data-testid="deployment-command-panel"] textarea').element.value).toBe('wget diagnostic');
  });

  it('scrolls to the one-time deployment command when it is outside the viewport', async () => {
    createDeployment.mockResolvedValue({ data: { deployment: { id: 'deploy-scroll' }, command: 'curl command', wgetCommand: 'wget command', expiresAt: '' } });
    wrapper = mountView();
    await flushPromises();
    const panel = wrapper.get('[data-testid="deployment-command-panel"]').element;
    const scrollIntoView = vi.fn();
    panel.getBoundingClientRect = vi.fn(() => ({ top: 900, bottom: 1200 }));
    panel.scrollIntoView = scrollIntoView;

    await wrapper.find('input[placeholder="HK Edge"]').setValue('Scroll VPS');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' });
  });

  it('does not scroll after command generation when the command panel is fully visible', async () => {
    createDeployment.mockResolvedValue({ data: { deployment: { id: 'deploy-visible' }, command: 'curl command', wgetCommand: 'wget command', expiresAt: '' } });
    wrapper = mountView();
    await flushPromises();
    const panel = wrapper.get('[data-testid="deployment-command-panel"]').element;
    const scrollIntoView = vi.fn();
    panel.getBoundingClientRect = vi.fn(() => ({ top: 100, bottom: 500 }));
    panel.scrollIntoView = scrollIntoView;

    await wrapper.find('input[placeholder="HK Edge"]').setValue('Visible VPS');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('uses live global values without saving and keeps inbound overrides sparse', async () => {
    const dataStore = useDataStore();
    dataStore.profiles = [{ id: 'profile-live', name: '实时配置' }];
    createDeployment.mockResolvedValue({ data: { deployment: { id: 'deploy-live' }, command: 'curl command', wgetCommand: 'wget command', expiresAt: '' } });
    wrapper = mountView();
    await flushPromises();

    await wrapper.find('input[placeholder="HK Edge"]').setValue('Live Global');
    await wrapper.get('[data-testid="global-runtime-core"]').setValue('xray');
    await wrapper.get('[data-testid="global-uuid"]').setValue('123e4567-e89b-42d3-a456-426614174000');
    await wrapper.get('[data-testid="global-certificate-mode"]').setValue('existing');
    await wrapper.get('[data-testid="global-random-port-min"]').setValue(20000);
    await wrapper.get('[data-testid="global-random-port-max"]').setValue(30000);
    await wrapper.get('[data-testid="global-node-group"]').setValue('Live Nodes');
    await wrapper.get('[data-testid="global-profile"]').setValue('profile-live');
    await wrapper.get('[data-testid="global-shared-transport"]').setValue('ws');

    const inboundTransport = wrapper.get('[data-testid="inbound-transport-0"]');
    expect(inboundTransport.text()).toContain('ws');
    await inboundTransport.setValue('grpc');

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();

    expect(saveDeploymentDefaults).not.toHaveBeenCalled();
    const payload = createDeployment.mock.calls[0][0];
    expect(payload).toMatchObject({ nodeGroup: 'Live Nodes', profileId: 'profile-live' });
    expect(payload.config.runtime).toMatchObject({ core: 'xray', tier: 'auto', channel: 'stable' });
    expect(payload.config.defaults).toMatchObject({
      credentials: { uuid: '123e4567-e89b-42d3-a456-426614174000' },
      randomPorts: { min: 20000, max: 30000 },
      deployment: { nodeGroup: 'Live Nodes', profileId: 'profile-live' },
      runtime: { core: 'xray' },
      certificate: { mode: 'existing' },
      protocolDefaults: { vless: { transport: 'ws' } }
    });
    expect(payload.config.inbounds[0].transport).toBe('grpc');
  });

  it('supports independent passwords, contextual hints, and visibility toggles', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('更多设置')).trigger('click');

    const sharedToggle = wrapper.get('[data-testid="shared-password-enabled"]');
    const globalPassword = wrapper.get('[data-testid="global-password"]');
    expect(sharedToggle.element.checked).toBe(true);
    expect(globalPassword.attributes('type')).toBe('password');
    expect(globalPassword.attributes('placeholder')).toBe('留空自动生成并共享');
    await wrapper.get('[data-testid="generate-global-password"]').trigger('click');
    expect(globalPassword.element.value).toMatch(/^[A-Za-z0-9_-]{24}$/);
    await wrapper.get('[data-testid="toggle-global-password"]').trigger('click');
    expect(globalPassword.attributes('type')).toBe('text');
    expect(wrapper.get('[data-testid="toggle-global-password"]').attributes('aria-label')).toBe('隐藏密码');

    await sharedToggle.setValue(false);
    expect(globalPassword.attributes('disabled')).toBeDefined();
    expect(globalPassword.attributes('placeholder')).toBe('每个密码入站独立生成');

    await wrapper.get('[data-testid="inbound-protocol"]').setValue('trojan');
    const more = wrapper.findAll('button').find(button => button.text().includes('更多') && !button.text().includes('设置'));
    await more.trigger('click');
    const inboundPassword = wrapper.get('[data-testid="inbound-password"]');
    expect(inboundPassword.attributes('type')).toBe('password');
    expect(inboundPassword.attributes('placeholder')).toBe('留空为当前入站独立生成密码');
    await wrapper.get('[data-testid="generate-inbound-password"]').trigger('click');
    expect(inboundPassword.element.value).toMatch(/^[A-Za-z0-9_-]{24}$/);
    await wrapper.get('[data-testid="toggle-inbound-password"]').trigger('click');
    expect(inboundPassword.attributes('type')).toBe('text');
    expect(wrapper.get('[data-testid="toggle-inbound-password"]').attributes('aria-label')).toBe('隐藏密码');
  });

  it('opens dependent settings for certificate, transport, and WARP selections', async () => {
    wrapper = mountView();
    await flushPromises();

    await wrapper.get('[data-testid="global-certificate-mode"]').setValue('existing');
    expect(wrapper.text()).toContain('证书路径');

    await wrapper.get('[data-testid="inbound-protocol"]').setValue('vmess');
    await wrapper.get('[data-testid="inbound-transport-0"]').setValue('ws');
    expect(wrapper.get('[data-testid="inbound-advanced-0"]').text()).toContain('路径');

    await wrapper.findAll('button').find(button => button.text().includes('更多设置')).trigger('click');
    expect(wrapper.text()).not.toContain('WARP 私钥');
    await wrapper.get('[data-testid="inbound-outbound-0"]').setValue('warp-auto');
    await flushPromises();
    expect(wrapper.get('[data-testid="warp-settings"]').text()).toContain('服务器自动注册');
    expect(wrapper.get('[data-testid="warp-settings"]').text()).not.toContain('WARP 私钥');
    await wrapper.get('[data-testid="warp-settings"] input[value="manual"]').setValue();
    expect(wrapper.get('[data-testid="warp-settings"]').text()).toContain('WARP 私钥');

    const protocol = wrapper.get('[data-testid="inbound-protocol"]');
    await protocol.setValue('hysteria2');
    expect(wrapper.get('[data-testid="inbound-transport-0"]').text()).toContain('Hysteria2 / QUIC');
  });

  it('renders protocol-native transports as read-only values and filters shared settings', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('更多设置')).trigger('click');
    await wrapper.get('[data-testid="global-shared-transport"]').setValue('ws');
    expect(wrapper.get('[data-testid="shared-transport-scope"]').text()).toContain('VLESS');
    expect(wrapper.get('[data-testid="shared-transport-scope"]').text()).toContain('VMess');
    expect(wrapper.get('[data-testid="shared-transport-scope"]').text()).not.toContain('TUIC');

    const protocol = wrapper.get('[data-testid="inbound-protocol"]');
    for (const [value, label, tls] of [
      ['hysteria2', 'Hysteria2 / QUIC', 'tls'], ['tuic', 'TUIC / QUIC', 'tls'], ['anytls', 'AnyTLS / TCP', 'tls'],
      ['shadowsocks', 'TCP + UDP', 'none'], ['socks5', 'TCP + UDP', 'none']
    ]) {
      await protocol.setValue(value);
      const transport = wrapper.get('[data-testid="inbound-transport-0"]');
      expect(transport.element.tagName).toBe('OUTPUT');
      expect(transport.text()).toContain(label);
      const more = wrapper.findAll('button').find(button => button.text().includes('更多') && !button.text().includes('设置'));
      if (!wrapper.find('[data-testid="inbound-advanced-0"]').exists()) await more.trigger('click');
      expect(wrapper.get('[data-testid="inbound-tls-mode-0"]').element.tagName).toBe('OUTPUT');
      expect(wrapper.get('[data-testid="inbound-tls-mode-0"]').text()).toBe(tls);
    }
  });

  it('keeps self-signed TLS server names aligned when adding TUIC', async () => {
    wrapper = mountView();
    await flushPromises();

    await wrapper.get('[data-testid="inbound-protocol"]').setValue('trojan');
    await wrapper.get('[data-testid="inbound-more-0"]').trigger('click');
    await wrapper.get('#inbound-server-name-0').setValue('www.cloudflare.com');
    await wrapper.get('[data-testid="add-inbound"]').trigger('click');
    const protocols = wrapper.findAll('[data-testid="inbound-protocol"]');
    await protocols[1].setValue('tuic');
    await wrapper.get('[data-testid="inbound-more-1"]').trigger('click');

    expect(wrapper.get('#inbound-server-name-0').element.value).toBe('www.cloudflare.com');
    expect(wrapper.get('#inbound-server-name-1').element.value).toBe('www.cloudflare.com');
  });

  it('does not force TLS server names to match with a managed certificate', async () => {
    wrapper = mountView();
    await flushPromises();

    await wrapper.get('[data-testid="global-certificate-mode"]').setValue('existing');
    await wrapper.get('[data-testid="inbound-protocol"]').setValue('trojan');
    await wrapper.get('[data-testid="inbound-more-0"]').trigger('click');
    await wrapper.get('#inbound-server-name-0').setValue('www.cloudflare.com');
    await wrapper.get('[data-testid="add-inbound"]').trigger('click');
    const protocols = wrapper.findAll('[data-testid="inbound-protocol"]');
    await protocols[1].setValue('tuic');
    await wrapper.get('[data-testid="inbound-more-1"]').trigger('click');

    expect(wrapper.get('#inbound-server-name-0').element.value).toBe('www.cloudflare.com');
    expect(wrapper.get('#inbound-server-name-1').element.value).toBe('');
    expect(wrapper.get('#inbound-server-name-1').attributes('placeholder')).toBe('bing.com');
  });

  it('edits transport Host independently from TLS SNI', async () => {
    createDeployment.mockResolvedValue({ data: { deployment: { id: 'deploy-host' }, command: 'curl command', wgetCommand: 'wget command', expiresAt: '' } });
    wrapper = mountView();
    await flushPromises();
    await wrapper.find('input[placeholder="HK Edge"]').setValue('Host Split');
    await wrapper.get('[data-testid="inbound-protocol"]').setValue('vmess');
    await flushPromises();
    await wrapper.get('[data-testid="inbound-transport-0"]').setValue('ws');
    await flushPromises();
    await wrapper.get('[data-testid="inbound-tls-mode-0"]').setValue('tls');
    await wrapper.get('#inbound-server-name-0').setValue('tls.example.invalid');
    await wrapper.get('[data-testid="inbound-host-0"]').setValue('transport.example.invalid');
    await wrapper.get('#inbound-server-name-0').setValue('changed.example.invalid');
    expect(wrapper.get('[data-testid="inbound-host-0"]').element.value).toBe('transport.example.invalid');

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();
    expect(createDeployment.mock.calls[0][0].config.inbounds[0]).toMatchObject({
      tls: { serverName: 'changed.example.invalid' },
      transportOptions: { host: 'transport.example.invalid' }
    });
  });

  it('removes Reality when VLESS switches to WebSocket', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.get('[data-testid="inbound-transport-0"]').setValue('ws');
    const more = wrapper.findAll('button').find(button => button.text().includes('更多') && !button.text().includes('设置'));
    if (!wrapper.find('[data-testid="inbound-advanced-0"]').exists()) await more.trigger('click');
    const tls = wrapper.get('[data-testid="inbound-tls-mode-0"]');
    expect(tls.element.value).toBe('');
    expect(tls.find('option[value="reality"]').exists()).toBe(false);
    expect(tls.text()).toContain('继承（none）');
  });

  it('configures per-inbound CDN modes, preferred endpoints, Quick Tunnel, and automatic WARP consent', async () => {
    wrapper = mountView();
    await flushPromises();
    const edgeCard = wrapper.get('[data-testid="edge-warp-settings"]');
    expect(edgeCard.text()).toContain('CDN、Argo 与 WARP');
    const edgeEntryMode = wrapper.get('[data-testid="edge-mode"]');
    expect(edgeEntryMode.element.value).toBe('disabled');
    expect([...edgeEntryMode.element.options].map(option => option.textContent)).toEqual([
      '已禁用', 'CF 橙云域名', '临时隧道', '固定隧道'
    ]);

    await wrapper.get('[data-testid="inbound-protocol"]').setValue('vmess');
    await wrapper.get('[data-testid="inbound-transport-0"]').setValue('ws');
    await wrapper.get('[data-testid="inbound-port"]').setValue('8443');
    await wrapper.get('[data-testid="edge-mode"]').setValue('manual');
    await wrapper.get('[data-testid="inbound-tls-mode-0"]').setValue('tls');
    await wrapper.get('[data-testid="edge-hostname"]').setValue('edge.example.com');
    await wrapper.get('[data-testid="add-edge-endpoint"]').trigger('click');
    await edgeCard.get('input[placeholder="198.51.100.10"]').setValue('203.0.113.8');
    const edgeMode = wrapper.get('[data-testid="inbound-edge-mode-0"]');
    expect(edgeMode.attributes('disabled')).toBeUndefined();
    await edgeMode.setValue('append');
    expect(edgeMode.element.value).toBe('append');

    await wrapper.get('[data-testid="inbound-transport-0"]').setValue('grpc');
    expect(wrapper.get('[data-testid="inbound-advanced-0"]').text()).toContain('实验功能');
    await wrapper.get('[data-testid="inbound-transport-0"]').setValue('ws');

    await wrapper.get('[data-testid="edge-mode"]').setValue('quick');
    expect(wrapper.get('[data-testid="tunnel-memory-recommendation"]').text()).toContain('cgroup 内存上限大于或等于 128 MB');
    expect(wrapper.get('[data-testid="vps-push-enabled"]').element.checked).toBe(true);
    expect(wrapper.get('[data-testid="quick-inbound"]').element.value).toBeTruthy();
    expect(edgeMode.element.value).toBe('only');
    expect(edgeMode.attributes('disabled')).toBeDefined();
    const edgeHelp = wrapper.get('[data-testid="inbound-edge-mode-help-0"]');
    const edgeTooltip = document.getElementById(edgeHelp.attributes('aria-controls'));
    expect(edgeTooltip.textContent).toContain('临时隧道（Quick Tunnel）由上方入站选择统一管理，不能在此单独修改。');
    expect(edgeMode.element.parentElement.textContent).not.toContain('临时隧道（Quick Tunnel）由上方入站选择统一管理');

    await wrapper.get('[data-testid="inbound-outbound-0"]').setValue('warp-auto');
    expect(wrapper.get('[data-testid="warp-accept-terms"]').element.checked).toBe(false);
    await wrapper.get('[data-testid="warp-accept-terms"]').setValue(true);
    expect(wrapper.get('[data-testid="warp-accept-terms"]').element.checked).toBe(true);
    await wrapper.get('[data-testid="edge-mode"]').setValue('manual');
    expect(wrapper.find('[data-testid="tunnel-memory-recommendation"]').exists()).toBe(false);
  });

  it('opens a compact preset menu and imports preferred hostnames selectively', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.get('[data-testid="edge-mode"]').setValue('manual');

    expect(wrapper.get('[data-testid="add-edge-endpoint"]').text()).toBe('新增优选');
    expect(wrapper.get('[data-testid="probe-edge-hostname"]').element.parentElement.textContent).toContain('未添加优选地址时直接使用入口域名，如需添加请点击“新增优选”或“预设优选”按钮按需添加。');
    expect(wrapper.get('[data-testid="preferred-domain-preset-trigger"]').text()).toBe('预设优选');
    await wrapper.get('[data-testid="preferred-domain-preset-trigger"]').trigger('click');
    let presetMenu = wrapper.get('[data-testid="preferred-domain-preset-menu"]');
    expect(presetMenu.text()).toContain('MOD社区优选');
    expect(presetMenu.text()).toContain('staticdelivery.nexusmods.com');
    expect(presetMenu.findAll('button')[3].findAll('span').map(item => item.text())).toEqual(['MOD社区优选', 'staticdelivery.nexusmods.com']);
    document.body.click();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="preferred-domain-preset-menu"]').exists()).toBe(false);
    await wrapper.get('[data-testid="preferred-domain-preset-trigger"]').trigger('click');
    presetMenu = wrapper.get('[data-testid="preferred-domain-preset-menu"]');
    await presetMenu.findAll('button')[0].trigger('click');
    await flushPromises();
    let addresses = wrapper.findAll('[data-testid^="edge-endpoint-address-"]').map(input => input.element.value);
    expect(addresses).toEqual(['www.visa.cn']);
    expect(wrapper.findAll('[data-testid^="edge-endpoint-label-"]').map(input => input.element.value)).toEqual(['visa中国优选']);
    expect(wrapper.find('[data-testid="preferred-domain-preset-menu"]').exists()).toBe(false);

    await wrapper.get('[data-testid="preferred-domain-preset-trigger"]').trigger('click');
    presetMenu = wrapper.get('[data-testid="preferred-domain-preset-menu"]');
    await presetMenu.findAll('button')[3].trigger('click');
    await flushPromises();
    addresses = wrapper.findAll('[data-testid^="edge-endpoint-address-"]').map(input => input.element.value);
    expect(addresses).toEqual(['www.visa.cn', 'staticdelivery.nexusmods.com']);
    expect(wrapper.findAll('[data-testid^="edge-endpoint-label-"]').map(input => input.element.value)).toEqual(['visa中国优选', 'MOD社区优选']);

    expect(wrapper.find('[data-testid="preferred-domain-preset-menu"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid^="import-preferred-ct"]').exists()).toBe(false);
  });

  it('offers manual configuration or an automatic VLESS/VMess inbound when Quick Tunnel has no candidate', async () => {
    wrapper = mountView();
    await flushPromises();

    await wrapper.get('[data-testid="edge-mode"]').setValue('quick');
    const dialog = document.querySelector('[data-testid="quick-inbound-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('临时隧道（Quick Tunnel）只能使用非 Reality 的 WebSocket 入站');
    expect(wrapper.get('[data-testid="quick-inbound"]').element.value).toBe('');

    dialog.querySelector('input[value="vmess"]').click();
    dialog.querySelector('[data-testid="quick-auto-add"]').click();
    await flushPromises();

    const protocols = wrapper.findAll('[data-testid="inbound-protocol"]');
    expect(protocols).toHaveLength(2);
    expect(protocols[1].element.value).toBe('vmess');
    expect(wrapper.findAll('select[data-testid^="inbound-transport-"]')[1].element.value).toBe('ws');
    expect(wrapper.get('[data-testid="inbound-tls-mode-1"]').element.value).toBe('none');
    expect(wrapper.get('[data-testid="inbound-edge-mode-1"]').element.value).toBe('only');
    expect(wrapper.get('[data-testid="quick-inbound"]').element.value).toBeTruthy();
    expect(wrapper.get('[data-testid="vps-push-enabled"]').element.checked).toBe(true);

    await protocols[1].setValue('vless');
    await wrapper.get('[data-testid="inbound-tls-mode-1"]').setValue('reality');
    await flushPromises();
    expect(wrapper.get('[data-testid="quick-inbound"]').element.value).toBe('');
    expect(wrapper.get('[data-testid="inbound-edge-mode-1"]').element.value).toBe('direct');
  });

  it('cancels or focuses a configurable inbound from the Quick Tunnel requirement dialog', async () => {
    wrapper = mountView();
    await flushPromises();

    await wrapper.get('[data-testid="edge-mode"]').setValue('quick');
    document.querySelector('[data-testid="quick-inbound-dialog"] button').click();
    await flushPromises();
    expect(wrapper.get('[data-testid="edge-mode"]').element.value).toBe('disabled');

    await wrapper.get('[data-testid="edge-mode"]').setValue('quick');
    document.querySelector('[data-testid="quick-go-configure"]').click();
    await flushPromises();
    expect(document.activeElement.id).toBe('inbound-transport-0');
    expect(wrapper.get('[data-testid="inbound-advanced-0"]').exists()).toBe(true);
  });

  it('disables automatic Quick Tunnel creation at the inbound limit', async () => {
    wrapper = mountView();
    await flushPromises();
    for (let index = 1; index < 20; index += 1) await wrapper.get('[data-testid="add-inbound"]').trigger('click');

    await wrapper.get('[data-testid="edge-mode"]').setValue('quick');
    const dialog = document.querySelector('[data-testid="quick-inbound-dialog"]');
    expect(dialog.textContent).toContain('已达到 20 个入站上限');
    expect(dialog.querySelector('[data-testid="quick-auto-add"]').disabled).toBe(true);
  });

  it('keeps direct CDN mode available and explains each missing prerequisite', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('更多') && !button.text().includes('设置')).trigger('click');

    const edgeMode = wrapper.get('[data-testid="inbound-edge-mode-0"]');
    expect(edgeMode.attributes('disabled')).toBeUndefined();
    expect(edgeMode.get('option[value="direct"]').attributes('disabled')).toBeUndefined();
    expect(edgeMode.get('option[value="append"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="inbound-advanced-0"]').text()).toContain('请先启用边缘入口');
    await wrapper.get('[data-testid="inbound-edge-fix-0"]').trigger('click');
    expect(document.activeElement.id).toBe('edge-mode');

    await wrapper.get('[data-testid="edge-mode"]').setValue('manual');
    expect(wrapper.get('[data-testid="inbound-advanced-0"]').text()).toContain('请选择 WebSocket、gRPC 或 XHTTP');
    await wrapper.get('[data-testid="inbound-transport-0"]').setValue('ws');
    expect(wrapper.get('[data-testid="inbound-tls-mode-0"]').find('option[value="reality"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="inbound-advanced-0"]').text()).toContain('要求源站启用 TLS');
    await wrapper.get('[data-testid="inbound-tls-mode-0"]').setValue('none');
    expect(wrapper.get('[data-testid="inbound-advanced-0"]').text()).toContain('要求源站启用 TLS');
    await wrapper.get('[data-testid="inbound-tls-mode-0"]').setValue('tls');
    expect(wrapper.get('[data-testid="inbound-advanced-0"]').text()).toContain('Cloudflare HTTPS 代理端口');
    await wrapper.get('[data-testid="inbound-port"]').setValue('8443');
    expect(edgeMode.get('option[value="append"]').attributes('disabled')).toBeUndefined();
    await edgeMode.setValue('append');
    expect(edgeMode.element.value).toBe('append');
  });

  it('keeps server subscription and traffic controls dependent and accepts an optional quota', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('更多设置')).trigger('click');
    const subscription = wrapper.get('[data-testid="vps-subscription-enabled"]');
    const traffic = wrapper.get('[data-testid="vps-traffic-enabled"]');
    expect(subscription.element.checked).toBe(true);
    expect(traffic.element.checked).toBe(true);
    expect(traffic.attributes('disabled')).toBeUndefined();
    const settings = wrapper.get('[data-testid="vps-subscription-settings"]');
    expect(settings.text()).toContain('服务器订阅与流量');
    expect(settings.text()).toContain('套餐额度');
    expect(settings.text()).toContain('不重复计算代理核心访问目标网站的流量');
    expect(wrapper.get('[data-testid="vps-push-enabled"]').element.checked).toBe(true);
    expect(wrapper.get('[data-testid="vps-push-interval"]').element.value).toBe('15');
    await subscription.setValue(false);
    expect(traffic.element.checked).toBe(true);
    expect(traffic.attributes('disabled')).toBeDefined();
  });

  it('allows 20 compact inbounds and opens a non-persistent risk dialog before generation', async () => {
    wrapper = mountView();
    await flushPromises();
    const add = () => wrapper.findAll('button').find(button => button.text() === '新增');
    for (let index = 1; index < 20; index++) await add().trigger('click');
    expect(wrapper.findAll('select').filter(select => select.element.closest('article')).length).toBe(60);
    expect(add().attributes('disabled')).toBeDefined();

    await wrapper.find('input[placeholder="HK Edge"]').setValue('Tiny VPS');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(document.body.textContent).toContain('确认生成部署命令');
    expect(document.body.textContent).toContain('自签证书');
  });

  it('renders the deployment generator in English and preserves incompatible inbounds', async () => {
    wrapper = mountView('en-US');
    await flushPromises();
    expect(wrapper.text()).toContain('Proxy Deployments');
    expect(wrapper.text()).toContain('Generate Install Command');
    expect(wrapper.text()).toContain('One-time Deployment Command');
    expect(wrapper.text()).toContain('Resources and Agent');
    expect(wrapper.text()).toContain('Protocol Global Configuration');
    expect(wrapper.text()).not.toMatch(/[\u4e00-\u9fff]/);

    await wrapper.get('[data-testid="global-runtime-core"]').setValue('xray');
    const protocol = wrapper.find('article select');
    await protocol.setValue('tuic');
    expect(protocol.element.value).toBe('tuic');
    expect(wrapper.text()).toContain('The xray core does not support TUIC v5');
  });

  it('loads an existing deployment for update, reuses it safely, and exposes uninstall mode', async () => {
    const deployment = {
      id: 'deploy-template', name: 'Singapore Edge', schemaVersion: 2, configRevision: 4, status: 'succeeded',
      nodeGroup: 'Singapore', profileId: 'profile-template', configSummary: { runtime: { core: 'xray' }, protocols: [{ protocol: 'vless', port: 443 }] }
    };
    const template = {
      deployment, configRevision: 4, retainedSecrets: true,
      config: {
        schemaVersion: 2,
        runtime: { tier: 'auto', core: 'xray', channel: 'stable', controlCommand: 'tsub' },
        certificate: { mode: 'self-signed', apiToken: '********' },
        warp: { provisioning: 'manual', privateKey: '********', peerPublicKey: 'warp-peer', ipv4: '172.16.0.2/32', ipv6: '2606:4700:110:8::2/128' },
        edge: {
          mode: 'disabled', hostname: 'old-edge.example.com', endpoints: [{ id: 'edge-1', label: 'Preferred', address: '198.51.100.8', port: null }],
          cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), apiToken: '********' },
          managed: { tunnelId: '********', dnsRecordId: '********', tunnelToken: '********', managedByTsub: true }
        },
        firewall: { enabled: true }, tunnels: [],
        subscription: { hostname: 'node.example.com', namePrefix: 'TSub', addressMode: 'auto', server: { enabled: true, port: 51250, token: '********', pushEnabled: true, pushIntervalMinutes: 15, pushAddressMode: 'auto', traffic: { enabled: true, quotaBytes: 0 } } },
        inbounds: [{ id: 'vless-main', name: 'Singapore-VLESS', protocol: 'vless', port: 443, transport: 'tcp', outbound: 'direct', credentials: { uuid: '********' }, tls: { mode: 'reality', serverName: 'www.example.com', realityPrivateKey: '********', realityPublicKey: 'public-key', shortId: 'a1b2c3d4' }, transportOptions: { path: '/', serviceName: 'tsub' } }]
      }
    };
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    getDeploymentTemplate.mockResolvedValue({ success: true, data: template });
    createDeploymentCommand.mockResolvedValue({ data: { command: 'update command', wgetCommand: 'update wget', expiresAt: '' } });
    createDeployment.mockResolvedValue({ data: { deployment: { id: 'deploy-clone' }, command: 'install command', wgetCommand: 'install wget', expiresAt: '' } });
    useDataStore().profiles = [{ id: 'profile-template', name: 'Template Profile' }];
    wrapper = mountView();
    await flushPromises();

    await wrapper.get('[data-testid="control-command-input"]').setValue('edge-menu');
    await wrapper.get('[data-testid="global-runtime-core"]').setValue('sing-box');
    await wrapper.get('[data-testid="inbound-protocol"]').setValue('trojan');
    await wrapper.get('[data-testid="inbound-node-name"]').setValue('Current-Trojan');

    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '更新配置').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('选择更新方式');
    expect(document.body.textContent).toContain('重新配置');
    expect(document.body.textContent).toContain('载入配置');
    expect(Array.from(document.querySelector('[data-testid="load-config-dialog"]').querySelectorAll('button')).map(button => button.textContent)).toEqual(['取消', '直接生成命令', '重新配置', '载入配置']);
    Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === '取消').click();
    await flushPromises();
    expect(wrapper.text()).toContain('Singapore Edge');
    expect(getDeploymentTemplate).not.toHaveBeenCalled();

    await wrapper.findAll('button').find(button => button.text() === '更新配置').trigger('click');
    document.querySelector('[data-testid="direct-deployment-command"]').click();
    await flushPromises();
    expect(createDeploymentCommand).toHaveBeenCalledWith('deploy-template', 'update', { outputLanguage: 'zh-CN' });
    expect(wrapper.find('[data-testid="deployment-basic-settings"]').exists()).toBe(false);
    expect(document.querySelector('[data-testid="deployment-operation-command-dialog"] textarea').value).toBe('update wget');
    expect(document.querySelector('[data-testid="load-config-dialog"]')).toBeNull();
    document.querySelector('[data-testid="deployment-operation-command-dialog"] button').click();
    await flushPromises();

    await wrapper.findAll('button').find(button => button.text() === '更新配置').trigger('click');
    Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === '重新配置').click();
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-mode-update"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="target-deployment-select"]').element.value).toBe('deploy-template');
    expect(wrapper.find('input[placeholder="HK Edge"]').element.value).toBe('Singapore Edge');
    expect(wrapper.get('[data-testid="control-command-input"]').element.value).toBe('edge-menu');
    expect(wrapper.get('[data-testid="global-runtime-core"]').element.value).toBe('sing-box');
    expect(wrapper.get('[data-testid="inbound-protocol"]').element.value).toBe('trojan');
    expect(wrapper.get('[data-testid="inbound-node-name"]').element.value).toBe('Current-Trojan');
    expect(getDeploymentTemplate).not.toHaveBeenCalled();

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();
    expect(createDeploymentCommand).toHaveBeenLastCalledWith('deploy-template', 'update', expect.objectContaining({
      configRevision: 4,
      name: 'Singapore Edge',
      config: expect.objectContaining({ runtime: expect.objectContaining({ core: 'sing-box' }), inbounds: [expect.objectContaining({ protocol: 'trojan', name: 'Current-Trojan' })] })
    }));

    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '更新配置').trigger('click');
    Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === '载入配置').click();
    await flushPromises();
    expect(getDeploymentTemplate).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="deployment-mode-update"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="target-deployment-select"]').element.value).toBe('deploy-template');
    expect(wrapper.find('input[placeholder="HK Edge"]').element.value).toBe('Singapore Edge');
    expect(wrapper.get('[data-testid="global-node-group"]').element.value).toBe('Singapore');
    expect(wrapper.get('[data-testid="global-profile"]').element.value).toBe('profile-template');
    await wrapper.findAll('button').find(button => button.text().includes('更多') && !button.text().includes('设置')).trigger('click');
    expect(wrapper.get('[data-testid="inbound-uuid"]').element.value).toBe('');
    expect(wrapper.get('[data-testid="inbound-uuid"]').attributes('placeholder')).toBe('留空沿用原部署值');
    expect(wrapper.get('[data-testid="deployment-submit"]').text()).toBe('保存配置并生成更新命令');

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();
    expect(createDeploymentCommand).toHaveBeenLastCalledWith('deploy-template', 'update', expect.objectContaining({ configRevision: 4, name: 'Singapore Edge' }));

    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '复用配置').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-mode-install"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="reuse-config-notice"]').text()).toContain('创建一条全新部署记录');
    expect(wrapper.find('input[placeholder="HK Edge"]').element.value).toBe('');
    expect(wrapper.get('[data-testid="global-node-group"]').element.value).toBe('');
    expect(wrapper.get('[data-testid="global-profile"]').element.value).toBe('');
    expect(wrapper.get('[data-testid="inbound-node-name"]').element.value).toBe('');
    expect(wrapper.find('[data-testid="edge-hostname"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="warp-settings"]').text()).not.toContain('warp-peer');

    await wrapper.find('input[placeholder="HK Edge"]').setValue('Tokyo Edge');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();
    expect(createDeployment).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Tokyo Edge',
      nodeGroup: '',
      profileId: '',
      cloneFromDeploymentId: 'deploy-template',
      resetInheritedNodeNames: true,
      config: expect.objectContaining({
        inbounds: [expect.objectContaining({ name: '' })],
        edge: expect.objectContaining({ hostname: '', endpoints: [{ id: 'edge-1', label: 'Preferred', address: '198.51.100.8', port: null }], cloudflare: expect.objectContaining({ accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32) }) }),
        warp: expect.objectContaining({ provisioning: 'manual', privateKey: '', peerPublicKey: '', ipv4: '', ipv6: '' })
      })
    }));

    await wrapper.get('[data-testid="deployment-mode-uninstall"]').trigger('click');
    await wrapper.get('[data-testid="target-deployment-select"]').setValue('deploy-template');
    await flushPromises();
    expect(wrapper.get('[data-testid="uninstall-target-summary"]').text()).toContain('Singapore Edge');
    expect(wrapper.find('[data-testid="deployment-basic-settings"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="deployment-submit"]').text()).toBe('生成卸载命令');
  });

  it('replaces update configuration with reinstall for an offline deployment', async () => {
    const deployment = {
      id: 'deploy-offline', name: 'Offline VPS', schemaVersion: 2, configRevision: 7, status: 'offline', subscriptionSourceDisabled: true,
      reinstallable: true,
      nodeGroup: 'Japan', profileId: '', configSummary: { runtime: { core: 'sing-box' }, protocols: [{ protocol: 'vless', port: 51231 }] }
    };
    const template = {
      deployment, configRevision: 7, retainedSecrets: true,
      config: {
        schemaVersion: 2,
        runtime: { tier: 'auto', core: 'sing-box', channel: 'stable', controlCommand: 'tsub' },
        certificate: { mode: 'self-signed' }, firewall: { enabled: true }, warp: { provisioning: 'auto' }, edge: { mode: 'disabled', hostname: '', endpoints: [], cloudflare: {}, managed: {} }, tunnels: [],
        subscription: { hostname: '203.0.113.7', namePrefix: 'TSub', addressMode: 'auto', server: { enabled: true, port: 51238, token: '********', pushEnabled: true, pushIntervalMinutes: 15, pushAddressMode: 'auto', traffic: { enabled: true, quotaBytes: 0 } } },
        inbounds: [{ id: 'vless-main', name: 'Offline-VLESS', protocol: 'vless', port: 51231, transport: 'ws', outbound: 'direct', edgeMode: 'direct', credentials: { uuid: '********' }, tls: { mode: 'none', serverName: '' }, transportOptions: { path: '/', serviceName: '' } }]
      }
    };
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    getDeploymentTemplate.mockResolvedValue({ success: true, data: template });
    createDeploymentCommand.mockResolvedValue({ data: { command: 'reinstall command', wgetCommand: 'reinstall wget', expiresAt: '' } });
    wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    const offlineUpdateButton = wrapper.get('[data-testid="deployment-update-config"]');
    expect(offlineUpdateButton.attributes()).toHaveProperty('disabled');
    const reinstallButton = wrapper.get('[data-testid="deployment-reinstall-config"]');
    expect(reinstallButton.text()).toBe('重新安装');
    expect(reinstallButton.attributes('disabled')).toBeUndefined();
    await reinstallButton.trigger('click');
    await flushPromises();
    document.querySelector('[data-testid="direct-deployment-command"]').click();
    await flushPromises();
    expect(createDeploymentCommand).toHaveBeenCalledWith('deploy-offline', 'reinstall', { outputLanguage: 'zh-CN' });
    expect(wrapper.find('[data-testid="deployment-basic-settings"]').exists()).toBe(false);
    expect(document.querySelector('[data-testid="deployment-operation-command-dialog"] textarea').value).toBe('reinstall wget');
    expect(document.querySelector('[data-testid="load-config-dialog"]')).toBeNull();
    document.querySelector('[data-testid="deployment-operation-command-dialog"] button').click();
    await flushPromises();
    await reinstallButton.trigger('click');
    await flushPromises();
    Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === '载入配置').click();
    await flushPromises();

    expect(getDeploymentTemplate).toHaveBeenCalledWith('deploy-offline');
    expect(wrapper.get('[data-testid="deployment-mode-update"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="target-deployment-select"]').element.value).toBe('deploy-offline');
    expect(wrapper.get('[data-testid="deployment-submit"]').text()).toBe('保存配置并生成重新安装命令');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();
    expect(createDeploymentCommand).toHaveBeenCalledWith('deploy-offline', 'reinstall', expect.objectContaining({
      configRevision: 7, name: 'Offline VPS', config: expect.objectContaining({ inbounds: [expect.objectContaining({ protocol: 'vless', port: 51231 })] })
    }));
  });

  it('uses the backend reinstallable capability for failed and running records', async () => {
    const records = [
      { id: 'deploy-failed-install', name: 'Failed Install', schemaVersion: 2, status: 'failed', reinstallable: true, configSummary: {} },
      { id: 'deploy-running-install', name: 'Running Install', schemaVersion: 2, status: 'running', reinstallable: true, configSummary: {} },
      { id: 'deploy-failed-update', name: 'Failed Update', schemaVersion: 2, status: 'failed', reinstallable: false, deployedAt: '2026-08-05T01:00:00.000Z', configSummary: {} }
    ];
    listDeployments.mockResolvedValue({ success: true, data: records });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('[data-testid="deployment-reinstall-config"]')).toHaveLength(3);
    expect(wrapper.findAll('[data-testid="deployment-update-config"]')).toHaveLength(3);
  });

  it('silently refreshes pending and running deployment records until their callback finishes', async () => {
    vi.useFakeTimers();
    const running = { id: 'deploy-poll', name: 'Polling Install', schemaVersion: 2, status: 'running', reinstallable: true, configSummary: {} };
    const offline = { ...running, status: 'offline', pendingReason: 'reinstall', lastError: 'low memory', reinstallable: true };
    listDeployments
      .mockResolvedValueOnce({ success: true, data: [running] })
      .mockResolvedValueOnce({ success: true, data: [running] })
      .mockResolvedValue({ success: true, data: [offline] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('运行中');

    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(wrapper.text()).toContain('已离线');
  });

  it('silently refreshes heartbeat state every 30 seconds while deployment records are visible', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true, data: { mode: 'full', features: { remoteCommands: true, heartbeats: true } } }) });
    const deployment = { id: 'deploy-heartbeat', name: 'Heartbeat', schemaVersion: 2, status: 'succeeded', configSummary: {} };
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    const callsAfterOpen = listDeployments.mock.calls.length;

    await vi.advanceTimersByTimeAsync(25000);
    expect(listDeployments).toHaveBeenCalledTimes(callsAfterOpen);
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(listDeployments).toHaveBeenCalledTimes(callsAfterOpen + 1);
  });

  it('asks whether to delete the active-push subscription with the deployment record', async () => {
    const deployment = {
      id: 'deploy-delete', name: 'Delete Me', schemaVersion: 2, status: 'succeeded',
      configSummary: { subscriptionServer: { pushEnabled: true }, edge: { hasManagedResources: false } }
    };
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    deleteDeployment.mockResolvedValue({ success: true, data: { deleted: true } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(true);
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '删除记录').trigger('click');
    await flushPromises();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1][0]).toContain('同时删除');
    expect(deleteDeployment).toHaveBeenCalledWith('deploy-delete', { preserveCloudflareResources: false, deleteSubscriptionSource: true });
  });

  it('keeps the active-push subscription when the optional deletion prompt is declined', async () => {
    const deployment = {
      id: 'deploy-keep-source', name: 'Keep Source', schemaVersion: 2, status: 'succeeded',
      configSummary: { subscriptionServer: { pushEnabled: true }, edge: { hasManagedResources: false } }
    };
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    deleteDeployment.mockResolvedValue({ success: true, data: { deleted: true } });
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false);
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '删除记录').trigger('click');
    await flushPromises();

    expect(deleteDeployment).toHaveBeenCalledWith('deploy-keep-source', { preserveCloudflareResources: false, deleteSubscriptionSource: false });
  });

  it('refreshes to reinstall immediately after generating an uninstall command', async () => {
    const active = {
      id: 'deploy-uninstalling', name: 'Pending Uninstall', schemaVersion: 2, status: 'succeeded', reinstallable: false,
      configSummary: { runtime: { core: 'xray' }, protocols: [] }
    };
    listDeployments.mockResolvedValue({ success: true, data: [active] });
    createDeploymentCommand.mockResolvedValue({ data: { command: 'curl uninstall', wgetCommand: 'wget uninstall', expiresAt: '' } });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    listDeployments.mockResolvedValue({ success: true, data: [{ ...active, pendingReason: 'uninstall', reinstallable: true }] });

    await wrapper.findAll('button').find(button => button.text() === '卸载').trigger('click');
    document.querySelector('[data-testid="confirm-deployment-operation"]').click();
    await flushPromises();

    expect(createDeploymentCommand).toHaveBeenCalledWith('deploy-uninstalling', 'uninstall', { outputLanguage: 'zh-CN' });
    expect(wrapper.get('[data-testid="deployment-reinstall-config"]').text()).toBe('重新安装');
    expect(document.querySelector('[data-testid="deployment-operation-command-dialog"] textarea').value).toBe('wget uninstall');
    expect(wrapper.find('[data-testid="deployment-basic-settings"]').exists()).toBe(false);
  });

  it('opens read-only operation commands in a modal without leaving deployment records', async () => {
    const deployment = {
      id: 'deploy-operation', name: '独角鲸日本软银', schemaVersion: 2, status: 'succeeded',
      configSummary: { runtime: { core: 'xray' }, protocols: [{ protocol: 'vless', port: 51231 }] }
    };
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    createDeploymentCommand.mockResolvedValue({ data: { command: 'curl command', wgetCommand: 'wget command', diagnosticCommand: 'curl diagnostic', diagnosticWgetCommand: 'wget diagnostic', expiresAt: '2026-08-05T10:00:00.000Z' } });
    wrapper = mountView();
    await flushPromises();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    for (const [label, action] of [['获取状态', 'status'], ['同步节点', 'list'], ['诊断', 'doctor']]) {
      await wrapper.findAll('button').find(button => button.text() === label).trigger('click');
      await flushPromises();
      expect(document.querySelector('[data-testid="deployment-operation-confirm-dialog"]')).toBeNull();
      const commandDialog = document.querySelector('[data-testid="deployment-operation-command-dialog"]');
      expect(commandDialog).not.toBeNull();
      expect(commandDialog.textContent).toContain(`独角鲸日本软银 · ${label}命令`);
      expect(commandDialog.querySelector('textarea').value).toBe('wget command');
      expect(wrapper.find('[data-testid="deployment-basic-settings"]').exists()).toBe(false);
      expect(createDeploymentCommand).toHaveBeenLastCalledWith('deploy-operation', action, { outputLanguage: 'zh-CN' });
      Array.from(commandDialog.querySelectorAll('button')).find(button => button.textContent === 'curl').click();
      await flushPromises();
      expect(commandDialog.querySelector('textarea').value).toBe('curl command');
      Array.from(commandDialog.querySelectorAll('button')).find(button => button.textContent === '显示排障命令').click();
      await flushPromises();
      expect(commandDialog.querySelector('textarea').value).toBe('curl diagnostic');
      commandDialog.querySelector('[data-testid="copy-deployment-operation-command"]').click();
      await flushPromises();
      expect(writeText).toHaveBeenLastCalledWith('curl diagnostic');
      Array.from(commandDialog.querySelectorAll('button')).find(button => button.textContent === '关闭').click();
      await flushPromises();
      expect(document.querySelector('[data-testid="deployment-operation-command-dialog"]')).toBeNull();
    }
  });

  it('confirms mutating operations before opening their independent command modal', async () => {
    const deployment = {
      id: 'deploy-operation', name: '独角鲸日本软银', schemaVersion: 2, status: 'succeeded',
      configSummary: { runtime: { core: 'xray' }, protocols: [{ protocol: 'vless', port: 51231 }] }
    };
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    createDeploymentCommand.mockResolvedValue({ data: { command: 'curl operation', wgetCommand: 'wget operation', expiresAt: '' } });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();

    for (const [label, action] of [['更新核心', 'update'], ['重启', 'restart'], ['修复', 'repair'], ['回滚', 'rollback'], ['卸载', 'uninstall']]) {
      const callsBefore = createDeploymentCommand.mock.calls.length;
      await wrapper.findAll('button').find(button => button.text() === label).trigger('click');
      const confirmDialog = document.querySelector('[data-testid="deployment-operation-confirm-dialog"]');
      expect(confirmDialog).not.toBeNull();
      expect(confirmDialog.parentElement.className).toContain('fixed inset-0');
      expect(confirmDialog.textContent).toContain('独角鲸日本软银');
      expect(confirmDialog.textContent).toContain(label);
      if (action === 'uninstall') expect(confirmDialog.textContent).toContain('节点将被禁用');
      expect(createDeploymentCommand).toHaveBeenCalledTimes(callsBefore);

      if (action === 'update') {
        confirmDialog.querySelector('button').click();
        await flushPromises();
        expect(createDeploymentCommand).toHaveBeenCalledTimes(callsBefore);
        await wrapper.findAll('button').find(button => button.text() === label).trigger('click');
      }
      document.querySelector('[data-testid="confirm-deployment-operation"]').click();
      await flushPromises();
      expect(createDeploymentCommand).toHaveBeenLastCalledWith('deploy-operation', action, { outputLanguage: 'zh-CN' });
      expect(document.querySelector('[data-testid="deployment-operation-confirm-dialog"]')).toBeNull();
      expect(document.querySelector('[data-testid="deployment-operation-command-dialog"] textarea').value).toBe('wget operation');
      expect(wrapper.find('[data-testid="deployment-basic-settings"]').exists()).toBe(false);
      Array.from(document.querySelector('[data-testid="deployment-operation-command-dialog"]').querySelectorAll('button')).find(button => button.textContent === '关闭').click();
      await flushPromises();
    }
  });

  it('closes operation dialogs with Escape and does not show an empty modal on API failure', async () => {
    const deployment = {
      id: 'deploy-operation', name: 'Tokyo VPS', schemaVersion: 2, status: 'succeeded',
      configSummary: { runtime: { core: 'xray' }, protocols: [] }
    };
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();

    await wrapper.findAll('button').find(button => button.text() === '重启').trigger('click');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(document.querySelector('[data-testid="deployment-operation-confirm-dialog"]')).toBeNull();
    expect(createDeploymentCommand).not.toHaveBeenCalled();

    createDeploymentCommand.mockResolvedValueOnce({ data: { command: 'curl status', wgetCommand: 'wget status', expiresAt: '' } });
    await wrapper.findAll('button').find(button => button.text() === '获取状态').trigger('click');
    await flushPromises();
    const commandDialog = document.querySelector('[data-testid="deployment-operation-command-dialog"]');
    expect(commandDialog).not.toBeNull();
    commandDialog.parentElement.click();
    await flushPromises();
    expect(document.querySelector('[data-testid="deployment-operation-command-dialog"]')).toBeNull();

    createDeploymentCommand.mockResolvedValueOnce({ data: { command: 'curl status', wgetCommand: 'wget status', expiresAt: '' } });
    await wrapper.findAll('button').find(button => button.text() === '获取状态').trigger('click');
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(document.querySelector('[data-testid="deployment-operation-command-dialog"]')).toBeNull();

    createDeploymentCommand.mockRejectedValueOnce(new Error('network failure'));
    await wrapper.findAll('button').find(button => button.text() === '诊断').trigger('click');
    await flushPromises();
    expect(document.querySelector('[data-testid="deployment-operation-command-dialog"]')).toBeNull();
  });

  it('loads configuration from the remote menu and saves it directly to the online agent', async () => {
    const deployment = {
      id: 'deploy-remote', name: 'Remote Edge', schemaVersion: 2, configRevision: 7, status: 'succeeded',
      nodeGroup: 'Remote', profileId: '', agent: {
        online: true, lastSeenAt: '2026-08-03T04:30:31.000Z',
        heartbeat: { runtimeVersion: '2.3.18', core: 'sing-box', coreVersion: '1.13.15', osId: 'debian', osVersion: '13', osPrettyName: 'Debian GNU/Linux 13 (trixie)', pollIntervalSeconds: 30, hostname: 'remote-edge', configRevision: 7 }
      },
      configSummary: { runtime: { core: 'sing-box' }, protocols: [{ protocol: 'vless', port: 443 }] }
    };
    const template = {
      deployment, configRevision: 7, retainedSecrets: true,
      config: {
        schemaVersion: 2,
        runtime: { tier: 'auto', core: 'sing-box', channel: 'stable', controlCommand: 'tsub' },
        certificate: { mode: 'self-signed', apiToken: '********' },
        warp: { privateKey: '********', peerPublicKey: '', ipv4: '', ipv6: '' },
        firewall: { enabled: true }, tunnels: [],
        subscription: { hostname: 'remote.example.com', namePrefix: 'Remote', addressMode: 'auto', server: { enabled: false } },
        inbounds: [{ id: 'vless-main', name: 'Remote-VLESS', protocol: 'vless', port: 443, transport: 'tcp', outbound: 'direct', credentials: { uuid: '********' }, tls: { mode: 'reality', serverName: 'www.example.com', realityPrivateKey: '********', realityPublicKey: 'public-key', shortId: 'a1b2c3d4' }, transportOptions: {} }]
      }
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true, data: { mode: 'full', features: { remoteCommands: true, heartbeats: true } } }) });
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    getDeploymentTemplate.mockResolvedValue({ success: true, data: template });
    createRemoteDeploymentCommand.mockResolvedValue({ success: true, data: { operation: { id: 'op-remote', status: 'pending' } } });
    wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-system-version"]').text()).toBe('Debian 13');
    expect(wrapper.get('[data-testid="deployment-runtime-version"]').text()).toBe('Runtime 2.3.18');
    expect(wrapper.get('[data-testid="deployment-heartbeat-row"]').text()).toContain('Agent 在线');
    expect(wrapper.get('[data-testid="deployment-heartbeat-row"]').text()).toContain('30 秒');
    const remoteMenu = wrapper.get('[data-testid="deployment-remote-trigger"]');
    await remoteMenu.trigger('click');
    expect(remoteMenu.element.parentElement.hasAttribute('open')).toBe(true);
    expect(wrapper.get('[data-testid="deployment-remote-menu"]').classes()).toEqual(expect.arrayContaining(['left-auto', 'right-0', 'z-[60]']));
    document.body.click();
    await flushPromises();
    expect(remoteMenu.element.parentElement.hasAttribute('open')).toBe(false);
    await remoteMenu.trigger('click');
    const remoteActions = wrapper.get('[data-testid="remote-update-config"]').element.parentElement.querySelectorAll('button');
    expect(remoteActions[0].textContent).toBe('更新配置');
    await wrapper.get('[data-testid="remote-update-config"]').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('选择更新方式');
    expect(document.body.textContent).toContain('使用主控中保存的原配置创建 Agent 任务');
    expect(document.querySelector('[data-testid="direct-deployment-command"]').textContent).toBe('直接远程应用');
    document.querySelector('[data-testid="direct-deployment-command"]').click();
    await flushPromises();
    expect(createRemoteDeploymentCommand).toHaveBeenCalledWith('deploy-remote', 'update', { outputLanguage: 'zh-CN' });
    expect(createDeploymentCommand).not.toHaveBeenCalled();
    expect(getDeploymentTemplate).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="deployment-tabs"]').text()).toContain('操作记录');

    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="deployment-remote-trigger"]').trigger('click');
    await wrapper.get('[data-testid="remote-update-config"]').trigger('click');
    await flushPromises();
    Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === '重新配置').click();
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-submit"]').text()).toBe('保存并远程应用');
    expect(wrapper.find('[data-testid="deployment-command-panel"]').exists()).toBe(false);
    await wrapper.get('[data-testid="deployment-mode-install"]').trigger('click');
    expect(wrapper.get('[data-testid="deployment-submit"]').text()).toBe('生成安装命令');
    expect(wrapper.get('[data-testid="deployment-command-panel"]').exists()).toBe(true);

    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="deployment-remote-trigger"]').trigger('click');
    await wrapper.get('[data-testid="remote-update-config"]').trigger('click');
    await flushPromises();
    Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === '载入配置').click();
    await flushPromises();

    expect(getDeploymentTemplate).toHaveBeenCalledWith('deploy-remote');
    expect(wrapper.get('[data-testid="deployment-submit"]').text()).toBe('保存并远程应用');
    expect(wrapper.find('[data-testid="deployment-command-panel"]').exists()).toBe(false);
    await wrapper.get('[data-testid="inbound-protocol"]').setValue('trojan');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(document.body.textContent).toContain('确认保存并远程应用');
    document.querySelector('[data-testid="deployment-risk-panel"] button:last-child').click();
    await flushPromises();

    expect(createRemoteDeploymentCommand).toHaveBeenCalledWith('deploy-remote', 'update', expect.objectContaining({
      configRevision: 7,
      name: 'Remote Edge',
      config: expect.objectContaining({ inbounds: [expect.objectContaining({ protocol: 'trojan' })] })
    }));
    expect(createDeploymentCommand).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="deployment-tabs"]').text()).toContain('操作记录');
    expect(wrapper.find('[data-testid="deployment-command-panel"]').exists()).toBe(false);
  });

  it('queues a saved WebSocket preferred endpoint probe through the online Agent', async () => {
    const deployment = {
      id: 'deploy-probe', name: 'Probe Edge', schemaVersion: 2, configRevision: 4, status: 'succeeded',
      nodeGroup: 'Probe', profileId: '', agent: { online: true, lastSeenAt: '2026-08-04T00:00:00.000Z', heartbeat: { hostname: 'probe-host', cgroupLimitMb: 512, rssMb: 81 } },
      configSummary: { runtime: { core: 'xray' }, protocols: [{ protocol: 'vless', port: 8443 }] }
    };
    const config = {
      schemaVersion: 2,
      runtime: { tier: 'auto', core: 'xray', channel: 'stable', controlCommand: 'tsub' },
      certificate: { mode: 'self-signed' }, firewall: { enabled: true }, warp: { provisioning: 'manual' },
      edge: { mode: 'manual', hostname: 'cdn.example.com', endpoints: [{ id: 'preferred-ip', label: 'Preferred', address: '203.0.113.8', port: 8443 }], cloudflare: { accountId: '', zoneId: '', zoneName: '', sslMode: '', apiToken: '' } },
      subscription: { hostname: '', namePrefix: 'Probe', addressMode: 'auto', server: { enabled: false } },
      inbounds: [{ id: 'ws-main', name: 'Probe-VLESS', protocol: 'vless', port: 8443, transport: 'ws', outbound: 'direct', edgeMode: 'append', credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' }, tls: { mode: 'tls', serverName: 'cdn.example.com' }, transportOptions: { path: '/ws' } }]
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true, data: { mode: 'full', features: { remoteCommands: true, heartbeats: true } } }) });
    listDeployments.mockResolvedValue({ success: true, data: [deployment] });
    getDeploymentTemplate.mockResolvedValue({ success: true, data: { deployment, configRevision: 4, retainedSecrets: false, config } });
    probeDeploymentEdge.mockResolvedValue({ success: true, data: { runner: 'agent', operation: { id: 'op-probe' } } });
    wrapper = mountView(); await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="deployment-remote-trigger"]').trigger('click');
    await wrapper.get('[data-testid="remote-update-config"]').trigger('click'); await flushPromises();
    Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === '载入配置').click(); await flushPromises();

    const resourceHelp = wrapper.get('[data-testid="deployment-resource-tier-help"]');
    await resourceHelp.trigger('click');
    expect(document.getElementById(resourceHelp.attributes('aria-controls')).textContent).toContain('cgroup 上限：512 MB');
    await wrapper.get('[data-testid="probe-edge-endpoint-0"]').trigger('click'); await flushPromises();
    expect(probeDeploymentEdge).toHaveBeenCalledWith('deploy-probe', {
      inboundId: 'ws-main', endpointId: 'preferred-ip', configRevision: 4, runner: 'auto'
    });
    expect(wrapper.get('[data-testid="deployment-tabs"]').text()).toContain('操作记录');
  });

  it('restores a deleted managed subscription from its deployment record', async () => {
    listDeployments.mockResolvedValue({ success: true, data: [{
      id: 'deploy-1', name: 'Edge VPS', status: 'succeeded', schemaVersion: 2,
      subscriptionSourceDisabled: true, configSummary: { protocols: [] }
    }] });
    restoreDeploymentSource.mockResolvedValue({ success: true, data: { restored: true } });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();

    const restore = wrapper.get('[data-testid="restore-deployment-source"]');
    expect(restore.text()).toBe('恢复订阅');
    await restore.trigger('click');
    await flushPromises();
    expect(restoreDeploymentSource).toHaveBeenCalledWith('deploy-1');
  });

  it('shows the latest successful apply time in deployment records', async () => {
    listDeployments.mockResolvedValue({ success: true, data: [{
      id: 'deploy-time', name: 'Timed VPS', status: 'succeeded', schemaVersion: 2,
      deployedAt: '2026-07-30T00:44:00.000Z', pushCount: 4, pushHistory: ['2026-07-30T00:44:00.000Z'],
      configUpdatedAt: '2026-08-02T08:30:00.000Z',
      configSummary: { protocols: [], subscriptionServer: { pushEnabled: true, pushIntervalMinutes: 15 } }
    }] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-succeeded-at"]').text()).toBe('部署时间 2026/7/30');
    expect(wrapper.get('[data-testid="deployment-config-updated-at"]').text()).toBe('更新时间 2026/8/2');
    expect(wrapper.get('[data-testid="deployment-config-updated-at"]').text()).not.toBe(wrapper.get('[data-testid="deployment-succeeded-at"]').text());
    const remoteTrigger = wrapper.get('[data-testid="deployment-remote-trigger"]');
    expect(remoteTrigger.classes()).toEqual(expect.arrayContaining(['deploy-btn-neutral', 'deploy-remote-trigger', 'min-h-9', 'text-xs']));
    expect(remoteTrigger.attributes('aria-disabled')).toBe('true');
    await wrapper.get('[data-testid="deployment-push-history"]').trigger('click');
    expect(document.body.textContent).toContain('主动推送记录');
    expect(document.body.textContent).toContain('4');
  });

  it('prompts deployed self-signed TUIC records to update when certificate pins are missing', async () => {
    listDeployments.mockResolvedValue({ success: true, data: [{
      id: 'deploy-tuic-pin', name: 'Japan TUIC', status: 'succeeded', schemaVersion: 2,
      deployedAt: '2026-08-05T00:00:00.000Z',
      capabilities: { tuicCertificatePinStatus: 'missing' },
      configSummary: { selfSigned: true, protocols: [{ protocol: 'tuic', port: 51235 }] }
    }] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="tuic-certificate-pin-warning"]').text()).toContain('主控仍会下发该节点');
    expect(wrapper.get('[data-testid="deployment-update-config"]').exists()).toBe(true);
  });

  it('renders compact deployment rows and exposes complete details through one accessible popover at a time', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true, data: { mode: 'full', features: { remoteCommands: true, heartbeats: true } } }) });
    listDeployments.mockResolvedValue({ success: true, data: [{
      id: 'deploy-info', name: 'Compact Edge', status: 'succeeded', schemaVersion: 2, configRevision: 9,
      deployedAt: '2026-08-01T04:30:31.000Z', nodeCount: 4, resolvedHostname: 'edge.example.com', resolvedAddresses: ['203.0.113.9'], pushServerAddress: '203.0.113.9', edgeHostname: 'cdn.example.com',
      agent: {
        online: true, lastSeenAt: '2026-08-03T04:30:31.000Z',
        heartbeat: { runtimeVersion: '2.3.15', core: 'xray', coreVersion: '26.8.1', osId: 'debian', osVersion: '13', osPrettyName: 'Debian GNU/Linux 13 (trixie)', pollIntervalSeconds: 30, hostname: 'edge-host', configRevision: 9, currentCommandId: 'cmd-running', rssMb: 51, memoryAvailableMb: 180, cgroupLimitMb: 256, swapReported: true, swapTotalMb: 512, swapFreeMb: 384, swapUsedMb: 128, cgroupSwapReported: true, cgroupSwapCurrentMb: 32, cgroupSwapLimitMb: 256 }
      },
      capabilities: { container: 'podman', init: 'openrc', memoryMb: 256, rssMb: 43, trafficBackend: 'core-xray', controlCommand: 'tsub', degradedReason: '缺少 CAP_NET_ADMIN，已跳过防火墙' },
      configSummary: { runtime: { core: 'auto', tier: 'auto' }, addressMode: 'dual', selfSigned: true, protocols: [{ protocol: 'vless', port: 51231 }, { protocol: 'hysteria2', port: 51233 }], subscriptionServer: { enabled: true, port: 51235, trafficEnabled: true } }
    }] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="deployment-time-row"] p').text()).toBe('部署时间 2026/8/1 · 更新时间 2026/8/1');
    expect(wrapper.get('[data-testid="deployment-system-row"]').text()).toContain('Xray · auto · 4 个节点 · Debian 13 · Runtime 2.3.15');
    expect(wrapper.get('[data-testid="deployment-heartbeat-row"]').text()).toContain('Agent 在线 · 心跳 8/3');
    expect(wrapper.get('[data-testid="deployment-heartbeat-row"]').text()).toContain('30 秒');

    const timeButton = wrapper.get('[data-testid="deployment-time-info-deploy-info"]');
    await timeButton.trigger('focus');
    expect(timeButton.attributes('aria-expanded')).toBe('true');
    expect(document.querySelector('[role="tooltip"]:not([style*="display: none"])').textContent)
      .toContain(new Date('2026-08-01T04:30:31.000Z').toLocaleString('zh-CN'));
    await timeButton.trigger('click');
    await timeButton.trigger('blur');
    expect(timeButton.attributes('aria-expanded')).toBe('true');

    const systemButton = wrapper.get('[data-testid="deployment-system-info-deploy-info"]');
    expect(systemButton.classes().join(' ')).toContain('text-gray-400');
    await systemButton.trigger('click');
    expect(timeButton.attributes('aria-expanded')).toBe('false');
    expect(systemButton.attributes('aria-expanded')).toBe('true');
    const systemTooltip = document.querySelector('[role="tooltip"]:not([style*="display: none"])');
    expect(systemTooltip.textContent).toContain('缺少 CAP_NET_ADMIN');
    expect(systemTooltip.textContent).toContain('Debian GNU/Linux 13 (trixie)');
    expect(systemTooltip.textContent).toContain('203.0.113.9 · edge.example.com');
    expect(systemTooltip.textContent).toContain('cdn.example.com');
    expect(systemTooltip.textContent).toContain('RSS 51 MB · 可用 180 MB · cgroup 上限 256 MB');
    expect(systemTooltip.textContent).toContain('Swap 128/512 MB（可用 384 MB）');
    expect(systemTooltip.textContent).toContain('cgroup Swap 32/256 MB');
    expect(systemTooltip.textContent).toContain('vless:51231 · hysteria2:51233');
    expect(systemTooltip.textContent).toContain('podman / openrc');

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(systemButton.attributes('aria-expanded')).toBe('false');

    const heartbeatButton = wrapper.get('[data-testid="deployment-heartbeat-info-deploy-info"]');
    await heartbeatButton.trigger('click');
    await flushPromises();
    const heartbeatTooltip = document.querySelector('[role="tooltip"]:not([style*="display: none"])');
    expect(heartbeatTooltip.textContent).toContain('edge-host');
    expect(heartbeatTooltip.textContent).toContain('cmd-running');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(heartbeatButton.attributes('aria-expanded')).toBe('false');
  });

  it('shows offline, missing-heartbeat, and KV-limited heartbeat summaries', async () => {
    const deployment = {
      id: 'deploy-state', name: 'State Edge', status: 'succeeded', schemaVersion: 2, nodeCount: 1,
      deployedAt: '2026-08-03T00:00:00.000Z', configSummary: { runtime: { core: 'xray', tier: 'auto' }, protocols: [] }
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true, data: { mode: 'full', features: { remoteCommands: true, heartbeats: true } } }) });
    listDeployments.mockResolvedValue({ success: true, data: [{ ...deployment, agent: { online: false, lastSeenAt: '2026-08-03T04:30:31.000Z', heartbeat: { pollIntervalSeconds: 180 } } }] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-heartbeat-row"]').text()).toContain('Agent 离线');
    expect(wrapper.get('[data-testid="deployment-heartbeat-row"]').text()).toContain('180 秒');
    wrapper.unmount();

    listDeployments.mockResolvedValue({ success: true, data: [{ ...deployment, agent: { online: false, lastSeenAt: null, heartbeat: null } }] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-system-version"]').text()).toBe('系统未知');
    expect(wrapper.get('[data-testid="deployment-heartbeat-row"]').text()).toContain('尚未收到心跳');
    wrapper.unmount();

    fetchSpy.mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true, data: { mode: 'basic', features: { remoteCommands: false, heartbeats: false } } }) });
    listDeployments.mockResolvedValue({ success: true, data: [{ ...deployment, agent: { online: false, requiresD1: true } }] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '部署记录').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="deployment-heartbeat-row"]').text()).toContain('切换到 D1 后可用');
  });

  it('fills legacy operation host and result from heartbeat and the latest event', async () => {
    listDeployments.mockResolvedValue({ success: true, data: [{
      id: 'deploy-legacy-op', name: 'Legacy Agent', status: 'succeeded', schemaVersion: 2,
      agent: { online: true, heartbeat: { hostname: 'legacy-agent-host' } }, configSummary: { protocols: [] }
    }] });
    listDeploymentOperations.mockResolvedValue({ success: true, data: [{
      id: 'op-legacy', deploymentId: 'deploy-legacy-op', action: 'repair', status: 'succeeded',
      events: [
        { stage: 'repair', status: 'running', message: 'command started', resources: {} },
        { stage: 'repair', status: 'succeeded', message: 'command completed', resources: { tier: 'small', rssMb: 32, memoryMb: 128 } }
      ]
    }] });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '操作记录').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="operation-host"]').text()).toBe('legacy-agent-host');
    expect(wrapper.get('[data-testid="operation-result"]').text()).toBe('command completed');
    expect(wrapper.get('[data-testid="operation-result"]').attributes('title')).toBe('command completed');
  });
});

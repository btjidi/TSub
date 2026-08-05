import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from '../../src/i18n/index.js';
import CloudflareUsageCard from '../../src/components/settings/sections/CloudflareUsageCard.vue';

const accountId = 'a'.repeat(32); const databaseId = '1'.repeat(32); const namespaceId = '2'.repeat(32);
function settings(overrides = {}) { return { secretStatus: {}, cloudflareUsage: { enabled: false, accountId, apiToken: 'temporary-token', d1DatabaseId: '', kvNamespaceId: '', ...overrides } }; }
function mountCard(value = settings(), platform = 'cloudflare') {
  return mount(CloudflareUsageCard, { props: { settings: value, platform }, global: { plugins: [createI18n({ initialLocale: 'zh-CN' }), createPinia()] } });
}

describe('Cloudflare usage settings card', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('shows least-privilege instructions and detects selectable resources', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: {
      checks: { analytics: { ok: true }, d1: { ok: true }, kv: { ok: false, error: 'permission_required' } },
      d1: [{ id: databaseId, name: 'tsub-production' }], kv: [{ id: namespaceId, name: 'tsub-kv' }]
    } }), { headers: { 'Content-Type': 'application/json' } })));
    const wrapper = mountCard();
    expect(wrapper.text()).toContain('如何创建最小权限 API Token');
    expect(wrapper.text()).toContain('不要使用 Global API Key');
    await wrapper.get('[data-testid="cloudflare-detect-resources"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Analytics · 已通过');
    expect(wrapper.text()).toContain('KV · 缺少权限');
    expect(wrapper.find(`option[value="${databaseId}"]`).text()).toContain('tsub-production');
    expect(wrapper.find(`option[value="${namespaceId}"]`).text()).toContain('tsub-kv');
  });

  it('does not render on a server controller', () => {
    expect(mountCard(settings(), 'server').find('[data-testid="cloudflare-usage-card"]').exists()).toBe(false);
  });
});

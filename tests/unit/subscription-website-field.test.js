import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { useSubscriptionForms } from '../../src/composables/useSubscriptionForms.js';
import AdvancedOptions from '../../src/components/modals/SubscriptionEditModal/AdvancedOptions.vue';
import Card from '../../src/components/ui/Card.vue';
import PushHistoryModal from '../../src/components/modals/PushHistoryModal.vue';
import EditForm from '../../src/components/modals/SubscriptionEditModal/EditForm.vue';
import { createI18n } from '../../src/i18n/index.js';

function withZhI18n(stubs = {}) {
  return {
    plugins: [createI18n({ initialLocale: 'zh-CN' })],
    stubs
  };
}

vi.mock('../../src/stores/toast.js', () => ({
  useToastStore: () => ({
    showToast: vi.fn()
  })
}));

describe('subscription official website field', () => {
  it('initializes official website as an independent field for new subscriptions', () => {
    const { openAdd, editingSubscription } = useSubscriptionForms({
      addSubscription: vi.fn(),
      updateSubscription: vi.fn()
    });

    openAdd();

    expect(editingSubscription.value.website).toBe('');
  });

  it('renders website input above notes in advanced options', () => {
    const wrapper = mount(AdvancedOptions, {
      props: {
        editingSubscription: {
          customUserAgent: '',
          website: '',
          notes: '',
          enableNodeCache: false,
          plusAsSpace: false
        }
      },
      global: withZhI18n()
    });

    const websiteInput = wrapper.get('#sub-edit-website');
    const notesTextarea = wrapper.get('textarea');

    expect(wrapper.text()).toContain('官网');
    expect(websiteInput.attributes('placeholder')).toBe('https://example.com');
    expect(websiteInput.element.compareDocumentPosition(notesTextarea.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders managed deployment identity fields as disabled and hides fetch settings', () => {
    const wrapper = mount(EditForm, {
      props: {
        managed: true,
        editingSubscription: {
          name: 'Deployment Name', url: 'https://example.com/mirror', fetchProxy: 'https://proxy.example/'
        }
      },
      global: withZhI18n()
    });
    expect(wrapper.get('[data-testid="managed-subscription-readonly-hint"]').text()).toContain('无法在此修改');
    expect(wrapper.get('#sub-edit-name').attributes('disabled')).toBeDefined();
    expect(wrapper.get('#sub-edit-url').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).not.toContain('使用专属拉取代理');
  });

  it('uses the explicit website field for the card website link instead of parsing notes', () => {
    const wrapper = mount(Card, {
      props: {
        tsub: {
          id: 'sub_1',
          name: '测试机场',
          url: 'https://api.example.com/sub?target=clash',
          website: 'wd-gold.net/clientarea.php',
          notes: '备注里没有可识别官网',
          enabled: true,
          nodeCount: 0
        }
      },
      global: withZhI18n({
        Switch: { template: '<button class="switch-stub"></button>' }
      })
    });

    const link = wrapper.get('[data-testid="subscription-website-link"]');
    expect(link.attributes('href')).toBe('https://wd-gold.net/clientarea.php');
    expect(link.text()).toContain('官网');
  });

  it('shows the website link before notes on the subscription card', () => {
    const wrapper = mount(Card, {
      props: {
        tsub: {
          id: 'sub_1',
          name: '测试机场',
          url: 'https://api.example.com/sub?target=clash',
          website: 'https://wd-gold.net/clientarea.php',
          notes: '30/月 IPLC专线',
          enabled: true,
          nodeCount: 0
        }
      },
      global: withZhI18n({
        Switch: { template: '<button class="switch-stub"></button>' }
      })
    });

    const meta = wrapper.get('[data-testid="subscription-footer-meta"]');
    const websiteLink = wrapper.get('[data-testid="subscription-website-link"]');
    const notes = wrapper.get('[data-testid="subscription-notes"]');

    expect(websiteLink.element.compareDocumentPosition(notes.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(meta.text()).toMatch(/^官网\s*30\/月 IPLC专线/);
  });

  it('marks managed active push sources, allows preference editing, and allows deletion', async () => {
    const wrapper = mount(Card, {
      props: { tsub: {
        id: 'tsub_airport_deploy_1', name: 'VPS 订阅源', url: 'https://tsub.example/api/deploy/subscriptions/deploy_1/token',
        localUrl: 'http://203.0.113.10:51250/cgi-bin/local-token', serverAddress: '203.0.113.10',
        enabled: true, nodeCount: 1, lastPushAt: new Date().toISOString(), pushIntervalMinutes: 15, pushCount: 3,
        pushHistory: ['2026-07-30T00:30:00.000Z', '2026-07-30T00:15:00.000Z'], trafficBackend: 'core-singbox', source: { kind: 'tsub-deployment-push' }
      } },
      global: withZhI18n({ Switch: { template: '<button class="switch-stub"></button>' } })
    });
    expect(wrapper.get('[data-testid="push-source-badge"]').text()).toBe('主动推送');
    expect(wrapper.text()).toContain('最后推送');
    expect(wrapper.text()).toContain('推送频率：每 15 分钟');
    expect(wrapper.text()).toContain('累计推送 3 次');
    expect(wrapper.text()).toContain('预计下次推送');
    expect(wrapper.text()).toContain('核心统计 · sing-box');
    expect(wrapper.get('[data-testid="push-server-address"]').text()).toContain('203.0.113.10');
    expect(wrapper.get('[data-testid="push-mirror-url"]').element.value).toContain('/api/deploy/subscriptions/');
    expect(wrapper.get('[data-testid="push-local-url"]').element.value).toBe('http://203.0.113.10:51250/cgi-bin/local-token');
    expect(wrapper.find('[aria-label="编辑"]').exists()).toBe(true);
    await wrapper.get('[data-testid="edit-subscription"]').trigger('click');
    expect(wrapper.emitted('edit')).toHaveLength(1);
    expect(wrapper.find('[aria-label="删除"]').exists()).toBe(true);
    await wrapper.get('[data-testid="delete-subscription"]').trigger('click');
    expect(wrapper.emitted('delete')).toHaveLength(1);
    await wrapper.get('[data-testid="push-history-button"]').trigger('click');
    expect(wrapper.emitted('history')).toHaveLength(1);
  });

  it('renders installation snapshots as managed non-updating sources', () => {
    const wrapper = mount(Card, {
      props: { tsub: {
        id: 'tsub_airport_deploy_2', name: 'VPS 快照', url: 'https://tsub.example/api/deploy/subscriptions/deploy_2/token',
        localUrl: 'http://203.0.113.20:51250/cgi-bin/local-token', serverAddress: '203.0.113.20',
        enabled: true, nodeCount: 2, source: { kind: 'tsub-deployment-snapshot' }
      } },
      global: withZhI18n({ Switch: { template: '<button class="switch-stub"></button>' } })
    });
    expect(wrapper.get('[data-testid="snapshot-source-badge"]').text()).toBe('安装快照');
    expect(wrapper.text()).toContain('节点不会自动更新');
    expect(wrapper.find('[aria-label="编辑"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="删除"]').exists()).toBe(true);
  });

  it('converts and clears quota overrides through the subscription form', () => {
    const updateSubscription = vi.fn();
    const { openEdit, editingSubscription, handleSave } = useSubscriptionForms({
      addSubscription: vi.fn(), updateSubscription
    });
    openEdit({ id: 'sub-1', name: 'Source', url: 'https://example.com/sub', trafficQuotaOverrideBytes: 2 * 1024 ** 4 });
    expect(editingSubscription.value._trafficQuotaValue).toBe(2);
    expect(editingSubscription.value._trafficQuotaUnit).toBe('TB');
    editingSubscription.value._trafficQuotaValue = '1.5';
    editingSubscription.value._trafficQuotaUnit = 'GB';
    handleSave();
    expect(updateSubscription).toHaveBeenCalledWith(expect.objectContaining({
      trafficQuotaOverrideBytes: Math.round(1.5 * 1024 ** 3)
    }));
    expect(updateSubscription.mock.calls[0][0]).not.toHaveProperty('_trafficQuotaValue');
  });

  it('shows a custom quota without fabricating unavailable usage', () => {
    const wrapper = mount(Card, {
      props: { tsub: {
        id: 'sub-quota', name: 'Quota only', url: 'https://example.com/sub', enabled: true,
        trafficQuotaOverrideBytes: 100 * 1024 ** 3, userInfo: null
      } },
      global: withZhI18n({ Switch: { template: '<button class="switch-stub"></button>' } })
    });
    expect(wrapper.text()).toContain('自定义额度');
    expect(wrapper.text()).toContain('100 GB');
    expect(wrapper.text()).toContain('使用量不可用');
  });

  it('shows waiting and overdue states from the configured push interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T01:00:00+08:00'));
    const wrapper = mount(Card, {
      props: { tsub: {
        id: 'tsub_airport_deploy_schedule', name: '周期推送', url: 'https://tsub.example/sub', enabled: true,
        lastPushAt: '2026-07-30T00:44:00+08:00', pushIntervalMinutes: 15,
        source: { kind: 'tsub-deployment-push' }
      } },
      global: withZhI18n({ Switch: { template: '<button class="switch-stub"></button>' } })
    });
    expect(wrapper.get('[data-testid="push-schedule"]').text()).toContain('等待本次上报');
    expect(wrapper.text()).not.toContain('上报超时');

    vi.setSystemTime(new Date('2026-07-30T01:30:00+08:00'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wrapper.text()).toContain('上报超时');
    expect(wrapper.get('[data-testid="push-stale-badge"]').classes()).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    expect(wrapper.get('[data-testid="push-schedule"]').text()).not.toContain('等待本次上报');
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('keeps mobile status badges and actions in separate responsive rows', () => {
    const wrapper = mount(Card, {
      props: { tsub: {
        id: 'tsub_airport_deploy_mobile', name: '独角鲸日本软银', url: 'https://tsub.example/sub', enabled: true,
        lastPushAt: '2026-07-30T00:00:00+08:00', pushIntervalMinutes: 15,
        source: { kind: 'tsub-deployment-push' }
      } },
      global: withZhI18n({ Switch: { template: '<button class="switch-stub"></button>' } })
    });

    expect(wrapper.get('[data-testid="subscription-card-header"]').classes()).toEqual(expect.arrayContaining([
      'flex-col', 'lg:flex-row', 'lg:items-start', 'lg:justify-between'
    ]));
    expect(wrapper.get('[data-testid="subscription-card-badges"]').classes()).toContain('flex-wrap');
    expect(wrapper.get('h3').classes()).toEqual(expect.arrayContaining(['order-first', 'lg:order-none']));
    expect(wrapper.get('[data-testid="push-source-badge"]').classes()).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    expect(wrapper.get('[data-testid="subscription-card-actions"]').classes()).toEqual(expect.arrayContaining([
      '-my-2', 'w-full', 'shrink-0', 'justify-end', 'lg:my-0', 'lg:w-auto'
    ]));
  });

  it('renders accepted count and the latest push times in the shared history modal', () => {
    const wrapper = mount(PushHistoryModal, {
      props: {
        show: true,
        record: { pushCount: 8, pushIntervalMinutes: 30, lastPushAt: '2026-07-30T00:30:00.000Z', pushHistory: ['2026-07-30T00:30:00.000Z', '2026-07-30T00:00:00.000Z'] }
      },
      global: withZhI18n()
    });
    expect(wrapper.get('[data-testid="push-history-modal"]').text()).toContain('8');
    expect(wrapper.text()).toContain('每 30 分钟');
    expect(wrapper.findAll('time')).toHaveLength(2);
  });
});

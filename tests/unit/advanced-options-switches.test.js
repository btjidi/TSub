import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AdvancedOptions from '../../src/components/modals/SubscriptionEditModal/AdvancedOptions.vue';
import { createI18n } from '../../src/i18n/index.js';

describe('AdvancedOptions', () => {
  it('renders subscription toggles with concise labels and Switch controls', () => {
    const wrapper = mount(AdvancedOptions, {
      props: {
        editingSubscription: {
          customUserAgent: '',
          notes: '',
          enableNodeCache: false,
          plusAsSpace: false,
          excludeTraffic: false
        }
      },
      global: {
        plugins: [createI18n({ initialLocale: 'zh-CN' })]
      }
    });

    expect(wrapper.text()).toContain('保护性缓存节点');
    expect(wrapper.text()).toContain('+ 号转空格');
    expect(wrapper.text()).toContain('合并时不计算此机场流量');
    expect(wrapper.text()).toContain('拉取失败或空节点时使用上次缓存，避免节点清零');
    expect(wrapper.text()).toContain('将节点名中的 + 号显示为空格');
    expect(wrapper.text()).toContain('在多个订阅源合并展示流量时，忽略此机场的流量信息');
    expect(wrapper.findAllComponents({ name: 'Switch' }).length).toBe(3);
  });

  it('keeps safe preference fields and hides managed runtime options', () => {
    const wrapper = mount(AdvancedOptions, {
      props: {
        managed: true,
        editingSubscription: {
          customUserAgent: 'TSub', website: '', notes: '', enableNodeCache: true,
          plusAsSpace: true, excludeTraffic: false, _trafficQuotaValue: '', _trafficQuotaUnit: 'GB'
        }
      },
      global: { plugins: [createI18n({ initialLocale: 'zh-CN' })] }
    });
    expect(wrapper.text()).toContain('流量额度');
    expect(wrapper.find('[data-testid="subscription-traffic-quota-value"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('官网');
    expect(wrapper.text()).toContain('备注');
    expect(wrapper.text()).toContain('合并时不计算此机场流量');
    expect(wrapper.text()).not.toContain('自定义 User-Agent');
    expect(wrapper.text()).not.toContain('保护性缓存节点');
    expect(wrapper.text()).not.toContain('+ 号转空格');
    expect(wrapper.findAllComponents({ name: 'Switch' })).toHaveLength(1);
  });
});

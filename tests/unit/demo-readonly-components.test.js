import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import Card from '../../src/components/ui/Card.vue';
import ProfileCard from '../../src/components/profiles/ProfileCard.vue';
import ManualNodeCard from '../../src/components/nodes/ManualNodeCard.vue';
import { createI18n } from '../../src/i18n/index.js';

vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast: vi.fn() }) }));

const options = () => ({ global: { plugins: [createPinia(), createI18n({ initialLocale: 'zh-CN' })] } });

describe('demo records are read-only', () => {
  it('hides subscription mutation, export, and copy controls', () => {
    const wrapper = mount(Card, {
      props: {
        tsub: {
          id: 'demo-sub', demo: true, name: '演示 · 主动推送', enabled: true,
          url: 'https://demo.invalid/sub', localUrl: 'http://192.0.2.1:51250/demo',
          source: { kind: 'tsub-demo-push' }, userInfo: {}
        }
      },
      ...options()
    });
    expect(wrapper.find('[data-testid="push-source-badge"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="copy-push-mirror-url"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="delete-subscription"]').exists()).toBe(false);
    expect(wrapper.find('input').exists()).toBe(false);
  });

  it('hides Profile links, switches, logs, and mutation controls', () => {
    const wrapper = mount(ProfileCard, {
      props: { profile: { id: 'demo-profile', demo: true, name: '演示 · 日常使用', enabled: true, subscriptions: [], manualNodes: [] } },
      ...options()
    });
    expect(wrapper.text()).toContain('演示 · 日常使用');
    expect(wrapper.findAll('button')).toHaveLength(0);
  });

  it('does not allow demo nodes to be selected or mutated', async () => {
    const wrapper = mount(ManualNodeCard, {
      props: {
        node: { id: 'demo-node', demo: true, name: '演示 · 新加坡 VLESS', enabled: true, url: 'vless://id@192.0.2.1:443#demo' },
        isSelectionMode: true,
        isSelected: false
      },
      ...options()
    });
    await wrapper.trigger('click');
    expect(wrapper.emitted('toggle-select')).toBeUndefined();
    expect(wrapper.findAll('button')).toHaveLength(0);
  });
});

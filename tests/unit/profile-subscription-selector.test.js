import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SubscriptionSelector from '../../src/components/modals/ProfileModal/SubscriptionSelector.vue';
import { createI18n } from '../../src/i18n/index.js';

const post = vi.fn();
vi.mock('../../src/lib/http.js', () => ({ api: { post: (...args) => post(...args) } }));

function mountSelector(selectedIds) {
  const subscription = { id: 'sub-1', name: '部署订阅', url: 'https://example.com/sub' };
  return mount(SubscriptionSelector, {
    props: {
      subscriptions: [subscription],
      filteredSubscriptions: [subscription],
      selectedIds,
      searchTerm: ''
    },
    global: {
      plugins: [createI18n({ initialLocale: 'zh-CN' })],
      stubs: {
        draggable: {
          props: ['modelValue'],
          template: '<div><slot name="item" v-for="(element, index) in modelValue" :element="element" :index="index" /></div>'
        }
      }
    }
  });
}

describe('Profile subscription node selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({
      nodes: [1, 2, 3, 4].map(index => ({
        name: `Current ${index}`,
        url: `vless://uuid-${index}@example.com:443#Current-${index}`
      }))
    });
  });

  it('counts only current matches and keeps a fully stale selection empty', async () => {
    const staleFingerprints = Array.from({ length: 9 }, (_value, index) => index.toString(16).padStart(64, '0'));
    const wrapper = mountSelector([{
      id: 'sub-1',
      nodeSelection: { mode: 'include', fingerprints: staleFingerprints }
    }]);

    await flushPromises();
    expect(post).toHaveBeenCalledWith('/api/subscription_nodes', { subscriptionId: 'sub-1', applyTransform: false });
    await vi.waitFor(() => expect(wrapper.emitted('update:selectedIds')).toBeTruthy());
    await wrapper.setProps({ selectedIds: wrapper.emitted('update:selectedIds').at(-1)[0] });
    await flushPromises();

    expect(wrapper.text()).toContain('已选 0 个节点');
    expect(wrapper.text()).not.toContain('已选 9 个节点');
    await wrapper.find('button[aria-label="展开订阅源节点"]').trigger('click');
    expect(wrapper.text()).toContain('原选择已失效，请重新选择节点。');
    const normalized = wrapper.emitted('update:selectedIds').at(-1)[0][0].nodeSelection;
    expect(normalized).toEqual({ mode: 'include', fingerprints: [], identities: [] });
  });
});

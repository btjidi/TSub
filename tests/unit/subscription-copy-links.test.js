import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import Card from '../../src/components/ui/Card.vue';
import { createI18n } from '../../src/i18n/index.js';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast: toast }) }));

function mountCard(tsub) {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(Card, { props: { tsub }, global: { plugins: [pinia, createI18n({ initialLocale: 'en-US' })] } });
}

describe('subscription source copy controls', () => {
  beforeEach(() => {
    toast.mockClear();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('copies the main URL for an ordinary source', async () => {
    const wrapper = mountCard({ id: 'source-1', name: 'Source', url: 'https://example.com/sub', enabled: true, userInfo: {} });
    const input = wrapper.get('[data-testid="subscription-url"]');
    const button = wrapper.get('[data-testid="copy-subscription-url"]');
    expect(input.classes()).toContain('pr-11');
    expect(input.classes()).not.toContain('rounded-r-none');
    expect(button.classes()).toEqual(expect.arrayContaining(['absolute', 'right-0', 'rounded-r-lg']));
    await button.trigger('click');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://example.com/sub');
    expect(toast).toHaveBeenCalledWith('Subscription URL copied', 'success');
  });

  it('copies controller and server URLs independently for managed sources', async () => {
    const wrapper = mountCard({
      id: 'source-2', name: 'Push source', url: 'https://controller.example/sub',
      localUrls: ['http://192.0.2.10:51250/sub', 'http://[2001:db8::10]:51250/sub'], enabled: true,
      source: { kind: 'tsub-deployment-push' }, userInfo: {}
    });
    await wrapper.get('[data-testid="copy-push-mirror-url"]').trigger('click');
    await wrapper.get('[data-testid="copy-push-local-url"]').trigger('click');
    await wrapper.get('[data-testid="copy-push-local-url-1"]').trigger('click');
    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(1, 'https://controller.example/sub');
    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(2, 'http://192.0.2.10:51250/sub');
    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(3, 'http://[2001:db8::10]:51250/sub');
    expect(wrapper.get('[data-testid="push-mirror-url"]').classes()).toContain('pr-11');
    expect(wrapper.get('[data-testid="push-local-url"]').classes()).toContain('pr-11');
    expect(wrapper.get('[data-testid="copy-push-mirror-url"]').classes()).toEqual(expect.arrayContaining(['absolute', 'right-0']));
    expect(wrapper.get('[data-testid="copy-push-local-url"]').classes()).toEqual(expect.arrayContaining(['absolute', 'right-0']));
    expect(wrapper.get('[data-testid="copy-push-local-url"] path').attributes('d')).toBe(wrapper.get('[data-testid="copy-push-mirror-url"] path').attributes('d'));
    expect(wrapper.get('[data-testid="copy-push-local-url"]').attributes('aria-label')).toBe('Copy local server subscription URL');
  });

  it('keeps the readonly URL visible when clipboard access fails', async () => {
    navigator.clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    const wrapper = mountCard({ id: 'source-3', name: 'Source', url: 'https://example.com/sub', enabled: true, userInfo: {} });
    await wrapper.get('[data-testid="copy-subscription-url"]').trigger('click');
    expect(wrapper.get('[data-testid="subscription-url"]').element.value).toBe('https://example.com/sub');
    expect(toast).toHaveBeenCalledWith('Copy failed. Select and copy the URL manually.', 'error');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import Card from '../../src/components/ui/Card.vue';
import { createI18n } from '../../src/i18n/index.js';

vi.mock('../../src/stores/toast.js', () => ({
  useToastStore: () => ({ showToast: vi.fn() })
}));

const wrappers = [];
const mountCard = (source) => {
  const tsub = {
    id: `source-${wrappers.length + 1}`,
    name: '测试订阅',
    url: 'https://example.com/sub',
    enabled: true,
    nodeCount: 1,
    userInfo: {},
    ...(source ? { source } : {})
  };
  const wrapper = mount(Card, {
    attachTo: document.body,
    props: { tsub },
    global: { plugins: [createI18n({ initialLocale: 'zh-CN' })] }
  });
  wrappers.push(wrapper);
  return { wrapper, tsub };
};

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount();
  document.body.innerHTML = '';
});

describe('subscription enabled switch help', () => {
  it.each([
    [undefined, '关闭后不参与订阅生成，已保存的订阅数据仍会保留'],
    [{ kind: 'tsub-deployment-snapshot' }, '关闭后不参与订阅生成，已保存的节点快照仍会保留'],
    [{ kind: 'tsub-deployment-push' }, '主控镜像暂不可用，但不会停止服务器主动推送']
  ])('shows source-specific help text', async (source, expected) => {
    const { wrapper } = mountCard(source);
    const container = wrapper.get('[data-testid="subscription-enabled-help-container"]');
    const tooltip = wrapper.get('[data-testid="subscription-enabled-tooltip"]');
    expect(tooltip.isVisible()).toBe(false);
    await container.trigger('mouseenter');
    expect(tooltip.isVisible()).toBe(true);
    expect(tooltip.text()).toContain(expected);
    await container.trigger('mouseleave');
    expect(tooltip.isVisible()).toBe(false);
  });

  it('pins on click and closes on second click, outside pointer, and Escape', async () => {
    const { wrapper } = mountCard({ kind: 'tsub-deployment-push' });
    const button = wrapper.get('[data-testid="subscription-enabled-help"]');
    const tooltip = wrapper.get('[data-testid="subscription-enabled-tooltip"]');

    await button.trigger('click');
    expect(tooltip.isVisible()).toBe(true);
    expect(button.attributes('aria-expanded')).toBe('true');
    expect(tooltip.attributes('role')).toBe('tooltip');
    await wrapper.get('[data-testid="subscription-enabled-help-container"]').trigger('mouseleave');
    expect(tooltip.isVisible()).toBe(true);

    await button.trigger('click');
    expect(tooltip.isVisible()).toBe(false);
    await button.trigger('click');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(tooltip.isVisible()).toBe(false);

    await button.trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(tooltip.isVisible()).toBe(false);
    expect(document.activeElement).toBe(button.element);
  });

  it('keeps the original switch model and change event behavior', async () => {
    const { wrapper, tsub } = mountCard({ kind: 'tsub-deployment-push' });
    await wrapper.get('input[type="checkbox"]').trigger('change');
    expect(tsub.enabled).toBe(false);
    expect(wrapper.emitted('change')).toHaveLength(1);
  });

  it('places the help control at the far right of the footer actions', () => {
    const { wrapper } = mountCard();
    const actions = wrapper.get('[data-testid="subscription-footer-actions"]');
    const enabledSwitch = wrapper.get('[data-testid="subscription-enabled-switch"]');
    const help = wrapper.get('[data-testid="subscription-enabled-help-container"]');
    expect(enabledSwitch.element.parentElement).toBe(actions.element);
    expect(enabledSwitch.element.nextElementSibling).toBe(help.element);
    expect(actions.element.lastElementChild).toBe(help.element);
    const footer = wrapper.get('[data-testid="subscription-footer"]');
    expect(actions.element.parentElement).toBe(footer.element);
    expect(footer.classes()).toEqual(expect.arrayContaining(['mt-auto', 'justify-end']));
    expect(wrapper.get('[data-testid="subscription-enabled-tooltip"]').classes()).toEqual(expect.arrayContaining(['right-0', 'bottom-full']));
  });

  it('keeps notes above the bottom-right switch footer', async () => {
    const { wrapper } = mountCard();
    await wrapper.setProps({ tsub: { ...wrapper.props('tsub'), notes: '测试备注' } });
    const meta = wrapper.get('[data-testid="subscription-footer-meta"]');
    const footer = wrapper.get('[data-testid="subscription-footer"]');
    expect(meta.element.nextElementSibling).toBe(footer.element);
  });
});

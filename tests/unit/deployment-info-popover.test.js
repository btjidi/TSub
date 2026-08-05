import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DeploymentInfoPopover from '../../src/components/deployments/DeploymentInfoPopover.vue';

describe('DeploymentInfoPopover', () => {
  let wrapper;

  afterEach(() => {
    wrapper?.unmount();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('teleports into body, stays inside the viewport, and flips around its trigger', async () => {
    let buttonRect = { left: 284, right: 304, top: 210, bottom: 230, width: 20, height: 20 };
    const rect = values => ({ x: values.left, y: values.top, toJSON: () => ({}), ...values });
    const getRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      if (this.getAttribute('data-testid') === 'position-help') return rect(buttonRect);
      if (this.getAttribute('role') === 'tooltip') return rect({ left: 0, right: 300, top: 0, bottom: 100, width: 300, height: 100 });
      return rect({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 246 });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(); return 1; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    wrapper = mount(DeploymentInfoPopover, {
      attachTo: document.body,
      props: { open: false, label: 'CDN 节点', testId: 'position-help' },
      slots: { default: '提示内容' }
    });
    const trigger = wrapper.get('[data-testid="position-help"]');
    expect(trigger.classes()).not.toContain('z-[130]');
    expect(trigger.classes()).toContain('relative');
    await wrapper.setProps({ open: true });
    await flushPromises();

    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip.style.left).toBe('16px');
    expect(tooltip.style.top).toBe('102px');
    expect(tooltip.lastElementChild.className).toContain('top-full');

    buttonRect = { left: 20, right: 40, top: 12, bottom: 32, width: 20, height: 20 };
    window.dispatchEvent(new Event('resize'));
    await flushPromises();
    expect(tooltip.style.left).toBe('16px');
    expect(tooltip.style.top).toBe('40px');
    expect(tooltip.lastElementChild.className).toContain('bottom-full');

    const callsBeforeScroll = getRect.mock.calls.length;
    window.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(getRect.mock.calls.length).toBeGreaterThan(callsBeforeScroll);
  });
});

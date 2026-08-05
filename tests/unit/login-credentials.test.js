import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import Login from '../../src/components/modals/Login.vue';
import { createI18n } from '../../src/i18n/index.js';

describe('administrator login form', () => {
  it('submits a normalized username and password', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(Login, { props: { login }, global: { plugins: [createI18n({ initialLocale: 'zh-CN' })], stubs: { img: true } } });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue(' Ops.Admin ');
    await inputs[1].setValue('secret-password');
    await wrapper.find('form').trigger('submit');
    expect(login).toHaveBeenCalledWith('ops.admin', 'secret-password');
    expect(inputs[0].attributes('autocomplete')).toBe('username');
    expect(inputs[1].attributes('autocomplete')).toBe('current-password');
  });

  it('renders both fields in English and rejects an empty username', async () => {
    const login = vi.fn();
    const wrapper = mount(Login, { props: { login }, global: { plugins: [createI18n({ initialLocale: 'en-US' })], stubs: { img: true } } });
    expect(wrapper.text()).toContain('Sign in with your administrator account');
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('');
    await inputs[1].setValue('secret-password');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.text()).toContain('Enter your username');
    expect(login).not.toHaveBeenCalled();
    const alert = wrapper.get('[role="alert"]');
    expect(alert.attributes('id')).toBe('login-error');
    expect(alert.classes()).not.toContain('absolute');
    expect(inputs[0].attributes('aria-describedby')).toBe('login-error');
    expect(inputs[1].attributes('aria-describedby')).toBe('login-error');
  });

  it('keeps an authentication error in normal flow above the submit button', async () => {
    const login = vi.fn().mockRejectedValue(new Error('invalid credentials'));
    const wrapper = mount(Login, { props: { login }, global: { plugins: [createI18n({ initialLocale: 'zh-CN' })], stubs: { img: true } } });
    const inputs = wrapper.findAll('input');
    await inputs[1].setValue('wrong-password');
    await wrapper.find('form').trigger('submit');

    const alert = wrapper.get('#login-error');
    const submit = wrapper.get('button[type="submit"]');
    expect(alert.text()).toBe('登录失败，请检查账号和密码');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.classes()).not.toContain('absolute');
    expect(alert.element.compareDocumentPosition(submit.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

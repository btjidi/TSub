import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SecretInput from '../../src/components/forms/SecretInput.vue';
import { createI18n } from '../../src/i18n/index.js';

describe('SecretInput actions', () => {
  it('places visibility before generate and generate at the far right', () => {
    const wrapper = mount(SecretInput, {
      props: {
        allowGenerate: true,
        toggleTestid: 'toggle-secret',
        generateTestid: 'generate-secret'
      },
      global: { plugins: [createI18n({ initialLocale: 'zh-CN' })] }
    });
    const buttons = wrapper.findAll('button');
    expect(buttons[0].attributes('data-testid')).toBe('toggle-secret');
    expect(buttons[0].classes()).toContain('right-12');
    expect(buttons[1].attributes('data-testid')).toBe('generate-secret');
    expect(buttons[1].classes()).toContain('right-px');
    expect(buttons[1].classes()).toContain('px-3');
  });
});

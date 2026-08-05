import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import BasicSettings from '../../src/components/settings/sections/BasicSettings.vue';
import { createI18n } from '../../src/i18n/index.js';

const showToast = vi.fn();

vi.mock('../../src/stores/toast', () => ({
  useToastStore: () => ({ showToast })
}));

const mountBasicSettings = (settings) => mount(BasicSettings, {
  props: {
    settings,
    disguiseConfig: {
      enabled: false,
      pageType: 'default',
      redirectUrl: ''
    }
  },
  global: {
    plugins: [createI18n({ initialLocale: 'zh-CN' })],
    stubs: {
      Switch: {
        template: '<div />'
      }
    }
  }
});

describe('BasicSettings validation feedback', () => {
  beforeEach(() => {
    showToast.mockReset();
  });

  it('keeps reserved tokens in the field and shows inline error state', async () => {
    const wrapper = mountBasicSettings({
      FileName: '',
      mytoken: 'settings',
      profileToken: 'profile-token',
      customLoginPath: 'login',
      enablePublicPage: true
    });

    await wrapper.vm.$nextTick();

    expect(wrapper.props().settings.mytoken).toBe('settings');
    expect(wrapper.text()).toContain('系统保留路径不可用作自定义订阅 Token');
    expect(wrapper.props().settings.customLoginPath).toBe('login');
    expect(wrapper.text()).toContain('"/login" 是系统保留路径，不可用作自定义管理后台路径');
  });

  it('allows URL path-safe symbol characters in subscription tokens for stronger secrets', async () => {
    const wrapper = mountBasicSettings({
      FileName: '',
      mytoken: '!luckyss',
      profileToken: 'profile:token!$&()*+,;=@',
      customLoginPath: 'login',
      enablePublicPage: true
    });

    await wrapper.vm.$nextTick();

    expect(wrapper.props().settings.mytoken).toBe('!luckyss');
    expect(wrapper.props().settings.profileToken).toBe('profile:token!$&()*+,;=@');
    expect(wrapper.text()).not.toContain('Token 仅允许');
  });

  it('still rejects token characters that break a single URL path segment', async () => {
    const wrapper = mountBasicSettings({
      FileName: '',
      mytoken: 'bad/token',
      profileToken: 'bad?token',
      customLoginPath: 'login',
      enablePublicPage: true
    });

    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Token 不能包含斜杠、问号、井号或空白字符');
  });

  it('generates a UUID token from the action inside the custom token input', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue('79411d85-b0dc-4cd2-b46c-01789a18c650');
    const settings = {
      FileName: '',
      mytoken: '',
      profileToken: 'profile-token',
      customLoginPath: 'admin',
      enablePublicPage: true
    };
    const wrapper = mountBasicSettings(settings);

    const button = wrapper.get('[data-testid="generate-custom-subscription-token"]');
    expect(button.text()).toBe('生成');
    expect(button.classes()).toContain('absolute');
    await button.trigger('click');

    expect(settings.mytoken).toBe('79411d85-b0dc-4cd2-b46c-01789a18c650');
    expect(wrapper.get('[data-testid="custom-subscription-token"]').element.value).toBe('79411d85-b0dc-4cd2-b46c-01789a18c650');
    randomUUID.mockRestore();
  });

  it('renders four combinable traffic metrics and all supported label styles', () => {
    const wrapper = mountBasicSettings({
      FileName: '', mytoken: '', profileToken: '', customLoginPath: '', enablePublicPage: true,
      enableTrafficNode: true,
      trafficNodeDisplay: {
        upload: { enabled: true, label: 'symbol' },
        download: { enabled: true, label: 'symbol' },
        total: { enabled: true, label: 'symbol' },
        remaining: { enabled: true, label: 'symbol' }
      }
    });

    expect(wrapper.findAll('[data-testid^="traffic-node-enabled-"]')).toHaveLength(4);
    expect(wrapper.get('[data-testid="traffic-node-label-upload"]').text()).toContain('上行流量');
    expect(wrapper.get('[data-testid="traffic-node-label-download"]').text()).toContain('下行流量');
    expect(wrapper.get('[data-testid="traffic-node-label-total"]').text()).toContain('总计流量');
    expect(wrapper.get('[data-testid="traffic-node-label-remaining"]').text()).toContain('剩余流量');
    expect(wrapper.get('[data-testid="traffic-node-layout-two"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[data-testid="traffic-node-layout"]').text()).toContain('一行显示');
    expect(wrapper.get('[data-testid="traffic-node-layout"]').text()).toContain('四行显示');
  });

  it('changes the traffic node row layout', async () => {
    const settings = {
      FileName: '', mytoken: '', profileToken: '', customLoginPath: '', enablePublicPage: true,
      enableTrafficNode: true,
      trafficNodeDisplay: {
        upload: { enabled: true, label: 'symbol' }, download: { enabled: true, label: 'symbol' },
        total: { enabled: true, label: 'symbol' }, remaining: { enabled: true, label: 'symbol' }
      }
    };
    const wrapper = mountBasicSettings(settings);
    await wrapper.get('[data-testid="traffic-node-layout-one"]').trigger('click');
    expect(settings.trafficNodeDisplay.layout).toBe('one');
    expect(wrapper.get('[data-testid="traffic-node-layout-one"]').attributes('aria-checked')).toBe('true');
  });

  it('shows and preserves a sanitized custom label input', async () => {
    const settings = {
      FileName: '', mytoken: '', profileToken: '', customLoginPath: '', enablePublicPage: true,
      enableTrafficNode: true,
      trafficNodeDisplay: {
        upload: { enabled: true, label: 'symbol' }, download: { enabled: true, label: 'symbol' },
        total: { enabled: true, label: 'symbol' }, remaining: { enabled: true, label: 'symbol' }
      }
    };
    const wrapper = mountBasicSettings(settings);

    expect(wrapper.text()).toContain('上行流量');
    expect(wrapper.text()).toContain('下行流量');
    expect(wrapper.text()).toContain('总计流量');
    expect(wrapper.text()).toContain('剩余流量');
    expect(wrapper.find('[data-testid="traffic-node-custom-label-upload"]').exists()).toBe(false);

    await wrapper.get('[data-testid="traffic-node-label-upload"]').setValue('custom');
    const input = wrapper.get('[data-testid="traffic-node-custom-label-upload"]');
    expect(input.attributes('maxlength')).toBe('24');
    expect(input.attributes('placeholder')).toBe('输入自定义名称');
    await input.setValue('  上\u0000传  ');
    await input.trigger('blur');
    expect(settings.trafficNodeDisplay.upload.customLabel).toBe('上传');

    await wrapper.get('[data-testid="traffic-node-label-upload"]').setValue('full');
    expect(wrapper.find('[data-testid="traffic-node-custom-label-upload"]').exists()).toBe(false);
    expect(settings.trafficNodeDisplay.upload.customLabel).toBe('上传');
    await wrapper.get('[data-testid="traffic-node-label-upload"]').setValue('custom');
    expect(wrapper.get('[data-testid="traffic-node-custom-label-upload"]').element.value).toBe('上传');
  });

  it('keeps the last traffic metric enabled', async () => {
    const settings = {
      FileName: '', mytoken: '', profileToken: '', customLoginPath: '', enablePublicPage: true,
      enableTrafficNode: true,
      trafficNodeDisplay: {
        upload: { enabled: true, label: 'symbol' },
        download: { enabled: false, label: 'symbol' },
        total: { enabled: false, label: 'symbol' },
        remaining: { enabled: false, label: 'symbol' }
      }
    };
    const wrapper = mountBasicSettings(settings);
    await wrapper.get('[data-testid="traffic-node-enabled-upload"]').setValue(false);

    expect(settings.trafficNodeDisplay.upload.enabled).toBe(true);
    expect(showToast).toHaveBeenCalledWith('至少选择一个流量统计节点', 'warning');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import BasicSettings from '../../src/components/settings/sections/BasicSettings.vue';
import ClientSettings from '../../src/components/settings/sections/ClientSettings.vue';
import TransformCard from '../../src/components/settings/sections/ServiceSettings/TransformCard.vue';
import RuleTemplateManager from '../../src/components/settings/sections/ServiceSettings/RuleTemplateManager.vue';
import TelegramCard from '../../src/components/settings/sections/ServiceSettings/TelegramCard.vue';
import SystemSettings from '../../src/components/settings/sections/SystemSettings.vue';
import { createI18n } from '../../src/i18n/index.js';

vi.mock('../../src/lib/http.js', () => ({
  api: {
    get: vi.fn(async (url) => {
      if (url === '/api/clients') {
        return {
          success: true,
          data: [
            {
              id: 'clash-verge',
              name: 'Clash Verge',
              icon: '🌐',
              description: 'Desktop client',
              platforms: ['windows'],
              url: 'https://example.com',
              repo: 'example/client'
            }
          ]
        };
      }
      return { success: true, data: [] };
    }),
    post: vi.fn(async () => ({ success: true, data: [] })),
    del: vi.fn(async () => ({ success: true, data: [] }))
  }
}));

vi.mock('../../src/stores/toast', () => ({
  useToastStore: () => ({ showToast: vi.fn() })
}));

const SwitchStub = {
  props: ['modelValue', 'label'],
  emits: ['update:modelValue'],
  template: '<button type="button" @click="$emit(\'update:modelValue\', !modelValue)">{{ label }}</button>'
};

const ModalStub = {
  props: ['show', 'title', 'confirmText', 'cancelText'],
  emits: ['update:show', 'confirm'],
  template: '<section v-if="show"><h2>{{ title }}</h2><slot name="body" /><slot name="footer" /></section>'
};

const englishMountOptions = () => ({
  global: {
    plugins: [createI18n({ initialLocale: 'en-US' })],
    stubs: {
      Switch: SwitchStub,
      Modal: ModalStub
    }
  }
});

const expectNoChineseOrKeys = (text) => {
  expect(text).not.toMatch(/[\u4e00-\u9fff]/);
  expect(text).not.toContain('settings.');
};

describe('settings page English translations', () => {
  it('renders BasicSettings access control copy in English', () => {
    const wrapper = mount(BasicSettings, {
      props: {
        settings: {
          FileName: '',
          mytoken: 'token',
          profileToken: 'profile-token',
          customLoginPath: 'admin',
          enablePublicPage: true,
          enableAccessLog: false,
          accessLogMode: 'light',
          showRemainingTraffic: true,
          autoUpdateInterval: 0,
          defaultLocale: 'en-US'
        },
        disguiseConfig: {
          enabled: true,
          pageType: 'redirect',
          redirectUrl: 'example.com'
        }
      },
      ...englishMountOptions()
    });

    expect(wrapper.text()).toContain('Default display language');
    expect(wrapper.text()).toContain('Web Access Control');
    expect(wrapper.text()).toContain('Allow public access without login');
    expect(wrapper.text()).toContain('Disguise strategy');
    expect(wrapper.text()).toContain('Target URL');
    expect(wrapper.text()).toContain('English');
  });

  it('renders traffic metric titles and the custom label control in English', async () => {
    const wrapper = mount(BasicSettings, {
      props: {
        settings: {
          FileName: '', mytoken: 'token', profileToken: 'profile-token', customLoginPath: 'admin',
          enablePublicPage: true, enableTrafficNode: true,
          trafficNodeDisplay: {
            upload: { enabled: true, label: 'symbol' }, download: { enabled: true, label: 'symbol' },
            total: { enabled: true, label: 'symbol' }, remaining: { enabled: true, label: 'symbol' }
          }
        },
        disguiseConfig: { enabled: false, pageType: 'default', redirectUrl: '' }
      },
      ...englishMountOptions()
    });

    expect(wrapper.text()).toContain('Upload Traffic');
    expect(wrapper.text()).toContain('Download Traffic');
    expect(wrapper.text()).toContain('Total Traffic');
    expect(wrapper.text()).toContain('Remaining Traffic');
    expect(wrapper.get('[data-testid="traffic-node-label-upload"]').text()).toContain('Custom');
    await wrapper.get('[data-testid="traffic-node-label-upload"]').setValue('custom');
    expect(wrapper.get('[data-testid="traffic-node-custom-label-upload"]').attributes('placeholder')).toBe('Enter a custom label');
  });

  it('renders ClientSettings management copy in English', async () => {
    const wrapper = mount(ClientSettings, englishMountOptions());
    await flushPromises();

    expect(wrapper.text()).toContain('Client Management');
    expect(wrapper.text()).toContain('Reset defaults');
    expect(wrapper.text()).toContain('Add client');
    expect(wrapper.text()).toContain('Up');
    expect(wrapper.text()).toContain('Down');
    expect(wrapper.text()).toContain('Edit');
    expectNoChineseOrKeys(wrapper.text());
  });

  it('renders service cards in English without leaking keys', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const transform = mount(TransformCard, {
      props: {
        settings: {
          transformConfigMode: 'preset',
          transformConfig: '',
          builtinSkipCertVerify: false,
          builtinEnableUdp: false,
          ruleLevel: 'std',
          subconverter: {
            engineMode: 'external',
            defaultBackend: 'api.v1.mk',
            defaultOptions: { udp: true, emoji: true, scv: true, tfo: false, sort: false, list: false }
          }
        }
      },
      global: {
        plugins: [createI18n({ initialLocale: 'en-US' }), pinia],
        stubs: {
          TransformSelector: true,
          RuleTemplateManager: true
        }
      }
    });

    expect(transform.text()).toContain('Default conversion engine');
    expect(transform.text()).toContain('External backend parameters');
    expect(transform.text()).toContain('Test backend availability');
    expectNoChineseOrKeys(transform.text());

    const telegram = mount(TelegramCard, {
      props: {
        settings: {
          BotToken: '',
          ChatID: '',
          telegram_push_config: {
            enabled: true,
            bot_token: '',
            webhook_secret: '',
            allowed_user_ids: [],
            allow_all_users: false
          }
        }
      },
      ...englishMountOptions()
    });

    expect(telegram.text()).toContain('Telegram notification bot');
    expect(telegram.text()).toContain('Webhook Secret (required)');
    expect(telegram.text()).toContain('setWebhook link');
    expectNoChineseOrKeys(telegram.text());

    await telegram.setProps({
      settings: {
        BotToken: '',
        ChatID: '123',
        secretStatus: {
          BotToken: true,
          'telegram_push_config.bot_token': true,
          'telegram_push_config.webhook_secret': true
        },
        telegram_push_config: {
          enabled: true,
          bot_token: '',
          webhook_secret: '',
          allowed_user_ids: [],
          allow_all_users: false
        }
      }
    });
    expect(telegram.text()).toContain('Securely configured; the saved value is not shown again');
    expect(telegram.text()).toContain('Clear credential');

    const rules = mount(RuleTemplateManager, {
      global: {
        plugins: [createI18n({ initialLocale: 'en-US' }), pinia]
      }
    });
    await flushPromises();

    expect(rules.text()).toContain('Custom rule templates');
    expect(rules.text()).toContain('No custom rule templates yet');
    expectNoChineseOrKeys(rules.text());
  });

  it('splits data and backup controls from system security controls in English', () => {
    const commonProps = {
      settings: { storageType: 'd1', externalApi: { enabled: true, tokens: [{ name: 'default', token: 'secret' }] } },
      exportBackup: vi.fn(),
      importBackup: vi.fn(),
      handleReset: vi.fn()
    };
    const dataWrapper = mount(SystemSettings, {
      props: {
        ...commonProps,
        category: 'data'
      },
      ...englishMountOptions()
    });
    const securityWrapper = mount(SystemSettings, {
      props: { ...commonProps, category: 'security' },
      ...englishMountOptions()
    });

    expect(dataWrapper.text()).toContain('Data storage type');
    expect(dataWrapper.text()).toContain('Demo data');
    expect(dataWrapper.text()).toContain('Generate demo data');
    expect(dataWrapper.find('[data-testid="seed-demo-data"]').exists()).toBe(true);
    expect(dataWrapper.find('[data-testid="clear-demo-data"]').attributes('disabled')).toBeDefined();
    expect(dataWrapper.text()).toContain('D1 database (recommended)');
    expect(dataWrapper.text()).toContain('Data submission mode');
    expect(dataWrapper.text()).toContain('Submit changes immediately');
    expect(dataWrapper.text()).toContain('Backup and restore');
    expect(dataWrapper.text()).toContain('Export backup');
    expect(dataWrapper.text()).not.toContain('External management API');

    expect(securityWrapper.text()).toContain('External management API');
    expect(securityWrapper.text()).toContain('Bearer token');
    expect(securityWrapper.text()).toContain('Generate random token');
    expect(securityWrapper.text()).toContain('Administrator security settings');
    expect(securityWrapper.text()).toContain('Update credentials');
    expect(securityWrapper.text()).toContain('Danger zone');
    expect(securityWrapper.text()).not.toContain('Data storage type');
    expectNoChineseOrKeys(dataWrapper.text());
    expectNoChineseOrKeys(securityWrapper.text());
  });

  it('places the data submission switch before Cloudflare quotas and updates the setting', async () => {
    const settings = {
      storageType: 'd1',
      dataCommitMode: 'manual',
      directCommitSilentSuccess: true,
      externalApi: { enabled: false, tokens: [] }
    };
    const wrapper = mount(SystemSettings, {
      props: { category: 'data', settings, exportBackup: vi.fn(), importBackup: vi.fn(), handleReset: vi.fn() },
      ...englishMountOptions()
    });

    const commitCard = wrapper.get('[data-testid="data-commit-mode-card"]');
    const usageCard = wrapper.find('[data-testid="cloudflare-usage-card"]');
    expect(usageCard.exists()).toBe(true);
    expect(commitCard.element.compareDocumentPosition(usageCard.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await commitCard.get('[data-testid="data-commit-mode-switch"]').trigger('click');
    expect(settings.dataCommitMode).toBe('direct');
    expect(commitCard.text()).toContain('each complete action invokes the existing unified save flow');
    const silentSwitch = commitCard.get('[data-testid="data-commit-silent-success-switch"]');
    expect(silentSwitch.attributes('disabled')).toBeUndefined();
    await silentSwitch.trigger('click');
    expect(settings.directCommitSilentSuccess).toBe(false);
    expect(commitCard.text()).toContain('successful automatic submissions show no notice');
  });

  it('disables switching back to KV for a D1-only installation', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/storage/status') {
        return new Response(JSON.stringify({
          success: true,
          data: { platform: 'cloudflare', activeStorage: 'd1', bindings: { d1: true, kv: false } }
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/settings/credentials') {
        return new Response(JSON.stringify({ success: true, data: { username: 'admin', canPersist: true } }));
      }
      return new Response(JSON.stringify({ success: true, data: { counts: {} } }));
    }));
    try {
      const wrapper = mount(SystemSettings, {
        props: {
          category: 'data', settings: { storageType: 'd1', externalApi: { enabled: false, tokens: [] } },
          exportBackup: vi.fn(), importBackup: vi.fn(), handleReset: vi.fn()
        },
        ...englishMountOptions()
      });
      await flushPromises();

      expect(wrapper.text()).toContain('Bind TSUB_KV in Pages and redeploy before switching back');
      const switchButton = wrapper.findAll('button').find(button => button.text().includes('Sync and switch to KV'));
      expect(switchButton).toBeTruthy();
      expect(switchButton.attributes('disabled')).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows external API configured state without rendering the saved token', () => {
    const wrapper = mount(SystemSettings, {
      props: {
        settings: {
          storageType: 'kv',
          secretStatus: { keySource: 'settings', externalApiTokens: { 'external-1': true } },
          externalApi: { enabled: true, tokens: [{ id: 'external-1', name: 'default', token: '', configured: true }] }
        },
        exportBackup: vi.fn(),
        importBackup: vi.fn(),
        handleReset: vi.fn()
      },
      ...englishMountOptions()
    });
    expect(wrapper.text()).toContain('Securely configured; the saved value is not shown again');
    expect(wrapper.text()).toContain('Clear credential');
    expect(wrapper.html()).not.toContain('external-token-value');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import NodePreviewModal from '../../src/components/modals/NodePreview/NodePreviewModal.vue';
import NodeList from '../../src/components/modals/NodePreview/components/NodeList.vue';
import { createI18n } from '../../src/i18n/index.js';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const toastMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/http.js', () => ({
  APIError: class APIError extends Error {},
  api: {
    post: vi.fn(async () => ({
      success: true,
      nodes: [
        {
          id: 'node-1',
          name: 'Demo HK',
          url: 'vless://demo@example.com:443#Demo',
          type: 'vless',
          server: 'example.com',
          port: 443,
          region: 'Hong Kong'
        }
      ],
      stats: {
        protocols: { vless: 1 },
        regions: { 'Hong Kong': 1 }
      }
    }))
  }
}));

vi.mock('../../src/stores/toast.js', () => ({
  useToastStore: () => ({
    showToast: toastMock
  })
}));

const expectNoChineseOrKeys = (text) => {
  expect(text).not.toMatch(/[\u4e00-\u9fff]/);
  expect(text).not.toMatch(/\b(nodePreview|common|actions)\./);
};

describe('NodePreviewModal English translations', () => {
  beforeEach(() => {
    toastMock.mockClear();
  });

  it('renders profile preview header and picking actions in English', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const wrapper = mount(NodePreviewModal, {
      props: {
        show: true,
        profileId: 'profile-1',
        profileName: 'CMSS'
      },
      global: {
        plugins: [pinia, createI18n({ initialLocale: 'en-US' })],
        stubs: {
          Teleport: true,
          NodeFilters: true,
          NodeList: true,
          NodeCard: true,
          NodePagination: true
        }
      }
    });

    await flushPromises();

    expect(wrapper.text()).toContain('CMSS');
    expect(wrapper.text()).toContain('Profile node overview');
    expect(wrapper.text()).toContain('Pick nodes');
    expect(wrapper.text()).toContain('Nodes Total');
    expect(wrapper.text()).toContain('Protocols');
    expect(wrapper.text()).toContain('Regions');
    expect(wrapper.text()).toContain('Total Pages');
    expectNoChineseOrKeys(wrapper.text());

    await wrapper.find('button').trigger('click');

    expect(wrapper.text()).toContain('Exit picking');
    expect(wrapper.text()).toContain('Picking mode');
    expect(wrapper.text()).toContain('Selected');
    expect(wrapper.text()).toContain('Select all');
    expect(wrapper.text()).toContain('Clear');
    expect(wrapper.text()).toContain('Save selection');
    expectNoChineseOrKeys(wrapper.text());
  });

  it('saves selected preview nodes as manual nodes without using a missing store action', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const dataStore = useDataStore();

    const wrapper = mount(NodePreviewModal, {
      props: {
        show: true,
        profileId: 'profile-1',
        profileName: 'CMSS'
      },
      global: {
        plugins: [pinia, createI18n({ initialLocale: 'en-US' })],
        stubs: {
          Teleport: true,
          NodeFilters: true,
          NodeList: true,
          NodeCard: true,
          NodePagination: true
        }
      }
    });

    await flushPromises();

    const findButton = (label) => wrapper.findAll('button').find(button => button.text().includes(label));
    await findButton('Pick nodes').trigger('click');
    await findButton('Select all').trigger('click');
    await findButton('Save selection').trigger('click');
    await flushPromises();

    expect(dataStore.subscriptions).toHaveLength(1);
    expect(dataStore.subscriptions[0]).toMatchObject({
      name: 'Demo HK',
      url: 'vless://demo@example.com:443#Demo',
      enabled: true
    });
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('1'), 'success');
    expect(wrapper.text()).not.toContain('Picking mode');
  });

  it('translates desktop list headers and empty state in both locales', () => {
    const props = { nodes: [], parseNodeInfo: node => node, getProtocolStyle: () => '' };
    const english = mount(NodeList, { props, global: { plugins: [createI18n({ initialLocale: 'en-US' })] } });
    expect(english.text()).toContain('Node Name');
    expect(english.text()).toContain('Server Address');
    expect(english.text()).toContain('No node data');
    expectNoChineseOrKeys(english.text());
    english.unmount();

    const chinese = mount(NodeList, { props, global: { plugins: [createI18n({ initialLocale: 'zh-CN' })] } });
    expect(chinese.text()).toContain('节点名称');
    expect(chinese.text()).toContain('服务器地址');
    expect(chinese.text()).toContain('暂无节点数据');
    chinese.unmount();
  });

  it('keeps the preview body scrollable without clipping virtual rows', () => {
    const modalSource = readFileSync(path.join(process.cwd(), 'src/components/modals/NodePreview/NodePreviewModal.vue'), 'utf8');
    const listSource = readFileSync(path.join(process.cwd(), 'src/components/modals/NodePreview/components/NodeList.vue'), 'utf8');
    const sharedModalSource = readFileSync(path.join(process.cwd(), 'src/components/forms/Modal.vue'), 'utf8');

    expect(modalSource).toContain('panel-class="h-[85dvh] overflow-hidden lg:h-[90dvh]"');
    expect(modalSource).toContain('body-class="flex min-h-0 flex-col !overflow-hidden !px-0 !pb-0"');
    expect(modalSource).toContain('data-testid="node-preview-scroll-region"');
    expect(listSource).toContain('const itemHeight = 57');
    expect(listSource).toContain('h-[57px]');
    expect(sharedModalSource).toContain('z-[90]');
  });
});

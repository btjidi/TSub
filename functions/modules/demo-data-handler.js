import { StorageFactory } from '../storage-adapter.js';
import { createErrorResponse, createJsonResponse } from './utils.js';

export const DEMO_DATA_KEY = 'tsub_demo_data_v1';
export const DEMO_DATA_VERSION = 1;

const uuid = '11111111-2222-4333-8444-555555555555';
const password = 'TSub-Demo-Only';
const gb = value => value * 1024 * 1024 * 1024;
const isoAgo = (now, minutes) => new Date(now - minutes * 60 * 1000).toISOString();
const toBase64 = value => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const vmessUrl = name => {
  const payload = JSON.stringify({ v: '2', ps: name, add: '203.0.113.30', port: '8443', id: uuid, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'demo.invalid', path: '/demo', tls: 'tls', sni: 'demo.invalid' });
  return `vmess://${toBase64(payload)}`;
};

export async function getDemoStorage(env) {
  const type = await StorageFactory.getStorageType(env);
  return StorageFactory.createAdapter(env, type);
}

export const isDemoView = request => String(request?.headers?.get('X-TSub-Demo-View') || '') === '1';

export async function readDemoData(storage) {
  const value = await storage.get(DEMO_DATA_KEY);
  return value && typeof value === 'object' ? value : null;
}

export function createDemoData(now = Date.now()) {
  const seededAt = new Date(now).toISOString();
  const pushHistory = [0, 15, 30, 45, 60].map(minutes => isoAgo(now, minutes));
  const nodes = [
    { id: 'demo-node-vless-sg', name: '演示 · 新加坡 VLESS', group: '亚太', url: `vless://${uuid}@192.0.2.10:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&type=tcp#${encodeURIComponent('演示 · 新加坡 VLESS')}` },
    { id: 'demo-node-trojan-hk', name: '演示 · 香港 Trojan', group: '亚太', url: `trojan://${password}@198.51.100.20:443?security=tls&sni=demo.invalid#${encodeURIComponent('演示 · 香港 Trojan')}` },
    { id: 'demo-node-vmess-jp', name: '演示 · 日本 VMess', group: '亚太', url: vmessUrl('演示 · 日本 VMess') },
    { id: 'demo-node-hy2-us', name: '演示 · 美国 Hysteria2', group: '欧美', url: `hysteria2://${password}@192.0.2.40:51233?security=tls&sni=demo.invalid&insecure=1#${encodeURIComponent('演示 · 美国 Hysteria2')}` },
    { id: 'demo-node-tuic-de', name: '演示 · 德国 TUIC', group: '欧美', url: `tuic://${uuid}:${password}@198.51.100.50:51234?congestion_control=bbr&alpn=h3&sni=demo.invalid&allow_insecure=1#${encodeURIComponent('演示 · 德国 TUIC')}` },
    { id: 'demo-node-anytls-sg', name: '演示 · 新加坡 AnyTLS', group: '亚太', url: `anytls://${password}@203.0.113.60:443?security=tls&sni=demo.invalid&insecure=1#${encodeURIComponent('演示 · 新加坡 AnyTLS')}` },
    { id: 'demo-node-ss-jp', name: '演示 · 日本 SS2022', group: '亚太', url: `ss://${toBase64(`2022-blake3-aes-128-gcm:${password}`).replace(/=+$/g, '')}@192.0.2.70:51235#${encodeURIComponent('演示 · 日本 SS2022')}` },
    { id: 'demo-node-socks-us', name: '演示 · 美国 SOCKS5', group: '备用', url: `socks5://${toBase64(`demo:${password}`).replace(/=+$/g, '')}@198.51.100.80:1080#${encodeURIComponent('演示 · 美国 SOCKS5')}` }
  ].map(item => ({ ...item, enabled: true, demo: true, createdAt: isoAgo(now, 1440), updatedAt: seededAt }));

  const subscriptions = [
    {
      id: 'demo-sub-push-sg', name: '演示 · 新加坡主动推送', url: 'https://demo.invalid/subscriptions/singapore', localUrl: 'http://192.0.2.10:51250/demo', website: 'https://demo.invalid', enabled: true, demo: true,
      nodeCount: 6, pushCount: 48, pushHistory, lastPushAt: pushHistory[0], pushIntervalMinutes: 15, trafficBackend: 'core-singbox', serverAddress: '192.0.2.10',
      userInfo: { upload: gb(3), download: gb(35), total: gb(128), expire: Math.floor((now + 45 * 86400000) / 1000) },
      source: { kind: 'tsub-demo-push', deploymentId: 'demo-deploy-sg', mode: 'push' }, createdAt: isoAgo(now, 43200), updatedAt: seededAt
    },
    {
      id: 'demo-sub-global', name: '演示 · 全球优选线路', url: 'https://subscription.demo.invalid/global', website: 'https://demo.invalid', notes: '演示订阅源，不会发起网络请求', enabled: true, demo: true,
      nodeCount: 18, userInfo: { upload: gb(5), download: gb(57), total: gb(256), expire: Math.floor((now + 90 * 86400000) / 1000) }, createdAt: isoAgo(now, 10080), updatedAt: seededAt
    },
    {
      id: 'demo-sub-snapshot-de', name: '演示 · 德国安装快照', url: 'https://demo.invalid/subscriptions/frankfurt', localUrl: 'http://198.51.100.50:51250/demo', enabled: true, demo: true,
      nodeCount: 3, trafficBackend: 'unavailable', serverAddress: '198.51.100.50', source: { kind: 'tsub-demo-snapshot', deploymentId: 'demo-deploy-de', mode: 'snapshot' }, createdAt: isoAgo(now, 2880), updatedAt: seededAt
    }
  ];

  const profiles = [
    { id: 'demo-profile-daily', customId: 'demo-daily', name: '演示 · 日常使用', enabled: true, isPublic: false, demo: true, subscriptions: ['demo-sub-push-sg', 'demo-sub-global'], manualNodes: ['demo-node-vless-sg', 'demo-node-trojan-hk', 'demo-node-vmess-jp'], downloadCount: 126, createdAt: isoAgo(now, 10080), updatedAt: seededAt },
    { id: 'demo-profile-media', customId: 'demo-media', name: '演示 · 流媒体', enabled: true, isPublic: false, demo: true, subscriptions: ['demo-sub-global', 'demo-sub-snapshot-de'], manualNodes: ['demo-node-hy2-us', 'demo-node-tuic-de', 'demo-node-anytls-sg'], downloadCount: 64, createdAt: isoAgo(now, 4320), updatedAt: seededAt }
  ];

  const deployments = [
    {
      id: 'demo-deploy-sg', schemaVersion: 2, demo: true, name: '演示 · 新加坡 Edge-01', status: 'succeeded', nodeCount: 6, deployedAt: isoAgo(now, 2880), lastSyncAt: pushHistory[0], pushCount: 48, pushHistory,
      createdAt: isoAgo(now, 43200), updatedAt: seededAt, configSummary: { runtime: { core: 'sing-box', tier: 'small' }, protocols: [{ name: '新加坡 VLESS', protocol: 'vless', port: 443 }, { name: '新加坡 HY2', protocol: 'hysteria2', port: 51233 }], subscriptionServer: { enabled: true, port: 51250, pushEnabled: true, pushIntervalMinutes: 15, trafficEnabled: true }, selfSigned: true },
      capabilities: { container: 'lxc', init: 'openrc', memoryMb: 128, rssMb: 43, trafficBackend: 'core-singbox', controlCommand: 'tsub' }
    },
    {
      id: 'demo-deploy-de', schemaVersion: 2, demo: true, name: '演示 · 法兰克福 Edge-02', status: 'offline', nodeCount: 3, deployedAt: isoAgo(now, 5760), lastSyncAt: isoAgo(now, 180), createdAt: isoAgo(now, 10080), updatedAt: seededAt,
      configSummary: { runtime: { core: 'xray', tier: 'tiny' }, protocols: [{ name: '德国 XHTTP', protocol: 'vless', port: 8443 }], subscriptionServer: { enabled: true, port: 51250, pushEnabled: false, pushIntervalMinutes: 15, trafficEnabled: false }, selfSigned: false },
      capabilities: { container: 'openvz', init: 'crontab', memoryMb: 64, rssMb: 38, trafficBackend: 'unavailable', degradedReason: '演示：容器无 CAP_NET_ADMIN，已使用降级启动方式', controlCommand: 'tsub-2' }
    }
  ];

  const operations = [
    { id: 'demo-op-sg-apply', deploymentId: 'demo-deploy-sg', action: 'apply', status: 'succeeded', stage: 'complete', hostname: 'sg-edge.demo.invalid', message: '演示部署安装成功', createdAt: isoAgo(now, 2885), completedAt: isoAgo(now, 2880), events: [{ stage: 'complete', status: 'succeeded', resources: { tier: 'small', memoryMb: 128, rssMb: 43 } }] },
    { id: 'demo-op-sg-status', deploymentId: 'demo-deploy-sg', action: 'status', status: 'succeeded', stage: 'health', hostname: 'sg-edge.demo.invalid', message: '核心与订阅服务运行正常', createdAt: isoAgo(now, 15), completedAt: isoAgo(now, 14), events: [{ stage: 'health', status: 'succeeded', resources: { tier: 'small', memoryMb: 128, rssMb: 43 } }] },
    { id: 'demo-op-de-apply', deploymentId: 'demo-deploy-de', action: 'apply', status: 'succeeded', stage: 'complete', hostname: 'de-edge.demo.invalid', message: '演示部署以降级模式运行', createdAt: isoAgo(now, 5765), completedAt: isoAgo(now, 5760), events: [{ stage: 'complete', status: 'succeeded', resources: { tier: 'tiny', memoryMb: 64, rssMb: 38 } }] }
  ];

  return { version: DEMO_DATA_VERSION, seededAt, subscriptions, nodes, profiles, deployments, operations };
}

const summary = data => ({
  version: data?.version || DEMO_DATA_VERSION,
  seededAt: data?.seededAt || null,
  counts: {
    subscriptions: data?.subscriptions?.length || 0,
    nodes: data?.nodes?.length || 0,
    profiles: data?.profiles?.length || 0,
    deployments: data?.deployments?.length || 0,
    operations: data?.operations?.length || 0
  }
});

export async function handleDemoDataRequest(request, env) {
  const storage = await getDemoStorage(env);
  try {
    if (request.method === 'GET') return createJsonResponse({ success: true, data: summary(await readDemoData(storage)) });
    if (request.method === 'POST') {
      const data = createDemoData();
      await storage.put(DEMO_DATA_KEY, data);
      return createJsonResponse({ success: true, data: summary(data) });
    }
    if (request.method === 'DELETE') {
      await storage.delete(DEMO_DATA_KEY);
      return createJsonResponse({ success: true, data: summary(null) });
    }
    return createErrorResponse('Method Not Allowed', 405);
  } catch (error) {
    return createErrorResponse(error, 500);
  }
}

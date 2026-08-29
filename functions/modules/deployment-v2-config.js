import {
  ALL_TRANSPORTS, PROTOCOL_CAPABILITIES, canonicalTransport, compatibleCoresForInbounds,
  edgeCompatibilityReason, isCloudflareHttpsPort, isConfigurableTransportProtocol, isQuickTunnelCompatible, protocolCapability,
  tlsModesForProtocol, transportsForProtocol
} from '../../shared/deployment-capabilities.js';

const PROTOCOLS = new Set(Object.keys(PROTOCOL_CAPABILITIES));
const TRANSPORTS = new Set(ALL_TRANSPORTS);
const XHTTP_MODES = new Set(['auto', 'packet-up', 'stream-up', 'stream-one']);
const XHTTP_VERSIONS = new Set(['auto', 'h2', 'h3']);
const OUTBOUND_POLICIES = new Set(['direct', 'warp-auto', 'warp-v4', 'warp-v6']);
const EDGE_MODES = new Set(['disabled', 'manual', 'quick', 'managed']);
const EDGE_NODE_MODES = new Set(['direct', 'append', 'only']);
const TIERS = new Set(['auto', 'tiny', 'small', 'standard']);
const CHANNELS = new Set(['stable', 'latest', 'pinned']);
const SECRET_FIELDS = new Set(['password', 'uuid', 'privateKey', 'realityPrivateKey', 'token', 'pushToken', 'apiToken', 'apiSecret', 'secretKey', 'warpPrivateKey', 'tunnelToken', 'tunnelId', 'dnsRecordId', 'previousDnsRecordId']);
const MASK = '********';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUSH_INTERVALS = new Set([5, 15, 30, 60]);
const AGENT_POLL_INTERVALS = new Set([15, 30, 60, 120, 180, 300]);
const NODE_NAME_MODES = new Set(['deployment-protocol-port', 'prefix-protocol-port', 'protocol-random']);
const CONTROL_COMMAND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const PROTOCOL_NAME_ALIASES = Object.freeze({ hysteria2: 'hy2', shadowsocks: 'ss', socks5: 'socks' });
const DEFAULT_TLS_SERVER_NAME = 'www.cloudflare.com';
export const BUILTIN_PROTOCOL_DEFAULTS = Object.freeze({
  vless: { transport: 'tcp', outbound: 'direct', tlsMode: 'reality', serverName: DEFAULT_TLS_SERVER_NAME, path: '/', serviceName: 'tsub' },
  trojan: { transport: 'tcp', outbound: 'direct', tlsMode: 'tls', serverName: DEFAULT_TLS_SERVER_NAME, path: '/', serviceName: 'tsub' },
  vmess: { transport: 'ws', outbound: 'direct', tlsMode: 'none', serverName: '', path: '/tsub', serviceName: 'tsub' },
  hysteria2: { transport: 'hysteria', outbound: 'direct', tlsMode: 'tls', serverName: DEFAULT_TLS_SERVER_NAME, path: '/', serviceName: 'tsub' },
  tuic: { transport: 'quic', outbound: 'direct', tlsMode: 'tls', serverName: DEFAULT_TLS_SERVER_NAME, path: '/', serviceName: 'tsub' },
  anytls: { transport: 'tcp', outbound: 'direct', tlsMode: 'tls', serverName: DEFAULT_TLS_SERVER_NAME, path: '/', serviceName: 'tsub' },
  shadowsocks: { transport: 'tcp', outbound: 'direct', tlsMode: 'none', serverName: '', path: '/', serviceName: 'tsub' },
  socks5: { transport: 'tcp', outbound: 'direct', tlsMode: 'none', serverName: '', path: '/', serviceName: 'tsub' },
  naive: { transport: 'https', outbound: 'direct', tlsMode: 'tls', serverName: DEFAULT_TLS_SERVER_NAME, path: '/', serviceName: 'tsub' }
});

function randomBytes(size) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return bytes; }
function base64(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function randomPassword() { return base64(randomBytes(18)).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function randomToken() { return base64(randomBytes(32)).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function randomUuid() { return crypto.randomUUID(); }
function randomNodeSuffix() {
  let suffix = '';
  while (suffix.length < 10) suffix += base64(randomBytes(8)).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return suffix.slice(0, 10);
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const result = { ...(base || {}) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === MASK) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(result[key], value) : value;
  }
  return result;
}

function mergeNonEmpty(base, override) {
  const result = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) if (value !== '' && value !== null && value !== undefined) result[key] = value;
  return result;
}

function text(value, max = 512) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new Error(`字段长度不能超过 ${max}`);
  return result;
}

function nodeName(value) {
  const result = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (result.length > 80) throw new Error('节点名称长度不能超过 80');
  return result;
}

function nodeNameMode(value) {
  const mode = text(value || 'deployment-protocol-port', 32);
  if (!NODE_NAME_MODES.has(mode)) throw new Error('自动节点命名方式无效');
  return mode;
}

function port(value, label = '端口') {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${label}必须在 1-65535 之间`);
  return number;
}

function validIpv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validIpv6(value) {
  const address = String(value).replace(/^\[|\]$/g, '');
  if (!address.includes(':') || !/^[0-9a-f:]+$/i.test(address)) return false;
  try { return new URL(`http://[${address}]/`).hostname.length > 2; } catch { return false; }
}

function validDnsHostname(value) {
  const hostname = String(value);
  if (!hostname || hostname.length > 253 || /^\d+(?:\.\d+)+$/.test(hostname)) return false;
  return hostname.split('.').every(label => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function validHostname(value) {
  const hostname = String(value);
  return validIpv4(hostname) || validIpv6(hostname) || validDnsHostname(hostname);
}

function optionalPort(value) {
  if (value === '' || value === null || value === undefined) return null;
  return port(value);
}

function addressMode(value) {
  const mode = text(value || 'auto', 16).toLowerCase();
  if (!['auto', 'ipv4', 'ipv6', 'dual'].includes(mode)) throw new Error('协议与订阅 IP 模式无效');
  return mode;
}

function pushAddressMode(value) {
  const mode = text(value || 'auto', 16).toLowerCase();
  if (!['auto', 'ipv4', 'ipv6'].includes(mode)) throw new Error('主动推送 IP 模式无效');
  return mode;
}

export function normalizeDeploymentDefaults(raw = {}) {
  const min = optionalPort(raw.randomPorts?.min) || 10000;
  const max = optionalPort(raw.randomPorts?.max) || 65535;
  if (min > max || max - min < 19) throw new Error('随机端口范围至少需要容纳 20 个端口');
  const protocolDefaults = {};
  for (const protocol of PROTOCOLS) {
    const source = raw.protocolDefaults?.[protocol] || {};
    const requestedTransport = text(source.transport, 16);
    const transport = requestedTransport ? canonicalTransport(protocol, requestedTransport) : '';
    if (transport && !transportsForProtocol(protocol).includes(transport)) throw new Error(`${protocol} 不支持传输 ${transport}`);
    const tlsMode = text(source.tlsMode, 16);
    const effectiveTransport = transport || BUILTIN_PROTOCOL_DEFAULTS[protocol].transport;
    if (tlsMode && !tlsModesForProtocol(protocol, effectiveTransport).includes(tlsMode)) throw new Error(`${protocol} 不支持 ${effectiveTransport} + ${tlsMode} 组合`);
    const outbound = text(source.outbound, 16);
    if (outbound && !protocolCapability(protocol).outbounds.includes(outbound)) throw new Error(`${protocol} 不支持 ${outbound} 出站`);
    protocolDefaults[protocol] = {
      transport, outbound, tlsMode,
      serverName: text(source.serverName, 253), path: text(source.path, 512), serviceName: text(source.serviceName, 128),
      realityPrivateKey: text(source.realityPrivateKey, 128), realityPublicKey: text(source.realityPublicKey, 128), shortId: text(source.shortId, 32)
    };
  }
  return {
    schemaVersion: 2,
    credentials: {
      sharedUuidEnabled: raw.credentials?.sharedUuidEnabled !== false,
      sharedPasswordEnabled: raw.credentials?.sharedPasswordEnabled !== false,
      uuid: text(raw.credentials?.uuid, 64), password: text(raw.credentials?.password, 2048), username: text(raw.credentials?.username || 'tsub', 64)
    },
    randomPorts: { min, max },
    deployment: {
      hostname: text(raw.deployment?.hostname, 253), nodeGroup: text(raw.deployment?.nodeGroup, 120),
      profileId: text(raw.deployment?.profileId, 160), namePrefix: text(raw.deployment?.namePrefix || 'TSub', 80),
      nodeNameMode: nodeNameMode(raw.deployment?.nodeNameMode), addressMode: addressMode(raw.deployment?.addressMode)
    },
    runtime: {
      tier: text(raw.runtime?.tier || 'auto', 16), core: text(raw.runtime?.core || 'auto', 16),
      channel: text(raw.runtime?.channel || 'stable', 16), version: text(raw.runtime?.version, 64),
      confirmHigherTier: raw.runtime?.confirmHigherTier === true,
      agentPollIntervalSeconds: normalizeAgentPollInterval(raw.runtime?.agentPollIntervalSeconds)
    },
    protocolDefaults,
    certificate: {
      mode: text(raw.certificate?.mode || 'self-signed', 32), email: text(raw.certificate?.email, 254),
      apiToken: text(raw.certificate?.apiToken, 2048), certificatePath: text(raw.certificate?.certificatePath, 512),
      keyPath: text(raw.certificate?.keyPath, 512)
    },
    warp: {
      provisioning: text(raw.warp?.provisioning || 'auto', 16), acceptedTerms: raw.warp?.acceptedTerms === true,
      privateKey: text(raw.warp?.privateKey, 256), peerPublicKey: text(raw.warp?.peerPublicKey, 256),
      ipv4: text(raw.warp?.ipv4, 64), ipv6: text(raw.warp?.ipv6, 128)
    },
    edge: normalizeEdgeDefaults(raw.edge),
    tunnel: { mode: text(raw.tunnel?.mode, 16), hostname: text(raw.tunnel?.hostname, 253), token: text(raw.tunnel?.token, 2048) },
    subscriptionServer: {
      enabled: raw.subscriptionServer?.enabled !== false,
      port: optionalPort(raw.subscriptionServer?.port),
      trafficEnabled: raw.subscriptionServer?.trafficEnabled !== false,
      quotaBytes: normalizeQuotaBytes(raw.subscriptionServer?.quotaBytes),
      pushEnabled: raw.subscriptionServer?.pushEnabled !== false,
      pushIntervalMinutes: normalizePushInterval(raw.subscriptionServer?.pushIntervalMinutes),
      pushAddressMode: pushAddressMode(raw.subscriptionServer?.pushAddressMode)
    },
    firewall: { enabled: raw.firewall?.enabled !== false }
  };
}

function normalizeEdgeDefaults(raw = {}) {
  const mode = text(raw?.mode || 'disabled', 16).toLowerCase();
  const endpoints = Array.isArray(raw?.endpoints) ? raw.endpoints.slice(0, 10).map((item, index) => ({
    id: text(item?.id || `edge-${index + 1}`, 64), label: text(item?.label, 24),
    address: text(item?.address, 253), port: optionalPort(item?.port)
  })) : [];
  return {
    mode: EDGE_MODES.has(mode) ? mode : 'disabled', hostname: text(raw?.hostname, 253),
    quickInboundId: text(raw?.quickInboundId, 64), endpoints,
    cloudflare: {
      accountId: text(raw?.cloudflare?.accountId, 64), zoneId: text(raw?.cloudflare?.zoneId, 64), zoneName: text(raw?.cloudflare?.zoneName, 253),
      sslMode: text(raw?.cloudflare?.sslMode, 32), apiToken: text(raw?.cloudflare?.apiToken, 2048)
    }
  };
}

export function mergeDeploymentDefaults(systemDefaults = {}, requestDefaults = {}) {
  const base = normalizeDeploymentDefaults(systemDefaults);
  const merged = deepMerge(base, requestDefaults);
  const preserve = (path) => {
    let source = base; let requested = requestDefaults; let target = merged;
    for (let index = 0; index < path.length - 1; index += 1) {
      source = source?.[path[index]]; requested = requested?.[path[index]]; target = target?.[path[index]];
    }
    const key = path[path.length - 1];
    if (source?.[key] && (!requested || requested[key] === '' || requested[key] === MASK || requested[key] === undefined)) target[key] = source[key];
  };
  for (const path of [
    ['credentials', 'password'], ['certificate', 'apiToken'], ['warp', 'privateKey'],
    ['edge', 'cloudflare', 'apiToken'], ['tunnel', 'token']
  ]) preserve(path);
  return normalizeDeploymentDefaults(merged);
}

export function publicDeploymentDefaults(defaults) {
  const normalized = normalizeDeploymentDefaults(defaults);
  const masked = maskObject(normalized);
  masked.credentials.uuid = normalized.credentials.uuid;
  return masked;
}

function randomPortInRange(min, max, used) {
  const span = max - min + 1;
  for (let attempt = 0; attempt < span * 2; attempt++) {
    const values = randomBytes(4);
    const number = ((values[0] * 0x1000000) + (values[1] << 16) + (values[2] << 8) + values[3]) >>> 0;
    const candidate = min + (number % span);
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
  for (let candidate = min; candidate <= max; candidate++) if (!used.has(candidate)) { used.add(candidate); return candidate; }
  throw new Error('随机端口范围没有可用端口');
}

function normalizeQuotaBytes(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 10 * 1024 ** 5) throw new Error('套餐额度必须是 0-10PB 之间的整数字节数');
  return number;
}

function normalizePushInterval(value) {
  const interval = value === '' || value === null || value === undefined ? 15 : Number(value);
  if (!Number.isInteger(interval) || !PUSH_INTERVALS.has(interval)) throw new Error('主动推送周期必须是 5、15、30 或 60 分钟');
  return interval;
}

function normalizeAgentPollInterval(value) {
  const interval = value === '' || value === null || value === undefined ? 30 : Number(value);
  if (!Number.isInteger(interval) || !AGENT_POLL_INTERVALS.has(interval)) throw new Error('Agent 连接频率必须是 15、30、60、120、180 或 300 秒');
  return interval;
}

function normalizeControlCommand(value) {
  const command = text(value || 'tsub', 32).toLowerCase();
  if (!CONTROL_COMMAND_PATTERN.test(command)) throw new Error('服务器控制命令必须以小写字母开头，并且只能包含小写字母、数字、连字符和下划线');
  return command;
}

export function resolveV2Config(raw = {}, systemDefaults = {}, context = {}) {
  const defaults = mergeDeploymentDefaults(systemDefaults, raw.defaults || {});
  const inboundSources = Array.isArray(raw.inbounds) ? raw.inbounds : [];
  const rawServer = raw.subscription?.server || {};
  const serverEnabled = rawServer.enabled === undefined ? defaults.subscriptionServer.enabled : rawServer.enabled === true;
  const configuredServerPort = rawServer.port === undefined ? defaults.subscriptionServer.port : optionalPort(rawServer.port);
  const requestedServerPort = serverEnabled ? configuredServerPort : null;
  const usedPorts = new Set();
  for (const item of inboundSources) {
    const value = optionalPort(item?.port);
    if (value === null) continue;
    if (usedPorts.has(value)) throw new Error(`端口 ${value} 重复`);
    usedPorts.add(value);
  }
  if (requestedServerPort !== null && usedPorts.has(requestedServerPort)) throw new Error(`订阅端口 ${requestedServerPort} 与代理入站端口重复`);
  if (requestedServerPort !== null) usedPorts.add(requestedServerPort);
  const sharedUuidEnabled = defaults.credentials.sharedUuidEnabled !== false;
  const sharedPasswordEnabled = defaults.credentials.sharedPasswordEnabled !== false;
  const sharedUuid = sharedUuidEnabled ? (defaults.credentials.uuid || randomUuid()) : '';
  const sharedPassword = sharedPasswordEnabled ? (defaults.credentials.password || randomPassword()) : '';
  const deploymentName = nodeName(context.deploymentName);
  const resolvedInbounds = inboundSources.map((source, index) => {
    const protocol = text(source?.protocol, 32).toLowerCase();
    const protocolDefaults = mergeNonEmpty(BUILTIN_PROTOCOL_DEFAULTS[protocol] || {}, defaults.protocolDefaults?.[protocol] || {});
    const tlsSource = source?.tls || {};
    const transportOptions = source?.transportOptions || {};
    const credentials = { ...(source?.credentials || {}) };
    if (['vless', 'vmess', 'tuic'].includes(protocol) && !credentials.uuid) credentials.uuid = sharedUuidEnabled ? sharedUuid : randomUuid();
    if (['trojan', 'hysteria2', 'tuic', 'anytls', 'socks5', 'naive'].includes(protocol) && !credentials.password) {
      credentials.password = sharedPasswordEnabled ? sharedPassword : randomPassword();
    }
    if (protocol === 'socks5' && !credentials.username) credentials.username = defaults.credentials.username;
    if (protocol === 'naive' && !credentials.username) credentials.username = defaults.credentials.username;
    if (protocol === 'shadowsocks' && !credentials.password) credentials.password = base64(randomBytes(16));
    if (protocol === 'shadowsocks' && !credentials.method) credentials.method = '2022-blake3-aes-128-gcm';
    const tlsMode = text(tlsSource.mode || protocolDefaults.tlsMode || 'none', 16);
    const serverName = text(tlsSource.serverName || protocolDefaults.serverName || (tlsMode !== 'none' ? DEFAULT_TLS_SERVER_NAME : ''), 253);
    const resolvedPort = optionalPort(source?.port) || randomPortInRange(defaults.randomPorts.min, defaults.randomPorts.max, usedPorts);
    const explicitName = nodeName(source?.name);
    let resolvedName = explicitName;
    if (!resolvedName && defaults.deployment.nodeNameMode === 'protocol-random') {
      resolvedName = `${PROTOCOL_NAME_ALIASES[protocol] || protocol}-${randomNodeSuffix()}`;
    } else if (!resolvedName) {
      const prefix = defaults.deployment.nodeNameMode === 'deployment-protocol-port'
        ? (deploymentName || defaults.deployment.namePrefix)
        : defaults.deployment.namePrefix;
      resolvedName = `${prefix}-${protocol}-${resolvedPort}`;
    }
    return {
      ...source,
      id: source?.id || `inbound-${index + 1}`,
      name: resolvedName,
      port: resolvedPort,
      transport: source?.transport || protocolDefaults.transport,
      outbound: source?.outbound || protocolDefaults.outbound,
      edgeMode: source?.edgeMode || 'direct',
      credentials,
      tls: {
        ...tlsSource, mode: tlsMode, serverName,
        certificatePath: tlsSource.certificatePath || defaults.certificate.certificatePath,
        keyPath: tlsSource.keyPath || defaults.certificate.keyPath,
        realityPrivateKey: tlsSource.realityPrivateKey || protocolDefaults.realityPrivateKey,
        realityPublicKey: tlsSource.realityPublicKey || protocolDefaults.realityPublicKey,
        shortId: tlsSource.shortId || protocolDefaults.shortId || (tlsMode === 'reality' ? Array.from(randomBytes(4), byte => byte.toString(16).padStart(2, '0')).join('') : '')
      },
      transportOptions: {
        ...transportOptions, path: transportOptions.path || protocolDefaults.path,
        host: Object.prototype.hasOwnProperty.call(transportOptions, 'host') ? transportOptions.host : serverName,
        serviceName: transportOptions.serviceName || protocolDefaults.serviceName,
        xhttpMode: transportOptions.xhttpMode || 'auto', xhttpVersion: transportOptions.xhttpVersion || 'auto',
        bandwidthUp: transportOptions.bandwidthUp || '', bandwidthDown: transportOptions.bandwidthDown || '',
        udpHopPorts: transportOptions.udpHopPorts || '', udpHopInterval: transportOptions.udpHopInterval || ''
      }
    };
  });
  const rawCertificate = raw.certificate || {};
  const certificate = deepMerge(defaults.certificate, rawCertificate);
  if (resolvedInbounds.some(item => item.protocol === 'naive') && certificate.mode === 'self-signed') throw new Error('NaiveProxy 必须使用可信的已有证书或 ACME 证书');
  const tunnel = deepMerge(defaults.tunnel, raw.tunnel || {});
  const tunnels = Array.isArray(raw.tunnels) ? raw.tunnels : (tunnel.mode ? [{ type: tunnel.mode, hostname: tunnel.hostname, token: tunnel.token }] : []);
  const serverPort = serverEnabled ? (requestedServerPort || randomPortInRange(defaults.randomPorts.min, defaults.randomPorts.max, usedPorts)) : null;
  const trafficEnabled = serverEnabled && (rawServer.traffic?.enabled === undefined ? defaults.subscriptionServer.trafficEnabled : rawServer.traffic.enabled === true);
  const requestedPushEnabled = rawServer.pushEnabled === undefined ? defaults.subscriptionServer.pushEnabled : rawServer.pushEnabled === true;
  const edge = deepMerge(defaults.edge, raw.edge || {});
  const pushEnabled = serverEnabled && (edge.mode === 'quick' || requestedPushEnabled);
  const pushIntervalMinutes = normalizePushInterval(rawServer.pushIntervalMinutes === undefined ? defaults.subscriptionServer.pushIntervalMinutes : rawServer.pushIntervalMinutes);
  const quotaBytes = normalizeQuotaBytes(rawServer.traffic?.quotaBytes === undefined ? defaults.subscriptionServer.quotaBytes : rawServer.traffic.quotaBytes);
  const configuredTrafficApiPort = rawServer.traffic?.apiPort === undefined ? null : optionalPort(rawServer.traffic.apiPort);
  if (trafficEnabled && configuredTrafficApiPort !== null && usedPorts.has(configuredTrafficApiPort)) throw new Error(`统计接口端口 ${configuredTrafficApiPort} 与已有端口重复`);
  if (trafficEnabled && configuredTrafficApiPort !== null) usedPorts.add(configuredTrafficApiPort);
  const trafficApiPort = trafficEnabled ? (configuredTrafficApiPort || randomPortInRange(10000, 65535, usedPorts)) : null;
  return normalizeV2Config({
    ...raw,
    inbounds: resolvedInbounds,
    runtime: deepMerge(defaults.runtime, raw.runtime || {}),
    firewall: deepMerge(defaults.firewall, raw.firewall || {}),
    certificate,
    warp: deepMerge(defaults.warp, raw.warp || {}),
    edge,
    tunnels,
    subscription: {
      hostname: raw.subscription?.hostname || defaults.deployment.hostname,
      namePrefix: raw.subscription?.namePrefix || defaults.deployment.namePrefix,
      addressMode: defaults.deployment.addressMode,
      server: {
        enabled: serverEnabled,
        port: serverPort,
        token: serverEnabled ? (text(rawServer.token, 64) || (sharedUuidEnabled ? sharedUuid : randomUuid())) : '',
        pushEnabled,
        pushIntervalMinutes,
        pushAddressMode: pushAddressMode(rawServer.pushAddressMode === undefined ? defaults.subscriptionServer.pushAddressMode : rawServer.pushAddressMode),
        pushToken: pushEnabled ? (text(rawServer.pushToken, 128) || randomToken()) : '',
        pushGeneration: pushEnabled ? (text(rawServer.pushGeneration, 64) || randomUuid()) : '',
        traffic: {
          enabled: trafficEnabled,
          quotaBytes,
          checkpointMinutes: 15,
          apiPort: trafficApiPort,
          apiSecret: trafficEnabled ? (text(rawServer.traffic?.apiSecret, 128) || randomToken()) : ''
        }
      }
    }
  });
}

export function resolveBootstrapConfig(config, connectingAddress = '', detectedAddresses = {}) {
  const resolved = typeof structuredClone === 'function' ? structuredClone(config) : JSON.parse(JSON.stringify(config));
  if (resolved.subscription?.hostname) return resolved;
  const fallback = text(connectingAddress, 253).replace(/^\[|\]$/g, '');
  const ipv4 = text(detectedAddresses.ipv4 || (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(fallback) ? fallback : ''), 64);
  const ipv6 = text(detectedAddresses.ipv6 || (fallback.includes(':') ? fallback : ''), 128);
  const mode = resolved.subscription.addressMode || 'auto';
  if (mode === 'ipv4' && !ipv4) throw new Error('未检测到服务器公网 IPv4 地址');
  if (mode === 'ipv6' && !ipv6) throw new Error('未检测到服务器公网 IPv6 地址');
  if (mode === 'dual' && (!ipv4 || !ipv6)) throw new Error('IPv4+IPv6 模式需要服务器同时具备公网 IPv4 和 IPv6 地址');
  if (mode === 'auto' && !ipv4 && !ipv6) throw new Error('无法自动确定服务器公网地址，请在生成器中填写公网地址');
  resolved.subscription.resolvedAddresses = { ipv4, ipv6 };
  const primary = mode === 'ipv6' ? ipv6 : (ipv4 || ipv6);
  resolved.subscription.hostname = primary.includes(':') ? `[${primary}]` : primary;
  if (mode === 'auto' && !ipv4 && ipv6) {
    for (const inbound of resolved.inbounds || []) {
      if (inbound.listen === '0.0.0.0') inbound.listen = '::';
    }
  }
  return resolved;
}

function normalizeInbound(raw, index) {
  const protocol = text(raw?.protocol, 32).toLowerCase();
  if (!PROTOCOLS.has(protocol)) throw new Error(`入站 ${index + 1} 的协议不受支持`);
  const transport = canonicalTransport(protocol, text(raw?.transport || BUILTIN_PROTOCOL_DEFAULTS[protocol].transport, 16));
  if (!TRANSPORTS.has(transport)) throw new Error(`入站 ${index + 1} 的传输不受支持`);
  if (!transportsForProtocol(protocol).includes(transport)) throw new Error(`${protocol} 不支持 ${transport} 传输`);
  const tlsMode = text(raw?.tls?.mode || 'none', 16).toLowerCase();
  if (!['none', 'tls', 'reality'].includes(tlsMode)) throw new Error('TLS 模式无效');
  if (!tlsModesForProtocol(protocol, transport).includes(tlsMode)) {
    if (protocolCapability(protocol).tls.length === 1 && protocolCapability(protocol).tls[0] === 'tls') throw new Error(`${protocol} 必须启用 TLS`);
    if (tlsMode === 'reality' && protocol === 'vless' && transport === 'ws') throw new Error('Reality 不支持 WebSocket，VLESS Reality 必须使用 TCP/RAW、gRPC 或 XHTTP');
    throw new Error(`${protocol} 不支持 ${transport} + ${tlsMode} 组合`);
  }
  if (tlsMode !== 'none' && !text(raw?.tls?.serverName, 253)) throw new Error(`入站 ${index + 1} 缺少 TLS 域名`);
  if (tlsMode !== 'none' && !validHostname(text(raw?.tls?.serverName, 253))) throw new Error(`入站 ${index + 1} 的 TLS 域名无效`);
  const outbound = text(raw?.outbound || 'direct', 16);
  if (!OUTBOUND_POLICIES.has(outbound)) throw new Error('出站策略无效');
  if (!protocolCapability(protocol).outbounds.includes(outbound)) throw new Error(`${protocol} 不支持 ${outbound} 出站`);
  const edgeMode = text(raw?.edgeMode || 'direct', 16).toLowerCase();
  if (!EDGE_NODE_MODES.has(edgeMode)) throw new Error('CDN 节点模式无效');
  const credentials = {};
  for (const [key, value] of Object.entries(raw?.credentials || {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(key)) continue;
    credentials[key] = text(value, 2048);
  }
  if (['vless', 'vmess', 'tuic'].includes(protocol) && !credentials.uuid) throw new Error(`${protocol} 缺少 UUID`);
  if (credentials.uuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(credentials.uuid)) throw new Error(`${protocol} UUID 无效`);
  if (['trojan', 'hysteria2', 'tuic', 'anytls', 'shadowsocks', 'socks5', 'naive'].includes(protocol) && !credentials.password) throw new Error(`${protocol} 缺少密码`);
  const realityPrivateKey = text(raw?.tls?.realityPrivateKey, 128);
  const realityPublicKey = text(raw?.tls?.realityPublicKey, 128);
  const autoReality = tlsMode === 'reality' && !realityPrivateKey && !realityPublicKey;
  if (tlsMode === 'reality' && !autoReality && (!realityPrivateKey || !realityPublicKey)) throw new Error('Reality 必须同时填写服务端私钥和客户端公钥');
  if (tlsMode === 'reality' && !autoReality && (!/^[A-Za-z0-9_-]{40,64}$/.test(realityPrivateKey) || !/^[A-Za-z0-9_-]{40,64}$/.test(realityPublicKey))) throw new Error('Reality 密钥格式无效');
  if (raw?.tls?.shortId && (!/^[0-9a-f]{2,16}$/i.test(raw.tls.shortId) || raw.tls.shortId.length % 2 !== 0)) throw new Error('Reality Short ID 必须是偶数长度十六进制');
  if (['ws', 'xhttp'].includes(transport) && raw?.transportOptions?.path && !String(raw.transportOptions.path).startsWith('/')) throw new Error('WebSocket/XHTTP 路径必须以 / 开头');
  const xhttpMode = text(raw?.transportOptions?.xhttpMode || 'auto', 16).toLowerCase();
  const xhttpVersion = text(raw?.transportOptions?.xhttpVersion || 'auto', 16).toLowerCase();
  if (!XHTTP_MODES.has(xhttpMode)) throw new Error('XHTTP 模式无效');
  if (!XHTTP_VERSIONS.has(xhttpVersion)) throw new Error('XHTTP HTTP 版本无效');
  if (transport === 'xhttp' && xhttpVersion === 'h3' && tlsMode !== 'tls') throw new Error('XHTTP H3 必须使用 TLS，不能使用 Reality 或明文');
  const bandwidthPattern = /^$|^\d+(?:\.\d+)?(?:k|m|g)?bps$/i;
  const bandwidthUp = text(raw?.transportOptions?.bandwidthUp, 32);
  const bandwidthDown = text(raw?.transportOptions?.bandwidthDown, 32);
  if (!bandwidthPattern.test(bandwidthUp) || !bandwidthPattern.test(bandwidthDown)) throw new Error('Hysteria2 带宽必须使用 Mbps、Kbps 或 Gbps');
  const udpHopPorts = text(raw?.transportOptions?.udpHopPorts, 256);
  if (udpHopPorts && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(udpHopPorts)) throw new Error('Hysteria2 跳跃端口格式无效');
  if (udpHopPorts) {
    for (const segment of udpHopPorts.split(',')) {
      const [startText, endText = startText] = segment.split('-');
      const start = Number(startText); const end = Number(endText);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) throw new Error('Hysteria2 跳跃端口必须在 1-65535 之间且范围顺序正确');
    }
  }
  const udpHopInterval = raw?.transportOptions?.udpHopInterval === '' || raw?.transportOptions?.udpHopInterval == null ? 0 : Number(raw.transportOptions.udpHopInterval);
  if (!Number.isInteger(udpHopInterval) || udpHopInterval < 0 || (udpHopInterval > 0 && udpHopInterval < 5) || udpHopInterval > 300) throw new Error('Hysteria2 跳跃周期必须为 5-300 秒');
  return {
    id: text(raw?.id || `inbound-${index + 1}`, 64), name: nodeName(raw?.name), protocol, port: port(raw?.port), transport,
    listen: text(raw?.listen || '0.0.0.0', 64), outbound, edgeMode,
    tls: { mode: tlsMode, serverName: text(raw?.tls?.serverName, 253), certificatePath: text(raw?.tls?.certificatePath, 512), keyPath: text(raw?.tls?.keyPath, 512), realityPublicKey, realityPrivateKey, shortId: text(raw?.tls?.shortId, 32), autoGenerate: autoReality },
    transportOptions: {
      path: text(raw?.transportOptions?.path || '/', 512), host: text(raw?.transportOptions?.host, 253), serviceName: text(raw?.transportOptions?.serviceName || 'tsub', 128),
      xhttpMode, xhttpVersion, bandwidthUp, bandwidthDown, udpHopPorts, udpHopInterval
    },
    credentials
  };
}

function defaultInboundListen(addressModeValue, hostname = '') {
  const normalizedHostname = String(hostname || '').replace(/^\[|\]$/g, '');
  return addressModeValue === 'ipv6' || addressModeValue === 'dual' || validIpv6(normalizedHostname) ? '::' : '0.0.0.0';
}

function parsePortIntervals(value) {
  if (!value) return [];
  return String(value).split(',').map(segment => {
    const [startText, endText = startText] = segment.split('-');
    return { start: Number(startText), end: Number(endText) };
  });
}

function assertNoHysteriaPortConflicts(inbounds, reservedPorts) {
  const occupied = [...reservedPorts].map(value => ({ start: value, end: value, label: `端口 ${value}` }));
  for (const inbound of inbounds) {
    if (inbound.protocol !== 'hysteria2') continue;
    for (const range of parsePortIntervals(inbound.transportOptions.udpHopPorts)) {
      for (const other of occupied) {
        if (range.start <= other.end && other.start <= range.end) {
          throw new Error(`Hysteria2 跳跃端口 ${range.start === range.end ? range.start : `${range.start}-${range.end}`} 与${other.label}冲突`);
        }
      }
      occupied.push({ ...range, label: `其他 Hysteria2 跳跃端口 ${range.start === range.end ? range.start : `${range.start}-${range.end}`}` });
    }
  }
}

function normalizeEdgeAddress(value) {
  const rawAddress = text(value, 253);
  if ((rawAddress.startsWith('[') || rawAddress.endsWith(']')) && !(rawAddress.startsWith('[') && rawAddress.endsWith(']'))) throw new Error('CDN 优选地址格式无效');
  const address = rawAddress.replace(/^\[|\]$/g, '');
  if (!address || address.includes('://') || /[\s/@?#]/.test(address)) throw new Error('CDN 优选地址必须是 IP 或域名');
  if (!validIpv4(address) && !validIpv6(address) && !validDnsHostname(address)) throw new Error('CDN 优选地址格式无效');
  return address;
}

function normalizeEdge(raw, inbounds, pushEnabled) {
  const mode = text(raw?.mode || 'disabled', 16).toLowerCase();
  if (!EDGE_MODES.has(mode)) throw new Error('CDN/Argo 模式无效');
  const endpointSources = Array.isArray(raw?.endpoints) ? raw.endpoints : [];
  if (endpointSources.length > 10) throw new Error('CDN 优选地址最多 10 条');
  const endpoints = endpointSources.map((item, index) => ({
    id: text(item?.id || `edge-${index + 1}`, 64), label: nodeName(item?.label).slice(0, 24),
    address: normalizeEdgeAddress(item?.address), port: optionalPort(item?.port)
  }));
  const endpointKeys = new Set();
  for (const endpoint of endpoints) {
    const key = `${endpoint.address.toLowerCase()}:${endpoint.port || ''}`;
    if (endpointKeys.has(key)) throw new Error('CDN 优选地址不能重复');
    endpointKeys.add(key);
    if (endpoint.port && !isCloudflareHttpsPort(endpoint.port)) throw new Error('CDN 端口必须是 Cloudflare 支持的 HTTPS 端口');
  }
  const hostname = text(raw?.hostname, 253).toLowerCase();
  const selected = inbounds.filter(item => item.edgeMode !== 'direct');
  if (mode === 'disabled') {
    if (selected.length) throw new Error('启用 CDN 节点前必须选择 CDN/Argo 模式');
  } else {
    if (!selected.length) throw new Error('至少一个入站需要启用 CDN 节点');
    for (const inbound of selected) {
      const reason = edgeCompatibilityReason({ protocol: inbound.protocol, transport: inbound.transport, tlsMode: inbound.tls.mode, xhttpVersion: inbound.transportOptions.xhttpVersion, port: inbound.port }, mode);
      if (reason === 'transport' || reason === 'quickTransport') throw new Error(mode === 'quick' ? 'Quick Tunnel 只能选择一个非 Reality 的 WebSocket 入站' : 'CDN 仅支持 VLESS、VMess 或 Trojan 的 WebSocket、gRPC 或 XHTTP 入站');
      if (reason === 'reality') throw new Error('Reality 入站不能通过 Cloudflare CDN 转发');
      if (reason === 'xhttpH3') throw new Error('CDN/Argo 不支持 XHTTP H3 源站');
      if (reason === 'tls') throw new Error('普通 CDN 源站入站必须启用 TLS');
      if (reason === 'port') throw new Error('普通 CDN 入站必须使用 Cloudflare HTTPS 代理端口');
    }
    if (mode !== 'quick' && (!hostname || !validHostname(hostname))) throw new Error('CDN 入口域名无效');
    if (mode === 'manual') {
      for (const inbound of selected) {
        if (endpoints.some(endpoint => endpoint.port && endpoint.port !== inbound.port)) throw new Error('普通 CDN 优选端口必须与入站端口一致');
      }
    }
    if (mode === 'quick') {
      const quickInboundId = text(raw?.quickInboundId, 64);
      if (selected.length !== 1 || !isQuickTunnelCompatible({ protocol: selected[0].protocol, transport: selected[0].transport, tlsMode: selected[0].tls.mode }) || selected[0].id !== quickInboundId) throw new Error('Quick Tunnel 只能选择一个非 Reality 的 WebSocket 入站');
      if (!pushEnabled) throw new Error('Quick Tunnel 必须启用主动推送');
      if (endpoints.some(endpoint => endpoint.port && endpoint.port !== 443)) throw new Error('Quick Tunnel 优选地址仅支持 443 端口');
    }
    if (mode === 'managed') {
      const accountId = text(raw?.cloudflare?.accountId, 64);
      const apiToken = text(raw?.cloudflare?.apiToken, 2048);
      if (!accountId || !apiToken) throw new Error('托管固定 Tunnel 必须填写 Cloudflare 帐户 ID 和 API 令牌');
      const routeKeys = new Set();
      for (const inbound of selected) {
        const routeKey = inbound.transport === 'grpc' ? `/${inbound.transportOptions.serviceName}` : inbound.transportOptions.path;
        if (routeKeys.has(routeKey)) throw new Error('固定 Tunnel 的入站路径或服务名称不能重复');
        routeKeys.add(routeKey);
      }
    }
  }
  return {
    mode, hostname, quickInboundId: text(raw?.quickInboundId, 64), endpoints,
    cloudflare: {
      accountId: text(raw?.cloudflare?.accountId, 64), zoneId: text(raw?.cloudflare?.zoneId, 64), zoneName: text(raw?.cloudflare?.zoneName, 253),
      sslMode: text(raw?.cloudflare?.sslMode, 32), apiToken: text(raw?.cloudflare?.apiToken, 2048)
    },
    managed: {
      tunnelId: text(raw?.managed?.tunnelId, 64), dnsRecordId: text(raw?.managed?.dnsRecordId, 64),
      zoneId: text(raw?.managed?.zoneId, 64), previousDnsZoneId: text(raw?.managed?.previousDnsZoneId, 64),
      previousDnsRecordId: text(raw?.managed?.previousDnsRecordId, 64), tunnelToken: text(raw?.managed?.tunnelToken, 4096), managedByTsub: raw?.managed?.managedByTsub === true
    }
  };
}

function chooseCore(inbounds, requested) {
  const protocols = new Set(inbounds.map(item => item.protocol));
  if (protocols.has('naive')) {
    if (protocols.size > 1) throw new Error('NaiveProxy 必须作为独立部署运行');
    return 'naive';
  }
  if (!['auto', 'xray', 'sing-box'].includes(requested)) throw new Error('核心选项无效');
  const candidates = compatibleCoresForInbounds(inbounds.map(item => ({ protocol: item.protocol, transport: item.transport, tlsMode: item.tls.mode, outbound: item.outbound })));
  if (!candidates.length) throw new Error('所选协议、传输、TLS 或出站需要双核心或不受支持，当前单核心部署无法承载该组合');
  if (requested !== 'auto' && !candidates.includes(requested)) throw new Error(`${requested === 'xray' ? 'Xray' : 'sing-box'} 核心不支持当前协议、传输或 TLS 组合`);
  if (requested !== 'auto') return requested;
  return candidates.includes('xray') ? 'xray' : candidates[0];
}

export function normalizeV2Config(raw = {}) {
  if (Number(raw.schemaVersion || 2) !== 2) throw new Error('仅支持 schemaVersion 2');
  const inbounds = Array.isArray(raw.inbounds) ? raw.inbounds.map(normalizeInbound) : [];
  if (!inbounds.length || inbounds.length > 20) throw new Error('入站数量必须在 1-20 之间');
  const ports = new Set();
  for (const inbound of inbounds) {
    if (ports.has(inbound.port)) throw new Error(`端口 ${inbound.port} 重复`);
    ports.add(inbound.port);
  }
  const requestedTier = text(raw.runtime?.tier || 'auto', 16);
  if (!TIERS.has(requestedTier)) throw new Error('资源档位无效');
  const channel = text(raw.runtime?.channel || 'stable', 16);
  if (!CHANNELS.has(channel)) throw new Error('核心版本通道无效');
  const core = chooseCore(inbounds, text(raw.runtime?.core || 'auto', 16));
  const needsWarp = inbounds.some(item => item.outbound !== 'direct');
  const warpProvisioning = text(raw.warp?.provisioning || (raw.warp?.privateKey ? 'manual' : 'auto'), 16).toLowerCase();
  if (!['auto', 'manual'].includes(warpProvisioning)) throw new Error('WARP 凭据来源无效');
  const warp = {
    provisioning: warpProvisioning, acceptedTerms: raw.warp?.acceptedTerms === true,
    privateKey: text(raw.warp?.privateKey, 256), peerPublicKey: text(raw.warp?.peerPublicKey, 256),
    ipv4: text(raw.warp?.ipv4, 64), ipv6: text(raw.warp?.ipv6, 128), endpoint: text(raw.warp?.endpoint || '162.159.192.1', 253),
    port: raw.warp?.port ? port(raw.warp.port, 'WARP 端口') : 2408, reserved: Array.isArray(raw.warp?.reserved) ? raw.warp.reserved.slice(0, 3).map(Number) : []
  };
  if (needsWarp && warp.provisioning === 'auto' && !warp.acceptedTerms) throw new Error('自动 WARP 必须确认 Cloudflare WARP 服务条款');
  if (needsWarp && warp.provisioning === 'manual' && (!warp.privateKey || !warp.peerPublicKey || (!warp.ipv4 && !warp.ipv6))) throw new Error('手工 WARP 出站必须导入 WireGuard 私钥、公钥和地址');
  if (warp.provisioning === 'manual' && inbounds.some(item => item.outbound === 'warp-v4') && !warp.ipv4) throw new Error('warp-v4 出站必须导入 IPv4 地址');
  if (warp.provisioning === 'manual' && inbounds.some(item => item.outbound === 'warp-v6') && !warp.ipv6) throw new Error('warp-v6 出站必须导入 IPv6 地址');
  const tunnels = Array.isArray(raw.tunnels) ? raw.tunnels.slice(0, 2).map(item => ({ type: text(item?.type, 16), hostname: text(item?.hostname, 253), token: text(item?.token, 2048) })) : [];
  for (const tunnel of tunnels) {
    if (!['quick', 'named'].includes(tunnel.type)) throw new Error('Cloudflared 隧道类型必须是 quick 或 named');
    if (tunnel.type === 'named' && (!tunnel.hostname || !tunnel.token || !validHostname(tunnel.hostname) || tunnel.token.length < 20)) throw new Error('Named Tunnel 必须填写有效域名和 Token');
    if (tunnel.type === 'quick' && !inbounds.some(item => isQuickTunnelCompatible({ protocol: item.protocol, transport: item.transport, tlsMode: item.tls.mode }))) throw new Error('Quick Tunnel 至少需要一个非 Reality 的 WebSocket 入站');
  }
  const certificate = { mode: text(raw.certificate?.mode || 'existing', 32), email: text(raw.certificate?.email, 254), apiToken: text(raw.certificate?.apiToken, 2048) };
  if (!['existing', 'self-signed', 'acme-http01', 'cloudflare-dns01'].includes(certificate.mode)) throw new Error('证书模式无效');
  const tlsInbounds = inbounds.filter(item => item.tls.mode === 'tls');
  if (certificate.mode === 'existing' && tlsInbounds.some(item => !item.tls.certificatePath || !item.tls.keyPath)) throw new Error('已有证书模式必须填写证书和私钥路径');
  if (certificate.mode === 'existing' && tlsInbounds.some(item => !item.tls.certificatePath.startsWith('/') || !item.tls.keyPath.startsWith('/'))) throw new Error('证书与私钥必须使用绝对路径');
  if (certificate.mode !== 'existing' && certificate.mode !== 'self-signed' && tlsInbounds.length) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(certificate.email)) throw new Error('ACME 证书必须填写有效邮箱');
    if (certificate.mode === 'cloudflare-dns01' && !certificate.apiToken) throw new Error('Cloudflare DNS-01 必须填写 API Token');
    const domains = new Set(tlsInbounds.map(item => item.tls.serverName));
    if (domains.size > 1) throw new Error('首版 ACME 部署要求所有 TLS 入站使用同一域名');
    for (const item of tlsInbounds) { item.tls.certificatePath = `__TSUB_CERT_DIR__/${item.tls.serverName}.crt`; item.tls.keyPath = `__TSUB_CERT_DIR__/${item.tls.serverName}.key`; }
  }
  if (certificate.mode === 'self-signed' && tlsInbounds.length) {
    const certificateServerName = tlsInbounds[0].tls.serverName;
    for (const item of tlsInbounds) {
      item.tls.serverName = certificateServerName;
      item.tls.certificatePath = `__TSUB_CERT_DIR__/${certificateServerName}.crt`;
      item.tls.keyPath = `__TSUB_CERT_DIR__/${certificateServerName}.key`;
      item.tls.insecure = true;
    }
  }
  if (channel === 'pinned' && !text(raw.runtime?.version, 64)) throw new Error('Pinned 通道必须填写核心版本');
  const subscriptionHostname = text(raw.subscription?.hostname, 253);
  if (subscriptionHostname && !validHostname(subscriptionHostname)) throw new Error('节点公网地址无效');
  const subscriptionServerEnabled = raw.subscription?.server?.enabled === true;
  const subscriptionServerPort = subscriptionServerEnabled ? port(raw.subscription?.server?.port, '订阅端口') : null;
  if (subscriptionServerPort !== null && ports.has(subscriptionServerPort)) throw new Error(`订阅端口 ${subscriptionServerPort} 与代理入站端口重复`);
  const subscriptionToken = subscriptionServerEnabled ? text(raw.subscription?.server?.token, 64) : '';
  if (subscriptionServerEnabled && !UUID_PATTERN.test(subscriptionToken)) throw new Error('订阅 Token 必须是有效 UUID');
  const pushToken = subscriptionServerEnabled ? text(raw.subscription?.server?.pushToken, 128) : '';
  const pushGeneration = subscriptionServerEnabled ? text(raw.subscription?.server?.pushGeneration, 64) : '';
  const pushEnabled = subscriptionServerEnabled && raw.subscription?.server?.pushEnabled !== false;
  const pushIntervalMinutes = normalizePushInterval(raw.subscription?.server?.pushIntervalMinutes);
  const resolvedAddressMode = subscriptionHostname ? 'auto' : addressMode(raw.subscription?.addressMode);
  const automaticListen = defaultInboundListen(subscriptionHostname ? 'auto' : resolvedAddressMode, subscriptionHostname);
  inbounds.forEach((inbound, index) => {
    if (!text(raw.inbounds?.[index]?.listen, 64)) inbound.listen = automaticListen;
  });
  const resolvedPushAddressMode = pushAddressMode(raw.subscription?.server?.pushAddressMode);
  if (pushEnabled && !/^[A-Za-z0-9_-]{43}$/.test(pushToken)) throw new Error('主动推送凭证格式无效');
  if (pushEnabled && !UUID_PATTERN.test(pushGeneration)) throw new Error('主动推送配置代格式无效');
  const trafficEnabled = subscriptionServerEnabled && raw.subscription?.server?.traffic?.enabled === true;
  const trafficApiPort = trafficEnabled ? port(raw.subscription?.server?.traffic?.apiPort, '统计接口端口') : null;
  if (trafficApiPort !== null && (ports.has(trafficApiPort) || trafficApiPort === subscriptionServerPort)) throw new Error(`统计接口端口 ${trafficApiPort} 与已有端口重复`);
  const trafficApiSecret = trafficEnabled ? text(raw.subscription?.server?.traffic?.apiSecret, 128) : '';
  if (trafficEnabled && !/^[A-Za-z0-9_-]{43}$/.test(trafficApiSecret)) throw new Error('统计接口凭证格式无效');
  const reservedPorts = new Set(ports);
  if (subscriptionServerPort !== null) reservedPorts.add(subscriptionServerPort);
  if (trafficApiPort !== null) reservedPorts.add(trafficApiPort);
  assertNoHysteriaPortConflicts(inbounds, reservedPorts);
  const edge = normalizeEdge(raw.edge || {}, inbounds, pushEnabled);
  const edgeTunnels = edge.mode === 'quick'
    ? [{ type: 'quick', hostname: edge.hostname, token: '' }]
    : edge.mode === 'managed' && edge.managed.tunnelToken
      ? [{ type: 'named', hostname: edge.hostname, token: edge.managed.tunnelToken }]
      : tunnels;
  return {
    schemaVersion: 2, inbounds,
    outbounds: ['direct', 'warp-auto', 'warp-v4', 'warp-v6'].map(type => ({ type })),
    tunnels: edgeTunnels,
    certificate,
    runtime: {
      tier: requestedTier, core, channel, version: text(raw.runtime?.version, 64),
      confirmHigherTier: raw.runtime?.confirmHigherTier === true,
      agentPollIntervalSeconds: normalizeAgentPollInterval(raw.runtime?.agentPollIntervalSeconds),
      controlCommand: normalizeControlCommand(raw.runtime?.controlCommand)
    },
    firewall: { enabled: raw.firewall?.enabled !== false }, warp, edge,
    subscription: {
      hostname: subscriptionHostname,
      namePrefix: text(raw.subscription?.namePrefix || 'TSub', 80),
      addressMode: resolvedAddressMode,
      resolvedAddresses: raw.subscription?.resolvedAddresses || {},
      server: {
        enabled: subscriptionServerEnabled,
        port: subscriptionServerPort,
        token: subscriptionToken,
        pushEnabled,
        pushIntervalMinutes,
        pushAddressMode: resolvedPushAddressMode,
        pushToken: pushEnabled ? pushToken : '',
        pushGeneration: pushEnabled ? pushGeneration : '',
        traffic: {
          enabled: trafficEnabled,
          quotaBytes: normalizeQuotaBytes(raw.subscription?.server?.traffic?.quotaBytes),
          checkpointMinutes: trafficEnabled ? 15 : 0,
          apiPort: trafficApiPort,
          apiSecret: trafficApiSecret
        }
      }
    }
  };
}

function maskObject(value, key = '') {
  if (Array.isArray(value)) return value.map(item => maskObject(item));
  if (!value || typeof value !== 'object') return SECRET_FIELDS.has(key) && value ? '********' : value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, maskObject(childValue, childKey)]));
}

export function publicV2Config(config) { return maskObject(config); }

function realityMarker(item, kind) {
  const id = String(item.id || 'inbound').replace(/[^A-Za-z0-9_]/g, '_');
  return `__TSUB_REALITY_${kind}_${id}__`;
}

function realityPrivateKey(item) { return item.tls.autoGenerate ? realityMarker(item, 'PRIVATE') : item.tls.realityPrivateKey; }
function realityPublicKey(item) { return item.tls.autoGenerate ? realityMarker(item, 'PUBLIC') : item.tls.realityPublicKey; }
function bandwidthToMbps(value) {
  const match = String(value || '').toLowerCase().match(/^(\d+(?:\.\d+)?)([kmg]?)bps$/);
  if (!match) return '';
  const factor = match[2] === 'g' ? 1000 : (match[2] === 'm' ? 1 : (match[2] === 'k' ? 0.001 : 0.000001));
  return String(Number(match[1]) * factor);
}

function streamSettings(inbound) {
  const method = inbound.protocol === 'hysteria2' ? 'hysteria' : inbound.transport;
  const stream = { method, security: inbound.tls.mode === 'none' ? 'none' : inbound.tls.mode };
  if (inbound.transport === 'ws') stream.wsSettings = { path: inbound.transportOptions.path, headers: inbound.transportOptions.host ? { Host: inbound.transportOptions.host } : {} };
  if (inbound.transport === 'grpc') stream.grpcSettings = { serviceName: inbound.transportOptions.serviceName };
  if (inbound.transport === 'xhttp') stream.xhttpSettings = { path: inbound.transportOptions.path, host: inbound.transportOptions.host || undefined, mode: inbound.transportOptions.xhttpMode };
  if (inbound.protocol === 'hysteria2') stream.hysteriaSettings = { version: 2 };
  if (inbound.tls.mode === 'tls') {
    const alpn = inbound.transport === 'xhttp' && inbound.transportOptions.xhttpVersion !== 'auto' ? [inbound.transportOptions.xhttpVersion] : undefined;
    stream.tlsSettings = { serverName: inbound.tls.serverName, alpn, certificates: inbound.tls.certificatePath ? [{ certificateFile: inbound.tls.certificatePath, keyFile: inbound.tls.keyPath }] : [] };
  }
  if (inbound.tls.mode === 'reality') stream.realitySettings = { dest: `${inbound.tls.serverName}:443`, serverNames: [inbound.tls.serverName], privateKey: realityPrivateKey(inbound), shortIds: [inbound.tls.shortId || ''] };
  if (inbound.protocol === 'hysteria2' && (inbound.transportOptions.bandwidthUp || inbound.transportOptions.bandwidthDown || inbound.transportOptions.udpHopPorts)) {
    const quicParams = { congestion: inbound.transportOptions.bandwidthUp ? 'brutal' : 'bbr' };
    if (inbound.transportOptions.bandwidthUp) quicParams.brutalUp = inbound.transportOptions.bandwidthUp;
    if (inbound.transportOptions.bandwidthDown) quicParams.brutalDown = inbound.transportOptions.bandwidthDown;
    if (inbound.transportOptions.udpHopPorts) quicParams.udpHop = { ports: inbound.transportOptions.udpHopPorts, interval: inbound.transportOptions.udpHopInterval || 30 };
    stream.finalmask = { quicParams };
  }
  return stream;
}

function compileXray(config) {
  const inbounds = config.inbounds.map(item => {
    const protocol = item.protocol === 'socks5' ? 'socks' : (item.protocol === 'hysteria2' ? 'hysteria' : item.protocol);
    let settings;
    if (protocol === 'socks') settings = { auth: 'password', accounts: [{ user: item.credentials.username || 'tsub', pass: item.credentials.password }], udp: true };
    else if (protocol === 'trojan') settings = { users: [{ password: item.credentials.password, email: item.id }] };
    else if (protocol === 'hysteria') settings = { version: 2, users: [{ auth: item.credentials.password, email: item.id }] };
    else if (protocol === 'shadowsocks') settings = { method: item.credentials.method || '2022-blake3-aes-128-gcm', password: item.credentials.password, network: 'tcp,udp' };
    else settings = { users: [{ id: item.credentials.uuid, alterId: 0, email: item.id }], decryption: protocol === 'vless' ? 'none' : undefined };
    const inbound = { tag: item.id, listen: item.listen, port: item.port, protocol, settings };
    if (isConfigurableTransportProtocol(item.protocol) || item.protocol === 'hysteria2') inbound.streamSettings = streamSettings(item);
    return inbound;
  });
  const outbounds = [{ tag: 'direct', protocol: 'freedom' }];
  for (const tag of new Set(config.inbounds.map(item => item.outbound).filter(item => item !== 'direct'))) {
    const automatic = config.warp.provisioning === 'auto';
    const ipv4 = automatic ? '__TSUB_WARP_IPV4__' : config.warp.ipv4;
    const ipv6 = automatic ? '__TSUB_WARP_IPV6__' : config.warp.ipv6;
    const addresses = tag === 'warp-v4' ? [ipv4] : tag === 'warp-v6' ? [ipv6] : [ipv4, ipv6].filter(Boolean);
    outbounds.push({
      tag, protocol: 'wireguard',
      settings: {
        secretKey: automatic ? '__TSUB_WARP_PRIVATE_KEY__' : config.warp.privateKey,
        address: addresses,
        peers: [{ publicKey: automatic ? '__TSUB_WARP_PEER_PUBLIC_KEY__' : config.warp.peerPublicKey, endpoint: `${automatic ? '__TSUB_WARP_ENDPOINT__' : config.warp.endpoint}:${automatic ? '__TSUB_WARP_PORT__' : config.warp.port}` }],
        reserved: automatic ? '__TSUB_WARP_RESERVED__' : config.warp.reserved,
        domainStrategy: tag === 'warp-v4' ? 'ForceIPv4' : tag === 'warp-v6' ? 'ForceIPv6' : 'ForceIP'
      }
    });
  }
  const result = { log: { loglevel: 'warning' }, inbounds, outbounds, routing: { rules: config.inbounds.filter(item => item.outbound !== 'direct').map(item => ({ type: 'field', inboundTag: [item.id], outboundTag: item.outbound })) } };
  if (config.subscription.server.traffic.enabled) {
    result.stats = {};
    result.policy = { system: { statsInboundUplink: true, statsInboundDownlink: true } };
    result.metrics = { tag: 'tsub-metrics', listen: `127.0.0.1:${config.subscription.server.traffic.apiPort}` };
  }
  return result;
}

function singTransport(item) {
  if (!isConfigurableTransportProtocol(item.protocol) || item.transport === 'tcp') return undefined;
  if (item.transport === 'ws') return { type: 'ws', path: item.transportOptions.path, headers: item.transportOptions.host ? { Host: item.transportOptions.host } : undefined };
  if (item.transport === 'grpc') return { type: 'grpc', service_name: item.transportOptions.serviceName };
  return { type: 'http', path: item.transportOptions.path, host: item.transportOptions.host ? [item.transportOptions.host] : undefined };
}

function compileSingBox(config) {
  const typeMap = { shadowsocks: 'shadowsocks', socks5: 'socks', hysteria2: 'hysteria2', anytls: 'anytls', tuic: 'tuic', vless: 'vless', vmess: 'vmess', trojan: 'trojan' };
  const inbounds = config.inbounds.map(item => {
    const result = { type: typeMap[item.protocol], tag: item.id, listen: item.listen, listen_port: item.port };
    const transport = singTransport(item);
    if (transport) result.transport = transport;
    if (item.tls.mode !== 'none') result.tls = { enabled: true, server_name: item.tls.serverName, alpn: item.protocol === 'tuic' ? ['h3'] : undefined, certificate_path: item.tls.certificatePath || undefined, key_path: item.tls.keyPath || undefined, reality: item.tls.mode === 'reality' ? { enabled: true, handshake: { server: item.tls.serverName, server_port: 443 }, private_key: realityPrivateKey(item), short_id: item.tls.shortId } : undefined };
    if (item.protocol === 'shadowsocks') { result.method = item.credentials.method || '2022-blake3-aes-128-gcm'; result.password = item.credentials.password; }
    else if (item.protocol === 'socks5') result.users = [{ username: item.credentials.username || 'tsub', password: item.credentials.password }];
    else if (item.protocol === 'tuic') {
      result.users = [{ name: item.id, uuid: item.credentials.uuid, password: item.credentials.password }];
      result.congestion_control = 'bbr';
    }
    else if (['vless', 'vmess'].includes(item.protocol)) result.users = [{ name: item.id, uuid: item.credentials.uuid }];
    else result.users = [{ name: item.id, password: item.credentials.password }];
    return result;
  });
  const outbounds = [{ type: 'direct', tag: 'direct' }];
  const endpoints = [];
  for (const tag of new Set(config.inbounds.map(item => item.outbound).filter(item => item !== 'direct'))) {
    const automatic = config.warp.provisioning === 'auto';
    const ipv4 = automatic ? '__TSUB_WARP_IPV4__' : config.warp.ipv4;
    const ipv6 = automatic ? '__TSUB_WARP_IPV6__' : config.warp.ipv6;
    const addresses = tag === 'warp-v4' ? [ipv4] : tag === 'warp-v6' ? [ipv6] : [ipv4, ipv6].filter(Boolean);
    const allowedIps = tag === 'warp-v4' ? ['0.0.0.0/0'] : tag === 'warp-v6' ? ['::/0'] : ['0.0.0.0/0', '::/0'];
    endpoints.push({
      type: 'wireguard', tag, system: false, address: addresses,
      private_key: automatic ? '__TSUB_WARP_PRIVATE_KEY__' : config.warp.privateKey,
      peers: [{
        address: automatic ? '__TSUB_WARP_ENDPOINT__' : config.warp.endpoint,
        port: automatic ? '__TSUB_WARP_PORT__' : config.warp.port,
        public_key: automatic ? '__TSUB_WARP_PEER_PUBLIC_KEY__' : config.warp.peerPublicKey,
        allowed_ips: allowedIps,
        persistent_keepalive_interval: 30,
        reserved: automatic ? '__TSUB_WARP_RESERVED__' : config.warp.reserved
      }]
    });
  }
  const result = { log: { level: 'warn', timestamp: true }, inbounds, outbounds, route: { rules: config.inbounds.filter(item => item.outbound !== 'direct').map(item => ({ inbound: [item.id], outbound: item.outbound })) } };
  if (endpoints.length) result.endpoints = endpoints;
  if (config.subscription.server.traffic.enabled) {
    result.experimental = {
      clash_api: {
        external_controller: `127.0.0.1:${config.subscription.server.traffic.apiPort}`,
        secret: config.subscription.server.traffic.apiSecret
      }
    };
  }
  return result;
}

export function compileCoreConfig(config) {
  if (config.runtime.core === 'xray') return compileXray(config);
  if (config.runtime.core === 'sing-box') return compileSingBox(config);
  const item = config.inbounds[0];
  return `https://${item.tls.serverName}:${item.port} {\n  tls ${item.tls.certificatePath} ${item.tls.keyPath}\n  forward_proxy {\n    basic_auth ${item.credentials.username || 'tsub'} ${item.credentials.password}\n    hide_ip\n    hide_via\n    probe_resistance\n  }\n}`;
}

function compileInboundNode(config, item, entry, edge = false) {
    const rawHost = entry.host.replace(/^\[|\]$/g, '');
    const host = rawHost.includes(':') ? `[${rawHost}]` : rawHost;
    const nodeLabel = item.name || `${config.subscription.namePrefix}-${item.protocol}-${item.port}`;
    const name = encodeURIComponent(`${nodeLabel}${entry.suffix || ''}`);
    const portValue = entry.port || item.port;
    const edgeHostname = edge ? String(entry.edgeHostname || '').replace(/^\[|\]$/g, '') : '';
    const tlsMode = edge ? 'tls' : item.tls.mode;
    const tlsServerName = edge ? edgeHostname : item.tls.serverName;
    const transportHost = edge ? edgeHostname : item.transportOptions.host;
    if (item.protocol === 'vmess') {
      const pinned = !edge && config.certificate.mode === 'self-signed' && item.tls.mode === 'tls';
      const payload = { v: '2', ps: decodeURIComponent(name), add: rawHost, port: String(portValue), id: item.credentials.uuid, aid: '0', scy: config.runtime.core === 'sing-box' ? 'none' : 'auto', net: item.transport, type: 'none', host: transportHost, path: item.transport === 'grpc' ? item.transportOptions.serviceName : item.transportOptions.path, tls: tlsMode === 'tls' ? 'tls' : '', sni: tlsServerName, allowInsecure: pinned || item.tls.insecure ? true : undefined, insecure: pinned || item.tls.insecure ? true : undefined, pcs: pinned ? '__TSUB_CERT_PIN_SHA256__' : undefined, spki: pinned ? '__TSUB_CERT_SPKI_SHA256__' : undefined };
      return `vmess://${base64Text(JSON.stringify(payload))}`;
    }
    if (item.protocol === 'shadowsocks') {
      const userInfo = base64Text(`${item.credentials.method || '2022-blake3-aes-128-gcm'}:${item.credentials.password}`).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      return `ss://${userInfo}@${host}:${portValue}#${name}`;
    }
    if (item.protocol === 'naive') {
      const naiveAuthority = item.tls.serverName || rawHost;
      const naiveHost = naiveAuthority.includes(':') ? `[${naiveAuthority}]` : naiveAuthority;
      return `naive+https://${encodeURIComponent(item.credentials.username || 'tsub')}:${encodeURIComponent(item.credentials.password)}@${naiveHost}:${portValue}#${name}`;
    }
    if (item.protocol === 'socks5') return `socks5://${encodeURIComponent(item.credentials.username || 'tsub')}:${encodeURIComponent(item.credentials.password)}@${host}:${portValue}#${name}`;
    const query = new URLSearchParams();
    if (['vless', 'trojan'].includes(item.protocol)) query.set('type', item.transport);
    if (item.protocol === 'vless') query.set('encryption', 'none');
    if (tlsMode !== 'none') { query.set('security', tlsMode); query.set('sni', tlsServerName); }
    if (!edge && config.certificate.mode === 'self-signed' && item.tls.mode === 'tls') {
      query.set(item.protocol === 'hysteria2' ? 'pinSHA256' : 'pcs', '__TSUB_CERT_PIN_SHA256__');
      query.set('spki', '__TSUB_CERT_SPKI_SHA256__');
      query.set('insecure', '1');
      query.set('allowInsecure', '1');
      query.set('allow_insecure', '1');
    } else if (!edge && item.tls.insecure) {
      query.set('insecure', '1');
      query.set('allowInsecure', '1');
    }
    if (!edge && item.tls.mode === 'reality') { query.set('pbk', realityPublicKey(item)); query.set('sid', item.tls.shortId); query.set('fp', 'chrome'); }
    if (item.transport === 'ws' || item.transport === 'xhttp') {
      query.set('path', item.transportOptions.path);
      if (transportHost) query.set('host', transportHost);
    }
    if (item.transport === 'xhttp') {
      query.set('mode', item.transportOptions.xhttpMode);
      if (item.transportOptions.xhttpVersion !== 'auto') query.set('alpn', item.transportOptions.xhttpVersion);
    }
    if (item.transport === 'grpc') query.set('serviceName', item.transportOptions.serviceName);
    if (item.protocol === 'hysteria2') {
      if (item.transportOptions.bandwidthUp) query.set('upmbps', bandwidthToMbps(item.transportOptions.bandwidthUp));
      if (item.transportOptions.bandwidthDown) query.set('downmbps', bandwidthToMbps(item.transportOptions.bandwidthDown));
      if (item.transportOptions.udpHopPorts) query.set('mport', item.transportOptions.udpHopPorts);
      if (item.transportOptions.udpHopInterval) query.set('hopInterval', String(item.transportOptions.udpHopInterval));
    }
    if (item.protocol === 'tuic') {
      query.set('alpn', 'h3');
      query.set('congestion_control', 'bbr');
      query.set('udp_relay_mode', 'native');
    }
    if (item.protocol === 'tuic') return `tuic://${encodeURIComponent(item.credentials.uuid)}:${encodeURIComponent(item.credentials.password || '')}@${host}:${portValue}?${query}#${name}`;
    const secret = item.protocol === 'vless' ? item.credentials.uuid : item.credentials.password;
    return `${item.protocol}://${encodeURIComponent(secret || '')}@${host}:${portValue}?${query}#${name}`;
}

export function compileNodeUrls(config, options = {}) {
  const primary = config.subscription.hostname;
  const runtimeEdgeHostname = String(options.edgeHostname || config.edge?.hostname || '').trim().toLowerCase();
  if (!primary && !runtimeEdgeHostname) return [];
  const mode = config.subscription.addressMode || 'auto';
  const addresses = config.subscription.resolvedAddresses || {};
  const hosts = mode === 'dual'
    ? [{ host: addresses.ipv4, suffix: '-IPv4' }, { host: addresses.ipv6, suffix: '-IPv6' }]
    : [{ host: primary?.replace(/^\[|\]$/g, ''), suffix: '' }];
  const endpoints = config.edge?.endpoints?.length
    ? config.edge.endpoints
    : (runtimeEdgeHostname ? [{ id: 'edge-hostname', label: '', address: runtimeEdgeHostname, port: null }] : []);
  const defaultQuickTunnel = config.edge?.mode === 'quick' && !config.edge?.endpoints?.length;
  return config.inbounds.flatMap(item => {
    const directNodes = item.edgeMode === 'only' ? [] : hosts.filter(entry => entry.host).map(entry => compileInboundNode(config, item, entry));
    if (item.edgeMode === 'direct' || config.edge?.mode === 'disabled' || !runtimeEdgeHostname) return directNodes;
    const edgeNodes = endpoints.map(endpoint => compileInboundNode(config, item, {
      host: endpoint.address,
      port: endpoint.port || (config.edge.mode === 'manual' ? item.port : 443),
      edgeHostname: runtimeEdgeHostname,
      suffix: defaultQuickTunnel ? '-临时隧道' : `-CDN-${endpoint.label || endpoint.address}`
    }, true));
    return [...directNodes, ...edgeNodes];
  });
}

function base64Text(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

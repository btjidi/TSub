import { urlToClashProxy } from '../utils/url-to-clash.js';

const CHAIN_PROTOCOL_ALIASES = Object.freeze({ ss: 'shadowsocks', socks: 'socks5', 'socks5-tls': 'socks5' });
const CHAIN_CORES = Object.freeze({
  vless: ['xray', 'sing-box'], vmess: ['xray', 'sing-box'], trojan: ['xray', 'sing-box'],
  shadowsocks: ['xray', 'sing-box'], socks5: ['xray', 'sing-box'], http: ['xray', 'sing-box'],
  https: ['xray', 'sing-box'], hysteria2: ['xray', 'sing-box'], wireguard: ['xray', 'sing-box'],
  tuic: ['sing-box'], anytls: ['sing-box'], naive: ['sing-box'], snell: ['sing-box']
});

function cleanText(value, max = 2048) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new Error(`链式代理字段长度不能超过 ${max}`);
  return result;
}

function cleanPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('链式上游端口必须在 1-65535 之间');
  return port;
}

function cleanProtocol(value) {
  const raw = cleanText(value, 32).toLowerCase();
  const protocol = CHAIN_PROTOCOL_ALIASES[raw] || raw;
  if (!CHAIN_CORES[protocol]) {
    if (['ssr', 'ssd'].includes(protocol)) throw new Error('链式代理第一版不支持 SSR/SSD 上游');
    throw new Error(`不支持的链式上游协议：${protocol || 'unknown'}`);
  }
  return protocol;
}

function tlsFromProxy(proxy, protocol) {
  const reality = proxy['reality-opts'] || {};
  const enabled = Boolean(proxy.tls || reality['public-key'] || ['https', 'naive', 'hysteria2', 'tuic', 'anytls'].includes(protocol));
  return {
    enabled,
    mode: reality['public-key'] ? 'reality' : (enabled ? 'tls' : 'none'),
    serverName: cleanText(proxy.servername || proxy.sni || '', 253),
    insecure: proxy['skip-cert-verify'] === true,
    alpn: Array.isArray(proxy.alpn) ? proxy.alpn.slice(0, 8).map(value => cleanText(value, 32)) : [],
    publicKey: cleanText(reality['public-key'] || '', 128),
    shortId: cleanText(reality['short-id'] || '', 32),
    clientFingerprint: cleanText(proxy['client-fingerprint'] || '', 64),
    certificatePin: cleanText(proxy.pinnedPeerCertSha256 || '', 128),
    spkiPin: cleanText(proxy.certificatePublicKeySha256 || '', 128)
  };
}

function transportFromProxy(proxy) {
  const transport = cleanText(proxy.network || 'tcp', 32).toLowerCase();
  const ws = proxy['ws-opts'] || {};
  const grpc = proxy['grpc-opts'] || {};
  const xhttp = proxy['xhttp-opts'] || {};
  const h2 = proxy['h2-opts'] || {};
  const http = proxy['http-opts'] || {};
  return {
    type: transport,
    path: cleanText(ws.path || xhttp.path || h2.path || http.path || '/', 512),
    host: cleanText(ws.headers?.Host || xhttp.host || xhttp.headers?.Host || (Array.isArray(h2.host) ? h2.host[0] : h2.host) || (Array.isArray(http.headers?.Host) ? http.headers.Host[0] : http.headers?.Host) || '', 253),
    serviceName: cleanText(grpc['grpc-service-name'] || '', 128),
    mode: cleanText(xhttp.mode || grpc['grpc-mode'] || '', 32)
  };
}

function credentialsFromProxy(proxy, protocol) {
  const credentials = {};
  if (proxy.uuid) credentials.uuid = cleanText(proxy.uuid, 128);
  if (proxy.password) credentials.password = cleanText(proxy.password, 2048);
  if (proxy.username) credentials.username = cleanText(proxy.username, 256);
  if (proxy.cipher || proxy.method) credentials.method = cleanText(proxy.cipher || proxy.method, 128);
  if (proxy.psk) credentials.psk = cleanText(proxy.psk, 2048);
  if (proxy['private-key']) credentials.privateKey = cleanText(proxy['private-key'], 512);
  if (proxy['public-key']) credentials.publicKey = cleanText(proxy['public-key'], 512);
  if (proxy['preshared-key']) credentials.presharedKey = cleanText(proxy['preshared-key'], 512);
  if (protocol === 'tuic') {
    credentials.uuid = cleanText(proxy.uuid, 128);
    credentials.password = cleanText(proxy.password, 2048);
  }
  return credentials;
}

function optionsFromProxy(proxy) {
  return {
    flow: cleanText(proxy.flow || '', 64), alterId: Number(proxy.alterId || 0), cipher: cleanText(proxy.cipher || '', 128),
    udp: proxy.udp !== false, obfs: cleanText(proxy.obfs || '', 64), obfsPassword: cleanText(proxy['obfs-password'] || '', 2048),
    plugin: cleanText(proxy.plugin || '', 128), pluginOptions: proxy['plugin-opts'] && typeof proxy['plugin-opts'] === 'object' ? proxy['plugin-opts'] : {},
    up: cleanText(proxy.up || '', 32), down: cleanText(proxy.down || '', 32), ports: cleanText(proxy.ports || '', 256),
    congestionControl: cleanText(proxy['congestion-controller'] || '', 32), udpRelayMode: cleanText(proxy['udp-relay-mode'] || '', 32),
    wireguardAddresses: Array.isArray(proxy.ip) ? proxy.ip.slice(0, 8).map(value => cleanText(value, 128)) : [],
    allowedIps: Array.isArray(proxy['allowed-ips']) ? proxy['allowed-ips'].slice(0, 16).map(value => cleanText(value, 128)) : [],
    reserved: Array.isArray(proxy.reserved) ? proxy.reserved.slice(0, 3).map(Number) : [], mtu: Number(proxy.mtu || 0),
    persistentKeepalive: Number(proxy['persistent-keepalive'] || 0), version: Number(proxy.version || 0), reuse: proxy.reuse === true
  };
}

export function normalizeChainNodeUrl(url, source = {}) {
  const value = cleanText(url, 8192);
  const proxy = urlToClashProxy(value);
  if (!proxy) throw new Error('无法解析链式上游节点链接');
  const protocol = cleanProtocol(proxy.type);
  const server = cleanText(proxy.server, 253);
  if (!server) throw new Error('链式上游缺少服务器地址');
  const snapshot = {
    protocol,
    name: cleanText(proxy.name || `${protocol}-${server}`, 160),
    server,
    port: cleanPort(proxy.port),
    transport: transportFromProxy(proxy),
    tls: tlsFromProxy(proxy, protocol),
    credentials: credentialsFromProxy(proxy, protocol),
    options: optionsFromProxy(proxy)
  };
  return { source: normalizeChainSource(source, snapshot), snapshot };
}

export function normalizeChainSource(raw = {}, snapshot = {}) {
  const type = cleanText(raw.type || 'url', 32).toLowerCase();
  if (!['deployment', 'subscription', 'manual', 'url'].includes(type)) throw new Error('链式上游来源类型无效');
  return {
    type,
    key: cleanText(raw.key || '', 256),
    sourceId: cleanText(raw.sourceId || '', 160),
    nodeKey: cleanText(raw.nodeKey || '', 256),
    label: cleanText(raw.label || snapshot.name || '', 160),
    routeType: cleanText(raw.routeType || 'direct', 32)
  };
}

export function normalizeChainSnapshot(raw = {}) {
  const protocol = cleanProtocol(raw.protocol);
  const server = cleanText(raw.server, 253);
  if (!server) throw new Error('链式上游缺少服务器地址');
  const snapshot = {
    protocol,
    name: cleanText(raw.name || `${protocol}-${server}`, 160),
    server,
    port: cleanPort(raw.port),
    transport: {
      type: cleanText(raw.transport?.type || 'tcp', 32).toLowerCase(), path: cleanText(raw.transport?.path || '/', 512),
      host: cleanText(raw.transport?.host || '', 253), serviceName: cleanText(raw.transport?.serviceName || '', 128), mode: cleanText(raw.transport?.mode || '', 32)
    },
    tls: {
      enabled: raw.tls?.enabled === true, mode: cleanText(raw.tls?.mode || 'none', 16), serverName: cleanText(raw.tls?.serverName || '', 253),
      insecure: raw.tls?.insecure === true, alpn: Array.isArray(raw.tls?.alpn) ? raw.tls.alpn.slice(0, 8).map(value => cleanText(value, 32)) : [],
      publicKey: cleanText(raw.tls?.publicKey || '', 128), shortId: cleanText(raw.tls?.shortId || '', 32),
      clientFingerprint: cleanText(raw.tls?.clientFingerprint || '', 64), certificatePin: cleanText(raw.tls?.certificatePin || '', 128), spkiPin: cleanText(raw.tls?.spkiPin || '', 128)
    },
    credentials: Object.fromEntries(Object.entries(raw.credentials || {}).map(([key, value]) => [key, cleanText(value, 2048)])),
    options: raw.options && typeof raw.options === 'object' ? raw.options : {}
  };
  if (!snapshot.credentials.uuid && ['vless', 'vmess', 'tuic'].includes(protocol)) throw new Error(`链式 ${protocol} 上游缺少 UUID`);
  if (!snapshot.credentials.password && ['trojan', 'hysteria2', 'tuic', 'anytls', 'shadowsocks', 'naive'].includes(protocol)) throw new Error(`链式 ${protocol} 上游缺少密码`);
  if (!snapshot.credentials.privateKey && protocol === 'wireguard') throw new Error('链式 WireGuard 上游缺少私钥');
  return snapshot;
}

export function chainCoresForProtocol(protocol) {
  return [...(CHAIN_CORES[cleanProtocol(protocol)] || [])];
}

export function publicChainSummary(chain) {
  const snapshot = chain?.snapshot || {};
  return {
    source: chain?.source ? { ...chain.source } : null,
    snapshot: {
      protocol: snapshot.protocol || '', name: snapshot.name || '', server: snapshot.server || '', port: snapshot.port || null,
      transport: snapshot.transport || { type: 'tcp' },
      tls: snapshot.tls ? { enabled: snapshot.tls.enabled === true, mode: snapshot.tls.mode || 'none', serverName: snapshot.tls.serverName || '' } : { enabled: false, mode: 'none', serverName: '' }
    },
    retainedCredentials: true
  };
}

function xrayStream(snapshot) {
  const transport = snapshot.transport || { type: 'tcp' };
  const tls = snapshot.tls || {};
  const result = { network: transport.type === 'xhttp' ? 'xhttp' : transport.type, security: tls.mode === 'reality' ? 'reality' : (tls.enabled ? 'tls' : 'none') };
  if (transport.type === 'ws') result.wsSettings = { path: transport.path || '/', headers: transport.host ? { Host: transport.host } : {} };
  if (transport.type === 'grpc') result.grpcSettings = { serviceName: transport.serviceName || '' };
  if (transport.type === 'xhttp') result.xhttpSettings = { path: transport.path || '/', host: transport.host || undefined, mode: transport.mode || 'auto' };
  if (tls.enabled && tls.mode !== 'reality') result.tlsSettings = { serverName: tls.serverName || snapshot.server, allowInsecure: tls.insecure === true, alpn: tls.alpn?.length ? tls.alpn : undefined, fingerprint: tls.clientFingerprint || undefined };
  if (tls.mode === 'reality') result.realitySettings = { serverName: tls.serverName || snapshot.server, publicKey: tls.publicKey, shortId: tls.shortId, fingerprint: tls.clientFingerprint || 'chrome' };
  return result;
}

export function compileXrayChainOutbound(chain, tag) {
  const s = chain.snapshot;
  const c = s.credentials || {};
  let outbound;
  if (['vless', 'vmess'].includes(s.protocol)) outbound = { tag, protocol: s.protocol, settings: { vnext: [{ address: s.server, port: s.port, users: [{ id: c.uuid, alterId: Number(s.options?.alterId || 0), encryption: s.protocol === 'vless' ? 'none' : undefined, flow: s.options?.flow || undefined }] }] }, streamSettings: xrayStream(s) };
  else if (s.protocol === 'trojan') outbound = { tag, protocol: 'trojan', settings: { servers: [{ address: s.server, port: s.port, password: c.password }] }, streamSettings: xrayStream(s) };
  else if (s.protocol === 'shadowsocks') outbound = { tag, protocol: 'shadowsocks', settings: { servers: [{ address: s.server, port: s.port, method: c.method || s.options?.cipher, password: c.password, network: 'tcp,udp' }] } };
  else if (s.protocol === 'socks5') outbound = { tag, protocol: 'socks', settings: { servers: [{ address: s.server, port: s.port, users: c.username || c.password ? [{ user: c.username || '', pass: c.password || '' }] : undefined }] }, streamSettings: s.tls?.enabled ? xrayStream(s) : undefined };
  else if (['http', 'https'].includes(s.protocol)) outbound = { tag, protocol: 'http', settings: { servers: [{ address: s.server, port: s.port, users: c.username || c.password ? [{ user: c.username || '', pass: c.password || '' }] : undefined }] }, streamSettings: s.protocol === 'https' || s.tls?.enabled ? xrayStream(s) : undefined };
  else if (s.protocol === 'hysteria2') outbound = { tag, protocol: 'hysteria', settings: { version: 2, servers: [{ address: s.server, port: s.port, auth: c.password }] }, streamSettings: xrayStream(s) };
  else if (s.protocol === 'wireguard') outbound = { tag, protocol: 'wireguard', settings: { secretKey: c.privateKey, address: s.options?.wireguardAddresses || [], peers: [{ publicKey: c.publicKey, preSharedKey: c.presharedKey || undefined, endpoint: `${s.server}:${s.port}` }], reserved: s.options?.reserved || [], mtu: s.options?.mtu || undefined, domainStrategy: 'ForceIP' } };
  else throw new Error(`Xray 不支持 ${s.protocol} 链式上游`);
  return outbound;
}

function singTransport(snapshot) {
  const transport = snapshot.transport || { type: 'tcp' };
  if (!transport.type || transport.type === 'tcp') return undefined;
  if (transport.type === 'ws') return { type: 'ws', path: transport.path || '/', headers: transport.host ? { Host: transport.host } : undefined };
  if (transport.type === 'grpc') return { type: 'grpc', service_name: transport.serviceName || '' };
  return { type: transport.type === 'xhttp' ? 'http' : transport.type, path: transport.path || '/', host: transport.host ? [transport.host] : undefined };
}

function singTls(snapshot) {
  const tls = snapshot.tls || {};
  if (!tls.enabled) return undefined;
  const reality = tls.mode === 'reality';
  return {
    enabled: true, server_name: tls.serverName || snapshot.server, insecure: tls.insecure === true,
    alpn: tls.alpn?.length ? tls.alpn : undefined,
    reality: reality ? { enabled: true, public_key: tls.publicKey, short_id: tls.shortId } : undefined,
    utls: reality ? { enabled: true, fingerprint: tls.clientFingerprint || 'chrome' } : undefined
  };
}

export function compileSingBoxChainOutbound(chain, tag) {
  const s = chain.snapshot;
  const c = s.credentials || {};
  const base = { tag, server: s.server, server_port: s.port };
  let outbound;
  if (s.protocol === 'vless') outbound = { ...base, type: 'vless', uuid: c.uuid, flow: s.options?.flow || undefined, tls: singTls(s), transport: singTransport(s) };
  else if (s.protocol === 'vmess') outbound = { ...base, type: 'vmess', uuid: c.uuid, security: s.options?.cipher || 'auto', alter_id: Number(s.options?.alterId || 0), tls: singTls(s), transport: singTransport(s) };
  else if (s.protocol === 'trojan') outbound = { ...base, type: 'trojan', password: c.password, tls: singTls(s), transport: singTransport(s) };
  else if (s.protocol === 'shadowsocks') outbound = { ...base, type: 'shadowsocks', method: c.method || s.options?.cipher, password: c.password, plugin: s.options?.plugin || undefined, plugin_opts: s.options?.pluginOptions || undefined };
  else if (s.protocol === 'socks5') outbound = { ...base, type: 'socks', version: '5', username: c.username || undefined, password: c.password || undefined, network: s.options?.udp === false ? 'tcp' : undefined };
  else if (['http', 'https'].includes(s.protocol)) outbound = { ...base, type: 'http', username: c.username || undefined, password: c.password || undefined, tls: s.protocol === 'https' || s.tls?.enabled ? singTls(s) : undefined };
  else if (s.protocol === 'hysteria2') outbound = { ...base, type: 'hysteria2', password: c.password, up_mbps: Number(s.options?.up || 0) || undefined, down_mbps: Number(s.options?.down || 0) || undefined, obfs: s.options?.obfs ? { type: s.options.obfs, password: s.options?.obfsPassword || '' } : undefined, tls: singTls(s) };
  else if (s.protocol === 'tuic') outbound = { ...base, type: 'tuic', uuid: c.uuid, password: c.password, congestion_control: s.options?.congestionControl || 'bbr', udp_relay_mode: s.options?.udpRelayMode || 'native', tls: singTls(s) };
  else if (s.protocol === 'anytls') outbound = { ...base, type: 'anytls', password: c.password, tls: singTls(s) };
  else if (s.protocol === 'naive') outbound = { ...base, type: 'naive', username: c.username || '', password: c.password, tls: singTls(s) };
  else if (s.protocol === 'snell') outbound = { ...base, type: 'snell', psk: c.psk, version: Number(s.options?.version || 3), reuse_addr: s.options?.reuse === true };
  else if (s.protocol === 'wireguard') outbound = {
    tag,
    type: 'wireguard',
    system: false,
    address: s.options?.wireguardAddresses || [],
    private_key: c.privateKey,
    mtu: s.options?.mtu || undefined,
    peers: [{
      address: s.server,
      port: s.port,
      public_key: c.publicKey,
      pre_shared_key: c.presharedKey || undefined,
      allowed_ips: s.options?.allowedIps?.length ? s.options.allowedIps : ['0.0.0.0/0', '::/0'],
      persistent_keepalive_interval: s.options?.persistentKeepalive || undefined,
      reserved: s.options?.reserved || undefined
    }]
  };
  else throw new Error(`sing-box 不支持 ${s.protocol} 链式上游`);
  return outbound;
}

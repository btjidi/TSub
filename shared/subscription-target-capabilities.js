const STREAM_TRANSPORTS = Object.freeze(['tcp', 'ws', 'grpc']);
const PLAIN_OR_TLS = Object.freeze(['none', 'tls']);
const VMESS_TROJAN_REALITY = Object.freeze(['none', 'tls', 'reality']);
const VLESS_TLS = Object.freeze(['none', 'tls', 'reality']);
const TLS_ONLY = Object.freeze(['tls']);

export const SUBSCRIPTION_TARGET_CAPABILITIES = Object.freeze({
  clash: Object.freeze({
    protocols: Object.freeze(['ss', 'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic', 'anytls', 'snell', 'wireguard', 'http', 'https', 'socks5', 'socks5-tls']),
    transports: Object.freeze({ vmess: Object.freeze(['tcp', 'ws', 'grpc']), vless: Object.freeze(['tcp', 'ws', 'grpc', 'xhttp']), trojan: Object.freeze(['tcp', 'ws', 'grpc']) }),
    tls: Object.freeze({ vmess: VMESS_TROJAN_REALITY, vless: VLESS_TLS, trojan: Object.freeze(['tls', 'reality']), hysteria2: TLS_ONLY, hy2: TLS_ONLY, tuic: TLS_ONLY, anytls: TLS_ONLY, https: TLS_ONLY, 'socks5-tls': TLS_ONLY })
  }),
  singbox: Object.freeze({
    protocols: Object.freeze(['ss', 'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic', 'anytls', 'snell', 'wireguard', 'http', 'https', 'socks5', 'socks5-tls', 'naive']),
    transports: Object.freeze({ vmess: STREAM_TRANSPORTS, vless: STREAM_TRANSPORTS, trojan: STREAM_TRANSPORTS }),
    tls: Object.freeze({ vmess: VMESS_TROJAN_REALITY, vless: VLESS_TLS, trojan: Object.freeze(['tls', 'reality']), hysteria2: TLS_ONLY, hy2: TLS_ONLY, tuic: TLS_ONLY, anytls: TLS_ONLY, https: TLS_ONLY, 'socks5-tls': TLS_ONLY, naive: TLS_ONLY })
  }),
  loon: Object.freeze({
    protocols: Object.freeze(['ss', 'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic', 'wireguard', 'snell', 'http', 'https']),
    transports: Object.freeze({ vmess: Object.freeze(['tcp', 'ws']), vless: Object.freeze(['tcp', 'ws', 'grpc', 'xhttp']), trojan: Object.freeze(['tcp', 'ws']) }),
    tls: Object.freeze({ vmess: PLAIN_OR_TLS, vless: VLESS_TLS, trojan: TLS_ONLY, hysteria2: TLS_ONLY, hy2: TLS_ONLY, tuic: TLS_ONLY, https: TLS_ONLY })
  }),
  surge: Object.freeze({
    protocols: Object.freeze(['ss', 'shadowsocks', 'vmess', 'trojan', 'hysteria2', 'hy2', 'tuic', 'snell', 'wireguard', 'http', 'https', 'socks5', 'anytls']),
    transports: Object.freeze({ vmess: Object.freeze(['tcp', 'ws']), trojan: Object.freeze(['tcp', 'ws']) }),
    tls: Object.freeze({ vmess: PLAIN_OR_TLS, trojan: TLS_ONLY, hysteria2: TLS_ONLY, hy2: TLS_ONLY, tuic: TLS_ONLY, anytls: TLS_ONLY, https: TLS_ONLY })
  }),
  quanx: Object.freeze({
    protocols: Object.freeze(['ss', 'shadowsocks', 'vmess', 'vless', 'trojan', 'http', 'https', 'socks5']),
    transports: Object.freeze({ vmess: Object.freeze(['tcp', 'ws']), vless: Object.freeze(['tcp', 'ws']), trojan: Object.freeze(['tcp', 'ws']) }),
    tls: Object.freeze({ vmess: PLAIN_OR_TLS, vless: VLESS_TLS, trojan: TLS_ONLY, https: TLS_ONLY })
  }),
  egern: Object.freeze({
    protocols: Object.freeze(['ss', 'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic', 'anytls', 'wireguard', 'http', 'https', 'socks5']),
    transports: Object.freeze({ vmess: STREAM_TRANSPORTS, vless: STREAM_TRANSPORTS, trojan: STREAM_TRANSPORTS }),
    tls: Object.freeze({ vmess: VMESS_TROJAN_REALITY, vless: VLESS_TLS, trojan: Object.freeze(['tls', 'reality']), hysteria2: TLS_ONLY, hy2: TLS_ONLY, tuic: TLS_ONLY, anytls: TLS_ONLY, https: TLS_ONLY })
  })
});

function proxyTlsMode(proxy, protocol) {
  if (proxy?.security === 'reality' || proxy?.reality_opts || proxy?.['reality-opts']) return 'reality';
  if (proxy?.tls === true || ['trojan', 'hysteria2', 'hy2', 'tuic', 'anytls', 'https', 'socks5-tls', 'naive'].includes(protocol)) return 'tls';
  return 'none';
}

export function normalizeSubscriptionTarget(target) {
  const normalized = String(target || '').toLowerCase();
  if (normalized.startsWith('surge&ver=')) return 'surge';
  if (normalized === 'sing-box') return 'singbox';
  return normalized;
}

export function targetSupportsProxy(target, proxy) {
  const normalizedTarget = normalizeSubscriptionTarget(target);
  const capability = SUBSCRIPTION_TARGET_CAPABILITIES[normalizedTarget];
  if (!capability) return { supported: false, reason: 'unsupported-target' };
  const protocol = String(proxy?.type || '').toLowerCase();
  if (!capability.protocols.includes(protocol)) return { supported: false, reason: 'unsupported-protocol' };
  const allowedTlsModes = capability.tls[protocol];
  if (allowedTlsModes && !allowedTlsModes.includes(proxyTlsMode(proxy, protocol))) return { supported: false, reason: 'unsupported-tls' };
  if (normalizedTarget === 'singbox' && (proxy?.['skip-cert-verify'] === true || proxy?.skipCertVerify === true)) {
    const spki = String(proxy?.certificatePublicKeySha256 || '');
    if (!/^(?:[A-Za-z0-9+/]{43}=|[0-9a-f]{64})$/i.test(spki)) return { supported: false, reason: 'missing-certificate-pin' };
  }
  const allowedTransports = capability.transports[protocol];
  if (allowedTransports) {
    const transport = String(proxy?.network || 'tcp').toLowerCase();
    if (!allowedTransports.includes(transport)) return { supported: false, reason: 'unsupported-transport' };
  }
  return { supported: true };
}

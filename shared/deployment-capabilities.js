const freezeCapability = capability => Object.freeze({
  ...capability,
  cores: Object.freeze([...capability.cores]),
  transports: Object.freeze(Object.fromEntries(Object.entries(capability.transports).map(([core, values]) => [core, Object.freeze([...values])]))),
  tls: Object.freeze([...capability.tls]),
  outbounds: Object.freeze([...(capability.outbounds || ['direct', 'warp-auto', 'warp-v4', 'warp-v6'])])
});

export const PROTOCOL_CAPABILITIES = Object.freeze({
  vless: freezeCapability({ cores: ['xray', 'sing-box'], transports: { xray: ['tcp', 'ws', 'grpc', 'xhttp'], 'sing-box': ['tcp', 'ws', 'grpc'] }, tls: ['none', 'tls', 'reality'], configurableTransport: true }),
  vmess: freezeCapability({ cores: ['xray', 'sing-box'], transports: { xray: ['tcp', 'ws', 'grpc'], 'sing-box': ['tcp', 'ws', 'grpc'] }, tls: ['none', 'tls'], configurableTransport: true }),
  trojan: freezeCapability({ cores: ['xray', 'sing-box'], transports: { xray: ['tcp', 'ws', 'grpc'], 'sing-box': ['tcp', 'ws', 'grpc'] }, tls: ['tls'], configurableTransport: true }),
  hysteria2: freezeCapability({ cores: ['xray', 'sing-box'], transports: { xray: ['hysteria'], 'sing-box': ['hysteria'] }, tls: ['tls'], nativeTransport: 'hysteria' }),
  tuic: freezeCapability({ cores: ['sing-box'], transports: { 'sing-box': ['quic'] }, tls: ['tls'], nativeTransport: 'quic' }),
  anytls: freezeCapability({ cores: ['sing-box'], transports: { 'sing-box': ['tcp'] }, tls: ['tls'], nativeTransport: 'tcp' }),
  shadowsocks: freezeCapability({ cores: ['xray', 'sing-box'], transports: { xray: ['tcp'], 'sing-box': ['tcp'] }, tls: ['none'], nativeTransport: 'tcp' }),
  socks5: freezeCapability({ cores: ['xray', 'sing-box'], transports: { xray: ['tcp'], 'sing-box': ['tcp'] }, tls: ['none'], nativeTransport: 'tcp' }),
  naive: freezeCapability({ cores: ['naive'], transports: { naive: ['https'] }, tls: ['tls'], nativeTransport: 'https', outbounds: ['direct'] })
});

export const CONFIGURABLE_TRANSPORTS = Object.freeze(['tcp', 'ws', 'grpc', 'xhttp']);
export const ALL_TRANSPORTS = Object.freeze(['tcp', 'ws', 'grpc', 'xhttp', 'hysteria', 'quic', 'https']);
export const CLOUDFLARE_HTTPS_PORTS = Object.freeze([443, 2053, 2083, 2087, 2096, 8443]);

export function protocolCapability(protocol) {
  return PROTOCOL_CAPABILITIES[String(protocol || '').toLowerCase()] || null;
}

export function canonicalTransport(protocol, transport) {
  const normalizedProtocol = String(protocol || '').toLowerCase();
  const value = String(transport || '').toLowerCase();
  if (normalizedProtocol === 'tuic' && (!value || value === 'tcp')) return 'quic';
  if (normalizedProtocol === 'hysteria2' && (!value || value === 'tcp')) return 'hysteria';
  if (normalizedProtocol === 'naive' && (!value || value === 'tcp')) return 'https';
  const capability = protocolCapability(normalizedProtocol);
  return value || capability?.nativeTransport || '';
}

export function transportsForProtocol(protocol, core = 'auto') {
  const capability = protocolCapability(protocol);
  if (!capability) return [];
  const cores = core === 'auto' ? capability.cores : [core];
  return [...new Set(cores.flatMap(item => capability.transports[item] || []))];
}

export function tlsModesForProtocol(protocol, transport, core = 'auto') {
  const capability = protocolCapability(protocol);
  if (!capability) return [];
  const canonical = canonicalTransport(protocol, transport);
  const transportSupported = transportsForProtocol(protocol, core).includes(canonical);
  if (!transportSupported) return [];
  if (protocol === 'vless' && canonical === 'ws') return capability.tls.filter(mode => mode !== 'reality');
  return [...capability.tls];
}

export function compatibleCoresForInbound({ protocol, transport, tlsMode, outbound = 'direct' } = {}) {
  const capability = protocolCapability(protocol);
  if (!capability || !capability.outbounds.includes(outbound)) return [];
  const canonical = canonicalTransport(protocol, transport);
  return capability.cores.filter(core => (
    (capability.transports[core] || []).includes(canonical)
    && tlsModesForProtocol(protocol, canonical, core).includes(tlsMode)
  ));
}

export function compatibleCoresForInbounds(inbounds = []) {
  if (!inbounds.length) return [];
  return inbounds.reduce((candidates, inbound) => {
    const supported = new Set(compatibleCoresForInbound(inbound));
    return candidates.filter(core => supported.has(core));
  }, ['xray', 'sing-box', 'naive']);
}

export function isConfigurableTransportProtocol(protocol) {
  return protocolCapability(protocol)?.configurableTransport === true;
}

export function isEdgeTransport(transport) {
  return ['ws', 'grpc', 'xhttp'].includes(String(transport || '').toLowerCase());
}

export function isQuickTunnelCompatible({ protocol, transport, tlsMode } = {}) {
  return ['vless', 'vmess', 'trojan'].includes(protocol)
    && transport === 'ws'
    && tlsMode !== 'reality';
}

export function isCloudflareHttpsPort(port) {
  return CLOUDFLARE_HTTPS_PORTS.includes(Number(port));
}

export function edgeCompatibilityReason({ protocol, transport, tlsMode, xhttpVersion = 'auto', port } = {}, mode = 'managed') {
  if (mode === 'disabled') return 'disabled';
  if (!isConfigurableTransportProtocol(protocol) || !isEdgeTransport(transport)) return 'transport';
  if (tlsMode === 'reality') return 'reality';
  if (transport === 'xhttp' && xhttpVersion === 'h3') return 'xhttpH3';
  if (mode === 'quick' && !isQuickTunnelCompatible({ protocol, transport, tlsMode })) return 'quickTransport';
  if (mode === 'manual' && tlsMode !== 'tls') return 'tls';
  if (mode === 'manual' && !isCloudflareHttpsPort(port)) return 'port';
  return '';
}

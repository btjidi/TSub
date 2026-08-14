import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_CAPABILITIES, canonicalTransport, compatibleCoresForInbound,
  compatibleCoresForInbounds, edgeCompatibilityReason, isCloudflareHttpsPort, tlsModesForProtocol, transportsForProtocol
} from '../../shared/deployment-capabilities.js';
import { compileCoreConfig, compileNodeUrls, normalizeV2Config } from '../../functions/modules/deployment-v2-config.js';
import { generateProxiesOnly } from '../../functions/modules/subscription/builtin-clash-generator.js';
import { generateBuiltinSingboxConfig } from '../../functions/modules/subscription/builtin-singbox-generator.js';
import yaml from 'js-yaml';

const uuid = '79411d85-b0dc-4cd2-b46c-01789a18c650';
const credentials = protocol => {
  if (['vless', 'vmess'].includes(protocol)) return { uuid };
  if (protocol === 'tuic') return { uuid, password: 'secret' };
  if (protocol === 'socks5') return { username: 'tsub', password: 'secret' };
  if (protocol === 'shadowsocks') return { method: '2022-blake3-aes-128-gcm', password: 'dGVzdC10ZXN0LXRlc3Q=' };
  return { password: 'secret', username: protocol === 'naive' ? 'tsub' : undefined };
};
const inbound = (protocol, transport, tlsMode) => ({
  id: `${protocol}-main`, protocol, port: 51231, transport, outbound: 'direct', credentials: credentials(protocol),
  tls: { mode: tlsMode, serverName: tlsMode === 'none' ? '' : 'node.example', certificatePath: tlsMode === 'tls' ? '/cert' : '', keyPath: tlsMode === 'tls' ? '/key' : '', realityPrivateKey: tlsMode === 'reality' ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' : '', realityPublicKey: tlsMode === 'reality' ? 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' : '' }
});

describe('deployment protocol capability matrix', () => {
  it('defines one canonical transport set for every deployment protocol', () => {
    expect(Object.keys(PROTOCOL_CAPABILITIES)).toEqual(['vless', 'vmess', 'trojan', 'hysteria2', 'tuic', 'anytls', 'shadowsocks', 'socks5', 'naive']);
    expect(transportsForProtocol('vless', 'xray')).toEqual(['tcp', 'ws', 'grpc', 'xhttp']);
    expect(transportsForProtocol('vless', 'sing-box')).toEqual(['tcp', 'ws', 'grpc']);
    expect(canonicalTransport('tuic', 'tcp')).toBe('quic');
    expect(canonicalTransport('hysteria2', 'tcp')).toBe('hysteria');
    expect(canonicalTransport('naive', 'tcp')).toBe('https');
  });

  it('restricts Reality and computes a whole-deployment core intersection', () => {
    expect(tlsModesForProtocol('vless', 'ws')).toEqual(['none', 'tls']);
    expect(tlsModesForProtocol('vmess', 'tcp')).not.toContain('reality');
    expect(tlsModesForProtocol('trojan', 'grpc')).not.toContain('reality');
    expect(tlsModesForProtocol('vless', 'grpc')).toContain('reality');
    expect(compatibleCoresForInbound({ protocol: 'vless', transport: 'xhttp', tlsMode: 'tls', outbound: 'direct' })).toEqual(['xray']);
    expect(compatibleCoresForInbounds([
      { protocol: 'vless', transport: 'xhttp', tlsMode: 'tls', outbound: 'direct' },
      { protocol: 'tuic', transport: 'quic', tlsMode: 'tls', outbound: 'direct' }
    ])).toEqual([]);
  });

  it('shares Cloudflare edge and Tunnel constraints across consumers', () => {
    expect(isCloudflareHttpsPort(8443)).toBe(true);
    expect(isCloudflareHttpsPort(51231)).toBe(false);
    expect(edgeCompatibilityReason({ protocol: 'vless', transport: 'ws', tlsMode: 'none', port: 51231 }, 'quick')).toBe('');
    expect(edgeCompatibilityReason({ protocol: 'vless', transport: 'grpc', tlsMode: 'none', port: 51231 }, 'quick')).toBe('quickTransport');
    expect(edgeCompatibilityReason({ protocol: 'tuic', transport: 'quic', tlsMode: 'tls', port: 443 }, 'managed')).toBe('transport');
    expect(edgeCompatibilityReason({ protocol: 'vless', transport: 'ws', tlsMode: 'tls', port: 51231 }, 'manual')).toBe('port');
    expect(edgeCompatibilityReason({ protocol: 'vless', transport: 'xhttp', tlsMode: 'tls', xhttpVersion: 'h3', port: 443 }, 'managed')).toBe('xhttpH3');
  });

  it('accepts every declared configurable transport on its supported core', () => {
    for (const [protocol, capability] of Object.entries(PROTOCOL_CAPABILITIES)) {
      if (protocol === 'naive') continue;
      for (const core of capability.cores) {
        for (const transport of capability.transports[core]) {
          for (const tlsMode of tlsModesForProtocol(protocol, transport, core)) {
            const config = normalizeV2Config({ inbounds: [inbound(protocol, transport, tlsMode)], runtime: { core }, certificate: { mode: 'existing' } });
            expect(config).toMatchObject({ runtime: { core }, inbounds: [{ protocol, transport, tls: { mode: tlsMode } }] });
          }
        }
      }
    }
  });

  it('rejects protocol-native transport substitutions before compilation', () => {
    for (const [protocol, invalidTransport] of [['tuic', 'ws'], ['hysteria2', 'grpc'], ['anytls', 'ws'], ['shadowsocks', 'grpc'], ['socks5', 'ws']]) {
      const tlsMode = ['tuic', 'hysteria2', 'anytls'].includes(protocol) ? 'tls' : 'none';
      expect(() => normalizeV2Config({ inbounds: [inbound(protocol, invalidTransport, tlsMode)] })).toThrow(/不支持/);
    }
    expect(() => normalizeV2Config({ inbounds: [inbound('vless', 'ws', 'reality')] })).toThrow(/Reality.*WebSocket/);
  });

  it('omits native transport metadata and exports self-signed client compatibility flags', () => {
    const config = normalizeV2Config({
      inbounds: [
        { ...inbound('tuic', 'tcp', 'tls'), port: 51231 },
        { ...inbound('anytls', 'tcp', 'tls'), id: 'anytls-main', port: 51232 }
      ],
      runtime: { core: 'sing-box' }, certificate: { mode: 'self-signed' }, subscription: { hostname: '203.0.113.7' }
    });
    expect(config.inbounds[0].transport).toBe('quic');
    const compiled = compileCoreConfig(config);
    expect(compiled.inbounds.every(item => !Object.hasOwn(item, 'transport'))).toBe(true);
    const [tuic, anytls] = compileNodeUrls(config);
    expect(tuic).not.toContain('type=');
    expect(tuic).toContain('alpn=h3');
    expect(tuic).toContain('congestion_control=bbr');
    expect(tuic).toContain('udp_relay_mode=native');
    expect(tuic).toContain('insecure=1');
    expect(tuic).toContain('allowInsecure=1');
    expect(tuic).toContain('allow_insecure=1');
    expect(anytls).not.toContain('type=');
    expect(anytls).toContain('insecure=1');
    expect(anytls).toContain('allowInsecure=1');
  });

  it('does not emit V2Ray transport objects for native Shadowsocks and SOCKS5 inbounds', () => {
    const config = normalizeV2Config({
      inbounds: [{ ...inbound('shadowsocks', 'tcp', 'none'), port: 51231 }, { ...inbound('socks5', 'tcp', 'none'), id: 'socks-main', port: 51232 }],
      runtime: { core: 'sing-box' }
    });
    expect(compileCoreConfig(config).inbounds.every(item => !Object.hasOwn(item, 'transport'))).toBe(true);
  });

  it('keeps native links free of transport metadata through Clash and sing-box conversion', () => {
    const protocols = ['hysteria2', 'tuic', 'anytls', 'shadowsocks', 'socks5'];
    const config = normalizeV2Config({
      inbounds: protocols.map((protocol, index) => ({
        ...inbound(protocol, PROTOCOL_CAPABILITIES[protocol].nativeTransport, ['hysteria2', 'tuic', 'anytls'].includes(protocol) ? 'tls' : 'none'),
        id: `${protocol}-main`, name: `${protocol}-native`, port: 51231 + index
      })),
      runtime: { core: 'sing-box' }, certificate: { mode: 'self-signed' }, subscription: { hostname: '203.0.113.7' }
    });
    const links = compileNodeUrls(config);
    expect(links).toHaveLength(protocols.length);
    expect(links.every(link => !/[?&]type=/.test(link))).toBe(true);

    const singBox = JSON.parse(generateBuiltinSingboxConfig(links.join('\n')));
    for (const protocol of ['hysteria2', 'tuic', 'anytls', 'shadowsocks', 'socks']) {
      const outbound = singBox.outbounds.find(item => item.type === protocol);
      expect(outbound).toBeTruthy();
      expect(outbound).not.toHaveProperty('transport');
    }

    const clash = yaml.load(generateProxiesOnly(links.join('\n')));
    const nativeProxies = clash.proxies.filter(item => ['hysteria2', 'tuic', 'anytls', 'ss', 'socks5'].includes(item.type));
    expect(nativeProxies).toHaveLength(protocols.length);
    expect(nativeProxies.every(item => !Object.hasOwn(item, 'network'))).toBe(true);
  });
});

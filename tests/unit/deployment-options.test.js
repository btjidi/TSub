import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_ACTIONS, NATIVE_TRANSPORT_LABELS, OUTBOUND_OPTIONS, PROTOCOL_OPTIONS, RESOURCE_TIERS, TRANSPORT_OPTIONS } from '../../src/constants/deployment-options.js';

describe('V2 deployment generator option matrix', () => {
  it('exposes the complete TSub Proxy protocol baseline', () => {
    expect(PROTOCOL_OPTIONS.map(item => item.value)).toEqual([
      'vless', 'vmess', 'trojan', 'hysteria2', 'tuic', 'anytls', 'shadowsocks', 'socks5', 'naive'
    ]);
    expect(PROTOCOL_OPTIONS.find(item => item.value === 'naive').cores).toEqual(['naive']);
    expect(TRANSPORT_OPTIONS.map(([value]) => value)).toEqual(['tcp', 'ws', 'grpc', 'xhttp']);
    expect(NATIVE_TRANSPORT_LABELS).toMatchObject({ hysteria2: 'Hysteria2 / QUIC', tuic: 'TUIC / QUIC', anytls: 'AnyTLS / TCP', shadowsocks: 'TCP + UDP', socks5: 'TCP + UDP' });
  });

  it('uses per-inbound WARP policies and declarative operations', () => {
    expect(OUTBOUND_OPTIONS.map(([value]) => value)).toEqual(['direct', 'warp-auto', 'warp-v4', 'warp-v6']);
    expect(RESOURCE_TIERS.map(([value]) => value)).toEqual(['auto', 'tiny', 'small', 'standard']);
    expect(DEPLOYMENT_ACTIONS.map(([action]) => action)).toEqual([
      'plan', 'apply', 'status', 'list', 'update', 'update-runtime', 'restart', 'repair', 'doctor', 'rollback', 'uninstall'
    ]);
  });

  it('keeps Xray and sing-box protocol capabilities explicit', () => {
    expect(PROTOCOL_OPTIONS.filter(item => item.cores.includes('xray')).map(item => item.value)).toEqual(['vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'socks5']);
    expect(PROTOCOL_OPTIONS.filter(item => item.cores.includes('sing-box')).map(item => item.value)).toEqual(['vless', 'vmess', 'trojan', 'hysteria2', 'tuic', 'anytls', 'shadowsocks', 'socks5']);
  });
});

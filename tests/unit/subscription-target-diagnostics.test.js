import { describe, expect, it } from 'vitest';
import { transformBuiltinSubscriptionDetailed } from '../../functions/modules/subscription/transformer-factory.js';

const VMESS_GRPC = `vmess://${btoa(JSON.stringify({ v: '2', ps: 'VMess gRPC', add: 'vmess.example.invalid', port: '443', id: '79411d85-b0dc-4cd2-b46c-01789a18c650', aid: '0', net: 'grpc', path: 'edge-service', host: 'tls.example.invalid', tls: 'tls', sni: 'tls.example.invalid' }))}`;
const VLESS_XHTTP = 'vless://79411d85-b0dc-4cd2-b46c-01789a18c650@vless.example.invalid:443?type=xhttp&security=tls&sni=tls.example.invalid&host=transport.example.invalid&path=%2Fx#VLESS%20XHTTP';
const VLESS_REALITY = 'vless://79411d85-b0dc-4cd2-b46c-01789a18c650@vless.example.invalid:443?type=grpc&security=reality&sni=tls.example.invalid&serviceName=edge&pbk=ZmFrZS1wdWJsaWMta2V5&sid=0123456789abcdef#VLESS%20Reality';
const NAIVE = 'naive+https://user:password@naive.example.invalid:443#Naive';

describe('subscription target diagnostics', () => {
  it('renders native sing-box gRPC without a fake TCP transport and filters XHTTP', () => {
    const result = transformBuiltinSubscriptionDetailed(`${VMESS_GRPC}\n${VLESS_XHTTP}\n`, 'singbox');
    const config = JSON.parse(result.content);
    const vmess = config.outbounds.find(item => item.type === 'vmess');
    expect(vmess.transport).toEqual({ type: 'grpc', service_name: 'edge-service' });
    expect(result.diagnostics).toMatchObject({ total: 2, rendered: 1, omitted: 1 });
    expect(result.diagnostics.items[0]).toMatchObject({ protocol: 'vless', transport: 'xhttp', reason: 'unsupported-transport' });
  });

  it('keeps Naive only for targets with a native representation', () => {
    const singbox = transformBuiltinSubscriptionDetailed(NAIVE, 'singbox');
    expect(JSON.parse(singbox.content).outbounds).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'naive', server: 'naive.example.invalid' })]));
    expect(singbox.diagnostics.warnings[0].reason).toBe('client-build-capability-required');
    const loon = transformBuiltinSubscriptionDetailed(NAIVE, 'loon');
    expect(loon.diagnostics).toMatchObject({ total: 1, rendered: 0, omitted: 1 });
    expect(loon.diagnostics.items[0].reason).toBe('unsupported-protocol');
  });

  it('does not disguise unsupported gRPC as HTTP or TLS for Quantumult X', () => {
    const result = transformBuiltinSubscriptionDetailed(VMESS_GRPC, 'quanx');
    expect(result.diagnostics.items[0]).toMatchObject({ transport: 'grpc', reason: 'unsupported-transport' });
    expect(result.content).not.toContain('vmess=');
  });

  it('keeps Reality only when the target can express the TLS mode and transport together', () => {
    const singbox = transformBuiltinSubscriptionDetailed(VLESS_REALITY, 'singbox');
    expect(JSON.parse(singbox.content).outbounds.find(item => item.type === 'vless')).toMatchObject({
      transport: { type: 'grpc', service_name: 'edge' },
      tls: { reality: { enabled: true, public_key: 'ZmFrZS1wdWJsaWMta2V5', short_id: '0123456789abcdef' } }
    });
    const unsupported = transformBuiltinSubscriptionDetailed(VLESS_REALITY, 'surge');
    expect(unsupported.diagnostics.items[0]).toMatchObject({ protocol: 'vless', reason: 'unsupported-protocol' });
  });

  it('filters insecure TLS nodes without SPKI only from strict sing-box output', () => {
    const node = 'trojan://password@trojan.example.invalid:443?security=tls&sni=tls.example.invalid&allowInsecure=1#Self-signed';
    const result = transformBuiltinSubscriptionDetailed(node, 'singbox');
    expect(result.diagnostics.items[0]).toMatchObject({ protocol: 'trojan', reason: 'missing-certificate-pin' });
    expect(result.diagnostics.rendered).toBe(0);
  });

  it('normalizes Hysteria2 URI hop ranges for sing-box', () => {
    const spki = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
    const node = `hysteria2://password@hy2.example.invalid:443?sni=tls.example.invalid&allowInsecure=1&spki=${encodeURIComponent(spki)}&mport=20000-20010&hopInterval=30#HY2`;
    const config = JSON.parse(transformBuiltinSubscriptionDetailed(node, 'singbox').content);
    expect(config.outbounds.find(item => item.type === 'hysteria2')).toMatchObject({ server_ports: ['20000:20010'], hop_interval: '30s' });
  });
});

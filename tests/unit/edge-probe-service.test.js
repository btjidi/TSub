// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { deriveEdgeProbe, publicEdgeProbeResult } from '../../functions/services/edge-probe-service.js';

const config = () => ({
  edge: {
    mode: 'manual', hostname: 'cdn.example.com',
    endpoints: [
      { id: 'ip', address: '203.0.113.8', port: 8443 },
      { id: 'host', address: 'www.visa.cn', port: 8443 }
    ]
  },
  inbounds: [
    { id: 'ws', edgeMode: 'append', port: 8443, transport: 'ws', transportOptions: { path: '/edge' } },
    { id: 'grpc', edgeMode: 'only', port: 8443, transport: 'grpc', transportOptions: { serviceName: 'rpc' } },
    { id: 'direct', edgeMode: 'direct', port: 8443, transport: 'ws', transportOptions: { path: '/direct' } }
  ]
});

describe('edge probe derivation', () => {
  it('derives only saved endpoint and inbound data', () => {
    expect(deriveEdgeProbe(config(), { inboundId: 'ws', endpointId: 'ip', configRevision: 7 })).toEqual({
      hostname: 'cdn.example.com', address: '203.0.113.8', port: 8443, path: '/edge', inboundId: 'ws', endpointId: 'ip'
    });
    expect(deriveEdgeProbe(config(), { inboundId: 'ws', endpointId: 'host', configRevision: 7 })).toMatchObject({ address: 'www.visa.cn' });
  });

  it('rejects arbitrary targets and unsupported inbound transports', () => {
    expect(() => deriveEdgeProbe(config(), { inboundId: 'missing', endpointId: 'ip', configRevision: 1 })).toThrowError('edge_probe_inbound_unavailable');
    expect(() => deriveEdgeProbe(config(), { inboundId: 'ws', endpointId: 'arbitrary-host', configRevision: 1 })).toThrowError('edge_probe_endpoint_unavailable');
    expect(() => deriveEdgeProbe(config(), { inboundId: 'grpc', configRevision: 1 })).toThrowError('edge_probe_websocket_required');
    expect(() => deriveEdgeProbe(config(), { inboundId: 'direct', configRevision: 1 })).toThrowError('edge_probe_inbound_unavailable');
  });

  it('requires a valid revision and a Cloudflare HTTPS port', () => {
    expect(() => deriveEdgeProbe(config(), { inboundId: 'ws', configRevision: 0 })).toThrowError('edge_probe_revision_required');
    const invalid = config(); invalid.edge.endpoints[0].port = 51231;
    expect(() => deriveEdgeProbe(invalid, { inboundId: 'ws', endpointId: 'ip', configRevision: 1 })).toThrowError('edge_probe_port_invalid');
  });

  it('returns a bounded public result without target details', () => {
    expect(publicEdgeProbeResult({
      ok: true, checks: { dns: true, tcp: true, tls: true, hostSni: true, websocket101: true },
      latencyMs: 12.7, error: '', address: '203.0.113.8', token: 'secret'
    })).toEqual({
      ok: true, checks: { dns: true, tcp: true, tls: true, hostSni: true, websocket101: true }, latencyMs: 13, error: ''
    });
  });
});

import { describe, expect, it } from 'vitest';
import { buildReusableDeploymentConfig, deploymentReuseSummary, hasMaskedSecrets } from '../../src/lib/deployment-reuse.js';

const template = {
  schemaVersion: 2,
  runtime: { core: 'sing-box', tier: 'small', channel: 'stable' },
  inbounds: [{
    id: 'source-inbound', name: '日本软银', protocol: 'vless', port: 443, transport: 'tcp', outbound: 'warp-v4',
    credentials: { uuid: '********', password: '********' },
    tls: { mode: 'reality', serverName: 'www.cloudflare.com', realityPrivateKey: '********', realityPublicKey: 'PUBLIC', shortId: 'abcd' },
    transportOptions: { path: '/', host: 'www.cloudflare.com' }
  }],
  warp: { provisioning: 'manual', acceptedTerms: true, privateKey: '********', peerPublicKey: 'PEER', ipv4: '100.64.0.2' },
  subscription: { hostname: '198.51.100.10', server: { enabled: true, port: 8080, token: '********', pushToken: '********', pushGeneration: '********' } },
  edge: { mode: 'managed', managed: { tunnelToken: '********' } },
  tunnels: [{ type: 'named', hostname: 'edge.example.com', token: '********' }]
};

describe('deployment reuse template conversion', () => {
  it('creates a new public-only config and clears source credentials by default', () => {
    const result = buildReusableDeploymentConfig(template, {}, index => `new-${index}`);
    expect(result.inbounds[0]).toMatchObject({ id: 'new-0', name: '日本软银', port: '', outbound: 'warp-v4' });
    expect(result.inbounds[0].credentials).toEqual({});
    expect(result.inbounds[0].tls).toMatchObject({ mode: 'reality', serverName: 'www.cloudflare.com', shortId: 'abcd' });
    expect(result.inbounds[0].tls.realityPrivateKey).toBe('');
    expect(result.warp).toMatchObject({ privateKey: '', peerPublicKey: '', ipv4: '', acceptedTerms: false });
    expect(result.subscription.server).toMatchObject({ enabled: false, port: null, token: '', pushToken: '' });
    expect(result.edge.mode).toBe('disabled');
    expect(result.tunnels).toEqual([]);
    expect(hasMaskedSecrets(result)).toBe(false);
  });

  it('honors independent selection for public settings, ports, and names', () => {
    const result = buildReusableDeploymentConfig(template, {
      inbounds: true, tls: false, outbound: false, ports: true, nodeName: false
    }, index => `new-${index}`);
    expect(result.inbounds[0]).toMatchObject({ id: 'new-0', name: '', port: 443, outbound: '' });
    expect(result.inbounds[0].tls).toMatchObject({ mode: '', serverName: '', shortId: '' });
    expect(result.inbounds[0].transportOptions).toEqual({});
  });

  it('reuses only the individually selected inbound protocols', () => {
    const source = structuredClone(template);
    source.inbounds.push({
      id: 'source-vmess', name: '新加坡 VMess', protocol: 'vmess', port: 8443, transport: 'ws', outbound: 'direct',
      credentials: { uuid: '********' }, tls: { mode: 'none' }, transportOptions: { path: '/vmess' }
    });
    const result = buildReusableDeploymentConfig(source, { inboundIndexes: [1] }, index => `new-${index}`);
    expect(result.inbounds).toHaveLength(1);
    expect(result.inbounds[0]).toMatchObject({ id: 'new-0', protocol: 'vmess', name: '新加坡 VMess', outbound: 'direct' });
    expect(result.inbounds[0].credentials).toEqual({});
  });

  it('summarizes only non-sensitive template metadata', () => {
    expect(deploymentReuseSummary(template)).toMatchObject({ schemaVersion: 2, inboundCount: 1, core: 'sing-box' });
  });

  it('does not reuse a chain upstream unless explicitly enabled', () => {
    const source = structuredClone(template);
    source.inbounds[0].outbound = 'chain';
    source.inbounds[0].chain = {
      source: { type: 'deployment', sourceId: 'upstream', nodeKey: '0', label: 'Upstream' },
      snapshot: { protocol: 'vless', server: 'upstream.example.com', port: 443, transport: { type: 'ws' }, tls: { mode: 'tls' } },
      retainedCredentials: true
    };
    const safeDefault = buildReusableDeploymentConfig(source, {}, index => `new-${index}`);
    expect(safeDefault.inbounds[0].outbound).toBe('direct');
    expect(safeDefault.inbounds[0]).not.toHaveProperty('chain');

    const reused = buildReusableDeploymentConfig(source, { chainUpstream: true }, index => `new-${index}`);
    expect(reused.inbounds[0]).toMatchObject({ outbound: 'chain', chain: { retainedCredentials: true, source: { sourceId: 'upstream' } } });
  });
});

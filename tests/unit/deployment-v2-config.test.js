import { describe, expect, it } from 'vitest';
import {
  compileCoreConfig, compileNodeUrls, normalizeDeploymentDefaults, normalizeV2Config, publicDeploymentDefaults,
  publicV2Config, resolveBootstrapConfig, resolveV2Config
} from '../../functions/modules/deployment-v2-config.js';

const inbound = (overrides = {}) => ({
  protocol: 'vless', port: 443, transport: 'tcp', outbound: 'direct',
  credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' },
  tls: { mode: 'reality', serverName: 'www.example.com', realityPrivateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', realityPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }, ...overrides
});

describe('schemaVersion 2 compiler', () => {
  it('enables VPS subscriptions and traffic in built-in deployment defaults', () => {
    const defaults = publicDeploymentDefaults({});
    expect(defaults.subscriptionServer).toMatchObject({ enabled: true, trafficEnabled: true, pushEnabled: true, pushIntervalMinutes: 15 });
    expect(defaults.deployment.nodeNameMode).toBe('deployment-protocol-port');
    expect(defaults.deployment.addressMode).toBe('auto');
    expect(defaults.subscriptionServer.pushAddressMode).toBe('auto');
    expect(defaults.runtime.agentPollIntervalSeconds).toBe(30);
  });

  it('validates the configurable Agent connection interval', () => {
    for (const seconds of [15, 30, 60, 120, 180, 300]) {
      expect(normalizeV2Config({ inbounds: [inbound()], runtime: { agentPollIntervalSeconds: seconds } }).runtime.agentPollIntervalSeconds).toBe(seconds);
    }
    expect(normalizeV2Config({ inbounds: [inbound()] }).runtime.agentPollIntervalSeconds).toBe(30);
    expect(() => normalizeV2Config({ inbounds: [inbound()], runtime: { agentPollIntervalSeconds: 10 } })).toThrow(/Agent 连接频率/);
    expect(() => normalizeDeploymentDefaults({ runtime: { agentPollIntervalSeconds: 301 } })).toThrow(/Agent 连接频率/);
  });

  it('resolves IPv4-first, forced single-stack, and dual-stack node addresses', () => {
    const base = resolveV2Config({
      defaults: { deployment: { addressMode: 'dual' } },
      inbounds: [{ protocol: 'vless', port: 51231, name: '新加坡' }]
    }, {}, { deploymentName: 'Edge' });
    const dual = resolveBootstrapConfig(base, '', { ipv4: '198.51.100.10', ipv6: '2001:db8::10' });
    const urls = compileNodeUrls(dual);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('@198.51.100.10:51231');
    expect(urls[0]).toContain('#%E6%96%B0%E5%8A%A0%E5%9D%A1-IPv4');
    expect(urls[1]).toContain('@[2001:db8::10]:51231');
    expect(urls[1]).toContain('#%E6%96%B0%E5%8A%A0%E5%9D%A1-IPv6');
    expect(compileCoreConfig(dual).inbounds[0].listen).toBe('::');

    const auto = resolveV2Config({ inbounds: [{ protocol: 'vless' }] });
    const autoDual = resolveBootstrapConfig(auto, '', { ipv4: '198.51.100.11', ipv6: '2001:db8::11' });
    expect(autoDual.subscription.hostname).toBe('198.51.100.11');
    expect(compileCoreConfig(autoDual).inbounds[0].listen).toBe('0.0.0.0');
    const autoIpv6 = resolveBootstrapConfig(auto, '', { ipv6: '2001:db8::11' });
    expect(compileCoreConfig(autoIpv6).inbounds[0].listen).toBe('::');
    const ipv6 = resolveV2Config({ defaults: { deployment: { addressMode: 'ipv6' } }, inbounds: [{ protocol: 'vless' }] });
    expect(resolveBootstrapConfig(ipv6, '', { ipv6: '2001:db8::12' }).subscription.hostname).toBe('[2001:db8::12]');
    expect(compileCoreConfig(ipv6).inbounds[0].listen).toBe('::');
    const explicitListen = resolveV2Config({ defaults: { deployment: { addressMode: 'ipv6' } }, inbounds: [{ protocol: 'vless', listen: '127.0.0.1' }] });
    expect(compileCoreConfig(explicitListen).inbounds[0].listen).toBe('127.0.0.1');
    expect(() => resolveBootstrapConfig(ipv6, '', { ipv4: '198.51.100.12' })).toThrow(/IPv6/);
  });

  it('resolves explicit and automatic node names once and exports them in URL fragments and VMess ps', () => {
    const automatic = resolveV2Config({
      inbounds: [{ protocol: 'vless', port: 51231 }, { protocol: 'vmess', port: 51232 }],
      subscription: { hostname: 'node.example' }
    }, {}, { deploymentName: '新加坡' });
    expect(automatic.inbounds.map(item => item.name)).toEqual(['新加坡-vless-51231', '新加坡-vmess-51232']);
    expect(decodeURIComponent(compileNodeUrls(automatic)[0].split('#')[1])).toBe('新加坡-vless-51231');
    const vmessBytes = Uint8Array.from(atob(compileNodeUrls(automatic)[1].slice('vmess://'.length)), character => character.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(vmessBytes)).ps).toBe('新加坡-vmess-51232');

    const prefixed = resolveV2Config({
      defaults: { deployment: { nodeNameMode: 'prefix-protocol-port', namePrefix: 'Edge' } },
      inbounds: [{ protocol: 'vless', port: 51233, name: '  香港 # 01\u0000  ' }],
      subscription: { hostname: 'node.example' }
    }, {}, { deploymentName: 'Ignored' });
    expect(prefixed.inbounds[0].name).toBe('香港 # 01');
    expect(decodeURIComponent(compileNodeUrls(prefixed)[0].split('#')[1])).toBe('香港 # 01');

    const random = resolveV2Config({
      defaults: { deployment: { nodeNameMode: 'protocol-random' } },
      inbounds: [{ protocol: 'hysteria2', port: 51234 }]
    }, {}, { deploymentName: 'Ignored' });
    expect(random.inbounds[0].name).toMatch(/^hy2-[a-z0-9]{10}$/);
    const resolvedRandomName = random.inbounds[0].name;
    compileCoreConfig(random);
    expect(random.inbounds[0].name).toBe(resolvedRandomName);
    expect(() => resolveV2Config({ inbounds: [{ protocol: 'vless', name: 'x'.repeat(81) }] }, {}, { deploymentName: 'Edge' })).toThrow(/80/);
    expect(() => normalizeDeploymentDefaults({ deployment: { nodeNameMode: 'invalid' } })).toThrow(/命名方式/);

    const legacy = normalizeV2Config({ inbounds: [inbound({ name: undefined })], subscription: { hostname: 'node.example', namePrefix: 'Legacy' } });
    expect(decodeURIComponent(compileNodeUrls(legacy)[0].split('#')[1])).toBe('Legacy-vless-443');
  });
  it('selects one core and masks nested secrets', () => {
    const config = normalizeV2Config({ schemaVersion: 2, inbounds: [inbound()], runtime: { core: 'auto', tier: 'tiny' } });
    expect(config.runtime.core).toBe('xray');
    expect(publicV2Config(config).inbounds[0].credentials.uuid).toBe('********');
    const compiled = compileCoreConfig(config);
    expect(compiled.inbounds[0].protocol).toBe('vless');
    expect(compiled.inbounds[0].streamSettings.realitySettings).toMatchObject({ dest: 'www.example.com:443' });
    expect(config.runtime.controlCommand).toBe('tsub');
  });

  it('validates a per-deployment server control command without adding it to system defaults', () => {
    const config = normalizeV2Config({ inbounds: [inbound()], runtime: { controlCommand: 'proxy-menu' } });
    expect(config.runtime.controlCommand).toBe('proxy-menu');
    expect(normalizeDeploymentDefaults().runtime).not.toHaveProperty('controlCommand');
    expect(() => normalizeV2Config({ inbounds: [inbound()], runtime: { controlCommand: 'Bad Command' } })).toThrow(/服务器控制命令/);
    expect(() => normalizeV2Config({ inbounds: [inbound()], runtime: { controlCommand: '1proxy' } })).toThrow(/服务器控制命令/);
  });

  it('prefers Xray in auto mode and selects sing-box only for Xray-incompatible protocols', () => {
    const xrayProtocols = [
      inbound(),
      inbound({ protocol: 'trojan', credentials: { password: 'secret' }, tls: { mode: 'tls', serverName: 'tr.example', certificatePath: '/cert', keyPath: '/key' } }),
      inbound({ protocol: 'vmess', tls: { mode: 'none' } }),
      inbound({ protocol: 'hysteria2', transport: 'hysteria', credentials: { password: 'secret' }, tls: { mode: 'tls', serverName: 'hy.example', certificatePath: '/cert', keyPath: '/key' } }),
      inbound({ protocol: 'shadowsocks', credentials: { method: '2022-blake3-aes-128-gcm', password: 'dGVzdC10ZXN0LXRlc3Q=' }, tls: { mode: 'none' } }),
      inbound({ protocol: 'socks5', credentials: { username: 'tsub', password: 'secret' }, tls: { mode: 'none' } })
    ];
    for (const protocolInbound of xrayProtocols) {
      expect(normalizeV2Config({ inbounds: [protocolInbound], runtime: { core: 'auto' } }).runtime.core).toBe('xray');
    }

    const singBoxProtocols = [
      inbound({ protocol: 'tuic', credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'secret' }, tls: { mode: 'tls', serverName: 'tuic.example', certificatePath: '/cert', keyPath: '/key' } }),
      inbound({ protocol: 'anytls', credentials: { password: 'secret' }, tls: { mode: 'tls', serverName: 'anytls.example', certificatePath: '/cert', keyPath: '/key' } })
    ];
    for (const protocolInbound of singBoxProtocols) {
      expect(normalizeV2Config({ inbounds: [protocolInbound], runtime: { core: 'auto' } }).runtime.core).toBe('sing-box');
    }

    expect(() => normalizeV2Config({ inbounds: [inbound(), inbound()] })).toThrow(/端口/);
    expect(() => normalizeV2Config({
      inbounds: [inbound({ protocol: 'tuic', credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'secret' }, tls: { mode: 'tls', serverName: 'tuic.example', certificatePath: '/cert', keyPath: '/key' } })],
      runtime: { core: 'xray' }
    })).toThrow(/Xray/);
    expect(() => normalizeV2Config({
      inbounds: [
        inbound({ transport: 'xhttp', tls: { mode: 'tls', serverName: 'xh.example', certificatePath: '/cert', keyPath: '/key' } }),
        inbound({ protocol: 'tuic', port: 8443, credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'secret' }, tls: { mode: 'tls', serverName: 'tuic.example', certificatePath: '/cert', keyPath: '/key' } })
      ],
      runtime: { core: 'auto' }
    })).toThrow(/双核心/);
    expect(() => normalizeV2Config({ inbounds: [inbound()], runtime: { core: 'invalid' } })).toThrow(/核心选项/);
  });

  it('accepts 20 inbounds and rejects larger port sets', () => {
    const inbounds = Array.from({ length: 20 }, (_, index) => inbound({ port: 51231 + index }));
    expect(normalizeV2Config({ inbounds }).inbounds).toHaveLength(20);
    expect(() => normalizeV2Config({ inbounds: [...inbounds, inbound({ port: 51251 })] })).toThrow(/1-20/);
  });

  it('requires imported WARP credentials and compiles a WireGuard endpoint', () => {
    expect(() => normalizeV2Config({ inbounds: [inbound({ outbound: 'warp-v4' })] })).toThrow(/WARP/);
    const config = normalizeV2Config({ inbounds: [inbound({ outbound: 'warp-v4' })], runtime: { core: 'sing-box' }, warp: { privateKey: 'private', peerPublicKey: 'public', ipv4: '172.16.0.2/32' } });
    const compiled = compileCoreConfig(config);
    expect(compiled.outbounds.find(item => item.tag === 'warp-v4')).toBeUndefined();
    expect(compiled.endpoints.find(item => item.tag === 'warp-v4')).toMatchObject({
      type: 'wireguard', address: ['172.16.0.2/32'],
      peers: [{ allowed_ips: ['0.0.0.0/0'] }]
    });
  });

  it('keeps NaiveProxy isolated and enforces protocol TLS dependencies', () => {
    expect(() => normalizeV2Config({ inbounds: [inbound({ protocol: 'naive', credentials: { password: 'x' }, tls: { mode: 'tls', serverName: 'n.example' } }), inbound({ port: 8443 })] })).toThrow(/独立/);
    expect(() => normalizeV2Config({ inbounds: [inbound({ protocol: 'tuic', credentials: { uuid: 'x' }, tls: { mode: 'none' } })] })).toThrow(/TLS/);
  });

  it('exports protocol-correct VMess, SS2022, and Naive links', () => {
    const vmess = normalizeV2Config({ inbounds: [inbound({ protocol: 'vmess', tls: { mode: 'tls', serverName: 'vm.example', certificatePath: '/cert', keyPath: '/key' } })], subscription: { hostname: 'node.example' } });
    const xrayVmess = JSON.parse(atob(compileNodeUrls(vmess)[0].slice('vmess://'.length)));
    expect(xrayVmess).toMatchObject({ id: vmess.inbounds[0].credentials.uuid, scy: 'auto' });
    const singBoxVmess = normalizeV2Config({
      inbounds: [inbound({ protocol: 'vmess', transport: 'ws', tls: { mode: 'none' } })],
      runtime: { core: 'sing-box' }, subscription: { hostname: 'node.example' }
    });
    expect(JSON.parse(atob(compileNodeUrls(singBoxVmess)[0].slice('vmess://'.length))).scy).toBe('none');
    const shadowsocks = normalizeV2Config({ inbounds: [inbound({ protocol: 'shadowsocks', credentials: { password: 'secret', method: '2022-blake3-aes-128-gcm' }, tls: { mode: 'none' } })], runtime: { core: 'sing-box' }, subscription: { hostname: 'node.example' } });
    expect(compileNodeUrls(shadowsocks)[0]).toMatch(/^ss:\/\//);
    expect(compileCoreConfig(shadowsocks).inbounds[0]).toMatchObject({ method: '2022-blake3-aes-128-gcm', password: 'secret' });
    const naive = normalizeV2Config({ inbounds: [inbound({ protocol: 'naive', credentials: { username: 'tsub', password: 'secret' }, tls: { mode: 'tls', serverName: 'n.example', certificatePath: '/cert', keyPath: '/key' } })], subscription: { hostname: 'node.example' } });
    expect(compileNodeUrls(naive)[0]).toMatch(/^naive\+https:\/\//);
    expect(compileCoreConfig(naive)).toContain('forward_proxy');
  });

  it('resolves sparse inbounds with unique random ports and shared deployment credentials', () => {
    const config = resolveV2Config({
      inbounds: [
        { protocol: 'vless', port: '' },
        { protocol: 'vmess', port: null },
        { protocol: 'tuic', port: 51231 },
        { protocol: 'shadowsocks' }
      ],
      defaults: { randomPorts: { min: 51231, max: 51260 }, credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'shared-secret' } }
    });
    expect(new Set(config.inbounds.map(item => item.port)).size).toBe(4);
    expect(config.inbounds.slice(0, 3).map(item => item.credentials.uuid)).toEqual(Array(3).fill('79411d85-b0dc-4cd2-b46c-01789a18c650'));
    expect(config.inbounds[2].credentials.password).toBe('shared-secret');
    expect(config.inbounds[3].credentials.password).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(config.certificate.mode).toBe('self-signed');
  });

  it('normalizes shared self-signed certificate SNI across TLS inbounds', () => {
    const config = normalizeV2Config({
      inbounds: [
        inbound({
          protocol: 'hysteria2', port: 51233, transport: 'hysteria',
          credentials: { password: 'hy-secret' },
          tls: { mode: 'tls', serverName: 'www.cloudflare.com' }
        }),
        inbound({
          port: 8443, transport: 'ws', edgeMode: 'append',
          tls: { mode: 'tls', serverName: 'us-cdn-test.example.com' },
          transportOptions: { path: '/cdn' }
        }),
        inbound({
          protocol: 'tuic', port: 51234, transport: 'quic',
          credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'tuic-secret' },
          tls: { mode: 'tls', serverName: 'tuic.local' }
        })
      ],
      certificate: { mode: 'self-signed' },
      edge: { mode: 'manual', hostname: 'us-cdn-test.example.com' },
      subscription: { hostname: '198.51.100.10' }
    });

    expect(config.inbounds.map(item => item.tls.certificatePath)).toEqual([
      '__TSUB_CERT_DIR__/www.cloudflare.com.crt',
      '__TSUB_CERT_DIR__/www.cloudflare.com.crt',
      '__TSUB_CERT_DIR__/www.cloudflare.com.crt'
    ]);
    expect(config.inbounds.map(item => item.tls.serverName)).toEqual([
      'www.cloudflare.com',
      'www.cloudflare.com',
      'www.cloudflare.com'
    ]);
    expect(config.inbounds.every(item => item.tls.insecure)).toBe(true);
    const nodes = compileNodeUrls(config);
    expect(nodes.join('\n').match(/__TSUB_CERT_PIN_SHA256__/g)).toHaveLength(3);
    expect(nodes.find(node => node.startsWith('tuic://'))).toContain('sni=www.cloudflare.com');
    expect(nodes.find(node => node.startsWith('tuic://'))).toContain('alpn=h3');
    expect(nodes.find(node => node.startsWith('tuic://'))).not.toContain('sni=tuic.local');
    expect(compileCoreConfig(config).inbounds.find(item => item.type === 'tuic')).toMatchObject({
      congestion_control: 'bbr',
      tls: { alpn: ['h3'] }
    });
  });

  it('generates independent UUIDs and an unrelated subscription token when sharing is disabled', () => {
    const config = resolveV2Config({
      inbounds: [
        { protocol: 'vless' }, { protocol: 'vless' }, { protocol: 'vmess' },
        { protocol: 'tuic', credentials: { password: 'tuic-secret' } }
      ],
      defaults: { credentials: { sharedUuidEnabled: false, uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650' } },
      subscription: { server: { enabled: true } }
    });
    const uuids = config.inbounds.map(item => item.credentials.uuid);
    expect(new Set(uuids).size).toBe(4);
    expect(uuids).not.toContain('79411d85-b0dc-4cd2-b46c-01789a18c650');
    expect(uuids).not.toContain(config.subscription.server.token);
  });

  it('shares passwords by default and generates one per password inbound when disabled', () => {
    const shared = resolveV2Config({
      inbounds: [{ protocol: 'trojan' }, { protocol: 'hysteria2' }, { protocol: 'anytls' }],
      defaults: { credentials: { password: 'shared-secret' } }
    });
    expect(shared.inbounds.map(item => item.credentials.password)).toEqual(Array(3).fill('shared-secret'));

    const independent = resolveV2Config({
      inbounds: [
        { protocol: 'trojan' }, { protocol: 'trojan' }, { protocol: 'hysteria2' },
        { protocol: 'anytls', credentials: { password: 'explicit-secret' } }, { protocol: 'shadowsocks' }
      ],
      defaults: { credentials: { sharedPasswordEnabled: false, password: 'ignored-secret' } }
    });
    const generated = independent.inbounds.slice(0, 3).map(item => item.credentials.password);
    expect(new Set(generated).size).toBe(3);
    expect(generated).not.toContain('ignored-secret');
    expect(independent.inbounds[3].credentials.password).toBe('explicit-secret');
    expect(independent.inbounds[4].credentials.password).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('treats a missing shared password switch as enabled for existing defaults', () => {
    const defaults = normalizeDeploymentDefaults({ credentials: { password: 'legacy-secret' } });
    expect(defaults.credentials.sharedPasswordEnabled).toBe(true);
    const config = resolveV2Config({ inbounds: [{ protocol: 'trojan' }, { protocol: 'hysteria2' }] }, defaults);
    expect(config.inbounds.map(item => item.credentials.password)).toEqual(['legacy-secret', 'legacy-secret']);
  });

  it('keeps explicit inbound UUID overrides when sharing is disabled', () => {
    const explicit = '79411d85-b0dc-4cd2-b46c-01789a18c650';
    const config = resolveV2Config({
      inbounds: [{ protocol: 'vless', credentials: { uuid: explicit } }, { protocol: 'vmess' }],
      defaults: { credentials: { sharedUuidEnabled: false } }
    });
    expect(config.inbounds[0].credentials.uuid).toBe(explicit);
    expect(config.inbounds[1].credentials.uuid).not.toBe(explicit);
  });

  it('compiles Xray Hysteria2, Shadowsocks 2022, and XHTTP H3 with the v26 schema', () => {
    const hy2 = normalizeV2Config({
      inbounds: [inbound({ protocol: 'hysteria2', transport: 'hysteria', credentials: { password: 'secret' }, tls: { mode: 'tls', serverName: 'hy.example', certificatePath: '/cert', keyPath: '/key' }, transportOptions: { bandwidthUp: '100Mbps', bandwidthDown: '200Mbps', udpHopPorts: '20000-20010', udpHopInterval: 30 } })],
      runtime: { core: 'xray' }, subscription: { hostname: 'hy.example' }
    });
    const hyInbound = compileCoreConfig(hy2).inbounds[0];
    expect(hyInbound).toMatchObject({ protocol: 'hysteria', settings: { version: 2, users: [{ auth: 'secret' }] }, streamSettings: { method: 'hysteria', hysteriaSettings: { version: 2 } } });
    expect(hyInbound.streamSettings.finalmask.quicParams).toMatchObject({ brutalUp: '100Mbps', brutalDown: '200Mbps', udpHop: { ports: '20000-20010', interval: 30 } });
    expect(compileNodeUrls(hy2)[0]).toContain('upmbps=100');
    expect(compileNodeUrls(hy2)[0]).toContain('mport=20000-20010');
    expect(compileNodeUrls(hy2)[0]).not.toContain('type=tcp');

    const ss = normalizeV2Config({ inbounds: [inbound({ protocol: 'shadowsocks', credentials: { method: '2022-blake3-aes-128-gcm', password: 'dGVzdC10ZXN0LXRlc3Q=' }, tls: { mode: 'none' } })], runtime: { core: 'xray' } });
    expect(compileCoreConfig(ss).inbounds[0]).toMatchObject({ protocol: 'shadowsocks', settings: { method: '2022-blake3-aes-128-gcm', password: 'dGVzdC10ZXN0LXRlc3Q=' } });

    const xhttp = normalizeV2Config({ inbounds: [inbound({ transport: 'xhttp', tls: { mode: 'tls', serverName: 'xh.example', certificatePath: '/cert', keyPath: '/key' }, transportOptions: { path: '/xh', xhttpMode: 'stream-one', xhttpVersion: 'h3' } })], runtime: { core: 'xray' } });
    expect(compileCoreConfig(xhttp).inbounds[0].streamSettings).toMatchObject({ method: 'xhttp', xhttpSettings: { mode: 'stream-one' }, tlsSettings: { alpn: ['h3'] } });
    expect(() => normalizeV2Config({ inbounds: [inbound({ transport: 'xhttp', tls: { mode: 'reality', serverName: 'www.example.com' }, transportOptions: { xhttpVersion: 'h3' } })], runtime: { core: 'xray' } })).toThrow(/H3.*TLS/);
  });

  it('allocates a stable protected VPS subscription endpoint without colliding with inbounds', () => {
    const config = resolveV2Config({
      inbounds: [{ protocol: 'vless', port: 51231 }, { protocol: 'vmess' }],
      defaults: { randomPorts: { min: 51231, max: 51260 } },
      runtime: { core: 'sing-box' },
      subscription: { hostname: 'node.example', server: { enabled: true, traffic: { enabled: true, quotaBytes: 1024 ** 3 } } }
    });
    expect(config.subscription.server).toMatchObject({ enabled: true, traffic: { enabled: true, quotaBytes: 1024 ** 3, checkpointMinutes: 15 } });
    expect(config.subscription.server).toMatchObject({ pushEnabled: true, pushIntervalMinutes: 15 });
    expect(config.subscription.server.port).not.toBe(51231);
    expect(config.inbounds.map(item => item.port)).not.toContain(config.subscription.server.port);
    expect(config.subscription.server.traffic.apiPort).not.toBe(config.subscription.server.port);
    expect(config.inbounds.map(item => item.port)).not.toContain(config.subscription.server.traffic.apiPort);
    expect(config.subscription.server.traffic.apiSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(config.subscription.server.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(config.subscription.server.pushToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(config.subscription.server.pushGeneration).toMatch(/^[0-9a-f-]{36}$/);
    expect(publicV2Config(config).subscription.server.token).toBe('********');
    expect(publicV2Config(config).subscription.server.traffic.apiSecret).toBe('********');
    expect(compileCoreConfig(config).experimental.clash_api).toMatchObject({
      external_controller: `127.0.0.1:${config.subscription.server.traffic.apiPort}`,
      secret: config.subscription.server.traffic.apiSecret
    });
  });

  it('supports push intervals and omits push credentials when active push is disabled', () => {
    const active = resolveV2Config({
      inbounds: [{ protocol: 'vless' }],
      subscription: { server: { enabled: true, pushEnabled: true, pushIntervalMinutes: 30 } }
    });
    expect(active.subscription.server).toMatchObject({ pushEnabled: true, pushIntervalMinutes: 30 });
    expect(() => resolveV2Config({
      inbounds: [{ protocol: 'vless' }],
      subscription: { server: { enabled: true, pushIntervalMinutes: 10 } }
    })).toThrow(/5、15、30 或 60/);

    const snapshot = resolveV2Config({
      inbounds: [{ protocol: 'vless' }],
      subscription: { server: { enabled: true, pushEnabled: false, pushIntervalMinutes: 60 } }
    });
    expect(snapshot.subscription.server).toMatchObject({ pushEnabled: false, pushIntervalMinutes: 60, pushToken: '', pushGeneration: '' });
  });

  it('enables loopback-only Xray metrics for core traffic fallback', () => {
    const config = resolveV2Config({
      inbounds: [{ protocol: 'vless', transport: 'xhttp' }],
      subscription: { server: { enabled: true, traffic: { enabled: true } } }
    });
    const compiled = compileCoreConfig(config);
    expect(config.runtime.core).toBe('xray');
    expect(compiled.metrics.listen).toBe(`127.0.0.1:${config.subscription.server.traffic.apiPort}`);
    expect(compiled).toMatchObject({ stats: {}, policy: { system: { statsInboundUplink: true, statsInboundDownlink: true } } });
  });

  it('rejects subscription ports that collide with proxy ports', () => {
    expect(() => resolveV2Config({
      inbounds: [{ protocol: 'vless', port: 51231 }],
      subscription: { server: { enabled: true, port: 51231 } }
    })).toThrow(/订阅端口.*重复/);
  });

  it('applies protocol overrides after request and system defaults', () => {
    const config = resolveV2Config({
      defaults: { protocolDefaults: { vmess: { transport: 'grpc' } } },
      inbounds: [{ protocol: 'vmess', transport: 'tcp', tls: { mode: 'none' } }]
    }, { protocolDefaults: { vmess: { transport: 'ws', path: '/system' } } });
    expect(config.inbounds[0]).toMatchObject({ transport: 'tcp', transportOptions: { path: '/system' } });
  });

  it('keeps only UUID visible in public deployment defaults', () => {
    const defaults = publicDeploymentDefaults({ credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'secret' }, warp: { privateKey: 'warp-secret' } });
    expect(defaults.credentials).toMatchObject({ uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: '********' });
    expect(defaults.warp.privateKey).toBe('********');
  });

  it('resolves IPv4 and IPv6 bootstrap addresses and pins self-signed certificates', () => {
    const base = resolveV2Config({ inbounds: [{ protocol: 'trojan' }, { protocol: 'hysteria2', port: 51232 }, { protocol: 'vmess', port: 51233, tls: { mode: 'tls' } }] });
    const ipv4 = resolveBootstrapConfig(base, '203.0.113.7');
    const ipv6 = resolveBootstrapConfig(base, '2001:db8::7');
    expect(ipv4.subscription.hostname).toBe('203.0.113.7');
    expect(ipv6.subscription.hostname).toBe('[2001:db8::7]');
    const urls = compileNodeUrls(ipv6);
    expect(urls[0]).toContain('pcs=__TSUB_CERT_PIN_SHA256__');
    expect(urls[1]).toContain('pinSHA256=__TSUB_CERT_PIN_SHA256__');
    expect(urls[0]).toContain('spki=__TSUB_CERT_SPKI_SHA256__');
    expect(urls[1]).toContain('spki=__TSUB_CERT_SPKI_SHA256__');
    const vmess = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(urls[2].slice('vmess://'.length)), character => character.charCodeAt(0))));
    expect(vmess.pcs).toBe('__TSUB_CERT_PIN_SHA256__');
    expect(vmess.spki).toBe('__TSUB_CERT_SPKI_SHA256__');
    expect(urls.join('\n')).toMatch(/(?:allowInsecure|insecure)=1/);
    expect(vmess).toMatchObject({ allowInsecure: true, insecure: true });
    expect(() => resolveBootstrapConfig(base, '')).toThrow(/公网地址/);
  });

  it('keeps transport Host independent from TLS SNI and preserves explicit empty Host', () => {
    const config = normalizeV2Config({
      inbounds: [inbound({ transport: 'ws', tls: { mode: 'tls', serverName: 'tls.example', certificatePath: '/cert', keyPath: '/key' }, transportOptions: { path: '/ws', host: '' } })],
      runtime: { core: 'xray' }
    });
    expect(config.inbounds[0]).toMatchObject({ tls: { serverName: 'tls.example' }, transportOptions: { host: '' } });
    expect(compileCoreConfig(config).inbounds[0].streamSettings.wsSettings.headers).toEqual({});
  });

  it('rejects Hysteria2 hop ranges that overlap reserved or other hop ports', () => {
    const hy2 = (portValue, udpHopPorts) => inbound({ protocol: 'hysteria2', port: portValue, credentials: { password: 'secret' }, tls: { mode: 'tls', serverName: 'hy2.example', certificatePath: '/cert', keyPath: '/key' }, transportOptions: { udpHopPorts } });
    expect(() => normalizeV2Config({ inbounds: [hy2(51231, '51240-51250'), inbound({ protocol: 'tuic', port: 51245, credentials: { uuid: '79411d85-b0dc-4cd2-b46c-01789a18c650', password: 'secret' }, tls: { mode: 'tls', serverName: 'tuic.example', certificatePath: '/cert', keyPath: '/key' } })] })).toThrow(/跳跃端口.*冲突/);
    expect(() => normalizeV2Config({ inbounds: [hy2(51231, '52000-52010'), hy2(51232, '52005-52015')] })).toThrow(/跳跃端口.*冲突/);
  });

  it('compiles direct and CDN nodes in stable order with Cloudflare TLS metadata', () => {
    const config = resolveV2Config({
      inbounds: [{ protocol: 'vless', port: 8443, transport: 'ws', edgeMode: 'append', tls: { mode: 'tls', serverName: 'origin.example', insecure: true }, transportOptions: { path: '/edge' } }],
      certificate: { mode: 'self-signed' },
      subscription: { hostname: '203.0.113.9' },
      edge: {
        mode: 'manual', hostname: 'edge.example.com',
        endpoints: [{ id: 'a', label: '优选一', address: '198.51.100.10' }, { id: 'b', label: '', address: 'cdn.example.net', port: 8443 }]
      }
    });
    const urls = compileNodeUrls(config);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('@203.0.113.9:8443');
    expect(urls[0]).toContain('pcs=__TSUB_CERT_PIN_SHA256__');
    expect(urls[0]).toContain('spki=__TSUB_CERT_SPKI_SHA256__');
    expect(urls[1]).toContain('@198.51.100.10:8443');
    expect(urls[1]).toContain('sni=edge.example.com');
    expect(urls[1]).toContain('host=edge.example.com');
    expect(urls[1]).not.toMatch(/(?:pcs|allowInsecure|insecure)=/);
    expect(decodeURIComponent(urls[1].split('#')[1])).toContain('-CDN-优选一');
    expect(urls[2]).toContain('@cdn.example.net:8443');
  });

  it('rejects malformed CDN IP addresses and DNS names', () => {
    const request = address => ({
      inbounds: [{ protocol: 'vless', port: 8443, transport: 'ws', edgeMode: 'append', tls: { mode: 'tls', serverName: 'origin.example' } }],
      edge: { mode: 'manual', hostname: 'edge.example.com', endpoints: [{ address }] }
    });
    for (const address of ['999.1.1.1', '1.2.3', 'bad..example.com', '-edge.example.com', '2001:db8:::1', '[2001:db8::1']) {
      expect(() => resolveV2Config(request(address))).toThrow(/CDN 优选地址/);
    }
    expect(resolveV2Config(request('[2001:db8::1]')).edge.endpoints[0].address).toBe('2001:db8::1');
  });

  it('validates Quick Tunnel and enables active push without mutating the request', () => {
    const input = {
      inbounds: [{ id: 'ws-1', protocol: 'vmess', transport: 'ws', edgeMode: 'only', tls: { mode: 'none' } }],
      edge: { mode: 'quick', quickInboundId: 'ws-1' },
      subscription: { server: { enabled: true, pushEnabled: false } }
    };
    const config = resolveV2Config(input);
    expect(input.subscription.server.pushEnabled).toBe(false);
    expect(config.subscription.server.pushEnabled).toBe(true);
    expect(config.tunnels).toEqual([{ type: 'quick', hostname: '', token: '' }]);
    expect(compileNodeUrls(config)).toEqual([]);
    const [quickNode] = compileNodeUrls(config, { edgeHostname: 'random.trycloudflare.com' });
    expect(quickNode).toBeTruthy();
    const quickPayload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(quickNode.slice('vmess://'.length)), character => character.charCodeAt(0))));
    expect(quickPayload.ps).toMatch(/-临时隧道$/);
    expect(quickPayload.ps).not.toContain('random.trycloudflare.com');
  });

  it('keeps custom Quick Tunnel endpoint labels in CDN node names', () => {
    const config = resolveV2Config({
      name: '香港',
      inbounds: [{ id: 'ws-1', protocol: 'vless', port: 51237, transport: 'ws', edgeMode: 'only', tls: { mode: 'none' } }],
      edge: {
        mode: 'quick', quickInboundId: 'ws-1',
        endpoints: [{ id: 'preferred', label: '优选一', address: '198.51.100.10' }]
      },
      subscription: { server: { enabled: true, pushEnabled: true } }
    });
    const [node] = compileNodeUrls(config, { edgeHostname: 'random.trycloudflare.com' });
    expect(decodeURIComponent(node.split('#')[1])).toMatch(/-CDN-优选一$/);
  });

  it('uses runtime placeholders for automatic WARP identities and masks managed resources', () => {
    const config = resolveV2Config({
      inbounds: [{ protocol: 'vless', outbound: 'warp-auto' }],
      warp: { provisioning: 'auto', acceptedTerms: true }
    });
    const compiled = compileCoreConfig(config);
    expect(compiled.outbounds[1].settings).toMatchObject({
      secretKey: '__TSUB_WARP_PRIVATE_KEY__',
      address: ['__TSUB_WARP_IPV4__', '__TSUB_WARP_IPV6__'],
      reserved: '__TSUB_WARP_RESERVED__'
    });
    const publicConfig = publicV2Config({ ...config, edge: { mode: 'managed', managed: { tunnelId: 'tunnel-id', dnsRecordId: 'dns-id', tunnelToken: 'token' } } });
    expect(publicConfig.edge.managed).toEqual({ tunnelId: '********', dnsRecordId: '********', tunnelToken: '********' });
  });
});

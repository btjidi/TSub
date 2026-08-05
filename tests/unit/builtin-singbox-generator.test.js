import { describe, it, expect } from 'vitest';
import { generateBuiltinSingboxConfig } from '../../functions/modules/subscription/builtin-singbox-generator.js';

const SS2022_V2RAY_PLUGIN_NODE = 'ss://MjAyMi1ibGFrZTMtYWVzLTI1Ni1nY206MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=@proxy.example.invalid:8080?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Bhost%3Dws.example.invalid%3Bpath%3D%2F%3Fenc%5C%3D2022-blake3-aes-256-gcm%3Bmux%3D0#2022-blake3-aes-256-gcm';

describe('Built-in Sing-box generator', () => {
    it('should generate a JSON config with outbounds', () => {
        const result = generateBuiltinSingboxConfig([
            'trojan://password@1.2.3.4:443#TestNode',
            'trojan://password@1.2.3.5:443#JPNode'
        ].join('\n'));
        const parsed = JSON.parse(result);

        expect(Array.isArray(parsed.outbounds)).toBe(true);
        expect(parsed.outbounds.some(outbound => outbound.tag.endsWith('TestNode'))).toBe(true);
        expect(parsed.outbounds.some(outbound => outbound.tag.includes('节点选择'))).toBe(true);
        expect(parsed.outbounds.some(outbound => outbound.tag.includes('视频广告'))).toBe(true);
        expect(parsed.outbounds.some(outbound => outbound.tag.includes('Apple'))).toBe(true);
        expect(parsed.outbounds.some(outbound => outbound.tag.includes('日本') && outbound.type === 'urltest')).toBe(true);
        expect(parsed.route.final).toContain('节点选择');
    });

    it('should include a tun inbound for sing-box Android client deployment', () => {
        const result = generateBuiltinSingboxConfig('trojan://password@1.2.3.4:443#AndroidNode');
        const parsed = JSON.parse(result);

        expect(parsed.inbounds).toEqual([
            expect.objectContaining({
                type: 'tun',
                tag: 'tun-in',
                auto_route: true,
                strict_route: true,
                stack: 'mixed'
            })
        ]);
        expect(parsed.inbounds[0].address).toEqual(expect.arrayContaining(['172.19.0.1/30']));
    });

    it('should enable TLS for https and socks5-tls', () => {
        const result = generateBuiltinSingboxConfig([
            'https://user:pass@1.2.3.4:443#HttpsNode',
            'socks5://user:pass@5.6.7.8:1080#PlainSocks',
            'socks5://user:pass@5.6.7.8:1081?tls=1#TlsSocks'
        ].join('\n'));
        const parsed = JSON.parse(result);
        const httpsNode = parsed.outbounds.find(outbound => outbound.tag.endsWith('HttpsNode'));
        const socksNode = parsed.outbounds.find(outbound => outbound.tag.endsWith('TlsSocks'));

        expect(httpsNode?.tls?.enabled).toBe(true);
        expect(socksNode?.tls?.enabled).toBe(true);
    });

    it('uses current DNS server objects while preserving Trojan websocket transport', () => {
        const result = generateBuiltinSingboxConfig('trojan://password@1.2.3.4:443?type=ws&path=%2Fws&host=example.com&sni=example.org#TrojanWS');
        const parsed = JSON.parse(result);
        const trojanNode = parsed.outbounds.find(outbound => outbound.tag.endsWith('TrojanWS'));

        expect(parsed.dns.servers).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'udp', server: '223.5.5.5', server_port: 53 }),
            expect.objectContaining({ type: 'https', server: '1.1.1.1', path: '/dns-query' })
        ]));
        expect(parsed.dns.servers.every(server => !Object.hasOwn(server, 'address'))).toBe(true);
        expect(trojanNode?.type).toBe('trojan');
        expect(trojanNode?.tls?.enabled).toBe(true);
        expect(trojanNode?.tls?.server_name).toBe('example.org');
        expect(trojanNode?.transport?.type).toBe('ws');
        expect(trojanNode?.transport?.path).toBe('/ws');
        expect(trojanNode?.transport?.headers?.Host).toBe('example.com');
    });

    it('maps self-signed SPKI pins to native sing-box TLS verification', () => {
        const spkiHex = '01'.repeat(32);
        const spkiBase64 = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
        const vmess = btoa(JSON.stringify({ v: '2', ps: 'VMessPin', add: '1.2.3.9', port: '443', id: '11111111-1111-4111-8111-111111111111', aid: '0', net: 'ws', path: '/ws', tls: 'tls', sni: 'example.com', spki: spkiBase64 }));
        const result = JSON.parse(generateBuiltinSingboxConfig([
            `vless://11111111-1111-4111-8111-111111111111@1.2.3.4:443?security=tls&sni=example.com&spki=${spkiHex}#VLESSPin`,
            `trojan://password@1.2.3.5:443?sni=example.com&spki=${spkiHex}#TrojanPin`,
            `hysteria2://password@1.2.3.6:443?sni=example.com&spki=${spkiHex}#HY2Pin`,
            `tuic://11111111-1111-4111-8111-111111111111:password@1.2.3.7:443?sni=example.com&alpn=h3&allow_insecure=1&spki=${spkiHex}#TUICPin`,
            `anytls://password@1.2.3.8:443?sni=example.com&spki=${spkiHex}#AnyTLSPin`,
            `vmess://${vmess}`
        ].join('\n')));
        const pinned = result.outbounds.filter(outbound => ['vless', 'trojan', 'hysteria2', 'tuic', 'anytls', 'vmess'].includes(outbound.type));
        expect(pinned).toHaveLength(6);
        expect(pinned.every(outbound => outbound.tls?.certificate_public_key_sha256?.[0] === spkiBase64)).toBe(true);
        expect(pinned.every(outbound => outbound.tls?.insecure === false)).toBe(true);
        expect(pinned.find(outbound => outbound.type === 'tuic')?.tls?.alpn).toEqual(['h3']);
    });

    it('enables standard TLS for VLESS websocket outbounds', () => {
        const result = generateBuiltinSingboxConfig('vless://11111111-1111-4111-8111-111111111111@cdn.example.com:443?security=tls&type=ws&path=%2Fws&host=origin.example.com&sni=origin.example.com#VlessTLS');
        const parsed = JSON.parse(result);
        const node = parsed.outbounds.find(outbound => outbound.tag.endsWith('VlessTLS'));

        expect(node?.tls).toEqual(expect.objectContaining({ enabled: true, server_name: 'origin.example.com' }));
        expect(node?.transport).toEqual(expect.objectContaining({ type: 'ws', path: '/ws', headers: { Host: 'origin.example.com' } }));
    });

    it('should map anytls outbound', () => {
        const result = generateBuiltinSingboxConfig('anytls://pass-anytls@anytls.example.com:443/?sni=example.com&allowInsecure=1#AnyTLSNode');
        const parsed = JSON.parse(result);
        const anytlsNode = parsed.outbounds.find(outbound => outbound.tag.endsWith('AnyTLSNode'));

        expect(anytlsNode?.type).toBe('anytls');
        expect(anytlsNode?.server).toBe('anytls.example.com');
        expect(anytlsNode?.server_port).toBe(443);
        expect(anytlsNode?.password).toBe('pass-anytls');
        expect(anytlsNode?.tls?.enabled).toBe(true);
        expect(anytlsNode?.tls?.server_name).toBe('example.com');
        expect(anytlsNode?.tls?.insecure).toBe(true);
    });

    it('should map SS2022 v2ray-plugin websocket with SIP003 fields instead of an invalid transport', () => {
        const result = generateBuiltinSingboxConfig(SS2022_V2RAY_PLUGIN_NODE);
        const parsed = JSON.parse(result);
        const ssNode = parsed.outbounds.find(outbound => outbound.type === 'shadowsocks');

        expect(ssNode?.method).toBe('2022-blake3-aes-256-gcm');
        expect(ssNode?.plugin).toBe('v2ray-plugin');
        expect(ssNode?.plugin_opts).toBe('mode=websocket;host=ws.example.invalid;path=/?enc=2022-blake3-aes-256-gcm');
        expect(ssNode?.transport).toBeUndefined();
        expect(ssNode?.tls).toBeUndefined();
    });

    it('applies global certificate bypass only to TLS-enabled outbounds', () => {
        const result = generateBuiltinSingboxConfig([
            'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@1.2.3.4:8388#PlainSS',
            'vmess://eyJ2IjoiMiIsInBzIjoiUGxhaW5WTWVzcyIsImFkZCI6IjEuMi4zLjUiLCJwb3J0IjoiODAiLCJpZCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsImFpZCI6IjAiLCJuZXQiOiJ3cyIsInR5cGUiOiJub25lIiwiaG9zdCI6IiIsInBhdGgiOiIvd3MiLCJ0bHMiOiIifQ==',
            'trojan://password@1.2.3.6:443?sni=example.com#TlsTrojan'
        ].join('\n'), { skipCertVerify: true });
        const parsed = JSON.parse(result);
        const ssNode = parsed.outbounds.find(outbound => outbound.tag.endsWith('PlainSS'));
        const vmessNode = parsed.outbounds.find(outbound => outbound.tag.endsWith('PlainVMess'));
        const trojanNode = parsed.outbounds.find(outbound => outbound.tag.endsWith('TlsTrojan'));

        expect(ssNode?.tls).toBeUndefined();
        expect(vmessNode?.tls).toBeUndefined();
        expect(trojanNode?.tls).toEqual(expect.objectContaining({ enabled: true, insecure: true }));
    });

    it('should map TUIC extended parameters documented by sing-box', () => {
        const result = generateBuiltinSingboxConfig('tuic://uuid-tuic:pass-tuic@tuic.example.com:443?sni=tuic.example.com&congestion_control=bbr&udp_relay_mode=quic&udp_over_stream=1&zero_rtt_handshake=1&heartbeat=10s&allow_insecure=1#TUICNode');
        const parsed = JSON.parse(result);
        const tuicNode = parsed.outbounds.find(outbound => outbound.tag.endsWith('TUICNode'));

        expect(tuicNode?.type).toBe('tuic');
        expect(tuicNode?.congestion_control).toBe('bbr');
        expect(tuicNode?.udp_relay_mode).toBe('quic');
        expect(tuicNode?.udp_over_stream).toBe(true);
        expect(tuicNode?.zero_rtt_handshake).toBe(true);
        expect(tuicNode?.heartbeat).toBe('10s');
        expect(tuicNode?.tls?.server_name).toBe('tuic.example.com');
        expect(tuicNode?.tls?.insecure).toBe(true);
    });

    it('should use rule_set for geoip instead of deprecated geoip field (sing-box 1.12+)', () => {
        const result = generateBuiltinSingboxConfig('trojan://password@1.2.3.4:443#TestNode');
        const parsed = JSON.parse(result);

        // No rule should have a direct geoip field
        const geoipRules = parsed.route.rules.filter(r => r.geoip !== undefined);
        expect(geoipRules).toHaveLength(0);

        // Should have a geoip-cn rule_set reference instead
        const geoipRuleSet = parsed.route.rules.filter(r =>
            Array.isArray(r.rule_set) && r.rule_set.includes('geoip-cn')
        );
        expect(geoipRuleSet).toHaveLength(1);
        expect(geoipRuleSet[0].outbound).toBe('DIRECT');

        // Should have geoip-cn in the rule_set definitions
        const geoipProvider = parsed.route.rule_set.find(rs => rs.tag === 'geoip-cn');
        expect(geoipProvider).toBeDefined();
        expect(geoipProvider.type).toBe('remote');
        expect(geoipProvider.url).toContain('sing-geoip');
        expect(geoipProvider.format).toBe('binary');
    });
});

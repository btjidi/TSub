import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { parseIniTemplate } from '../../functions/modules/subscription/template-parsers/ini-template-parser.js';
import { renderClashFromIniTemplate, renderLoonFromIniTemplate, renderQuanxFromIniTemplate, renderSingboxFromIniTemplate, renderSurgeFromIniTemplate } from '../../functions/modules/subscription/template-pipeline.js';
import { getBuiltinTemplate } from '../../functions/modules/subscription/builtin-template-registry.js';

const SS2022_V2RAY_PLUGIN_NODE = 'ss://MjAyMi1ibGFrZTMtYWVzLTI1Ni1nY206MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=@proxy.example.invalid:8080?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Bhost%3Dws.example.invalid%3Bpath%3D%2F%3Fenc%5C%3D2022-blake3-aes-256-gcm%3Bmux%3D0#2022-blake3-aes-256-gcm';

describe('Template pipeline', () => {
    it('uses current DNS server objects in sing-box templates', () => {
        const rendered = renderSingboxFromIniTemplate(`
[Proxy Group]
节点选择 = select, Trojan WS, DIRECT

[Rule]
MATCH,节点选择
        `, {
            proxies: [{
                name: 'Trojan WS', type: 'trojan', server: 'trojan.example.com', port: 443,
                password: 'secret', network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'edge.example.com' } }
            }]
        });
        const parsed = JSON.parse(rendered);
        const trojan = parsed.outbounds.find(outbound => outbound.tag === 'Trojan WS');

        expect(parsed.dns.servers).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'udp', server: '223.5.5.5', server_port: 53 })
        ]));
        expect(parsed.dns.servers.every(server => !Object.hasOwn(server, 'address'))).toBe(true);
        expect(trojan).toBeDefined();
    });

    it('uses SIP003 v2ray-plugin fields instead of an invalid Shadowsocks transport', () => {
        const rendered = renderSingboxFromIniTemplate(`
[Proxy Group]
节点选择 = select, SS2022, DIRECT

[Rule]
MATCH,节点选择
        `, { nodeList: SS2022_V2RAY_PLUGIN_NODE });
        const parsed = JSON.parse(rendered);
        const ssNode = parsed.outbounds.find(outbound => outbound.type === 'shadowsocks');

        expect(ssNode?.plugin).toBe('v2ray-plugin');
        expect(ssNode?.plugin_opts).toBe('mode=websocket;host=ws.example.invalid;path=/?enc=2022-blake3-aes-256-gcm');
        expect(ssNode?.transport).toBeUndefined();
    });

    it('pins self-signed TUIC certificates in sing-box templates', () => {
        const spkiHex = '01'.repeat(32);
        const spkiBase64 = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
        const rendered = renderSingboxFromIniTemplate(`
[Proxy Group]
节点选择 = select, TUIC Pin, DIRECT

[Rule]
MATCH,节点选择
        `, {
            nodeList: `tuic://11111111-1111-4111-8111-111111111111:password@1.2.3.7:443?sni=www.cloudflare.com&alpn=h3&allow_insecure=1&spki=${spkiHex}#TUIC%20Pin`
        });
        const parsed = JSON.parse(rendered);
        const tuic = parsed.outbounds.find(outbound => outbound.type === 'tuic');

        expect(tuic?.tls).toEqual(expect.objectContaining({
            enabled: true,
            server_name: 'www.cloudflare.com',
            alpn: ['h3'],
            insecure: false,
            certificate_public_key_sha256: [spkiBase64]
        }));
    });

    it('uses the shared sing-box protocol mapping in template output', () => {
        const spkiHex = '02'.repeat(32);
        const vmessPayload = btoa(JSON.stringify({
            v: '2', ps: 'VMess', add: 'vmess.example.invalid', port: '443',
            id: '11111111-1111-4111-8111-111111111111', aid: '0', scy: 'none',
            net: 'grpc', path: 'vmess-service', tls: 'tls', sni: 'tls.example.invalid'
        }));
        const rendered = renderSingboxFromIniTemplate('[Proxy Group]\n节点选择 = select, VMess, Trojan, HY2, TUIC, DIRECT', {
            nodeList: [
                `vmess://${vmessPayload}`,
                'trojan://password@trojan.example.invalid:443?security=tls&sni=tls.example.invalid&type=grpc&serviceName=trojan-service#Trojan',
                `hysteria2://password@hy2.example.invalid:443?sni=tls.example.invalid&upmbps=100&downmbps=200&mport=20000-20010&hopInterval=30&allow_insecure=1&spki=${spkiHex}#HY2`,
                `tuic://22222222-2222-4222-8222-222222222222:password@tuic.example.invalid:443?sni=tls.example.invalid&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1&spki=${spkiHex}#TUIC`
            ].join('\n')
        });
        const parsed = JSON.parse(rendered);
        const vmess = parsed.outbounds.find(outbound => outbound.type === 'vmess');
        const trojan = parsed.outbounds.find(outbound => outbound.type === 'trojan');
        const hy2 = parsed.outbounds.find(outbound => outbound.type === 'hysteria2');
        const tuic = parsed.outbounds.find(outbound => outbound.type === 'tuic');

        expect(vmess.transport).toEqual({ type: 'grpc', service_name: 'vmess-service' });
        expect(vmess).not.toHaveProperty('udp_relay_mode');
        expect(vmess).not.toHaveProperty('congestion_control');
        expect(trojan.transport).toEqual({ type: 'grpc', service_name: 'trojan-service' });
        expect(hy2).toMatchObject({ server_ports: ['20000:20010'], hop_interval: '30s', up_mbps: 100, down_mbps: 200 });
        expect(hy2.tls).toMatchObject({ insecure: false, certificate_public_key_sha256: [expect.any(String)] });
        expect(tuic).toMatchObject({ congestion_control: 'bbr', udp_relay_mode: 'native' });
        expect(tuic.tls).toMatchObject({ alpn: ['h3'], insecure: false, certificate_public_key_sha256: [expect.any(String)] });
    });

    it('should parse limited ini template into unified model', () => {
        const model = parseIniTemplate(`
[Proxy Group]
节点选择 = select, HK-01, JP-01, DIRECT
自动选择 = url-test, HK-01, JP-01, url=http://www.gstatic.com/generate_204, interval=300

[Rule]
DOMAIN-SUFFIX,google.com,节点选择
GEOIP,CN,DIRECT
MATCH,节点选择
        `, {
            fileName: 'Demo',
            targetFormat: 'clash'
        });

        expect(model.groups).toHaveLength(2);
        expect(model.rules).toHaveLength(3);
        expect(model.groups[0].name).toBe('节点选择');
        expect(model.rules[2].type).toBe('match');
    });

    it('should render clash yaml from limited ini template', () => {
        const rendered = renderClashFromIniTemplate(`
[Proxy Group]
节点选择 = select, HK-01, JP-01, DIRECT

[Rule]
DOMAIN-SUFFIX,google.com,节点选择
MATCH,节点选择
        `, {
            proxies: [
                { name: 'HK-01', type: 'trojan', server: '1.1.1.1', port: 443, password: 'pass' },
                { name: 'JP-01', type: 'trojan', server: '2.2.2.2', port: 443, password: 'pass' }
            ],
            managedConfigUrl: 'https://example.com/sub'
        });

        const parsed = yaml.load(rendered);
        expect(parsed['proxy-groups'][0].name).toBe('节点选择');
        expect(parsed.rules).toContain('MATCH,节点选择');
        expect(parsed.profile['subscription-url']).toBe('https://example.com/sub');
    });

    it('should exclude DIRECT from auto-select groups when rendering templates', () => {
        const rendered = renderClashFromIniTemplate(`
[Proxy Group]
节点选择 = select, 自动选择, DIRECT
自动选择 = url-test, HK-01, JP-01, DIRECT

[Rule]
MATCH,节点选择
        `, {
            proxies: [
                { name: 'HK-01', type: 'trojan', server: '1.1.1.1', port: 443, password: 'pass' },
                { name: 'JP-01', type: 'trojan', server: '2.2.2.2', port: 443, password: 'pass' }
            ]
        });

        const parsed = yaml.load(rendered);
        const autoSelectGroup = parsed['proxy-groups'].find(group => group.name === '自动选择');
        expect(autoSelectGroup.proxies).toEqual(['HK-01', 'JP-01']);
        expect(autoSelectGroup.proxies).not.toContain('DIRECT');
    });

    it('should keep Clash template relay-like groups as plain select without dialer-proxy', () => {
        const rendered = renderClashFromIniTemplate(`
[Proxy Group]
🔗 链式代理 = select, 入口节点, HK-01, DIRECT
入口节点 = select, HK-01, DIRECT

[Rule]
MATCH,🔗 链式代理
        `, {
            proxies: [
                { name: 'HK-01', type: 'trojan', server: '1.1.1.1', port: 443, password: 'pass' }
            ]
        });

        const parsed = yaml.load(rendered);
        const relayLikeGroup = parsed['proxy-groups'].find(group => group.name === '🔗 链式代理');
        expect(relayLikeGroup.type).toBe('select');
        expect(relayLikeGroup.proxies).toEqual(['入口节点', 'HK-01', 'DIRECT']);
        expect(relayLikeGroup['dialer-proxy']).toBeUndefined();
    });

    it('should merge duplicate proxy groups with the same name before rendering', () => {
        const rendered = renderClashFromIniTemplate(`
[Proxy Group]
节点选择 = select, HK-01
节点选择 = select, JP-01, DIRECT
自动选择 = url-test, HK-01, JP-01

[Rule]
MATCH,节点选择
        `, {
            proxies: [
                { name: 'HK-01', type: 'trojan', server: '1.1.1.1', port: 443, password: 'pass' },
                { name: 'JP-01', type: 'trojan', server: '2.2.2.2', port: 443, password: 'pass' }
            ]
        });

        const parsed = yaml.load(rendered);
        const selectGroups = parsed['proxy-groups'].filter(group => group.name === '节点选择');
        expect(selectGroups).toHaveLength(1);
        expect(selectGroups[0].proxies).toContain('HK-01');
        expect(selectGroups[0].proxies).toContain('JP-01');
        expect(selectGroups[0].proxies).toContain('DIRECT');
    });

    it('should parse builtin ACL4SSR custom template registry entry', () => {
        const builtinTemplate = getBuiltinTemplate('clash_acl4ssr_full');
        const model = parseIniTemplate(builtinTemplate.content, {
            fileName: 'ACL4SSR',
            targetFormat: 'clash'
        });

        expect(model.groups.length).toBeGreaterThan(10);
        expect(model.rules.some(rule => rule.type === 'rule-set')).toBe(true);
        expect(model.groups.some(group => group.name === '🚀 节点选择')).toBe(true);
    });

    it('should render sing-box json from ACL4SSR custom template', () => {
        const builtinTemplate = getBuiltinTemplate('clash_acl4ssr_full');
        const rendered = renderSingboxFromIniTemplate(builtinTemplate.content, {
            nodeList: [
                'trojan://password@1.2.3.4:443#HK-01',
                'vmess://eyJ2IjoiMiIsInBzIjoiSlAtMDEiLCJhZGQiOiIxLjIuMy41IiwicG9ydCI6IjQ0MyIsImlkIjoidXVpZC0xMjM0IiwiYWlkIjoiMCIsIm5ldCI6IndzIiwidHlwZSI6Im5vbmUiLCJob3N0IjoiZXhhbXBsZS5jb20iLCJwYXRoIjoiL3dzIiwidGxzIjoidGxzIn0'
            ].join('\n'),
            targetFormat: 'singbox'
        });
        const parsed = JSON.parse(rendered);

        expect(Array.isArray(parsed.outbounds)).toBe(true);
        expect(parsed.outbounds.some(outbound => outbound.tag === '🚀 节点选择')).toBe(true);
        expect(parsed.outbounds.some(outbound => outbound.tag === '🇭🇰 HK-01')).toBe(true);
        expect(parsed.outbounds.some(outbound => outbound.tag === '🇯🇵 JP-01' && outbound.type === 'vmess')).toBe(true);
        expect(Array.isArray(parsed.route.rule_set)).toBe(true);
        expect(parsed.route.rule_set.length).toBeGreaterThan(0);
        const aclRuleSets = parsed.route.rule_set.filter(ruleSet => String(ruleSet.url).endsWith('.list'));
        expect(aclRuleSets.length).toBeGreaterThan(0);
        expect(aclRuleSets.every(ruleSet => ruleSet.format === 'source')).toBe(true);
    });

    it('should render surge config sections from ACL4SSR custom template', () => {
        const builtinTemplate = getBuiltinTemplate('clash_acl4ssr_full');
        const rendered = renderSurgeFromIniTemplate(builtinTemplate.content, {
            nodeList: [
                'trojan://password@1.2.3.4:443#HK-01',
                'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.5:8388#JP-01'
            ].join('\n'),
            targetFormat: 'surge&ver=4'
        });

        expect(rendered).toContain('[Proxy]');
        expect(rendered).toContain('[Proxy Group]');
        expect(rendered).toContain('[Rule]');
        expect(rendered).toContain('🚀 节点选择 = select');
    });

    it('should render loon and quanx config sections from ACL4SSR custom template', () => {
        const builtinTemplate = getBuiltinTemplate('clash_acl4ssr_full');
        const nodeList = [
            'trojan://password@1.2.3.4:443#HK-01',
            'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.5:8388#JP-01',
            'vmess://eyJ2IjoiMiIsInBzIjoiVVMtMDEiLCJhZGQiOiIxLjIuMy42IiwicG9ydCI6IjQ0MyIsImlkIjoidXVpZC01Njc4IiwiYWlkIjoiMCIsIm5ldCI6IndzIiwiaG9zdCI6ImV4YW1wbGUuY29tIiwicGF0aCI6Ii93cyIsInRscyI6InRscyJ9',
            'vless://uuid-9999@1.2.3.7:443?security=reality&type=grpc&serviceName=edge&pbk=testpublickey&sid=abcd&sni=example.com#SG-01',
            'wireguard://privatekey@1.2.3.8:51820?publickey=peerpub&reserved=1,2,3&address=172.16.0.2/32#WG-01'
        ].join('\n');

        const loonRendered = renderLoonFromIniTemplate(builtinTemplate.content, { nodeList, targetFormat: 'loon' });
        const quanxRendered = renderQuanxFromIniTemplate(builtinTemplate.content, { nodeList, targetFormat: 'quanx' });
        const surgeRendered = renderSurgeFromIniTemplate(builtinTemplate.content, { nodeList, targetFormat: 'surge&ver=4' });

        expect(loonRendered).toContain('[Proxy]');
        expect(loonRendered).toContain('[Proxy Group]');
        expect(loonRendered).toContain('[Rule]');
        expect(loonRendered).toContain('SG-01 = vless');
        expect(loonRendered).toContain('grpc-service-name=edge');
        expect(loonRendered).toContain('reality=true');
        expect(loonRendered).toContain('WG-01 = wireguard');
        expect(loonRendered).toContain('RULE-SET,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list,🤖 AI 服务');
        expect(loonRendered).toContain('🚀 节点选择 = select');
        expect(quanxRendered).toContain('[server_local]');
        expect(quanxRendered).toContain('[policy]');
        expect(quanxRendered).toContain('[filter_remote]');
        expect(quanxRendered).toContain('[filter_local]');
        expect(quanxRendered).toContain('vmess=1.2.3.6:443, method=none, password=uuid-5678, obfs=wss, obfs-uri=/ws, obfs-host=example.com, tag=🇺🇸 US-01');
        expect(quanxRendered).not.toContain('vmess=1.2.3.6:443, method=none, password=uuid-5678, obfs=ws,');
        expect(quanxRendered).toContain('filter_remote, https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list, tag=🤖 AI 服务, force-policy=🤖 AI 服务, update-interval=86400, enabled=true');
        expect(quanxRendered).toContain('static=🚀 节点选择');
        expect(surgeRendered).not.toContain('SG-01 = vless');
        expect(surgeRendered).toContain('WG-01 = wireguard');
        expect(surgeRendered).toContain('RULE-SET,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list,🤖 AI 服务');
        expect(surgeRendered).toContain('🚀 节点选择 = select');
    });

    it('should render Loon vmess and trojan proxies with compatible syntax', () => {
        const loonRendered = renderLoonFromIniTemplate(`
[Proxy]
custom_proxy_group=TestGroup` , {
            nodeList: [
                'vmess://eyJ2IjoiMiIsInBzIjoiVk1FU1MtV1MiLCJhZGQiOiJwcm94eS5leGFtcGxlLmludmFsaWQiLCJwb3J0IjoiNDQzIiwiaWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhaWQiOiIwIiwic2N5IjoiYXV0byIsIm5ldCI6IndzIiwidHlwZSI6Im5vbmUiLCJob3N0Ijoid3MuZXhhbXBsZS5pbnZhbGlkIiwicGF0aCI6Ii92bWVzcy1hcmdvP2VkPTI1NjAiLCJ0bHMiOiJ0bHMiLCJzbmkiOiJ3cy5leGFtcGxlLmludmFsaWQiLCJmcCI6ImZpcmVmb3gifQ==',
                'trojan://synthetic-password@proxy.example.invalid:443?security=tls&sni=ws.example.invalid&fp=firefox&insecure=0&allowInsecure=0&type=ws&host=ws.example.invalid&path=%2Ftrojan-argo%3Fed%3D2560#Trojan-WS'
            ].join('\n'),
            targetFormat: 'loon'
        });

        expect(loonRendered).toContain('VMESS-WS = vmess, proxy.example.invalid, 443, auto, "11111111-1111-4111-8111-111111111111", 0, over-tls=true, transport=ws, path=/vmess-argo?ed=2560, host=ws.example.invalid, sni=ws.example.invalid');
        expect(loonRendered).toContain('Trojan-WS = trojan, proxy.example.invalid, 443, synthetic-password, transport=ws, path=/trojan-argo?ed=2560, host=ws.example.invalid, sni=ws.example.invalid');
        expect(loonRendered).not.toContain(', tls=true');
        expect(loonRendered).not.toContain('password=synthetic-password');
    });

    it('should render Loon vless ws with path host and over-tls syntax', () => {
        const loonRendered = renderLoonFromIniTemplate(`
[Proxy]
custom_proxy_group=TestGroup`, {
            nodeList: 'vless://11111111-1111-4111-8111-111111111111@proxy.example.invalid:443?encryption=none&security=tls&sni=ws.example.invalid&fp=firefox&insecure=0&allowInsecure=0&type=ws&host=ws.example.invalid&path=%2Fvless-argo%3Fed%3D2560#VLESS-WS',
            targetFormat: 'loon'
        });

        expect(loonRendered).toContain('VLESS-WS = vless, proxy.example.invalid, 443, 11111111-1111-4111-8111-111111111111, transport=ws, path=/vless-argo?ed=2560, host=ws.example.invalid, over-tls=true, sni=ws.example.invalid');
        expect(loonRendered).not.toContain(', tls=true');
    });

    it('should render Loon anytls syntax', () => {
        const loonRendered = renderLoonFromIniTemplate(`
[Proxy]
custom_proxy_group=TestGroup`, {
            nodeList: 'anytls://synthetic-password@anytls.example.invalid:443/?sni=tls.example.invalid&alpn=h2%2Ch3&allowInsecure=1#AnyTLS-HK',
            targetFormat: 'loon'
        });

        expect(loonRendered).toContain('AnyTLS-HK = anytls, anytls.example.invalid, 443, synthetic-password, sni=tls.example.invalid, alpn=h2,h3, skip-cert-verify=true');
    });

    it('should render Surge tuic syntax for sample nodes', () => {
        const surgeRendered = renderSurgeFromIniTemplate(`
[Proxy]
custom_proxy_group=TestGroup`, {
            nodeList: 'tuic://a276f4e4-08b4-4a03-bfe8-f36ef17ad133:a276f4e4-08b4-4a03-bfe8-f36ef17ad133@5.45.102.158:39689?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=www.bing.com&allow_insecure=1&allowInsecure=1#TUIC-Surge',
            targetFormat: 'surge&ver=4'
        });

        expect(surgeRendered).toContain('TUIC-Surge = tuic, 5.45.102.158, 39689, token=a276f4e4-08b4-4a03-bfe8-f36ef17ad133:a276f4e4-08b4-4a03-bfe8-f36ef17ad133, sni=www.bing.com, congestion-control=bbr, udp-relay=true, alpn=h3, skip-cert-verify=true');
    });

    it('should skip vless nodes when rendering Surge configs', () => {
        const surgeRendered = renderSurgeFromIniTemplate(`
[Proxy]
custom_proxy_group=TestGroup`, {
            nodeList: 'vless://uuid-9999@1.2.3.7:443?security=reality&type=grpc&serviceName=edge&pbk=testpublickey&sid=abcd&sni=example.com#SG-01',
            targetFormat: 'surge&ver=4'
        });

        expect(surgeRendered).not.toContain('SG-01 = vless');
        expect(surgeRendered).not.toContain('grpc-service-name=edge');
        expect(surgeRendered).not.toContain('reality=true');
    });

    it('should render QuanX DNS using syntax accepted by Quantumult X', () => {
        const quanxRendered = renderQuanxFromIniTemplate(`
[Proxy]
custom_proxy_group=TestGroup`, {
            nodeList: 'trojan://password@1.2.3.4:443#HK-01',
            targetFormat: 'quanx'
        });

        expect(quanxRendered).toContain('[dns]');
        expect(quanxRendered).toContain('no-ipv6');
        expect(quanxRendered).toContain('server = 223.5.5.5');
        expect(quanxRendered).toContain('server = 114.114.114.114');
        expect(quanxRendered).not.toContain('prefer-ipv4=true');
        expect(quanxRendered).not.toContain('server=223.5.5.5');
    });

    it('should render QuanX tuic and anytls syntax while skipping unsupported hysteria2', () => {
        const quanxRendered = renderQuanxFromIniTemplate(`
[Proxy]
custom_proxy_group=TestGroup`, {
            nodeList: [
                'hysteria2://a276f4e4-08b4-4a03-bfe8-f36ef17ad133@5.45.102.158:11416?security=tls&alpn=h3&insecure=1&mport=&sni=www.bing.com#HY2-QX',
                'tuic://a276f4e4-08b4-4a03-bfe8-f36ef17ad133:a276f4e4-08b4-4a03-bfe8-f36ef17ad133@5.45.102.158:39689?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=www.bing.com&allow_insecure=1&allowInsecure=1#TUIC-QX',
                'anytls://9d6c62f6-e38d-4146-ab3e-d40568555f89@156.239.232.67:443/?sni=xkhkfree.99887766.best&alpn=h2%2Ch3&allowInsecure=1#AnyTLS-QX'
            ].join('\n'),
            targetFormat: 'quanx'
        });

        expect(quanxRendered).not.toContain('hysteria2=');
        expect(quanxRendered).toContain('tuic=5.45.102.158:39689, a276f4e4-08b4-4a03-bfe8-f36ef17ad133, a276f4e4-08b4-4a03-bfe8-f36ef17ad133, sni=www.bing.com, congestion-controller=bbr, udp-relay=native, alpn=h3, tls-verification=false, tag=🌍 TUIC-QX');
        expect(quanxRendered).toContain('anytls=156.239.232.67:443, password=9d6c62f6-e38d-4146-ab3e-d40568555f89, over-tls=true, tls-verification=false, tls-host=xkhkfree.99887766.best, fast-open=false, udp-relay=true, tag=🌍 AnyTLS-QX');
    });

    it('should render QuanX VLESS TLS, REALITY and XTLS Vision syntax from templates', () => {
        const quanxRendered = renderQuanxFromIniTemplate(`
[Proxy]
custom_proxy_group=TestGroup`, {
            nodeList: [
                'vless://11111111-1111-4111-8111-111111111111@tls.example.com:443?security=tls&sni=tls.example.com&type=tcp#VLESS-TLS',
                'vless://22222222-2222-4222-8222-222222222222@reality.example.com:443?security=reality&sni=addons.mozilla.org&pbk=testpublickey&sid=abcdef&type=tcp#VLESS-Reality',
                'vless://33333333-3333-4333-8333-333333333333@vision.example.com:443?security=tls&sni=vision.example.com&flow=xtls-rprx-vision&type=tcp#VLESS-Vision'
            ].join('\n'),
            targetFormat: 'quanx'
        });

        expect(quanxRendered).toContain('vless=tls.example.com:443, password=11111111-1111-4111-8111-111111111111, method=none, obfs=over-tls, obfs-host=tls.example.com, tag=🌍 VLESS-TLS');
        expect(quanxRendered).toContain('vless=reality.example.com:443, password=22222222-2222-4222-8222-222222222222, method=none, obfs=over-tls, obfs-host=addons.mozilla.org, reality-base64-pubkey=testpublickey, reality-hex-shortid=abcdef, tag=🌍 VLESS-Reality');
        expect(quanxRendered).toContain('vless=vision.example.com:443, password=33333333-3333-4333-8333-333333333333, method=none, obfs=over-tls, obfs-host=vision.example.com, vless-flow=xtls-rprx-vision, tag=🌍 VLESS-Vision');
        expect(quanxRendered).not.toContain('over-tls=true');
        expect(quanxRendered).not.toContain('tls-host=vision.example.com');
    });

    it('should render QuanX vmess ws tls tag at the end in template output', () => {
        const vmessConfig = Buffer.from(JSON.stringify({
            v: '2', ps: 'VMESS 节点', add: 'ip.sb', port: '443',
            id: '6f4e029b-099f-45f6-afd2-33f0e8f86f15', aid: '0', scy: 'auto',
            net: 'ws', type: 'none', host: 'gbwarp.owg.dpdns.org', path: '/vmess-argo?ed=2560',
            tls: 'tls', sni: 'gbwarp.owg.dpdns.org'
        })).toString('base64');
        const quanxRendered = renderQuanxFromIniTemplate(`[Proxy]`, {
            nodeList: `vmess://${vmessConfig}`,
            targetFormat: 'quanx'
        });
        const line = quanxRendered.split('\n').find(item => item.startsWith('vmess='));

        expect(line).toBe('vmess=ip.sb:443, method=none, password=6f4e029b-099f-45f6-afd2-33f0e8f86f15, obfs=wss, obfs-uri=/vmess-argo?ed=2560, obfs-host=gbwarp.owg.dpdns.org, tag=🌍 VMESS 节点');
        expect(line).not.toContain('tag=🌍 VMESS 节点, obfs=');
        expect(line).not.toContain('over-tls=true');
        expect(line).not.toContain('tls-host=');
    });

    it('should render SS2022 v2ray-plugin websocket in non-Clash template targets', () => {
        const template = `
[Proxy]
custom_proxy_group=TestGroup`;
        const surgeRendered = renderSurgeFromIniTemplate(template, { nodeList: SS2022_V2RAY_PLUGIN_NODE, targetFormat: 'surge&ver=4' });
        const loonRendered = renderLoonFromIniTemplate(template, { nodeList: SS2022_V2RAY_PLUGIN_NODE, targetFormat: 'loon' });
        const quanxRendered = renderQuanxFromIniTemplate(template, { nodeList: SS2022_V2RAY_PLUGIN_NODE, targetFormat: 'quanx' });
        const singboxRendered = renderSingboxFromIniTemplate(template, { nodeList: SS2022_V2RAY_PLUGIN_NODE, targetFormat: 'singbox' });
        const singbox = JSON.parse(singboxRendered);
        const ssOutbound = singbox.outbounds.find(outbound => outbound.type === 'shadowsocks');

        expect(surgeRendered).toContain('encrypt-method=2022-blake3-aes-256-gcm');
        expect(surgeRendered).toContain('ws=true');
        expect(surgeRendered).toContain('ws-path=/?enc=2022-blake3-aes-256-gcm');
        expect(surgeRendered).toContain('ws-headers=Host:ws.example.invalid');

        expect(loonRendered).toContain('transport=ws');
        expect(loonRendered).toContain('path=/?enc=2022-blake3-aes-256-gcm');
        expect(loonRendered).toContain('host=ws.example.invalid');

        expect(quanxRendered).toContain('method=2022-blake3-aes-256-gcm');
        expect(quanxRendered).toContain('obfs=ws');
        expect(quanxRendered).toContain('obfs-uri=/?enc=2022-blake3-aes-256-gcm');
        expect(quanxRendered).toContain('obfs-host=ws.example.invalid');
        expect(quanxRendered).not.toContain('over-tls=true');

        expect(ssOutbound?.method).toBe('2022-blake3-aes-256-gcm');
        expect(ssOutbound?.plugin).toBe('v2ray-plugin');
        expect(ssOutbound?.plugin_opts).toBe('mode=websocket;host=ws.example.invalid;path=/?enc=2022-blake3-aes-256-gcm');
        expect(ssOutbound?.transport).toBeUndefined();
        expect(ssOutbound?.tls).toBeUndefined();
    });

    it('should convert ACL4SSR list rules into clash yaml providers', () => {
        const builtinTemplate = getBuiltinTemplate('clash_acl4ssr_lite');
        const rendered = renderClashFromIniTemplate(builtinTemplate.content, {
            nodeList: [
                'trojan://password@1.2.3.4:443#HK-01',
                'trojan://password@1.2.3.5:443#JP-01',
                'trojan://password@1.2.3.6:443#US-01'
            ].join('\n'),
            targetFormat: 'clash'
        });

        const parsed = yaml.load(rendered);
        const providers = parsed['rule-providers'] || {};
        const providerUrls = Object.values(providers).map(provider => provider.url);

        expect(providerUrls.length).toBeGreaterThan(0);
        expect(providerUrls.some(url => String(url).includes('/Clash/Providers/Ruleset/YouTube.yaml'))).toBe(true);
        expect(providerUrls.some(url => String(url).includes('/Clash/Providers/ProxyGFWlist.yaml'))).toBe(true);
        expect(providerUrls.some(url => String(url).includes('/Clash/BanAD.list'))).toBe(true);
        expect(Object.values(providers).some(provider => provider.url.includes('/Clash/BanAD.list') && provider.format === 'text')).toBe(true);
    });

    it('should map only ACL4SSR lists with existing provider YAML files to provider URLs', () => {
        const rendered = renderClashFromIniTemplate(`
[custom]
ruleset=📲 电报消息,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Telegram.list
ruleset=🚀 节点选择,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyGFWlist.list
ruleset=🐟 漏网之鱼,[]FINAL
custom_proxy_group=🚀 节点选择\`select\`[]DIRECT\`.*
`, {
            nodeList: 'trojan://password@1.2.3.4:443#HK-01',
            targetFormat: 'clash'
        });

        const parsed = yaml.load(rendered);
        const providerUrls = Object.values(parsed['rule-providers'] || {}).map(provider => provider.url);

        expect(providerUrls).toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Providers/Ruleset/Telegram.yaml');
        expect(providerUrls).toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Providers/ProxyGFWlist.yaml');
    });

    it('keeps ACL4SSR root list rules inline when provider YAML files are missing', () => {
        const rendered = renderClashFromIniTemplate(`
[custom]
ruleset=🎯 全球直连,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list
ruleset=🛑 广告拦截,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanAD.list
ruleset=🐟 漏网之鱼,[]FINAL
custom_proxy_group=🚀 节点选择\`select\`[]DIRECT\`.*
`, {
            nodeList: 'trojan://password@1.2.3.4:443#HK-01',
            targetFormat: 'clash'
        });

        const parsed = yaml.load(rendered);
        const providerUrls = Object.values(parsed['rule-providers'] || {}).map(provider => provider.url);

        const localAreaProvider = Object.values(parsed['rule-providers'] || {}).find(provider => provider.url.includes('/Clash/LocalAreaNetwork.list'));
        const banAdProvider = Object.values(parsed['rule-providers'] || {}).find(provider => provider.url.includes('/Clash/BanAD.list'));

        expect(providerUrls).not.toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Providers/Ruleset/LocalAreaNetwork.yaml');
        expect(providerUrls).not.toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Providers/Ruleset/BanAD.yaml');
        expect(localAreaProvider).toMatchObject({ behavior: 'classical', format: 'text', path: './ruleset/localareanetwork_0.list' });
        expect(banAdProvider).toMatchObject({ behavior: 'classical', format: 'text', path: './ruleset/banad_1.list' });
        expect(parsed.rules).toContain('RULE-SET,localareanetwork_0,🎯 全球直连');
        expect(parsed.rules).toContain('RULE-SET,banad_1,🛑 广告拦截');
    });

    it('maps ACL4SSR root IP lists to matching ipcidr provider YAML files', () => {
        const rendered = renderClashFromIniTemplate(`
[custom]
ruleset=🎯 全球直连,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaCompanyIp.list
ruleset=🎯 全球直连,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaIp.list
ruleset=🎯 全球直连,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaIpV6.list
ruleset=🐟 漏网之鱼,[]FINAL
custom_proxy_group=🚀 节点选择\`select\`[]DIRECT\`.*
`, {
            nodeList: 'trojan://password@1.2.3.4:443#HK-01',
            targetFormat: 'clash'
        });

        const parsed = yaml.load(rendered);
        const providers = Object.values(parsed['rule-providers'] || {});
        const providerUrls = providers.map(provider => provider.url);

        expect(providerUrls).toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Providers/ChinaCompanyIp.yaml');
        expect(providerUrls).toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Providers/ChinaIp.yaml');
        expect(providerUrls).toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Providers/ChinaIpV6.yaml');
        expect(providerUrls).not.toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaCompanyIp.list');

        for (const provider of providers) {
            expect(provider).toMatchObject({ behavior: 'ipcidr' });
            expect(provider.path).toMatch(/\.yaml$/);
            expect(provider.format).toBeUndefined();
        }
    });

    it('keeps ACL4SSR Download list as a text provider because YAML comments out most rules', () => {
        const rendered = renderClashFromIniTemplate(`
[custom]
ruleset=📥 下载服务,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Download.list
ruleset=🐟 漏网之鱼,[]FINAL
custom_proxy_group=🚀 节点选择\`select\`[]DIRECT\`.*
custom_proxy_group=📥 下载服务\`select\`[]🚀 节点选择\`[]DIRECT
`, {
            nodeList: 'trojan://password@1.2.3.4:443#HK-01',
            targetFormat: 'clash'
        });

        const parsed = yaml.load(rendered);
        const providers = parsed['rule-providers'] || {};
        const downloadProvider = Object.values(providers).find(provider => provider.url.includes('/Clash/Download.list'));

        expect(Object.values(providers).map(provider => provider.url)).not.toContain('https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Providers/Download.yaml');
        expect(downloadProvider).toMatchObject({ behavior: 'classical', format: 'text', path: './ruleset/download_0.list' });
        expect(parsed.rules).toContain('RULE-SET,download_0,📥 下载服务');
    });

    it('keeps non-ACL4SSR raw GitHub rule URLs unchanged', () => {
        const rendered = renderClashFromIniTemplate(`
[custom]
ruleset=🎯 全球直连,https://raw.githubusercontent.com/szkane/ClashRuleSet/main/Clash/Apple.list
ruleset=🎯 全球直连,https://raw.githubusercontent.com/szkane/ClashRuleSet/main/Clash/Microsoft.list
ruleset=🐟 漏网之鱼,[]FINAL
custom_proxy_group=🚀 节点选择\`select\`[]DIRECT\`.*
`, {
            nodeList: 'trojan://password@1.2.3.4:443#HK-01',
            targetFormat: 'clash'
        });

        const parsed = yaml.load(rendered);
        const providerUrls = Object.values(parsed['rule-providers'] || {}).map(provider => provider.url);

        expect(providerUrls).toContain('https://raw.githubusercontent.com/szkane/ClashRuleSet/main/Clash/Apple.list');
        expect(providerUrls).toContain('https://raw.githubusercontent.com/szkane/ClashRuleSet/main/Clash/Microsoft.list');
        expect(providerUrls).not.toContain('https://raw.githubusercontent.com/szkane/ClashRuleSet/main/Clash/Providers/Apple.yaml');
        expect(providerUrls).not.toContain('https://raw.githubusercontent.com/szkane/ClashRuleSet/main/Clash/Providers/Ruleset/Microsoft.yaml');
        expect(Object.values(parsed['rule-providers'] || {})).toEqual(expect.arrayContaining([
            expect.objectContaining({ format: 'text', path: './ruleset/apple_0.list' }),
            expect.objectContaining({ format: 'text', path: './ruleset/microsoft_1.list' })
        ]));
    });

    it('uses short ACL4SSR file names as rule-provider name hints instead of rs fallback names', () => {
        const rendered = renderClashFromIniTemplate(`
[custom]
ruleset=🤖 AI 服务,https://rules.example.test/AI.list
ruleset=🐟 漏网之鱼,[]FINAL
custom_proxy_group=🚀 节点选择\`select\`[]DIRECT\`.*
custom_proxy_group=🤖 AI 服务\`select\`[]🚀 节点选择\`[]DIRECT
`, {
            nodeList: 'trojan://password@1.2.3.4:443#HK-01',
            targetFormat: 'clash'
        });

        const parsed = yaml.load(rendered);
        const providers = parsed['rule-providers'] || {};

        expect(Object.keys(providers)).toContain('ai_0');
        expect(Object.keys(providers)).not.toContain('rs_0');
        expect(providers.ai_0).toMatchObject({
            behavior: 'classical',
            format: 'text',
            url: 'https://rules.example.test/AI.list',
            path: './ruleset/ai_0.list'
        });
        expect(parsed.rules).toContain('RULE-SET,ai_0,🤖 AI 服务');
    });
});

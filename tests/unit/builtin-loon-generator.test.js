import { describe, it, expect } from 'vitest';
import { generateBuiltinLoonConfig } from '../../functions/modules/subscription/builtin-loon-generator.js';

describe('Loon 内置生成器', () => {
    it('应处理 realityOpts 参数', () => {
        const vless = 'vless://uuid@1.2.3.4:443?type=tcp&security=reality&pbk=pubkey123&sid=shortid#RealityNode';
        const result = generateBuiltinLoonConfig(vless);
        expect(result).toContain('RealityNode = vless');
        expect(result).toContain('reality=true');
        expect(result).toContain('public-key=pubkey123');
        expect(result).toContain('short-id=shortid');
    });

    it('应保留 VLESS flow 参数且不默认跳过证书验证', () => {
        const vless = 'vless://uuid@1.2.3.4:443?type=tcp&security=reality&flow=xtls-rprx-vision&pbk=pubkey123&sid=shortid#RealityFlow';
        const result = generateBuiltinLoonConfig(vless);
        expect(result).toContain('flow=xtls-rprx-vision');
        expect(result).not.toContain('skip-cert-verify=true');
    });

    it('应对重名节点添加 _1 后缀', () => {
        const nodeList = [
            'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#SameName',
            'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@5.6.7.8:8388#SameName'
        ].join('\n');
        const result = generateBuiltinLoonConfig(nodeList);
        expect(result).toContain('SameName = Shadowsocks');
        expect(result).toContain('SameName_1 = Shadowsocks');
    });

    it('应生成 Loon TUIC v5 的完整兼容参数', () => {
        const tuic = 'tuic://11111111-1111-4111-8111-111111111111:password@1.2.3.4:443?sni=www.cloudflare.com&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1&pcs=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&spki=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE%3D#TUIC';
        const result = generateBuiltinLoonConfig(tuic);
        expect(result).toContain('TUIC = tuic, 1.2.3.4, 443, password, 11111111-1111-4111-8111-111111111111, version=5');
        expect(result).toContain('sni=www.cloudflare.com');
        expect(result).toContain('skip-cert-verify=true');
        expect(result).toContain('alpn=h3');
        expect(result).toContain('congestion-control=bbr');
        expect(result).toContain('udp-relay-mode=native');
        expect(result).not.toContain('reduce-rtt=');

        const explicit = generateBuiltinLoonConfig(tuic.replace('allow_insecure=1', 'allow_insecure=1&reduce_rtt=1'));
        expect(explicit).toContain('reduce-rtt=true');
    });

    it('应将部署 HY2 证书指纹转换为 Loon 可用的证书选项', () => {
        const hysteria2 = 'hysteria2://password@1.2.3.4:443?sni=www.cloudflare.com&pinSHA256=abcdef#HY2';
        const result = generateBuiltinLoonConfig(hysteria2);
        expect(result).toContain('HY2 = hysteria2');
        expect(result).toContain('skip-cert-verify=true');
    });
});

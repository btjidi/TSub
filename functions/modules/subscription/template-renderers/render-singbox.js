import { urlsToClashProxies } from '../../../utils/url-to-clash.js';
import { buildSingboxOutbound } from '../builtin-singbox-generator.js';
import { normalizeUnifiedTemplateModel } from '../template-model.js';

function sanitizeTag(value) {
    return String(value || '').trim() || 'Untitled';
}

function mapGroupType(type) {
    const normalized = String(type || '').toLowerCase();
    if (normalized === 'select') return 'selector';
    if (normalized === 'url-test') return 'urltest';
    if (normalized === 'load-balance') return 'selector';
    return 'selector';
}

function buildGroupOutbounds(groups) {
    return groups.map(group => {
        const mappedType = mapGroupType(group.type);
        const rawMembers = Array.isArray(group.members) ? group.members.filter(Boolean) : [];
        const outbound = {
            tag: sanitizeTag(group.name),
            type: mappedType,
            outbounds: ['urltest'].includes(mappedType)
                ? rawMembers.filter(member => !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'].includes(String(member).toUpperCase()))
                : rawMembers
        };

        if (mappedType === 'urltest') {
            outbound.url = group.options?.url || 'http://www.gstatic.com/generate_204';
            outbound.interval = `${group.options?.interval || 300}s`;
        }

        if (outbound.outbounds.length > 0) {
            outbound.default = outbound.outbounds[0];
        }

        return outbound;
    });
}

function mapRuleToSingbox(rule) {
    const type = String(rule.type || '').toLowerCase();
    if (type === 'rule-set') {
        return {
            rule_set: sanitizeTag(`${rule.policy}_${rule.value}`),
            outbound: rule.policy
        };
    }
    if (type === 'geoip') {
        const value = String(rule.value || 'cn').toLowerCase();
        return {
            rule_set: [`geoip-${value}`],
            outbound: rule.policy
        };
    }
    if (type === 'geosite') {
        const value = String(rule.value || 'cn').toLowerCase();
        return {
            rule_set: [`geosite-${value}`],
            outbound: rule.policy
        };
    }
    if (type === 'match' || type === 'final') {
        return {
            outbound: rule.policy
        };
    }
    if (type === 'domain-suffix') {
        return {
            domain_suffix: [rule.value],
            outbound: rule.policy
        };
    }
    if (type === 'domain-keyword') {
        return {
            domain_keyword: [rule.value],
            outbound: rule.policy
        };
    }
    return null;
}

function detectRuleSetFormat(url) {
    const raw = String(url || '').trim().toLowerCase();
    if (!raw) return 'source';
    return raw.endsWith('.srs') ? 'binary' : 'source';
}

function buildRuleSets(rules) {
    const remoteRuleSets = rules
        .filter(rule => String(rule.type || '').toLowerCase() === 'rule-set' && rule.source === 'remote')
        .map(rule => ({
            tag: sanitizeTag(`${rule.policy}_${rule.value}`),
            type: 'remote',
            format: detectRuleSetFormat(rule.value),
            url: rule.value,
            download_detour: 'DIRECT'
        }));

    const implicitRuleSets = [];
    const seen = new Set();

    rules.forEach(rule => {
        const type = String(rule.type || '').toLowerCase();
        if (type === 'geoip' || type === 'geosite') {
            const value = String(rule.value || 'cn').toLowerCase();
            const tag = `${type}-${value}`;
            if (!seen.has(tag)) {
                seen.add(tag);
                implicitRuleSets.push({
                    tag,
                    type: 'remote',
                    format: 'binary',
                    url: type === 'geoip'
                        ? `https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-${value}.srs`
                        : `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-${value}.srs`,
                    download_detour: 'DIRECT'
                });
            }
        }
    });

    return [...remoteRuleSets, ...implicitRuleSets];
}

export function renderSingboxFromTemplateModel(model, options = {}) {
    const normalizedModel = normalizeUnifiedTemplateModel(model);
    const nodeList = typeof options.nodeList === 'string' ? options.nodeList : '';
    const proxyUrls = nodeList
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    const proxies = Array.isArray(normalizedModel.proxies) && normalizedModel.proxies.length > 0
        ? normalizedModel.proxies
        : urlsToClashProxies(proxyUrls);
    const builtNodes = proxies.map(buildSingboxOutbound).filter(Boolean);
    const proxyOutbounds = builtNodes.filter(item => !item.endpoint);
    const endpoints = builtNodes.map(item => item.endpoint).filter(Boolean);
    const groupOutbounds = buildGroupOutbounds(normalizedModel.groups.filter(g => Array.isArray(g.members) && g.members.length > 0));
    const ruleSetObjects = buildRuleSets(normalizedModel.rules);
    const routeRules = normalizedModel.rules.map(mapRuleToSingbox).filter(Boolean);

    const config = {
        log: { level: 'info' },
        dns: {
            strategy: 'prefer_ipv4',
            servers: [
                { tag: 'dns-ali', type: 'udp', server: '223.5.5.5', server_port: 53, detour: 'DIRECT' },
                { tag: 'dns-google', type: 'udp', server: '8.8.8.8', server_port: 53, detour: 'DIRECT' }
            ]
        },
        outbounds: [
            { tag: 'DIRECT', type: 'direct' },
            { tag: 'REJECT', type: 'block' },
            ...proxyOutbounds,
            ...groupOutbounds
        ],
        ...(endpoints.length ? { endpoints } : {}),
        route: {
            auto_detect_interface: true,
            final: normalizedModel.groups[0]?.name || 'DIRECT',
            rule_set: ruleSetObjects,
            rules: routeRules
        }
    };

    return JSON.stringify(config, null, 2) + '\n';
}

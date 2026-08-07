import { generateBuiltinClashConfig } from './builtin-clash-generator.js';
import { generateBuiltinSurgeConfig } from './builtin-surge-generator.js';
import { generateBuiltinLoonConfig } from './builtin-loon-generator.js';
import { generateBuiltinQuanxConfig } from './builtin-quanx-generator.js';
import { generateBuiltinSingboxConfig } from './builtin-singbox-generator.js';
import { generateBuiltinEgernConfig } from './builtin-egern-generator.js';
import { urlToClashProxy } from '../../utils/url-to-clash.js';
import { normalizeSubscriptionTarget, targetSupportsProxy } from '../../../shared/subscription-target-capabilities.js';

function nodeProtocol(line) {
    return String(line).match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase() || 'unknown';
}

function filterNodeList(nodeList, targetFormat) {
    const target = normalizeSubscriptionTarget(targetFormat);
    const lines = String(nodeList || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const included = [];
    const omitted = [];
    const warnings = [];
    for (const line of lines) {
        const proxy = urlToClashProxy(line);
        if (!proxy) {
            omitted.push({ name: 'Unknown', protocol: nodeProtocol(line), transport: 'unknown', reason: 'invalid-node' });
            continue;
        }
        const result = targetSupportsProxy(target, proxy);
        if (!result.supported) {
            omitted.push({ name: String(proxy.name || 'Untitled'), protocol: String(proxy.type || nodeProtocol(line)), transport: String(proxy.network || 'tcp'), reason: result.reason });
            continue;
        }
        included.push(line);
        if (target === 'singbox' && proxy.type === 'naive') warnings.push({ name: String(proxy.name || 'Untitled'), protocol: 'naive', transport: 'https', reason: 'client-build-capability-required' });
    }
    return {
        nodeList: `${included.join('\n')}${included.length ? '\n' : ''}`,
        diagnostics: { target, total: lines.length, rendered: included.length, omitted: omitted.length, items: omitted, warnings, rawTarget: 'nodes' }
    };
}

export function transformBuiltinSubscriptionDetailed(nodeList, targetFormat, options = {}) {
    const normalized = (targetFormat || '').toLowerCase();
    const targetKey = normalizeSubscriptionTarget(normalized);
    const filtered = filterNodeList(nodeList, targetKey);
    let content = null;

    switch (targetKey) {
        case 'clash': content = generateBuiltinClashConfig(filtered.nodeList, options); break;
        case 'surge': content = generateBuiltinSurgeConfig(filtered.nodeList, options); break;
        case 'loon': content = generateBuiltinLoonConfig(filtered.nodeList, options); break;
        case 'quanx': content = generateBuiltinQuanxConfig(filtered.nodeList, options); break;
        case 'singbox': content = generateBuiltinSingboxConfig(filtered.nodeList, options); break;
        case 'egern': content = generateBuiltinEgernConfig(filtered.nodeList, options); break;
        default: return { content: null, diagnostics: { target: targetKey, total: 0, rendered: 0, omitted: 0, items: [], warnings: [], rawTarget: 'nodes' } };
    }
    return { content, diagnostics: filtered.diagnostics };
}

export function transformBuiltinSubscription(nodeList, targetFormat, options = {}) {
    return transformBuiltinSubscriptionDetailed(nodeList, targetFormat, options).content;
}

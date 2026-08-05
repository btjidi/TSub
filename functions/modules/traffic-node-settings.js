export const TRAFFIC_NODE_KEYS = ['upload', 'download', 'total', 'remaining'];
export const TRAFFIC_NODE_LAYOUTS = ['one', 'two', 'four'];
export const DEFAULT_TRAFFIC_NODE_LAYOUT = 'two';
export const TRAFFIC_NODE_CUSTOM_LABEL_MAX_LENGTH = 24;

export const DEFAULT_TRAFFIC_NODE_DISPLAY = Object.freeze({
    layout: DEFAULT_TRAFFIC_NODE_LAYOUT,
    upload: Object.freeze({ enabled: true, label: 'symbol', customLabel: '' }),
    download: Object.freeze({ enabled: true, label: 'symbol', customLabel: '' }),
    total: Object.freeze({ enabled: true, label: 'symbol', customLabel: '' }),
    remaining: Object.freeze({ enabled: true, label: 'symbol', customLabel: '' })
});

export const TRAFFIC_NODE_LABELS = Object.freeze({
    upload: Object.freeze({ symbol: '↑', single: '上', short: '上行', full: '上行流量' }),
    download: Object.freeze({ symbol: '↓', single: '下', short: '下行', full: '下行流量' }),
    total: Object.freeze({ symbol: 'TOT', single: '总', short: '总计', full: '总计流量' }),
    remaining: Object.freeze({ symbol: 'REM', single: '剩', short: '剩余', full: '剩余流量' })
});

export function sanitizeTrafficNodeCustomLabel(value) {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
        : '';
}

export function validateTrafficNodeCustomLabels(value) {
    const input = value && typeof value === 'object' ? value : {};
    for (const key of TRAFFIC_NODE_KEYS) {
        const item = input[key] && typeof input[key] === 'object' ? input[key] : {};
        if (item.enabled === false || item.label !== 'custom') continue;
        const customLabel = sanitizeTrafficNodeCustomLabel(item.customLabel);
        if (!customLabel) return { valid: false, key, reason: 'required' };
        if ([...customLabel].length > TRAFFIC_NODE_CUSTOM_LABEL_MAX_LENGTH) {
            return { valid: false, key, reason: 'tooLong' };
        }
    }
    return { valid: true };
}

export function normalizeTrafficNodeDisplay(value) {
    const input = value && typeof value === 'object' ? value : {};
    const metrics = Object.fromEntries(TRAFFIC_NODE_KEYS.map(key => {
        const item = input[key] && typeof input[key] === 'object' ? input[key] : {};
        const customLabel = sanitizeTrafficNodeCustomLabel(item.customLabel);
        const hasValidCustomLabel = customLabel && [...customLabel].length <= TRAFFIC_NODE_CUSTOM_LABEL_MAX_LENGTH;
        const hasFixedLabel = Object.prototype.hasOwnProperty.call(TRAFFIC_NODE_LABELS[key], item.label);
        const label = item.label === 'custom' && hasValidCustomLabel
            ? 'custom'
            : hasFixedLabel ? item.label : DEFAULT_TRAFFIC_NODE_DISPLAY[key].label;
        return [key, {
            enabled: item.enabled === undefined ? DEFAULT_TRAFFIC_NODE_DISPLAY[key].enabled : item.enabled === true,
            label,
            customLabel: hasValidCustomLabel ? customLabel : ''
        }];
    }));
    return {
        layout: TRAFFIC_NODE_LAYOUTS.includes(input.layout) ? input.layout : DEFAULT_TRAFFIC_NODE_LAYOUT,
        ...metrics
    };
}

export function hasEnabledTrafficNode(display) {
    const normalized = normalizeTrafficNodeDisplay(display);
    return TRAFFIC_NODE_KEYS.some(key => normalized[key].enabled);
}

export function resolveTrafficNodeLabel(key, label, customLabel = '') {
    if (label === 'custom') {
        const normalized = sanitizeTrafficNodeCustomLabel(customLabel);
        if (normalized && [...normalized].length <= TRAFFIC_NODE_CUSTOM_LABEL_MAX_LENGTH) return normalized;
    }
    return TRAFFIC_NODE_LABELS[key]?.[label] || TRAFFIC_NODE_LABELS[key]?.symbol || '';
}

export function groupTrafficNodeItems(items, layout) {
    const available = Array.isArray(items) ? items : [];
    const normalizedLayout = TRAFFIC_NODE_LAYOUTS.includes(layout) ? layout : DEFAULT_TRAFFIC_NODE_LAYOUT;
    if (normalizedLayout === 'one') return available.length ? [available] : [];
    if (normalizedLayout === 'four') return available.map(item => [item]);

    const byKey = new Map(available.map(item => [item.key, item]));
    return [
        ['upload', 'download'].map(key => byKey.get(key)).filter(Boolean),
        ['total', 'remaining'].map(key => byKey.get(key)).filter(Boolean)
    ].filter(group => group.length > 0);
}

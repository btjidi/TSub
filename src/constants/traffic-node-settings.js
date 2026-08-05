export const TRAFFIC_NODE_KEYS = ['upload', 'download', 'total', 'remaining'];
export const TRAFFIC_NODE_LAYOUTS = ['one', 'two', 'four'];
export const DEFAULT_TRAFFIC_NODE_LAYOUT = 'two';
export const TRAFFIC_NODE_CUSTOM_LABEL_MAX_LENGTH = 24;

export const DEFAULT_TRAFFIC_NODE_DISPLAY = {
    layout: DEFAULT_TRAFFIC_NODE_LAYOUT,
    upload: { enabled: true, label: 'symbol', customLabel: '' },
    download: { enabled: true, label: 'symbol', customLabel: '' },
    total: { enabled: true, label: 'symbol', customLabel: '' },
    remaining: { enabled: true, label: 'symbol', customLabel: '' }
};

export const TRAFFIC_NODE_LABEL_OPTIONS = {
    upload: [
        { value: 'symbol', text: '↑' }, { value: 'single', text: '上' },
        { value: 'short', text: '上行' }, { value: 'full', text: '上行流量' },
        { value: 'custom', text: '' }
    ],
    download: [
        { value: 'symbol', text: '↓' }, { value: 'single', text: '下' },
        { value: 'short', text: '下行' }, { value: 'full', text: '下行流量' },
        { value: 'custom', text: '' }
    ],
    total: [
        { value: 'symbol', text: 'TOT' }, { value: 'single', text: '总' },
        { value: 'short', text: '总计' }, { value: 'full', text: '总计流量' },
        { value: 'custom', text: '' }
    ],
    remaining: [
        { value: 'symbol', text: 'REM' }, { value: 'single', text: '剩' },
        { value: 'short', text: '剩余' }, { value: 'full', text: '剩余流量' },
        { value: 'custom', text: '' }
    ]
};

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
        const labels = new Set(TRAFFIC_NODE_LABEL_OPTIONS[key].map(option => option.value));
        const customLabel = sanitizeTrafficNodeCustomLabel(item.customLabel);
        const hasValidCustomLabel = customLabel && [...customLabel].length <= TRAFFIC_NODE_CUSTOM_LABEL_MAX_LENGTH;
        const label = item.label === 'custom' && !hasValidCustomLabel
            ? 'symbol'
            : labels.has(item.label) ? item.label : 'symbol';
        return [key, {
            enabled: item.enabled === undefined ? true : item.enabled === true,
            label,
            customLabel: hasValidCustomLabel ? customLabel : ''
        }];
    }));
    return {
        layout: TRAFFIC_NODE_LAYOUTS.includes(input.layout) ? input.layout : DEFAULT_TRAFFIC_NODE_LAYOUT,
        ...metrics
    };
}

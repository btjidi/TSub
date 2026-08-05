function decodeBase64(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    try { return atob(padded); } catch { return ''; }
}

function encodeBase64(value) {
    try { return btoa(value).replace(/=+$/g, ''); } catch { return ''; }
}

export function normalizeNodeIdentity(nodeUrl) {
    const value = String(nodeUrl || '').trim();
    if (!value) return '';
    if (/^vmess:\/\//i.test(value)) {
        const decoded = decodeBase64(value.slice(8));
        try {
            const payload = JSON.parse(decoded);
            delete payload.ps;
            return `vmess://${encodeBase64(JSON.stringify(payload))}`;
        } catch { return value.split('#', 1)[0]; }
    }
    return value.split('#', 1)[0];
}

export async function nodeFingerprint(nodeUrl) {
    const bytes = new TextEncoder().encode(normalizeNodeIdentity(nodeUrl));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function filterNodesBySelection(nodes, nodeSelection) {
    if (nodeSelection?.mode !== 'include' || !Array.isArray(nodeSelection.fingerprints)) return nodes;
    const allowed = new Set(nodeSelection.fingerprints.filter(value => /^[0-9a-f]{64}$/i.test(String(value))));
    if (!allowed.size) return [];
    const fingerprints = await Promise.all(nodes.map(node => nodeFingerprint(typeof node === 'string' ? node : node?.url)));
    return nodes.filter((_node, index) => allowed.has(fingerprints[index]));
}

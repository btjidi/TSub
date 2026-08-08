function decodeBase64(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    try { return atob(padded); } catch { return ''; }
}

function decodeBase64Text(value) {
    const decoded = decodeBase64(value);
    if (!decoded) return '';
    try {
        return new TextDecoder().decode(Uint8Array.from(decoded, character => character.charCodeAt(0)));
    } catch {
        return decoded;
    }
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

function normalizeIdentityName(value) {
    const name = String(value || '').trim();
    return name ? name.normalize('NFC') : '';
}

export function nodeSelectionIdentity(nodeUrl) {
    const value = String(nodeUrl || '').trim();
    const protocol = value.match(/^([a-z0-9+.-]+):\/\//i)?.[1]?.toLowerCase() || '';
    if (!protocol) return null;
    let name = '';
    if (protocol === 'vmess') {
        try { name = JSON.parse(decodeBase64Text(value.slice(8))).ps || ''; } catch { /* use an empty name */ }
    } else {
        const hashIndex = value.lastIndexOf('#');
        if (hashIndex >= 0) {
            const fragment = value.slice(hashIndex + 1);
            try { name = decodeURIComponent(fragment); } catch { name = fragment; }
        }
    }
    name = normalizeIdentityName(name);
    return name ? { protocol, name } : null;
}

export function nodeSelectionIdentityKey(identity) {
    const protocol = String(identity?.protocol || '').trim().toLowerCase();
    const name = normalizeIdentityName(identity?.name);
    return protocol && name ? `${protocol}\u0000${name}` : '';
}

function normalizeStoredIdentities(identities) {
    const normalized = new Map();
    for (const identity of Array.isArray(identities) ? identities : []) {
        const key = nodeSelectionIdentityKey(identity);
        if (key) normalized.set(key, { protocol: String(identity.protocol).trim().toLowerCase(), name: normalizeIdentityName(identity.name) });
    }
    return normalized;
}

async function describeNodes(nodes) {
    return Promise.all((Array.isArray(nodes) ? nodes : []).map(async node => {
        const url = typeof node === 'string' ? node : node?.url;
        const identity = nodeSelectionIdentity(url);
        return { node, fingerprint: await nodeFingerprint(url), identity, identityKey: nodeSelectionIdentityKey(identity) };
    }));
}

export async function reconcileNodeSelection(nodeSelection, currentNodes, options = {}) {
    if (nodeSelection?.mode !== 'include' || !Array.isArray(nodeSelection.fingerprints)) {
        return { nodeSelection, matchedFingerprints: null, matchedCount: null, staleCount: 0, changed: false };
    }
    const allowed = new Set(nodeSelection.fingerprints.filter(value => /^[0-9a-f]{64}$/i.test(String(value))).map(value => String(value).toLowerCase()));
    const desiredIdentities = normalizeStoredIdentities(nodeSelection.identities);
    const current = await describeNodes(currentNodes);
    const previous = await describeNodes(options.previousNodes || []);
    const previousIdentityCounts = new Map();
    for (const descriptor of previous) {
        if (descriptor.identityKey) previousIdentityCounts.set(descriptor.identityKey, (previousIdentityCounts.get(descriptor.identityKey) || 0) + 1);
    }
    for (const descriptor of previous) {
        if (allowed.has(descriptor.fingerprint) && descriptor.identityKey && previousIdentityCounts.get(descriptor.identityKey) === 1) {
            desiredIdentities.set(descriptor.identityKey, descriptor.identity);
        }
    }

    const currentIdentityCounts = new Map();
    for (const descriptor of current) {
        if (descriptor.identityKey) currentIdentityCounts.set(descriptor.identityKey, (currentIdentityCounts.get(descriptor.identityKey) || 0) + 1);
    }
    const matchedFingerprints = new Set();
    const matchedIdentityKeys = new Set();
    for (const descriptor of current) {
        const exact = allowed.has(descriptor.fingerprint);
        const uniqueIdentity = descriptor.identityKey
            && desiredIdentities.has(descriptor.identityKey)
            && currentIdentityCounts.get(descriptor.identityKey) === 1;
        if (!exact && !uniqueIdentity) continue;
        matchedFingerprints.add(descriptor.fingerprint);
        if (descriptor.identityKey && currentIdentityCounts.get(descriptor.identityKey) === 1) {
            desiredIdentities.set(descriptor.identityKey, descriptor.identity);
            matchedIdentityKeys.add(descriptor.identityKey);
        }
    }
    const nextIdentities = Array.from(desiredIdentities.entries())
        .filter(([key]) => matchedIdentityKeys.has(key) || options.preserveUnmatchedIdentities === true)
        .map(([, identity]) => identity);
    const nextSelection = {
        mode: 'include',
        fingerprints: Array.from(matchedFingerprints),
        identities: nextIdentities
    };
    const previousSerialized = JSON.stringify({
        mode: 'include',
        fingerprints: Array.from(allowed),
        identities: Array.from(normalizeStoredIdentities(nodeSelection.identities).values())
    });
    const changed = previousSerialized !== JSON.stringify(nextSelection);
    return {
        nodeSelection: nextSelection,
        matchedFingerprints,
        matchedCount: matchedFingerprints.size,
        staleCount: Math.max(0, allowed.size - current.filter(item => allowed.has(item.fingerprint)).length),
        changed
    };
}

export async function filterNodesBySelection(nodes, nodeSelection) {
    if (nodeSelection?.mode !== 'include' || !Array.isArray(nodeSelection.fingerprints)) return nodes;
    const reconciled = await reconcileNodeSelection(nodeSelection, nodes, { preserveUnmatchedIdentities: true });
    if (!reconciled.matchedFingerprints?.size) return [];
    const fingerprints = await Promise.all(nodes.map(node => nodeFingerprint(typeof node === 'string' ? node : node?.url)));
    return nodes.filter((_node, index) => reconciled.matchedFingerprints.has(fingerprints[index]));
}

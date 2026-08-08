function decodeBase64(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  try { return atob(padded); } catch { return ''; }
}

function decodeBase64Text(value) {
  const decoded = decodeBase64(value);
  if (!decoded) return '';
  try { return new TextDecoder().decode(Uint8Array.from(decoded, character => character.charCodeAt(0))); }
  catch { return decoded; }
}

function normalizeNodeIdentity(nodeUrl) {
  const value = String(nodeUrl || '').trim();
  if (/^vmess:\/\//i.test(value)) {
    try {
      const payload = JSON.parse(decodeBase64(value.slice(8)));
      delete payload.ps;
      return `vmess://${btoa(JSON.stringify(payload)).replace(/=+$/g, '')}`;
    } catch { return value.split('#', 1)[0]; }
  }
  return value.split('#', 1)[0];
}

export async function nodeFingerprint(nodeUrl) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeNodeIdentity(nodeUrl)));
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

export async function reconcileNodeSelection(nodeSelection, currentNodes, { preserveUnmatchedIdentities = true } = {}) {
  if (nodeSelection?.mode !== 'include' || !Array.isArray(nodeSelection.fingerprints)) {
    return { nodeSelection, matchedFingerprints: null, matchedCount: null, changed: false };
  }
  const allowed = new Set(nodeSelection.fingerprints.filter(value => /^[0-9a-f]{64}$/i.test(String(value))).map(value => String(value).toLowerCase()));
  const identities = new Map();
  for (const identity of Array.isArray(nodeSelection.identities) ? nodeSelection.identities : []) {
    const key = nodeSelectionIdentityKey(identity);
    if (key) identities.set(key, { protocol: String(identity.protocol).trim().toLowerCase(), name: normalizeIdentityName(identity.name) });
  }
  const described = await Promise.all((Array.isArray(currentNodes) ? currentNodes : []).map(async node => {
    const url = typeof node === 'string' ? node : node?.url;
    const identity = nodeSelectionIdentity(url);
    return { fingerprint: await nodeFingerprint(url), identity, identityKey: nodeSelectionIdentityKey(identity) };
  }));
  const identityCounts = new Map();
  described.forEach(item => item.identityKey && identityCounts.set(item.identityKey, (identityCounts.get(item.identityKey) || 0) + 1));
  const matchedFingerprints = new Set();
  const matchedIdentityKeys = new Set();
  for (const descriptor of described) {
    const exact = allowed.has(descriptor.fingerprint);
    const uniqueIdentity = descriptor.identityKey && identities.has(descriptor.identityKey) && identityCounts.get(descriptor.identityKey) === 1;
    if (!exact && !uniqueIdentity) continue;
    matchedFingerprints.add(descriptor.fingerprint);
    if (descriptor.identityKey && identityCounts.get(descriptor.identityKey) === 1) {
      identities.set(descriptor.identityKey, descriptor.identity);
      matchedIdentityKeys.add(descriptor.identityKey);
    }
  }
  const nextSelection = {
    mode: 'include',
    fingerprints: Array.from(matchedFingerprints),
    identities: Array.from(identities.entries())
      .filter(([key]) => matchedIdentityKeys.has(key) || preserveUnmatchedIdentities)
      .map(([, identity]) => identity)
  };
  return {
    nodeSelection: nextSelection,
    matchedFingerprints,
    matchedCount: matchedFingerprints.size,
    changed: JSON.stringify(nodeSelection) !== JSON.stringify(nextSelection)
  };
}

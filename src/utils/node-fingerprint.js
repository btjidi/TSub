function decodeBase64(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  try { return atob(padded); } catch { return ''; }
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

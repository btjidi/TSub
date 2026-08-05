function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function deriveKey(secret) {
  if (!secret || String(secret).length < 16) throw new Error('DEPLOYMENT_SECRET_KEY 必须至少 16 个字符');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptDeploymentConfig(config, env) {
  const key = await deriveKey(env?.DEPLOYMENT_SECRET_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(config));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { algorithm: 'A256GCM', iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

export async function decryptDeploymentConfig(envelope, env) {
  const key = await deriveKey(env?.DEPLOYMENT_SECRET_KEY);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(decrypted));
}

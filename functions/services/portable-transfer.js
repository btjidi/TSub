import { StorageFactory } from '../storage-adapter.js';
import { decryptDeploymentConfig, encryptDeploymentConfig } from '../modules/deployment-crypto.js';
import { buildBackupPayload, restoreBackupPayload } from '../modules/webdav-backup-handler.js';

const ITERATIONS = 600_000;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

function bytesToBase64(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value) { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
function randomBytes(length) { return crypto.getRandomValues(new Uint8Array(length)); }

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function digest(value) {
  const data = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validatePassphrase(value) {
  const passphrase = String(value || '');
  if (passphrase.length < 12 || passphrase.length > 256) throw Object.assign(new Error('迁移包密码长度必须为 12–256 个字符'), { status: 400 });
  return passphrase;
}

export async function exportPortablePackage(env, passphraseValue) {
  const passphrase = validatePassphrase(passphraseValue);
  const storageType = await StorageFactory.getStorageType(env);
  const storage = StorageFactory.createAdapter(env, storageType);
  const backup = await buildBackupPayload(env, { scope: 'dataAndSettings', trigger: 'portable-export' });
  const portableDeployments = [];
  for (const deployment of backup.data.deployments) {
    const copy = structuredClone(deployment);
    if (copy.encryptedConfig) {
      copy.portableConfig = await decryptDeploymentConfig(copy.encryptedConfig, env);
      delete copy.encryptedConfig;
    }
    portableDeployments.push(copy);
  }
  backup.data.deployments = portableDeployments;
  backup.data.settings = await storage.get('worker_settings_v1') || {};
  const plaintext = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), sourceStorage: storageType, backup });
  if (new TextEncoder().encode(plaintext).byteLength > MAX_PACKAGE_BYTES) throw Object.assign(new Error('迁移数据超过 20 MB 限制'), { status: 413 });
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return {
    format: 'tsub-portable-v1', kdf: { name: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: bytesToBase64(salt) },
    cipher: { name: 'AES-256-GCM', iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) },
    digest: await digest(plaintext)
  };
}

export async function importPortablePackage(env, envelope, passphraseValue) {
  const passphrase = validatePassphrase(passphraseValue);
  if (envelope?.format !== 'tsub-portable-v1' || envelope?.kdf?.iterations !== ITERATIONS) throw Object.assign(new Error('不支持的迁移包格式'), { status: 400 });
  let plaintext;
  try {
    const salt = base64ToBytes(envelope.kdf.salt); const iv = base64ToBytes(envelope.cipher.iv);
    const key = await deriveKey(passphrase, salt);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBytes(envelope.cipher.ciphertext));
    plaintext = new TextDecoder().decode(decrypted);
  } catch { throw Object.assign(new Error('迁移包密码错误或文件已被篡改'), { status: 400 }); }
  if (await digest(plaintext) !== envelope.digest) throw Object.assign(new Error('迁移包摘要校验失败'), { status: 400 });
  const portable = JSON.parse(plaintext);
  const backup = portable.backup;
  for (const deployment of backup.data.deployments || []) {
    if (deployment.portableConfig) {
      deployment.encryptedConfig = await encryptDeploymentConfig(deployment.portableConfig, env);
      delete deployment.portableConfig;
    }
    deployment.agentReconnectRequired = true;
  }
  const result = await restoreBackupPayload(env, backup, { scope: 'dataAndSettings', allowPortableSecrets: true });
  return { ...result, sourceStorage: portable.sourceStorage, importedAt: new Date().toISOString() };
}

export const portableTransferConstants = { ITERATIONS, MAX_PACKAGE_BYTES };

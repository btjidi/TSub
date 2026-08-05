const SETTINGS_KEY = 'worker_settings_v1';
export const SETTINGS_SECRETS_KEY = 'tsub_settings_secrets_v1';
const ENVELOPE_VERSION = 1;
const ALGORITHM = 'A256GCM';
const SECRET_PATHS = [
    'webdavBackup.password',
    'telegram_push_config.bot_token',
    'telegram_push_config.webhook_secret',
    'cloudflareUsage.apiToken',
    'cronSecret',
    'BotToken'
];

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function getPath(target, path) {
    return path.split('.').reduce((value, key) => value?.[key], target);
}

function setPath(target, path, value) {
    const keys = path.split('.');
    let current = target;
    for (let index = 0; index < keys.length - 1; index += 1) {
        const key = keys[index];
        if (!current[key] || typeof current[key] !== 'object') current[key] = {};
        current = current[key];
    }
    current[keys.at(-1)] = value;
}

function deletePath(target, path) {
    const keys = path.split('.');
    let current = target;
    for (let index = 0; index < keys.length - 1; index += 1) {
        current = current?.[keys[index]];
        if (!current || typeof current !== 'object') return;
    }
    if (current) delete current[keys.at(-1)];
}

function tokenId(item, index) {
    const existing = String(item?.id || '').trim();
    if (existing) return existing;
    const name = String(item?.name || `token-${index + 1}`).trim() || `token-${index + 1}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'token';
    return `external-${slug}-${index + 1}`;
}

function normalizeExternalTokens(tokens = []) {
    return Array.isArray(tokens) ? tokens.map((item, index) => ({
        ...item,
        id: tokenId(item, index),
        name: String(item?.name || `token-${index + 1}`).trim() || `token-${index + 1}`
    })) : [];
}

function extractSettingsSecrets(settings = {}) {
    const publicSettings = clone(settings) || {};
    const secrets = { fields: {}, externalApiTokens: {} };
    let hasSecrets = false;

    for (const path of SECRET_PATHS) {
        const value = getPath(publicSettings, path);
        if (typeof value === 'string' && value !== '') {
            secrets.fields[path] = value;
            hasSecrets = true;
        }
        if (value !== undefined) setPath(publicSettings, path, '');
    }

    if (publicSettings.externalApi && typeof publicSettings.externalApi === 'object') {
        publicSettings.externalApi.tokens = normalizeExternalTokens(publicSettings.externalApi.tokens).map(item => {
            const token = typeof item.token === 'string' ? item.token : '';
            if (token) {
                secrets.externalApiTokens[item.id] = token;
                hasSecrets = true;
            }
            const { token: _token, ...descriptor } = item;
            return { ...descriptor, token: '', configured: Boolean(token || item.configured) };
        });
    }

    return { publicSettings, secrets, hasSecrets };
}

function mergeSettingsSecrets(publicSettings = {}, secrets = {}) {
    const settings = clone(publicSettings) || {};
    for (const path of SECRET_PATHS) {
        const value = secrets?.fields?.[path];
        if (typeof value === 'string') setPath(settings, path, value);
    }

    if (settings.externalApi && typeof settings.externalApi === 'object') {
        settings.externalApi.tokens = normalizeExternalTokens(settings.externalApi.tokens).map(item => ({
            ...item,
            token: secrets?.externalApiTokens?.[item.id] || '',
            configured: Boolean(secrets?.externalApiTokens?.[item.id])
        }));
    }
    return settings;
}

async function deriveKey(secret) {
    if (!secret || String(secret).length < 16) {
        throw new Error('SETTINGS_SECRET_KEY 或 DEPLOYMENT_SECRET_KEY 必须至少 16 个字符');
    }
    const material = new TextEncoder().encode(`TSub/settings/v1\0${String(secret)}`);
    const digest = await crypto.subtle.digest('SHA-256', material);
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function candidateSecrets(env = {}) {
    return [...new Set([env.SETTINGS_SECRET_KEY, env.DEPLOYMENT_SECRET_KEY]
        .map(value => String(value || ''))
        .filter(value => value.length >= 16))];
}

async function encryptSecrets(secrets, env) {
    const candidates = candidateSecrets(env);
    if (!candidates.length) await deriveKey('');
    const key = await deriveKey(candidates[0]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
    const additionalData = new TextEncoder().encode('tsub_settings_secrets_v1');
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext);
    return {
        version: ENVELOPE_VERSION,
        algorithm: ALGORITHM,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        updatedAt: new Date().toISOString()
    };
}

async function decryptSecrets(envelope, env) {
    if (!envelope) return { secrets: {}, usedPrimaryKey: true };
    if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
        throw new Error('不支持的设置 Secret 加密格式');
    }
    const additionalData = new TextEncoder().encode('tsub_settings_secrets_v1');
    const candidates = candidateSecrets(env);
    for (let index = 0; index < candidates.length; index += 1) {
        try {
            const key = await deriveKey(candidates[index]);
            const plaintext = await crypto.subtle.decrypt({
                name: 'AES-GCM',
                iv: base64ToBytes(envelope.iv),
                additionalData
            }, key, base64ToBytes(envelope.ciphertext));
            return { secrets: JSON.parse(new TextDecoder().decode(plaintext)), usedPrimaryKey: index === 0 };
        } catch {
            // Try the deployment-key compatibility fallback.
        }
    }
    throw new Error('无法解密设置 Secret，请检查 SETTINGS_SECRET_KEY 或 DEPLOYMENT_SECRET_KEY');
}

async function readSecureSettings(base, env) {
    const publicSettings = await base.get(SETTINGS_KEY);
    if (!publicSettings || typeof publicSettings !== 'object') return publicSettings;

    const envelope = await base.get(SETTINGS_SECRETS_KEY);
    const decrypted = envelope ? await decryptSecrets(envelope, env) : { secrets: {}, usedPrimaryKey: true };
    const storedSecrets = decrypted.secrets;
    const legacy = extractSettingsSecrets(publicSettings);
    const mergedSecrets = {
        fields: { ...(storedSecrets.fields || {}), ...(legacy.secrets.fields || {}) },
        externalApiTokens: { ...(storedSecrets.externalApiTokens || {}), ...(legacy.secrets.externalApiTokens || {}) }
    };

    if ((legacy.hasSecrets || (!decrypted.usedPrimaryKey && env?.SETTINGS_SECRET_KEY)) && candidateSecrets(env).length) {
        await base.put(SETTINGS_SECRETS_KEY, await encryptSecrets(mergedSecrets, env));
        await base.put(SETTINGS_KEY, legacy.publicSettings);
    }

    return mergeSettingsSecrets(legacy.publicSettings, mergedSecrets);
}

async function writeSecureSettings(base, env, settings) {
    const extracted = extractSettingsSecrets(settings);
    if (extracted.hasSecrets) {
        await base.put(SETTINGS_SECRETS_KEY, await encryptSecrets(extracted.secrets, env));
    } else {
        await base.delete(SETTINGS_SECRETS_KEY);
    }
    return base.put(SETTINGS_KEY, extracted.publicSettings);
}

export function redactSettingsForClient(settings = {}) {
    const redacted = extractSettingsSecrets(settings).publicSettings;
    const secretStatus = {};
    for (const path of SECRET_PATHS) secretStatus[path] = Boolean(getPath(settings, path));
    secretStatus.externalApiTokens = Object.fromEntries(
        normalizeExternalTokens(settings.externalApi?.tokens).map(item => [item.id, Boolean(item.token || item.configured)])
    );
    return { ...redacted, secretStatus };
}

export function mergeSettingsUpdate(oldSettings = {}, incomingSettings = {}) {
    const incoming = clone(incomingSettings) || {};
    const actions = incoming.secretActions || {};
    delete incoming.secretActions;
    delete incoming.secretStatus;
    const merged = { ...clone(oldSettings), ...incoming };

    for (const path of SECRET_PATHS) {
        const next = getPath(incoming, path);
        const previous = getPath(oldSettings, path);
        if ((next === '' || next == null) && previous) setPath(merged, path, previous);
    }

    if (incoming.externalApi && typeof incoming.externalApi === 'object') {
        const previousTokens = new Map(normalizeExternalTokens(oldSettings.externalApi?.tokens).map(item => [item.id, item]));
        merged.externalApi = { ...(oldSettings.externalApi || {}), ...incoming.externalApi };
        merged.externalApi.tokens = normalizeExternalTokens(incoming.externalApi.tokens).map(item => {
            const previous = previousTokens.get(item.id);
            return { ...item, token: item.token || previous?.token || '' };
        });
    }

    const allowedClears = new Set(SECRET_PATHS);
    for (const path of Array.isArray(actions.clearPaths) ? actions.clearPaths : []) {
        if (allowedClears.has(path) && !getPath(incoming, path)) setPath(merged, path, '');
    }
    const clearTokenIds = new Set(Array.isArray(actions.clearExternalTokenIds) ? actions.clearExternalTokenIds : []);
    if (merged.externalApi?.tokens && clearTokenIds.size) {
        const incomingTokens = new Map(normalizeExternalTokens(incoming.externalApi?.tokens).map(item => [item.id, item.token || '']));
        merged.externalApi.tokens = merged.externalApi.tokens.map(item => clearTokenIds.has(item.id) && !incomingTokens.get(item.id) ? { ...item, token: '' } : item);
    }
    return merged;
}

export function wrapSettingsAdapter(base, env) {
    if (!base || base.__secureSettingsAdapter) return base;
    return new Proxy(base, {
        get(target, property, receiver) {
            if (property === '__secureSettingsAdapter') return true;
            if (property === 'get') {
                return async (key, ...args) => key === SETTINGS_KEY
                    ? readSecureSettings(target, env)
                    : target.get(key, ...args);
            }
            if (property === 'put') {
                return async (key, value, ...args) => key === SETTINGS_KEY
                    ? writeSecureSettings(target, env, value)
                    : target.put(key, value, ...args);
            }
            if (property === 'delete') {
                return async (key, ...args) => {
                    if (key === SETTINGS_KEY) await target.delete(SETTINGS_SECRETS_KEY).catch(() => {});
                    return target.delete(key, ...args);
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

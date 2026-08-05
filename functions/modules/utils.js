/**
 * 工具函数模块
 * 包含各种通用的辅助函数
 */

import { normalizeTrafficNodeDisplay } from './traffic-node-settings.js';
import { StorageFactory, StorageInitializationError } from '../storage-adapter.js';

/**
 * 计算数据的简单哈希值，用于检测变更
 * @param {any} data - 要计算哈希的数据
 * @returns {string} - 数据的哈希值
 */
export function calculateDataHash(data) {
    const jsonString = JSON.stringify(data, Object.keys(data).sort());
    let hash = 0;
    for (let i = 0; i < jsonString.length; i++) {
        const char = jsonString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // 转换为32位整数
    }
    return hash.toString();
}

/**
 * 检测数据是否发生变更
 * @param {any} oldData - 旧数据
 * @param {any} newData - 新数据
 * @returns {boolean} - 是否发生变更
 */
export function hasDataChanged(oldData, newData) {
    if (!oldData && !newData) return false;
    if (!oldData || !newData) return true;
    return calculateDataHash(oldData) !== calculateDataHash(newData);
}

/**
 * 获取当前活动持久化存储。
 * @param {Object} env
 * @returns {Object|null}
 */
async function getPersistentStorage(env) {
    try {
        return await StorageFactory.getActiveAdapter(env);
    } catch (error) {
        if (error instanceof StorageInitializationError) throw error;
        return null;
    }
}

/**
 * 读取运行时环境变量。
 * @param {Object} env
 * @param {string} key
 * @returns {string|undefined}
 */
function getRuntimeEnvValue(env, key) {
    const envValue = env?.[key];
    if (envValue !== undefined && envValue !== null && String(envValue).trim() !== '') {
        return String(envValue);
    }

    return undefined;
}

function isStorageUnavailableError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('kv storage is paused')
        || message.includes('storage is paused')
        || message.includes('namespace is paused')
        || message.includes('kv put() limit exceeded')
        || message.includes('put() limit exceeded for the day');
}

async function safeKvGet(storage, key) {
    if (!storage) return null;
    try {
        return await storage.get(key);
    } catch (error) {
        if (isStorageUnavailableError(error)) {
            console.warn(`[Auth Storage] KV get skipped for ${key}: ${error.message}`);
            return null;
        }
        throw error;
    }
}

async function safeKvPut(storage, key, value) {
    if (!storage) return false;
    try {
        await storage.put(key, value);
        return true;
    } catch (error) {
        if (isStorageUnavailableError(error)) {
            console.warn(`[Auth Storage] KV put skipped for ${key}: ${error.message}`);
            return false;
        }
        throw error;
    }
}

/**
 * 条件性写入KV存储，只在数据真正变更时写入
 * @param {Object} env - Cloudflare环境对象
 * @param {string} key - KV键名
 * @param {any} newData - 新数据
 * @param {any} oldData - 旧数据（可选）
 * @returns {Promise<boolean>} - 是否执行了写入操作
 */
export async function conditionalKVPut(env, key, newData, oldData = null) {
    const kv = await getPersistentStorage(env);
    if (!kv) return false;
    // 如果没有提供旧数据，先从KV读取
    if (oldData === null) {
        try {
            oldData = await kv.get(key).then(r => r ? JSON.parse(r) : null);
        } catch (error) {
            // 读取失败时，为安全起见执行写入
            await kv.put(key, JSON.stringify(newData));
            return true;
        }
    }

    // 检测数据是否变更
    if (hasDataChanged(oldData, newData)) {
        await kv.put(key, JSON.stringify(newData));
        return true;
    } else {
        return false;
    }
}

/**
 * 获取或生成 Cookie 加密密钥
 * 优先顺序：KV → 环境变量 COOKIE_SECRET → 随机生成（无 KV 时仅内存有效）
 * @param {Object} env - 运行时环境对象
 * @returns {Promise<string>} 密钥
 */
export async function getCookieSecret(env) {
    const kv = await getPersistentStorage(env);
    const runtimeCookieSecret = getRuntimeEnvValue(env, 'COOKIE_SECRET');

    if (kv) {
        // 1. 尝试从 KV 读取
        const kvSecret = await safeKvGet(kv, 'SYSTEM_COOKIE_SECRET');
        if (kvSecret) return kvSecret;

        // 2. 有环境变量则优先回退到环境变量，并尽力写回 KV
        if (runtimeCookieSecret) {
            await safeKvPut(kv, 'SYSTEM_COOKIE_SECRET', runtimeCookieSecret);
            return runtimeCookieSecret;
        }

        // 3. 生成新密钥并尽力持久化到 KV；若 KV 暂不可用则退化为本次运行临时密钥
        const newSecret = crypto.randomUUID();
        await safeKvPut(kv, 'SYSTEM_COOKIE_SECRET', newSecret);
        return newSecret;
    }

    // 无 KV：直接使用环境变量，无则生成临时密钥（重启后失效）
    if (runtimeCookieSecret) return runtimeCookieSecret;
    return crypto.randomUUID();
}

/**
 * 获取管理员密码
 * 优先顺序：环境变量 ADMIN_PASSWORD → KV → 默认值 'admin'
 * @param {Object} env - 运行时环境对象
 * @returns {Promise<string>} 密码
 */
const ADMIN_CREDENTIALS_KEY = 'SYSTEM_ADMIN_CREDENTIALS_V1';
const LEGACY_ADMIN_PASSWORD_KEY = 'SYSTEM_ADMIN_PASSWORD';
const PBKDF2_ITERATIONS = 600000;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

export function normalizeAdminUsername(value) {
    return String(value ?? '').trim().toLowerCase();
}

export function validateAdminUsername(value) {
    return USERNAME_PATTERN.test(normalizeAdminUsername(value));
}

export function validateAdminPassword(value) {
    return typeof value === 'string'
        && value.length >= 8
        && value.length <= 128
        && value === value.trim();
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

async function derivePasswordHash(password, salt, iterations = PBKDF2_ITERATIONS) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
    return new Uint8Array(bits);
}

async function buildPasswordVerifier(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePasswordHash(password, salt);
    return { algorithm: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt), hash: bytesToBase64(hash) };
}

async function verifyPasswordHash(password, verifier) {
    if (!verifier || verifier.algorithm !== 'PBKDF2-SHA256') return false;
    const iterations = Number(verifier.iterations);
    if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 1000000) return false;
    try {
        const expected = base64ToBytes(verifier.hash);
        const actual = await derivePasswordHash(password, base64ToBytes(verifier.salt), iterations);
        if (actual.length !== expected.length) return false;
        let difference = 0;
        for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
        return difference === 0;
    } catch {
        return false;
    }
}

async function readCredentialRecord(env) {
    const raw = await safeKvGet(await getPersistentStorage(env), ADMIN_CREDENTIALS_KEY);
    if (!raw) return null;
    try {
        const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return record?.schemaVersion === 1 ? record : null;
    } catch {
        return null;
    }
}

async function resolveAdminCredentials(env) {
    const kv = await getPersistentStorage(env);
    const record = await readCredentialRecord(env);
    const runtimeUsername = normalizeAdminUsername(getRuntimeEnvValue(env, 'ADMIN_USERNAME') || 'admin');
    const runtimePassword = getRuntimeEnvValue(env, 'ADMIN_PASSWORD');
    const legacyPassword = record ? null : await safeKvGet(kv, LEGACY_ADMIN_PASSWORD_KEY);
    const authVersion = Math.max(1, Number(record?.authVersion) || 1);

    if (record?.mode === 'override' && validateAdminUsername(record.username) && record.passwordVerifier) {
        return {
            username: record.username,
            passwordVerifier: record.passwordVerifier,
            passwordPlaintext: null,
            authVersion,
            usernameSource: kv?.type || 'storage',
            passwordSource: kv?.type || 'storage'
        };
    }

    return {
        username: validateAdminUsername(runtimeUsername) ? runtimeUsername : 'admin',
        passwordVerifier: null,
        passwordPlaintext: String(legacyPassword || runtimePassword || 'admin'),
        authVersion,
        usernameSource: getRuntimeEnvValue(env, 'ADMIN_USERNAME') ? 'env' : 'default',
        passwordSource: legacyPassword ? 'legacy-kv' : (runtimePassword ? 'env' : 'default')
    };
}

export async function getAdminCredentialMetadata(env) {
    const resolved = await resolveAdminCredentials(env);
    const storage = await getPersistentStorage(env);
    return {
        username: resolved.username,
        authVersion: resolved.authVersion,
        usernameSource: resolved.usernameSource,
        passwordSource: resolved.passwordSource,
        canPersist: !!storage
    };
}

export async function verifyAdminCredentials(env, username, password) {
    const resolved = await resolveAdminCredentials(env);
    if (normalizeAdminUsername(username) !== resolved.username || typeof password !== 'string') return false;
    if (resolved.passwordVerifier) {
        const matched = await verifyPasswordHash(password, resolved.passwordVerifier);
        if (matched && Number(resolved.passwordVerifier.iterations) < PBKDF2_ITERATIONS) {
            const record = await readCredentialRecord(env);
            if (record?.mode === 'override') {
                await safeKvPut(await getPersistentStorage(env), ADMIN_CREDENTIALS_KEY, JSON.stringify({
                    ...record,
                    passwordVerifier: await buildPasswordVerifier(password),
                    updatedAt: new Date().toISOString()
                }));
            }
        }
        return matched;
    }
    return password === resolved.passwordPlaintext;
}

export async function verifyCurrentAdminPassword(env, password) {
    const resolved = await resolveAdminCredentials(env);
    return verifyAdminCredentials(env, resolved.username, password);
}

export async function saveAdminCredentials(env, currentPassword, username, newPassword = '') {
    const kv = await getPersistentStorage(env);
    if (!kv) throw new Error('当前部署没有可用持久化存储，请通过环境变量修改管理员凭据');
    const resolved = await resolveAdminCredentials(env);
    if (!await verifyCurrentAdminPassword(env, currentPassword)) throw new Error('当前密码错误');
    const normalizedUsername = normalizeAdminUsername(username || resolved.username);
    if (!validateAdminUsername(normalizedUsername)) throw new Error('账号必须为 3-32 位小写字母、数字、点、下划线或连字符');
    const password = newPassword || currentPassword;
    if (!validateAdminPassword(password)) throw new Error('密码必须为 8-128 位且不能包含首尾空格');
    const record = {
        schemaVersion: 1,
        mode: 'override',
        username: normalizedUsername,
        passwordVerifier: await buildPasswordVerifier(password),
        authVersion: resolved.authVersion + 1,
        updatedAt: new Date().toISOString()
    };
    await kv.put(ADMIN_CREDENTIALS_KEY, JSON.stringify(record));
    return getAdminCredentialMetadata(env);
}

export async function resetAdminCredentials(env, currentPassword) {
    const kv = await getPersistentStorage(env);
    if (!kv) throw new Error('当前部署没有可用持久化存储，凭据已经由环境变量管理');
    const resolved = await resolveAdminCredentials(env);
    if (!await verifyCurrentAdminPassword(env, currentPassword)) throw new Error('当前密码错误');
    await kv.put(ADMIN_CREDENTIALS_KEY, JSON.stringify({
        schemaVersion: 1,
        mode: 'environment',
        authVersion: resolved.authVersion + 1,
        updatedAt: new Date().toISOString()
    }));
    return getAdminCredentialMetadata(env);
}

export async function getAdminPassword(env) {
    const resolved = await resolveAdminCredentials(env);
    return resolved.passwordPlaintext || '';
}

/**
 * 获取认证相关调试信息（不返回任何敏感值）
 * @param {Object} env
 * @returns {Promise<Object>}
 */
export async function getAuthDebugInfo(env) {
    const runtimeAdminPassword = getRuntimeEnvValue(env, 'ADMIN_PASSWORD');
    const runtimeCookieSecret = getRuntimeEnvValue(env, 'COOKIE_SECRET');
    const kv = await getPersistentStorage(env);

    let hasStoredAdminPassword = false;
    let hasStoredCookieSecret = false;

    if (kv) {
        hasStoredAdminPassword = !!(await safeKvGet(kv, ADMIN_CREDENTIALS_KEY)) || !!(await safeKvGet(kv, LEGACY_ADMIN_PASSWORD_KEY));
        hasStoredCookieSecret = !!(await safeKvGet(kv, 'SYSTEM_COOKIE_SECRET'));
    }

    const credentialMetadata = await getAdminCredentialMetadata(env);
    const adminPasswordSource = credentialMetadata.passwordSource;

    let cookieSecretSource = 'generated';
    if (runtimeCookieSecret) {
        cookieSecretSource = 'env';
    } else if (hasStoredCookieSecret) {
        cookieSecretSource = kv?.type || 'storage';
    }

    return {
        hasKv: !!StorageFactory.resolveKV(env),
        hasD1: !!env?.TSUB_DB,
        adminPassword: {
            source: adminPasswordSource,
            hasRuntime: !!runtimeAdminPassword,
            hasKvValue: hasStoredAdminPassword,
            isDefaultFallback: adminPasswordSource === 'default'
        },
        adminUsername: {
            source: credentialMetadata.usernameSource,
            value: credentialMetadata.username
        },
        cookieSecret: {
            source: cookieSecretSource,
            hasRuntime: !!runtimeCookieSecret,
            hasKvValue: hasStoredCookieSecret,
            mayRegenerateWithoutKv: !kv && !runtimeCookieSecret
        }
    };
}

/**
 * 检查是否正在使用默认密码
 * @param {Object} env
 * @returns {Promise<boolean>}
 */
export async function isUsingDefaultPassword(env) {
    return (await getAdminCredentialMetadata(env)).passwordSource === 'default';
}

/**
 * 设置管理员密码
 * 有 KV 时持久化到 KV；无 KV 时抛出提示
 * @param {Object} env - 运行时环境对象
 * @param {string} newPassword - 新密码
 */
export async function setAdminPassword(env, newPassword) {
    const resolved = await resolveAdminCredentials(env);
    if (!resolved.passwordPlaintext) throw new Error('请使用管理员凭据接口修改密码');
    return saveAdminCredentials(env, resolved.passwordPlaintext, resolved.username, newPassword);
}

export { formatBytes } from '../../src/shared/utils.js';

/**
 * 检测字符串是否为有效的Base64格式
 * @param {string} str - 要检测的字符串
 * @returns {boolean} - 是否为有效Base64
 */
export function isValidBase64(str) {
    const cleanStr = str.replace(/\s/g, '');
    if (!cleanStr) return false;

    let normalized = cleanStr.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4;
    if (padding) {
        normalized += '='.repeat(4 - padding);
    }

    const base64Regex = /^[A-Za-z0-9+\/=]+$/;
    return base64Regex.test(normalized) && normalized.length > 20;
}

/**
 * 修复Clash配置中的WireGuard问题
 * @param {string} content - Clash配置内容
 * @returns {string} - 修复后的配置内容
 */
export function clashFix(content) {
    if (content.includes('wireguard') && !content.includes('remote-dns-resolve')) {
        let lines;
        if (content.includes('\r\n')) {
            lines = content.split('\r\n');
        } else {
            lines = content.split('\n');
        }

        let result = "";
        for (let line of lines) {
            if (line.includes('type: wireguard')) {
                const 备改内容 = `, mtu: 1280, udp: true`;
                const 正确内容 = `, mtu: 1280, remote-dns-resolve: true, udp: true`;
                result += line.replace(new RegExp(备改内容, 'g'), 正确内容) + '\n';
            } else {
                result += line + '\n';
            }
        }
        return result;
    }
    return content;
}

import { SYSTEM_CONSTANTS } from './config.js';

/**
 * 根据客户端类型确定合适的用户代理
 * @param {string} originalUserAgent - 原始用户代理字符串
 * @returns {string} - 处理后的用户代理字符串
 */
export function getProcessedUserAgent(originalUserAgent, url = '') {
    if (!originalUserAgent) return originalUserAgent;

    const rawUrl = typeof url === 'string' ? url : '';
    try {
        const parsedUrl = new URL(rawUrl);
        const params = parsedUrl.searchParams;
        if (params.has('clash') || params.get('target')?.toLowerCase() === 'clash') {
            return 'clash-verge/v2.4.3';
        }
    } catch {
        if (/[?&](?:clash(?:=|&|$)|target=clash(?:&|$))/i.test(rawUrl)) {
            return 'clash-verge/v2.4.3';
        }
    }

    // CF-Workers-SUB的精华策略：
    // 默认使用 v2rayN UA 获取订阅，绕过多数机场过滤同时保证获取完整节点。
    // 个别 Clash 专用链接（如 ?clash=2）会严格校验 UA，需要保留 Clash UA。
    return 'v2rayN/7.23';
}
/**
 * 名称前缀辅助函数
 * @param {string} link - 节点链接
 * @param {string} prefix - 前缀文本
 * @returns {string} 添加前缀后的链接
 */
export function prependNodeName(link, prefix) {
    if (!prefix) return link;
    const appendToFragment = (baseLink, namePrefix) => {
        const hashIndex = baseLink.lastIndexOf('#');
        const originalName = hashIndex !== -1 ? decodeURIComponent(baseLink.substring(hashIndex + 1)) : '';
        const base = hashIndex !== -1 ? baseLink.substring(0, hashIndex) : baseLink;
        if (originalName.startsWith(namePrefix)) {
            return baseLink;
        }
        const newName = originalName ? `${namePrefix} - ${originalName}` : namePrefix;
        return `${base}#${encodeURIComponent(newName)}`;
    };
    if (link.startsWith('vmess://')) {
        try {
            const base64Part = link.substring('vmess://'.length);
            const binaryString = atob(base64Part);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const jsonString = new TextDecoder('utf-8').decode(bytes);
            const nodeConfig = JSON.parse(jsonString);
            const originalPs = nodeConfig.ps || '';
            if (!originalPs.startsWith(prefix)) {
                nodeConfig.ps = originalPs ? `${prefix} - ${originalPs}` : prefix;
            }
            const newJsonString = JSON.stringify(nodeConfig);
            const newBase64Part = btoa(unescape(encodeURIComponent(newJsonString)));
            return 'vmess://' + newBase64Part;
        } catch (e) {
            console.error("为 vmess 节点添加名称前缀失败，将回退到通用方法。", e);
            return appendToFragment(link, prefix);
        }
    }
    return appendToFragment(link, prefix);
}

/**
 * 创建带超时的请求
 * @param {RequestInfo} input - 请求输入
 * @param {RequestInit} init - 请求初始化选项
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<Response>} 响应
 */
export function createTimeoutFetch(input, init = {}, timeout = 10000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // 分离 cf 选项：cf 是 Cloudflare Workers fetch 特有的选项，
    // 不属于标准 RequestInit，不应传入 Request 构造器。
    // 将其直接传给 fetch() 的第二参数，Cloudflare 环境正常生效，Node.js 环境安全忽略。
    const { cf, ...requestInit } = init;
    const request = new Request(input, {
        ...requestInit,
        signal: controller.signal
    });
    const fetchPromise = cf ? fetch(request, { cf }) : fetch(request);

    return fetchPromise.finally(() => {
        clearTimeout(timeoutId);
    });
}

/**
 * 带重试机制的请求函数
 * @param {RequestInfo} input - 请求输入
 * @param {RequestInit} init - 请求初始化选项
 * @param {Object} options - 选项
 * @param {number} options.maxRetries - 最大重试次数
 * @param {number} options.timeout - 每次请求超时时间
 * @param {number} options.baseDelay - 基础延迟时间
 * @returns {Promise<Response>} 响应
 */
export async function retryFetch(input, init = {}, options = {}) {
    const {
        maxRetries = 3,
        timeout = 10000,
        baseDelay = 1000
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await createTimeoutFetch(input, init, timeout);
        } catch (error) {
            lastError = error;

            // 如果是最后一次尝试，直接抛出错误
            if (attempt === maxRetries) {
                throw error;
            }

            // 计算延迟时间（指数退避）
            const delay = baseDelay * Math.pow(2, attempt);
            console.warn(`[Retry] Request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, error.message);

            // 等待延迟
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}



/**
 * 安全的存储操作包装器
 * @param {Function} operation - 存储操作函数
 * @param {any} fallback - 操作失败时的默认返回值
 * @param {string} context - 操作上下文
 * @returns {Promise<any>} 操作结果
 */
export async function safeStorageOperation(operation, fallback = null, context = '') {
    try {
        return await operation();
    } catch (error) {
        console.error(`[Storage] ${context} failed:`, error);
        return fallback;
    }
}

/**
 * 通用日志函数
 * @param {string} level - 日志级别 (info, warn, error)
 * @param {string} message - 日志消息
 * @param {any} data - 附加数据
 */
export function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        level,
        message,
        data
    };

    switch (level) {
        case 'info':
            console.info(`[${timestamp}] ${message}`, data);
            break;
        case 'warn':
            console.warn(`[${timestamp}] ${message}`, data);
            break;
        case 'error':
            console.error(`[${timestamp}] ${message}`, data);
            break;
        default:
            console.info(`[${timestamp}] ${message}`, data);
    }

    return logEntry;
}

/**
 * 获取回调令牌
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<string>} 回调令牌
 */
export async function getCallbackToken(env) {
    const secret = env.COOKIE_SECRET || 'default-callback-secret';
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode('callback-static-data'));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * 处理配置的向后兼容性，确保新的前缀配置结构存在
 * @param {Object} config - 原始配置对象
 * @returns {Object} - 处理后的配置对象
 */
export function migrateConfigSettings(config) {
    const migratedConfig = { ...config };

    // [Fix] 强制转换为布尔值，防止 KV 中存储了字符串"false"导致判断错误
    const toBoolean = (val) => {
        if (typeof val === 'string') {
            return val.toLowerCase() === 'true';
        }
        return !!val;
    };

    if (migratedConfig.hasOwnProperty('enableAccessLog')) {
        migratedConfig.enableAccessLog = toBoolean(migratedConfig.enableAccessLog);
    }
    if (migratedConfig.hasOwnProperty('enableTrafficNode')) {
        migratedConfig.enableTrafficNode = toBoolean(migratedConfig.enableTrafficNode);
    }
    migratedConfig.directCommitSilentSuccess = migratedConfig.directCommitSilentSuccess !== false;
    migratedConfig.trafficNodeDisplay = normalizeTrafficNodeDisplay(migratedConfig.trafficNodeDisplay);
    // [Migration] 映射旧名到新名（如果新名不存在且旧名存在）
    if (!migratedConfig.hasOwnProperty('builtinSkipCertVerify') && migratedConfig.hasOwnProperty('transformBackendScv')) {
        migratedConfig.builtinSkipCertVerify = toBoolean(migratedConfig.transformBackendScv);
    }
    if (!migratedConfig.hasOwnProperty('builtinEnableUdp') && migratedConfig.hasOwnProperty('transformBackendUdp')) {
        migratedConfig.builtinEnableUdp = toBoolean(migratedConfig.transformBackendUdp);
    }

    if (migratedConfig.hasOwnProperty('builtinSkipCertVerify')) {
        migratedConfig.builtinSkipCertVerify = toBoolean(migratedConfig.builtinSkipCertVerify);
    }
    if (migratedConfig.hasOwnProperty('builtinEnableUdp')) {
        migratedConfig.builtinEnableUdp = toBoolean(migratedConfig.builtinEnableUdp);
    }
    if (migratedConfig.hasOwnProperty('builtinLoonSkipCertVerify')) {
        migratedConfig.builtinLoonSkipCertVerify = toBoolean(migratedConfig.builtinLoonSkipCertVerify);
    }

    return migratedConfig;
}


/**
 * 创建标准JSON响应
 * @param {Object} data - 响应数据
 * @param {number} status - HTTP状态码
 * @param {Object} headers - 额外的HTTP头
 * @returns {Response}
 */
export function createJsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers
        }
    });
}

/**
 * 获取用于外部回调的基础 URL
 * @param {Object} env - Cloudflare环境对象
 * @param {URL} requestUrl - 当前请求 URL
 * @returns {URL} - 规范化后的基础 URL
 */
export function getPublicBaseUrl(env, requestUrl) {
    const configured = (env?.TSUB_CALLBACK_URL || env?.TSUB_PUBLIC_URL || '').trim();
    if (!configured) {
        return new URL(requestUrl.origin);
    }

    const hasProtocol = /^https?:\/\//i.test(configured);
    const normalized = hasProtocol ? configured : `https://${configured}`;
    const baseUrl = new URL(normalized);
    baseUrl.pathname = '';
    baseUrl.search = '';
    baseUrl.hash = '';
    return baseUrl;
}

/**
 * 自定义 API 错误类
 */
export class APIError extends Error {
    constructor(message, status = 500, code = 'INTERNAL_ERROR', details = null) {
        super(message);
        this.name = 'APIError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

/**
 * 转义HTML特殊字符，防止XSS和Telegram解析错误
 * @param {string} str - 需要转义的字符串
 * @returns {string} - 转义后的字符串
 */
export function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export const JSON_BODY_LIMITS = {
    auth: 16 * 1024,
    small: 128 * 1024,
    normal: 1024 * 1024,
    large: 5 * 1024 * 1024,
    portable: 25 * 1024 * 1024
};

export class RequestBodyTooLargeError extends Error {
    constructor(limitBytes) {
        super(`Request JSON body too large (max ${limitBytes} bytes)`);
        this.name = 'RequestBodyTooLargeError';
        this.status = 413;
        this.code = 'REQUEST_BODY_TOO_LARGE';
    }
}

export async function readJsonWithLimit(request, limitBytes = JSON_BODY_LIMITS.normal) {
    const contentLength = request?.headers?.get?.('Content-Length') || request?.headers?.get?.('content-length');
    if (contentLength) {
        const declaredBytes = Number(contentLength);
        if (Number.isFinite(declaredBytes) && declaredBytes > limitBytes) {
            throw new RequestBodyTooLargeError(limitBytes);
        }
    }

    const text = await request.text();
    if (new TextEncoder().encode(text).length > limitBytes) {
        throw new RequestBodyTooLargeError(limitBytes);
    }
    return text ? JSON.parse(text) : {};
}

/**
 * 创建标准错误响应
 * @param {Error|string} error - 错误对象或错误消息
 * @param {number} status - HTTP状态码 (默认500)
 * @returns {Response}
 */
export function createErrorResponse(error, status = 500) {
    let message = 'Internal Server Error';
    let code = 'INTERNAL_ERROR';
    let details = null;

    if (error instanceof APIError) {
        status = error.status;
        message = error.message;
        code = error.code;
        details = error.details;
    } else if (error instanceof Error && status < 500) {
        message = error.message;
    } else if (typeof error === 'string' && status < 500) {
        message = error;
    }

    const requestId = status >= 500 ? crypto.randomUUID() : undefined;
    if (status >= 500) {
        message = 'Internal Server Error';
        code = 'INTERNAL_ERROR';
        details = null;
    }

    return createJsonResponse({
        success: false,
        error: message,
        code,
        ...(details == null ? {} : { details }),
        ...(requestId ? { requestId } : {})
    }, status);
}

/**
 * 迁移旧版 profile ID，去除 'profile_' 前缀
 * 旧版 generateProfileId() 使用 generateId('profile') 生成带前缀的 ID，
 * 当前版本已修复为不加前缀，但数据库中可能存留旧数据。
 * @param {Array} profiles - 订阅组列表
 * @returns {boolean} 是否发生了迁移
 */
export function migrateProfileIds(profiles) {
    if (!Array.isArray(profiles)) return false;
    let migrated = false;
    for (const p of profiles) {
        if (p.id && p.id.startsWith('profile_')) {
            p.id = p.id.slice('profile_'.length);
            migrated = true;
        }
    }
    return migrated;
}

/**
 * 安全的 UTF-8 到 Base64 编码 (替代已弃用的 unescape/encodeURIComponent 方案)
 */
export function base64EncodeUtf8(str) {
    if (!str) return '';
    try {
        const bytes = new TextEncoder().encode(str);
        const binString = Array.from(bytes, b => String.fromCharCode(b)).join('');
        return btoa(binString);
    } catch (e) {
        console.error('[Utils] base64EncodeUtf8 failed:', e);
        return '';
    }
}

/**
 * 安全的 Base64 到 UTF-8 解码
 */
export function base64DecodeUtf8(base64) {
    if (!base64) return '';
    try {
        const binString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = Uint8Array.from(binString, m => m.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.error('[Utils] base64DecodeUtf8 failed:', e);
        return '';
    }
}

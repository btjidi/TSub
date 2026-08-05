import { StorageFactory } from '../storage-adapter.js';

const memoryEntries = new Map();

function bytesToHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function clientIp(request) {
    return String(request?.headers?.get('CF-Connecting-IP') || 'unknown').trim().toLowerCase();
}

async function hashIdentifier(env, scope, identifier) {
    const salt = String(env?.RATE_LIMIT_SECRET || env?.COOKIE_SECRET || env?.DEPLOYMENT_SECRET_KEY || 'tsub-rate-limit-v1');
    const payload = new TextEncoder().encode(`${salt}\0${scope}\0${identifier}`);
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', payload)));
}

async function getAdapter(env) {
    try {
        return StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
    } catch {
        return null;
    }
}

function normalizeEntry(entry, now, windowMs) {
    if (!entry || Number(entry.windowStartedAt) + windowMs <= now) {
        return { count: 0, windowStartedAt: now, blockedUntil: 0 };
    }
    return {
        count: Math.max(0, Number(entry.count) || 0),
        windowStartedAt: Number(entry.windowStartedAt) || now,
        blockedUntil: Math.max(0, Number(entry.blockedUntil) || 0)
    };
}

async function readEntry(adapter, key) {
    if (adapter) {
        try { return await adapter.get(key); } catch { /* memory fallback */ }
    }
    return memoryEntries.get(key) || null;
}

async function writeEntry(adapter, key, entry) {
    if (adapter) {
        try {
            await adapter.put(key, entry);
            return;
        } catch { /* memory fallback */ }
    }
    memoryEntries.set(key, entry);
}

export async function inspectRateLimit(request, env, options) {
    const now = Date.now();
    const identifier = options.identifier || clientIp(request);
    const digest = await hashIdentifier(env, options.scope, identifier);
    const key = `tsub_rate_limit_v1:${options.scope}:${digest}`;
    const adapter = await getAdapter(env);
    const entry = normalizeEntry(await readEntry(adapter, key), now, options.windowMs);
    const blocked = entry.blockedUntil > now;
    return {
        allowed: !blocked && entry.count < options.limit,
        retryAfter: blocked
            ? Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000))
            : Math.max(1, Math.ceil((entry.windowStartedAt + options.windowMs - now) / 1000)),
        key,
        adapter,
        entry,
        now
    };
}

export async function recordRateLimitFailure(state, options) {
    const entry = normalizeEntry(state.entry, state.now, options.windowMs);
    entry.count += 1;
    if (entry.count >= options.limit) entry.blockedUntil = state.now + (options.blockMs || options.windowMs);
    await writeEntry(state.adapter, state.key, entry);
    return entry;
}

export async function consumeRateLimit(request, env, options) {
    const state = await inspectRateLimit(request, env, options);
    if (!state.allowed) return state;
    await recordRateLimitFailure(state, options);
    return { ...state, allowed: true };
}

export async function clearRateLimit(state) {
    if (!state?.key) return;
    if (state.adapter) {
        try {
            await state.adapter.delete(state.key);
            return;
        } catch { /* memory fallback */ }
    }
    memoryEntries.delete(state.key);
}

export function createRateLimitResponse(retryAfter) {
    return new Response(JSON.stringify({ success: false, error: '请求过于频繁，请稍后重试', code: 'RATE_LIMITED' }), {
        status: 429,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Retry-After': String(Math.max(1, retryAfter || 1))
        }
    });
}

export function getRateLimitClientIp(request) {
    return clientIp(request);
}


/**
 * 数据存储抽象层
 * 支持 KV 和 D1 两种存储方式
 * 根据设置自动选择存储类型
 */

import { wrapSettingsAdapter } from './modules/settings-secrets.js';

// 存储类型常量
export const STORAGE_TYPES = {
    KV: 'kv',
    D1: 'd1',
    SQLITE: 'sqlite',
    POSTGRES: 'postgres'
};

// 数据键映射
const DATA_KEYS = {
    SUBSCRIPTIONS: 'tsub_subscriptions_v1',
    PROFILES: 'tsub_profiles_v1',
    SETTINGS: 'worker_settings_v1',
    PROFILE_DOWNLOAD_COUNT_PREFIX: 'tsub_profile_download_count_'
};

const D1_SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_updated_at ON subscriptions(updated_at);`,
    `CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);`,
    `CREATE INDEX IF NOT EXISTS idx_settings_updated_at ON settings(updated_at);`
    ,`CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT '', config_revision INTEGER NOT NULL DEFAULT 1,
        data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`
    ,`CREATE TABLE IF NOT EXISTS deployment_operations (
        id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME, FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );`
    ,`CREATE TABLE IF NOT EXISTS deployment_events (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(operation_id) REFERENCES deployment_operations(id) ON DELETE CASCADE
    );`
    ,`CREATE TABLE IF NOT EXISTS deployment_snapshots (
        deployment_id TEXT PRIMARY KEY, push_generation TEXT NOT NULL, sequence INTEGER NOT NULL,
        snapshot_hash TEXT NOT NULL, data TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );`
    ,`CREATE TABLE IF NOT EXISTS deployment_commands (
        id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, operation_id TEXT NOT NULL, action TEXT NOT NULL,
        status TEXT NOT NULL, lease_id TEXT, lease_expires_at DATETIME, expires_at DATETIME NOT NULL,
        data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );`
    ,`CREATE TABLE IF NOT EXISTS deployment_agents (
        deployment_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
        revoked_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );`
    ,`CREATE TABLE IF NOT EXISTS deployment_heartbeats (
        deployment_id TEXT PRIMARY KEY, data TEXT NOT NULL, last_seen_at DATETIME NOT NULL,
        FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );`
    ,`CREATE TABLE IF NOT EXISTS controller_transfers (
        id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', expires_at DATETIME NOT NULL, data TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );`
    ,`CREATE TABLE IF NOT EXISTS storage_control (
        id TEXT PRIMARY KEY, active_storage TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle', epoch INTEGER NOT NULL DEFAULT 1,
        data TEXT NOT NULL DEFAULT '{}', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`
    ,`CREATE TABLE IF NOT EXISTS storage_migrations (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, phase TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`
    ,`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);`
    ,`CREATE TABLE IF NOT EXISTS scheduler_leases (
        name TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until DATETIME NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`
    ,`CREATE INDEX IF NOT EXISTS idx_deployments_status_updated ON deployments(status, updated_at);`
    ,`CREATE INDEX IF NOT EXISTS idx_operations_deployment_created ON deployment_operations(deployment_id, created_at);`
    ,`CREATE INDEX IF NOT EXISTS idx_events_operation_created ON deployment_events(operation_id, created_at);`
    ,`CREATE INDEX IF NOT EXISTS idx_commands_claim ON deployment_commands(deployment_id, status, created_at);`
    ,`CREATE INDEX IF NOT EXISTS idx_commands_lease ON deployment_commands(status, lease_expires_at);`
    ,`CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_one_active ON deployment_commands(deployment_id)
        WHERE status IN ('pending', 'claimed', 'running');`
    ,`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_token_hash ON deployment_agents(token_hash);`
    ,`CREATE INDEX IF NOT EXISTS idx_heartbeats_seen ON deployment_heartbeats(last_seen_at);`
    ,`CREATE UNIQUE INDEX IF NOT EXISTS idx_controller_transfers_token ON controller_transfers(token_hash);`
    ,`CREATE INDEX IF NOT EXISTS idx_controller_transfers_expiry ON controller_transfers(status, expires_at);`
];

const initializedSchemas = new WeakSet();
const schemaInitializationPromises = new WeakMap();
const D1_SCHEMA_VERSION = 1;

export class StorageInitializationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'StorageInitializationError';
        this.code = code;
        this.status = 503;
    }
}

export async function ensureD1Schema(d1Db) {
    if (d1Db && typeof d1Db === 'object' && initializedSchemas.has(d1Db)) return;
    if (!d1Db || typeof d1Db !== 'object') throw new StorageInitializationError('D1_BINDING_INVALID', 'D1 binding is invalid');
    if (schemaInitializationPromises.has(d1Db)) return schemaInitializationPromises.get(d1Db);

    const initialization = (async () => {
        let currentVersion = 0;
        try {
            const row = await d1Db.prepare('SELECT MAX(version) AS version FROM schema_migrations').first();
            currentVersion = Number(row?.version || 0);
        } catch {
            currentVersion = 0;
        }
        // CREATE IF NOT EXISTS also repairs partially initialized databases whose
        // schema version row exists but one or more tables or indexes are missing.
        const isIndexStatement = statement => /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement);
        const executeStatements = async statements => {
            if (statements.length === 0) return;
            const prepared = statements.map(statement => d1Db.prepare(statement));
            if (typeof d1Db.batch === 'function') await d1Db.batch(prepared);
            else for (const statement of prepared) await statement.run();
        };

        // SQLite validates index targets while preparing statements, so tables
        // must exist before the index batch is prepared.
        await executeStatements(D1_SCHEMA_STATEMENTS.filter(statement => !isIndexStatement(statement)));
        await executeStatements(D1_SCHEMA_STATEMENTS.filter(isIndexStatement));
        if (currentVersion < D1_SCHEMA_VERSION) {
            await d1Db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, CURRENT_TIMESTAMP)
                ON CONFLICT(version) DO NOTHING`)
                .bind(D1_SCHEMA_VERSION).run();
        }
        initializedSchemas.add(d1Db);
    })();
    schemaInitializationPromises.set(d1Db, initialization);
    try {
        await initialization;
    } catch (error) {
        schemaInitializationPromises.delete(d1Db);
        throw error;
    }
}

/**
 * KV 存储适配器
 */
class KVStorageAdapter {
    constructor(kvNamespace) {
        this.kv = kvNamespace;
        this.type = STORAGE_TYPES.KV;
    }

    async get(key) {
        try {
            const raw = await this.kv.get(key);
            if (raw === null || raw === undefined) return null;
            try {
                return JSON.parse(raw);
            } catch {
                return raw;
            }
        } catch (error) {
            console.error(`[KV] Failed to get key ${key}:`, error);
            return null;
        }
    }

    async put(key, value) {
        try {
            const data = typeof value === 'string' ? value : JSON.stringify(value);
            await this.kv.put(key, data);
            return true;
        } catch (error) {
            console.error(`[KV] Failed to put key ${key}:`, error);
            throw error;
        }
    }

    async delete(key) {
        try {
            await this.kv.delete(key);
            return true;
        } catch (error) {
            console.error(`[KV] Failed to delete key ${key}:`, error);
            throw error;
        }
    }

    async list(prefix) {
        try {
            const result = await this.kv.list({ prefix });
            return result.keys || [];
        } catch (error) {
            console.error(`[KV] Failed to list keys with prefix ${prefix}:`, error);
            return [];
        }
    }

    async getSubscriptionById(id) {
        const all = await this.get(DATA_KEYS.SUBSCRIPTIONS);
        return Array.isArray(all) ? all.find(item => item.id === id) || null : null;
    }

    async getAllSubscriptions() {
        const all = await this.get(DATA_KEYS.SUBSCRIPTIONS);
        return Array.isArray(all) ? all : [];
    }

    async getProfileById(id) {
        const all = await this.get(DATA_KEYS.PROFILES);
        return Array.isArray(all) ? all.find(item => item.id === id || item.customId === id) || null : null;
    }

    async getAllProfiles() {
        const all = await this.get(DATA_KEYS.PROFILES);
        return Array.isArray(all) ? all : [];
    }

    async updateSubscriptionById(id, updater) {
        const all = await this.get(DATA_KEYS.SUBSCRIPTIONS) || [];
        const index = all.findIndex(item => item.id === id);
        if (index === -1) return null;
        const updated = updater({ ...all[index] });
        all[index] = updated;
        await this.put(DATA_KEYS.SUBSCRIPTIONS, all);
        return updated;
    }

    async putSubscription(item) {
        const all = await this.getAllSubscriptions();
        const index = all.findIndex(entry => entry.id === item.id);
        if (index === -1) {
          all.push(item);
        } else {
          all[index] = item;
        }
        await this.put(DATA_KEYS.SUBSCRIPTIONS, all);
        return item;
    }

    async deleteSubscriptionById(id) {
        const all = await this.getAllSubscriptions();
        const filtered = all.filter(item => item.id !== id);
        await this.put(DATA_KEYS.SUBSCRIPTIONS, filtered);
        return filtered.length !== all.length;
    }

    async putProfile(item) {
        const all = await this.getAllProfiles();
        const index = all.findIndex(entry => entry.id === item.id);
        if (index === -1) {
          all.push(item);
        } else {
          all[index] = item;
        }
        await this.put(DATA_KEYS.PROFILES, all);
        return item;
    }

    async deleteProfileById(id) {
        const all = await this.getAllProfiles();
        const filtered = all.filter(item => item.id !== id);
        await this.put(DATA_KEYS.PROFILES, filtered);
        return filtered.length !== all.length;
    }

    async getSubscriptionsByIds(ids = []) {
        const all = await this.get(DATA_KEYS.SUBSCRIPTIONS) || [];
        const idSet = new Set(ids);
        return all.filter(item => idSet.has(item.id));
    }

    async putAllSubscriptions(items) {
        return this.put(DATA_KEYS.SUBSCRIPTIONS, items);
    }

    async putAllProfiles(items) {
        return this.put(DATA_KEYS.PROFILES, items);
    }
}

/**
 * D1 存储适配器
 */
export class D1StorageAdapter {
    constructor(d1Database, type = STORAGE_TYPES.D1) {
        this.db = d1Database;
        this.type = type;
    }

    async get(key, type = 'json') {
        try {
            // 根据 key 确定查询的表和字段
            const { table, queryField, queryValue } = this._parseKey(key);

            let result = await this.db.prepare(
                `SELECT ${table === 'settings' ? 'value as data' : 'data'} FROM ${table} WHERE ${queryField} = ?`
            ).bind(queryValue).first();

            // Early D1 releases stored the main settings row under its logical
            // KV key. Read it until a normal settings save writes the `main` row.
            if (!result && key === DATA_KEYS.SETTINGS) {
                result = await this.db.prepare('SELECT value AS data FROM settings WHERE key = ?')
                    .bind(DATA_KEYS.SETTINGS).first();
            }

            if (!result) return null;

            if (type !== 'json') return result.data;
            try { return JSON.parse(result.data); } catch { return result.data; }
        } catch (error) {
            // 如果是表不存在的错误，说明 D1 还未初始化或未被使用，直接返回 null
            if (error.message && error.message.includes('no such table')) {
                return null;
            }
            console.error(`[D1] Failed to get key ${key}:`, error);
            return null;
        }
    }

    async put(key, value) {
        try {
            const { table, queryField, queryValue } = this._parseKey(key);
            const data = typeof value === 'string' ? value : JSON.stringify(value);

            if (table === 'settings') {
                // settings 表使用 key-value 结构
                await this.db.prepare(`
                    INSERT OR REPLACE INTO ${table} (key, value, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                `).bind(queryValue, data).run();
            } else {
                // subscriptions 和 profiles 表使用 id-data 结构
                await this.db.prepare(`
                    INSERT OR REPLACE INTO ${table} (id, data, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                `).bind(queryValue, data).run();
            }

            return true;
        } catch (error) {
            console.error(`[D1] Failed to put key ${key}:`, error);
            throw error;
        }
    }

    async delete(key) {
        try {
            const { table, queryField, queryValue } = this._parseKey(key);

            await this.db.prepare(
                `DELETE FROM ${table} WHERE ${queryField} = ?`
            ).bind(queryValue).run();

            return true;
        } catch (error) {
            console.error(`[D1] Failed to delete key ${key}:`, error);
            throw error;
        }
    }

    async list(prefix) {
        try {
            // D1 中的 list 操作需要根据前缀查询相应的表
            const tables = [
                { name: 'subscriptions', keyField: 'id' },
                { name: 'profiles', keyField: 'id' },
                { name: 'settings', keyField: 'key' }
            ];
            const keys = [];
            const effectivePrefix = prefix || '';
            const explicitlySubscriptions = effectivePrefix.startsWith(DATA_KEYS.SUBSCRIPTIONS);
            const explicitlyProfiles = effectivePrefix.startsWith(DATA_KEYS.PROFILES);
            const shouldQuerySubscriptions = !effectivePrefix || explicitlySubscriptions;
            const shouldQueryProfiles = !effectivePrefix || explicitlyProfiles;
            const shouldQuerySettings = !effectivePrefix
                || (!explicitlySubscriptions && !explicitlyProfiles)
                || effectivePrefix.startsWith(DATA_KEYS.SETTINGS);

            for (const table of tables) {
                if (table.name === 'subscriptions' && !shouldQuerySubscriptions) continue;
                if (table.name === 'profiles' && !shouldQueryProfiles) continue;
                if (table.name === 'settings' && !shouldQuerySettings) continue;

                let results;
                if (table.name === 'settings' && effectivePrefix) {
                    results = await this.db.prepare(
                        `SELECT ${table.keyField} FROM ${table.name} WHERE ${table.keyField} LIKE ?`
                    ).bind(`${effectivePrefix}%`).all();
                } else {
                    results = await this.db.prepare(
                        `SELECT ${table.keyField} FROM ${table.name}`
                    ).all();
                }

                results.results.forEach(row => {
                    const key = this._buildKey(table.name, row[table.keyField]);
                    if (key.startsWith(effectivePrefix)) {
                        keys.push({ name: key });
                    }
                });
            }

            return keys;
        } catch (error) {
            console.error(`[D1] Failed to list keys with prefix ${prefix}:`, error);
            return [];
        }
    }

    async getSubscriptionById(id) {
        try {
            const result = await this.db.prepare('SELECT data FROM subscriptions WHERE id = ?').bind(id).first();
            if (result) return JSON.parse(result.data);

            const legacyMain = await this.db.prepare('SELECT data FROM subscriptions WHERE id = ?').bind('main').first();
            if (!legacyMain) return null;
            const parsed = JSON.parse(legacyMain.data);
            return Array.isArray(parsed) ? parsed.find(item => item.id === id) || null : null;
        } catch (error) {
            console.error(`[D1] Failed to get subscription ${id}:`, error);
            return null;
        }
    }

    async getAllSubscriptions() {
        try {
            const results = await this.db.prepare('SELECT data FROM subscriptions').all();
            if (!Array.isArray(results?.results)) return [];

            const all = [];
            results.results.forEach(row => {
                const parsed = JSON.parse(row.data);
                if (Array.isArray(parsed)) {
                    all.push(...parsed);
                } else if (parsed) {
                    all.push(parsed);
                }
            });

            const deduped = new Map();
            all.forEach(item => {
                if (item?.id) deduped.set(item.id, item);
            });
            return Array.from(deduped.values()).sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
        } catch (error) {
            console.error('[D1] Failed to get all subscriptions:', error);
            return [];
        }
    }

    async getProfileById(id) {
        try {
            const result = await this.db.prepare('SELECT data FROM profiles WHERE id = ?').bind(id).first();
            if (result) return JSON.parse(result.data);

            const legacyMain = await this.db.prepare('SELECT data FROM profiles WHERE id = ?').bind('main').first();
            const allProfiles = legacyMain ? JSON.parse(legacyMain.data) : await this.get(DATA_KEYS.PROFILES);
            return Array.isArray(allProfiles) ? allProfiles.find(item => item.id === id || item.customId === id) || null : null;
        } catch (error) {
            console.error(`[D1] Failed to get profile ${id}:`, error);
            return null;
        }
    }

    async getAllProfiles() {
        try {
            const results = await this.db.prepare('SELECT data FROM profiles').all();
            if (!Array.isArray(results?.results)) return [];

            const all = [];
            results.results.forEach(row => {
                const parsed = JSON.parse(row.data);
                if (Array.isArray(parsed)) {
                    all.push(...parsed);
                } else if (parsed) {
                    all.push(parsed);
                }
            });

            const deduped = new Map();
            all.forEach(item => {
                if (item?.id) deduped.set(item.id, item);
            });
            return Array.from(deduped.values()).sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
        } catch (error) {
            console.error('[D1] Failed to get all profiles:', error);
            return [];
        }
    }

    async updateSubscriptionById(id, updater) {
        const existing = await this.getSubscriptionById(id);
        if (!existing) return null;
        const updated = updater({ ...existing });
        await this.db.prepare(`
            INSERT OR REPLACE INTO subscriptions (id, data, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `).bind(id, JSON.stringify(updated)).run();
        return updated;
    }

    async putSubscription(item) {
        await this.db.prepare(`
            INSERT OR REPLACE INTO subscriptions (id, data, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `).bind(item.id, JSON.stringify(item)).run();
        return item;
    }

    async deleteSubscriptionById(id) {
        const result = await this.db.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
        return Boolean(result?.success);
    }

    async putProfile(item) {
        await this.db.prepare(`
            INSERT OR REPLACE INTO profiles (id, data, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `).bind(item.id, JSON.stringify(item)).run();
        return item;
    }

    async deleteProfileById(id) {
        const result = await this.db.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run();
        return Boolean(result?.success);
    }

    async getSubscriptionsByIds(ids = []) {
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        try {
            const results = await this.db.prepare(`SELECT data FROM subscriptions WHERE id IN (${placeholders})`).bind(...ids).all();
            const directHits = Array.isArray(results?.results) ? results.results.map(row => JSON.parse(row.data)) : [];
            const foundIds = new Set(directHits.map(item => item?.id).filter(Boolean));
            const missingIds = ids.filter(id => !foundIds.has(id));

            if (missingIds.length === 0) return directHits;

            const legacyMain = await this.db.prepare('SELECT data FROM subscriptions WHERE id = ?').bind('main').first();
            if (!legacyMain) return directHits;

            const parsed = JSON.parse(legacyMain.data);
            if (!Array.isArray(parsed)) return directHits;

            const legacyHits = parsed.filter(item => missingIds.includes(item.id));
            return [...directHits, ...legacyHits];
        } catch (error) {
            console.error('[D1] Failed to get subscriptions by ids:', error);
            return [];
        }
    }

    async putAllSubscriptions(items) {
        if (!Array.isArray(items)) return false;
        // 使用并行 Promise 提高效率
        await Promise.all(items.map(item => this.putSubscription(item)));
        return true;
    }

    async putAllProfiles(items) {
        if (!Array.isArray(items)) return false;
        await Promise.all(items.map(item => this.putProfile(item)));
        return true;
    }

    /**
     * 解析 key，确定对应的表、查询字段和查询值
     */
    _parseKey(key) {
        if (key === DATA_KEYS.SUBSCRIPTIONS) {
            return { table: 'subscriptions', queryField: 'id', queryValue: 'main' };
        } else if (key === DATA_KEYS.PROFILES) {
            return { table: 'profiles', queryField: 'id', queryValue: 'main' };
        } else if (key === DATA_KEYS.SETTINGS) {
            return { table: 'settings', queryField: 'key', queryValue: 'main' };
        } else {
            if (String(key).startsWith(DATA_KEYS.PROFILE_DOWNLOAD_COUNT_PREFIX)) {
                return { table: 'settings', queryField: 'key', queryValue: key };
            }
            if (String(key).startsWith('tmp_external_nodes:')) {
                return { table: 'settings', queryField: 'key', queryValue: key };
            }
            if (String(key).startsWith('tsub_guestbook_v1')) {
                return { table: 'settings', queryField: 'key', queryValue: key };
            }
            if (String(key).startsWith('tsub_')) {
                return { table: 'settings', queryField: 'key', queryValue: key };
            }
            if (SYSTEM_STORAGE_KEYS.includes(String(key))) {
                return { table: 'settings', queryField: 'key', queryValue: key };
            }
            // 处理其他格式的 key，默认作为 settings 表的 key，但记录警告
            console.warn(`[D1 Storage] Unknown key format: ${key}, treating as settings key`);
            return { table: 'settings', queryField: 'key', queryValue: key };
        }
    }

    /**
     * 构建 key
     */
    _buildKey(table, keyValue) {
        if (table === 'subscriptions' && keyValue === 'main') {
            return DATA_KEYS.SUBSCRIPTIONS;
        } else if (table === 'profiles' && keyValue === 'main') {
            return DATA_KEYS.PROFILES;
        } else if (table === 'settings' && keyValue === 'main') {
            return DATA_KEYS.SETTINGS;
        } else {
            return keyValue;
        }
    }
}

/**
 * 无存储降级适配器（无可用持久化存储时，不读写持久数据）
 */
class NoopStorageAdapter {
    async get() { return null; }
    async put() { return true; }
    async delete() { return true; }
    async list() { return []; }
    async getAllSubscriptions() { return []; }
    async getAllProfiles() { return []; }
}


/**
 * 判断一个值是否像 KV namespace（有 get/put/delete 方法）
 */
function isKVNamespace(val) {
    return val && typeof val === 'object' &&
        typeof val.get === 'function' &&
        typeof val.put === 'function' &&
        typeof val.delete === 'function';
}

/**
 * 解析 KV 命名空间。
 * 优先读取 Cloudflare Pages 的 env 绑定，并兼容其他 env 中的 KV 绑定。
 * @param {Object} env
 * @returns {Object|null}
 */
function resolveKV(env) {
    // 1. Cloudflare Pages 方式：env.TSUB_KV
    if (env && isKVNamespace(env.TSUB_KV)) return env.TSUB_KV;

    // 2. 自动探测 env 中其他 KV 绑定（仅允许变量名包含 KV，避免误识别）
    if (env) {
        for (const key of Object.keys(env)) {
            if (!String(key).toUpperCase().includes('KV')) continue;
            if (isKVNamespace(env[key])) {
                console.log(`[Storage] Auto-detected KV in env: ${key}`);
                return env[key];
            }
        }
    }

    return null;
}

const STORAGE_CONTROL_ID = 'main';
const SYSTEM_STORAGE_KEYS = [
    'SYSTEM_COOKIE_SECRET',
    'SYSTEM_ADMIN_CREDENTIALS_V1',
    'SYSTEM_ADMIN_PASSWORD',
    'cron_last_execution'
];

function parseStoredJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
}

function storageMarker(settings) {
    return settings?.storageType === STORAGE_TYPES.KV || settings?.storageType === STORAGE_TYPES.D1
        ? settings.storageType
        : '';
}

async function inspectKvInitializationState(kv) {
    const keys = [
        DATA_KEYS.SETTINGS,
        DATA_KEYS.SUBSCRIPTIONS,
        DATA_KEYS.PROFILES,
        'tsub_deployments_v2',
        'tsub_deployment_operations_v2',
        ...SYSTEM_STORAGE_KEYS
    ];
    const values = await Promise.all(keys.map(key => kv.get(key)));
    const settings = parseStoredJson(values[0]);
    const populated = values.some((value, index) => {
        if (value === null || value === undefined) return false;
        const parsed = parseStoredJson(value);
        if (index === 1 || index === 2 || index === 3 || index === 4) return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
        return true;
    });
    return { populated, marker: storageMarker(settings) };
}

async function inspectD1InitializationState(db) {
    const counts = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM profiles) AS profiles,
        (SELECT COUNT(*) FROM deployments) AS deployments,
        (SELECT COUNT(*) FROM deployment_operations) AS operations,
        (SELECT COUNT(*) FROM settings) AS settings`).first();
    const adapter = new D1StorageAdapter(db);
    const settings = await adapter.get(DATA_KEYS.SETTINGS);
    const populated = ['subscriptions', 'profiles', 'deployments', 'operations', 'settings']
        .some(key => Number(counts?.[key] || 0) > 0);
    return { populated, marker: storageMarker(settings) };
}

function configuredInitialStorage(env) {
    const value = String(env?.TSUB_INITIAL_STORAGE || '').trim().toLowerCase();
    if (!value) return '';
    if (value !== STORAGE_TYPES.KV && value !== STORAGE_TYPES.D1) {
        throw new StorageInitializationError('INITIAL_STORAGE_INVALID', 'TSUB_INITIAL_STORAGE must be kv or d1');
    }
    return value;
}

export async function initializeCloudflareStorage(env = {}) {
    if (env.TSUB_PLATFORM === 'server') return { activeStorage: env.TSUB_STORAGE_TYPE || STORAGE_TYPES.SQLITE, initialized: false };
    const kv = resolveKV(env);
    const db = env.TSUB_DB;
    if (!db) return { activeStorage: kv ? STORAGE_TYPES.KV : STORAGE_TYPES.KV, initialized: false };

    try {
        await ensureD1Schema(db);
        const existing = await db.prepare('SELECT active_storage, state, epoch FROM storage_control WHERE id = ?')
            .bind(STORAGE_CONTROL_ID).first();
        if (existing?.active_storage === STORAGE_TYPES.KV || existing?.active_storage === STORAGE_TYPES.D1) {
            return { activeStorage: existing.active_storage, initialized: false };
        }

        let selected = STORAGE_TYPES.D1;
        let reason = 'd1_only';
        if (kv) {
            const [kvState, d1State] = await Promise.all([
                inspectKvInitializationState(kv),
                inspectD1InitializationState(db)
            ]);
            if (kvState.populated && !d1State.populated) {
                selected = STORAGE_TYPES.KV;
                reason = 'kv_data_only';
            } else if (!kvState.populated && d1State.populated) {
                selected = STORAGE_TYPES.D1;
                reason = 'd1_data_only';
            } else if (!kvState.populated && !d1State.populated) {
                const requested = configuredInitialStorage(env);
                selected = requested || STORAGE_TYPES.KV;
                reason = requested ? 'explicit_empty_dual' : 'empty_dual_default_kv';
            } else {
                if (kvState.marker && kvState.marker === d1State.marker) {
                    selected = kvState.marker;
                    reason = 'consistent_storage_marker';
                } else {
                    const requested = configuredInitialStorage(env);
                    if (requested) {
                        selected = requested;
                        reason = 'explicit_conflict_resolution';
                    } else {
                        throw new StorageInitializationError(
                            'STORAGE_SELECTION_AMBIGUOUS',
                            'KV and D1 both contain data without a consistent active storage marker'
                        );
                    }
                }
            }
        }

        await db.prepare(`INSERT INTO storage_control (id, active_storage, state, epoch, data, updated_at)
            VALUES (?, ?, 'idle', 1, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO NOTHING`)
            .bind(STORAGE_CONTROL_ID, selected, JSON.stringify({ initializedAutomatically: true, reason })).run();
        const control = await db.prepare('SELECT active_storage FROM storage_control WHERE id = ?')
            .bind(STORAGE_CONTROL_ID).first();
        if (control?.active_storage !== STORAGE_TYPES.KV && control?.active_storage !== STORAGE_TYPES.D1) {
            throw new StorageInitializationError('STORAGE_CONTROL_INVALID', 'Storage control initialization did not converge');
        }
        SettingsCache.clear();
        return { activeStorage: control.active_storage, initialized: true };
    } catch (error) {
        if (error instanceof StorageInitializationError) throw error;
        console.error('[Storage Initialization] Failed:', error?.message || error);
        throw new StorageInitializationError('STORAGE_INITIALIZATION_FAILED', 'Cloudflare storage initialization failed');
    }
}

let _globalSettingsCache = {
    data: null,
    timestamp: 0
};
const SETTINGS_CACHE_TTL_MS = 10 * 1000; // 10秒缓存过时

export class SettingsCache {
    /**
     * 带内存缓存的设置读取
     */
    static async get(env) {
        await initializeCloudflareStorage(env);
        const now = Date.now();
        if (_globalSettingsCache.data && (now - _globalSettingsCache.timestamp < SETTINGS_CACHE_TTL_MS)) {
            return _globalSettingsCache.data;
        }

        try {
            let settings = null;
            let preferredStorage = '';
            if (env?.TSUB_PLATFORM === 'server' && env.TSUB_SQL_DB) {
                preferredStorage = env.TSUB_STORAGE_TYPE === STORAGE_TYPES.POSTGRES ? STORAGE_TYPES.POSTGRES : STORAGE_TYPES.SQLITE;
                try {
                    const sqlAdapter = wrapSettingsAdapter(new D1StorageAdapter(env.TSUB_SQL_DB, preferredStorage), env);
                    settings = await sqlAdapter.get(DATA_KEYS.SETTINGS);
                } catch (sqlError) {
                    console.warn('[Storage Cache] Failed to read from server database:', sqlError.message);
                }
            } else if (env?.TSUB_DB) {
                try {
                    const control = await env.TSUB_DB.prepare('SELECT active_storage FROM storage_control WHERE id = ?').bind('main').first();
                    preferredStorage = control?.active_storage === STORAGE_TYPES.KV ? STORAGE_TYPES.KV : control?.active_storage === STORAGE_TYPES.D1 ? STORAGE_TYPES.D1 : '';
                } catch (d1Error) {
                    console.warn('[Storage Cache] Failed to read storage control:', d1Error.message);
                }
                if (preferredStorage === STORAGE_TYPES.D1 || !preferredStorage) {
                    try {
                        const d1Adapter = wrapSettingsAdapter(new D1StorageAdapter(env.TSUB_DB), env);
                        settings = await d1Adapter.get(DATA_KEYS.SETTINGS);
                    } catch (d1Error) {
                        console.warn('[Storage Cache] Failed to read from D1:', d1Error.message);
                    }
                }
            }

            const kvNs = resolveKV(env);
            if (!settings && kvNs && (preferredStorage === STORAGE_TYPES.KV || !preferredStorage)) {
                try {
                    const kvAdapter = wrapSettingsAdapter(new KVStorageAdapter(kvNs), env);
                    settings = await kvAdapter.get(DATA_KEYS.SETTINGS);
                } catch (kvError) {
                    console.warn('[Storage Cache] Failed to read from KV:', kvError.message);
                }
            }

            if (settings) {
                _globalSettingsCache.data = settings;
                _globalSettingsCache.timestamp = now;
                return settings;
            }
        } catch (error) {
            if (error instanceof StorageInitializationError) throw error;
            console.error('[Storage Cache] Failed to read settings:', error);
        }

        return null;
    }

    /**
     * 在更新设置后主动清除缓存
     */
    static clear() {
        _globalSettingsCache = { data: null, timestamp: 0 };
    }
}

/**
 * 存储工厂类
 * 根据配置创建相应的存储适配器
 */
export class StorageFactory {
    /**
     * 解析 KV 命名空间（委托顶层函数）
     */
    static resolveKV(env) {
        return resolveKV(env);
    }

    /**
     * 创建存储适配器
     * @param {Object} env - Cloudflare 环境对象
     * @param {string} storageType - 存储类型 ('kv' | 'd1')
     * @returns {KVStorageAdapter|D1StorageAdapter}
     */
    static createAdapter(env, storageType = STORAGE_TYPES.KV) {
        switch (storageType) {
            case STORAGE_TYPES.SQLITE:
            case STORAGE_TYPES.POSTGRES:
                if (!env.TSUB_SQL_DB) {
                    console.warn(`[Storage] ${storageType} database not available, using noop adapter`);
                    return wrapSettingsAdapter(new NoopStorageAdapter(), env);
                }
                return wrapSettingsAdapter(new D1StorageAdapter(env.TSUB_SQL_DB, storageType), env);
            case STORAGE_TYPES.D1:
                if (!env.TSUB_DB) {
                    throw new StorageInitializationError(
                        'ACTIVE_STORAGE_BINDING_MISSING',
                        'The active D1 storage binding is unavailable'
                    );
                }
                return wrapSettingsAdapter(new D1StorageAdapter(env.TSUB_DB), env);

            case STORAGE_TYPES.KV:
            default: {
                const kv = StorageFactory.resolveKV(env);
                if (!kv) {
                    console.warn('[Storage] No KV binding found, using noop adapter');
                    return wrapSettingsAdapter(new NoopStorageAdapter(), env);
                }
                return wrapSettingsAdapter(new KVStorageAdapter(kv), env);
            }
        }
    }


    /**
     * 获取当前存储类型设置
     * @param {Object} env - Cloudflare 环境对象
     * @returns {Promise<string>} 存储类型
     */
    static async getStorageType(env) {
        try {
            if (env?.TSUB_PLATFORM === 'server') {
                return env.TSUB_STORAGE_TYPE === STORAGE_TYPES.POSTGRES
                    ? STORAGE_TYPES.POSTGRES
                    : STORAGE_TYPES.SQLITE;
            }
            await initializeCloudflareStorage(env);
            const controlDb = env?.TSUB_DB || (env?.TSUB_PLATFORM === 'server' ? env.TSUB_SQL_DB : null);
            if (controlDb) {
                try {
                    const control = await controlDb.prepare('SELECT active_storage FROM storage_control WHERE id = ?').bind('main').first();
                    if (control?.active_storage && Object.values(STORAGE_TYPES).includes(control.active_storage)) return control.active_storage;
                } catch {}
            }
            const settings = await SettingsCache.get(env);
            if (settings?.storageType) {
                return settings.storageType;
            }
            return STORAGE_TYPES.KV;
        } catch (error) {
            if (error instanceof StorageInitializationError) throw error;
            console.error('[Storage] Failed to get storage type:', error);
            return STORAGE_TYPES.KV;
        }
    }

    /**
     * 将 KV Settings 同步到 D1（当 D1 为空时）
     */
    static async ensureD1Settings(env) {
        if (!env?.TSUB_DB) return false;
        try {
            const d1Adapter = wrapSettingsAdapter(new D1StorageAdapter(env.TSUB_DB), env);
            const existing = await d1Adapter.get(DATA_KEYS.SETTINGS);
            if (existing) return true;
            const kvNs = resolveKV(env);
            if (!kvNs) return false;
            const kvAdapter = wrapSettingsAdapter(new KVStorageAdapter(kvNs), env);
            const settings = await kvAdapter.get(DATA_KEYS.SETTINGS);
            if (!settings) return false;
            if (settings?.storageType !== STORAGE_TYPES.D1) {
                settings.storageType = STORAGE_TYPES.D1;
            }
            await d1Adapter.put(DATA_KEYS.SETTINGS, settings);
            return true;
        } catch (error) {
            console.warn('[Storage] ensureD1Settings failed:', error?.message || error);
            return false;
        }
    }

    /**
     * 检查是否配置了双重存储
     * @param {Object} env - Cloudflare环境对象
     * @returns {boolean} 是否配置了双重存储
     */
    static hasDualStorage(env) {
        return !!(StorageFactory.resolveKV(env) && env.TSUB_DB);
    }

    static async getActiveAdapter(env) {
        const storageType = await StorageFactory.getStorageType(env);
        return StorageFactory.createAdapter(env, storageType);
    }
}

/**
 * 数据迁移工具
 */
export class DataMigrator {
    static async _digest(value) {
        const stable = input => {
            if (Array.isArray(input)) return input.map(stable);
            if (!input || typeof input !== 'object') return input;
            return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
        };
        const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    static async _listKvKeys(kv, prefix = 'tsub_') {
        const keys = [];
        let cursor;
        do {
            const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
            keys.push(...(page.keys || []).map(item => item.name));
            cursor = page.list_complete === false ? page.cursor : null;
        } while (cursor);
        return keys;
    }

    static async _listMigratedKvKeys(kv) {
        const keys = new Set(await this._listKvKeys(kv, 'tsub_'));
        for (const key of SYSTEM_STORAGE_KEYS) {
            if (await kv.get(key) !== null) keys.add(key);
        }
        return [...keys].sort();
    }

    static async _persistentSettingsSnapshot(adapter) {
        const keys = new Set((await adapter.list('tsub_')).map(item => item.name));
        for (const key of SYSTEM_STORAGE_KEYS) {
            if (await adapter.get(key) !== null) keys.add(key);
        }
        const excluded = new Set([
            DATA_KEYS.SUBSCRIPTIONS,
            DATA_KEYS.PROFILES,
            'tsub_deployments_v2',
            'tsub_deployment_operations_v2'
        ]);
        const entries = [];
        for (const key of [...keys].filter(key => !excluded.has(key)).sort()) {
            entries.push([key, await adapter.get(key)]);
        }
        return {
            settings: await adapter.get(DATA_KEYS.SETTINGS),
            entries
        };
    }

    static async describeKV(env) {
        const kvNs = resolveKV(env);
        if (!kvNs) throw new Error('No KV binding found');
        const adapter = wrapSettingsAdapter(new KVStorageAdapter(kvNs), env);
        const { createDeploymentRepository } = await import('./services/deployment-repository.js');
        const repository = createDeploymentRepository(adapter);
        const data = {
            subscriptions: await adapter.getAllSubscriptions(), profiles: await adapter.getAllProfiles(),
            deployments: await repository.listDeployments(), operations: await repository.listOperations(),
            persistentSettings: await this._persistentSettingsSnapshot(adapter)
        };
        return {
            counts: {
                subscriptions: data.subscriptions.length,
                profiles: data.profiles.length,
                deployments: data.deployments.length,
                operations: data.operations.length
            },
            digest: await this._digest(data)
        };
    }

    static async describeD1(env) {
        if (!env.TSUB_DB) throw new Error('D1 database not available');
        await ensureD1Schema(env.TSUB_DB);
        const adapter = wrapSettingsAdapter(new D1StorageAdapter(env.TSUB_DB), env);
        const { createDeploymentRepository } = await import('./services/deployment-repository.js');
        const repository = createDeploymentRepository(adapter);
        const data = {
            subscriptions: await adapter.getAllSubscriptions(), profiles: await adapter.getAllProfiles(),
            deployments: await repository.listDeployments(), operations: await repository.listOperations(),
            persistentSettings: await this._persistentSettingsSnapshot(adapter)
        };
        return {
            counts: {
                subscriptions: data.subscriptions.length,
                profiles: data.profiles.length,
                deployments: data.deployments.length,
                operations: data.operations.length
            },
            digest: await this._digest(data)
        };
    }

    static async copyKVToD1(env, options = {}) {
        const kvNs = resolveKV(env);
        if (!kvNs || !env.TSUB_DB) throw new Error('KV and D1 bindings are required');
        await ensureD1Schema(env.TSUB_DB);
        const source = wrapSettingsAdapter(new KVStorageAdapter(kvNs), env);
        const target = wrapSettingsAdapter(new D1StorageAdapter(env.TSUB_DB), env);
        const { createDeploymentRepository } = await import('./services/deployment-repository.js');
        const sourceRepo = createDeploymentRepository(source); const targetRepo = createDeploymentRepository(target);
        const subscriptions = await source.getAllSubscriptions();
        const profiles = await source.getAllProfiles();
        for (const table of ['controller_transfers', 'deployment_heartbeats', 'deployment_agents', 'deployment_commands', 'deployment_snapshots', 'deployment_events', 'deployment_operations', 'deployments', 'profiles', 'subscriptions']) {
            await env.TSUB_DB.prepare(`DELETE FROM ${table}`).run();
        }
        for (const item of subscriptions) await target.putSubscription(item);
        for (const item of profiles) await target.putProfile(item);
        for (const item of await sourceRepo.listDeployments()) await targetRepo.putDeployment(item);
        for (const item of await sourceRepo.listOperations()) await targetRepo.putOperation(item);
        const settings = await source.get(DATA_KEYS.SETTINGS);
        if (settings) await target.put(DATA_KEYS.SETTINGS, { ...settings, storageType: options.switchStorage === false ? settings.storageType : STORAGE_TYPES.D1 });
        const excluded = new Set([DATA_KEYS.SUBSCRIPTIONS, DATA_KEYS.PROFILES, 'tsub_deployments_v2', 'tsub_deployment_operations_v2']);
        const kvKeys = await this._listMigratedKvKeys(kvNs);
        const explicitPlaceholders = SYSTEM_STORAGE_KEYS.map(() => '?').join(', ');
        const d1ExtraRows = await env.TSUB_DB.prepare(`SELECT key FROM settings WHERE key LIKE 'tsub_%' OR key IN (${explicitPlaceholders})`)
            .bind(...SYSTEM_STORAGE_KEYS).all();
        const kvKeySet = new Set(kvKeys);
        for (const row of d1ExtraRows?.results || []) {
            if (!kvKeySet.has(row.key)) await env.TSUB_DB.prepare('DELETE FROM settings WHERE key = ?').bind(row.key).run();
        }
        for (const key of kvKeys) {
            if (excluded.has(key)) continue;
            const raw = await kvNs.get(key);
            if (raw !== null) await env.TSUB_DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(key, raw).run();
        }
        return this.describeKV(env);
    }

    static async copyD1ToKV(env, options = {}) {
        const kvNs = resolveKV(env);
        if (!kvNs || !env.TSUB_DB) throw new Error('KV and D1 bindings are required');
        await ensureD1Schema(env.TSUB_DB);
        const source = wrapSettingsAdapter(new D1StorageAdapter(env.TSUB_DB), env);
        const target = wrapSettingsAdapter(new KVStorageAdapter(kvNs), env);
        const { createDeploymentRepository } = await import('./services/deployment-repository.js');
        const sourceRepo = createDeploymentRepository(source); const targetRepo = createDeploymentRepository(target);
        await target.putAllSubscriptions(await source.getAllSubscriptions());
        await target.putAllProfiles(await source.getAllProfiles());
        await target.put('tsub_deployments_v2', await sourceRepo.listDeployments());
        await target.put('tsub_deployment_operations_v2', await sourceRepo.listOperations());
        const settings = await source.get(DATA_KEYS.SETTINGS);
        if (settings) await target.put(DATA_KEYS.SETTINGS, { ...settings, storageType: options.switchStorage === false ? settings.storageType : STORAGE_TYPES.KV });
        const explicitPlaceholders = SYSTEM_STORAGE_KEYS.map(() => '?').join(', ');
        const rows = await env.TSUB_DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'tsub_%' OR key IN (${explicitPlaceholders})`)
            .bind(...SYSTEM_STORAGE_KEYS).all();
        const sourceKeys = new Set((rows?.results || []).map(row => row.key));
        for (const key of await this._listMigratedKvKeys(kvNs)) {
            if (![DATA_KEYS.SUBSCRIPTIONS, DATA_KEYS.PROFILES, 'tsub_deployments_v2', 'tsub_deployment_operations_v2'].includes(key) && !sourceKeys.has(key)) await kvNs.delete(key);
        }
        for (const row of rows?.results || []) {
            if ([DATA_KEYS.SUBSCRIPTIONS, DATA_KEYS.PROFILES, 'tsub_deployments_v2', 'tsub_deployment_operations_v2'].includes(row.key)) continue;
            await kvNs.put(row.key, row.value);
        }
        return this.describeD1(env);
    }

    /**
     * 从 KV 迁移到 D1
     * @param {Object} env - Cloudflare 环境对象
     * @returns {Promise<Object>} 迁移结果
     */
    static async migrateKVToD1(env) {
        try {
            const copied = await this.copyKVToD1(env, { switchStorage: true });
            await env.TSUB_DB.prepare(`INSERT INTO storage_control (id, active_storage, state, epoch, data, updated_at)
                VALUES ('main', 'd1', 'idle', 1, '{}', CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET active_storage = 'd1', state = 'idle', epoch = storage_control.epoch + 1, updated_at = CURRENT_TIMESTAMP`).run();
            SettingsCache.clear();
            return { subscriptions: true, profiles: true, settings: true, deployments: true, operations: true, counts: copied.counts, digest: copied.digest, errors: [] };
        } catch (error) {
            console.error('[Migration] Failed to migrate KV to D1:', error);
            throw error;
        }
    }

    static async migrateLegacyD1MainRows(env) {
        if (!env?.TSUB_DB) throw new Error('D1 database not available');

        const d1Adapter = new D1StorageAdapter(env.TSUB_DB);
        await ensureD1Schema(d1Adapter.db);

        const results = {
            subscriptions: 0,
            profiles: 0,
            errors: []
        };

        try {
            const legacySubs = await d1Adapter.get(DATA_KEYS.SUBSCRIPTIONS);
            if (Array.isArray(legacySubs)) {
                for (const item of legacySubs) {
                    if (!item?.id) continue;
                    await d1Adapter.putSubscription(item);
                    results.subscriptions += 1;
                }
                await d1Adapter.db.prepare('DELETE FROM subscriptions WHERE id = ?').bind('main').run();
            }
        } catch (error) {
            results.errors.push(`订阅主行迁移失败: ${error.message}`);
        }

        try {
            const legacyProfiles = await d1Adapter.get(DATA_KEYS.PROFILES);
            if (Array.isArray(legacyProfiles)) {
                for (const item of legacyProfiles) {
                    if (!item?.id) continue;
                    await d1Adapter.putProfile(item);
                    results.profiles += 1;
                }
                await d1Adapter.db.prepare('DELETE FROM profiles WHERE id = ?').bind('main').run();
            }
        } catch (error) {
            results.errors.push(`订阅组主行迁移失败: ${error.message}`);
        }

        return results;
    }

    static async detectLegacyD1MainRows(env) {
        if (!env?.TSUB_DB) {
            return {
                hasLegacySubscriptions: false,
                hasLegacyProfiles: false,
                hasLegacyData: false
            };
        }

        const d1Adapter = new D1StorageAdapter(env.TSUB_DB);
        const [legacySubs, legacyProfiles] = await Promise.all([
            d1Adapter.db.prepare('SELECT data FROM subscriptions WHERE id = ?').bind('main').first(),
            d1Adapter.db.prepare('SELECT data FROM profiles WHERE id = ?').bind('main').first()
        ]);

        const hasLegacySubscriptions = Array.isArray(legacySubs ? JSON.parse(legacySubs.data) : null);
        const hasLegacyProfiles = Array.isArray(legacyProfiles ? JSON.parse(legacyProfiles.data) : null);

        return {
            hasLegacySubscriptions,
            hasLegacyProfiles,
            hasLegacyData: hasLegacySubscriptions || hasLegacyProfiles
        };
    }
}

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function questionMarksToPostgres(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizePostgresSql(sql) {
  let value = sql.replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ');
  const replaceMatch = value.match(/^\s*INSERT OR REPLACE INTO\s+(settings|subscriptions|profiles)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if (replaceMatch) {
    const table = replaceMatch[1];
    const columns = replaceMatch[2].split(',').map(item => item.trim());
    const conflict = table === 'settings' ? 'key' : 'id';
    const updates = columns.filter(column => column !== conflict && column !== 'created_at')
      .map(column => `${column} = EXCLUDED.${column}`).join(', ');
    value = value.replace(/INSERT OR REPLACE/i, 'INSERT');
    value += ` ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`;
  }
  return questionMarksToPostgres(value);
}

class SQLiteStatement {
  constructor(statement) { this.statement = statement; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async first() { return this.statement.get(...this.params) || null; }
  async all() { return { success: true, results: this.statement.all(...this.params) }; }
  async run() {
    const result = this.statement.run(...this.params);
    return { success: true, meta: { changes: Number(result.changes || 0), last_row_id: result.lastInsertRowid } };
  }
}

class SQLiteDatabaseBinding {
  constructor(database) { this.database = database; }
  prepare(sql) { return new SQLiteStatement(this.database.prepare(sql)); }
  async exec(sql) { this.database.exec(sql); return { success: true }; }
  async batch(statements) {
    return this.database.transaction(() => statements.map(statement => {
      const result = statement.statement.run(...statement.params);
      return { success: true, meta: { changes: Number(result.changes || 0), last_row_id: result.lastInsertRowid } };
    }))();
  }
  close() { this.database.close(); }
}

class PostgresStatement {
  constructor(pool, sql) { this.pool = pool; this.sql = normalizePostgresSql(sql); this.params = []; }
  bind(...params) { this.params = params; return this; }
  async first() { const result = await this.pool.query(this.sql, this.params); return result.rows[0] || null; }
  async all() { const result = await this.pool.query(this.sql, this.params); return { success: true, results: result.rows }; }
  async run() { const result = await this.pool.query(this.sql, this.params); return { success: true, meta: { changes: result.rowCount }, changes: result.rowCount }; }
}

class PostgresDatabaseBinding {
  constructor(pool) { this.pool = pool; }
  prepare(sql) { return new PostgresStatement(this.pool, sql); }
  async exec(sql) {
    const statements = sql.split(';').map(item => item.trim()).filter(Boolean);
    for (const statement of statements) await this.pool.query(normalizePostgresSql(statement));
    return { success: true };
  }
  async batch(statements) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const statement of statements) {
        const result = await client.query(statement.sql, statement.params);
        results.push({ success: true, meta: { changes: result.rowCount }, changes: result.rowCount });
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}

export async function createServerDatabase(options = {}) {
  const type = options.type === 'postgres' ? 'postgres' : 'sqlite';
  if (type === 'postgres') {
    if (!options.url) throw new Error('TSUB_DATABASE_URL is required for PostgreSQL');
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: options.url, max: Number(options.poolSize || 10) });
    await pool.query('SELECT 1');
    return { type, binding: new PostgresDatabaseBinding(pool) };
  }

  const dataDir = options.dataDir || '/var/lib/tsub-controller';
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const { default: BetterSqlite3 } = await import('better-sqlite3');
  const databasePath = options.path || path.join(dataDir, 'tsub.sqlite');
  const database = new BetterSqlite3(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  database.pragma('synchronous = NORMAL');
  await Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(file => chmod(file, 0o600).catch(() => {})));
  return { type, binding: new SQLiteDatabaseBinding(database) };
}

async function readControlFile(controlPath, fallback) {
  try {
    const parsed = JSON.parse(await readFile(controlPath, 'utf8'));
    return parsed?.activeStorage === 'postgres' ? 'postgres' : parsed?.activeStorage === 'sqlite' ? 'sqlite' : fallback;
  } catch {
    return fallback;
  }
}

async function writeControlFile(controlPath, activeStorage) {
  await mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 });
  const temporary = `${controlPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ activeStorage, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  await rename(temporary, controlPath);
  await chmod(controlPath, 0o600);
}

export async function createServerDatabaseManager(options = {}) {
  const dataDir = options.dataDir || '/var/lib/tsub-controller';
  const configured = options.type === 'postgres' ? 'postgres' : 'sqlite';
  const controlPath = options.controlPath || path.join(dataDir, 'storage-control.json');
  const activeStorage = await readControlFile(controlPath, configured);
  if (activeStorage === 'postgres' && !options.postgresUrl) {
    throw new Error('Active storage is PostgreSQL but TSUB_POSTGRES_URL/TSUB_DATABASE_URL is missing');
  }

  const databases = {};
  databases.sqlite = (await createServerDatabase({
    type: 'sqlite', path: options.sqlitePath, dataDir
  })).binding;
  if (options.postgresUrl) {
    databases.postgres = (await createServerDatabase({
      type: 'postgres', url: options.postgresUrl, poolSize: options.poolSize
    })).binding;
  }

  if (!databases[activeStorage]) throw new Error(`Server storage ${activeStorage} is unavailable`);
  if (!(await readControlFile(controlPath, ''))) await writeControlFile(controlPath, activeStorage);

  let current = activeStorage;
  return {
    databases,
    controlPath,
    get type() { return current; },
    get binding() { return databases[current]; },
    async switchStorage(target) {
      if (!databases[target]) throw new Error(`Server storage ${target} is unavailable`);
      await writeControlFile(controlPath, target);
      current = target;
      return target;
    },
    async close() {
      await Promise.all(Object.values(databases).map(binding => binding.close?.()));
    }
  };
}

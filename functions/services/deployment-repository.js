import { STORAGE_TYPES } from '../storage-adapter.js';

export const DEPLOYMENTS_KEY = 'tsub_deployments_v2';
export const OPERATIONS_KEY = 'tsub_deployment_operations_v2';

const MAX_DEPLOYMENTS = 100;
const MAX_OPERATIONS = 500;

function parseRow(row) {
  if (!row) return null;
  const value = row.data ?? row.value;
  if (typeof value === 'object' && value !== null) return value;
  try { return JSON.parse(value); } catch { return null; }
}

function rowsOf(result) {
  return Array.isArray(result?.results) ? result.results : Array.isArray(result?.rows) ? result.rows : [];
}

class CollectionDeploymentRepository {
  constructor(storage) { this.storage = storage; this.rowLevel = false; }

  async listDeployments() {
    const value = await this.storage.get(DEPLOYMENTS_KEY);
    return Array.isArray(value) ? value : [];
  }

  async getDeployment(id) {
    return (await this.listDeployments()).find(item => item.id === id) || null;
  }

  async putDeployment(item) {
    const all = await this.listDeployments();
    const index = all.findIndex(candidate => candidate.id === item.id);
    if (index >= 0) all[index] = item; else all.unshift(item);
    await this.storage.put(DEPLOYMENTS_KEY, all.slice(0, MAX_DEPLOYMENTS));
    return item;
  }

  async deleteDeployment(id) {
    const all = await this.listDeployments();
    await this.storage.put(DEPLOYMENTS_KEY, all.filter(item => item.id !== id));
    const operations = await this.listOperations();
    await this.storage.put(OPERATIONS_KEY, operations.filter(item => item.deploymentId !== id));
    return all.some(item => item.id === id);
  }

  async listOperations(deploymentId = '') {
    const value = await this.storage.get(OPERATIONS_KEY);
    const all = Array.isArray(value) ? value : [];
    return deploymentId ? all.filter(item => item.deploymentId === deploymentId) : all;
  }

  async getOperation(id) {
    return (await this.listOperations()).find(item => item.id === id) || null;
  }

  async putOperation(item) {
    const all = await this.listOperations();
    const index = all.findIndex(candidate => candidate.id === item.id);
    if (index >= 0) all[index] = item; else all.unshift(item);
    await this.storage.put(OPERATIONS_KEY, all.slice(0, MAX_OPERATIONS));
    return item;
  }
}

class SqlDeploymentRepository {
  constructor(storage) {
    this.storage = storage;
    this.db = storage.db;
    this.rowLevel = true;
  }

  async listDeployments() {
    const result = await this.db.prepare('SELECT data FROM deployments ORDER BY updated_at DESC LIMIT ?').bind(MAX_DEPLOYMENTS).all();
    return rowsOf(result).map(parseRow).filter(Boolean);
  }

  async getDeployment(id) {
    return parseRow(await this.db.prepare('SELECT data FROM deployments WHERE id = ?').bind(id).first());
  }

  async putDeployment(item, expectedRevision = null) {
    const data = JSON.stringify(item);
    if (expectedRevision !== null) {
      const result = await this.db.prepare(`UPDATE deployments SET data = ?, status = ?, config_revision = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND config_revision = ?`).bind(data, item.status || '', item.configRevision || 1, item.id, expectedRevision).run();
      if (!result?.success || result.meta?.changes === 0 || result.changes === 0) {
        const error = new Error('Deployment configuration changed');
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      return item;
    }
    await this.db.prepare(`INSERT INTO deployments (id, status, config_revision, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, config_revision = excluded.config_revision,
      data = excluded.data, updated_at = CURRENT_TIMESTAMP`).bind(item.id, item.status || '', item.configRevision || 1, data, item.createdAt || null).run();
    return item;
  }

  async deleteDeployment(id) {
    const result = await this.db.prepare('DELETE FROM deployments WHERE id = ?').bind(id).run();
    return Boolean(result?.success);
  }

  async listOperations(deploymentId = '') {
    const statement = deploymentId
      ? this.db.prepare('SELECT data FROM deployment_operations WHERE deployment_id = ? ORDER BY created_at DESC LIMIT ?').bind(deploymentId, MAX_OPERATIONS)
      : this.db.prepare('SELECT data FROM deployment_operations ORDER BY created_at DESC LIMIT ?').bind(MAX_OPERATIONS);
    const result = await statement.all();
    const operations = rowsOf(result).map(parseRow).filter(Boolean);
    if (!operations.length) return operations;
    const eventResult = deploymentId
      ? await this.db.prepare(`SELECT e.operation_id, e.data FROM deployment_events e
          JOIN deployment_operations o ON o.id = e.operation_id
          WHERE o.deployment_id = ? ORDER BY e.created_at ASC`).bind(deploymentId).all()
      : await this.db.prepare('SELECT operation_id, data FROM deployment_events ORDER BY created_at ASC').all();
    const grouped = new Map();
    for (const row of rowsOf(eventResult)) {
      const event = parseRow(row);
      if (!event) continue;
      const list = grouped.get(row.operation_id) || [];
      list.push(event);
      grouped.set(row.operation_id, list.slice(-50));
    }
    return operations.map(operation => ({ ...operation, events: grouped.get(operation.id) || [] }));
  }

  async getOperation(id) {
    const operation = parseRow(await this.db.prepare('SELECT data FROM deployment_operations WHERE id = ?').bind(id).first());
    if (!operation) return null;
    const events = rowsOf(await this.db.prepare(`SELECT data FROM (
      SELECT data, created_at FROM deployment_events WHERE operation_id = ? ORDER BY created_at DESC LIMIT 50
    ) recent ORDER BY created_at ASC`).bind(id).all()).map(parseRow).filter(Boolean);
    return { ...operation, events };
  }

  async putOperation(item) {
    const { events = [], ...summary } = item;
    await this.db.prepare(`INSERT INTO deployment_operations
      (id, deployment_id, action, status, data, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data,
      updated_at = CURRENT_TIMESTAMP, expires_at = excluded.expires_at`).bind(
        item.id, item.deploymentId, item.action || '', item.status || '', JSON.stringify(summary), item.createdAt || null, item.expiresAt || null
      ).run();
    const existing = rowsOf(await this.db.prepare('SELECT data FROM deployment_events WHERE operation_id = ? ORDER BY created_at ASC').bind(item.id).all()).map(parseRow).filter(Boolean);
    const existingKeys = new Set(existing.map(event => `${event.at}|${event.status}|${event.stage}|${event.message}`));
    for (const event of events.slice(-50)) {
      const key = `${event.at}|${event.status}|${event.stage}|${event.message}`;
      if (existingKeys.has(key)) continue;
      await this.db.prepare('INSERT INTO deployment_events (id, operation_id, data, created_at) VALUES (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), item.id, JSON.stringify(event), event.at || new Date().toISOString()).run();
    }
    return item;
  }
}

export function createDeploymentRepository(storage) {
  return [STORAGE_TYPES.D1, STORAGE_TYPES.SQLITE, STORAGE_TYPES.POSTGRES].includes(storage.type) && storage.db
    ? new SqlDeploymentRepository(storage)
    : new CollectionDeploymentRepository(storage);
}

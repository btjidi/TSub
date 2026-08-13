import { createDeploymentRepository } from './deployment-repository.js';
import { getPlatformCapabilities } from './platform-capabilities.js';

const COMMAND_TTL_MS = 30 * 60 * 1000;
const LEASE_TTL_MS = 120 * 1000;
const HEARTBEAT_WRITE_MS = 60 * 1000;
const ONLINE_MS = 150 * 1000;
const AGENT_POLL_INTERVALS = new Set([15, 30, 60, 120, 180, 300]);

function agentPollInterval(value) {
  const interval = Number(value);
  return Number.isInteger(interval) && AGENT_POLL_INTERVALS.has(interval) ? interval : 30;
}

function onlineWindowMs(heartbeatData) {
  return Math.max(ONLINE_MS, agentPollInterval(heartbeatData?.pollIntervalSeconds) * 3 * 1000);
}

function base64Url(bytes) {
  let binary = ''; bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
const randomToken = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));
const randomId = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
const nowIso = () => new Date().toISOString();

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function bearer(request) {
  const match = String(request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function rows(result) { return result?.results || result?.rows || []; }
function parseData(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }
function changes(result) { return Number(result?.meta?.changes ?? result?.changes ?? 0); }
function safeHostname(value) { return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160); }

async function failExpiredRunningCommands(storage, timestamp, deploymentId = '') {
  const binding = deploymentId ? [deploymentId, timestamp] : [timestamp];
  const where = deploymentId ? 'deployment_id = ? AND ' : '';
  const result = await storage.db.prepare(`SELECT id, deployment_id, operation_id, action, data FROM deployment_commands
    WHERE ${where}status = 'running' AND lease_expires_at <= ?`).bind(...binding).all();
  const repository = createDeploymentRepository(storage);
  for (const command of rows(result)) {
    const at = timestamp;
    const message = 'Agent command lease expired before completion';
    const updated = await storage.db.prepare(`UPDATE deployment_commands SET status = 'failed', lease_id = NULL,
      lease_expires_at = NULL, data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running' AND lease_expires_at <= ?`)
      .bind(JSON.stringify({ ...parseData(command.data), status: 'failed', updatedAt: at, error: 'agent_lease_expired' }), command.id, timestamp).run();
    if (!changes(updated)) continue;
    const operation = await repository.getOperation(command.operation_id);
    if (operation) {
      let hostname = safeHostname(operation.hostname);
      if (!hostname) {
        const heartbeat = await storage.db.prepare('SELECT data FROM deployment_heartbeats WHERE deployment_id = ?')
          .bind(command.deployment_id).first();
        hostname = safeHostname(parseData(heartbeat?.data).hostname);
      }
      const event = { at, status: 'failed', stage: command.action, message, resources: {} };
      operation.events = [...(operation.events || []), event].slice(-50);
      operation.status = 'failed'; operation.updatedAt = at; operation.completedAt = at; operation.message = message;
      if (hostname) operation.hostname = hostname;
      await repository.putOperation(operation);
    }
    const deployment = await repository.getDeployment(command.deployment_id);
    if (deployment) {
      deployment.status = 'failed'; deployment.updatedAt = at; deployment.lastError = message;
      if (deployment.pendingOperationId === command.operation_id) delete deployment.pendingOperationId;
      await repository.putDeployment(deployment);
    }
  }
}

async function assertAgentReady(storage, deploymentId) {
  if (!storage.db) throw Object.assign(new Error('Full storage mode is required'), { status: 409, code: 'full_storage_required' });
  const now = nowIso();
  await storage.db.prepare(`UPDATE deployment_commands SET status = 'expired', lease_id = NULL, lease_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE deployment_id = ? AND status IN ('pending','claimed','running')
    AND expires_at <= ?`).bind(deploymentId, now).run();
  const active = await storage.db.prepare(`SELECT id FROM deployment_commands WHERE deployment_id = ?
    AND status IN ('pending','claimed','running') AND expires_at > ? LIMIT 1`).bind(deploymentId, now).first();
  if (active) throw Object.assign(new Error('Another remote command is active'), { status: 409, code: 'command_active' });
  const agent = await storage.db.prepare('SELECT deployment_id FROM deployment_agents WHERE deployment_id = ? AND revoked_at IS NULL').bind(deploymentId).first();
  if (!agent) throw Object.assign(new Error('Deployment agent is not connected'), { status: 409, code: 'agent_unavailable' });
  const heartbeat = await storage.db.prepare('SELECT data, last_seen_at FROM deployment_heartbeats WHERE deployment_id = ?').bind(deploymentId).first();
  if (!heartbeat || Date.parse(heartbeat.last_seen_at) < Date.now() - onlineWindowMs(parseData(heartbeat.data))) {
    throw Object.assign(new Error('Deployment agent is offline'), { status: 409, code: 'agent_offline' });
  }
}

export async function ensureDeploymentAgent(storage, deployment, options = {}) {
  if (!storage.db) return { token: '', configured: false };
  const current = await storage.db.prepare('SELECT generation FROM deployment_agents WHERE deployment_id = ? AND revoked_at IS NULL').bind(deployment.id).first();
  if (current && Number(current.generation || 0) >= 1) {
    if (options.rotateIfOffline === true && deployment.controlTransport !== 'local-executor') {
      const heartbeat = await storage.db.prepare('SELECT data, last_seen_at FROM deployment_heartbeats WHERE deployment_id = ?').bind(deployment.id).first();
      const heartbeatData = parseData(heartbeat?.data);
      const online = heartbeat?.last_seen_at && Date.parse(heartbeat.last_seen_at) >= Date.now() - onlineWindowMs(heartbeatData);
      if (!online) return rotateDeploymentAgent(storage, deployment.id);
    }
    return { token: '', configured: true, generation: Number(current.generation) };
  }
  const token = randomToken(); const tokenHash = await sha256(token);
  await storage.db.prepare(`INSERT INTO deployment_agents (deployment_id, token_hash, generation, revoked_at, created_at, updated_at)
    VALUES (?, ?, 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(deployment_id) DO UPDATE SET token_hash = excluded.token_hash, generation = 0,
    revoked_at = NULL, updated_at = CURRENT_TIMESTAMP`).bind(deployment.id, tokenHash).run();
  return { token, configured: true, generation: 0 };
}

export async function rotateDeploymentAgent(storage, deploymentId) {
  if (!storage.db) throw Object.assign(new Error('Full storage mode is required'), { status: 409, code: 'full_storage_required' });
  const token = randomToken();
  const tokenHash = await sha256(token);
  const current = await storage.db.prepare('SELECT generation FROM deployment_agents WHERE deployment_id = ?').bind(deploymentId).first();
  const generation = Math.max(1, Number(current?.generation || 0) + 1);
  await storage.db.prepare(`INSERT INTO deployment_agents (deployment_id, token_hash, generation, revoked_at, created_at, updated_at)
    VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(deployment_id) DO UPDATE SET token_hash = excluded.token_hash, generation = excluded.generation,
    revoked_at = NULL, updated_at = CURRENT_TIMESTAMP`).bind(deploymentId, tokenHash, generation).run();
  return { token, generation };
}

export async function queueAgentCommand(storage, deployment, operation, commandData = {}) {
  await assertAgentReady(storage, deployment.id);
  const command = {
    id: randomId('cmd'), deploymentId: deployment.id, operationId: operation.id, action: operation.action,
    status: 'pending', createdAt: nowIso(), expiresAt: new Date(Date.now() + COMMAND_TTL_MS).toISOString()
  };
  try {
    await storage.db.prepare(`INSERT INTO deployment_commands
      (id, deployment_id, operation_id, action, status, expires_at, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .bind(command.id, deployment.id, operation.id, operation.action, command.expiresAt, JSON.stringify({ ...command, ...commandData })).run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) {
      throw Object.assign(new Error('Another remote command is active'), { status: 409, code: 'command_active' });
    }
    throw error;
  }
  return command;
}

export async function queueAgentConfigurationUpdate(storage, currentDeployment, nextDeployment, operation, expectedRevision) {
  await assertAgentReady(storage, currentDeployment.id);
  if (typeof storage.db.batch !== 'function') {
    throw Object.assign(new Error('Transactional storage is required'), { status: 409, code: 'full_storage_required' });
  }
  const command = {
    id: randomId('cmd'), deploymentId: currentDeployment.id, operationId: operation.id, action: 'update',
    status: 'pending', createdAt: nowIso(), expiresAt: new Date(Date.now() + COMMAND_TTL_MS).toISOString()
  };
  const deploymentData = JSON.stringify(nextDeployment);
  const { events: _events, ...operationSummary } = operation;
  const statements = [
    storage.db.prepare(`UPDATE deployments SET data = ?, status = ?, config_revision = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND config_revision = ?`).bind(
      deploymentData, nextDeployment.status || '', nextDeployment.configRevision, currentDeployment.id, expectedRevision
    ),
    storage.db.prepare(`INSERT INTO deployment_operations
      (id, deployment_id, action, status, data, created_at, updated_at, expires_at)
      SELECT ?, ?, 'update', 'pending', ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP, ?
      WHERE EXISTS (SELECT 1 FROM deployments WHERE id = ? AND data = ?)`).bind(
      operation.id, currentDeployment.id, JSON.stringify(operationSummary), operation.createdAt || null,
      operation.expiresAt || null, currentDeployment.id, deploymentData
    ),
    storage.db.prepare(`INSERT INTO deployment_commands
      (id, deployment_id, operation_id, action, status, expires_at, data, created_at, updated_at)
      SELECT ?, ?, ?, 'update', 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM deployments WHERE id = ? AND data = ?)`).bind(
      command.id, currentDeployment.id, operation.id, command.expiresAt, JSON.stringify(command),
      currentDeployment.id, deploymentData
    )
  ];
  try {
    const results = await storage.db.batch(statements);
    if (results.some(result => changes(result) !== 1)) {
      throw Object.assign(new Error('Deployment configuration changed'), { status: 409, code: 'REVISION_CONFLICT' });
    }
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') throw error;
    if (/unique|constraint/i.test(String(error?.message || ''))) {
      throw Object.assign(new Error('Another remote command is active'), { status: 409, code: 'command_active' });
    }
    throw error;
  }
  return command;
}

async function authenticateAgent(request, env, storage) {
  const capabilities = await getPlatformCapabilities(env);
  if (!capabilities.features.remoteAgent || !storage.db) return { error: { status: 409, code: 'd1_required' } };
  const token = bearer(request);
  if (!token) return { error: { status: 401, code: 'unauthorized' } };
  const tokenHash = await sha256(token);
  const agent = await storage.db.prepare(`SELECT deployment_id, generation FROM deployment_agents
    WHERE token_hash = ? AND revoked_at IS NULL`).bind(tokenHash).first();
  if (!agent) return { error: { status: 401, code: 'unauthorized' } };
  if (Number(agent.generation || 0) === 0) {
    await storage.db.prepare(`UPDATE deployment_agents SET generation = 1, updated_at = CURRENT_TIMESTAMP
      WHERE deployment_id = ? AND token_hash = ? AND generation = 0`).bind(agent.deployment_id, tokenHash).run();
    agent.generation = 1;
  }
  return { agent, tokenHash };
}

export async function pollAgent(request, env, storage, payload = {}) {
  const auth = await authenticateAgent(request, env, storage);
  if (auth.error) return auth;
  const deploymentId = auth.agent.deployment_id;
  const timestamp = nowIso();
  const previous = await storage.db.prepare('SELECT data, last_seen_at FROM deployment_heartbeats WHERE deployment_id = ?').bind(deploymentId).first();
  const heartbeat = {
    runtimeVersion: String(payload.runtimeVersion || '').slice(0, 64), core: String(payload.core || '').slice(0, 32),
    coreVersion: String(payload.coreVersion || '').slice(0, 120), coreIdentity: String(payload.coreIdentity || '').slice(0, 200),
    osId: String(payload.osId || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32),
    osVersion: String(payload.osVersion || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64),
    osPrettyName: String(payload.osPrettyName || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160),
    hostname: String(payload.hostname || '').slice(0, 160), currentCommandId: String(payload.currentCommandId || '').slice(0, 96),
    configRevision: Number.isSafeInteger(Number(payload.configRevision)) ? Number(payload.configRevision) : 0,
    pollIntervalSeconds: agentPollInterval(payload.pollIntervalSeconds),
    cgroupLimitMb: Math.max(0, Number(payload.cgroupLimitMb || 0) || 0),
    memoryAvailableMb: Math.max(0, Number(payload.memoryAvailableMb || 0) || 0),
    swapReported: payload.swapReported === true,
    swapTotalMb: Math.max(0, Number(payload.swapTotalMb || 0) || 0),
    swapFreeMb: Math.max(0, Number(payload.swapFreeMb || 0) || 0),
    swapUsedMb: Math.max(0, Number(payload.swapUsedMb || 0) || 0),
    cgroupSwapReported: payload.cgroupSwapReported === true,
    cgroupSwapCurrentMb: Math.max(0, Number(payload.cgroupSwapCurrentMb || 0) || 0),
    cgroupSwapLimitMb: Number(payload.cgroupSwapLimitMb) === -1 ? -1 : Math.max(0, Number(payload.cgroupSwapLimitMb || 0) || 0),
    rssMb: Math.max(0, Number(payload.rssMb || 0) || 0),
    coreRssMb: Math.max(0, Number(payload.coreRssMb || 0) || 0),
    cloudflaredRssMb: Math.max(0, Number(payload.cloudflaredRssMb || 0) || 0),
    estimatedCoreRssMb: Math.max(0, Number(payload.estimatedCoreRssMb || 0) || 0),
    estimatedCloudflaredRssMb: Math.max(0, Number(payload.estimatedCloudflaredRssMb || 0) || 0)
  };
  const heartbeatData = JSON.stringify(heartbeat);
  const heartbeatChanged = !previous || previous.data !== heartbeatData;
  if (heartbeatChanged || Date.parse(previous.last_seen_at) < Date.now() - HEARTBEAT_WRITE_MS || payload.stateChanged === true) {
    await storage.db.prepare(`INSERT INTO deployment_heartbeats (deployment_id, data, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(deployment_id) DO UPDATE SET data = excluded.data, last_seen_at = excluded.last_seen_at`)
      .bind(deploymentId, heartbeatData, timestamp).run();
  }
  if (payload.heartbeatOnly === true) {
    return { deploymentId, heartbeatAt: timestamp, nextPollSeconds: heartbeat.pollIntervalSeconds, command: null };
  }
  await failExpiredRunningCommands(storage, timestamp, deploymentId);
  await storage.db.prepare(`UPDATE deployment_commands SET status = 'pending', lease_id = NULL, lease_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE deployment_id = ? AND status = 'claimed' AND lease_expires_at <= ? AND expires_at > ?`).bind(deploymentId, timestamp, timestamp).run();
  await storage.db.prepare(`UPDATE deployment_commands SET status = 'expired', lease_id = NULL, lease_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE deployment_id = ? AND status IN ('pending','claimed','running') AND expires_at <= ?`).bind(deploymentId, timestamp).run();
  const pending = await storage.db.prepare(`SELECT id, operation_id, action, data FROM deployment_commands
    WHERE deployment_id = ? AND status = 'pending' AND expires_at > ?
    ORDER BY created_at ASC LIMIT 1`).bind(deploymentId, timestamp).first();
  if (!pending) return { deploymentId, heartbeatAt: timestamp, nextPollSeconds: heartbeat.pollIntervalSeconds, command: null };
  const leaseId = randomToken();
  const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const claimed = await storage.db.prepare(`UPDATE deployment_commands SET status = 'claimed', lease_id = ?, lease_expires_at = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).bind(leaseId, leaseExpiresAt, pending.id).run();
  const changes = claimed?.meta?.changes ?? claimed?.changes ?? 0;
  if (!changes) return { deploymentId, heartbeatAt: timestamp, nextPollSeconds: 5, command: null };
  return { deploymentId, heartbeatAt: timestamp, nextPollSeconds: heartbeat.pollIntervalSeconds, command: { id: pending.id, operationId: pending.operation_id, action: pending.action, leaseId, leaseExpiresAt } };
}

export async function authorizeAgentCommand(request, env, storage, commandId) {
  const auth = await authenticateAgent(request, env, storage);
  if (auth.error) return auth;
  const leaseId = String(request.headers.get('X-TSub-Lease') || '');
  const command = await storage.db.prepare(`SELECT * FROM deployment_commands WHERE id = ? AND deployment_id = ?
    AND lease_id = ? AND status IN ('claimed','running') AND lease_expires_at > ?`)
    .bind(commandId, auth.agent.deployment_id, leaseId, nowIso()).first();
  return command ? { ...auth, command } : { error: { status: 409, code: 'invalid_command_lease' } };
}

export async function reportAgentCommand(request, env, storage, commandId, payload = {}, hooks = {}) {
  const auth = await authorizeAgentCommand(request, env, storage, commandId);
  if (auth.error) return auth;
  const allowed = new Set(['running', 'succeeded', 'failed']);
  const status = String(payload.status || '');
  if (!allowed.has(status)) return { error: { status: 400, code: 'invalid_status' } };
  if (status === 'running' && payload.leaseRenewal === true) {
    const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
    const renewed = await storage.db.prepare(`UPDATE deployment_commands SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running' AND lease_id = ?`).bind(leaseExpiresAt, commandId, auth.command.lease_id).run();
    return changes(renewed)
      ? { deploymentId: auth.agent.deployment_id, commandId, status, leaseExpiresAt }
      : { error: { status: 409, code: 'invalid_command_lease' } };
  }
  const repository = createDeploymentRepository(storage);
  const operation = await repository.getOperation(auth.command.operation_id);
  if (!operation) return { error: { status: 404, code: 'operation_not_found' } };
  const event = {
    at: nowIso(), status, stage: String(payload.stage || auth.command.action).slice(0, 64),
    message: String(payload.message || '').slice(-500), resources: payload.resources && typeof payload.resources === 'object' ? payload.resources : {}
  };
  if (status === 'succeeded' && typeof hooks.beforeSuccess === 'function') {
    try {
      await hooks.beforeSuccess({ auth, operation, event, payload });
    } catch (error) {
      return { error: { status: error?.status || 409, code: error?.code || 'subscription_snapshot_sync_failed' } };
    }
  }
  let hostname = safeHostname(payload.hostname || operation.hostname);
  if (!hostname) {
    const heartbeat = await storage.db.prepare('SELECT data FROM deployment_heartbeats WHERE deployment_id = ?')
      .bind(auth.agent.deployment_id).first();
    hostname = safeHostname(parseData(heartbeat?.data).hostname);
  }
  operation.events = [...(operation.events || []), event].slice(-50);
  operation.status = status; operation.updatedAt = event.at;
  if (hostname) operation.hostname = hostname;
  if (event.message) operation.message = event.message;
  if (status === 'succeeded' || status === 'failed') operation.completedAt = event.at;
  await repository.putOperation(operation);
  await storage.db.prepare(`UPDATE deployment_commands SET status = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(status, JSON.stringify({ ...parseData(auth.command.data), status, updatedAt: event.at }), commandId).run();
  const deployment = await repository.getDeployment(auth.agent.deployment_id);
  if (deployment) {
    deployment.status = status === 'running' ? 'running' : status;
    deployment.updatedAt = event.at;
    if (status === 'failed') deployment.lastError = event.message;
    if (status === 'succeeded') {
      deployment.lastError = '';
      if (auth.command.action === 'update') delete deployment.pendingReason;
      if (['apply', 'update', 'repair', 'rollback'].includes(auth.command.action)) {
        const reportedNodeCount = Number(event.resources?.nodeCount);
        if (Number.isSafeInteger(reportedNodeCount) && reportedNodeCount >= 0) deployment.nodeCount = reportedNodeCount;
      }
    }
    if (status === 'succeeded' && auth.command.action === 'uninstall') {
      deployment.status = 'offline';
      if (deployment.controlTransport !== 'local-executor') {
        await storage.db.prepare(`UPDATE deployment_agents SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE deployment_id = ?`).bind(auth.agent.deployment_id).run();
      }
    }
    if (status === 'succeeded' && auth.command.action === 'transfer-controller') {
      deployment.status = 'offline';
      deployment.agentTransferredAt = event.at;
      await storage.db.prepare(`UPDATE deployment_agents SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE deployment_id = ?`).bind(auth.agent.deployment_id).run();
    }
    if (status === 'succeeded' || status === 'failed') delete deployment.pendingOperationId;
    await repository.putDeployment(deployment);
  }
  return { deploymentId: auth.agent.deployment_id, commandId, status };
}

export async function listAgentState(storage, deploymentId) {
  if (!storage.db) return { available: false, online: false };
  const agent = await storage.db.prepare('SELECT generation, revoked_at FROM deployment_agents WHERE deployment_id = ?').bind(deploymentId).first();
  const heartbeat = await storage.db.prepare('SELECT data, last_seen_at FROM deployment_heartbeats WHERE deployment_id = ?').bind(deploymentId).first();
  return {
    available: Boolean(agent && !agent.revoked_at), online: Boolean(heartbeat && Date.parse(heartbeat.last_seen_at) >= Date.now() - onlineWindowMs(parseData(heartbeat.data))),
    lastSeenAt: heartbeat?.last_seen_at || null, heartbeat: heartbeat ? parseData(heartbeat.data) : null
  };
}

export async function cleanupAgentControl(storage, now = new Date()) {
  if (!storage?.db) return { available: false };
  const timestamp = now.toISOString();
  const commandCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const transferCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  await failExpiredRunningCommands(storage, timestamp);
  const statements = [
    storage.db.prepare(`UPDATE deployment_commands SET status = 'expired', lease_id = NULL, lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE status IN ('pending','claimed','running') AND expires_at <= ?`).bind(timestamp),
    storage.db.prepare(`UPDATE deployment_commands SET status = 'pending', lease_id = NULL, lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE status = 'claimed' AND lease_expires_at <= ? AND expires_at > ?`).bind(timestamp, timestamp),
    storage.db.prepare(`DELETE FROM deployment_commands WHERE status IN ('succeeded','failed','expired','canceled') AND updated_at < ?`).bind(commandCutoff),
    storage.db.prepare(`DELETE FROM controller_transfers WHERE updated_at < ? AND (status <> 'pending' OR expires_at <= ?)`).bind(transferCutoff, timestamp)
  ];
  if (typeof storage.db.batch === 'function') await storage.db.batch(statements);
  else for (const statement of statements) await statement.run();
  return { available: true, cleanedAt: timestamp };
}

export const agentControlConstants = { COMMAND_TTL_MS, LEASE_TTL_MS, HEARTBEAT_WRITE_MS, ONLINE_MS };

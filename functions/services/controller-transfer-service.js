import { createDeploymentRepository } from './deployment-repository.js';
import { getPlatformCapabilities } from './platform-capabilities.js';
import { rotateDeploymentAgent } from './agent-control-service.js';

const TRANSFER_TTL_MS = 30 * 60 * 1000;

function base64Url(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken() { return base64Url(crypto.getRandomValues(new Uint8Array(32))); }
function randomId() { return `transfer_${crypto.randomUUID().replace(/-/g, '')}`; }

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function bearer(request) {
  const match = String(request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export async function createControllerTransferClaim(env, storage, deploymentId) {
  const capabilities = await getPlatformCapabilities(env);
  if (!capabilities.features.remoteAgent || !storage.db) throw Object.assign(new Error('Full storage mode is required'), { status: 409, code: 'full_storage_required' });
  const deployment = await createDeploymentRepository(storage).getDeployment(deploymentId);
  if (!deployment || deployment.schemaVersion !== 2) throw Object.assign(new Error('Deployment is unavailable'), { status: 409, code: 'deployment_unavailable' });
  const token = randomToken();
  const id = randomId();
  const expiresAt = new Date(Date.now() + TRANSFER_TTL_MS).toISOString();
  await storage.db.prepare(`INSERT INTO controller_transfers
    (id, deployment_id, token_hash, status, expires_at, data, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .bind(id, deploymentId, await sha256(token), expiresAt).run();
  return { id, deploymentId, token, expiresAt };
}

export async function claimControllerTransfer(request, env, storage) {
  const capabilities = await getPlatformCapabilities(env);
  if (!capabilities.features.remoteAgent || !storage.db) return { error: { status: 409, code: 'full_storage_required' } };
  const token = bearer(request);
  if (!token) return { error: { status: 404, code: 'transfer_not_found' } };
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const transfer = await storage.db.prepare(`SELECT id, deployment_id FROM controller_transfers
    WHERE token_hash = ? AND status = 'pending' AND expires_at > ?`).bind(tokenHash, now).first();
  if (!transfer) return { error: { status: 404, code: 'transfer_not_found' } };
  const claimed = await storage.db.prepare(`UPDATE controller_transfers SET status = 'claimed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND token_hash = ? AND status = 'pending' AND expires_at > ?`).bind(transfer.id, tokenHash, now).run();
  const changes = claimed?.meta?.changes ?? claimed?.changes ?? 0;
  if (!changes) return { error: { status: 404, code: 'transfer_not_found' } };

  const agent = await rotateDeploymentAgent(storage, transfer.deployment_id);
  const repository = createDeploymentRepository(storage);
  const deployment = await repository.getDeployment(transfer.deployment_id);
  if (deployment) {
    deployment.agentReconnectRequired = false;
    deployment.controllerTransferredAt = new Date().toISOString();
    await repository.putDeployment(deployment);
  }
  await storage.db.prepare(`UPDATE controller_transfers SET status = 'completed', data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(JSON.stringify({ generation: agent.generation, completedAt: new Date().toISOString() }), transfer.id).run();
  const controllerUrl = new URL('/api/deploy/agent', request.url).toString();
  return {
    deploymentId: transfer.deployment_id,
    controllerUrl,
    token: agent.token,
    config: `agent_mode=remote\nagent_controller_url=${controllerUrl}\nagent_deployment_id=${transfer.deployment_id}\nagent_token_b64=${encodeBase64(agent.token)}\n`
  };
}

export function validateTransferTarget(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw Object.assign(new Error('Invalid target controller URL'), { status: 400 }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('Target controller must use a clean HTTPS URL'), { status: 400 });
  }
  return url.origin;
}

export const controllerTransferConstants = { TRANSFER_TTL_MS };

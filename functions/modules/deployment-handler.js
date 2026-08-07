import { StorageFactory, STORAGE_TYPES, ensureD1Schema } from '../storage-adapter.js';
import { RUNTIME_MANIFEST } from '../generated/runtime-manifest.js';
import { NODE_PROTOCOL_REGEX } from './utils/node-parser.js';
import { createErrorResponse, createJsonResponse, JSON_BODY_LIMITS, readJsonWithLimit } from './utils.js';
import { compileCoreConfig, compileNodeUrls, mergeDeploymentDefaults, normalizeDeploymentDefaults, publicDeploymentDefaults, publicV2Config, resolveBootstrapConfig, resolveV2Config } from './deployment-v2-config.js';
import { decryptDeploymentConfig, encryptDeploymentConfig } from './deployment-crypto.js';
import { buildSubscriptionNodeCacheKey } from '../services/subscription-service.js';
import { isDemoView, readDemoData } from './demo-data-handler.js';
import { hasTrafficUsage, resolveEffectiveTrafficTotal } from './traffic-quota.js';
import { createDeploymentRepository, DEPLOYMENTS_KEY, OPERATIONS_KEY } from '../services/deployment-repository.js';
import { getPlatformCapabilities } from '../services/platform-capabilities.js';
import { authorizeAgentCommand, ensureDeploymentAgent, listAgentState, pollAgent, queueAgentCommand, queueAgentConfigurationUpdate, reportAgentCommand, rotateDeploymentAgent } from '../services/agent-control-service.js';
import { claimControllerTransfer, createControllerTransferClaim, validateTransferTarget } from '../services/controller-transfer-service.js';
import { checkCloudflareEdgePermissions, cleanupManagedTunnel, ensureManagedTunnel, isManagedCloudflareResource, resolveManagedCloudflareZone } from '../services/cloudflare-edge-service.js';
import { deriveEdgeProbe, publicEdgeProbeResult } from '../services/edge-probe-service.js';
import { invalidateCaches } from '../services/node-cache-service.js';
import { DEFAULT_SETTINGS, KV_KEY_SETTINGS } from './config.js';
import { transformBuiltinSubscriptionDetailed } from './subscription/transformer-factory.js';
import { determineTargetFormat, isMetaCore } from './subscription/user-agent-utils.js';

const LEGACY_DEPLOYMENTS_KEY = 'tsub_deployments_v1';
const BOOTSTRAP_TOKEN_PREFIX = 'tsub_bootstrap_token_v2:';
const CALLBACK_TOKEN_PREFIX = 'tsub_callback_token_v2:';
const DEFAULTS_KEY = 'tsub_deployment_defaults_v2';
const TOKEN_TTL_MS = 30 * 60 * 1000;
const CALLBACK_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CALLBACK_BYTES = 256 * 1024;
const MAX_NODES = 1000;
const ACTIONS = new Set(['plan', 'apply', 'reinstall', 'status', 'list', 'update', 'restart', 'repair', 'doctor', 'rollback', 'uninstall']);
const REMOTE_ACTIONS = new Set([...ACTIONS].filter(action => action !== 'reinstall').concat('transfer-controller'));
const CONFIRMED_ACTIONS = new Set(['apply', 'reinstall', 'update', 'repair', 'restart', 'rollback', 'uninstall']);
const FINAL_STATUSES = new Set(['succeeded', 'failed']);
const TRAFFIC_BACKENDS = new Set(['nftables', 'iptables', 'core-singbox', 'core-xray', 'unavailable']);
const isRowStorage = storage => [STORAGE_TYPES.D1, STORAGE_TYPES.SQLITE, STORAGE_TYPES.POSTGRES].includes(storage.type);

export function normalizeDeploymentClientNodeUrl(value) {
  try {
    const node = new URL(String(value));
    if (!['vless:', 'tuic:'].includes(node.protocol)) return value;
    if (node.protocol === 'vless:' && !node.searchParams.has('encryption')) node.searchParams.set('encryption', 'none');
    if (node.protocol === 'tuic:') {
      node.searchParams.set('alpn', 'h3');
      if (!node.searchParams.has('congestion_control')) node.searchParams.set('congestion_control', 'bbr');
      if (!node.searchParams.has('udp_relay_mode')) node.searchParams.set('udp_relay_mode', 'native');
      if (node.searchParams.get('allow_insecure') === '1') {
        node.searchParams.set('insecure', '1');
        node.searchParams.set('allowInsecure', '1');
      }
    }
    return node.toString();
  } catch {
    return value;
  }
}

async function resolveCloudflareEdgeMetadata(config) {
  await resolveManagedCloudflareZone(config, { force: true });
  if (config.edge?.mode === 'manual' && config.edge.cloudflare?.sslMode === 'strict' && config.certificate?.mode === 'self-signed') {
    throw Object.assign(new Error('Cloudflare 严格 SSL 模式必须使用可信源站证书'), { status: 400, code: 'cloudflare_strict_certificate_required' });
  }
}

async function getStorage(env) {
  const type = await StorageFactory.getStorageType(env);
  const storage = StorageFactory.createAdapter(env, type);
  if ([STORAGE_TYPES.D1, STORAGE_TYPES.SQLITE, STORAGE_TYPES.POSTGRES].includes(storage.type) && storage.db) {
    await ensureD1Schema(storage.db);
  }
  return storage;
}

const nowIso = () => new Date().toISOString();
const randomId = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

function normalizePushHistory(...values) {
  const unique = new Set();
  for (const value of values.flat()) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) unique.add(new Date(timestamp).toISOString());
  }
  return [...unique].sort((left, right) => Date.parse(right) - Date.parse(left)).slice(0, 5);
}

function normalizePushCount(...values) {
  return Math.max(0, ...values.map(value => Number(value)).filter(Number.isSafeInteger));
}

function base64Url(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const randomToken = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function parseBearer(request) {
  const match = String(request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function readCollection(storage, key) {
  const repository = createDeploymentRepository(storage);
  if (key === DEPLOYMENTS_KEY) return repository.listDeployments();
  if (key === OPERATIONS_KEY) return repository.listOperations();
  const value = await storage.get(key);
  return Array.isArray(value) ? value : [];
}

async function writeItem(storage, key, item, limit) {
  const repository = createDeploymentRepository(storage);
  if (key === DEPLOYMENTS_KEY) return repository.putDeployment(item);
  if (key === OPERATIONS_KEY) return repository.putOperation(item);
  const all = await readCollection(storage, key);
  const index = all.findIndex(candidate => candidate.id === item.id);
  if (index >= 0) all[index] = item;
  else all.unshift(item);
  await storage.put(key, all.slice(0, limit));
}

const writeDeployment = (storage, item) => writeItem(storage, DEPLOYMENTS_KEY, item, 100);
const writeOperation = (storage, item) => writeItem(storage, OPERATIONS_KEY, item, 500);
const findDeployment = async (storage, id) => createDeploymentRepository(storage).getDeployment(id);
const findOperation = async (storage, id) => createDeploymentRepository(storage).getOperation(id);

async function readDeploymentDefaults(storage, env) {
  const envelope = await storage.get(DEFAULTS_KEY);
  if (!envelope) return normalizeDeploymentDefaults();
  return normalizeDeploymentDefaults(await decryptDeploymentConfig(envelope, env));
}

export async function handleDeploymentDefaultsRequest(request, env) {
  const storage = await getStorage(env);
  try {
    if (request.method === 'GET') return createJsonResponse({ success: true, data: publicDeploymentDefaults(await readDeploymentDefaults(storage, env)) });
    if (request.method === 'PUT') {
      let body; try { body = await request.json(); } catch { return createErrorResponse('Invalid JSON', 400); }
      const current = await readDeploymentDefaults(storage, env);
      const defaults = mergeDeploymentDefaults(current, body?.defaults || body || {});
      await storage.put(DEFAULTS_KEY, await encryptDeploymentConfig(defaults, env));
      return createJsonResponse({ success: true, data: publicDeploymentDefaults(defaults) });
    }
    if (request.method === 'DELETE') {
      await storage.delete(DEFAULTS_KEY);
      return createJsonResponse({ success: true, data: publicDeploymentDefaults(normalizeDeploymentDefaults()) });
    }
    return createErrorResponse('Method Not Allowed', 405);
  } catch (error) {
    return createErrorResponse(error.message, /DEPLOYMENT_SECRET_KEY/.test(error.message) ? 503 : 400);
  }
}

function summarizeConfig(config) {
  return {
    schemaVersion: 2,
    runtime: config.runtime,
    protocols: config.inbounds.map(item => ({ name: item.name, protocol: item.protocol, port: item.port, transport: item.transport, tls: item.tls.mode, outbound: item.outbound })),
    tunnelCount: config.tunnels.length,
    edge: { mode: config.edge?.mode || 'disabled', hasManagedResources: isManagedCloudflareResource(config) },
    firewall: config.firewall,
    selfSigned: config.certificate.mode === 'self-signed',
    subscriptionServer: {
      enabled: config.subscription.server.enabled,
      port: config.subscription.server.port,
      pushEnabled: config.subscription.server.pushEnabled,
      pushIntervalMinutes: config.subscription.server.pushIntervalMinutes,
      pushAddressMode: config.subscription.server.pushAddressMode || 'auto',
      trafficEnabled: config.subscription.server.traffic.enabled,
      quotaBytes: config.subscription.server.traffic.quotaBytes
    },
    addressMode: config.subscription.addressMode || 'auto'
  };
}

function publicDeployment(deployment) {
  if (!deployment) return deployment;
  const { encryptedConfig, pendingOperationId: _pendingOperationId, ...safe } = deployment;
  if (safe.schemaVersion !== 2) return { ...safe, migrationRequired: true, status: 'draft' };
  const requiresTuicPin = safe.configSummary?.selfSigned
    && safe.configSummary?.protocols?.some(item => item.protocol === 'tuic');
  safe.capabilities = {
    ...(safe.capabilities || {}),
    tuicCertificatePinStatus: safe.capabilities?.tuicCertificatePinStatus || (requiresTuicPin ? 'missing' : 'not-required')
  };
  return {
    ...safe,
    configRevision: Number.isSafeInteger(safe.configRevision) ? safe.configRevision : 1,
    reinstallable: isDeploymentReinstallable(safe)
  };
}

function isDeploymentReinstallable(deployment) {
  if (!deployment || deployment.schemaVersion !== 2) return false;
  if (deployment.status === 'offline' || ['reinstall', 'uninstall'].includes(deployment.pendingReason)) return true;
  return !deployment.deployedAt && ['failed', 'running'].includes(deployment.status);
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function missingSecret(value) { return value === '' || value === null || value === undefined || value === '********'; }

function sharedCredentialValue(config, key, protocols) {
  const values = (config.inbounds || [])
    .filter(item => protocols.has(item.protocol))
    .map(item => item.credentials?.[key])
    .filter(Boolean);
  return values.length && new Set(values).size === 1 ? values[0] : '';
}

function editableConfigMetadata(config) {
  return {
    sharedUuidEnabled: Boolean(sharedCredentialValue(config, 'uuid', new Set(['vless', 'vmess', 'tuic']))),
    sharedPasswordEnabled: Boolean(sharedCredentialValue(config, 'password', new Set(['trojan', 'hysteria2', 'tuic', 'anytls', 'socks5', 'naive'])))
  };
}

function editorConfigFromDefaults(defaults, requestConfig = {}) {
  return {
    sharedUuidEnabled: defaults.credentials?.sharedUuidEnabled !== false,
    sharedPasswordEnabled: defaults.credentials?.sharedPasswordEnabled !== false,
    randomPorts: cloneJson(defaults.randomPorts || { min: 10000, max: 65535 }),
    nodeNameMode: defaults.deployment?.nodeNameMode || 'deployment-protocol-port',
    runtime: {
      tier: requestConfig.runtime?.tier || defaults.runtime?.tier || 'auto',
      core: requestConfig.runtime?.core || defaults.runtime?.core || 'auto',
      channel: requestConfig.runtime?.channel || defaults.runtime?.channel || 'stable',
      version: requestConfig.runtime?.version || defaults.runtime?.version || '',
      confirmHigherTier: requestConfig.runtime?.confirmHigherTier === true || defaults.runtime?.confirmHigherTier === true,
      agentPollIntervalSeconds: requestConfig.runtime?.agentPollIntervalSeconds || defaults.runtime?.agentPollIntervalSeconds || 30
    }
  };
}

function restoreDeploymentSecrets(requestConfig, sourceConfig, preserveMachineSecrets, resetInheritedNodeNames = false) {
  const next = cloneJson(requestConfig || {});
  next.defaults ||= {};
  next.defaults.credentials ||= {};
  const sourceSharedUuid = sharedCredentialValue(sourceConfig, 'uuid', new Set(['vless', 'vmess', 'tuic']));
  const sourceSharedPassword = sharedCredentialValue(sourceConfig, 'password', new Set(['trojan', 'hysteria2', 'tuic', 'anytls', 'socks5', 'naive']));
  if (next.defaults.credentials.sharedUuidEnabled !== false && missingSecret(next.defaults.credentials.uuid) && sourceSharedUuid) next.defaults.credentials.uuid = sourceSharedUuid;
  if (next.defaults.credentials.sharedPasswordEnabled !== false && missingSecret(next.defaults.credentials.password) && sourceSharedPassword) next.defaults.credentials.password = sourceSharedPassword;
  const sourceInbounds = new Map((sourceConfig.inbounds || []).map((item, index) => [item.id || `inbound-${index + 1}`, item]));
  next.inbounds = (Array.isArray(next.inbounds) ? next.inbounds : []).map((item, index) => {
    const source = item.id ? sourceInbounds.get(item.id) : sourceConfig.inbounds?.[index];
    if (!source || source.protocol !== item.protocol) return item;
    const restored = cloneJson(item);
    if (resetInheritedNodeNames && restored.name === source.name) restored.name = '';
    restored.credentials ||= {};
    for (const key of ['uuid', 'password']) {
      if (missingSecret(restored.credentials[key]) && source.credentials?.[key]) restored.credentials[key] = source.credentials[key];
    }
    restored.tls ||= {};
    if (missingSecret(restored.tls.realityPrivateKey) && source.tls?.realityPrivateKey) restored.tls.realityPrivateKey = source.tls.realityPrivateKey;
    return restored;
  });

  next.defaults.certificate ||= {};
  if (missingSecret(next.defaults.certificate.apiToken) && sourceConfig.certificate?.apiToken) next.defaults.certificate.apiToken = sourceConfig.certificate.apiToken;
  next.defaults.warp ||= {};
  if (preserveMachineSecrets && missingSecret(next.defaults.warp.privateKey) && sourceConfig.warp?.privateKey) next.defaults.warp.privateKey = sourceConfig.warp.privateKey;
  if (!preserveMachineSecrets) {
    delete next.defaults.warp.privateKey;
    delete next.defaults.warp.peerPublicKey;
    delete next.defaults.warp.ipv4;
    delete next.defaults.warp.ipv6;
    next.warp ||= {};
    delete next.warp.privateKey;
    delete next.warp.peerPublicKey;
    delete next.warp.ipv4;
    delete next.warp.ipv6;
  }
  next.edge ||= {};
  next.edge.cloudflare ||= {};
  if (missingSecret(next.edge.cloudflare.apiToken) && sourceConfig.edge?.cloudflare?.apiToken) next.edge.cloudflare.apiToken = sourceConfig.edge.cloudflare.apiToken;
  if (preserveMachineSecrets) {
    next.edge.managed ||= {};
    for (const key of ['tunnelId', 'dnsRecordId', 'zoneId', 'previousDnsZoneId', 'previousDnsRecordId', 'tunnelToken']) {
      if (missingSecret(next.edge.managed[key]) && sourceConfig.edge?.managed?.[key]) next.edge.managed[key] = sourceConfig.edge.managed[key];
    }
    if (sourceConfig.edge?.managed?.managedByTsub) next.edge.managed.managedByTsub = true;
  } else {
    next.edge.hostname = '';
    delete next.edge.managed;
    next.defaults.tunnel = {};
    delete next.tunnels;
  }
  if (preserveMachineSecrets) {
    next.defaults.tunnel ||= {};
    const sourceTunnel = sourceConfig.tunnels?.[0];
    if (missingSecret(next.defaults.tunnel.token) && sourceTunnel?.token) next.defaults.tunnel.token = sourceTunnel.token;
    next.tunnels = (Array.isArray(next.tunnels) ? next.tunnels : []).map((item, index) => {
      const source = sourceConfig.tunnels?.[index];
      if (!source || source.type !== item?.type) return item;
      const restored = cloneJson(item);
      if (missingSecret(restored.token) && source.token) restored.token = source.token;
      return restored;
    });
  }

  next.subscription ||= {};
  next.subscription.server ||= {};
  const sourceServer = sourceConfig.subscription?.server || {};
  if (missingSecret(next.subscription.server.token) && sourceServer.token) next.subscription.server.token = sourceServer.token;
  if (preserveMachineSecrets) {
    if (sourceServer.pushToken) next.subscription.server.pushToken = sourceServer.pushToken;
    if (sourceServer.pushGeneration) next.subscription.server.pushGeneration = sourceServer.pushGeneration;
    next.subscription.server.traffic ||= {};
    if (sourceServer.traffic?.apiPort) next.subscription.server.traffic.apiPort = sourceServer.traffic.apiPort;
    if (sourceServer.traffic?.apiSecret) next.subscription.server.traffic.apiSecret = sourceServer.traffic.apiSecret;
  } else {
    delete next.subscription.server.pushToken;
    delete next.subscription.server.pushGeneration;
    if (next.subscription.server.traffic) {
      delete next.subscription.server.traffic.apiPort;
      delete next.subscription.server.traffic.apiSecret;
    }
  }
  return next;
}

async function prepareDeploymentUpdate(storage, deployment, body, env, pendingOperationId = '', action = 'update') {
  if (action === 'reinstall' && !isDeploymentReinstallable(deployment)) throw Object.assign(new Error('Deployment cannot be reinstalled in its current state'), { status: 409 });
  if (action !== 'reinstall' && deployment.status === 'offline') throw Object.assign(new Error('Deployment template is unavailable'), { status: 409 });
  const currentRevision = Number.isSafeInteger(deployment.configRevision) ? deployment.configRevision : 1;
  if (Number(body.configRevision) !== currentRevision) {
    throw Object.assign(new Error('Deployment configuration changed; reload it before updating'), { status: 409, code: 'REVISION_CONFLICT' });
  }
  const nextDeployment = cloneJson(deployment);
  const nextName = String(body.name || deployment.name).trim().slice(0, 120) || deployment.name;
  const sourceConfig = await decryptDeploymentConfig(deployment.encryptedConfig, env);
  const systemDefaults = await readDeploymentDefaults(storage, env);
  const restoredConfig = restoreDeploymentSecrets(body.config, sourceConfig, true);
  const configDefaults = mergeDeploymentDefaults(systemDefaults, restoredConfig.defaults || {});
  const config = resolveV2Config(restoredConfig, systemDefaults, { deploymentName: nextName });
  await resolveCloudflareEdgeMetadata(config);
  validateRuntimeAssets(config, env);
  nextDeployment.name = nextName;
  nextDeployment.nodeGroup = String(body.nodeGroup ?? deployment.nodeGroup ?? '').trim().slice(0, 120);
  nextDeployment.profileId = String(body.profileId ?? deployment.profileId ?? '').trim().slice(0, 160);
  nextDeployment.encryptedConfig = await encryptDeploymentConfig(config, env);
  nextDeployment.configSummary = summarizeConfig(publicV2Config(config));
  nextDeployment.editorConfig = editorConfigFromDefaults(configDefaults, restoredConfig);
  nextDeployment.configRevision = currentRevision + 1;
  nextDeployment.status = 'pending';
  nextDeployment.pendingReason = action === 'reinstall' ? 'reinstall' : 'config';
  if (pendingOperationId) nextDeployment.pendingOperationId = pendingOperationId;
  else delete nextDeployment.pendingOperationId;
  nextDeployment.updatedAt = nowIso();
  nextDeployment.configUpdatedAt = nextDeployment.updatedAt;
  return { currentRevision, nextDeployment };
}

async function supersedeDeploymentOperations(storage, deploymentId) {
  const timestamp = nowIso();
  const operations = await createDeploymentRepository(storage).listOperations(deploymentId);
  const superseded = operations.filter(operation =>
    ['apply', 'reinstall', 'uninstall'].includes(operation.action)
    && !FINAL_STATUSES.has(operation.status)
  );
  for (const operation of superseded) {
    const event = { at: timestamp, status: 'failed', stage: 'superseded', message: 'Operation superseded by reinstall', resources: {} };
    operation.status = 'failed';
    operation.message = event.message;
    operation.updatedAt = timestamp;
    operation.completedAt = timestamp;
    operation.events = [...(operation.events || []), event].slice(-50);
    await Promise.all([
      writeOperation(storage, operation),
      ...(operation.bootstrapTokenHash ? [storage.delete(`${BOOTSTRAP_TOKEN_PREFIX}${operation.bootstrapTokenHash}`)] : []),
      ...(operation.callbackTokenHash ? [storage.delete(`${CALLBACK_TOKEN_PREFIX}${operation.callbackTokenHash}`)] : [])
    ]);
  }
}

function operationConfirmation(action, deploymentName) {
  if (!CONFIRMED_ACTIONS.has(action)) return '';
  const actionLabel = { apply: '安装节点', reinstall: '重新安装', update: '更新配置', repair: '修复部署', restart: '重启服务', rollback: '回滚部署', uninstall: '卸载部署' }[action];
  const prompt = `即将在服务器执行“${actionLabel}”：${deploymentName}。输入 Y 确认：`;
  return `printf %s ${shellQuote(prompt)}; TSUB_CONFIRM=''; IFS= read -r TSUB_CONFIRM || true; case "$TSUB_CONFIRM" in y|Y) ;; *) printf '%s\\n' '操作已取消。'; exit 0 ;; esac; `;
}

function publicOperation(operation) {
  if (!operation) return operation;
  const { bootstrapTokenHash, callbackTokenHash, ...safe } = operation;
  if (!FINAL_STATUSES.has(safe.status) && Date.parse(safe.expiresAt) <= Date.now()) safe.status = 'expired';
  return safe;
}

function extractNodeName(url, fallback) {
  const fragment = String(url).split('#').slice(1).join('#');
  if (!fragment) return fallback;
  try { return decodeURIComponent(fragment.replace(/\+/g, ' ')).slice(0, 160); } catch { return fragment.slice(0, 160); }
}

function normalizeCallbackNodes(lines) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const lineValue of lines) {
    const line = String(lineValue || '').trim();
    if (!line) continue;
    if (!NODE_PROTOCOL_REGEX.test(line)) { rejected.push({ value: line.slice(0, 100), reason: 'unsupported_protocol' }); continue; }
    if (line.length > 8192) { rejected.push({ value: line.slice(0, 100), reason: 'node_too_long' }); continue; }
    if (!seen.has(line)) { seen.add(line); accepted.push(line); }
    if (accepted.length >= MAX_NODES) break;
  }
  return { accepted, rejected };
}

function validTuicCertificatePin(value) {
  try {
    const node = new URL(String(value));
    if (node.protocol !== 'tuic:') return false;
    const certificatePin = node.searchParams.get('pcs') || '';
    const spkiPin = node.searchParams.get('spki') || '';
    if (!/^[0-9a-f]{64}$/i.test(certificatePin) || !/^[A-Za-z0-9+/]{43}=$/.test(spkiPin)) return false;
    return atob(spkiPin).length === 32;
  } catch {
    return false;
  }
}

function isTuicNode(value) {
  return /^tuic:\/\//i.test(String(value || '').trim());
}

function tuicCertificatePinStatus(config, nodeUrls) {
  const requiresPin = config.certificate?.mode === 'self-signed'
    && config.inbounds?.some(item => item.protocol === 'tuic' && item.tls?.mode === 'tls');
  if (!requiresPin) return 'not-required';
  const tuicNodes = nodeUrls.filter(isTuicNode);
  return tuicNodes.length > 0 && tuicNodes.every(validTuicCertificatePin) ? 'ready' : 'missing';
}

async function replaceDeploymentNodes(storage, deployment, nodeUrls) {
  const current = typeof storage.getAllSubscriptions === 'function' ? await storage.getAllSubscriptions() : await readCollection(storage, 'tsub_subscriptions_v1');
  const existing = current.filter(item => item?.source?.kind === 'tsub-deployment' && item.source.deploymentId === deployment.id);
  const existingByUrl = new Map(existing.map(item => [item.url, item]));
  const others = current.filter(item => !(item?.source?.kind === 'tsub-deployment' && item.source.deploymentId === deployment.id));
  const timestamp = nowIso();
  const nodes = [];
  for (let index = 0; index < nodeUrls.length; index++) {
    const url = nodeUrls[index];
    const previous = existingByUrl.get(url);
    const protocol = url.match(/^([a-z0-9+]+):\/\//i)?.[1]?.toLowerCase() || 'node';
    nodes.push({
      ...(previous || {}), id: previous?.id || `tsub_${deployment.id}_${(await sha256(url)).slice(0, 16)}`,
      name: extractNodeName(url, `${deployment.name}-${protocol}-${index + 1}`), url, enabled: true,
      group: deployment.nodeGroup || deployment.name, tags: ['tsub', 'tsub-proxy-v2'], remarks: `TSub Proxy deployment: ${deployment.name}`,
      sortIndex: others.length + index, createdAt: previous?.createdAt || timestamp, updatedAt: timestamp,
      source: { kind: 'tsub-deployment', deploymentId: deployment.id, schemaVersion: 2 }
    });
  }
  if (isRowStorage(storage) && storage.putSubscription && storage.deleteSubscriptionById) {
    const nextIds = new Set(nodes.map(item => item.id));
    await Promise.all(existing.filter(item => !nextIds.has(item.id)).map(item => storage.deleteSubscriptionById(item.id)));
    await Promise.all(nodes.map(item => storage.putSubscription(item)));
  } else await storage.put('tsub_subscriptions_v1', [...others, ...nodes]);
  if (deployment.profileId) {
    const profiles = typeof storage.getAllProfiles === 'function' ? await storage.getAllProfiles() : await readCollection(storage, 'tsub_profiles_v1');
    const profile = profiles.find(item => item.id === deployment.profileId || item.customId === deployment.profileId);
    if (profile) {
      const oldIds = new Set(existing.map(item => item.id));
      profile.manualNodes = [...(Array.isArray(profile.manualNodes) ? profile.manualNodes.filter(id => !oldIds.has(id)) : []), ...nodes.map(item => item.id)];
      profile.updatedAt = timestamp;
      if (isRowStorage(storage) && storage.putProfile) await storage.putProfile(profile);
      else await storage.put('tsub_profiles_v1', profiles);
    }
  }
  return nodes;
}

function isDeploymentSource(item, deploymentId) {
  return item?.source?.deploymentId === deploymentId
    && ['tsub-deployment', 'tsub-deployment-subscription', 'tsub-deployment-push', 'tsub-deployment-snapshot'].includes(item.source.kind);
}

async function updateDeploymentProfile(storage, deployment, airportId, manualIds = []) {
  if (!deployment.profileId) return;
  const profiles = typeof storage.getAllProfiles === 'function' ? await storage.getAllProfiles() : await readCollection(storage, 'tsub_profiles_v1');
  const profile = profiles.find(item => item.id === deployment.profileId || item.customId === deployment.profileId);
  if (!profile) return;
  const manualSet = new Set(manualIds);
  profile.manualNodes = (Array.isArray(profile.manualNodes) ? profile.manualNodes : []).filter(id => !manualSet.has(id));
  const subscriptions = Array.isArray(profile.subscriptions) ? profile.subscriptions : [];
  if (!subscriptions.some(item => (typeof item === 'object' ? item?.id : item) === airportId)) subscriptions.push(airportId);
  profile.subscriptions = subscriptions;
  profile.updatedAt = nowIso();
  if (isRowStorage(storage) && storage.putProfile) await storage.putProfile(profile);
  else await storage.put('tsub_profiles_v1', profiles);
}

function profileReferencesSubscription(profile, subscriptionId) {
  return Array.isArray(profile?.subscriptions) && profile.subscriptions.some(item =>
    (typeof item === 'object' ? item?.id : item) === subscriptionId
  );
}

async function invalidateDeploymentOutputCaches(storage, deployment, subscriptionId) {
  try {
    const profiles = typeof storage.getAllProfiles === 'function'
      ? await storage.getAllProfiles()
      : await readCollection(storage, 'tsub_profiles_v1');
    const identifiers = new Set();
    for (const profile of profiles) {
      const matchesDeployment = profile?.id === deployment.profileId || profile?.customId === deployment.profileId;
      if (!matchesDeployment && !profileReferencesSubscription(profile, subscriptionId)) continue;
      if (profile.id) identifiers.add(profile.id);
      if (profile.customId) identifiers.add(profile.customId);
    }
    if (deployment.profileId) identifiers.add(deployment.profileId);
    const settings = await storage.get(KV_KEY_SETTINGS) || {};
    const configuredMainToken = settings?.mytoken ?? DEFAULT_SETTINGS.mytoken;
    const mainToken = typeof configuredMainToken === 'string' && configuredMainToken ? configuredMainToken : null;
    await invalidateCaches(storage, [...identifiers], mainToken);
  } catch (error) {
    console.warn('[DeploymentPush] Failed to invalidate subscription output caches:', error?.message || error);
  }
}

async function upsertDeploymentSubscription(storage, deployment, config, nodeCount, cachedNodeUrls = [], origin = '', reenable = true, persist = true) {
  const current = typeof storage.getAllSubscriptions === 'function' ? await storage.getAllSubscriptions() : await readCollection(storage, 'tsub_subscriptions_v1');
  const airportId = `tsub_airport_${deployment.id}`;
  const previous = current.find(item => item.id === airportId);
  const manualNodes = current.filter(item => item?.source?.kind === 'tsub-deployment' && item.source.deploymentId === deployment.id);
  const timestamp = nowIso();
  for (const item of manualNodes) {
    item.enabled = false;
    item.updatedAt = timestamp;
    item.lastError = 'Deployment switched to server subscription';
  }
  const host = deployment.resolvedHostname || config.subscription.hostname;
  const detected = deployment.resolvedAddresses || config.subscription.resolvedAddresses || {};
  const formatHttpHost = value => String(value || '').includes(':') && !String(value || '').startsWith('[') ? `[${value}]` : value;
  const server = config.subscription.server;
  const pushEnabled = server.pushEnabled !== false;
  const sourceKind = pushEnabled ? 'tsub-deployment-push' : 'tsub-deployment-snapshot';
  const sourceMode = pushEnabled ? 'push' : 'snapshot';
  const mirrorUrl = origin ? new URL(`/api/deploy/subscriptions/${deployment.id}/${server.token}`, origin).toString() : previous?.url;
  const airport = {
    ...(previous || {}),
    id: airportId,
    name: deployment.name,
    url: mirrorUrl,
    localUrl: `http://${formatHttpHost(host)}:${server.port}/cgi-bin/${server.token}`,
    localUrls: [...new Set([detected.ipv4, detected.ipv6].filter(Boolean).map(address => `http://${formatHttpHost(address)}:${server.port}/cgi-bin/${server.token}`))],
    serverAddress: host,
    subscriptionPort: server.port,
    enabled: reenable ? true : previous?.enabled !== false,
    enableNodeCache: true,
    nodeCount: Number.isInteger(nodeCount) ? nodeCount : (previous?.nodeCount || 0),
    group: deployment.nodeGroup || deployment.name,
    tags: ['tsub', 'tsub-proxy-v2', pushEnabled ? 'push-source' : 'install-snapshot'],
    remarks: pushEnabled ? `TSub Proxy active push source: ${deployment.name}` : `TSub Proxy installation snapshot: ${deployment.name}`,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
    lastError: null,
    pushIntervalMinutes: server.pushIntervalMinutes || 15,
    pushCount: normalizePushCount(previous?.pushCount, deployment.pushCount),
    pushHistory: normalizePushHistory(previous?.pushHistory || [], deployment.pushHistory || [], previous?.lastPushAt),
    source: { kind: sourceKind, deploymentId: deployment.id, schemaVersion: 2, mode: sourceMode }
  };
  if (!persist) return airport;
  if (isRowStorage(storage) && storage.putSubscription) {
    await Promise.all([...manualNodes.map(item => storage.putSubscription(item)), storage.putSubscription(airport)]);
  } else {
    const replaceIds = new Set([airportId, ...manualNodes.map(item => item.id)]);
    await storage.put('tsub_subscriptions_v1', [...current.filter(item => !replaceIds.has(item.id)), ...manualNodes, airport]);
  }
  if (cachedNodeUrls.length) {
    const cacheKey = buildSubscriptionNodeCacheKey(airport);
    const previousCache = await storage.get(cacheKey);
    await storage.put(cacheKey, {
      ...(previousCache || {}), nodes: cachedNodeUrls, nodeCount: cachedNodeUrls.length, updatedAt: timestamp,
      source: pushEnabled && previousCache?.pushGeneration ? previousCache.source : (pushEnabled ? 'tsub-deployment-callback' : sourceKind)
    });
  }
  await updateDeploymentProfile(storage, deployment, airportId, manualNodes.map(item => item.id));
  return airport;
}

async function disableDeploymentNodes(storage, deploymentId) {
  const current = typeof storage.getAllSubscriptions === 'function' ? await storage.getAllSubscriptions() : await readCollection(storage, 'tsub_subscriptions_v1');
  const changed = current.filter(item => isDeploymentSource(item, deploymentId));
  for (const item of changed) { item.enabled = false; item.updatedAt = nowIso(); item.lastError = 'Deployment uninstalled'; }
  if (isRowStorage(storage) && storage.putSubscription) await Promise.all(changed.map(item => storage.putSubscription(item)));
  else if (changed.length) await storage.put('tsub_subscriptions_v1', current);
  return changed.length;
}

async function deleteDeploymentSubscriptionSource(storage, deploymentId, deployment = null) {
  const sourceId = `tsub_airport_${deploymentId}`;
  const current = typeof storage.getAllSubscriptions === 'function' ? await storage.getAllSubscriptions() : await readCollection(storage, 'tsub_subscriptions_v1');
  const source = current.find(item => item.id === sourceId);
  if (source) {
    if (typeof storage.deleteSubscriptionById === 'function') await storage.deleteSubscriptionById(sourceId);
    else await storage.put('tsub_subscriptions_v1', current.filter(item => item.id !== sourceId));
    if (!deployment) await storage.delete(buildSubscriptionNodeCacheKey(source));
  }
  const profiles = typeof storage.getAllProfiles === 'function' ? await storage.getAllProfiles() : await readCollection(storage, 'tsub_profiles_v1');
  const changedProfiles = profiles.filter(profile => Array.isArray(profile.subscriptions) && profile.subscriptions.some(item => (typeof item === 'object' ? item?.id : item) === sourceId));
  for (const profile of changedProfiles) {
    profile.subscriptions = profile.subscriptions.filter(item => (typeof item === 'object' ? item?.id : item) !== sourceId);
    profile.updatedAt = nowIso();
  }
  if (isRowStorage(storage) && storage.putProfile) await Promise.all(changedProfiles.map(profile => storage.putProfile(profile)));
  else if (changedProfiles.length) await storage.put('tsub_profiles_v1', profiles);
  if (deployment) {
    deployment.subscriptionSourceDisabled = true;
    deployment.subscriptionId = null;
    deployment.updatedAt = nowIso();
    await writeDeployment(storage, deployment);
  }
  return Boolean(source);
}

function stableAssetDescriptor(core, env, latest = false) {
  if (core === 'wgcf') return {
    version: '2.2.22',
    assets: {
      amd64: { url: 'https://github.com/ViRb3/wgcf/releases/download/v2.2.22/wgcf_2.2.22_linux_amd64', sha256: '268d187e649870b603ad2e5c1b74a696251f6c2f6f075c726a174a0039b0b1e2', format: 'binary' },
      arm64: { url: 'https://github.com/ViRb3/wgcf/releases/download/v2.2.22/wgcf_2.2.22_linux_arm64', sha256: 'e5ff08d3aae5374935211053b2d64d96daaa3f1aec8e9a1dab7418125585a011', format: 'binary' }
    }
  };
  const prefix = core === 'sing-box' ? 'SINGBOX' : core.toUpperCase();
  const channelPrefix = latest ? 'LATEST_' : '';
  const version = env?.[`TSUB_${prefix}_${channelPrefix}VERSION`] || '';
  const assets = {};
  for (const arch of ['AMD64', 'ARM64']) {
    const assetPrefix = `TSUB_${prefix}_${channelPrefix}${arch}`;
    assets[arch.toLowerCase()] = {
      url: env?.[`${assetPrefix}_URL`] || '', sha256: env?.[`${assetPrefix}_SHA256`] || '',
      format: env?.[`${assetPrefix}_FORMAT`] || 'binary', binarySha256: env?.[`${assetPrefix}_BINARY_SHA256`] || ''
    };
  }
  return { version, assets };
}

function resolveAssetDescriptor(core, runtime, env) {
  if (runtime?.channel === 'pinned' && core === runtime.core) {
    let manifest;
    try { manifest = JSON.parse(env?.TSUB_PINNED_CORE_MANIFEST || '{}'); } catch { throw new Error('TSUB_PINNED_CORE_MANIFEST 不是有效 JSON'); }
    const descriptor = manifest?.[core]?.[runtime.version];
    if (!descriptor) throw new Error(`Pinned 清单不包含 ${core} ${runtime.version}`);
    return { version: runtime.version, assets: descriptor };
  }
  return stableAssetDescriptor(core, env, runtime?.channel === 'latest' && core === runtime.core);
}

function coreAssetLines(core, runtime, env) {
  const descriptor = resolveAssetDescriptor(core, runtime, env);
  if (!descriptor.version) throw new Error(`${core} 缺少版本环境变量`);
  const lines = [];
  for (const arch of ['AMD64', 'ARM64']) {
    const asset = descriptor.assets?.[arch.toLowerCase()] || {};
    const url = String(asset.url || ''); const hash = String(asset.sha256 || '');
    const format = String(asset.format || 'binary');
    const binaryHash = String(asset.binarySha256 || (format === 'binary' ? hash : ''));
    if (!/^https:\/\//.test(url) || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`${core}/${arch.toLowerCase()} 资产 URL 或 SHA-256 无效`);
    if (!['binary', 'tar.gz'].includes(format) || !/^[0-9a-f]{64}$/i.test(binaryHash)) throw new Error(`${core}/${arch.toLowerCase()} 资产格式或二进制 SHA-256 无效`);
    lines.push(
      `${core}_${arch.toLowerCase()}_url=${url}`, `${core}_${arch.toLowerCase()}_sha256=${hash}`,
      `${core}_${arch.toLowerCase()}_format=${format}`, `${core}_${arch.toLowerCase()}_binary_sha256=${binaryHash}`
    );
  }
  return { version: descriptor.version, lines };
}

export function compileBootstrapConfig(config, callbackToken, callbackUrl, deploymentId, env, agentToken = '', agentMode = agentToken ? 'remote' : 'none', controllerBase = callbackUrl, configRevision = 0) {
  const core = config.runtime.core;
  const compiledCoreConfig = compileCoreConfig(config);
  const coreConfig = typeof compiledCoreConfig === 'string' ? compiledCoreConfig : JSON.stringify(compiledCoreConfig);
  const nodes = compileNodeUrls(config).join('\n');
  const tier = config.runtime.tier === 'auto' ? '' : config.runtime.tier;
  const tunnelLines = config.tunnels.flatMap((tunnel, index) => {
    const target = config.inbounds.find(item => item.id === config.edge?.quickInboundId)
      || config.inbounds.find(item => ['ws', 'xhttp'].includes(item.transport)) || config.inbounds[0];
    return [
      `tunnel_${index + 1}_type=${tunnel.type}`, `tunnel_${index + 1}_hostname=${tunnel.hostname}`,
      `tunnel_${index + 1}_token_b64=${base64Utf8(tunnel.token)}`, `tunnel_${index + 1}_target_port=${target.port}`,
      `tunnel_${index + 1}_target_scheme=${target.tls.mode === 'tls' ? 'https' : 'http'}`
    ];
  });
  const certificateDomain = config.inbounds.find(item => item.tls.mode === 'tls')?.tls?.serverName || '';
  const mainAsset = coreAssetLines(core, config.runtime, env);
  const tunnelAsset = config.tunnels.length ? coreAssetLines('cloudflared', { channel: 'stable', core: 'cloudflared' }, env) : null;
  const automaticWarp = config.warp.provisioning === 'auto' && config.inbounds.some(item => item.outbound.startsWith('warp'));
  const wgcfAsset = automaticWarp ? coreAssetLines('wgcf', { channel: 'stable', core: 'wgcf' }, env) : null;
  const legoAsset = !['existing', 'self-signed'].includes(config.certificate.mode) && certificateDomain ? coreAssetLines('lego', { channel: 'stable', core: 'lego' }, env) : null;
  const busyboxAsset = config.subscription.server.enabled ? coreAssetLines('busybox', { channel: 'stable', core: 'busybox' }, env) : null;
  const realityAutoIds = config.inbounds.filter(item => item.tls.mode === 'reality' && item.tls.autoGenerate).map(item => String(item.id).replace(/[^A-Za-z0-9_]/g, '_')).join(',');
  const udpHopRules = config.inbounds.filter(item => item.protocol === 'hysteria2' && item.transportOptions.udpHopPorts).map(item => `${item.port}:${item.transportOptions.udpHopPorts.replace(/,/g, '+')}`).join(' ');
  const inboundSummary = config.inbounds.map(item => {
    const network = ['hysteria2', 'tuic'].includes(item.protocol) || (item.transport === 'xhttp' && item.transportOptions.xhttpVersion === 'h3') ? 'UDP' : 'TCP';
    const protocol = item.protocol === 'hysteria2' ? 'Hysteria2' : item.protocol === 'shadowsocks' ? 'Shadowsocks 2022' : item.protocol.toUpperCase();
    return `${protocol} ${item.port}/${network} - ${item.transport}`;
  }).join('\n');
  const nodeUrls = compileNodeUrls(config);
  const nodeDetails = nodeUrls.map((url, index) => {
    const scheme = String(url).match(/^([a-z0-9+.-]+):\/\//i)?.[1] || 'node';
    const protocol = scheme === 'hysteria2' ? 'Hysteria2' : scheme === 'ss' ? 'Shadowsocks 2022' : scheme === 'vless' ? 'VLESS' : scheme === 'vmess' ? 'VMess' : scheme === 'tuic' ? 'TUIC' : scheme.toUpperCase();
    const fragment = String(url).split('#').slice(1).join('#');
    let nodeName = `Node ${index + 1}`;
    if (fragment) try { nodeName = decodeURIComponent(fragment); } catch { nodeName = fragment; }
    if (scheme === 'vmess') {
      try { nodeName = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(url.slice('vmess://'.length)), character => character.charCodeAt(0)))).ps || nodeName; } catch { /* keep fallback */ }
    }
    return `${nodeName}（${protocol}）\n${url}`;
  }).join('\n\n');
  const detected = config.subscription.resolvedAddresses || {};
  const pushMode = config.subscription.server.pushAddressMode || 'auto';
  const pushRawAddress = pushMode === 'ipv6' ? detected.ipv6 : pushMode === 'ipv4' ? detected.ipv4 : (detected.ipv4 || detected.ipv6);
  const pushServerAddress = pushRawAddress || config.subscription.hostname.replace(/^\[|\]$/g, '');
  const subscriptionMirrorUrl = config.subscription.server.enabled
    ? new URL(`/api/deploy/subscriptions/${deploymentId}/${config.subscription.server.token}`, controllerBase).toString()
    : '';
  return [
    'schema_version=2', `config_revision=${Number.isSafeInteger(Number(configRevision)) ? Number(configRevision) : 0}`, `runtime_tier=${tier}`, `runtime_tier_mode=${config.runtime.tier}`, `runtime_confirm_higher_tier=${config.runtime.confirmHigherTier}`, `runtime_core=${core}`, `runtime_channel=${config.runtime.channel}`,
    `control_command=${config.runtime.controlCommand || 'tsub'}`,
    `${core}_version=${mainAsset.version}`,
    `inbound_count=${config.inbounds.length}`, `tunnel_count=${config.tunnels.length}`,
    `inbound_ports=${config.inbounds.map(item => `${item.port}/${['hysteria2', 'tuic'].includes(item.protocol) || (item.transport === 'xhttp' && item.transportOptions.xhttpVersion === 'h3') ? 'udp' : 'tcp'}`).join(',')}`,
    `udp_hop_rules=${udpHopRules}`,
    `firewall_enabled=${config.firewall.enabled}`, `warp_backend=${config.inbounds.some(item => item.outbound.startsWith('warp')) ? 'userspace' : 'none'}`,
    `warp_provisioning=${config.warp.provisioning}`, `warp_terms_accepted=${config.warp.acceptedTerms}`, `edge_mode=${config.edge?.mode || 'disabled'}`,
    `certificate_mode=${config.certificate.mode}`, `certificate_email=${config.certificate.email}`, `certificate_domain=${certificateDomain}`, `certificate_api_token_b64=${base64Utf8(config.certificate.apiToken)}`, `reality_auto_ids=${realityAutoIds}`,
    `subscription_server_enabled=${config.subscription.server.enabled}`, `subscription_server_port=${config.subscription.server.port || ''}`,
    `subscription_server_token_b64=${base64Utf8(config.subscription.server.token)}`, `subscription_hostname=${config.subscription.hostname}`,
    `subscription_address_mode=${config.subscription.addressMode || 'auto'}`, `push_address_mode=${config.subscription.server.pushAddressMode || 'auto'}`,
    `subscription_ipv4=${detected.ipv4 || ''}`, `subscription_ipv6=${detected.ipv6 || ''}`,
    `push_server_address=${pushServerAddress}`,
    `inbound_summary_b64=${base64Utf8(inboundSummary)}`, `subscription_mirror_url_b64=${base64Utf8(subscriptionMirrorUrl)}`,
    `push_enabled=${config.subscription.server.pushEnabled}`, `push_interval_minutes=${config.subscription.server.pushIntervalMinutes}`,
    `subscription_traffic_enabled=${config.subscription.server.traffic.enabled}`, `subscription_traffic_quota_bytes=${config.subscription.server.traffic.quotaBytes}`,
    `subscription_traffic_checkpoint_minutes=${config.subscription.server.traffic.checkpointMinutes}`,
    `traffic_core_api_port=${config.subscription.server.traffic.apiPort || ''}`,
    `traffic_core_api_secret_b64=${base64Utf8(config.subscription.server.traffic.apiSecret || '')}`,
    `deployment_id=${deploymentId}`, `push_url=${config.subscription.server.pushEnabled ? new URL(`/api/deploy/push/${deploymentId}`, controllerBase).toString() : ''}`,
    `quick_tunnel_callback_url=${config.edge?.mode === 'quick' ? new URL('/api/deploy/edge/quick', controllerBase).toString() : ''}`,
    `agent_mode=${agentMode}`, `agent_controller_url=${new URL('/api/deploy/agent', controllerBase).toString()}`, `agent_deployment_id=${deploymentId}`,
    `agent_poll_interval_seconds=${config.runtime.agentPollIntervalSeconds || 30}`,
    `agent_token_b64=${agentToken ? base64Utf8(agentToken) : ''}`,
    `push_token_b64=${base64Utf8(config.subscription.server.pushToken)}`, `push_generation=${config.subscription.server.pushGeneration}`,
    `${core}_config_b64=${base64Utf8(coreConfig)}`, `nodes_b64=${base64Utf8(nodes)}`, `node_details_b64=${base64Utf8(nodeDetails)}`,
    `callback_url=${callbackUrl}`, `callback_token_b64=${base64Utf8(callbackToken)}`, 'health_wait=60',
    ...mainAsset.lines, ...(tunnelAsset ? [`cloudflared_version=${tunnelAsset.version}`, ...tunnelAsset.lines] : []), ...(wgcfAsset ? [`wgcf_version=${wgcfAsset.version}`, ...wgcfAsset.lines] : []), ...(legoAsset ? [`lego_version=${legoAsset.version}`, ...legoAsset.lines] : []),
    ...(busyboxAsset ? [`busybox_version=${busyboxAsset.version}`, ...busyboxAsset.lines] : []), ...tunnelLines
  ].join('\n');
}

function validateRuntimeAssets(config, env) {
  coreAssetLines(config.runtime.core, config.runtime, env);
  if (config.tunnels.length || ['quick', 'managed'].includes(config.edge?.mode)) coreAssetLines('cloudflared', { channel: 'stable', core: 'cloudflared' }, env);
  if (config.warp.provisioning === 'auto' && config.inbounds.some(item => item.outbound.startsWith('warp'))) coreAssetLines('wgcf', { channel: 'stable', core: 'wgcf' }, env);
  if (!['existing', 'self-signed'].includes(config.certificate.mode) && config.inbounds.some(item => item.tls.mode === 'tls')) coreAssetLines('lego', { channel: 'stable', core: 'lego' }, env);
  if (config.subscription.server.enabled) coreAssetLines('busybox', { channel: 'stable', core: 'busybox' }, env);
}

export function buildBootstrapScript(operation, config, callbackToken, origin, env = {}, agentToken = '', configRevision = 0) {
  const runtimeUrl = new URL(RUNTIME_MANIFEST.path, origin);
  runtimeUrl.searchParams.set('v', RUNTIME_MANIFEST.sha256);
  const callbackUrl = new URL('/api/deploy/events', origin).toString();
  const compiled = compileBootstrapConfig(config, callbackToken, callbackUrl, operation.deploymentId, env, agentToken, agentToken ? 'remote' : 'none', callbackUrl, configRevision);
  return `#!/bin/sh
set -eu
umask 077
BOOTSTRAP_OS=unknown
BOOTSTRAP_VERSION=unknown
BOOTSTRAP_PRETTY=unknown
if [ -r /etc/os-release ]; then
  while IFS='=' read -r BOOTSTRAP_KEY BOOTSTRAP_VALUE; do
    BOOTSTRAP_FIRST=\${BOOTSTRAP_VALUE%"\${BOOTSTRAP_VALUE#?}"}
    if [ "$BOOTSTRAP_FIRST" = '"' ]; then BOOTSTRAP_VALUE=\${BOOTSTRAP_VALUE#?}; BOOTSTRAP_VALUE=\${BOOTSTRAP_VALUE%?}; fi
    case "$BOOTSTRAP_KEY" in ID) BOOTSTRAP_OS=$BOOTSTRAP_VALUE ;; VERSION_ID) BOOTSTRAP_VERSION=$BOOTSTRAP_VALUE ;; PRETTY_NAME) BOOTSTRAP_PRETTY=$BOOTSTRAP_VALUE ;; esac
  done </etc/os-release
fi
[ "$BOOTSTRAP_PRETTY" != unknown ] || BOOTSTRAP_PRETTY=$BOOTSTRAP_OS
printf 'TSub Proxy 系统预检：%s（ID=%s，版本=%s）\\n' "$BOOTSTRAP_PRETTY" "$BOOTSTRAP_OS" "$BOOTSTRAP_VERSION"
printf 'TSub Proxy CPU 架构：%s\\n' "$(uname -m 2>/dev/null || printf unknown)"
TMP_DIR=$(mktemp -d "\${TMPDIR:-/tmp}/tsub-bootstrap.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
RUNTIME="$TMP_DIR/tsub-proxy.sh"
CONFIG="$TMP_DIR/bootstrap.conf"
download() { if command -v curl >/dev/null 2>&1; then curl -fL --retry 2 -o "$RUNTIME" ${shellQuote(runtimeUrl.toString())}; elif command -v wget >/dev/null 2>&1; then wget -O "$RUNTIME" ${shellQuote(runtimeUrl.toString())}; else return 127; fi; }
hash_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'; else return 127; fi; }
download || { echo 'TSub Proxy 下载失败' >&2; exit 1; }
[ "$(hash_file "$RUNTIME")" = ${shellQuote(RUNTIME_MANIFEST.sha256)} ] || { echo 'TSub Proxy SHA-256 校验失败' >&2; exit 1; }
cat >"$CONFIG" <<'TSUB_CONFIG_EOF'
${compiled}
TSUB_CONFIG_EOF
chmod 600 "$CONFIG" "$RUNTIME"
TSUB_CONFIG="$CONFIG" /bin/sh "$RUNTIME" ${shellQuote(operation.action === 'reinstall' ? 'apply' : operation.action)}
`;
}

async function authenticateToken(request, env, kind, tokenOverride = '') {
  const token = tokenOverride || parseBearer(request);
  if (!token) return { error: createErrorResponse('Missing bearer token', 401) };
  const storage = await getStorage(env);
  const tokenHash = await sha256(token);
  const prefix = kind === 'bootstrap' ? BOOTSTRAP_TOKEN_PREFIX : CALLBACK_TOKEN_PREFIX;
  const record = await storage.get(`${prefix}${tokenHash}`);
  if (!record) return { error: createErrorResponse('Invalid operation token', 401) };
  const operation = await findOperation(storage, record.operationId);
  const expected = kind === 'bootstrap' ? operation?.bootstrapTokenHash : operation?.callbackTokenHash;
  if (!operation || expected !== tokenHash) return { error: createErrorResponse('Invalid operation token', 401) };
  if (Date.parse(operation.expiresAt) <= Date.now()) {
    operation.status = 'expired'; operation.updatedAt = nowIso(); await writeOperation(storage, operation);
    return { error: createErrorResponse('Operation token expired', 410) };
  }
  if (FINAL_STATUSES.has(operation.status)) return { error: createErrorResponse('Operation already completed', 409) };
  const deployment = await findDeployment(storage, operation.deploymentId);
  if (!deployment) return { error: createErrorResponse('Deployment not found', 404) };
  return { storage, token, tokenHash, tokenRecord: record, operation, deployment };
}

async function refreshOperationState(auth) {
  const [operation, deployment] = await Promise.all([
    findOperation(auth.storage, auth.operation.id),
    findDeployment(auth.storage, auth.deployment.id)
  ]);
  if (!operation || FINAL_STATUSES.has(operation.status)) return { error: createErrorResponse('Operation already completed', 409) };
  if (!deployment) return { error: createErrorResponse('Deployment not found', 404) };
  const deploymentRevision = Number.isSafeInteger(deployment.configRevision) ? deployment.configRevision : 1;
  if (Number.isSafeInteger(operation.configRevision) && operation.configRevision !== deploymentRevision) {
    return { error: createErrorResponse('Operation superseded by a newer configuration', 409) };
  }
  auth.operation = operation;
  auth.deployment = deployment;
  return auth;
}

function deployRunHeaders(contentType = 'text/plain; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  };
}

function buildDeployRunScript(request) {
  const origin = new URL(request.url).origin;
  const prepareUrl = new URL('/api/deploy/prepare', origin).toString();
  return `#!/bin/sh
set -eu
umask 077
TSUB_TOKEN=\${1-}
[ -n "$TSUB_TOKEN" ] || { printf '%s\\n' '缺少一次性部署 Token。' >&2; exit 2; }
shift || true
TSUB_PREPARE=$(mktemp) || exit 1
chmod 600 "$TSUB_PREPARE"
trap 'rm -f "$TSUB_PREPARE"' EXIT HUP INT TERM
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -H "Authorization: Bearer $TSUB_TOKEN" -o "$TSUB_PREPARE" ${shellQuote(prepareUrl)}
elif command -v wget >/dev/null 2>&1; then
  wget -O "$TSUB_PREPARE" --header="Authorization: Bearer $TSUB_TOKEN" ${shellQuote(prepareUrl)}
else
  printf '%s\\n' '需要预先安装 curl 或 wget。' >&2
  exit 1
fi
export TSUB_TOKEN
/bin/sh "$TSUB_PREPARE"
`;
}

function buildDeployPrepareScript(request, operation, deployment) {
  const origin = new URL(request.url).origin;
  const bootstrapUrl = new URL('/api/deploy/bootstrap', origin).toString();
  const probeUrl = new URL(`/api/deploy/address/${operation.id}`, origin).toString();
  const actionLabel = {
    apply: '安装节点', reinstall: '重新安装', update: '更新配置', repair: '修复部署', restart: '重启服务',
    rollback: '回滚部署', uninstall: '卸载部署', plan: '预检部署', status: '查看状态',
    list: '显示节点', doctor: '诊断部署'
  }[operation.action] || operation.action;
  const confirmation = CONFIRMED_ACTIONS.has(operation.action) ? `
printf '%s' ${shellQuote(`即将在服务器执行“${actionLabel}”：${deployment.name}。输入 Y 确认：`)}
TSUB_CONFIRM=''
if [ -r /dev/tty ]; then IFS= read -r TSUB_CONFIRM </dev/tty || true; fi
case "$TSUB_CONFIRM" in
  y|Y) ;;
  *) printf '%s\\n' '操作已取消。'; exit 0 ;;
esac
` : '';
  return `#!/bin/sh
set -u
umask 077
: "\${TSUB_TOKEN:?缺少一次性部署 Token。}"
${confirmation}TSUB_BOOTSTRAP=$(mktemp) || exit 1
chmod 600 "$TSUB_BOOTSTRAP"
trap 'rm -f "$TSUB_BOOTSTRAP"' EXIT HUP INT TERM
TSUB_BOOTSTRAP_URL=${shellQuote(bootstrapUrl)}
TSUB_PROBE_URL=${shellQuote(probeUrl)}
if command -v curl >/dev/null 2>&1; then
  curl -4 -fsS -X POST -H "Authorization: Bearer $TSUB_TOKEN" "$TSUB_PROBE_URL" >/dev/null 2>&1 || true
  curl -6 -fsS -X POST -H "Authorization: Bearer $TSUB_TOKEN" "$TSUB_PROBE_URL" >/dev/null 2>&1 || true
  TSUB_ATTEMPT=0
  until curl -fsSL -H "Authorization: Bearer $TSUB_TOKEN" -o "$TSUB_BOOTSTRAP" "$TSUB_BOOTSTRAP_URL"; do
    TSUB_ATTEMPT=$((TSUB_ATTEMPT + 1)); [ "$TSUB_ATTEMPT" -lt 12 ] || exit 1; sleep 5
  done
elif command -v wget >/dev/null 2>&1; then
  wget -qO- -4 --header="Authorization: Bearer $TSUB_TOKEN" --post-data='' "$TSUB_PROBE_URL" >/dev/null 2>&1 || true
  wget -qO- -6 --header="Authorization: Bearer $TSUB_TOKEN" --post-data='' "$TSUB_PROBE_URL" >/dev/null 2>&1 || true
  TSUB_ATTEMPT=0
  until wget -O "$TSUB_BOOTSTRAP" --header="Authorization: Bearer $TSUB_TOKEN" "$TSUB_BOOTSTRAP_URL"; do
    TSUB_ATTEMPT=$((TSUB_ATTEMPT + 1)); [ "$TSUB_ATTEMPT" -lt 12 ] || exit 1; sleep 5
  done
else
  printf '%s\\n' '需要预先安装 curl 或 wget。' >&2
  exit 1
fi
/bin/sh "$TSUB_BOOTSTRAP"
`;
}

export async function handleDeployRunScript(request) {
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: deployRunHeaders() });
  return new Response(buildDeployRunScript(request), { status: 200, headers: deployRunHeaders('text/x-shellscript; charset=utf-8') });
}

export async function handleDeployPrepare(request, env) {
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: deployRunHeaders() });
  const auth = await authenticateToken(request, env, 'bootstrap');
  if (auth.error) return new Response('Not Found', { status: 404, headers: deployRunHeaders() });
  const script = buildDeployPrepareScript(request, auth.operation, auth.deployment);
  return new Response(script, { status: 200, headers: deployRunHeaders('text/x-shellscript; charset=utf-8') });
}

export async function handleDeployBootstrap(request, env) {
  if (request.method !== 'GET') return createErrorResponse('Method Not Allowed', 405);
  const auth = await authenticateToken(request, env, 'bootstrap');
  if (auth.error) return auth.error;
  let config; let finalizeManagedResources = null;
  try {
    config = await decryptDeploymentConfig(auth.deployment.encryptedConfig, env);
    if (config.edge?.mode === 'managed') {
      const provisioned = await ensureManagedTunnel(config, auth.deployment);
      config = provisioned.config;
      finalizeManagedResources = provisioned.finalize || null;
      if (provisioned.changed) {
        auth.deployment.encryptedConfig = await encryptDeploymentConfig(config, env);
        auth.deployment.configSummary = summarizeConfig(publicV2Config(config));
        await writeDeployment(auth.storage, auth.deployment);
      }
    }
    if (config.edge?.mode === 'quick') {
      config.edge.hostname = '';
      if (config.tunnels?.[0]?.type === 'quick') config.tunnels[0].hostname = '';
    }
    const cloudflareAddress = request.cf && typeof request.cf === 'object' ? request.headers.get('CF-Connecting-IP') || '' : '';
    config = resolveBootstrapConfig(config, cloudflareAddress, auth.operation.resolvedAddresses || {});
    const detected = config.subscription.resolvedAddresses || {};
    const pushMode = config.subscription.server.pushAddressMode || 'auto';
    const pushAddress = pushMode === 'ipv6' ? detected.ipv6 : pushMode === 'ipv4' ? detected.ipv4 : (detected.ipv4 || detected.ipv6);
    const detectedAutomatically = Boolean(detected.ipv4 || detected.ipv6);
    if (config.subscription.server.pushEnabled && detectedAutomatically && pushMode !== 'auto' && !pushAddress) throw new Error(`未检测到主动推送所需的 ${pushMode === 'ipv6' ? 'IPv6' : 'IPv4'} 地址`);
    config.subscription.server.pushServerAddress = pushAddress || config.subscription.hostname.replace(/^\[|\]$/g, '');
  }
  catch (error) { return createErrorResponse(error.message || 'Unable to resolve deployment configuration', /公网地址|未检测到|IPv4\+IPv6/.test(error.message || '') ? 400 : 500); }
  const currentAuth = await refreshOperationState(auth);
  if (currentAuth.error) return currentAuth.error;
  auth.operation.status = 'running'; auth.operation.bootstrapAt = nowIso();
  auth.operation.expiresAt = new Date(Date.now() + CALLBACK_TTL_MS).toISOString(); auth.operation.updatedAt = auth.operation.bootstrapAt;
  auth.deployment.status = 'running'; auth.deployment.updatedAt = auth.operation.updatedAt;
  auth.deployment.resolvedHostname = config.subscription.hostname;
  auth.deployment.resolvedAddresses = config.subscription.resolvedAddresses || {};
  auth.deployment.pushServerAddress = config.subscription.server.pushServerAddress || '';
  await Promise.all([
    writeOperation(auth.storage, auth.operation), writeDeployment(auth.storage, auth.deployment),
    auth.storage.delete(`${BOOTSTRAP_TOKEN_PREFIX}${auth.tokenHash}`)
  ]);
  if (finalizeManagedResources) await finalizeManagedResources().catch(() => {});
  const script = buildBootstrapScript(auth.operation, config, auth.tokenRecord.callbackToken, request.url, env, auth.tokenRecord.agentToken || '', auth.deployment.configRevision || 1);
  return new Response(script, { headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function handleCloudflareEdgePermissionCheck(request) {
  if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
  try {
    const body = await readJsonWithLimit(request, JSON_BODY_LIMITS.small);
    const result = await checkCloudflareEdgePermissions(body);
    return createJsonResponse({ success: true, data: result }, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    return createJsonResponse({ success: false, error: error.code || 'cloudflare_edge_check_failed' }, error.status || 502, { 'Cache-Control': 'no-store' });
  }
}

export async function handleDeployQuickTunnelCallback(request, env) {
  if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
  const bearer = parseBearer(request);
  let body;
  try { body = await readJsonWithLimit(request, JSON_BODY_LIMITS.small); } catch (error) { return createErrorResponse(error.message || 'Invalid JSON', error.status || 400); }
  const deploymentId = String(body?.deploymentId || '').trim();
  const hostname = String(body?.hostname || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(hostname)) return createErrorResponse('Invalid Quick Tunnel hostname', 400);
  const storage = await getStorage(env);
  const deployment = await findDeployment(storage, deploymentId);
  if (!deployment || !bearer) return createErrorResponse('Unauthorized', 401);
  try {
    const config = await decryptDeploymentConfig(deployment.encryptedConfig, env);
    if (config.edge?.mode !== 'quick' || !config.subscription?.server?.pushEnabled || await sha256(bearer) !== await sha256(config.subscription.server.pushToken)) {
      return createErrorResponse('Unauthorized', 401);
    }
    if (config.edge.hostname !== hostname) {
      config.edge.hostname = hostname;
      if (config.tunnels?.[0]?.type === 'quick') config.tunnels[0].hostname = hostname;
      deployment.encryptedConfig = await encryptDeploymentConfig(config, env);
      deployment.configSummary = summarizeConfig(publicV2Config(config));
      deployment.edgeHostname = hostname;
    }
    const nodes = compileNodeUrls(config, { edgeHostname: hostname });
    deployment.nodeCount = (await replaceDeploymentNodes(storage, deployment, nodes)).length;
    deployment.updatedAt = nowIso();
    await writeDeployment(storage, deployment);
    if (String(request.headers.get('Accept') || '').includes('text/plain')) {
      return new Response(`${nodes.join('\n')}\n`, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return createJsonResponse({ success: true, data: { hostname, nodes } }, 200, { 'Cache-Control': 'no-store' });
  } catch {
    return createErrorResponse('Quick Tunnel update failed', 503);
  }
}

export async function handleDeployAddressProbe(request, env, operationId) {
  if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
  const auth = await authenticateToken(request, env, 'bootstrap');
  if (auth.error) return auth.error;
  if (auth.operation.id !== operationId) return createErrorResponse('Operation mismatch', 409);
  const address = request.cf && typeof request.cf === 'object' ? String(request.headers.get('CF-Connecting-IP') || '').trim() : '';
  const family = address.includes(':') ? 'ipv6' : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) ? 'ipv4' : '';
  if (!family) return createErrorResponse('Trusted public address unavailable', 400);
  auth.operation.resolvedAddresses = { ...(auth.operation.resolvedAddresses || {}), [family]: address };
  auth.operation.updatedAt = nowIso();
  await writeOperation(auth.storage, auth.operation);
  return createJsonResponse({ success: true, data: { family } }, 200, { 'Cache-Control': 'no-store' });
}

function parseEventPayload(text) {
  const payload = { nodes: [], cacheNodes: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split < 1) continue;
    const key = line.slice(0, split); const value = line.slice(split + 1);
    if (key === 'node') payload.nodes.push(value);
    else if (key === 'cacheNode') payload.cacheNodes.push(value);
    else if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) payload[key] = value;
  }
  return payload;
}

function normalizeTrafficBackend(value) {
  const backend = String(value || 'unavailable');
  return TRAFFIC_BACKENDS.has(backend) ? backend : null;
}

function nonnegativeMetric(value) {
  const metric = Number(value);
  return Number.isFinite(metric) ? Math.max(0, metric) : 0;
}

function swapLimitMetric(value) {
  return Number(value) === -1 ? -1 : nonnegativeMetric(value);
}

function clearRecoveredPushDegradation(value) {
  return String(value || '')
    .split(';')
    .map(item => item.trim())
    .filter(item => item && item !== '首次主动推送失败')
    .join('; ');
}

export async function handleDeployEvents(request, env) {
  if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_CALLBACK_BYTES) return createErrorResponse('Callback payload too large', 413);
  const auth = await authenticateToken(request, env, 'callback');
  if (auth.error) return auth.error;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_CALLBACK_BYTES) return createErrorResponse('Callback payload too large', 413);
  const payload = parseEventPayload(text);
  const status = String(payload.status || '');
  if (!['running', 'succeeded', 'failed'].includes(status)) return createErrorResponse('Invalid event status', 400);
  const currentAuth = await refreshOperationState(auth);
  if (currentAuth.error) return currentAuth.error;
  const trafficBackend = normalizeTrafficBackend(payload.trafficBackend);
  if (!trafficBackend) return createErrorResponse('Invalid traffic backend', 400);
  const nodes = normalizeCallbackNodes(payload.nodes);
  const cacheNodes = normalizeCallbackNodes(payload.cacheNodes);
  const timestamp = nowIso();
  const event = {
    at: timestamp, status, stage: String(payload.stage || '').slice(0, 64), message: String(payload.message || '').slice(-500),
    resources: {
      tier: String(payload.resourceTier || ''), container: String(payload.container || ''), init: String(payload.init || ''),
      tun: payload.tun === 'true', firewall: payload.firewall === 'true', memoryMb: Number(payload.memoryMb || payload.cgroupLimitMb || 0),
      cgroupLimitMb: Number(payload.cgroupLimitMb || payload.memoryMb || 0),
      memoryAvailableMb: Number(payload.memoryAvailableMb || 0), diskKb: Number(payload.diskKb || 0), pidLimit: String(payload.pidLimit || ''), rssMb: Number(payload.rssMb || 0),
      swapReported: payload.swapReported === 'true', swapTotalMb: nonnegativeMetric(payload.swapTotalMb),
      swapFreeMb: nonnegativeMetric(payload.swapFreeMb), swapUsedMb: nonnegativeMetric(payload.swapUsedMb),
      cgroupSwapReported: payload.cgroupSwapReported === 'true', cgroupSwapCurrentMb: nonnegativeMetric(payload.cgroupSwapCurrentMb),
      cgroupSwapLimitMb: swapLimitMetric(payload.cgroupSwapLimitMb),
      coreRssMb: Number(payload.coreRssMb || 0), cloudflaredRssMb: Number(payload.cloudflaredRssMb || 0),
      estimatedCoreRssMb: Number(payload.estimatedCoreRssMb || 0), estimatedCloudflaredRssMb: Number(payload.estimatedCloudflaredRssMb || 0),
      coreVersion: String(payload.coreVersion || '').slice(0, 120), ipv6: payload.ipv6 === 'true',
      trafficBackend, degradedReason: String(payload.degradedReason || '').slice(0, 300),
      controlCommand: /^[a-z][a-z0-9_-]{0,39}$/.test(String(payload.controlCommand || '')) ? String(payload.controlCommand) : ''
    }
  };
  const existingEvents = Array.isArray(auth.operation.events) ? auth.operation.events : [];
  const previousEvent = existingEvents.at(-1);
  const duplicateEvent = previousEvent && previousEvent.status === event.status && previousEvent.stage === event.stage
    && previousEvent.message === event.message && JSON.stringify(previousEvent.resources) === JSON.stringify(event.resources);
  auth.operation.events = duplicateEvent ? existingEvents : [...existingEvents, event].slice(-50);
  auth.operation.status = status; auth.operation.hostname = String(payload.hostname || '').slice(0, 160);
  auth.operation.message = event.message; auth.operation.updatedAt = timestamp;
  const previousTuicPinStatus = auth.deployment.capabilities?.tuicCertificatePinStatus;
  auth.deployment.status = status;
  auth.deployment.capabilities = {
    ...event.resources,
    ...(previousTuicPinStatus ? { tuicCertificatePinStatus: previousTuicPinStatus } : {})
  };
  auth.deployment.updatedAt = timestamp;
  if (status === 'succeeded') {
    if (['update', 'reinstall'].includes(auth.operation.action)) delete auth.deployment.pendingReason;
    if (['apply', 'reinstall'].includes(auth.operation.action)) {
      auth.deployment.deployedAt = timestamp;
      auth.deployment.configUpdatedAt = timestamp;
    }
    if (auth.operation.action === 'uninstall') {
      await disableDeploymentNodes(auth.storage, auth.deployment.id);
      auth.deployment.status = 'offline';
      auth.deployment.subscriptionSourceDisabled = true;
      delete auth.deployment.pendingReason;
    } else if (payload.subscriptionReady === 'true') {
      const config = await decryptDeploymentConfig(auth.deployment.encryptedConfig, env);
      const subscriptionNodeCount = Math.max(0, Math.min(MAX_NODES, Number(payload.subscriptionNodeCount || 0) || 0));
      if (!config.subscription?.server?.enabled) return createErrorResponse('Unexpected subscription event', 400);
      const airport = await upsertDeploymentSubscription(auth.storage, auth.deployment, config, subscriptionNodeCount, cacheNodes.accepted, request.url, true);
      auth.deployment.subscriptionSourceDisabled = false;
      auth.deployment.subscriptionId = airport.id;
      auth.deployment.nodeCount = airport.nodeCount;
      auth.deployment.lastSyncAt = timestamp;
      auth.deployment.capabilities.tuicCertificatePinStatus = tuicCertificatePinStatus(config, cacheNodes.accepted);
    } else if (nodes.accepted.length) {
      const config = await decryptDeploymentConfig(auth.deployment.encryptedConfig, env);
      auth.deployment.nodeCount = (await replaceDeploymentNodes(auth.storage, auth.deployment, nodes.accepted)).length;
      auth.deployment.lastSyncAt = timestamp;
      auth.deployment.capabilities.tuicCertificatePinStatus = tuicCertificatePinStatus(config, nodes.accepted);
    }
  }
  if (status === 'failed') {
    auth.deployment.lastError = event.message;
    if (auth.operation.action === 'reinstall') {
      auth.deployment.status = 'offline';
      auth.deployment.pendingReason = 'reinstall';
    }
  }
  if (FINAL_STATUSES.has(status)) {
    auth.operation.completedAt = timestamp;
    auth.operation.nodeCount = payload.subscriptionReady === 'true' ? auth.deployment.nodeCount : nodes.accepted.length;
    auth.operation.rejectedCount = nodes.rejected.length + cacheNodes.rejected.length;
  }
  await Promise.all([writeOperation(auth.storage, auth.operation), writeDeployment(auth.storage, auth.deployment)]);
  if (FINAL_STATUSES.has(status)) await auth.storage.delete(`${CALLBACK_TOKEN_PREFIX}${auth.tokenHash}`);
  return createJsonResponse({ success: true, data: {
    accepted: nodes.accepted.length,
    rejected: nodes.rejected.length,
    cacheAccepted: cacheNodes.accepted.length,
    cacheRejected: cacheNodes.rejected.length,
    final: FINAL_STATUSES.has(status)
  } });
}

// Compatibility export for integrations upgrading from V1. The V1 route now uses V2 event semantics.
export const handleDeployCallback = handleDeployEvents;

function safeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null;
}

async function commitPushRows(storage, cacheKey, cacheData, source, deployment, generation, sequence, snapshotHash) {
  const condition = `EXISTS (SELECT 1 FROM deployment_snapshots WHERE deployment_id = ? AND push_generation = ? AND sequence = ? AND snapshot_hash = ?)`;
  const conditionValues = [deployment.id, generation, sequence, snapshotHash];
  const statements = [storage.db.prepare(`INSERT INTO deployment_snapshots
    (deployment_id, push_generation, sequence, snapshot_hash, data, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(deployment_id) DO UPDATE SET push_generation = excluded.push_generation,
    sequence = excluded.sequence, snapshot_hash = excluded.snapshot_hash, data = excluded.data, updated_at = CURRENT_TIMESTAMP
    WHERE deployment_snapshots.push_generation <> excluded.push_generation OR deployment_snapshots.sequence < excluded.sequence`)
    .bind(deployment.id, generation, sequence, snapshotHash, JSON.stringify(cacheData)),
  storage.db.prepare(`INSERT INTO settings (key, value, updated_at)
    SELECT ?, ?, CURRENT_TIMESTAMP WHERE ${condition}
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP WHERE ${condition}`)
    .bind(cacheKey, JSON.stringify(cacheData), ...conditionValues, ...conditionValues),
  storage.db.prepare(`INSERT INTO subscriptions (id, data, created_at, updated_at)
    SELECT ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP WHERE ${condition}
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP WHERE ${condition}`)
    .bind(source.id, JSON.stringify(source), ...conditionValues, ...conditionValues),
  storage.db.prepare(`UPDATE deployments SET data = ?, status = ?, config_revision = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND ${condition}`).bind(JSON.stringify(deployment), deployment.status || '', deployment.configRevision || 1, deployment.id, ...conditionValues)];
  if (typeof storage.db.batch !== 'function') throw new Error('Transactional batch support is required for row-level push storage');
  await storage.db.batch(statements);
  const current = await storage.db.prepare('SELECT push_generation, sequence, snapshot_hash FROM deployment_snapshots WHERE deployment_id = ?').bind(deployment.id).first();
  if (current?.push_generation === generation && Number(current.sequence) === sequence && current.snapshot_hash === snapshotHash) return { accepted: true };
  if (current?.push_generation === generation && Number(current.sequence) === sequence) return { conflict: true };
  return { stale: true };
}

async function updateStoredSubscription(storage, item) {
  if (isRowStorage(storage) && storage.putSubscription) await storage.putSubscription(item);
  else {
    const all = await readCollection(storage, 'tsub_subscriptions_v1');
    const index = all.findIndex(candidate => candidate.id === item.id);
    if (index >= 0) all[index] = item; else all.push(item);
    await storage.put('tsub_subscriptions_v1', all);
  }
}

export async function handleDeployPush(request, env, deploymentId) {
  if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_CALLBACK_BYTES) return createErrorResponse('Push payload too large', 413);
  const storage = await getStorage(env);
  const deployment = await findDeployment(storage, deploymentId);
  if (!deployment) return createErrorResponse('Deployment not found', 404);
  if (deployment.status === 'offline') return createErrorResponse('Deployment is offline', 409);
  let config;
  try { config = await decryptDeploymentConfig(deployment.encryptedConfig, env); }
  catch (error) { return createErrorResponse(error.message, 503); }
  const server = config.subscription?.server;
  const bearer = parseBearer(request);
  if (!server?.enabled || server.pushEnabled === false || !bearer || await sha256(bearer) !== await sha256(server.pushToken)) return createErrorResponse('Unauthorized', 401);
  const textBody = await request.text();
  if (new TextEncoder().encode(textBody).byteLength > MAX_CALLBACK_BYTES) return createErrorResponse('Push payload too large', 413);
  const payload = parseEventPayload(textBody);
  if (deployment.subscriptionSourceDisabled === true && payload.event !== 'uninstall') return createJsonResponse({ success: true, data: { ignored: true, reason: 'subscription-source-disabled' } });
  if (payload.pushGeneration !== server.pushGeneration) return createErrorResponse('Push generation mismatch', 409);
  if (payload.event === 'uninstall') {
    await disableDeploymentNodes(storage, deployment.id);
    deployment.status = 'offline';
    deployment.subscriptionSourceDisabled = true;
    deployment.lastError = '';
    deployment.updatedAt = nowIso();
    await writeDeployment(storage, deployment);
    return createJsonResponse({ success: true, data: { offline: true } });
  }
  const sequence = safeInteger(payload.sequence);
  const upload = safeInteger(payload.upload);
  const download = safeInteger(payload.download);
  const trafficBackend = normalizeTrafficBackend(payload.trafficBackend);
  if (sequence === null || sequence < 1 || upload === null || download === null || !trafficBackend) return createErrorResponse('Invalid push counters', 400);
  const expectedServerAddress = String(deployment.pushServerAddress || deployment.resolvedHostname || config.subscription.hostname || '').replace(/^\[|\]$/g, '').trim();
  const serverAddress = String(payload.serverAddress || expectedServerAddress).replace(/^\[|\]$/g, '').trim();
  const subscriptionPort = payload.subscriptionPort === undefined ? server.port : safeInteger(payload.subscriptionPort);
  const detectedPushAddresses = [deployment.resolvedAddresses?.ipv4, deployment.resolvedAddresses?.ipv6].filter(Boolean);
  const allowedPushAddresses = server.pushAddressMode === 'auto' && detectedPushAddresses.length
    ? new Set(detectedPushAddresses)
    : new Set([expectedServerAddress]);
  if (!serverAddress || !allowedPushAddresses.has(serverAddress)) return createErrorResponse('Push server address mismatch', 409);
  if (subscriptionPort !== server.port) return createErrorResponse('Push subscription port mismatch', 409);
  if (payload.subscriptionReady !== undefined && payload.subscriptionReady !== 'true') return createErrorResponse('Push subscription is not ready', 409);
  const nodes = normalizeCallbackNodes(payload.nodes);
  const snapshotHash = await sha256(textBody);
  const airportId = `tsub_airport_${deployment.id}`;
  const current = typeof storage.getAllSubscriptions === 'function' ? await storage.getAllSubscriptions() : await readCollection(storage, 'tsub_subscriptions_v1');
  let source = current.find(item => item.id === airportId);
  const previousCache = source ? await storage.get(buildSubscriptionNodeCacheKey(source)) : null;
  if (previousCache?.pushGeneration === server.pushGeneration) {
    if (sequence < Number(previousCache.sequence || 0)) {
      return createJsonResponse({
        success: false,
        error: 'Stale push sequence',
        code: 'STALE_PUSH_SEQUENCE',
        data: { expectedSequence: Number(previousCache.sequence || 0) + 1 }
      }, 409, { 'Cache-Control': 'no-store' });
    }
    if (sequence === Number(previousCache.sequence || 0)) {
      if (previousCache.snapshotHash !== snapshotHash) return createErrorResponse('Push sequence conflict', 409);
      await invalidateDeploymentOutputCaches(storage, deployment, airportId);
      return createJsonResponse({ success: true, data: { duplicate: true, accepted: previousCache.nodeCount || 0 } });
    }
  }
  if (!source) source = await upsertDeploymentSubscription(storage, deployment, config, nodes.accepted.length, [], request.url, false, !isRowStorage(storage));
  const timestamp = nowIso();
  const userInfo = server.traffic.enabled ? { upload, download, total: server.traffic.quotaBytes, expire: 0 } : null;
  const legacySequenceBaseline = previousCache?.pushGeneration === server.pushGeneration ? Number(previousCache.sequence || 0) : 0;
  const pushCount = normalizePushCount(source.pushCount, deployment.pushCount, legacySequenceBaseline) + 1;
  const pushHistory = normalizePushHistory(timestamp, source.pushHistory || [], deployment.pushHistory || [], source.lastPushAt);
  const cacheKey = buildSubscriptionNodeCacheKey(source);
  const cacheData = {
    nodes: nodes.accepted, nodeCount: nodes.accepted.length, updatedAt: timestamp, source: 'tsub-deployment-push',
    pushGeneration: server.pushGeneration, sequence, snapshotHash, userInfo, trafficBackend
  };
  source.nodeCount = nodes.accepted.length;
  source.userInfo = userInfo;
  source.lastPushAt = timestamp;
  source.lastUpdate = timestamp;
  source.lastError = nodes.rejected.length ? `${nodes.rejected.length} 个节点被拒绝` : null;
  source.pushDegradedReason = String(payload.degradedReason || '').slice(0, 300);
  source.trafficBackend = trafficBackend;
  source.serverAddress = serverAddress;
  source.subscriptionPort = server.port;
  source.subscriptionReady = true;
  const localAddress = serverAddress.includes(':') && !serverAddress.startsWith('[') ? `[${serverAddress}]` : serverAddress;
  source.localUrl = `http://${localAddress}:${server.port}/cgi-bin/${server.token}`;
  const detectedAddresses = deployment.resolvedAddresses || {};
  source.localUrls = [...new Set([detectedAddresses.ipv4, detectedAddresses.ipv6].filter(Boolean).map(address => `http://${address.includes(':') ? `[${address}]` : address}:${server.port}/cgi-bin/${server.token}`))];
  source.pushCount = pushCount;
  source.pushHistory = pushHistory;
  deployment.nodeCount = nodes.accepted.length;
  deployment.lastSyncAt = timestamp;
  deployment.resolvedHostname = serverAddress;
  deployment.pushServerAddress = serverAddress;
  deployment.pushCount = pushCount;
  deployment.pushHistory = pushHistory;
  deployment.capabilities = {
    ...(deployment.capabilities || {}),
    trafficBackend,
    serverAddress,
    subscriptionPort: server.port,
    subscriptionReady: true,
    tuicCertificatePinStatus: tuicCertificatePinStatus(config, nodes.accepted),
    degradedReason: clearRecoveredPushDegradation(deployment.capabilities?.degradedReason)
  };
  deployment.updatedAt = timestamp;
  if (isRowStorage(storage) && storage.db) {
    const claim = await commitPushRows(storage, cacheKey, cacheData, source, deployment, server.pushGeneration, sequence, snapshotHash);
    if (claim.conflict) return createErrorResponse('Push sequence conflict', 409);
    if (claim.stale) return createErrorResponse('Stale push sequence', 409);
    await updateDeploymentProfile(storage, deployment, source.id);
  } else {
    await storage.put(cacheKey, cacheData);
    await updateStoredSubscription(storage, source);
    await writeDeployment(storage, deployment);
  }
  await invalidateDeploymentOutputCaches(storage, deployment, source.id);
  return createJsonResponse({ success: true, data: { accepted: nodes.accepted.length, rejected: nodes.rejected.length, sequence } });
}

export async function handleDeploySubscription(request, env, deploymentId, subscriptionToken) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return createErrorResponse('Method Not Allowed', 405);
  const storage = await getStorage(env);
  const deployment = await findDeployment(storage, deploymentId);
  if (!deployment || deployment.status === 'offline') return createErrorResponse('Not Found', 404);
  let config;
  try { config = await decryptDeploymentConfig(deployment.encryptedConfig, env); }
  catch { return createErrorResponse('Service unavailable', 503); }
  const server = config.subscription?.server;
  if (!server?.enabled || await sha256(subscriptionToken) !== await sha256(server.token)) return createErrorResponse('Not Found', 404);
  const all = typeof storage.getAllSubscriptions === 'function' ? await storage.getAllSubscriptions() : await readCollection(storage, 'tsub_subscriptions_v1');
  const source = all.find(item => item.id === `tsub_airport_${deployment.id}`);
  if (!source || source.enabled === false) return createErrorResponse('Not Found', 404);
  let cached = await storage.get(buildSubscriptionNodeCacheKey(source));
  if (isRowStorage(storage) && storage.db) {
    const snapshot = await storage.db.prepare('SELECT data FROM deployment_snapshots WHERE deployment_id = ?').bind(deployment.id).first();
    if (snapshot?.data) { try { cached = JSON.parse(snapshot.data); } catch {} }
  }
  if (!cached || !Array.isArray(cached.nodes)) return createErrorResponse('Subscription snapshot unavailable', 503);
  const requestUrl = new URL(request.url);
  const userAgent = request.headers.get('User-Agent') || '';
  const explicitTarget = String(requestUrl.searchParams.get('target') || '').toLowerCase();
  const hasFormatFlag = ['clash', 'singbox', 'surge', 'loon', 'base64', 'v2ray', 'trojan', 'quanx', 'egern', 'nodes'].some(key => requestUrl.searchParams.has(key));
  const knownClient = /shadowrocket|v2rayn|v2rayng|loon|clash|mihomo|sing-?box|surge|quantumult|egern/i.test(userAgent);
  let targetFormat = explicitTarget || ((knownClient || hasFormatFlag) ? determineTargetFormat(userAgent, requestUrl.searchParams) : 'nodes');
  if (['shadowrocket', 'v2ray', 'v2rayn', 'v2rayng'].includes(targetFormat)) targetFormat = 'base64';
  if (['raw', 'plain'].includes(targetFormat)) targetFormat = 'nodes';
  const pinStatus = tuicCertificatePinStatus(config, cached.nodes);
  const filteredTuicCount = pinStatus === 'missing' ? cached.nodes.filter(isTuicNode).length : 0;
  const sourceNodes = pinStatus === 'missing' ? cached.nodes.filter(node => !isTuicNode(node)) : cached.nodes;
  const rawNodeList = `${sourceNodes.join('\n')}${sourceNodes.length ? '\n' : ''}`;
  const conversionNodeList = `${sourceNodes.map(normalizeDeploymentClientNodeUrl).join('\n')}${sourceNodes.length ? '\n' : ''}`;
  let responseBody = rawNodeList;
  let contentType = 'text/plain; charset=utf-8';
  let conversionDiagnostics = { target: targetFormat, total: sourceNodes.length, rendered: sourceNodes.length, omitted: 0, items: [], warnings: [], rawTarget: 'nodes' };
  if (targetFormat === 'base64') {
    responseBody = base64Utf8(rawNodeList);
  } else if (targetFormat !== 'nodes') {
    const transformed = transformBuiltinSubscriptionDetailed(conversionNodeList, targetFormat, {
      enableUdp: true,
      isMeta: isMetaCore(userAgent, requestUrl.searchParams)
    });
    conversionDiagnostics = transformed.diagnostics;
    if (transformed.content) {
      responseBody = transformed.content;
      if (targetFormat === 'singbox' || targetFormat === 'sing-box') contentType = 'application/json; charset=utf-8';
      else if (targetFormat === 'clash') contentType = 'text/yaml; charset=utf-8';
    } else {
      targetFormat = 'nodes';
      responseBody = rawNodeList;
      conversionDiagnostics = { target: 'nodes', total: sourceNodes.length, rendered: sourceNodes.length, omitted: 0, items: [], warnings: [], rawTarget: 'nodes' };
    }
  }
  if (filteredTuicCount) {
    const pinItems = cached.nodes.filter(isTuicNode).map(node => {
      let name = 'TUIC';
      try { name = decodeURIComponent(new URL(String(node)).hash.slice(1)) || name; } catch {}
      return { name, protocol: 'tuic', transport: 'quic', reason: 'missing-certificate-pin' };
    });
    conversionDiagnostics = {
      ...conversionDiagnostics,
      total: conversionDiagnostics.total + filteredTuicCount,
      omitted: conversionDiagnostics.omitted + filteredTuicCount,
      items: [...pinItems, ...conversionDiagnostics.items]
    };
  }
  if (requestUrl.searchParams.get('diagnostics') === '1') {
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(conversionDiagnostics), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    });
  }
  const headers = new Headers({ 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-TSub-Mode': `deployment-${targetFormat}` });
  headers.set('X-TSub-TUIC-Pin-Status', pinStatus);
  headers.set('X-TSub-TUIC-Pin-Filtered', String(filteredTuicCount));
  headers.set('X-TSub-Node-Total', String(conversionDiagnostics.total));
  headers.set('X-TSub-Node-Rendered', String(conversionDiagnostics.rendered));
  headers.set('X-TSub-Node-Omitted', String(conversionDiagnostics.omitted));
  const warningCounts = [...conversionDiagnostics.items, ...conversionDiagnostics.warnings].reduce((result, item) => {
    result[item.reason] = (result[item.reason] || 0) + 1;
    return result;
  }, {});
  headers.set('X-TSub-Conversion-Warnings', Object.entries(warningCounts).map(([reason, count]) => `${reason}=${count}`).join(','));
  if (server.traffic.enabled && hasTrafficUsage(cached.userInfo)) {
    const effectiveTotal = resolveEffectiveTrafficTotal(source, cached.userInfo);
    headers.set('Subscription-Userinfo', `upload=${safeInteger(cached.userInfo.upload) || 0}; download=${safeInteger(cached.userInfo.download) || 0}; total=${effectiveTotal}; expire=0`);
  }
  return new Response(request.method === 'HEAD' ? null : responseBody, { status: 200, headers });
}

function agentError(error) {
  return createJsonResponse({ success: false, error: error.code }, error.status, { 'Cache-Control': 'no-store' });
}

export async function handleDeployAgentPoll(request, env) {
  if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 16 * 1024) return createErrorResponse('Payload too large', 413);
  let payload = {};
  try { payload = await request.json(); } catch { return createErrorResponse('Invalid JSON', 400); }
  const storage = await getStorage(env);
  const result = await pollAgent(request, env, storage, payload);
  if (result.error) return agentError(result.error);
  if (String(request.headers.get('Accept') || '').includes('text/plain')) {
    const command = result.command || {};
    return new Response([
      `nextPollSeconds=${result.nextPollSeconds || 30}`, `commandId=${command.id || ''}`,
      `operationId=${command.operationId || ''}`, `action=${command.action || ''}`,
      `leaseId=${command.leaseId || ''}`, `leaseExpiresAt=${command.leaseExpiresAt || ''}`
    ].join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return createJsonResponse({ success: true, data: result }, 200, { 'Cache-Control': 'no-store' });
}

export async function handleDeployAgentCommandConfig(request, env, commandId) {
  if (request.method !== 'GET') return createErrorResponse('Method Not Allowed', 405);
  const storage = await getStorage(env);
  const auth = await authorizeAgentCommand(request, env, storage, commandId);
  if (auth.error) return agentError(auth.error);
  const repository = createDeploymentRepository(storage);
  const deployment = await repository.getDeployment(auth.agent.deployment_id);
  const operation = await repository.getOperation(auth.command.operation_id);
  if (!deployment || !operation) return createErrorResponse('Command target not found', 404);
  try {
    if (auth.command.action === 'transfer-controller') {
      const commandData = JSON.parse(auth.command.data || '{}');
      const transfer = await decryptDeploymentConfig(commandData.encryptedTransfer, env);
      const compiled = `transfer_target_url=${validateTransferTarget(transfer.targetUrl)}\ntransfer_claim_b64=${base64Utf8(transfer.claimToken)}\n`;
      await storage.db.prepare(`UPDATE deployment_commands SET status = 'running', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'claimed'`).bind(commandId).run();
      return new Response(compiled, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (auth.command.action === 'edge-probe') {
      const commandData = JSON.parse(auth.command.data || '{}');
      const probe = await decryptDeploymentConfig(commandData.encryptedProbe, env);
      const compiled = [
        `edge_probe_hostname=${probe.hostname}`,
        `edge_probe_address_b64=${base64Utf8(probe.address)}`,
        `edge_probe_port=${probe.port}`,
        `edge_probe_path_b64=${base64Utf8(probe.path)}`
      ].join('\n') + '\n';
      await storage.db.prepare(`UPDATE deployment_commands SET status = 'running', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'claimed'`).bind(commandId).run();
      return new Response(compiled, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    const storedConfig = await decryptDeploymentConfig(deployment.encryptedConfig, env);
    const config = resolveBootstrapConfig(storedConfig, '', deployment.resolvedAddresses || {});
    const controllerBase = env.TSUB_PUBLIC_URL || request.url;
    const localExecutor = deployment.controlTransport === 'local-executor';
    const compiled = compileBootstrapConfig(config, '', '', deployment.id, env, localExecutor ? '' : parseBearer(request), localExecutor ? 'local' : 'remote', controllerBase, deployment.configRevision || 1);
    await storage.db.prepare(`UPDATE deployment_commands SET status = 'running', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'claimed'`).bind(commandId).run();
    return new Response(compiled, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return createErrorResponse('Unable to prepare command configuration', 503); }
}

export async function handleDeployAgentTransferClaim(request, env) {
  if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
  const storage = await getStorage(env);
  const result = await claimControllerTransfer(request, env, storage);
  if (result.error) return createJsonResponse({ success: false, error: result.error.code }, result.error.status, { 'Cache-Control': 'no-store' });
  return new Response(result.config, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function handleDeployAgentCommandEvents(request, env, commandId) {
  if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
  let payload = {};
  try { payload = await request.json(); } catch { return createErrorResponse('Invalid JSON', 400); }
  const storage = await getStorage(env);
  const result = await reportAgentCommand(request, env, storage, commandId, payload);
  return result.error ? agentError(result.error) : createJsonResponse({ success: true, data: result }, 200, { 'Cache-Control': 'no-store' });
}

async function createOperation(request, storage, deployment, action, env) {
  if (!ACTIONS.has(action)) return createErrorResponse('Unsupported deployment action', 400);
  const bootstrapToken = randomToken(); const callbackToken = randomToken();
  const bootstrapTokenHash = await sha256(bootstrapToken); const callbackTokenHash = await sha256(callbackToken);
  const createdAt = nowIso();
  const operation = {
    id: randomId('op'), deploymentId: deployment.id, action, status: 'pending', bootstrapTokenHash, callbackTokenHash,
    configRevision: Number.isSafeInteger(deployment.configRevision) ? deployment.configRevision : 1,
    events: [], createdAt, updatedAt: createdAt, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString()
  };
  const capabilities = await getPlatformCapabilities(env);
  const agent = capabilities.features.remoteAgent ? await ensureDeploymentAgent(storage, deployment) : { token: '' };
  if (action === 'uninstall') {
    deployment.pendingReason = 'uninstall';
    deployment.updatedAt = createdAt;
  }
  await Promise.all([
    writeOperation(storage, operation),
    ...(action === 'uninstall' ? [writeDeployment(storage, deployment)] : []),
    storage.put(`${BOOTSTRAP_TOKEN_PREFIX}${bootstrapTokenHash}`, { operationId: operation.id, callbackToken, agentToken: agent.token || '', expiresAt: operation.expiresAt }),
    storage.put(`${CALLBACK_TOKEN_PREFIX}${callbackTokenHash}`, { operationId: operation.id, expiresAt: new Date(Date.now() + CALLBACK_TTL_MS).toISOString() })
  ]);
  const bootstrapUrl = new URL('/api/deploy/bootstrap', request.url).toString();
  const runUrl = new URL('/api/deploy/run.sh', request.url).toString();
  const probeUrl = new URL(`/api/deploy/address/${operation.id}`, request.url).toString();
  const header = shellQuote(`Authorization: Bearer ${bootstrapToken}`);
  const retryPrefix = `(${operationConfirmation(action, deployment.name)}TSUB_BOOTSTRAP=$(mktemp) || exit 1; chmod 600 "$TSUB_BOOTSTRAP"; trap 'rm -f "$TSUB_BOOTSTRAP"' EXIT HUP INT TERM; TSUB_ATTEMPT=0; until `;
  const retrySuffix = `; do TSUB_ATTEMPT=$((TSUB_ATTEMPT + 1)); [ "$TSUB_ATTEMPT" -lt 12 ] || exit 1; sleep 5; done; /bin/sh "$TSUB_BOOTSTRAP")`;
  const probePrefix = `curl -4 -fsS -X POST -H ${header} ${shellQuote(probeUrl)} >/dev/null 2>&1 || true; curl -6 -fsS -X POST -H ${header} ${shellQuote(probeUrl)} >/dev/null 2>&1 || true; `;
  const diagnosticCommand = `${retryPrefix}${probePrefix}curl -fsSL -H ${header} -o "$TSUB_BOOTSTRAP" ${shellQuote(bootstrapUrl)}${retrySuffix}`;
  const wgetProbePrefix = `wget -qO- -4 --header=${header} --post-data='' ${shellQuote(probeUrl)} >/dev/null 2>&1 || true; wget -qO- -6 --header=${header} --post-data='' ${shellQuote(probeUrl)} >/dev/null 2>&1 || true; `;
  const diagnosticWgetCommand = `${retryPrefix}${wgetProbePrefix}wget -qO "$TSUB_BOOTSTRAP" --header=${header} ${shellQuote(bootstrapUrl)}${retrySuffix}`;
  const command = `curl -fsSL ${shellQuote(runUrl)} | sh -s -- ${shellQuote(bootstrapToken)}`;
  const wgetCommand = `wget -O- ${shellQuote(runUrl)} | sh -s -- ${shellQuote(bootstrapToken)}`;
  return createJsonResponse({
    success: true,
    data: { operation: publicOperation(operation), command, wgetCommand, diagnosticCommand, diagnosticWgetCommand, expiresAt: operation.expiresAt }
  });
}

async function listWithLegacyDrafts(storage) {
  const current = await readCollection(storage, DEPLOYMENTS_KEY);
  const operations = await readCollection(storage, OPERATIONS_KEY);
  const latestSuccessfulApply = new Map();
  for (const operation of operations) {
    if (operation.action !== 'apply' || operation.status !== 'succeeded' || !operation.completedAt) continue;
    const previous = latestSuccessfulApply.get(operation.deploymentId);
    if (!previous || Date.parse(operation.completedAt) > Date.parse(previous)) {
      latestSuccessfulApply.set(operation.deploymentId, operation.completedAt);
    }
  }
  const enriched = current.map(item => item.deployedAt || !latestSuccessfulApply.has(item.id)
    ? item
    : { ...item, deployedAt: latestSuccessfulApply.get(item.id) });
  const legacy = await readCollection(storage, LEGACY_DEPLOYMENTS_KEY);
  const legacyIds = new Set(enriched.map(item => item.legacyId).filter(Boolean));
  return [...enriched, ...legacy.filter(item => !legacyIds.has(item.id)).map(item => ({ id: item.id, legacyId: item.id, name: item.name, nodeGroup: item.nodeGroup, profileId: item.profileId, schemaVersion: 1, status: 'draft', createdAt: item.createdAt, updatedAt: item.updatedAt }))];
}

export async function handleDeploymentsRequest(request, env, path) {
  const storage = await getStorage(env);
  const demoData = await readDemoData(storage).catch(() => null);
  const parts = path.split('/').filter(Boolean); const id = parts[1] || ''; const child = parts[2] || '';
  if (parts.length === 1 && request.method === 'GET') {
    const real = isDemoView(request) ? [] : await listWithLegacyDrafts(storage);
    const capabilities = await getPlatformCapabilities(env);
    const realPublic = await Promise.all(real.map(async item => ({
      ...publicDeployment(item),
      agent: capabilities.features.heartbeats ? await listAgentState(storage, item.id) : { available: false, online: false, requiresD1: true }
    })));
    return createJsonResponse({ success: true, data: [...(demoData?.deployments || []).map(publicDeployment), ...realPublic] });
  }
  if (parts.length === 1 && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return createErrorResponse('Invalid JSON', 400); }
    const name = String(body?.name || '').trim().slice(0, 120);
    if (!name) return createErrorResponse('Deployment name is required', 400);
    let config; let encryptedConfig; let defaults; let requestConfig = body.config || {};
    try {
      const systemDefaults = await readDeploymentDefaults(storage, env);
      if (body.cloneFromDeploymentId) {
        const source = await findDeployment(storage, String(body.cloneFromDeploymentId));
        if (!source || source.schemaVersion !== 2 || source.status === 'offline') return createErrorResponse('Clone source is unavailable', 409);
        const sourceRevision = Number.isSafeInteger(source.configRevision) ? source.configRevision : 1;
        if (body.configRevision !== undefined && Number(body.configRevision) !== sourceRevision) return createErrorResponse('Deployment configuration changed; reload it before cloning', 409);
        requestConfig = restoreDeploymentSecrets(
          requestConfig,
          await decryptDeploymentConfig(source.encryptedConfig, env),
          false,
          body.resetInheritedNodeNames === true
        );
      }
      defaults = mergeDeploymentDefaults(systemDefaults, requestConfig.defaults || {});
      config = resolveV2Config(requestConfig, systemDefaults, { deploymentName: name });
      await resolveCloudflareEdgeMetadata(config);
      validateRuntimeAssets(config, env); encryptedConfig = await encryptDeploymentConfig(config, env);
    }
    catch (error) { return createErrorResponse(error.code || error.message, error.status || (/DEPLOYMENT_SECRET_KEY|资产|版本环境变量|PINNED_CORE_MANIFEST|Pinned 清单/.test(error.message) ? 503 : 400)); }
    const timestamp = nowIso();
    const deployment = {
      id: randomId('deploy'), schemaVersion: 2, configRevision: 1, name, nodeGroup: String(body.nodeGroup || defaults.deployment.nodeGroup || name).trim().slice(0, 120),
      profileId: String(body.profileId || defaults.deployment.profileId || '').trim().slice(0, 160), configSummary: summarizeConfig(publicV2Config(config)), encryptedConfig,
      editorConfig: editorConfigFromDefaults(defaults, requestConfig),
      status: 'pending', nodeCount: 0, runtime: RUNTIME_MANIFEST, createdAt: timestamp, updatedAt: timestamp, lastSyncAt: null, lastError: ''
    };
    await writeDeployment(storage, deployment);
    if (body.createCommand === false) return createJsonResponse({ success: true, data: { deployment: publicDeployment(deployment) } }, 201);
    const response = await createOperation(request, storage, deployment, 'apply', env); const result = await response.json();
    return createJsonResponse({ success: true, data: { deployment: publicDeployment(deployment), ...result.data } }, 201);
  }
  const demoDeployment = id ? (demoData?.deployments || []).find(item => item.id === id) : null;
  const deployment = demoDeployment || (id ? await findDeployment(storage, id) : null);
  if (!deployment && child === 'source' && request.method === 'DELETE') {
    const deleted = await deleteDeploymentSubscriptionSource(storage, id);
    return createJsonResponse({ success: true, data: { deleted, orphaned: true, id: `tsub_airport_${id}` } });
  }
  if (!deployment) return createErrorResponse('Deployment not found', 404);
  if (!child && request.method === 'GET') {
    const capabilities = await getPlatformCapabilities(env);
    const agent = capabilities.features.heartbeats ? await listAgentState(storage, deployment.id) : { available: false, online: false, requiresD1: true };
    return createJsonResponse({ success: true, data: { ...publicDeployment(deployment), agent } });
  }
  if (demoDeployment && child === 'operations' && request.method === 'GET') {
    return createJsonResponse({ success: true, data: (demoData?.operations || []).filter(item => item.deploymentId === deployment.id).map(publicOperation) });
  }
  if (demoDeployment) return createErrorResponse('Demo deployments are read-only', 409);
  if (child === 'template' && request.method === 'GET') {
    if (deployment.schemaVersion !== 2) return createErrorResponse('Deployment template is unavailable', 409);
    try {
      const config = await decryptDeploymentConfig(deployment.encryptedConfig, env);
      return createJsonResponse({
        success: true,
        data: {
          deployment: publicDeployment(deployment),
          config: publicV2Config(config),
          editor: { ...editableConfigMetadata(config), ...(deployment.editorConfig || {}) },
          configRevision: Number.isSafeInteger(deployment.configRevision) ? deployment.configRevision : 1,
          retainedSecrets: true
        }
      });
    } catch { return createErrorResponse('Service unavailable', 503); }
  }
  if (!child && request.method === 'PATCH') {
    let body; try { body = await request.json(); } catch { return createErrorResponse('Invalid JSON', 400); }
    if (body.name !== undefined) deployment.name = String(body.name).trim().slice(0, 120) || deployment.name;
    if (body.nodeGroup !== undefined) deployment.nodeGroup = String(body.nodeGroup).trim().slice(0, 120);
    if (body.profileId !== undefined) deployment.profileId = String(body.profileId).trim().slice(0, 160);
    if (body.config) {
      try {
        const sourceConfig = await decryptDeploymentConfig(deployment.encryptedConfig, env);
        const systemDefaults = await readDeploymentDefaults(storage, env);
        const restoredConfig = restoreDeploymentSecrets(body.config, sourceConfig, true);
        const configDefaults = mergeDeploymentDefaults(systemDefaults, restoredConfig.defaults || {});
        const config = resolveV2Config(restoredConfig, systemDefaults, { deploymentName: deployment.name });
        await resolveCloudflareEdgeMetadata(config);
        validateRuntimeAssets(config, env); deployment.encryptedConfig = await encryptDeploymentConfig(config, env); deployment.configSummary = summarizeConfig(publicV2Config(config));
        deployment.editorConfig = editorConfigFromDefaults(configDefaults, restoredConfig);
        deployment.configRevision = (Number.isSafeInteger(deployment.configRevision) ? deployment.configRevision : 1) + 1;
        deployment.status = 'pending';
        deployment.pendingReason = 'config';
      }
      catch (error) { return createErrorResponse(error.code || error.message, error.status || (/资产|版本环境变量|PINNED_CORE_MANIFEST|Pinned 清单/.test(error.message) ? 503 : 400)); }
    }
    deployment.updatedAt = nowIso(); await writeDeployment(storage, deployment);
    return createJsonResponse({ success: true, data: publicDeployment(deployment) });
  }
  if (!child && request.method === 'DELETE') {
    try {
      const config = await decryptDeploymentConfig(deployment.encryptedConfig, env);
      const preserveResources = new URL(request.url).searchParams.get('preserveCloudflareResources') === 'true';
      if (isManagedCloudflareResource(config) && !preserveResources) {
        return createJsonResponse({ success: false, error: 'cloudflare_resources_attached', message: '请先清理 Cloudflare 资源，或明确选择保留资源后再删除部署记录' }, 409);
      }
    } catch { return createErrorResponse('Service unavailable', 503); }
    await disableDeploymentNodes(storage, deployment.id);
    await createDeploymentRepository(storage).deleteDeployment(deployment.id);
    return createJsonResponse({ success: true, data: { deleted: true, id: deployment.id } });
  }
  if (child === 'cloudflare-resources' && request.method === 'DELETE') {
    let body; try { body = await readJsonWithLimit(request, JSON_BODY_LIMITS.small); } catch (error) { return createErrorResponse(error.message || 'Invalid JSON', error.status || 400); }
    if (String(body?.deploymentName || '') !== deployment.name) return createErrorResponse('Deployment name confirmation mismatch', 400);
    try {
      const config = await decryptDeploymentConfig(deployment.encryptedConfig, env);
      const result = await cleanupManagedTunnel(config);
      if (result.deleted) {
        config.edge = { ...config.edge, mode: 'disabled', hostname: '', managed: {} };
        config.inbounds = config.inbounds.map(item => ({ ...item, edgeMode: 'direct' }));
        config.tunnels = config.tunnels.filter(item => item.type !== 'named');
        deployment.encryptedConfig = await encryptDeploymentConfig(config, env);
        deployment.configSummary = summarizeConfig(publicV2Config(config));
        deployment.configRevision = (Number.isSafeInteger(deployment.configRevision) ? deployment.configRevision : 1) + 1;
        deployment.status = 'pending'; deployment.pendingReason = 'config'; deployment.updatedAt = nowIso();
        await writeDeployment(storage, deployment);
      }
      return createJsonResponse({ success: true, data: { ...result, deployment: publicDeployment(deployment) } }, 200, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return createJsonResponse({ success: false, error: error.code || 'cloudflare_resource_cleanup_failed' }, error.status || 502, { 'Cache-Control': 'no-store' });
    }
  }
  if (child === 'source' && request.method === 'DELETE') {
    const deleted = await deleteDeploymentSubscriptionSource(storage, deployment.id, deployment);
    return createJsonResponse({ success: true, data: { deleted, id: `tsub_airport_${deployment.id}` } });
  }
  if (child === 'source' && request.method === 'POST') {
    let config;
    try { config = await decryptDeploymentConfig(deployment.encryptedConfig, env); }
    catch { return createErrorResponse('Service unavailable', 503); }
    if (!config.subscription?.server?.enabled) return createErrorResponse('Deployment subscription is disabled', 409);
    const source = await upsertDeploymentSubscription(storage, deployment, config, deployment.nodeCount || 0, [], request.url, true);
    deployment.subscriptionSourceDisabled = false;
    deployment.subscriptionId = source.id;
    deployment.updatedAt = nowIso();
    await writeDeployment(storage, deployment);
    return createJsonResponse({ success: true, data: { restored: true, source: { id: source.id, enabled: source.enabled } } });
  }
  if (child === 'edge-probes' && request.method === 'POST') {
    let body; try { body = await readJsonWithLimit(request, JSON_BODY_LIMITS.small); } catch (error) { return createErrorResponse(error.message || 'Invalid JSON', error.status || 400); }
    const currentRevision = Number.isSafeInteger(deployment.configRevision) ? deployment.configRevision : 1;
    if (Number(body.configRevision) !== currentRevision) return createJsonResponse({ success: false, error: 'REVISION_CONFLICT' }, 409);
    try {
      const config = await decryptDeploymentConfig(deployment.encryptedConfig, env);
      const probe = deriveEdgeProbe(config, body);
      const platform = await getPlatformCapabilities(env);
      const agent = platform.features.remoteCommands ? await listAgentState(storage, deployment.id) : { online: false };
      if (agent.online) {
        const timestamp = nowIso();
        const operation = { id: randomId('op'), deploymentId: deployment.id, action: 'edge-probe', status: 'pending', delivery: 'agent', events: [], createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString() };
        const encryptedProbe = await encryptDeploymentConfig(probe, env);
        await writeOperation(storage, operation);
        let command;
        try {
          command = await queueAgentCommand(storage, deployment, operation, { encryptedProbe });
        } catch (error) {
          operation.status = 'failed'; operation.completedAt = nowIso(); operation.updatedAt = operation.completedAt;
          operation.message = error.code || 'edge_probe_queue_failed';
          operation.events = [{ at: operation.completedAt, status: 'failed', stage: 'edge-probe', message: operation.message, resources: {} }];
          await writeOperation(storage, operation);
          throw error;
        }
        return createJsonResponse({ success: true, data: { runner: 'agent', operation: publicOperation(operation), command } }, 202, { 'Cache-Control': 'no-store' });
      }
      if (env.TSUB_PLATFORM !== 'server' || typeof env.TSUB_EDGE_PROBE !== 'function') {
        return createJsonResponse({ success: false, error: 'edge_probe_agent_required' }, 409, { 'Cache-Control': 'no-store' });
      }
      const result = publicEdgeProbeResult(await env.TSUB_EDGE_PROBE(probe));
      const timestamp = nowIso();
      const operation = {
        id: randomId('op'), deploymentId: deployment.id, action: 'edge-probe', status: result.ok ? 'succeeded' : 'failed', delivery: 'controller',
        hostname: '', message: result.error || (result.ok ? 'edge probe passed' : 'edge probe failed'),
        events: [{ at: timestamp, status: result.ok ? 'succeeded' : 'failed', stage: 'edge-probe', message: result.error || '', resources: { edgeProbe: result } }],
        createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp
      };
      await writeOperation(storage, operation);
      return createJsonResponse({ success: true, data: { runner: 'controller', result, operation: publicOperation(operation) } }, 200, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return createJsonResponse({ success: false, error: error.code || 'edge_probe_failed' }, error.status || 500, { 'Cache-Control': 'no-store' });
    }
  }
  if (child === 'operations' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return createErrorResponse('Invalid JSON', 400); }
    const action = String(body.action || '');
    if (['update', 'reinstall'].includes(action) && body.config) {
      try {
        const { nextDeployment } = await prepareDeploymentUpdate(storage, deployment, body, env, '', action);
        if (action === 'reinstall') await supersedeDeploymentOperations(storage, deployment.id);
        Object.assign(deployment, nextDeployment);
        await writeDeployment(storage, deployment);
      } catch (error) {
        return createErrorResponse(error.message, error.status || (/DEPLOYMENT_SECRET_KEY|资产|版本环境变量|PINNED_CORE_MANIFEST|Pinned 清单/.test(error.message) ? 503 : 400));
      }
    } else if (action === 'reinstall') {
      if (!isDeploymentReinstallable(deployment)) return createErrorResponse('Deployment cannot be reinstalled in its current state', 409);
      await supersedeDeploymentOperations(storage, deployment.id);
      deployment.status = 'pending';
      deployment.pendingReason = 'reinstall';
      deployment.updatedAt = nowIso();
      await writeDeployment(storage, deployment);
    }
    return createOperation(request, storage, deployment, action, env);
  }
  if (child === 'transfer-claim' && request.method === 'POST') {
    try {
      return createJsonResponse({ success: true, data: await createControllerTransferClaim(env, storage, deployment.id) }, 201, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return createJsonResponse({ success: false, error: error.code || 'transfer_claim_failed', message: error.message }, error.status || 400);
    }
  }
  if (child === 'controller-transfer' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return createErrorResponse('Invalid JSON', 400); }
    try {
      const targetUrl = validateTransferTarget(body?.targetUrl);
      const claimToken = String(body?.claimToken || '').trim();
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(claimToken)) throw Object.assign(new Error('Invalid transfer claim token'), { status: 400 });
      const timestamp = nowIso();
      const operation = {
        id: randomId('op'), deploymentId: deployment.id, action: 'transfer-controller', delivery: 'agent', status: 'pending',
        events: [], createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString()
      };
      const encryptedTransfer = await encryptDeploymentConfig({ targetUrl, claimToken }, env);
      await writeOperation(storage, operation);
      const command = await queueAgentCommand(storage, deployment, operation, { encryptedTransfer });
      return createJsonResponse({ success: true, data: { operation: publicOperation(operation), command } }, 202, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return createJsonResponse({ success: false, error: error.code || 'controller_transfer_failed', message: error.message }, error.status || 400);
    }
  }
  if (child === 'local-executor' && request.method === 'POST') {
    const capabilities = await getPlatformCapabilities(env);
    if (!capabilities.features.localExecutor || typeof env.TSUB_PROVISION_LOCAL_EXECUTOR !== 'function') {
      return createJsonResponse({ success: false, error: 'local_executor_unavailable' }, 409);
    }
    try {
      for (const current of await createDeploymentRepository(storage).listDeployments()) {
        if (current.id === deployment.id || current.controlTransport !== 'local-executor') continue;
        await storage.db.prepare(`UPDATE deployment_agents SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE deployment_id = ?`).bind(current.id).run();
        current.controlTransport = 'manual';
        current.agentReconnectRequired = true;
        current.updatedAt = nowIso();
        await writeDeployment(storage, current);
      }
      const agent = await rotateDeploymentAgent(storage, deployment.id);
      await env.TSUB_PROVISION_LOCAL_EXECUTOR({ deploymentId: deployment.id, token: agent.token });
      deployment.controlTransport = 'local-executor';
      deployment.agentReconnectRequired = false;
      deployment.updatedAt = nowIso();
      await writeDeployment(storage, deployment);
      return createJsonResponse({ success: true, data: { deployment: publicDeployment(deployment), generation: agent.generation } }, 200, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return createJsonResponse({ success: false, error: 'local_executor_provision_failed', message: error.message }, error.status || 500);
    }
  }
  // Temporary alias accepted during the client migration, with V2 actions only.
  if (child === 'commands' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return createErrorResponse('Invalid JSON', 400); }
    if (body.delivery === 'agent') {
      const capabilities = await getPlatformCapabilities(env);
      if (!capabilities.features.remoteCommands) return createJsonResponse({ success: false, error: 'd1_required', message: '切换到 D1 后可使用远程执行' }, 409);
      const action = String(body.action || '');
      if (['transfer-controller', 'edge-probe'].includes(action)) return createErrorResponse('Use the dedicated endpoint for this action', 400);
      if (!REMOTE_ACTIONS.has(action)) return createErrorResponse('Unsupported remote action', 400);
      const timestamp = nowIso();
      const operation = { id: randomId('op'), deploymentId: deployment.id, action, status: 'pending', delivery: 'agent', events: [], createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString() };
      try {
        if (action === 'update' && body.config) {
          const { currentRevision, nextDeployment } = await prepareDeploymentUpdate(storage, deployment, body, env, operation.id);
          let nextConfig = await decryptDeploymentConfig(nextDeployment.encryptedConfig, env);
          let rollbackManagedResources = null; let finalizeManagedResources = null;
          if (nextConfig.edge?.mode === 'managed') {
            const provisioned = await ensureManagedTunnel(nextConfig, nextDeployment);
            nextConfig = provisioned.config;
            rollbackManagedResources = provisioned.rollback || null;
            finalizeManagedResources = provisioned.finalize || null;
            nextDeployment.encryptedConfig = await encryptDeploymentConfig(nextConfig, env);
            nextDeployment.configSummary = summarizeConfig(publicV2Config(nextConfig));
          }
          let command;
          try { command = await queueAgentConfigurationUpdate(storage, deployment, nextDeployment, operation, currentRevision); }
          catch (error) {
            if (rollbackManagedResources) await rollbackManagedResources();
            throw error;
          }
          if (finalizeManagedResources) await finalizeManagedResources().catch(() => {});
          return createJsonResponse({ success: true, data: { deployment: publicDeployment(nextDeployment), operation: publicOperation(operation), command } }, 202, { 'Cache-Control': 'no-store' });
        }
        await writeOperation(storage, operation);
        const command = await queueAgentCommand(storage, deployment, operation);
        return createJsonResponse({ success: true, data: { operation: publicOperation(operation), command } }, 202);
      } catch (error) { return createJsonResponse({ success: false, error: error.code || 'remote_command_failed', message: error.message }, error.status || 400); }
    }
    return createOperation(request, storage, deployment, String(body.action || ''), env);
  }
  if (child === 'operations' && request.method === 'GET') {
    const operations = (await readCollection(storage, OPERATIONS_KEY)).filter(item => item.deploymentId === deployment.id).map(publicOperation);
    return createJsonResponse({ success: true, data: operations });
  }
  return createErrorResponse('API route not found', 404);
}

export const deploymentConstants = { RUNTIME_MANIFEST, TOKEN_TTL_MS, CALLBACK_TTL_MS, MAX_CALLBACK_BYTES, MAX_NODES };

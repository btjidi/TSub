const MASKED_SECRET = '********';

export const DEFAULT_REUSE_OPTIONS = Object.freeze({
  inbounds: true,
  tls: true,
  outbound: true,
  ports: false,
  credentials: false,
  warpIdentity: false,
  subscription: false,
  chainUpstream: false,
  nodeName: true
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function visible(value) {
  return value === MASKED_SECRET ? '' : (value ?? '');
}

function freshId(makeId, index) {
  return typeof makeId === 'function' ? makeId(index) : `inbound-reuse-${Date.now()}-${index + 1}`;
}

function publicInbound(source, options, makeId, index) {
  const item = clone(source || {});
  const tls = item.tls || {};
  const transportOptions = item.transportOptions || {};
  const result = {
    ...item,
    id: freshId(makeId, index),
    name: options.nodeName ? String(item.name || '') : '',
    port: options.ports ? (item.port ?? '') : '',
    credentials: {},
    tls: {
      mode: options.tls ? String(tls.mode || '') : '',
      serverName: options.tls ? String(tls.serverName || '') : '',
      certificatePath: '',
      keyPath: '',
      realityPublicKey: '',
      realityPrivateKey: '',
      shortId: options.tls ? String(tls.shortId || '') : ''
    },
    transportOptions: options.tls
      ? { ...transportOptions }
      : {},
    edgeMode: 'direct'
  };

  if (options.credentials) {
    result.credentials = Object.fromEntries(Object.entries(item.credentials || {})
      .filter(([, value]) => value && value !== MASKED_SECRET));
  }
  if (options.tls && options.credentials) {
    result.tls.certificatePath = String(tls.certificatePath || '');
    result.tls.keyPath = String(tls.keyPath || '');
    result.tls.realityPrivateKey = visible(tls.realityPrivateKey);
    result.tls.realityPublicKey = visible(tls.realityPublicKey);
  }
  return result;
}

/**
 * Convert a publicV2Config template to a new, non-secret deployment config.
 * The result intentionally never contains source deployment IDs or managed
 * edge/tunnel credentials. It is safe to submit through the normal create API.
 */
export function buildReusableDeploymentConfig(template = {}, options = {}, makeId) {
  const settings = { ...DEFAULT_REUSE_OPTIONS, ...(options || {}) };
  const source = clone(template || {});
  const selectedInboundIndexes = Array.isArray(settings.inboundIndexes)
    ? new Set(settings.inboundIndexes.filter(index => Number.isInteger(index) && index >= 0 && index < 20))
    : null;
  const config = {
    schemaVersion: 2,
    runtime: clone(source.runtime || {}),
    certificate: clone(source.certificate || {}),
    firewall: clone(source.firewall || {}),
    warp: clone(source.warp || {}),
    subscription: clone(source.subscription || {}),
    inbounds: []
  };

  if (settings.inbounds) {
    config.inbounds = (Array.isArray(source.inbounds) ? source.inbounds : [])
      .slice(0, 20)
      .map((item, sourceIndex) => ({ item, sourceIndex }))
      .filter(({ sourceIndex }) => !selectedInboundIndexes || selectedInboundIndexes.has(sourceIndex))
      .map(({ item }, index) => publicInbound(item, settings, makeId, index));
  }
  if (settings.outbound && config.inbounds.length) {
    const selectedSourceInbounds = (Array.isArray(source.inbounds) ? source.inbounds : [])
      .slice(0, 20)
      .filter((_, sourceIndex) => !selectedInboundIndexes || selectedInboundIndexes.has(sourceIndex));
    config.inbounds = config.inbounds.map((item, index) => ({
      ...item,
      outbound: selectedSourceInbounds[index]?.outbound || item.outbound || 'direct'
    }));
  } else if (config.inbounds.length) {
    config.inbounds = config.inbounds.map(item => ({ ...item, outbound: '' }));
  }
  if (!settings.chainUpstream) {
    config.inbounds = config.inbounds.map(item => {
      if (item.outbound !== 'chain') return item;
      const { chain: _chain, ...safeItem } = item;
      return { ...safeItem, outbound: 'direct' };
    });
  }

  if (!settings.credentials) {
    config.warp = {
      ...(config.warp || {}), privateKey: '', peerPublicKey: '', ipv4: '', ipv6: '', acceptedTerms: false
    };
    config.certificate = {
      ...(config.certificate || {}), apiToken: '', certificatePath: '', keyPath: ''
    };
  }
  if (!settings.warpIdentity) {
    config.warp = {
      ...(config.warp || {}), provisioning: 'auto', privateKey: '', peerPublicKey: '', ipv4: '', ipv6: '', acceptedTerms: false
    };
  }
  if (!settings.subscription) {
    config.subscription = {
      ...(config.subscription || {}),
      hostname: '',
      server: {
        ...(config.subscription?.server || {}), enabled: false, port: null, token: '', pushToken: '', pushGeneration: '',
        traffic: { ...(config.subscription?.server?.traffic || {}), enabled: false, apiSecret: '' }
      }
    };
  } else if (config.subscription?.server) {
    config.subscription.server = {
      ...config.subscription.server,
      port: settings.ports ? (config.subscription.server.port ?? null) : null,
      token: '', pushToken: '', pushGeneration: '',
      traffic: { ...(config.subscription.server.traffic || {}), apiSecret: '' }
    };
  }

  // Managed Cloudflare resources and named tunnel tokens belong to the source
  // deployment and must never be reused by a new deployment.
  config.edge = { mode: 'disabled', hostname: '', quickInboundId: '', endpoints: [], cloudflare: {}, managed: {} };
  config.tunnels = [];
  if (!settings.credentials) {
    config.certificate.apiToken = '';
  }
  return config;
}

export function deploymentReuseSummary(template = {}) {
  const inbounds = Array.isArray(template.inbounds) ? template.inbounds : [];
  return {
    schemaVersion: Number(template.schemaVersion || 0),
    updatedAt: template.updatedAt || template.deployment?.updatedAt || '',
    inboundCount: inbounds.length,
    protocols: [...new Set(inbounds.map(item => item.protocol).filter(Boolean))],
    outbounds: [...new Set(inbounds.map(item => item.outbound).filter(Boolean))],
    core: template.runtime?.core || template.deployment?.configSummary?.runtime?.core || ''
  };
}

export function hasMaskedSecrets(value) {
  if (Array.isArray(value)) return value.some(hasMaskedSecrets);
  if (!value || typeof value !== 'object') return value === MASKED_SECRET;
  return Object.values(value).some(hasMaskedSecrets);
}

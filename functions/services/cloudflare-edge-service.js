const API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15_000;

function clean(value, max = 512) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

function cloudflareError(status, code = 'cloudflare_edge_request_failed') {
  const safeStatus = status === 401 || status === 403 ? 403 : [400, 404, 409, 429, 504].includes(status) ? status : 502;
  return Object.assign(new Error(code), { status: safeStatus, code });
}

async function cloudflareRequest(path, token, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false || body?.errors?.length) {
      const errorCodes = (body?.errors || []).map(item => Number(item?.code));
      const code = response.status === 401 || errorCodes.some(value => value === 1000 || value === 9109)
        ? 'cloudflare_edge_invalid_token'
        : response.status === 403
          ? 'cloudflare_edge_permission_required'
          : 'cloudflare_edge_request_failed';
      throw cloudflareError(response.status, code);
    }
    return body.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw cloudflareError(504, 'cloudflare_edge_timeout');
    throw error?.code ? error : cloudflareError(502);
  } finally { clearTimeout(timer); }
}

function validAccountId(value) { return /^[a-f0-9]{32}$/i.test(value); }
function validZoneId(value) { return /^[a-f0-9]{32}$/i.test(value); }
function validDnsHostname(value) {
  return value.length <= 253 && value.includes('.') && value.split('.').every(label => (
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

function zoneCandidates(hostname) {
  const labels = hostname.split('.');
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
}

export async function resolveCloudflareZone(input = {}) {
  const accountId = clean(input.accountId, 64);
  const apiToken = clean(input.apiToken, 2048);
  const hostname = clean(input.hostname, 253).replace(/\.$/, '').toLowerCase();
  if (!validAccountId(accountId) || !apiToken || !validDnsHostname(hostname)) {
    throw Object.assign(new Error('invalid_cloudflare_edge_credentials'), { status: 400, code: 'invalid_cloudflare_edge_credentials' });
  }
  for (const candidate of zoneCandidates(hostname)) {
    const query = new URLSearchParams({ name: candidate, page: '1', per_page: '1' });
    const zones = await cloudflareRequest(`/zones?${query}`, apiToken);
    const zone = (Array.isArray(zones) ? zones : []).find(item => String(item?.name || '').toLowerCase() === candidate);
    if (!zone) continue;
    const zoneId = clean(zone.id, 64);
    const zoneAccountId = clean(zone.account?.id, 64);
    if (!validZoneId(zoneId)) throw cloudflareError(502);
    if (zoneAccountId && zoneAccountId.toLowerCase() !== accountId.toLowerCase()) {
      throw Object.assign(new Error('cloudflare_edge_account_mismatch'), { status: 400, code: 'cloudflare_edge_account_mismatch' });
    }
    return { id: zoneId, name: candidate };
  }
  throw Object.assign(new Error('cloudflare_edge_zone_not_found'), { status: 404, code: 'cloudflare_edge_zone_not_found' });
}

export async function resolveManagedCloudflareZone(config, options = {}) {
  if (!['manual', 'managed'].includes(config.edge?.mode)) return null;
  const cloudflare = config.edge.cloudflare || (config.edge.cloudflare = {});
  if (config.edge.mode === 'manual' && (!validAccountId(clean(cloudflare.accountId, 64)) || !clean(cloudflare.apiToken, 2048))) return null;
  const previousZoneId = clean(cloudflare.zoneId, 64);
  const previousZoneName = clean(cloudflare.zoneName, 253).toLowerCase();
  const hostname = clean(config.edge.hostname, 253).toLowerCase();
  if (config.edge.managed?.dnsRecordId && previousZoneId && !config.edge.managed.zoneId) {
    config.edge.managed.zoneId = previousZoneId;
  }
  if (options.force !== true && validZoneId(previousZoneId) && validDnsHostname(previousZoneName)
    && (hostname === previousZoneName || hostname.endsWith(`.${previousZoneName}`))) {
    if (!cloudflare.sslMode && cloudflare.apiToken) {
      try {
        const setting = await cloudflareRequest(`/zones/${previousZoneId}/settings/ssl`, cloudflare.apiToken);
        cloudflare.sslMode = clean(setting?.value, 32).toLowerCase();
      } catch { cloudflare.sslMode = ''; }
    }
    return { id: previousZoneId, name: previousZoneName };
  }
  const zone = await resolveCloudflareZone({ ...cloudflare, hostname: config.edge.hostname });
  cloudflare.zoneId = zone.id;
  cloudflare.zoneName = zone.name;
  try {
    const setting = await cloudflareRequest(`/zones/${zone.id}/settings/ssl`, cloudflare.apiToken);
    cloudflare.sslMode = clean(setting?.value, 32).toLowerCase();
  } catch { cloudflare.sslMode = ''; }
  return zone;
}

function routeForInbound(hostname, inbound) {
  const tls = inbound.tls?.mode === 'tls';
  const service = `${tls ? 'https' : 'http'}://127.0.0.1:${inbound.port}`;
  const result = { hostname, service };
  if (inbound.transport === 'grpc') {
    result.path = `^/${String(inbound.transportOptions?.serviceName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/.*)?$`;
    result.originRequest = { http2Origin: true, noTLSVerify: tls };
  } else {
    result.path = String(inbound.transportOptions?.path || '/');
    if (tls) result.originRequest = { noTLSVerify: true };
  }
  return result;
}

function managedIngress(config) {
  return [
    ...config.inbounds.filter(item => item.edgeMode !== 'direct').map(item => routeForInbound(config.edge.hostname, item)),
    { service: 'http_status:404' }
  ];
}

async function findTunnel(accountId, token, name) {
  const items = await cloudflareRequest(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}&per_page=100`, token);
  return (Array.isArray(items) ? items : []).find(item => item.name === name) || null;
}

async function findDnsRecord(zoneId, token, hostname) {
  const items = await cloudflareRequest(`/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=100`, token);
  return (Array.isArray(items) ? items : []).find(item => String(item.name).toLowerCase() === hostname.toLowerCase()) || null;
}

async function getDnsRecord(zoneId, token, recordId) {
  try { return await cloudflareRequest(`/zones/${zoneId}/dns_records/${recordId}`, token); }
  catch (error) { if (error?.status === 404) return null; throw error; }
}

function dnsPayload(record) {
  return {
    type: record.type, name: record.name, content: record.content,
    proxied: record.proxied === true, ttl: record.ttl || 1
  };
}

export async function checkCloudflareEdgePermissions(input = {}) {
  const accountId = clean(input.accountId, 64);
  const zoneId = clean(input.zoneId, 64);
  const apiToken = clean(input.apiToken, 2048);
  const hostname = clean(input.hostname, 253).replace(/\.$/, '').toLowerCase();
  if (!validAccountId(accountId) || !apiToken || (!validDnsHostname(hostname) && !validZoneId(zoneId))) {
    throw Object.assign(new Error('invalid_cloudflare_edge_credentials'), { status: 400, code: 'invalid_cloudflare_edge_credentials' });
  }
  const tunnelPromise = cloudflareRequest(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=1`, apiToken);
  const zonePromise = validDnsHostname(hostname)
    ? resolveCloudflareZone({ accountId, apiToken, hostname })
    : cloudflareRequest(`/zones/${zoneId}`, apiToken).then(item => ({ id: zoneId, name: clean(item?.name, 253) }));
  const [tunnelResult, zoneResult] = await Promise.allSettled([tunnelPromise, zonePromise]);
  let dnsResult = null;
  let sslResult = null;
  if (zoneResult.status === 'fulfilled') {
    [dnsResult, sslResult] = await Promise.allSettled([
      cloudflareRequest(`/zones/${zoneResult.value.id}/dns_records?per_page=1`, apiToken),
      cloudflareRequest(`/zones/${zoneResult.value.id}/settings/ssl`, apiToken)
    ]);
  }
  const check = result => ({
    ok: result?.status === 'fulfilled',
    error: result?.status === 'rejected' ? (result.reason?.code || 'cloudflare_edge_request_failed') : ''
  });
  return {
    checks: {
      tunnel: check(tunnelResult),
      zone: check(zoneResult),
      dns: dnsResult ? check(dnsResult) : { ok: false, error: zoneResult.reason?.code || 'cloudflare_edge_zone_not_found' },
      ssl: sslResult ? check(sslResult) : { ok: false, error: zoneResult.reason?.code || 'cloudflare_edge_zone_not_found' }
    },
    zone: zoneResult.status === 'fulfilled' ? {
      ...zoneResult.value,
      sslMode: sslResult?.status === 'fulfilled' ? clean(sslResult.value?.value, 32).toLowerCase() : ''
    } : null
  };
}

export async function ensureManagedTunnel(config, deployment) {
  if (config.edge?.mode !== 'managed') return { config, changed: false };
  await resolveManagedCloudflareZone(config);
  const { accountId, zoneId, apiToken } = config.edge.cloudflare || {};
  const name = `tsub-${String(deployment.id || '').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48)}`;
  let tunnel = config.edge.managed?.tunnelId
    ? { id: config.edge.managed.tunnelId }
    : await findTunnel(accountId, apiToken, name);
  let createdTunnel = false;
  if (!tunnel) {
    tunnel = await cloudflareRequest(`/accounts/${accountId}/cfd_tunnel`, apiToken, {
      method: 'POST', body: JSON.stringify({ name, config_src: 'cloudflare' })
    });
    createdTunnel = true;
  }
  const tunnelId = clean(tunnel.id, 64);
  if (!tunnelId) throw cloudflareError(502);
  const configurationPath = `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`;
  let oldConfiguration = null;
  try { oldConfiguration = await cloudflareRequest(configurationPath, apiToken); }
  catch (error) {
    if (!createdTunnel || error?.status !== 404) {
      if (createdTunnel) await cloudflareRequest(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`, apiToken, { method: 'DELETE' }).catch(() => {});
      throw error;
    }
  }
  const target = `${tunnelId}.cfargotunnel.com`;
  const managedDnsId = clean(config.edge.managed?.dnsRecordId, 64);
  const managedDnsZoneId = clean(config.edge.managed?.zoneId || zoneId, 64);
  const previousDnsZoneId = clean(config.edge.managed?.previousDnsZoneId || (managedDnsId && managedDnsZoneId !== zoneId ? managedDnsZoneId : ''), 64);
  const previousDnsRecordId = clean(config.edge.managed?.previousDnsRecordId || (managedDnsId && managedDnsZoneId !== zoneId ? managedDnsId : ''), 64);
  const nextConfiguration = { config: { ingress: managedIngress(config), 'warp-routing': { enabled: false } } };
  let existingDns = null; let writtenDns = null; let configurationWritten = false;
  const rollback = async () => {
    if (writtenDns?.id) {
      if (existingDns) await cloudflareRequest(`/zones/${zoneId}/dns_records/${existingDns.id}`, apiToken, { method: 'PUT', body: JSON.stringify(dnsPayload(existingDns)) }).catch(() => {});
      else await cloudflareRequest(`/zones/${zoneId}/dns_records/${writtenDns.id}`, apiToken, { method: 'DELETE' }).catch(() => {});
    }
    if (configurationWritten && oldConfiguration?.config) await cloudflareRequest(configurationPath, apiToken, { method: 'PUT', body: JSON.stringify(oldConfiguration) }).catch(() => {});
    if (createdTunnel) await cloudflareRequest(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`, apiToken, { method: 'DELETE' }).catch(() => {});
  };
  try {
    existingDns = managedDnsId && managedDnsZoneId === zoneId
      ? await getDnsRecord(zoneId, apiToken, managedDnsId)
      : await findDnsRecord(zoneId, apiToken, config.edge.hostname);
    if (existingDns && !managedDnsId && String(existingDns.content || '').toLowerCase() !== target.toLowerCase()) {
      throw Object.assign(new Error('cloudflare_edge_dns_conflict'), { status: 409, code: 'cloudflare_edge_dns_conflict' });
    }
    await cloudflareRequest(configurationPath, apiToken, { method: 'PUT', body: JSON.stringify(nextConfiguration) });
    configurationWritten = true;
    const dnsPayload = { type: 'CNAME', name: config.edge.hostname, content: target, proxied: true, ttl: 1 };
    const dnsRecord = existingDns
      ? await cloudflareRequest(`/zones/${zoneId}/dns_records/${existingDns.id}`, apiToken, { method: 'PUT', body: JSON.stringify(dnsPayload) })
      : await cloudflareRequest(`/zones/${zoneId}/dns_records`, apiToken, { method: 'POST', body: JSON.stringify(dnsPayload) });
    writtenDns = dnsRecord;
    const tunnelToken = config.edge.managed?.tunnelToken
      || await cloudflareRequest(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`, apiToken);
    config.edge.managed = {
      tunnelId, dnsRecordId: clean(dnsRecord?.id || existingDns?.id, 64),
      zoneId, previousDnsZoneId, previousDnsRecordId,
      tunnelToken: clean(tunnelToken, 4096), managedByTsub: true
    };
    config.tunnels = [{ type: 'named', hostname: config.edge.hostname, token: config.edge.managed.tunnelToken }];
    const finalize = async () => {
      if (!previousDnsZoneId || !previousDnsRecordId || (previousDnsZoneId === zoneId && previousDnsRecordId === config.edge.managed.dnsRecordId)) return;
      await cloudflareRequest(`/zones/${previousDnsZoneId}/dns_records/${previousDnsRecordId}`, apiToken, { method: 'DELETE' }).catch(error => {
        if (error?.status !== 404) throw error;
      });
    };
    return { config, changed: true, rollback, finalize };
  } catch (error) {
    await rollback();
    throw error;
  }
}

export async function cleanupManagedTunnel(config) {
  if (config.edge?.mode !== 'managed' || !config.edge.managed?.managedByTsub) return { deleted: false };
  const { accountId, zoneId, apiToken } = config.edge.cloudflare || {};
  const { tunnelId, dnsRecordId } = config.edge.managed;
  const dnsZoneId = clean(config.edge.managed.zoneId || zoneId, 64);
  const previousDnsZoneId = clean(config.edge.managed.previousDnsZoneId, 64);
  const previousDnsRecordId = clean(config.edge.managed.previousDnsRecordId, 64);
  if (!accountId || !dnsZoneId || !apiToken || !tunnelId) throw Object.assign(new Error('cloudflare_edge_credentials_unavailable'), { status: 409, code: 'cloudflare_edge_credentials_unavailable' });
  if (dnsRecordId) await cloudflareRequest(`/zones/${dnsZoneId}/dns_records/${dnsRecordId}`, apiToken, { method: 'DELETE' }).catch(error => {
    if (error?.status !== 404) throw error;
  });
  if (previousDnsZoneId && previousDnsRecordId && (previousDnsZoneId !== dnsZoneId || previousDnsRecordId !== dnsRecordId)) {
    await cloudflareRequest(`/zones/${previousDnsZoneId}/dns_records/${previousDnsRecordId}`, apiToken, { method: 'DELETE' }).catch(error => {
      if (error?.status !== 404) throw error;
    });
  }
  await cloudflareRequest(`/accounts/${accountId}/cfd_tunnel/${tunnelId}?cascade=true`, apiToken, { method: 'DELETE' }).catch(error => {
    if (error?.status !== 404) throw error;
  });
  return { deleted: true, tunnelId };
}

export function isManagedCloudflareResource(config) {
  return config?.edge?.mode === 'managed' && config?.edge?.managed?.managedByTsub === true && Boolean(config?.edge?.managed?.tunnelId);
}

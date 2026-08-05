import { isCloudflareHttpsPort } from '../../shared/deployment-capabilities.js';

function clean(value, max = 253) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

function validHostname(value) {
  return value.length <= 253 && value.includes('.') && value.split('.').every(label => (
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

function validIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validIpv6(value) {
  return value.includes(':') && /^[0-9a-f:]+$/i.test(value) && value.split(':').length <= 8;
}

function probeError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

export function deriveEdgeProbe(config, input = {}) {
  const revision = Number(input.configRevision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw probeError('edge_probe_revision_required');
  if (!['manual', 'quick', 'managed'].includes(config.edge?.mode)) throw probeError('edge_probe_disabled', 409);
  const inbound = (config.inbounds || []).find(item => item.id === clean(input.inboundId, 64));
  if (!inbound || inbound.edgeMode === 'direct') throw probeError('edge_probe_inbound_unavailable', 409);
  if (inbound.transport !== 'ws') throw probeError('edge_probe_websocket_required', 409);
  const hostname = clean(config.edge.hostname).toLowerCase();
  if (!validHostname(hostname)) throw probeError('edge_probe_hostname_unavailable', 409);
  const endpointId = clean(input.endpointId, 64);
  const endpoint = endpointId ? (config.edge.endpoints || []).find(item => item.id === endpointId) : null;
  if (endpointId && !endpoint) throw probeError('edge_probe_endpoint_unavailable', 409);
  const address = clean(endpoint?.address || hostname).replace(/^\[|\]$/g, '').toLowerCase();
  if (!validHostname(address) && !validIpv4(address) && !validIpv6(address)) throw probeError('edge_probe_address_invalid');
  const port = Number(endpoint?.port || (config.edge.mode === 'manual' ? inbound.port : 443));
  if (!Number.isInteger(port) || !isCloudflareHttpsPort(port)) throw probeError('edge_probe_port_invalid');
  const path = clean(inbound.transportOptions?.path || '/', 512);
  if (!path.startsWith('/') || /[\r\n]/.test(path)) throw probeError('edge_probe_path_invalid');
  return { hostname, address, port, path, inboundId: inbound.id, endpointId: endpoint?.id || '' };
}

export function publicEdgeProbeResult(result = {}) {
  const checks = result.checks || {};
  return {
    ok: result.ok === true,
    checks: {
      dns: checks.dns === true,
      tcp: checks.tcp === true,
      tls: checks.tls === true,
      hostSni: checks.hostSni === true,
      websocket101: checks.websocket101 === true
    },
    latencyMs: Math.max(0, Math.round(Number(result.latencyMs || 0))),
    error: clean(result.error, 96)
  };
}

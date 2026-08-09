import { PROTOCOL_CAPABILITIES } from '../../shared/deployment-capabilities.js';

const labels = { vless: 'VLESS', trojan: 'Trojan', vmess: 'VMess', hysteria2: 'Hysteria2', tuic: 'TUIC v5', anytls: 'AnyTLS', shadowsocks: 'Shadowsocks 2022', socks5: 'SOCKS5', naive: 'NaiveProxy' };

export const PROTOCOL_OPTIONS = Object.entries(PROTOCOL_CAPABILITIES).map(([value, capability]) => ({
  value, label: labels[value], cores: [...capability.cores], tls: [...capability.tls]
}));

export const TRANSPORT_OPTIONS = [
  ['tcp', 'TCP / RAW'], ['ws', 'WebSocket'], ['grpc', 'gRPC'], ['xhttp', 'XHTTP']
];

export const NATIVE_TRANSPORT_LABELS = Object.freeze({
  hysteria2: 'Hysteria2 / QUIC', tuic: 'TUIC / QUIC', anytls: 'AnyTLS / TCP',
  shadowsocks: 'TCP + UDP', socks5: 'TCP + UDP', naive: 'HTTPS / H2 / H3'
});

export const OUTBOUND_OPTIONS = [
  ['direct', 'deployments.options.direct'], ['warp-auto', 'deployments.options.warpAuto'], ['warp-v4', 'WARP IPv4'], ['warp-v6', 'WARP IPv6']
];

export const RESOURCE_TIERS = [
  ['auto', 'deployments.options.autoDetect'], ['tiny', 'Tiny (<=96MB)'], ['small', 'Small (97-192MB)'], ['standard', 'Standard (>192MB)']
];

export const DEPLOYMENT_ACTIONS = [
  ['plan', 'deployments.actions.plan'], ['apply', 'deployments.actions.apply'], ['status', 'deployments.actions.status'], ['list', 'deployments.actions.list'],
  ['update', 'deployments.actions.update'], ['restart', 'deployments.actions.restart'], ['repair', 'deployments.actions.repair'], ['doctor', 'deployments.actions.doctor'],
  ['rollback', 'deployments.actions.rollback'], ['uninstall', 'deployments.actions.uninstall']
];

export const RUNTIME_VERSION = '2.4.26';

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDataStore } from '../stores/useDataStore.js';
import { useToastStore } from '../stores/toast.js';
import { DEPLOYMENT_ACTIONS, NATIVE_TRANSPORT_LABELS, OUTBOUND_OPTIONS, PROTOCOL_OPTIONS, RESOURCE_TIERS, RUNTIME_VERSION, TRANSPORT_OPTIONS } from '../constants/deployment-options.js';
import {
  canonicalTransport, compatibleCoresForInbound, compatibleCoresForInbounds,
  edgeCompatibilityReason, isConfigurableTransportProtocol, isQuickTunnelCompatible, protocolCapability,
  tlsModesForProtocol, transportsForProtocol
} from '../../shared/deployment-capabilities.js';
import {
  checkDeploymentEdgePermissions, cleanupDeploymentCloudflareResources, createDeployment, createDeploymentCommand, createRemoteDeploymentCommand, deleteDeployment, getDeploymentDefaults, getDeploymentTemplate, provisionLocalExecutor, restoreDeploymentSource,
  listDeploymentOperations, listDeployments, probeDeploymentEdge, resetDeploymentDefaults, saveDeploymentDefaults
} from '../lib/deployments.js';
import { useI18n } from '../i18n/index.js';
import SecretInput from '../components/forms/SecretInput.vue';
import PushHistoryModal from '../components/modals/PushHistoryModal.vue';
import DeploymentHelpLabel from '../components/deployments/DeploymentHelpLabel.vue';
import DeploymentInfoPopover from '../components/deployments/DeploymentInfoPopover.vue';

const dataStore = useDataStore();
const toast = useToastStore();
const { locale, t } = useI18n();
const { profiles } = storeToRefs(dataStore);
const tabs = computed(() => [
  { id: 'generator', label: t('deployments.tabs.generator') },
  { id: 'deployments', label: t('deployments.tabs.deployments') },
  { id: 'operations', label: t('deployments.tabs.operations') }
]);
const deploymentModeOptions = computed(() => [
  { value: 'install', label: t('deployments.modes.install') },
  { value: 'update', label: t('deployments.modes.update') },
  { value: 'uninstall', label: t('deployments.modes.uninstall') }
]);
const remoteUpdate = ref(false);
const reinstallMode = computed(() => deploymentMode.value === 'update' && targetDeployment.value
  && targetDeployment.value.reinstallable === true);
const submitLabel = computed(() => remoteUpdate.value ? t('deployments.submit.remoteUpdate') : t(`deployments.submit.${reinstallMode.value ? 'reinstall' : deploymentMode.value}`));
const visibleProtocols = PROTOCOL_OPTIONS;
const PREFERRED_DOMAIN_PRESETS = Object.freeze([
  { key: 'visa', address: 'www.visa.cn' },
  { key: 'mfaUkraine', address: 'mfa.gov.ua' },
  { key: 'shopify', address: 'www.shopify.com' },
  { key: 'nexusMods', address: 'staticdelivery.nexusmods.com' },
  { key: 'timeIs', address: 'time.is' }
]);
const activeTab = ref('generator');
const deploymentMode = ref('install');
const targetDeploymentId = ref('');
const preparedUpdateTargetId = ref('');
const templateSourceId = ref('');
const templateConfigRevision = ref(0);
const retainedSecrets = ref(false);
const showLoadConfigDialog = ref(false);
const pendingTemplateRecord = ref(null);
const pendingTemplateRemote = ref(false);
const loading = ref(false);
const defaultsLoading = ref(false);
const globalOpen = ref(false);
const warpSettingsRef = ref(null);
const edgePermissionLoading = ref(false);
const edgePermissionChecks = ref(null);
const edgePermissionError = ref('');
const edgeProbeBusyId = ref('');
const preferredPresetMenuOpen = ref(false);
const showQuickInboundDialog = ref(false);
const quickAutoProtocol = ref('vless');
const edgeModeBeforeQuick = ref('disabled');
const edgeModesBeforeQuick = ref([]);
const showRiskDialog = ref(false);
const pendingOperation = ref(null);
const showOperationCommandModal = ref(false);
const showPushHistoryModal = ref(false);
const pushHistoryRecord = ref({});
const systemDefaults = ref({});
const deployments = ref([]);
const operations = ref([]);
const capabilities = ref({ mode: 'basic', features: { remoteCommands: false, heartbeats: false } });
const selectedDeploymentId = ref('');
const remoteMenuId = ref('');
const deploymentInfoPopoverKey = ref('');
const output = reactive({ curl: '', wget: '', diagnosticCurl: '', diagnosticWget: '', expiresAt: '', client: 'wget', diagnostic: false });
const operationOutput = reactive({ curl: '', wget: '', diagnosticCurl: '', diagnosticWget: '', expiresAt: '', client: 'wget', diagnostic: false, deploymentName: '', action: '' });
const confirmedOperationActions = new Set(['update', 'restart', 'repair', 'rollback', 'uninstall']);
const deploymentPollIntervalMs = 5000;
let deploymentPollTimer = 0;
let deploymentRefreshRequest = 0;

const builtinProtocolDefaults = {
  vless: { transport: 'tcp', outbound: 'direct', tlsMode: 'reality', serverName: 'www.cloudflare.com', path: '/', serviceName: 'tsub' },
  trojan: { transport: 'tcp', outbound: 'direct', tlsMode: 'tls', serverName: 'tsub.local', path: '/', serviceName: 'tsub' },
  vmess: { transport: 'ws', outbound: 'direct', tlsMode: 'none', serverName: '', path: '/tsub', serviceName: 'tsub' },
  hysteria2: { transport: 'hysteria', outbound: 'direct', tlsMode: 'tls', serverName: 'tsub.local', path: '/', serviceName: 'tsub' },
  tuic: { transport: 'quic', outbound: 'direct', tlsMode: 'tls', serverName: 'tsub.local', path: '/', serviceName: 'tsub' },
  anytls: { transport: 'tcp', outbound: 'direct', tlsMode: 'tls', serverName: 'tsub.local', path: '/', serviceName: 'tsub' },
  shadowsocks: { transport: 'tcp', outbound: 'direct', tlsMode: 'none', serverName: '', path: '/', serviceName: 'tsub' },
  socks5: { transport: 'tcp', outbound: 'direct', tlsMode: 'none', serverName: '', path: '/', serviceName: 'tsub' },
  naive: { transport: 'https', outbound: 'direct', tlsMode: 'tls', serverName: 'tsub.local', path: '/', serviceName: 'tsub' }
};

const blankGlobal = () => ({
  credentials: { sharedUuidEnabled: true, sharedPasswordEnabled: true, uuid: '', password: '', username: 'tsub' }, randomPorts: { min: 10000, max: 65535 },
  deployment: { hostname: '', nodeGroup: '', profileId: '', namePrefix: 'TSub', nodeNameMode: 'deployment-protocol-port', addressMode: 'auto' },
  common: { transport: '', outbound: '', tlsMode: '', serverName: '', path: '', serviceName: '' }, protocolDefaults: {},
  runtime: { tier: 'auto', core: 'auto', channel: 'stable', version: '', confirmHigherTier: false, agentPollIntervalSeconds: 30 },
  certificate: { mode: 'self-signed', email: '', apiToken: '', certificatePath: '', keyPath: '' },
  warp: { provisioning: 'auto', acceptedTerms: false, privateKey: '', peerPublicKey: '', ipv4: '', ipv6: '' },
  edge: { mode: 'disabled', hostname: '', quickInboundId: '', endpoints: [], cloudflare: { accountId: '', zoneId: '', zoneName: '', sslMode: '', apiToken: '' }, managed: {} },
  tunnel: { mode: '', hostname: '', token: '' },
  subscriptionServer: { enabled: true, port: '', token: '', trafficEnabled: true, quotaValue: '', quotaUnit: 'GB', pushEnabled: true, pushIntervalMinutes: 15, pushAddressMode: 'auto' },
  firewall: { enabled: true }
});

const newInbound = () => ({
  id: `inbound-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, protocol: 'vless', port: '', expanded: false,
  name: '', transport: '', outbound: '', tlsMode: '', serverName: '', host: '', uuid: '', username: '', password: '', path: '', serviceName: '',
  certificatePath: '', keyPath: '', realityPrivateKey: '', realityPublicKey: '', shortId: '',
  xhttpMode: 'auto', xhttpVersion: 'auto', bandwidthUp: '', bandwidthDown: '', udpHopPorts: '', udpHopInterval: '', edgeMode: 'direct'
});

const global = reactive(blankGlobal());
const form = reactive({ name: '', hostname: '', controlCommand: 'tsub', inbounds: [newInbound()] });

const selectedDeployment = computed(() => deployments.value.find(item => item.id === selectedDeploymentId.value));
const targetDeployment = computed(() => deployments.value.find(item => item.id === targetDeploymentId.value));
const eligibleDeployments = computed(() => deployments.value.filter(item => !item.demo && item.schemaVersion === 2
  && (!remoteUpdate.value || (item.status !== 'offline' && item.agent?.online))));
const visibleDeploymentActions = computed(() => DEPLOYMENT_ACTIONS.filter(([action]) => !['plan', 'apply'].includes(action)));
const showEditableConfig = computed(() => deploymentMode.value === 'install'
  || (deploymentMode.value === 'update' && preparedUpdateTargetId.value && preparedUpdateTargetId.value === targetDeploymentId.value));
const shownCommand = computed(() => output.diagnostic
  ? (output.client === 'wget' ? output.diagnosticWget : output.diagnosticCurl)
  : (output.client === 'wget' ? output.wget : output.curl));
const shownOperationCommand = computed(() => operationOutput.diagnostic
  ? (operationOutput.client === 'wget' ? operationOutput.diagnosticWget : operationOutput.diagnosticCurl)
  : (operationOutput.client === 'wget' ? operationOutput.wget : operationOutput.curl));
const pendingOperationMessage = computed(() => {
  if (!pendingOperation.value) return '';
  if (pendingOperation.value.action === 'uninstall') return t('deployments.confirm.uninstall', { name: pendingOperation.value.deployment.name });
  return t('deployments.confirm.operation', {
    name: pendingOperation.value.deployment.name,
    action: t(`deployments.actions.${pendingOperation.value.action}`)
  });
});
const estimatedCore = computed(() => {
  const candidates = compatibleCoresForInbounds(form.inbounds.map(item => capabilityShape(item)));
  return candidates.includes('xray') ? 'xray' : (candidates[0] || '');
});
const needsWarp = computed(() => form.inbounds.some(item => effective(item, 'outbound') !== 'direct'));
const edgeEnabled = computed(() => Boolean(global.edge?.mode && global.edge.mode !== 'disabled'));
const quickInboundCandidates = computed(() => form.inbounds.filter(item => quickInboundEligible(item)));
const selectedCore = computed(() => global.runtime.core === 'auto' ? estimatedCore.value : global.runtime.core);
const sharedTransportScope = computed(() => {
  if (!global.common.transport) return '';
  const protocols = visibleProtocols.filter(item => transportsForProtocol(item.value, global.runtime.core).includes(global.common.transport)).map(item => item.label);
  return t('deployments.globalScope', { protocols: protocols.join('、') || '-' });
});
const sharedTlsScope = computed(() => {
  if (!global.common.tlsMode) return '';
  const protocols = visibleProtocols.filter(item => {
    const transport = transportsForProtocol(item.value, global.runtime.core).includes(global.common.transport)
      ? global.common.transport
      : canonicalTransport(item.value, global.protocolDefaults?.[item.value]?.transport || builtinProtocolDefaults[item.value]?.transport);
    return tlsModesForProtocol(item.value, transport, global.runtime.core).includes(global.common.tlsMode);
  }).map(item => item.label);
  return t('deployments.globalScope', { protocols: protocols.join('、') || '-' });
});
const compatibilityErrors = computed(() => {
  const errors = form.inbounds.map(inbound => inboundCompatibilityError(inbound)).filter(Boolean);
  if (!compatibleCoresForInbounds(form.inbounds.map(item => capabilityShape(item))).length) errors.push(t('deployments.errors.coreCombinationConflict'));
  return errors;
});
const edgeDetectionReady = computed(() => ['manual', 'managed'].includes(global.edge.mode)
  && /^[a-f0-9]{32}$/i.test(String(global.edge.cloudflare?.accountId || '').trim())
  && Boolean(String(global.edge.cloudflare?.apiToken || '').trim())
  && validEdgeHostname(global.edge.hostname));
const edgeDetectedZone = computed(() => {
  const id = String(global.edge.cloudflare.zoneId || '').trim();
  if (!id) return null;
  return { id, name: String(global.edge.cloudflare.zoneName || '').trim(), sslMode: String(global.edge.cloudflare.sslMode || '').trim() };
});
const selectedCoreBudgetMb = computed(() => (selectedCore.value === 'sing-box' ? 44 : 42));
const selectedRuntimeMetrics = computed(() => {
  const heartbeat = targetDeployment.value?.agent?.heartbeat || {};
  const reported = targetDeployment.value?.capabilities || {};
  return {
    cgroupLimitMb: heartbeat.cgroupLimitMb || reported.memoryMb || 0,
    rssMb: heartbeat.rssMb || reported.rssMb || 0
  };
});
const resourceTierHelp = computed(() => t('deployments.help.resourceTierDetails', {
  limit: selectedRuntimeMetrics.value.cgroupLimitMb ? `${selectedRuntimeMetrics.value.cgroupLimitMb} MB` : t('deployments.resources.pending'),
  rss: selectedRuntimeMetrics.value.rssMb ? `${selectedRuntimeMetrics.value.rssMb} MB` : t('deployments.resources.pending'),
  core: `${selectedCoreBudgetMb.value} MB`,
  cloudflared: ['quick', 'managed'].includes(global.edge.mode) ? '45 MB' : '0 MB'
}));
const strictManualCertificateConflict = computed(() => global.edge.mode === 'manual'
  && global.edge.cloudflare.sslMode === 'strict' && global.certificate.mode === 'self-signed');
const edgeProbeInbound = computed(() => form.inbounds.find(item => item.edgeMode !== 'direct' && effective(item, 'transport') === 'ws'));
let edgeDetectionTimer = null;
let edgeDetectionRequest = 0;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validEdgeHostname(value) {
  const hostname = String(value || '').trim().replace(/\.$/, '');
  return hostname.length <= 253 && hostname.includes('.') && hostname.split('.').every(label => (
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}
function compactZoneId(value) {
  const id = String(value || '');
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}
function edgePermissionErrorText(code) {
  if (!code) return '';
  const key = `deployments.edge.errors.${code}`;
  const translated = t(key);
  return translated === key ? t('deployments.edge.permissionFailed') : translated;
}
function deploymentSystemVersion(deployment) {
  const heartbeat = deployment.agent?.heartbeat || {};
  if (String(heartbeat.osPrettyName || '').trim()) return heartbeat.osPrettyName.trim();
  const fallback = [heartbeat.osId, heartbeat.osVersion].map(value => String(value || '').trim()).filter(Boolean).join(' ');
  return fallback || t('common.unknown');
}
function coreDisplayName(value) {
  if (value === 'xray') return 'Xray';
  if (value === 'sing-box') return 'sing-box';
  return String(value || 'V1');
}
function compactSystemVersion(deployment) {
  const heartbeat = deployment.agent?.heartbeat || {};
  const id = String(heartbeat.osId || '').trim().toLowerCase();
  const names = { debian: 'Debian', ubuntu: 'Ubuntu', alpine: 'Alpine', rocky: 'Rocky Linux', centos: 'CentOS', fedora: 'Fedora' };
  const name = names[id] || (id ? `${id[0].toUpperCase()}${id.slice(1)}` : '');
  return [name, String(heartbeat.osVersion || '').trim()].filter(Boolean).join(' ') || t('deployments.record.systemUnknown');
}
function formatCompactDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
function formatCompactDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function deploymentConfigUpdatedAt(deployment) { return deployment.configUpdatedAt || deployment.deployedAt || ''; }
function deploymentTimeTitle(deployment) {
  return [
    deployment.deployedAt ? t('deployments.record.deployedFull', { time: formatDate(deployment.deployedAt) }) : '',
    deploymentConfigUpdatedAt(deployment) ? t('deployments.record.updatedFull', { time: formatDate(deploymentConfigUpdatedAt(deployment)) }) : ''
  ].filter(Boolean).join(' · ');
}
function heartbeatSummary(deployment) {
  if (!capabilities.value.features?.heartbeats || deployment.agent?.requiresD1) return t('deployments.record.heartbeatRequiresD1');
  if (!deployment.agent?.lastSeenAt || !deployment.agent?.heartbeat) return t('deployments.record.heartbeatMissing');
  const heartbeat = deployment.agent.heartbeat;
  return [
    deployment.agent.online ? t('deployments.record.agentOnline') : t('deployments.record.agentOffline'),
    t('deployments.record.heartbeatAt', { time: formatCompactDateTime(deployment.agent.lastSeenAt) }),
    t('deployments.options.seconds', { seconds: heartbeat.pollIntervalSeconds || 30 })
  ].join(' · ');
}
function deploymentAddressSummary(deployment) {
  const values = [
    deployment.capabilities?.serverAddress,
    deployment.pushServerAddress,
    deployment.resolvedHostname,
    ...(Array.isArray(deployment.resolvedAddresses) ? deployment.resolvedAddresses : [])
  ].map(value => String(value || '').trim()).filter(Boolean);
  return [...new Set(values)].join(' · ') || '-';
}
function deploymentMemorySummary(deployment) {
  const heartbeat = deployment.agent?.heartbeat || {};
  const reported = deployment.capabilities || {};
  const rssMb = heartbeat.rssMb || reported.rssMb || 0;
  const availableMb = heartbeat.memoryAvailableMb || reported.memoryAvailableMb || 0;
  const limitMb = heartbeat.cgroupLimitMb || reported.cgroupLimitMb || reported.memoryMb || 0;
  const swap = Object.hasOwn(heartbeat, 'swapReported') ? heartbeat : reported;
  const swapSummary = swap.swapReported
    ? (swap.swapTotalMb > 0
        ? t('deployments.record.memorySwap', { used: swap.swapUsedMb || 0, total: swap.swapTotalMb, free: swap.swapFreeMb || 0 })
        : t('deployments.record.memorySwapDisabled'))
    : '';
  const cgroupSwapSummary = swap.cgroupSwapReported
    ? (swap.cgroupSwapLimitMb === -1
        ? t('deployments.record.memoryCgroupSwapUnlimited', { used: swap.cgroupSwapCurrentMb || 0 })
        : t('deployments.record.memoryCgroupSwap', { used: swap.cgroupSwapCurrentMb || 0, limit: swap.cgroupSwapLimitMb || 0 }))
    : '';
  return [
    rssMb ? t('deployments.record.memoryRss', { value: rssMb }) : '',
    availableMb ? t('deployments.record.memoryAvailable', { value: availableMb }) : '',
    limitMb ? t('deployments.record.memoryLimit', { value: limitMb }) : '',
    swapSummary,
    cgroupSwapSummary
  ].filter(Boolean).join(' · ') || '-';
}
function systemDetailRows(deployment) {
  const heartbeat = deployment.agent?.heartbeat || {};
  const capabilitiesInfo = deployment.capabilities || {};
  const configSummary = deployment.configSummary || {};
  const protocols = (configSummary.protocols || []).map(item => `${item.protocol}:${item.port}`).join(' · ') || t('deployments.noProtocolSummary');
  const subscription = configSummary.subscriptionServer?.enabled
    ? `${configSummary.subscriptionServer.port || '-'}${configSummary.subscriptionServer.trafficEnabled ? ` · ${t('deployments.trafficSummary')}` : ''}`
    : t('common.disabled');
  return [
    [t('deployments.record.nodeAddress'), deploymentAddressSummary(deployment)],
    [t('deployments.record.addressMode'), configSummary.addressMode || '-'],
    [t('deployments.record.edgeEntry'), deployment.edgeHostname || '-'],
    [t('deployments.record.system'), deploymentSystemVersion(deployment)],
    [t('deployments.record.runtime'), heartbeat.runtimeVersion || t('common.unknown')],
    [t('deployments.record.core'), [coreDisplayName(heartbeat.core || configSummary.runtime?.core), heartbeat.coreVersion].filter(Boolean).join(' · ')],
    [t('deployments.fields.resourceTier'), configSummary.runtime?.tier || '-'],
    [t('deployments.record.containerInit'), [capabilitiesInfo.container, capabilitiesInfo.init].filter(Boolean).join(' / ') || '-'],
    [t('deployments.record.memory'), deploymentMemorySummary(deployment)],
    [t('deployments.record.protocols'), protocols],
    [t('deployments.record.tls'), configSummary.selfSigned ? t('deployments.selfSignedSummary') : '-'],
    [t('deployments.record.subscription'), subscription],
    [t('deployments.record.trafficBackend'), trafficBackendText(capabilitiesInfo.trafficBackend) || '-'],
    [t('deployments.record.command'), capabilitiesInfo.controlCommand || '-']
  ].map(([label, value]) => ({ label, value }));
}
function heartbeatDetailRows(deployment) {
  if (!capabilities.value.features?.heartbeats || deployment.agent?.requiresD1) return [];
  const heartbeat = deployment.agent?.heartbeat || {};
  return [
    [t('common.status'), deployment.agent?.online ? t('deployments.record.agentOnline') : t('deployments.record.agentOffline')],
    [t('deployments.record.lastHeartbeat'), deployment.agent?.lastSeenAt ? formatDate(deployment.agent.lastSeenAt) : t('deployments.record.heartbeatMissing')],
    [t('deployments.record.pollInterval'), heartbeat.pollIntervalSeconds ? t('deployments.options.seconds', { seconds: heartbeat.pollIntervalSeconds }) : '-'],
    [t('deployments.record.hostname'), heartbeat.hostname || '-'],
    [t('deployments.record.configRevision'), heartbeat.configRevision || deployment.configRevision || '-'],
    [t('deployments.record.currentCommand'), heartbeat.currentCommandId || t('deployments.record.noCurrentCommand')]
  ].map(([label, value]) => ({ label, value }));
}
function deploymentInfoKey(deployment, section) { return `${deployment.id}:${section}`; }
function generatorHelpKey(field) { return `generator:${field}`; }
function setDeploymentInfoPopover(key, open) { deploymentInfoPopoverKey.value = open ? key : (deploymentInfoPopoverKey.value === key ? '' : deploymentInfoPopoverKey.value); }
function replaceReactive(target, value) { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, clone(value)); }
function clearCommandOutput() {
  output.curl = ''; output.wget = ''; output.diagnosticCurl = ''; output.diagnosticWget = '';
  output.expiresAt = ''; output.diagnostic = false;
}
function trafficBackendText(value) {
  if (value === 'nftables' || value === 'iptables') return t('subscriptions.trafficBackendPort', { backend: value });
  if (value === 'core-singbox') return t('subscriptions.trafficBackendCore', { core: 'sing-box' });
  if (value === 'core-xray') return t('subscriptions.trafficBackendCore', { core: 'Xray' });
  if (value === 'unavailable') return t('subscriptions.trafficBackendUnavailable');
  return '';
}
function protocolInfo(value) { return PROTOCOL_OPTIONS.find(item => item.value === value) || PROTOCOL_OPTIONS[0]; }
function credentialType(protocol) { return ['vless', 'vmess', 'tuic'].includes(protocol) ? 'uuid' : 'password'; }
function effective(inbound, key) {
  if (inbound[key]) return key === 'transport' ? canonicalTransport(inbound.protocol, inbound[key]) : inbound[key];
  const shared = global.common?.[key];
  if (shared && key === 'transport' && transportsForProtocol(inbound.protocol, global.runtime.core).includes(canonicalTransport(inbound.protocol, shared))) return canonicalTransport(inbound.protocol, shared);
  if (shared && key === 'tlsMode' && tlsModesForProtocol(inbound.protocol, effective(inbound, 'transport'), global.runtime.core).includes(shared)) return shared;
  if (shared && !['transport', 'tlsMode'].includes(key)) return shared;
  const current = global.protocolDefaults?.[inbound.protocol]?.[key];
  if (current && (key !== 'tlsMode' || tlsModesForProtocol(inbound.protocol, effective(inbound, 'transport'), global.runtime.core).includes(current))) return key === 'transport' ? canonicalTransport(inbound.protocol, current) : current;
  const system = systemDefaults.value.protocolDefaults?.[inbound.protocol]?.[key];
  if (system && (key !== 'tlsMode' || tlsModesForProtocol(inbound.protocol, effective(inbound, 'transport'), global.runtime.core).includes(system))) return key === 'transport' ? canonicalTransport(inbound.protocol, system) : system;
  const builtin = builtinProtocolDefaults[inbound.protocol]?.[key] || '';
  if (key === 'tlsMode' && !tlsModesForProtocol(inbound.protocol, effective(inbound, 'transport'), global.runtime.core).includes(builtin)) return tlsOptions(inbound)[0] || '';
  return key === 'transport' ? canonicalTransport(inbound.protocol, builtin) : builtin;
}
function syncSelfSignedTlsServerNames(sourceInbound = null) {
  if (global.certificate.mode !== 'self-signed') return;
  const tlsInbounds = form.inbounds.filter(item => effective(item, 'tlsMode') === 'tls');
  if (!tlsInbounds.length) return;
  const source = tlsInbounds.includes(sourceInbound) ? sourceInbound : tlsInbounds[0];
  const serverName = source.serverName || effective(source, 'serverName');
  if (!serverName) return;
  for (const inbound of tlsInbounds) inbound.serverName = serverName;
}
function updateSharedServerName() {
  if (global.certificate.mode !== 'self-signed') return;
  for (const inbound of form.inbounds) {
    if (effective(inbound, 'tlsMode') === 'tls') inbound.serverName = '';
  }
  syncSelfSignedTlsServerNames();
}
function capabilityShape(inbound, overrides = {}) {
  return {
    protocol: inbound.protocol,
    transport: overrides.transport || effective(inbound, 'transport'),
    tlsMode: overrides.tlsMode || effective(inbound, 'tlsMode'),
    outbound: overrides.outbound || effective(inbound, 'outbound')
  };
}
function tlsOptions(inbound) {
  const options = tlsModesForProtocol(inbound.protocol, effective(inbound, 'transport'), global.runtime.core);
  return options.length ? options : tlsModesForProtocol(inbound.protocol, effective(inbound, 'transport'));
}
function nativeTransportLabel(inbound) { return NATIVE_TRANSPORT_LABELS[inbound.protocol] || effective(inbound, 'transport'); }
function transportConfigurable(inbound) { return isConfigurableTransportProtocol(inbound.protocol); }
function coreSupportsProtocol(core, protocol) { return protocolInfo(protocol).cores.includes(core); }
function protocolDisabled(protocol) { return global.runtime.core !== 'auto' && !coreSupportsProtocol(global.runtime.core, protocol); }
function transportDisabled(inbound, transport) {
  if (!transportConfigurable(inbound) || !transportsForProtocol(inbound.protocol, global.runtime.core).includes(transport)) return true;
  const allowedTls = tlsModesForProtocol(inbound.protocol, transport, global.runtime.core);
  const currentTls = effective(inbound, 'tlsMode');
  const candidateTls = allowedTls.includes(currentTls) ? currentTls : allowedTls[0];
  const candidates = compatibleCoresForInbounds(form.inbounds.map(item => item === inbound
    ? capabilityShape(item, { transport, tlsMode: candidateTls })
    : capabilityShape(item)));
  return global.runtime.core === 'auto' ? !candidates.length : !candidates.includes(global.runtime.core);
}
function inboundCompatibilityError(inbound) {
  const shape = capabilityShape(inbound);
  if (!transportsForProtocol(shape.protocol).includes(shape.transport)) return t('deployments.errors.protocolTransportUnsupported', { protocol: protocolInfo(inbound.protocol).label, transport: shape.transport });
  if (!tlsModesForProtocol(shape.protocol, shape.transport).includes(shape.tlsMode)) {
    if (shape.protocol === 'vless' && shape.transport === 'ws' && shape.tlsMode === 'reality') return t('deployments.errors.realityWebSocketUnsupported');
    return t('deployments.errors.protocolCombinationUnsupported', { protocol: protocolInfo(inbound.protocol).label, transport: shape.transport, tls: shape.tlsMode });
  }
  const candidates = compatibleCoresForInbound(shape);
  const core = selectedCore.value;
  if (global.runtime.core !== 'auto' && !candidates.includes(global.runtime.core)) return t('deployments.errors.coreProtocol', { core: global.runtime.core, protocol: protocolInfo(inbound.protocol).label });
  if (!candidates.length) return t('deployments.errors.protocolCombinationUnsupported', { protocol: protocolInfo(inbound.protocol).label, transport: shape.transport, tls: shape.tlsMode });
  if (effective(inbound, 'transport') === 'xhttp' && inbound.xhttpVersion === 'h3' && effective(inbound, 'tlsMode') !== 'tls') return t('deployments.errors.xhttpH3RequiresTls');
  return '';
}
function generateUuid(target) { target.uuid = crypto.randomUUID(); }
function generateSubscriptionToken() { global.subscriptionServer.token = crypto.randomUUID(); }
function generatePassword(target) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  target.password = btoa(String.fromCharCode(...bytes)).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function generateRealityKeys(inbound) {
  try {
    const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const [privateJwk, publicJwk] = await Promise.all([
      crypto.subtle.exportKey('jwk', keyPair.privateKey),
      crypto.subtle.exportKey('jwk', keyPair.publicKey)
    ]);
    if (!privateJwk.d || !publicJwk.x) throw new Error('X25519 export failed');
    inbound.realityPrivateKey = privateJwk.d;
    inbound.realityPublicKey = publicJwk.x;
    toast.showToast(t('deployments.notices.realityKeysGenerated'), 'success');
  } catch {
    toast.showToast(t('deployments.errors.realityKeyGeneration'), 'error');
  }
}
function uuidPlaceholder() {
  if (retainedSecrets.value) return t('deployments.placeholders.retainOriginalSecret');
  return t(global.credentials.sharedUuidEnabled ? 'deployments.placeholders.inheritUuid' : 'deployments.placeholders.independentInboundUuid');
}
function passwordPlaceholder() {
  if (retainedSecrets.value) return t('deployments.placeholders.retainOriginalSecret');
  return t(global.credentials.sharedPasswordEnabled ? 'deployments.placeholders.inheritPassword' : 'deployments.placeholders.independentInboundPassword');
}
function nodeNamePlaceholder(inbound) {
  if (global.deployment.nodeNameMode === 'protocol-random') return t('deployments.placeholders.protocolRandomName', { protocol: inbound.protocol === 'hysteria2' ? 'hy2' : inbound.protocol });
  const prefix = global.deployment.nodeNameMode === 'prefix-protocol-port' ? (global.deployment.namePrefix || 'TSub') : (form.name.trim() || t('deployments.placeholders.deploymentName'));
  return `${prefix}-${inbound.protocol}-${inbound.port || t('deployments.placeholders.randomPort')}`;
}

function updateProtocol(inbound) {
  const capability = protocolCapability(inbound.protocol);
  inbound.transport = capability?.nativeTransport || '';
  if (inbound.tlsMode && !tlsOptions(inbound).includes(inbound.tlsMode)) inbound.tlsMode = '';
  if (effective(inbound, 'tlsMode') !== 'reality') {
    inbound.realityPrivateKey = '';
    inbound.realityPublicKey = '';
    inbound.shortId = '';
  }
  if (!['ws', 'xhttp'].includes(effective(inbound, 'transport'))) inbound.path = '';
  if (effective(inbound, 'transport') !== 'grpc') inbound.serviceName = '';
  if (effective(inbound, 'transport') !== 'xhttp') { inbound.xhttpMode = 'auto'; inbound.xhttpVersion = 'auto'; }
  if (['ws', 'xhttp', 'grpc'].includes(effective(inbound, 'transport'))) inbound.expanded = true;
  if (!edgeTransportEligible(inbound)) inbound.edgeMode = 'direct';
  syncSelfSignedTlsServerNames();
  syncQuickInboundSelection();
}
function updateTransport(inbound) {
  if (inbound.tlsMode && !tlsOptions(inbound).includes(inbound.tlsMode)) inbound.tlsMode = '';
  if (effective(inbound, 'tlsMode') !== 'reality') {
    inbound.realityPrivateKey = '';
    inbound.realityPublicKey = '';
    inbound.shortId = '';
  }
  if (!['ws', 'xhttp'].includes(effective(inbound, 'transport'))) inbound.path = '';
  if (effective(inbound, 'transport') !== 'grpc') inbound.serviceName = '';
  if (effective(inbound, 'transport') !== 'xhttp') { inbound.xhttpMode = 'auto'; inbound.xhttpVersion = 'auto'; }
  if (['ws', 'xhttp', 'grpc'].includes(effective(inbound, 'transport'))) inbound.expanded = true;
  if (!edgeTransportEligible(inbound)) inbound.edgeMode = 'direct';
  syncSelfSignedTlsServerNames();
  syncQuickInboundSelection();
}
function updateCore() {
  if (global.runtime.core === 'auto') return;
  for (const inbound of form.inbounds) {
    const allowed = transportsForProtocol(inbound.protocol, global.runtime.core);
    if (allowed.length && !allowed.includes(effective(inbound, 'transport'))) inbound.transport = allowed[0];
    updateTransport(inbound);
  }
}
async function updateOutbound(inbound) {
  if (!effective(inbound, 'outbound').startsWith('warp')) return;
  globalOpen.value = true;
  await nextTick();
  warpSettingsRef.value?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}
function updateCertificateMode() {
  if (global.certificate.mode !== 'self-signed') globalOpen.value = true;
  else syncSelfSignedTlsServerNames();
}
function addInbound() {
  if (form.inbounds.length >= 20) return toast.showToast(t('deployments.errors.maxInbounds'), 'warning');
  form.inbounds.push(newInbound());
}
function removeInbound(index) {
  if (form.inbounds.length <= 1) return;
  form.inbounds.splice(index, 1);
  syncSelfSignedTlsServerNames();
  syncQuickInboundSelection();
}
function quickInboundEligible(inbound) {
  return isQuickTunnelCompatible(capabilityShape(inbound));
}
function edgeEligibilityReason(inbound) {
  if (!edgeEnabled.value) return 'disabled';
  return edgeCompatibilityReason({
    protocol: inbound.protocol, transport: effective(inbound, 'transport'), tlsMode: effective(inbound, 'tlsMode'),
    xhttpVersion: inbound.xhttpVersion, port: inbound.port
  }, global.edge.mode);
}
function edgeTransportEligible(inbound) {
  return !edgeEligibilityReason(inbound);
}
function edgeOptionDisabled(inbound, value) {
  if (value === 'direct') return false;
  return global.edge.mode === 'quick' || Boolean(edgeEligibilityReason(inbound));
}
function edgeReasonText(inbound) {
  const reason = edgeEligibilityReason(inbound);
  return reason ? t(`deployments.edge.requirements.${reason}`) : '';
}
async function focusControl(id, inbound = null) {
  if (inbound) inbound.expanded = true;
  await nextTick();
  const element = document.getElementById(id);
  element?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  element?.focus?.({ preventScroll: true });
}
function focusEdgeRequirement(inbound, index) {
  const targets = {
    disabled: 'edge-mode', transport: `inbound-transport-${index}`, quickTransport: `inbound-transport-${index}`,
    reality: `inbound-tls-mode-${index}`, tls: `inbound-tls-mode-${index}`,
    xhttpH3: `inbound-xhttp-version-${index}`, port: `inbound-port-${index}`
  };
  return focusControl(targets[edgeEligibilityReason(inbound)] || 'edge-mode', inbound);
}
function applyQuickInboundSelection(selected) {
  global.edge.quickInboundId = selected?.id || '';
  for (const inbound of form.inbounds) inbound.edgeMode = inbound.id === selected?.id ? 'only' : 'direct';
}
function syncQuickInboundSelection() {
  if (global.edge?.mode !== 'quick') return;
  const selected = quickInboundCandidates.value.find(item => item.id === global.edge.quickInboundId)
    || quickInboundCandidates.value[0];
  applyQuickInboundSelection(selected);
}
function updateEdgeMode() {
  clearTimeout(edgeDetectionTimer);
  edgeDetectionRequest += 1;
  edgePermissionLoading.value = false;
  edgePermissionError.value = '';
  edgePermissionChecks.value = null;
  if (global.edge.mode !== 'quick') showQuickInboundDialog.value = false;
  if (global.edge.mode === 'disabled') {
    for (const inbound of form.inbounds) inbound.edgeMode = 'direct';
    global.edge.quickInboundId = '';
    edgeModeBeforeQuick.value = 'disabled';
    return;
  }
  if (global.edge.mode === 'quick') {
    global.subscriptionServer.enabled = true;
    global.subscriptionServer.pushEnabled = true;
    const selected = quickInboundCandidates.value.find(item => item.id === global.edge.quickInboundId)
      || quickInboundCandidates.value[0];
    applyQuickInboundSelection(selected);
    showQuickInboundDialog.value = !selected;
    return;
  }
  edgeModeBeforeQuick.value = global.edge.mode;
  for (const inbound of form.inbounds) if (!edgeTransportEligible(inbound)) inbound.edgeMode = 'direct';
}
function updateQuickInbound() {
  const selected = quickInboundCandidates.value.find(item => item.id === global.edge.quickInboundId);
  applyQuickInboundSelection(selected);
}
watch(quickInboundCandidates, () => syncQuickInboundSelection());
function rememberEdgeMode() {
  if (global.edge.mode === 'quick') return;
  edgeModeBeforeQuick.value = global.edge.mode;
  edgeModesBeforeQuick.value = form.inbounds.map(item => ({ id: item.id, edgeMode: item.edgeMode }));
}
function cancelQuickInboundDialog() {
  showQuickInboundDialog.value = false;
  global.edge.mode = edgeModeBeforeQuick.value || 'disabled';
  global.edge.quickInboundId = '';
  for (const inbound of form.inbounds) inbound.edgeMode = edgeModesBeforeQuick.value.find(item => item.id === inbound.id)?.edgeMode || 'direct';
}
async function focusQuickInboundConfiguration() {
  showQuickInboundDialog.value = false;
  const index = form.inbounds.findIndex(item => !transportDisabled(item, 'ws'));
  if (index < 0) return focusControl('deployment-inbounds-header');
  const inbound = form.inbounds[index];
  inbound.expanded = true;
  await focusControl(`inbound-transport-${index}`);
}
async function autoAddQuickInbound() {
  if (form.inbounds.length >= 20) return;
  const inbound = {
    ...newInbound(), protocol: quickAutoProtocol.value, transport: 'ws', tlsMode: 'none', outbound: 'direct',
    path: builtinProtocolDefaults[quickAutoProtocol.value]?.path || '/', edgeMode: 'only', expanded: true
  };
  form.inbounds.push(inbound);
  global.subscriptionServer.enabled = true;
  global.subscriptionServer.pushEnabled = true;
  applyQuickInboundSelection(inbound);
  showQuickInboundDialog.value = false;
  await focusControl(`inbound-transport-${form.inbounds.length - 1}`);
}
function addEdgeEndpoint() {
  if (global.edge.endpoints.length >= 10) return;
  global.edge.endpoints.push({ id: crypto.randomUUID(), label: '', address: '', port: '' });
}
function removeEdgeEndpoint(index) { global.edge.endpoints.splice(index, 1); }
function mergeEdgeEndpoints(items = []) {
  const seen = new Set(global.edge.endpoints.map(item => String(item.address || '').trim().toLowerCase()).filter(Boolean));
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    const address = String(item?.address || '').trim();
    const key = address.toLowerCase();
    if (!address || seen.has(key) || global.edge.endpoints.length >= 10) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    global.edge.endpoints.push({
      id: crypto.randomUUID(), label: String(item?.label || '').trim().slice(0, 24), address, port: ''
    });
    added += 1;
  }
  toast.showToast(t('deployments.edge.preferredImportComplete', { added, skipped }), added ? 'success' : 'warning');
  return { added, skipped };
}
async function importPreferredDomain(key) {
  const preset = PREFERRED_DOMAIN_PRESETS.find(item => item.key === key);
  if (preset) {
    mergeEdgeEndpoints([{
      address: preset.address, label: t(`deployments.edge.domainPresetLabels.${preset.key}`)
    }]);
  }
  preferredPresetMenuOpen.value = false;
  await nextTick();
}
function invalidateEdgeDetection() {
  clearTimeout(edgeDetectionTimer);
  edgeDetectionRequest += 1;
  edgePermissionLoading.value = false;
  edgePermissionChecks.value = null;
  edgePermissionError.value = '';
  global.edge.cloudflare.zoneId = '';
  global.edge.cloudflare.zoneName = '';
  global.edge.cloudflare.sslMode = '';
}
async function detectEdgePermissions(manual = false) {
  if (!edgeDetectionReady.value) return;
  const requestId = ++edgeDetectionRequest;
  edgePermissionLoading.value = true; edgePermissionChecks.value = null; edgePermissionError.value = '';
  try {
    const result = await checkDeploymentEdgePermissions({
      accountId: global.edge.cloudflare.accountId,
      apiToken: global.edge.cloudflare.apiToken,
      hostname: global.edge.hostname
    });
    if (requestId !== edgeDetectionRequest) return;
    edgePermissionChecks.value = result.data?.checks || {};
    const zone = result.data?.zone;
    if (zone?.id) {
      global.edge.cloudflare.zoneId = zone.id;
      global.edge.cloudflare.zoneName = zone.name || '';
      global.edge.cloudflare.sslMode = zone.sslMode || '';
    } else {
      edgePermissionError.value = edgePermissionChecks.value.zone?.error || 'cloudflare_edge_zone_not_found';
    }
  } catch (error) {
    if (requestId !== edgeDetectionRequest) return;
    edgePermissionError.value = error?.data?.error || error?.message || 'cloudflare_edge_check_failed';
    if (manual) toast.showToast(edgePermissionErrorText(edgePermissionError.value), 'error');
  } finally {
    if (requestId === edgeDetectionRequest) edgePermissionLoading.value = false;
  }
}

async function useCloudflareDnsCertificate() {
  global.certificate.mode = 'cloudflare-dns01';
  if (!global.certificate.apiToken && global.edge.cloudflare.apiToken && global.edge.cloudflare.apiToken !== '********') {
    global.certificate.apiToken = global.edge.cloudflare.apiToken;
  }
  globalOpen.value = true;
  await nextTick();
  await focusControl('global-acme-email');
}

async function probePreferredEndpoint(endpoint = null) {
  if (!targetDeployment.value || !edgeProbeInbound.value || !templateConfigRevision.value) {
    return toast.showToast(t('deployments.edge.probeSavedRequired'), 'warning');
  }
  const busyId = endpoint?.id || 'hostname';
  edgeProbeBusyId.value = busyId;
  try {
    const response = await probeDeploymentEdge(targetDeployment.value.id, {
      inboundId: edgeProbeInbound.value.id,
      endpointId: endpoint?.id || '',
      configRevision: templateConfigRevision.value,
      runner: 'auto'
    });
    selectedDeploymentId.value = targetDeployment.value.id;
    if (response.data?.runner === 'agent') {
      toast.showToast(t('deployments.edge.probeQueued'), 'success');
    } else {
      toast.showToast(response.data?.result?.ok ? t('deployments.edge.probePassed') : t('deployments.edge.probeFailed'), response.data?.result?.ok ? 'success' : 'error');
    }
    activeTab.value = 'operations';
    await loadOperations(targetDeployment.value.id);
  } catch (error) {
    const code = error?.data?.error;
    toast.showToast(code === 'REVISION_CONFLICT' ? t('deployments.errors.configRevisionConflict') : code === 'edge_probe_agent_required' ? t('deployments.edge.probeAgentRequired') : t('deployments.edge.probeFailed'), 'error');
  } finally { edgeProbeBusyId.value = ''; }
}

watch(() => [global.edge.mode, global.edge.hostname, global.edge.cloudflare.accountId, global.edge.cloudflare.apiToken], () => {
  clearTimeout(edgeDetectionTimer);
  if (edgeDetectionReady.value) edgeDetectionTimer = setTimeout(() => detectEdgePermissions(false), 600);
});

function serializeGlobal() {
  const value = clone(global);
  value.deployment.hostname = form.hostname.trim();
  delete value.common;
  const quotaNumber = value.subscriptionServer.quotaValue === '' ? 0 : Number(value.subscriptionServer.quotaValue);
  const quotaFactor = value.subscriptionServer.quotaUnit === 'TB' ? 1024 ** 4 : 1024 ** 3;
  value.subscriptionServer = {
    enabled: value.subscriptionServer.enabled === true,
    port: value.subscriptionServer.port === '' || value.subscriptionServer.port === null ? null : Number(value.subscriptionServer.port),
    trafficEnabled: value.subscriptionServer.enabled === true && value.subscriptionServer.trafficEnabled === true,
    quotaBytes: quotaNumber > 0 ? Math.round(quotaNumber * quotaFactor) : 0,
    pushEnabled: value.subscriptionServer.enabled === true && value.subscriptionServer.pushEnabled === true,
    pushIntervalMinutes: Number(value.subscriptionServer.pushIntervalMinutes) || 15,
    pushAddressMode: value.subscriptionServer.pushAddressMode || 'auto'
  };
  value.protocolDefaults ||= {};
  for (const protocol of visibleProtocols.map(item => item.value)) {
    value.protocolDefaults[protocol] ||= {};
    for (const [key, item] of Object.entries(global.common)) {
      if (item === '') continue;
      if (key === 'transport' && !transportsForProtocol(protocol, global.runtime.core).includes(item)) continue;
      const effectiveTransport = key === 'transport'
        ? item
        : canonicalTransport(protocol, value.protocolDefaults[protocol].transport || builtinProtocolDefaults[protocol]?.transport);
      if (key === 'tlsMode' && !tlsModesForProtocol(protocol, effectiveTransport, global.runtime.core).includes(item)) continue;
      value.protocolDefaults[protocol][key] = item;
    }
  }
  return value;
}

function hydrateGlobal(value) {
  const next = blankGlobal();
  for (const key of ['credentials', 'randomPorts', 'deployment', 'runtime', 'certificate', 'warp', 'edge', 'tunnel', 'firewall']) Object.assign(next[key], value?.[key] || {});
  next.edge.cloudflare = { ...next.edge.cloudflare, ...(value?.edge?.cloudflare || {}) };
  next.edge.cloudflare.apiToken = visibleSecret(next.edge.cloudflare.apiToken);
  const subscriptionServer = value?.subscriptionServer || {};
  next.subscriptionServer.enabled = subscriptionServer.enabled !== false;
  next.subscriptionServer.port = subscriptionServer.port || '';
  next.subscriptionServer.trafficEnabled = next.subscriptionServer.enabled && subscriptionServer.trafficEnabled !== false;
  next.subscriptionServer.pushEnabled = next.subscriptionServer.enabled && subscriptionServer.pushEnabled !== false;
  next.subscriptionServer.pushIntervalMinutes = [5, 15, 30, 60].includes(Number(subscriptionServer.pushIntervalMinutes)) ? Number(subscriptionServer.pushIntervalMinutes) : 15;
  next.subscriptionServer.pushAddressMode = ['auto', 'ipv4', 'ipv6'].includes(subscriptionServer.pushAddressMode) ? subscriptionServer.pushAddressMode : 'auto';
  const quotaBytes = Number(subscriptionServer.quotaBytes || 0);
  if (quotaBytes > 0) {
    const useTb = quotaBytes >= 1024 ** 4 && quotaBytes % (1024 ** 4) === 0;
    next.subscriptionServer.quotaUnit = useTb ? 'TB' : 'GB';
    next.subscriptionServer.quotaValue = quotaBytes / (useTb ? 1024 ** 4 : 1024 ** 3);
  }
  next.protocolDefaults = clone(value?.protocolDefaults || {});
  replaceReactive(global, next);
  form.hostname = next.deployment.hostname || '';
}

function visibleSecret(value) { return value === '********' ? '' : (value || ''); }
function hydrateDeploymentTemplate(payload, mode) {
  const config = payload.config || {};
  const deployment = payload.deployment || {};
  const next = blankGlobal();
  Object.assign(next.runtime, config.runtime || {});
  Object.assign(next.runtime, payload.editor?.runtime || {});
  delete next.runtime.controlCommand;
  Object.assign(next.certificate, config.certificate || {});
  next.certificate.apiToken = visibleSecret(next.certificate.apiToken);
  Object.assign(next.warp, config.warp || {});
  next.warp.privateKey = visibleSecret(next.warp.privateKey);
  if (mode === 'install') Object.assign(next.warp, { privateKey: '', peerPublicKey: '', ipv4: '', ipv6: '' });
  Object.assign(next.edge, config.edge || {});
  next.edge.cloudflare = { ...next.edge.cloudflare, ...(config.edge?.cloudflare || {}) };
  next.edge.cloudflare.apiToken = visibleSecret(next.edge.cloudflare.apiToken);
  next.edge.managed = {};
  if (mode === 'install') next.edge.hostname = '';
  const sourceTunnel = config.tunnels?.[0] || {};
  Object.assign(next.tunnel, { mode: sourceTunnel.type || '', hostname: sourceTunnel.hostname || '', token: visibleSecret(sourceTunnel.token) });
  if (mode === 'install') Object.assign(next.tunnel, { mode: '', hostname: '', token: '' });
  Object.assign(next.firewall, config.firewall || {});
  next.credentials.sharedUuidEnabled = payload.editor?.sharedUuidEnabled === true;
  next.credentials.sharedPasswordEnabled = payload.editor?.sharedPasswordEnabled === true;
  Object.assign(next.randomPorts, payload.editor?.randomPorts || {});
  next.credentials.uuid = '';
  next.credentials.password = '';
  next.deployment.hostname = config.subscription?.hostname || '';
  next.deployment.namePrefix = config.subscription?.namePrefix || 'TSub';
  next.deployment.nodeNameMode = payload.editor?.nodeNameMode || 'deployment-protocol-port';
  next.deployment.addressMode = config.subscription?.addressMode || 'auto';
  next.deployment.nodeGroup = deployment.nodeGroup || '';
  next.deployment.profileId = deployment.profileId || '';
  const server = config.subscription?.server || {};
  next.subscriptionServer.enabled = server.enabled === true;
  next.subscriptionServer.port = server.port || '';
  next.subscriptionServer.token = '';
  next.subscriptionServer.pushEnabled = server.enabled === true && server.pushEnabled !== false;
  next.subscriptionServer.pushIntervalMinutes = [5, 15, 30, 60].includes(Number(server.pushIntervalMinutes)) ? Number(server.pushIntervalMinutes) : 15;
  next.subscriptionServer.pushAddressMode = server.pushAddressMode || 'auto';
  next.subscriptionServer.trafficEnabled = server.traffic?.enabled === true;
  const quotaBytes = Number(server.traffic?.quotaBytes || 0);
  if (quotaBytes > 0) {
    const useTb = quotaBytes >= 1024 ** 4 && quotaBytes % (1024 ** 4) === 0;
    next.subscriptionServer.quotaUnit = useTb ? 'TB' : 'GB';
    next.subscriptionServer.quotaValue = quotaBytes / (useTb ? 1024 ** 4 : 1024 ** 3);
  }
  replaceReactive(global, next);
  form.name = mode === 'install' ? '' : (deployment.name || '');
  form.hostname = config.subscription?.hostname || '';
  form.controlCommand = config.runtime?.controlCommand || deployment.capabilities?.controlCommand || 'tsub';
  const hydratedInbounds = (config.inbounds || []).map((item, index) => ({
    ...newInbound(),
    id: item.id || `inbound-${index + 1}`,
    name: mode === 'install' ? '' : (item.name || ''), protocol: item.protocol || 'vless', port: item.port || '',
    transport: item.transport || '', outbound: item.outbound || '',
    tlsMode: item.tls?.mode || '', serverName: item.tls?.serverName || '',
    uuid: '', username: item.credentials?.username || '', password: '',
    path: item.transportOptions?.path || '',
    host: Object.prototype.hasOwnProperty.call(item.transportOptions || {}, 'host') ? (item.transportOptions.host || '') : (item.tls?.serverName || ''),
    serviceName: item.transportOptions?.serviceName || '',
    certificatePath: item.tls?.certificatePath || '', keyPath: item.tls?.keyPath || '',
    realityPrivateKey: '', realityPublicKey: item.tls?.realityPublicKey || '', shortId: item.tls?.shortId || '',
    xhttpMode: item.transportOptions?.xhttpMode || 'auto', xhttpVersion: item.transportOptions?.xhttpVersion || 'auto',
    bandwidthUp: item.transportOptions?.bandwidthUp || '', bandwidthDown: item.transportOptions?.bandwidthDown || '',
    udpHopPorts: item.transportOptions?.udpHopPorts || '', udpHopInterval: item.transportOptions?.udpHopInterval || '', edgeMode: item.edgeMode || 'direct'
  }));
  form.inbounds.splice(0, form.inbounds.length, ...(hydratedInbounds.length ? hydratedInbounds : [newInbound()]));
  syncSelfSignedTlsServerNames();
  deploymentMode.value = mode;
  targetDeploymentId.value = deployment.id || '';
  templateSourceId.value = deployment.id || '';
  preparedUpdateTargetId.value = mode === 'update' ? (deployment.id || '') : '';
  templateConfigRevision.value = Number(payload.configRevision || deployment.configRevision || 1);
  retainedSecrets.value = payload.retainedSecrets === true;
  activeTab.value = 'generator';
}

async function loadDeploymentConfig(deployment, mode, useRemote = false) {
  loading.value = true;
  try {
    const result = await getDeploymentTemplate(deployment.id);
    hydrateDeploymentTemplate(result.data || {}, mode);
    remoteUpdate.value = mode === 'update' && useRemote;
    clearCommandOutput();
    toast.showToast(mode === 'update' ? t('deployments.notices.configLoaded') : t('deployments.notices.configReused'), 'success');
  } catch (error) {
    toast.showToast(error?.status === 409 ? t('deployments.errors.configRevisionConflict') : t('deployments.errors.loadTemplate'), 'error');
  } finally { loading.value = false; }
}

function requestUpdateConfig(deployment, useRemote = false) {
  pendingTemplateRecord.value = deployment;
  pendingTemplateRemote.value = useRemote;
  showLoadConfigDialog.value = true;
}

function requestRemoteUpdateConfig(deployment) {
  remoteMenuId.value = '';
  if (!capabilities.value.features.remoteCommands) return toast.showToast(t('deployments.remote.requiresD1'), 'warning');
  if (!deployment.agent?.online) return toast.showToast(t('deployments.remote.offline'), 'warning');
  requestUpdateConfig(deployment, true);
}

function cancelLoadConfig() {
  showLoadConfigDialog.value = false;
  pendingTemplateRecord.value = null;
  pendingTemplateRemote.value = false;
}

async function confirmLoadConfig() {
  const deployment = pendingTemplateRecord.value;
  const useRemote = pendingTemplateRemote.value;
  showLoadConfigDialog.value = false;
  pendingTemplateRecord.value = null;
  pendingTemplateRemote.value = false;
  if (deployment) await loadDeploymentConfig(deployment, 'update', useRemote);
}

function reconfigureDeployment() {
  const deployment = pendingTemplateRecord.value;
  const useRemote = pendingTemplateRemote.value;
  showLoadConfigDialog.value = false;
  pendingTemplateRecord.value = null;
  pendingTemplateRemote.value = false;
  if (!deployment) return;
  deploymentMode.value = 'update';
  targetDeploymentId.value = deployment.id || '';
  preparedUpdateTargetId.value = deployment.id || '';
  templateSourceId.value = '';
  templateConfigRevision.value = Number(deployment.configRevision || 1);
  retainedSecrets.value = false;
  remoteUpdate.value = useRemote;
  form.name = deployment.name || '';
  clearCommandOutput();
  activeTab.value = 'generator';
  toast.showToast(t('deployments.notices.configReconfigured'), 'success');
}

async function reuseDeploymentConfig(deployment) {
  await loadDeploymentConfig(deployment, 'install');
}

function setDeploymentMode(mode) {
  if (deploymentMode.value === mode) return;
  showLoadConfigDialog.value = false;
  pendingTemplateRecord.value = null;
  pendingTemplateRemote.value = false;
  remoteUpdate.value = false;
  deploymentMode.value = mode;
  clearCommandOutput();
  if (mode === 'install') {
    targetDeploymentId.value = '';
    preparedUpdateTargetId.value = '';
    templateSourceId.value = '';
    templateConfigRevision.value = 0;
    retainedSecrets.value = false;
  } else if (mode === 'uninstall') {
    targetDeploymentId.value = '';
    preparedUpdateTargetId.value = '';
    templateSourceId.value = '';
    templateConfigRevision.value = 0;
    retainedSecrets.value = false;
  } else if (templateSourceId.value) {
    targetDeploymentId.value = templateSourceId.value;
    preparedUpdateTargetId.value = templateSourceId.value;
  }
}

function selectTargetDeployment(event) {
  const deployment = deployments.value.find(item => item.id === event.target.value);
  if (!deployment) { targetDeploymentId.value = ''; return; }
  if (deploymentMode.value === 'update') {
    event.target.value = targetDeploymentId.value;
    requestUpdateConfig(deployment, remoteUpdate.value);
  }
  else {
    targetDeploymentId.value = deployment.id;
    templateSourceId.value = '';
    templateConfigRevision.value = Number(deployment.configRevision || 1);
    form.name = deployment.name;
  }
}

async function loadDefaults() {
  defaultsLoading.value = true;
  try { const result = await getDeploymentDefaults(); systemDefaults.value = clone(result.data || {}); hydrateGlobal(result.data || {}); }
  catch { toast.showToast(t('deployments.errors.loadDefaults'), 'error'); }
  finally { defaultsLoading.value = false; }
}
async function saveGlobal() {
  defaultsLoading.value = true;
  try {
    const result = await saveDeploymentDefaults(serializeGlobal());
    systemDefaults.value = clone(result.data || {}); hydrateGlobal(result.data || {});
    toast.showToast(t('deployments.notices.defaultsSaved'), 'success');
  } catch { toast.showToast(t('deployments.errors.saveDefaults'), 'error'); }
  finally { defaultsLoading.value = false; }
}
async function resetGlobal() {
  if (!window.confirm(t('deployments.confirm.resetDefaults'))) return;
  defaultsLoading.value = true;
  try {
    const result = await resetDeploymentDefaults(); systemDefaults.value = clone(result.data || {}); hydrateGlobal(result.data || {});
    toast.showToast(t('deployments.notices.defaultsReset'), 'success');
  } catch { toast.showToast(t('deployments.errors.resetDefaults'), 'error'); }
  finally { defaultsLoading.value = false; }
}

function sparseInbound(item, index) {
  const credentials = {};
  if (item.uuid) credentials.uuid = item.uuid;
  if (item.username) credentials.username = item.username;
  if (item.password) credentials.password = item.password;
  const tls = {};
  if (item.tlsMode) tls.mode = item.tlsMode;
  if (item.serverName) tls.serverName = item.serverName;
  if (item.certificatePath) tls.certificatePath = item.certificatePath;
  if (item.keyPath) tls.keyPath = item.keyPath;
  if (item.realityPrivateKey) tls.realityPrivateKey = item.realityPrivateKey;
  if (item.realityPublicKey) tls.realityPublicKey = item.realityPublicKey;
  if (item.shortId) tls.shortId = item.shortId;
  const transportOptions = {};
  if (item.path) transportOptions.path = item.path;
  if (item.serviceName) transportOptions.serviceName = item.serviceName;
  if (['ws', 'xhttp'].includes(effective(item, 'transport'))) transportOptions.host = item.host || '';
  if (effective(item, 'transport') === 'xhttp') {
    transportOptions.xhttpMode = item.xhttpMode || 'auto';
    transportOptions.xhttpVersion = item.xhttpVersion || 'auto';
  }
  if (item.protocol === 'hysteria2') {
    if (item.bandwidthUp) transportOptions.bandwidthUp = item.bandwidthUp;
    if (item.bandwidthDown) transportOptions.bandwidthDown = item.bandwidthDown;
    if (item.udpHopPorts) transportOptions.udpHopPorts = item.udpHopPorts;
    if (item.udpHopInterval !== '') transportOptions.udpHopInterval = Number(item.udpHopInterval);
  }
  return {
    id: item.id || `inbound-${index + 1}`, name: item.name.trim(), protocol: item.protocol, port: item.port === '' || item.port === null ? null : Number(item.port),
    ...(item.transport ? { transport: item.transport } : {}), ...(item.outbound ? { outbound: item.outbound } : {}), edgeMode: item.edgeMode || 'direct',
    ...(Object.keys(credentials).length ? { credentials } : {}), ...(Object.keys(tls).length ? { tls } : {}),
    ...(Object.keys(transportOptions).length ? { transportOptions } : {})
  };
}

function buildConfig(currentGlobal = serializeGlobal()) {
  const subscriptionServer = currentGlobal.subscriptionServer;
  return {
    schemaVersion: 2, defaults: clone(currentGlobal), inbounds: form.inbounds.map(sparseInbound),
    runtime: { ...currentGlobal.runtime, controlCommand: form.controlCommand.trim().toLowerCase() }, edge: clone(currentGlobal.edge), warp: clone(currentGlobal.warp),
    subscription: {
      hostname: form.hostname.trim(),
      server: {
        enabled: subscriptionServer.enabled, port: subscriptionServer.port, token: global.subscriptionServer.token.trim(),
        pushEnabled: subscriptionServer.pushEnabled,
        pushIntervalMinutes: subscriptionServer.pushIntervalMinutes,
        pushAddressMode: subscriptionServer.pushAddressMode,
        traffic: { enabled: subscriptionServer.trafficEnabled, quotaBytes: subscriptionServer.quotaBytes }
      }
    }
  };
}

function validateForm() {
  if (!form.name.trim()) return t('deployments.errors.nameRequired');
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(form.controlCommand.trim())) return t('deployments.errors.controlCommandInvalid');
  if (global.credentials.sharedUuidEnabled && global.credentials.uuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(global.credentials.uuid)) return t('deployments.errors.sharedUuidInvalid');
  const randomMin = Number(global.randomPorts.min); const randomMax = Number(global.randomPorts.max);
  if (!Number.isInteger(randomMin) || !Number.isInteger(randomMax) || randomMin < 1 || randomMax > 65535 || randomMax - randomMin < 19) return t('deployments.errors.randomPortRange');
  const manualPorts = form.inbounds.filter(item => item.port !== '' && item.port !== null).map(item => Number(item.port));
  if (manualPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) return t('deployments.errors.portInvalid');
  if (new Set(manualPorts).size !== manualPorts.length) return t('deployments.errors.duplicatePorts');
  if (global.subscriptionServer.enabled) {
    if (global.subscriptionServer.token && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(global.subscriptionServer.token)) return t('deployments.errors.subscriptionTokenInvalid');
    const subscriptionPort = global.subscriptionServer.port === '' || global.subscriptionServer.port === null ? null : Number(global.subscriptionServer.port);
    if (subscriptionPort !== null && (!Number.isInteger(subscriptionPort) || subscriptionPort < 1 || subscriptionPort > 65535)) return t('deployments.errors.subscriptionPortInvalid');
    if (subscriptionPort !== null && manualPorts.includes(subscriptionPort)) return t('deployments.errors.subscriptionPortConflict');
    const quotaValue = global.subscriptionServer.quotaValue === '' ? 0 : Number(global.subscriptionServer.quotaValue);
    if (!Number.isFinite(quotaValue) || quotaValue < 0) return t('deployments.errors.quotaInvalid');
    const quotaBytes = quotaValue * (global.subscriptionServer.quotaUnit === 'TB' ? 1024 ** 4 : 1024 ** 3);
    if (!Number.isSafeInteger(Math.round(quotaBytes)) || quotaBytes > 10 * 1024 ** 5) return t('deployments.errors.quotaTooLarge');
  }
  for (const inbound of form.inbounds) {
    if (inbound.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().length > 80) return t('deployments.errors.nodeNameTooLong');
    if (inbound.uuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(inbound.uuid)) return t('deployments.errors.protocolUuidInvalid', { protocol: protocolInfo(inbound.protocol).label });
    if (inbound.tlsMode && !tlsOptions(inbound).includes(inbound.tlsMode)) return t('deployments.errors.protocolTlsUnsupported', { protocol: protocolInfo(inbound.protocol).label });
  }
  if (compatibilityErrors.value.length) return compatibilityErrors.value[0];
  if (needsWarp.value && global.warp.provisioning === 'auto' && !global.warp.acceptedTerms) return t('deployments.errors.warpTerms');
  if (needsWarp.value && global.warp.provisioning === 'manual' && ((!global.warp.privateKey && !retainedSecrets.value) || !global.warp.peerPublicKey || (!global.warp.ipv4 && !global.warp.ipv6))) return t('deployments.errors.warpCredentials');
  if (edgeEnabled.value) {
    const selected = form.inbounds.filter(item => item.edgeMode !== 'direct');
    if (!selected.length) return t('deployments.errors.edgeInboundRequired');
    if (selected.some(item => !edgeTransportEligible(item))) return t('deployments.errors.edgeIncompatible');
    const addresses = global.edge.endpoints.map(item => item.address.trim().toLowerCase()).filter(Boolean);
    if (global.edge.endpoints.some(item => !item.address.trim())) return t('deployments.errors.edgeAddressRequired');
    if (new Set(addresses).size !== addresses.length) return t('deployments.errors.edgeAddressDuplicate');
    if (global.edge.mode !== 'quick' && !global.edge.hostname.trim()) return t('deployments.errors.edgeHostnameRequired');
    if (global.edge.mode === 'quick' && !global.edge.quickInboundId) return t('deployments.errors.quickInboundRequired');
    if (global.edge.mode === 'managed' && (!global.edge.cloudflare.accountId.trim() || (!global.edge.cloudflare.apiToken.trim() && !retainedSecrets.value))) return t('deployments.errors.edgeCredentialsRequired');
    if (strictManualCertificateConflict.value) return t('deployments.errors.strictCertificateRequired');
  }
  if (global.runtime.channel === 'pinned' && !global.runtime.version.trim()) return t('deployments.errors.pinnedVersion');
  return '';
}

function requestInstallCommand() {
  if (deploymentMode.value === 'uninstall') {
    if (!targetDeployment.value) return toast.showToast(t('deployments.errors.selectTarget'), 'warning');
    return generateActionCommand(targetDeployment.value, 'uninstall');
  }
  if (deploymentMode.value === 'update' && (!preparedUpdateTargetId.value || preparedUpdateTargetId.value !== targetDeploymentId.value)) return toast.showToast(t('deployments.errors.selectTarget'), 'warning');
  if (remoteUpdate.value && !targetDeployment.value?.agent?.online) return toast.showToast(t('deployments.remote.offline'), 'warning');
  const error = validateForm();
  if (error) return toast.showToast(error, 'warning');
  showRiskDialog.value = true;
}
async function generateInstallCommand() {
  showRiskDialog.value = false; loading.value = true;
  try {
    const defaults = serializeGlobal();
    let result;
    if (deploymentMode.value === 'update') {
      const payload = {
        name: form.name.trim(), nodeGroup: defaults.deployment?.nodeGroup || '', profileId: defaults.deployment?.profileId || '',
        configRevision: templateConfigRevision.value, config: buildConfig(defaults)
      };
      const action = reinstallMode.value ? 'reinstall' : 'update';
      result = remoteUpdate.value
        ? await createRemoteDeploymentCommand(preparedUpdateTargetId.value, 'update', payload)
        : await createDeploymentCommand(preparedUpdateTargetId.value, action, payload);
      selectedDeploymentId.value = preparedUpdateTargetId.value;
      if (remoteUpdate.value) {
        toast.showToast(t('deployments.remote.configQueued'), 'success');
        await refreshDeployments();
        activeTab.value = 'operations';
        await loadOperations(preparedUpdateTargetId.value);
        return;
      }
      toast.showToast(t(reinstallMode.value ? 'deployments.notices.reinstallCommandGenerated' : 'deployments.notices.updateCommandGenerated'), 'success');
    } else {
      result = await createDeployment({
        name: form.name.trim(), nodeGroup: defaults.deployment?.nodeGroup || '', profileId: defaults.deployment?.profileId || '', config: buildConfig(defaults),
        ...(templateSourceId.value ? {
          cloneFromDeploymentId: templateSourceId.value,
          configRevision: templateConfigRevision.value,
          resetInheritedNodeNames: true
        } : {})
      });
      selectedDeploymentId.value = result.data.deployment.id;
      toast.showToast(t('deployments.notices.commandGenerated'), 'success');
    }
    setCommand(result); await refreshDeployments();
  } catch (error) {
    const fallback = remoteUpdate.value ? t('deployments.remote.failed') : t('deployments.errors.generateCommand');
    const serviceCode = error?.data?.error || error?.data?.message || '';
    const serviceMessage = serviceCode === 'invalid_cloudflare_edge_credentials' || String(serviceCode).startsWith('cloudflare_edge_')
      ? edgePermissionErrorText(serviceCode)
      : '';
    toast.showToast(error?.status === 409 && (!remoteUpdate.value || error?.data?.error === 'REVISION_CONFLICT')
      ? t('deployments.errors.configRevisionConflict')
      : (serviceMessage || error?.data?.message || fallback), 'error');
  }
  finally { loading.value = false; }
}

async function refreshDeployments({ silent = false } = {}) {
  const requestId = ++deploymentRefreshRequest;
  if (!silent) loading.value = true;
  try {
    const result = await listDeployments();
    if (requestId !== deploymentRefreshRequest) return;
    deployments.value = result.data || [];
    if (!selectedDeploymentId.value && deployments.value[0]) selectedDeploymentId.value = deployments.value[0].id;
  } catch {
    if (!silent && requestId === deploymentRefreshRequest) toast.showToast(t('deployments.errors.loadDeployments'), 'error');
  }
  finally { if (!silent && requestId === deploymentRefreshRequest) loading.value = false; }
}
function pollDeploymentStatus() {
  if (document.hidden || loading.value || !deployments.value.some(item => !item.demo && ['pending', 'running'].includes(item.status))) return;
  refreshDeployments({ silent: true });
}
async function loadOperations(id = selectedDeploymentId.value) {
  if (!id || selectedDeployment.value?.migrationRequired) { operations.value = []; return; }
  loading.value = true;
  try { operations.value = (await listDeploymentOperations(id)).data || []; }
  catch { toast.showToast(t('deployments.errors.loadOperations'), 'error'); }
  finally { loading.value = false; }
}
function assignCommand(target, result) {
  target.curl = result.data.command;
  target.wget = result.data.wgetCommand;
  target.diagnosticCurl = result.data.diagnosticCommand || '';
  target.diagnosticWget = result.data.diagnosticWgetCommand || '';
  target.expiresAt = result.data.expiresAt;
  target.client = 'wget';
  target.diagnostic = false;
}
function setCommand(result) {
  assignCommand(output, result);
  activeTab.value = 'generator';
}
async function executeActionCommand(deployment, action) {
  loading.value = true;
  try {
    const result = await createDeploymentCommand(deployment.id, action);
    assignCommand(operationOutput, result);
    operationOutput.deploymentName = deployment.name;
    operationOutput.action = action;
    selectedDeploymentId.value = deployment.id;
    showOperationCommandModal.value = true;
    toast.showToast(t('deployments.notices.operationCommandGenerated'), 'success');
    if (action === 'uninstall') await refreshDeployments();
  }
  catch { toast.showToast(t('deployments.errors.generateCommand'), 'error'); }
  finally { loading.value = false; }
}
async function generateDirectConfigCommand(deployment) {
  loading.value = true;
  try {
    const action = deployment.reinstallable ? 'reinstall' : 'update';
    const result = await createDeploymentCommand(deployment.id, action);
    assignCommand(operationOutput, result);
    operationOutput.deploymentName = deployment.name;
    operationOutput.action = deployment.reinstallable ? 'reinstall' : 'plan';
    selectedDeploymentId.value = deployment.id;
    showOperationCommandModal.value = true;
    await refreshDeployments({ silent: true });
    toast.showToast(t('deployments.notices.operationCommandGenerated'), 'success');
  } catch (error) {
    toast.showToast(error?.data?.message || t('deployments.errors.generateCommand'), 'error');
  } finally { loading.value = false; }
}
async function generateDirectPendingCommand() {
  const deployment = pendingTemplateRecord.value;
  showLoadConfigDialog.value = false;
  pendingTemplateRecord.value = null;
  pendingTemplateRemote.value = false;
  if (deployment) await generateDirectConfigCommand(deployment);
}
function cancelOperationCommand() { pendingOperation.value = null; }
async function confirmOperationCommand() {
  const operation = pendingOperation.value;
  pendingOperation.value = null;
  if (operation) await executeActionCommand(operation.deployment, operation.action);
}
async function generateActionCommand(deployment, action) {
  if (deployment.migrationRequired) return toast.showToast(t('deployments.errors.v1Migration'), 'warning');
  if (confirmedOperationActions.has(action)) { pendingOperation.value = { deployment, action }; return; }
  await executeActionCommand(deployment, action);
}
function closeOperationCommandModal() {
  showOperationCommandModal.value = false;
  Object.assign(operationOutput, { curl: '', wget: '', diagnosticCurl: '', diagnosticWget: '', expiresAt: '', client: 'wget', diagnostic: false, deploymentName: '', action: '' });
}
async function generateRemoteCommand(deployment, action) {
  remoteMenuId.value = '';
  if (!capabilities.value.features.remoteCommands) return toast.showToast(t('deployments.remote.requiresD1'), 'warning');
  if (!deployment.agent?.online) return toast.showToast(t('deployments.remote.offline'), 'warning');
  if (action === 'uninstall') {
    const entered = window.prompt(t('deployments.remote.typeName', { name: deployment.name }), '');
    if (entered !== deployment.name) return;
  } else if (!window.confirm(t('deployments.remote.confirm', { action: t(`deployments.actions.${action}`), name: deployment.name }))) return;
  loading.value = true;
  try {
    await createRemoteDeploymentCommand(deployment.id, action);
    toast.showToast(t('deployments.remote.queued'), 'success');
    await refreshDeployments();
  } catch (error) { toast.showToast(error?.data?.message || t('deployments.remote.failed'), 'error'); }
  finally { loading.value = false; }
}

function guardRemoteMenu(event) {
  if (capabilities.value.features.remoteCommands) return;
  event.preventDefault();
  event.stopPropagation();
}
function toggleRemoteMenu(deployment, event) {
  event.preventDefault();
  if (!capabilities.value.features.remoteCommands) return guardRemoteMenu(event);
  remoteMenuId.value = remoteMenuId.value === deployment.id ? '' : deployment.id;
}
function closeActionMenusOnOutside(event) {
  if (!event.target?.closest?.('[data-remote-menu]')) remoteMenuId.value = '';
  if (!event.target?.closest?.('[data-preferred-preset-menu]')) preferredPresetMenuOpen.value = false;
}
async function connectLocalExecutor(deployment) {
  if (!window.confirm(t('deployments.remote.localConfirm', { name: deployment.name }))) return;
  loading.value = true;
  try {
    await provisionLocalExecutor(deployment.id);
    toast.showToast(t('deployments.remote.localProvisioned'), 'success');
    await refreshDeployments();
  } catch (error) { toast.showToast(error?.data?.message || t('deployments.remote.localFailed'), 'error'); }
  finally { loading.value = false; }
}
async function removeDeployment(deployment) {
  if (!window.confirm(t('deployments.confirm.deleteRecord', { name: deployment.name }))) return;
  const preserveResources = deployment.configSummary?.edge?.hasManagedResources === true;
  if (preserveResources && !window.confirm(t('deployments.confirm.preserveCloudflareResources'))) return;
  try { await deleteDeployment(deployment.id, preserveResources); selectedDeploymentId.value = ''; await refreshDeployments(); toast.showToast(t('deployments.notices.recordDeleted'), 'success'); }
  catch { toast.showToast(t('deployments.errors.deleteRecord'), 'error'); }
}
async function cleanupCloudflareResources(deployment) {
  const confirmation = window.prompt(t('deployments.confirm.cleanupCloudflareResources', { name: deployment.name }), '');
  if (confirmation !== deployment.name) return;
  loading.value = true;
  try {
    await cleanupDeploymentCloudflareResources(deployment.id, confirmation);
    await refreshDeployments();
    toast.showToast(t('deployments.notices.cloudflareResourcesCleaned'), 'success');
  } catch { toast.showToast(t('deployments.errors.cloudflareCleanup'), 'error'); }
  finally { loading.value = false; }
}
async function restoreSubscriptionSource(deployment) {
  loading.value = true;
  try {
    await restoreDeploymentSource(deployment.id);
    await Promise.all([refreshDeployments(), dataStore.fetchData(true)]);
    toast.showToast(t('deployments.notices.sourceRestored'), 'success');
  } catch {
    toast.showToast(t('deployments.errors.restoreSource'), 'error');
  } finally {
    loading.value = false;
  }
}
async function copyCommand() {
  try { await navigator.clipboard.writeText(shownCommand.value); toast.showToast(t('deployments.notices.commandCopied'), 'success'); }
  catch { toast.showToast(t('deployments.errors.copyCommand'), 'error'); }
}
async function copyOperationCommand() {
  try { await navigator.clipboard.writeText(shownOperationCommand.value); toast.showToast(t('deployments.notices.commandCopied'), 'success'); }
  catch { toast.showToast(t('deployments.errors.copyCommand'), 'error'); }
}
function closeOperationModalOnEscape(event) {
  if (event.key !== 'Escape') return;
  if (showOperationCommandModal.value) closeOperationCommandModal();
  else if (pendingOperation.value) cancelOperationCommand();
}
function statusClass(status) {
  return {
    succeeded: 'text-emerald-700 border-emerald-300 dark:border-emerald-400/35 dark:text-emerald-300',
    running: 'text-sky-700 border-sky-300 dark:border-sky-400/35 dark:text-sky-300',
    failed: 'text-red-700 border-red-300 dark:border-red-400/35 dark:text-red-300',
    offline: 'text-gray-500 border-gray-300 dark:border-white/15 dark:text-gray-400',
    pending: 'text-amber-700 border-amber-300 dark:border-amber-400/35 dark:text-amber-300',
    draft: 'text-violet-700 border-violet-300 dark:border-violet-400/35 dark:text-violet-300',
    expired: 'text-gray-500 border-gray-300 dark:border-white/15 dark:text-gray-400'
  }[status] || 'text-gray-600 border-gray-300 dark:border-white/15 dark:text-gray-300';
}
function statusText(status) { return t(`deployments.status.${status}`) === `deployments.status.${status}` ? status : t(`deployments.status.${status}`); }
function deploymentStatusText(deployment) {
  return deployment.pendingReason === 'config' && deployment.status === 'pending'
    ? t('deployments.status.configPending')
    : statusText(deployment.status);
}
function formatDate(value) { return value ? new Date(value).toLocaleString(locale.value) : ''; }
function operationHostname(operation) { return operation.hostname || selectedDeployment.value?.agent?.heartbeat?.hostname || '-'; }
function operationResult(operation) {
  if (operation.message) return operation.message;
  const events = Array.isArray(operation.events) ? operation.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.message) return events[index].message;
  }
  return '-';
}
function operationResources(operation) {
  const resources = operation.events?.at(-1)?.resources || {};
  const probe = resources.edgeProbe;
  if (probe) return `TLS ${probe.checks?.tls ? '✓' : '×'} · SNI ${probe.checks?.hostSni ? '✓' : '×'} · WS 101 ${probe.checks?.websocket101 ? '✓' : '×'} · ${probe.latencyMs || 0}ms`;
  return `${resources.tier || '-'} ${resources.rssMb || 0}/${resources.memoryMb || 0}MB`;
}
function switchTab(tab) { deploymentInfoPopoverKey.value = ''; activeTab.value = tab; if (tab === 'deployments') refreshDeployments(); if (tab === 'operations') loadOperations(); }
function openPushHistory(deployment) {
  pushHistoryRecord.value = deployment;
  showPushHistoryModal.value = true;
}

onMounted(async () => {
  document.addEventListener('click', closeActionMenusOnOutside);
  window.addEventListener('keydown', closeOperationModalOnEscape);
  const capabilityRequest = fetch('/api/system/capabilities').then(response => response.json()).then(result => {
    const data = result?.data;
    if (data && !Array.isArray(data) && data.features && typeof data.features === 'object') capabilities.value = data;
  }).catch(() => {});
  await Promise.all([refreshDeployments(), loadDefaults(), dataStore.fetchData(), capabilityRequest]);
  deploymentPollTimer = window.setInterval(pollDeploymentStatus, deploymentPollIntervalMs);
});
onBeforeUnmount(() => {
  clearTimeout(edgeDetectionTimer);
  clearInterval(deploymentPollTimer);
  edgeDetectionRequest += 1;
  document.removeEventListener('click', closeActionMenusOnOutside);
  window.removeEventListener('keydown', closeOperationModalOnEscape);
});
</script>

<template>
  <div class="deployments-page mx-auto max-w-(--breakpoint-xl) space-y-4">
    <header data-testid="deployment-page-header" class="deployment-surface flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0"><h1 class="text-xl font-bold text-gray-900 dark:text-white">{{ t('deployments.title') }}</h1><p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('deployments.subtitle') }}</p></div>
      <span class="w-fit shrink-0 rounded-full bg-gray-100 px-2.5 py-1 font-mono text-xs font-medium text-gray-500 dark:bg-white/10 dark:text-gray-300">TSub Proxy v{{ RUNTIME_VERSION }}</span>
    </header>

    <div data-testid="deployment-tabs" class="deployment-surface flex gap-1 overflow-x-auto p-1.5" role="tablist">
      <button v-for="tab in tabs" :key="tab.id" type="button" class="min-h-10 shrink-0 border px-4 text-sm font-semibold transition-colors" :class="activeTab === tab.id ? 'border-primary-200 bg-primary-50 text-primary-700 hover:border-primary-300 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300 dark:hover:bg-primary-500/20' : 'border-transparent text-gray-500 hover:border-gray-200 hover:bg-gray-50 hover:text-gray-800 dark:hover:border-white/10 dark:hover:bg-white/5 dark:hover:text-gray-200'" @click="switchTab(tab.id)">{{ tab.label }}</button>
    </div>

    <template v-if="activeTab === 'generator'">
      <section class="grid gap-5" :class="remoteUpdate ? 'xl:grid-cols-1' : 'xl:grid-cols-[minmax(0,1fr)_360px]'">
        <form class="deployment-form min-w-0 space-y-5" @submit.prevent="requestInstallCommand">
          <section data-testid="deployment-mode-settings" class="deployment-surface space-y-4 p-4">
            <div>
              <h2 class="text-sm font-semibold">{{ t('deployments.modeTitle') }}</h2>
              <p class="mt-1 text-xs leading-5 text-gray-500">{{ t('deployments.modeHint') }}</p>
            </div>
            <div class="grid gap-2 sm:grid-cols-3" role="radiogroup" :aria-label="t('deployments.modeTitle')">
              <button v-for="option in deploymentModeOptions" :key="option.value" type="button" class="min-h-11 border px-4 text-sm font-semibold" :class="deploymentMode === option.value ? 'border-primary-300 bg-primary-50 text-primary-700 dark:border-primary-400/40 dark:bg-primary-500/15 dark:text-primary-200' : 'deploy-btn-neutral'" :aria-pressed="deploymentMode === option.value" :data-testid="`deployment-mode-${option.value}`" @click="setDeploymentMode(option.value)">{{ option.label }}</button>
            </div>
            <label v-if="deploymentMode !== 'install'" class="block text-sm font-medium">
              {{ t('deployments.targetDeployment') }}
              <select :value="targetDeploymentId" data-testid="target-deployment-select" class="mt-1 w-full border bg-transparent px-3 py-2.5" @change="selectTargetDeployment">
                <option value="">{{ t('deployments.pleaseSelect') }}</option>
                <option v-for="deployment in eligibleDeployments" :key="deployment.id" :value="deployment.id">{{ deployment.name }}</option>
              </select>
            </label>
            <div v-if="deploymentMode === 'uninstall' && targetDeployment" data-testid="uninstall-target-summary" class="rounded-lg border border-red-200 bg-red-50/70 p-3 text-sm text-red-800 dark:border-red-400/25 dark:bg-red-500/10 dark:text-red-200">
              <p class="font-semibold">{{ targetDeployment.name }}</p>
              <p class="mt-1 text-xs opacity-80">{{ targetDeployment.configSummary?.runtime?.core || '-' }} · {{ targetDeployment.configSummary?.protocols?.map(item => `${item.protocol}:${item.port}`).join(' · ') || t('deployments.noProtocolSummary') }}</p>
            </div>
            <p v-if="deploymentMode === 'update' && !showEditableConfig" class="text-xs leading-5 text-gray-500">{{ t('deployments.updateSelectHint') }}</p>
            <p v-if="deploymentMode === 'install' && templateSourceId" data-testid="reuse-config-notice" class="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs leading-5 text-sky-800 dark:border-sky-400/25 dark:bg-sky-500/10 dark:text-sky-200">{{ t('deployments.reuseNotice') }}</p>
          </section>

          <template v-if="showEditableConfig">
          <div data-testid="deployment-basic-settings" class="deployment-surface grid gap-3 p-4 sm:grid-cols-2">
            <label class="text-sm font-medium">{{ t('deployments.fields.name') }}<input v-model="form.name" required class="keep-square mt-1 w-full border bg-transparent px-3 py-2.5" placeholder="HK Edge" /></label>
            <div class="text-sm font-medium">
              <DeploymentHelpLabel for-id="deployment-hostname" :label="t('deployments.fields.hostname')" :help="t('deployments.help.hostname')" :open="deploymentInfoPopoverKey === generatorHelpKey('hostname')" test-id="deployment-hostname-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('hostname'), value)" />
              <input id="deployment-hostname" v-model="form.hostname" class="keep-square mt-1 w-full border bg-transparent px-3 py-2.5" :placeholder="t('deployments.placeholders.hostname')" />
            </div>
            <div class="text-sm font-medium sm:col-span-2">
              <DeploymentHelpLabel for-id="deployment-address-mode" :label="t('deployments.fields.addressMode')" :help="t('deployments.help.addressMode')" :open="deploymentInfoPopoverKey === generatorHelpKey('address-mode')" test-id="deployment-address-mode-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('address-mode'), value)" />
              <select id="deployment-address-mode" v-model="global.deployment.addressMode" data-testid="deployment-address-mode" :disabled="Boolean(form.hostname.trim())" class="mt-1 w-full border bg-transparent px-3 py-2.5 disabled:cursor-not-allowed disabled:opacity-50"><option value="auto">{{ t('deployments.options.addressAuto') }}</option><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option><option value="dual">IPv4 + IPv6</option></select>
              <span v-if="form.hostname.trim()" class="mt-1 block text-xs text-gray-500">{{ t('deployments.placeholders.manualAddressPriority') }}</span>
            </div>
          </div>

          <section data-testid="deployment-control-command" class="deployment-surface overflow-hidden">
            <div class="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between">
              <div class="min-w-0 flex-1"><h2 class="text-sm font-semibold">{{ t('deployments.controlCommand.title') }}</h2><p class="mt-1 text-xs leading-5 text-gray-500">{{ t('deployments.controlCommand.hint') }}</p></div>
              <label class="w-full shrink-0 text-sm font-medium sm:w-64">{{ t('deployments.controlCommand.label') }}<input v-model="form.controlCommand" data-testid="control-command-input" type="text" maxlength="32" autocomplete="off" spellcheck="false" class="mt-1 w-full border bg-transparent px-3 py-2 font-mono" placeholder="tsub" /></label>
            </div>

            <div data-testid="deployment-runtime-settings" class="space-y-3 border-t p-4 dark:border-white/10">
              <div><h3 class="text-sm font-semibold">{{ t('deployments.runtime.title') }}</h3><p class="mt-0.5 text-xs leading-5 text-gray-500">{{ t('deployments.runtime.subtitle') }}</p></div>
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div class="text-sm"><DeploymentHelpLabel for-id="deployment-resource-tier" :label="t('deployments.fields.resourceTier')" :help="resourceTierHelp" :open="deploymentInfoPopoverKey === generatorHelpKey('resource-tier')" test-id="deployment-resource-tier-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('resource-tier'), value)" /><select id="deployment-resource-tier" v-model="global.runtime.tier" class="mt-1 w-full border bg-transparent px-2 py-2"><option v-for="([value,label]) in RESOURCE_TIERS" :key="value" :value="value">{{ label.startsWith('deployments.') ? t(label) : label }}</option></select></div>
                <div class="text-sm"><DeploymentHelpLabel for-id="deployment-core-channel" :label="t('deployments.fields.coreChannel')" :help="t('deployments.help.coreChannel')" :open="deploymentInfoPopoverKey === generatorHelpKey('core-channel')" test-id="deployment-core-channel-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('core-channel'), value)" /><select id="deployment-core-channel" v-model="global.runtime.channel" class="mt-1 w-full border bg-transparent px-2 py-2"><option value="stable">{{ t('deployments.options.stable') }}</option><option value="latest">{{ t('deployments.options.latest') }}</option><option value="pinned">{{ t('deployments.options.pinned') }}</option></select></div>
                <label v-if="global.runtime.channel === 'pinned'" class="text-sm">{{ t('deployments.fields.coreVersion') }}<input v-model="global.runtime.version" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <div class="text-sm"><DeploymentHelpLabel for-id="agent-poll-interval" :label="t('deployments.fields.agentPollInterval')" :help="t('deployments.help.agentPollInterval')" :open="deploymentInfoPopoverKey === generatorHelpKey('agent-poll-interval')" test-id="agent-poll-interval-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('agent-poll-interval'), value)" /><select id="agent-poll-interval" v-model.number="global.runtime.agentPollIntervalSeconds" data-testid="agent-poll-interval" class="mt-1 w-full border bg-transparent px-2 py-2"><option v-for="seconds in [15,30,60,120,180,300]" :key="seconds" :value="seconds">{{ t('deployments.options.seconds', { seconds }) }}</option></select></div>
              </div>
            </div>

            <div data-testid="vps-subscription-settings" class="space-y-3 border-t p-4 dark:border-white/10">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div><h3 class="text-sm font-semibold">{{ t('deployments.subscription.title') }}</h3><p class="mt-0.5 text-xs text-gray-500">{{ t('deployments.subscription.subtitle') }}</p></div>
                <div class="flex flex-wrap gap-x-5 gap-y-2">
                  <label class="flex min-h-9 items-center gap-2 text-sm"><input v-model="global.subscriptionServer.enabled" data-testid="vps-subscription-enabled" type="checkbox" />{{ t('deployments.subscription.enable') }}</label>
                  <div class="flex min-h-9 items-center gap-1"><input id="vps-traffic-enabled" v-model="global.subscriptionServer.trafficEnabled" data-testid="vps-traffic-enabled" type="checkbox" :disabled="!global.subscriptionServer.enabled" /><DeploymentHelpLabel class="text-sm" for-id="vps-traffic-enabled" :label="t('deployments.subscription.traffic')" :help="t('deployments.help.trafficEnabled')" :open="deploymentInfoPopoverKey === generatorHelpKey('traffic-enabled')" test-id="vps-traffic-enabled-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('traffic-enabled'), value)" /></div>
                  <div class="flex min-h-9 items-center gap-1"><input id="vps-push-enabled" v-model="global.subscriptionServer.pushEnabled" data-testid="vps-push-enabled" type="checkbox" :disabled="!global.subscriptionServer.enabled" /><DeploymentHelpLabel class="text-sm" for-id="vps-push-enabled" :label="t('deployments.subscription.push')" :help="t('deployments.help.pushEnabled')" :open="deploymentInfoPopoverKey === generatorHelpKey('push-enabled')" test-id="vps-push-enabled-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('push-enabled'), value)" /></div>
                </div>
              </div>
              <div class="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label class="min-w-0 text-sm">{{ t('deployments.subscription.port') }}<input v-model="global.subscriptionServer.port" :disabled="!global.subscriptionServer.enabled" inputmode="numeric" class="mt-1 w-full border bg-transparent px-2 py-2 disabled:opacity-50" :placeholder="t('deployments.placeholders.random')" /></label>
                <div class="min-w-0 text-sm sm:col-span-2"><DeploymentHelpLabel for-id="vps-subscription-token" :label="t('deployments.subscription.token')" :help="t('deployments.help.subscriptionToken')" :open="deploymentInfoPopoverKey === generatorHelpKey('subscription-token')" test-id="vps-subscription-token-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('subscription-token'), value)" /><div class="relative mt-1 min-w-0"><input id="vps-subscription-token" v-model="global.subscriptionServer.token" :disabled="!global.subscriptionServer.enabled" type="text" autocomplete="off" class="w-full border bg-transparent py-2 pl-2 pr-16 font-mono disabled:opacity-50" :placeholder="retainedSecrets ? t('deployments.placeholders.retainOriginalSecret') : t('deployments.placeholders.subscriptionToken')" /><button data-testid="generate-subscription-token" type="button" class="absolute inset-y-px right-px border-0 border-l bg-gray-50 px-3 text-xs font-medium text-primary-600 hover:bg-primary-50 disabled:opacity-50 dark:bg-gray-900 dark:hover:bg-white/10" :disabled="!global.subscriptionServer.enabled" :title="t('deployments.subscription.generateToken')" @click="generateSubscriptionToken">{{ t('deployments.generate') }}</button></div></div>
                <div class="min-w-0 text-sm"><DeploymentHelpLabel for-id="vps-traffic-quota" :label="t('deployments.subscription.quota')" :help="t('deployments.help.trafficQuota')" :open="deploymentInfoPopoverKey === generatorHelpKey('traffic-quota')" test-id="vps-traffic-quota-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('traffic-quota'), value)" /><div class="mt-1 flex min-w-0"><input id="vps-traffic-quota" v-model="global.subscriptionServer.quotaValue" :disabled="!global.subscriptionServer.enabled || !global.subscriptionServer.trafficEnabled" type="number" min="0" step="0.01" class="min-w-0 flex-1 border bg-transparent px-2 py-2 disabled:opacity-50" :placeholder="t('deployments.subscription.unlimited')" /><select v-model="global.subscriptionServer.quotaUnit" :aria-label="t('deployments.subscription.quota')" :disabled="!global.subscriptionServer.enabled || !global.subscriptionServer.trafficEnabled" class="shrink-0 border border-l-0 bg-transparent px-2 disabled:opacity-50"><option value="GB">GB</option><option value="TB">TB</option></select></div></div>
                <label v-if="global.subscriptionServer.pushEnabled" class="min-w-0 text-sm">{{ t('deployments.subscription.interval') }}<select v-model.number="global.subscriptionServer.pushIntervalMinutes" data-testid="vps-push-interval" :disabled="!global.subscriptionServer.enabled" class="mt-1 w-full border bg-transparent px-2 py-2 disabled:opacity-50"><option v-for="minutes in [5,15,30,60]" :key="minutes" :value="minutes">{{ t('deployments.subscription.minutes', { minutes }) }}</option></select></label>
                <div v-if="global.subscriptionServer.pushEnabled" class="min-w-0 text-sm"><DeploymentHelpLabel for-id="push-address-mode" :label="t('deployments.subscription.pushAddressMode')" :help="t('deployments.help.pushAddressMode')" :open="deploymentInfoPopoverKey === generatorHelpKey('push-address-mode')" test-id="push-address-mode-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('push-address-mode'), value)" /><select id="push-address-mode" v-model="global.subscriptionServer.pushAddressMode" data-testid="push-address-mode" :disabled="!global.subscriptionServer.enabled" class="mt-1 w-full border bg-transparent px-2 py-2 disabled:opacity-50"><option value="auto">{{ t('deployments.options.addressAuto') }}</option><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option></select></div>
              </div>
              <p class="text-xs leading-5 text-gray-500">{{ global.subscriptionServer.pushEnabled ? t('deployments.subscription.pushHint', { minutes: global.subscriptionServer.pushIntervalMinutes }) : t('deployments.subscription.snapshotHint') }}</p>
            </div>
          </section>

          <section data-testid="deployment-global-settings" class="deployment-surface overflow-hidden">
            <div class="space-y-3 p-4">
              <div class="flex items-center justify-between gap-3"><h2 class="text-sm font-semibold">{{ t('deployments.globalConfig') }}</h2><button type="button" class="deploy-btn-neutral min-h-9 border px-3 text-sm" :aria-expanded="globalOpen" @click="globalOpen = !globalOpen"><span>{{ t('deployments.moreSettings') }}</span><span class="ml-1" aria-hidden="true">{{ globalOpen ? '−' : '+' }}</span></button></div>
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div class="text-sm"><div class="flex items-center justify-between gap-2"><DeploymentHelpLabel for-id="global-uuid" :label="t('deployments.fields.sharedUuid')" :help="t('deployments.help.sharedUuid')" :open="deploymentInfoPopoverKey === generatorHelpKey('shared-uuid')" test-id="shared-uuid-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('shared-uuid'), value)" /><label class="flex items-center gap-1.5 text-xs text-gray-500"><input v-model="global.credentials.sharedUuidEnabled" data-testid="shared-uuid-enabled" type="checkbox" />{{ t('deployments.fields.sharedUuidEnabled') }}</label></div><div class="relative mt-1"><input id="global-uuid" v-model="global.credentials.uuid" data-testid="global-uuid" type="text" autocomplete="off" class="w-full border bg-transparent py-2 pl-2 pr-16 font-mono disabled:cursor-not-allowed disabled:opacity-50" :disabled="!global.credentials.sharedUuidEnabled" :placeholder="retainedSecrets ? t('deployments.placeholders.retainOriginalSecret') : (global.credentials.sharedUuidEnabled ? t('deployments.placeholders.sharedUuid') : t('deployments.placeholders.independentUuid'))" /><button data-testid="generate-global-uuid" type="button" class="absolute inset-y-px right-px border-0 border-l bg-gray-50 px-3 text-xs font-medium text-primary-600 hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-gray-900 dark:hover:bg-white/10" :disabled="!global.credentials.sharedUuidEnabled" :title="t('deployments.generateUuid')" @click="generateUuid(global.credentials)">{{ t('deployments.generate') }}</button></div></div>
                <div class="text-sm"><DeploymentHelpLabel for-id="global-certificate-mode" :label="t('deployments.fields.certificateMode')" :help="t('deployments.help.certificateMode')" :open="deploymentInfoPopoverKey === generatorHelpKey('certificate-mode')" test-id="certificate-mode-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('certificate-mode'), value)" /><select id="global-certificate-mode" v-model="global.certificate.mode" data-testid="global-certificate-mode" class="mt-1 w-full border bg-transparent px-2 py-2" @change="updateCertificateMode"><option value="self-signed">{{ t('deployments.options.selfSigned') }}</option><option value="existing">{{ t('deployments.options.existingCertificate') }}</option><option value="acme-http01">ACME HTTP-01</option><option value="cloudflare-dns01">Cloudflare DNS-01</option></select></div>
                <div class="text-sm"><DeploymentHelpLabel for-id="global-runtime-core" :label="t('deployments.fields.core')" :help="t('deployments.help.core')" :open="deploymentInfoPopoverKey === generatorHelpKey('core')" test-id="global-core-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('core'), value)" /><select id="global-runtime-core" v-model="global.runtime.core" data-testid="global-runtime-core" class="mt-1 w-full border bg-transparent px-2 py-2" @change="updateCore"><option value="auto">{{ t('deployments.options.autoCore') }}</option><option value="xray">Xray</option><option value="sing-box">sing-box</option></select></div>
              </div>
            </div>
            <div v-if="globalOpen" class="space-y-5 border-t p-4 dark:border-white/10">
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div class="text-sm"><div class="flex items-center justify-between gap-2"><DeploymentHelpLabel for-id="global-password" :label="t('deployments.fields.sharedPassword')" :help="t('deployments.help.sharedPassword')" :open="deploymentInfoPopoverKey === generatorHelpKey('shared-password')" test-id="shared-password-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('shared-password'), value)" /><label class="flex items-center gap-1.5 text-xs text-gray-500"><input v-model="global.credentials.sharedPasswordEnabled" data-testid="shared-password-enabled" type="checkbox" />{{ t('deployments.fields.sharedPasswordEnabled') }}</label></div><SecretInput v-model="global.credentials.password" class="mt-1" autocomplete="new-password" :disabled="!global.credentials.sharedPasswordEnabled" :placeholder="retainedSecrets ? t('deployments.placeholders.retainOriginalSecret') : (global.credentials.sharedPasswordEnabled ? t('deployments.placeholders.sharedPassword') : t('deployments.placeholders.independentPassword'))" allow-generate input-id="global-password" input-testid="global-password" toggle-testid="toggle-global-password" generate-testid="generate-global-password" @generate="generatePassword(global.credentials)" /></div>
                <label class="text-sm">{{ t('deployments.fields.username') }}<input v-model="global.credentials.username" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <label class="text-sm">{{ t('deployments.fields.randomPortMin') }}<input v-model.number="global.randomPorts.min" data-testid="global-random-port-min" type="number" min="1" max="65535" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <label class="text-sm">{{ t('deployments.fields.randomPortMax') }}<input v-model.number="global.randomPorts.max" data-testid="global-random-port-max" type="number" min="1" max="65535" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <label class="text-sm">{{ t('deployments.fields.namePrefix') }}<input v-model="global.deployment.namePrefix" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <div class="text-sm"><DeploymentHelpLabel for-id="node-name-mode" :label="t('deployments.fields.nodeNameMode')" :help="t('deployments.help.nodeNameMode')" :open="deploymentInfoPopoverKey === generatorHelpKey('node-name-mode')" test-id="node-name-mode-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('node-name-mode'), value)" /><select id="node-name-mode" v-model="global.deployment.nodeNameMode" data-testid="node-name-mode" class="mt-1 w-full border bg-transparent px-2 py-2"><option value="deployment-protocol-port">{{ t('deployments.options.nodeNameDeployment') }}</option><option value="prefix-protocol-port">{{ t('deployments.options.nodeNamePrefix') }}</option><option value="protocol-random">{{ t('deployments.options.nodeNameRandom') }}</option></select></div>
                <label class="text-sm">{{ t('deployments.fields.nodeGroup') }}<input v-model="global.deployment.nodeGroup" data-testid="global-node-group" class="mt-1 w-full border bg-transparent px-2 py-2" :placeholder="t('deployments.placeholders.nodeGroup')" /></label>
                <div class="text-sm"><DeploymentHelpLabel for-id="global-profile" :label="t('deployments.fields.profile')" :help="t('deployments.help.profile')" :open="deploymentInfoPopoverKey === generatorHelpKey('profile')" test-id="global-profile-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('profile'), value)" /><select id="global-profile" v-model="global.deployment.profileId" data-testid="global-profile" class="mt-1 w-full border bg-transparent px-2 py-2"><option value="">{{ t('deployments.options.notLinked') }}</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option></select></div>
              </div>

              <div class="grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-white/10">
                <div class="text-sm"><DeploymentHelpLabel for-id="global-shared-transport" :label="t('deployments.fields.sharedTransport')" :help="t('deployments.help.sharedTransport')" :open="deploymentInfoPopoverKey === generatorHelpKey('shared-transport')" test-id="shared-transport-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('shared-transport'), value)" /><select id="global-shared-transport" v-model="global.common.transport" data-testid="global-shared-transport" class="mt-1 w-full border bg-transparent px-2 py-2"><option value="">{{ t('deployments.options.protocolDefault') }}</option><option v-for="([value,label]) in TRANSPORT_OPTIONS" :key="value" :value="value">{{ label }}</option></select><p v-if="sharedTransportScope" data-testid="shared-transport-scope" class="mt-1 text-xs leading-5 text-gray-500">{{ sharedTransportScope }}</p></div>
                <div class="text-sm"><DeploymentHelpLabel for-id="global-shared-tls" :label="t('deployments.fields.sharedTls')" :help="t('deployments.help.sharedTls')" :open="deploymentInfoPopoverKey === generatorHelpKey('shared-tls')" test-id="shared-tls-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('shared-tls'), value)" /><select id="global-shared-tls" v-model="global.common.tlsMode" data-testid="global-shared-tls" class="mt-1 w-full border bg-transparent px-2 py-2"><option value="">{{ t('deployments.options.protocolDefault') }}</option><option value="none">{{ t('deployments.options.noTls') }}</option><option value="tls">TLS</option><option value="reality">Reality</option></select><p v-if="sharedTlsScope" data-testid="shared-tls-scope" class="mt-1 text-xs leading-5 text-gray-500">{{ sharedTlsScope }}</p></div>
                <div class="text-sm"><DeploymentHelpLabel for-id="global-shared-outbound" :label="t('deployments.fields.sharedOutbound')" :help="t('deployments.help.sharedOutbound')" :open="deploymentInfoPopoverKey === generatorHelpKey('shared-outbound')" test-id="shared-outbound-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('shared-outbound'), value)" /><select id="global-shared-outbound" v-model="global.common.outbound" data-testid="global-shared-outbound" class="mt-1 w-full border bg-transparent px-2 py-2"><option value="">{{ t('deployments.options.protocolDefault') }}</option><option v-for="([value,label]) in OUTBOUND_OPTIONS" :key="value" :value="value">{{ label.startsWith('deployments.') ? t(label) : label }}</option></select></div>
                <div class="text-sm"><DeploymentHelpLabel for-id="global-shared-server-name" :label="t('deployments.fields.sharedServerName')" :help="t('deployments.help.sharedServerName')" :open="deploymentInfoPopoverKey === generatorHelpKey('shared-server-name')" test-id="shared-server-name-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('shared-server-name'), value)" /><input id="global-shared-server-name" v-model="global.common.serverName" class="mt-1 w-full border bg-transparent px-2 py-2" :placeholder="t('deployments.placeholders.protocolBuiltin')" @input="updateSharedServerName" /></div>
              </div>

              <div class="grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3 dark:border-white/10">
                <label v-if="['acme-http01','cloudflare-dns01'].includes(global.certificate.mode)" class="text-sm" for="global-acme-email">{{ t('deployments.fields.acmeEmail') }}<input id="global-acme-email" v-model="global.certificate.email" type="email" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <label v-if="global.certificate.mode === 'cloudflare-dns01'" class="text-sm" for="global-certificate-api-token">{{ t('deployments.fields.cloudflareApiToken') }}<SecretInput v-model="global.certificate.apiToken" class="mt-1" input-id="global-certificate-api-token" :placeholder="retainedSecrets ? t('deployments.placeholders.retainOriginalSecret') : ''" /></label>
                <label v-if="global.certificate.mode === 'existing'" class="text-sm">{{ t('deployments.fields.certificatePath') }}<input v-model="global.certificate.certificatePath" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <label v-if="global.certificate.mode === 'existing'" class="text-sm">{{ t('deployments.fields.keyPath') }}<SecretInput v-model="global.certificate.keyPath" class="mt-1" /></label>
                <div class="text-sm"><DeploymentHelpLabel for-id="global-firewall-mode" :label="t('deployments.fields.firewall')" :help="t('deployments.help.firewall')" :open="deploymentInfoPopoverKey === generatorHelpKey('firewall')" test-id="firewall-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('firewall'), value)" /><select id="global-firewall-mode" v-model="global.firewall.enabled" data-testid="global-firewall-mode" class="mt-1 w-full border bg-transparent px-2 py-2"><option :value="true">{{ t('deployments.options.firewallAuto') }}</option><option :value="false">{{ t('deployments.options.firewallOff') }}</option></select></div>
              </div>

            </div>
            <div data-testid="deployment-global-actions" class="flex flex-wrap gap-2 border-t p-4 dark:border-white/10">
              <button data-testid="save-deployment-defaults" type="button" class="deploy-btn-neutral min-h-10 border px-4 text-sm" :disabled="defaultsLoading" @click="saveGlobal">{{ t('deployments.saveSystemDefault') }}</button>
              <button data-testid="reset-deployment-defaults" type="button" class="deploy-btn-danger min-h-10 border border-red-200 px-4 text-sm text-red-600" :disabled="defaultsLoading" @click="resetGlobal">{{ t('common.reset') }}</button>
            </div>
          </section>

          <section ref="warpSettingsRef" data-testid="edge-warp-settings" class="deployment-surface overflow-hidden">
            <div class="space-y-1 p-4"><h2 class="text-sm font-semibold">{{ t('deployments.edge.title') }}</h2><p class="text-xs leading-5 text-gray-500">{{ t('deployments.edge.subtitle') }}</p></div>
            <div class="grid gap-3 border-t p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-white/10">
              <div class="text-sm"><DeploymentHelpLabel for-id="edge-mode" :label="t('deployments.edge.mode')" :help="t('deployments.help.edgeMode')" :open="deploymentInfoPopoverKey === generatorHelpKey('edge-mode')" test-id="edge-mode-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('edge-mode'), value)" /><select id="edge-mode" v-model="global.edge.mode" data-testid="edge-mode" class="mt-1 w-full border bg-transparent px-2 py-2" @focus="rememberEdgeMode" @pointerdown="rememberEdgeMode" @change="updateEdgeMode"><option value="disabled">{{ t('common.disabled') }}</option><option value="manual">{{ t('deployments.edge.manual') }}</option><option value="quick">{{ t('deployments.edge.quick') }}</option><option value="managed">{{ t('deployments.edge.managed') }}</option></select></div>
              <label v-if="['manual','managed'].includes(global.edge.mode)" class="text-sm sm:col-span-2">{{ t('deployments.edge.hostname') }}<input v-model="global.edge.hostname" data-testid="edge-hostname" class="mt-1 w-full border bg-transparent px-2 py-2" placeholder="cdn.example.com" @input="invalidateEdgeDetection" /></label>
              <div v-if="global.edge.mode === 'quick'" class="text-sm sm:col-span-2"><DeploymentHelpLabel for-id="quick-inbound" :label="t('deployments.edge.quickInbound')" :help="t('deployments.help.quickInbound')" :open="deploymentInfoPopoverKey === generatorHelpKey('quick-inbound')" test-id="quick-inbound-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('quick-inbound'), value)" /><select id="quick-inbound" v-model="global.edge.quickInboundId" data-testid="quick-inbound" class="mt-1 w-full border bg-transparent px-2 py-2" @change="updateQuickInbound"><option value="">{{ quickInboundCandidates.length ? t('deployments.pleaseSelect') : t('deployments.edge.noQuickInbound') }}</option><option v-for="item in quickInboundCandidates" :key="item.id" :value="item.id">{{ item.name || protocolInfo(item.protocol).label }} · {{ item.port || t('deployments.placeholders.randomPort') }}</option></select><button v-if="!quickInboundCandidates.length" type="button" class="mt-1 text-xs font-medium text-primary-600 underline underline-offset-2 dark:text-primary-400" data-testid="open-quick-inbound-dialog" @click="showQuickInboundDialog = true">{{ t('deployments.edge.configureQuickInbound') }}</button></div>
              <p v-if="global.edge.mode === 'quick'" class="self-end text-xs leading-5 text-amber-700 dark:text-amber-300">{{ t('deployments.edge.quickHint') }}</p>
            </div>
            <p v-if="['quick','managed'].includes(global.edge.mode)" data-testid="tunnel-memory-recommendation" class="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200">{{ t('deployments.edge.memoryRecommendation') }}</p>

            <div v-if="edgeEnabled" class="space-y-3 border-t p-4 dark:border-white/10">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0 grow"><div class="flex items-center"><h3 class="text-sm font-semibold">{{ t('deployments.edge.endpoints') }}</h3><DeploymentInfoPopover :open="deploymentInfoPopoverKey === generatorHelpKey('edge-endpoints')" :label="t('deployments.edge.endpoints')" test-id="edge-endpoints-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('edge-endpoints'), value)"><span>{{ t('deployments.help.endpoints') }}</span></DeploymentInfoPopover></div><p class="mt-0.5 text-xs text-gray-500">{{ t('deployments.edge.endpointsHint') }}</p></div>
                <div class="flex shrink-0 items-center gap-2">
                  <div data-preferred-preset-menu class="relative">
                    <button data-testid="preferred-domain-preset-trigger" type="button" class="deploy-btn-neutral inline-flex min-h-9 items-center border px-3 text-sm" :disabled="global.edge.endpoints.length >= 10" :aria-expanded="preferredPresetMenuOpen" aria-haspopup="menu" @click="preferredPresetMenuOpen = !preferredPresetMenuOpen">{{ t('deployments.edge.domainPresets') }}</button>
                    <div v-if="preferredPresetMenuOpen" data-testid="preferred-domain-preset-menu" class="absolute right-0 z-40 mt-1 grid min-w-72 gap-1 rounded-lg border border-gray-200 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-gray-900" role="menu">
                      <button v-for="preset in PREFERRED_DOMAIN_PRESETS" :key="preset.key" type="button" class="deploy-btn-neutral flex min-h-12 flex-col items-start justify-center border px-3 py-1.5 text-left" role="menuitem" @click="importPreferredDomain(preset.key)">
                        <span class="text-xs font-medium">{{ t(`deployments.edge.domainPresetLabels.${preset.key}`) }}</span>
                        <span class="mt-0.5 font-mono text-[11px] text-gray-500 dark:text-gray-400">{{ preset.address }}</span>
                      </button>
                    </div>
                  </div>
                  <button data-testid="add-edge-endpoint" type="button" class="deploy-btn-neutral min-h-9 border px-3 text-sm" :disabled="global.edge.endpoints.length >= 10" @click="addEdgeEndpoint">{{ t('deployments.edge.addPreferred') }}</button>
                </div>
              </div>
              <div v-if="!global.edge.endpoints.length" class="flex items-center justify-between gap-3 border border-dashed p-3 text-xs text-gray-500"><span>{{ t('deployments.edge.endpointFallback') }}</span><button type="button" data-testid="probe-edge-hostname" class="deploy-btn-neutral min-h-9 shrink-0 border px-3 text-xs" :disabled="edgeProbeBusyId || !targetDeployment || !edgeProbeInbound" :title="t('deployments.edge.probeSavedRequired')" @click="probePreferredEndpoint()">{{ t('deployments.edge.probe') }}</button></div>
              <div v-for="(endpoint, endpointIndex) in global.edge.endpoints" :key="endpoint.id" class="grid gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_7rem_auto_auto] sm:items-end">
                <label class="text-xs text-gray-500">{{ t('deployments.edge.label') }}<input v-model="endpoint.label" :data-testid="`edge-endpoint-label-${endpointIndex}`" maxlength="24" class="mt-1 w-full border bg-transparent px-2 py-2 text-sm text-gray-900 dark:text-white" /></label>
                <label class="text-xs text-gray-500">{{ t('deployments.edge.address') }}<input v-model="endpoint.address" :data-testid="`edge-endpoint-address-${endpointIndex}`" class="mt-1 w-full border bg-transparent px-2 py-2 font-mono text-sm text-gray-900 dark:text-white" placeholder="198.51.100.10" /></label>
                <label class="text-xs text-gray-500">{{ t('deployments.edge.port') }}<input v-model="endpoint.port" inputmode="numeric" class="mt-1 w-full border bg-transparent px-2 py-2 text-sm text-gray-900 dark:text-white" :placeholder="global.edge.mode === 'manual' ? t('deployments.edge.inboundPort') : '443'" /></label>
                <button type="button" :data-testid="`probe-edge-endpoint-${endpointIndex}`" class="deploy-btn-neutral min-h-10 border px-3 text-xs" :disabled="Boolean(edgeProbeBusyId) || !targetDeployment || !edgeProbeInbound" :title="t('deployments.edge.probeSavedRequired')" @click="probePreferredEndpoint(endpoint)">{{ edgeProbeBusyId === endpoint.id ? t('common.loading') : t('deployments.edge.probe') }}</button>
                <button type="button" class="deploy-btn-danger min-h-10 border border-red-200 px-3 text-lg text-red-600" :aria-label="t('actions.delete')" @click="removeEdgeEndpoint(endpointIndex)">×</button>
              </div>
            </div>

            <div v-if="['manual','managed'].includes(global.edge.mode)" class="space-y-3 border-t p-4 dark:border-white/10">
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="text-sm"><DeploymentHelpLabel for-id="edge-cloudflare-account-id" :label="t('deployments.edge.accountId')" :help="t('deployments.help.edgeAccountId')" :open="deploymentInfoPopoverKey === generatorHelpKey('edge-account-id')" test-id="edge-account-id-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('edge-account-id'), value)" /><input id="edge-cloudflare-account-id" v-model="global.edge.cloudflare.accountId" data-testid="edge-cloudflare-account-id" autocomplete="off" class="mt-1 w-full border bg-transparent px-2 py-2 font-mono" placeholder="32-character Account ID" @input="invalidateEdgeDetection" /></div>
                <div class="text-sm"><DeploymentHelpLabel for-id="edge-cloudflare-api-token" :label="t('deployments.edge.apiToken')" :help="t('deployments.help.edgeApiToken')" :open="deploymentInfoPopoverKey === generatorHelpKey('edge-api-token')" test-id="edge-api-token-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('edge-api-token'), value)" /><SecretInput v-model="global.edge.cloudflare.apiToken" class="mt-1" input-id="edge-cloudflare-api-token" input-testid="edge-cloudflare-api-token" autocomplete="new-password" :placeholder="retainedSecrets ? t('deployments.placeholders.retainOriginalSecret') : ''" @update:model-value="invalidateEdgeDetection" /></div>
              </div>
              <p class="text-xs text-gray-500">{{ global.edge.mode === 'managed' ? t('deployments.edge.credentialsHint') : t('deployments.edge.optionalDetectionHint') }}</p>
              <p v-if="edgePermissionLoading" data-testid="edge-zone-detecting" class="text-xs text-gray-500">{{ t('deployments.edge.zoneDetecting') }}</p>
              <p v-else-if="edgeDetectedZone" data-testid="edge-zone-detected" class="text-xs font-medium text-emerald-700 dark:text-emerald-300" :title="edgeDetectedZone.id">{{ t('deployments.edge.zoneDetected', { name: edgeDetectedZone.name || '-', id: compactZoneId(edgeDetectedZone.id) }) }}</p>
              <p v-if="edgeDetectedZone?.sslMode" data-testid="edge-ssl-mode" class="text-xs text-gray-600 dark:text-gray-300">{{ t('deployments.edge.sslModeDetected', { mode: t(`deployments.edge.sslModes.${edgeDetectedZone.sslMode}`) }) }}</p>
              <p v-if="edgePermissionError" data-testid="edge-zone-error" class="text-xs text-red-600 dark:text-red-300">{{ edgePermissionErrorText(edgePermissionError) }}</p>
              <div v-if="strictManualCertificateConflict" data-testid="edge-strict-certificate-warning" class="flex flex-wrap items-center gap-2 border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"><span>{{ t('deployments.edge.strictCertificateRequired') }}</span><button type="button" class="font-medium underline underline-offset-2" @click="useCloudflareDnsCertificate">{{ t('deployments.edge.useDns01') }}</button></div>
              <details class="border p-3 text-xs leading-6"><summary class="cursor-pointer font-medium">{{ t('deployments.edge.permissionGuide') }}</summary><p class="mt-2 text-gray-500">{{ t('deployments.edge.permissionSteps') }}</p></details>
              <div class="flex flex-wrap items-center gap-3"><button data-testid="detect-edge-zone" type="button" class="deploy-btn-neutral min-h-9 border px-3 text-sm" :disabled="edgePermissionLoading || !edgeDetectionReady" @click="detectEdgePermissions(true)">{{ t('deployments.edge.detectPermissions') }}</button><template v-if="edgePermissionChecks"><span v-for="key in ['tunnel','zone','dns','ssl']" :key="key" class="text-xs" :class="edgePermissionChecks[key]?.ok ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'">{{ key.toUpperCase() }} {{ edgePermissionChecks[key]?.ok ? '✓' : '×' }}</span></template></div>
            </div>

            <div data-testid="warp-settings" class="space-y-3 border-t p-4 dark:border-white/10">
              <div class="flex flex-wrap items-center gap-4"><div class="mr-auto flex items-center"><h3 class="text-sm font-semibold">{{ t('deployments.edge.warpTitle') }}</h3><DeploymentInfoPopover :open="deploymentInfoPopoverKey === generatorHelpKey('warp')" :label="t('deployments.edge.warpTitle')" test-id="warp-help" @update:open="value => setDeploymentInfoPopover(generatorHelpKey('warp'), value)"><span>{{ t('deployments.help.warp') }}</span></DeploymentInfoPopover></div><label class="flex items-center gap-2 text-sm"><input v-model="global.warp.provisioning" type="radio" value="auto" />{{ t('deployments.edge.warpAuto') }}</label><label class="flex items-center gap-2 text-sm"><input v-model="global.warp.provisioning" type="radio" value="manual" />{{ t('deployments.edge.warpManual') }}</label></div>
              <label v-if="global.warp.provisioning === 'auto'" class="flex items-start gap-2 text-sm"><input v-model="global.warp.acceptedTerms" data-testid="warp-accept-terms" type="checkbox" class="mt-1" /><span>{{ t('deployments.edge.warpTerms') }}</span></label>
              <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label class="text-sm">{{ t('deployments.fields.warpPrivateKey') }}<SecretInput v-model="global.warp.privateKey" class="mt-1" font-mono :placeholder="retainedSecrets ? t('deployments.placeholders.retainOriginalSecret') : ''" /></label>
                <label class="text-sm">{{ t('deployments.fields.warpPeerKey') }}<input v-model="global.warp.peerPublicKey" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <label class="text-sm">WARP IPv4<input v-model="global.warp.ipv4" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
                <label class="text-sm">WARP IPv6<input v-model="global.warp.ipv6" class="mt-1 w-full border bg-transparent px-2 py-2" /></label>
              </div>
            </div>
          </section>

          <div id="deployment-inbounds-header" data-testid="deployment-inbounds-header" class="deployment-surface flex items-center justify-between gap-3 p-4"><div><h2 class="text-base font-semibold">{{ t('deployments.inbounds.title') }}</h2><p class="mt-0.5 text-xs text-gray-500">{{ t('deployments.inbounds.hint') }}</p></div><button id="add-inbound" data-testid="add-inbound" type="button" class="deploy-btn-neutral min-h-10 shrink-0 border px-3 text-sm font-medium" :disabled="form.inbounds.length >= 20" @click="addInbound">{{ t('actions.add') }}</button></div>

          <article v-for="(inbound,index) in form.inbounds" :key="inbound.id" class="deployment-surface overflow-hidden">
            <div data-testid="inbound-basic-row" class="grid grid-cols-2 items-end gap-2 p-3 sm:grid-cols-4 lg:grid-cols-[minmax(112px,0.8fr)_minmax(88px,0.45fr)_minmax(176px,1.25fr)_minmax(128px,0.9fr)_minmax(140px,1fr)_auto_auto]">
              <label class="min-w-0 text-xs text-gray-500">{{ t('deployments.inbounds.protocol') }}<select v-model="inbound.protocol" data-testid="inbound-protocol" class="mt-1 min-h-10 w-full border bg-transparent px-2 text-sm text-gray-900 dark:text-white" @change="updateProtocol(inbound)"><option v-for="item in visibleProtocols" :key="item.value" :value="item.value" :disabled="protocolDisabled(item.value)">{{ item.label }}{{ protocolDisabled(item.value) ? t('deployments.inbounds.unsupportedByCore', { core: global.runtime.core }) : '' }}</option></select></label>
              <label class="min-w-0 text-xs text-gray-500" :for="`inbound-port-${index}`">{{ t('deployments.inbounds.port') }}<input :id="`inbound-port-${index}`" v-model="inbound.port" data-testid="inbound-port" inputmode="numeric" class="mt-1 min-h-10 w-full border bg-transparent px-2 text-sm text-gray-900 dark:text-white" :placeholder="t('deployments.placeholders.random')" /></label>
              <label class="col-span-2 min-w-0 text-xs text-gray-500 lg:col-span-1">{{ t('deployments.inbounds.nodeName') }}<input v-model="inbound.name" data-testid="inbound-node-name" maxlength="80" class="mt-1 min-h-10 w-full border bg-transparent px-2 text-sm text-gray-900 dark:text-white" :placeholder="nodeNamePlaceholder(inbound)" /></label>
              <div class="min-w-0 text-xs text-gray-500"><DeploymentHelpLabel :for-id="`inbound-transport-${index}`" :label="t('deployments.inbounds.transport')" :help="t('deployments.help.inboundTransport')" :open="deploymentInfoPopoverKey === generatorHelpKey(`inbound-${index}-transport`)" :test-id="`inbound-transport-help-${index}`" @update:open="value => setDeploymentInfoPopover(generatorHelpKey(`inbound-${index}-transport`), value)" /><select v-if="transportConfigurable(inbound)" :id="`inbound-transport-${index}`" v-model="inbound.transport" :data-testid="`inbound-transport-${index}`" class="mt-1 min-h-10 min-w-0 w-full border bg-transparent px-2 text-sm text-gray-900 dark:text-white" @change="updateTransport(inbound)"><option value="">{{ t('deployments.inbounds.inherit', { value: effective(inbound, 'transport') }) }}</option><option v-for="([value,label]) in TRANSPORT_OPTIONS" :key="value" :value="value" :disabled="transportDisabled(inbound, value)">{{ label }}</option></select><output v-else :id="`inbound-transport-${index}`" :data-testid="`inbound-transport-${index}`" class="mt-1 flex min-h-10 w-full items-center border bg-gray-50 px-2 text-sm text-gray-700 dark:bg-white/5 dark:text-gray-200">{{ nativeTransportLabel(inbound) }}</output></div>
              <div class="min-w-0 text-xs text-gray-500"><DeploymentHelpLabel :for-id="`inbound-outbound-${index}`" :label="t('deployments.inbounds.outbound')" :help="t('deployments.help.inboundOutbound')" :open="deploymentInfoPopoverKey === generatorHelpKey(`inbound-${index}-outbound`)" :test-id="`inbound-outbound-help-${index}`" @update:open="value => setDeploymentInfoPopover(generatorHelpKey(`inbound-${index}-outbound`), value)" /><select :id="`inbound-outbound-${index}`" v-model="inbound.outbound" :data-testid="`inbound-outbound-${index}`" class="mt-1 min-h-10 min-w-0 w-full border bg-transparent px-2 text-sm text-gray-900 dark:text-white" @change="updateOutbound(inbound)"><option value="">{{ t('deployments.inbounds.inherit', { value: effective(inbound, 'outbound') }) }}</option><option v-for="([value,label]) in OUTBOUND_OPTIONS" :key="value" :value="value">{{ label.startsWith('deployments.') ? t(label) : label }}</option></select></div>
              <button type="button" :data-testid="`inbound-more-${index}`" class="deploy-btn-neutral min-h-10 min-w-[4.75rem] shrink-0 whitespace-nowrap border px-3 text-sm" :aria-expanded="inbound.expanded" @click="inbound.expanded = !inbound.expanded"><span>{{ t('deployments.inbounds.advanced') }}</span><span class="ml-1" aria-hidden="true">{{ inbound.expanded ? '−' : '+' }}</span></button>
              <button type="button" class="deploy-btn-danger min-h-10 min-w-10 shrink-0 border border-red-200 px-3 text-lg text-red-600 disabled:cursor-not-allowed disabled:opacity-30" :disabled="form.inbounds.length === 1" :title="t('deployments.inbounds.delete')" :aria-label="t('deployments.inbounds.delete')" @click="removeInbound(index)">×</button>
            </div>
            <p v-if="inboundCompatibilityError(inbound)" class="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">{{ inboundCompatibilityError(inbound) }}</p>
            <div v-if="inbound.expanded" :data-testid="`inbound-advanced-${index}`" class="grid gap-3 border-t p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-white/10">
              <div class="text-sm"><DeploymentHelpLabel :for-id="`inbound-edge-mode-${index}`" :label="t('deployments.inbounds.edgeMode')" :help="global.edge.mode === 'quick' ? `${t('deployments.help.inboundEdgeMode')} ${t('deployments.edge.quickManaged')}` : t('deployments.help.inboundEdgeMode')" :open="deploymentInfoPopoverKey === generatorHelpKey(`inbound-${index}-edge-mode`)" :test-id="`inbound-edge-mode-help-${index}`" @update:open="value => setDeploymentInfoPopover(generatorHelpKey(`inbound-${index}-edge-mode`), value)" /><select :id="`inbound-edge-mode-${index}`" v-model="inbound.edgeMode" :data-testid="`inbound-edge-mode-${index}`" class="mt-1 w-full border bg-transparent px-2 py-2" :disabled="global.edge.mode === 'quick'"><option value="direct">{{ t('deployments.edge.directOnly') }}</option><option value="append" :disabled="edgeOptionDisabled(inbound, 'append')">{{ t('deployments.edge.directAndCdn') }}</option><option value="only" :disabled="edgeOptionDisabled(inbound, 'only')">{{ t('deployments.edge.cdnOnly') }}</option></select><p v-if="global.edge.mode !== 'quick' && edgeReasonText(inbound)" class="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-300"><span>{{ edgeReasonText(inbound) }}</span><button type="button" class="ml-1 font-medium text-primary-600 underline underline-offset-2 dark:text-primary-400" :data-testid="`inbound-edge-fix-${index}`" @click="focusEdgeRequirement(inbound, index)">{{ t('deployments.edge.goConfigure') }}</button></p><span v-else-if="global.edge.mode !== 'quick' && edgeEnabled && ['grpc','xhttp'].includes(effective(inbound, 'transport'))" class="mt-1 block text-xs leading-5 text-amber-700 dark:text-amber-300">{{ t('deployments.edge.experimental') }}</span></div>
              <div class="text-sm"><DeploymentHelpLabel :for-id="`inbound-tls-mode-${index}`" label="TLS" :help="t('deployments.help.inboundTls')" :open="deploymentInfoPopoverKey === generatorHelpKey(`inbound-${index}-tls`)" :test-id="`inbound-tls-help-${index}`" @update:open="value => setDeploymentInfoPopover(generatorHelpKey(`inbound-${index}-tls`), value)" /><select v-if="tlsOptions(inbound).length > 1" :id="`inbound-tls-mode-${index}`" v-model="inbound.tlsMode" :data-testid="`inbound-tls-mode-${index}`" class="mt-1 w-full border bg-transparent px-2 py-2" @change="updateTransport(inbound)"><option value="">{{ t('deployments.inbounds.inherit', { value: effective(inbound, 'tlsMode') }) }}</option><option v-for="value in tlsOptions(inbound)" :key="value" :value="value">{{ value }}</option></select><output v-else :id="`inbound-tls-mode-${index}`" :data-testid="`inbound-tls-mode-${index}`" class="mt-1 flex min-h-10 w-full items-center border bg-gray-50 px-2 text-sm text-gray-700 dark:bg-white/5 dark:text-gray-200">{{ effective(inbound, 'tlsMode') }}</output></div>
              <div v-if="effective(inbound, 'tlsMode') !== 'none'" class="text-sm"><DeploymentHelpLabel :for-id="`inbound-server-name-${index}`" :label="t('deployments.inbounds.serverName')" :help="t('deployments.help.inboundServerName')" :open="deploymentInfoPopoverKey === generatorHelpKey(`inbound-${index}-server-name`)" :test-id="`inbound-server-name-help-${index}`" @update:open="value => setDeploymentInfoPopover(generatorHelpKey(`inbound-${index}-server-name`), value)" /><input :id="`inbound-server-name-${index}`" v-model="inbound.serverName" class="mt-1 w-full border bg-transparent px-2 py-2" :placeholder="effective(inbound, 'serverName') || t('deployments.inbounds.inheritGlobal')" @input="syncSelfSignedTlsServerNames(inbound)" /></div>
              <label v-if="credentialType(inbound.protocol) === 'uuid'" class="text-sm sm:col-span-2">{{ t('deployments.inbounds.uuidOverride') }}<div class="relative mt-1"><input v-model="inbound.uuid" data-testid="inbound-uuid" type="text" autocomplete="off" class="w-full border bg-transparent py-2 pl-2 pr-16 font-mono" :placeholder="uuidPlaceholder()" /><button data-testid="generate-inbound-uuid" type="button" class="absolute inset-y-px right-px border-0 border-l bg-gray-50 px-3 text-xs font-medium text-primary-600 hover:bg-primary-50 dark:bg-gray-900 dark:hover:bg-white/10" :title="t('deployments.generateUuid')" @click="generateUuid(inbound)">{{ t('deployments.generate') }}</button></div></label>
              <label v-else-if="inbound.protocol !== 'shadowsocks'" class="text-sm sm:col-span-2">{{ t('deployments.inbounds.passwordOverride') }}<SecretInput v-model="inbound.password" class="mt-1" autocomplete="new-password" :placeholder="passwordPlaceholder()" allow-generate input-testid="inbound-password" toggle-testid="toggle-inbound-password" generate-testid="generate-inbound-password" @generate="generatePassword(inbound)" /></label>
              <label v-if="inbound.protocol === 'tuic'" class="text-sm sm:col-span-2">{{ t('deployments.inbounds.tuicPasswordOverride') }}<SecretInput v-model="inbound.password" class="mt-1" autocomplete="new-password" :placeholder="passwordPlaceholder()" allow-generate input-testid="inbound-password" toggle-testid="toggle-inbound-password" generate-testid="generate-inbound-password" @generate="generatePassword(inbound)" /></label>
              <label v-if="['ws','xhttp'].includes(effective(inbound, 'transport'))" class="text-sm sm:col-span-2">{{ t('deployments.inbounds.path') }}<input v-model="inbound.path" class="mt-1 w-full border bg-transparent px-2 py-2" :placeholder="effective(inbound, 'path')" /></label>
              <label v-if="['ws','xhttp'].includes(effective(inbound, 'transport'))" class="text-sm sm:col-span-2">{{ t('deployments.inbounds.host') }}<input v-model="inbound.host" :data-testid="`inbound-host-${index}`" class="mt-1 w-full border bg-transparent px-2 py-2" :placeholder="t('deployments.placeholders.optional')" /></label>
              <label v-if="effective(inbound, 'transport') === 'grpc'" class="text-sm sm:col-span-2">{{ t('deployments.inbounds.serviceName') }}<input v-model="inbound.serviceName" class="mt-1 w-full border bg-transparent px-2 py-2" :placeholder="effective(inbound, 'serviceName')" /></label>
              <template v-if="effective(inbound, 'transport') === 'xhttp'"><label class="text-sm">{{ t('deployments.inbounds.xhttpMode') }}<select v-model="inbound.xhttpMode" class="mt-1 w-full border bg-transparent px-2 py-2"><option value="auto">Auto</option><option value="packet-up">packet-up</option><option value="stream-up">stream-up</option><option value="stream-one">stream-one</option></select></label><label class="text-sm" :for="`inbound-xhttp-version-${index}`">{{ t('deployments.inbounds.xhttpVersion') }}<select :id="`inbound-xhttp-version-${index}`" v-model="inbound.xhttpVersion" class="mt-1 w-full border bg-transparent px-2 py-2" @change="updateTransport(inbound)"><option value="auto">Auto</option><option value="h2">HTTP/2</option><option value="h3">HTTP/3</option></select></label></template>
              <template v-if="inbound.protocol === 'hysteria2'"><label class="text-sm">{{ t('deployments.inbounds.bandwidthUp') }}<input v-model="inbound.bandwidthUp" class="mt-1 w-full border bg-transparent px-2 py-2" placeholder="100Mbps" /></label><label class="text-sm">{{ t('deployments.inbounds.bandwidthDown') }}<input v-model="inbound.bandwidthDown" class="mt-1 w-full border bg-transparent px-2 py-2" placeholder="100Mbps" /></label><label class="text-sm sm:col-span-2">{{ t('deployments.inbounds.udpHopPorts') }}<input v-model="inbound.udpHopPorts" class="mt-1 w-full border bg-transparent px-2 py-2" placeholder="20000-30000" /></label><label v-if="inbound.udpHopPorts" class="text-sm">{{ t('deployments.inbounds.udpHopInterval') }}<input v-model="inbound.udpHopInterval" type="number" min="5" max="300" class="mt-1 w-full border bg-transparent px-2 py-2" placeholder="30" /></label></template>
              <template v-if="effective(inbound, 'tlsMode') === 'reality'"><label class="text-sm sm:col-span-2">{{ t('deployments.inbounds.realityPrivateKey') }}<SecretInput v-model="inbound.realityPrivateKey" class="mt-1" :placeholder="retainedSecrets ? t('deployments.placeholders.retainOriginalSecret') : t('deployments.placeholders.realityPrivateKey')" allow-generate font-mono input-testid="reality-private-key" toggle-testid="toggle-reality-private-key" generate-testid="generate-reality-key" @generate="generateRealityKeys(inbound)" /></label><label class="text-sm sm:col-span-2">{{ t('deployments.inbounds.realityPublicKey') }}<input v-model="inbound.realityPublicKey" data-testid="reality-public-key" class="mt-1 w-full border bg-transparent px-2 py-2 font-mono" :placeholder="t('deployments.placeholders.realityPublicKey')" /></label><label class="text-sm">Short ID<input v-model="inbound.shortId" class="mt-1 w-full border bg-transparent px-2 py-2" :placeholder="t('deployments.placeholders.autoGenerate')" /></label></template>
            </div>
          </article>

          <p v-if="needsWarp" class="border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">{{ t('deployments.warpHint') }}</p>
          </template>
          <div data-bottom-action-anchor aria-hidden="true" class="h-0 shrink-0"></div>
          <div data-testid="deployment-submit-panel" class="bottom-action-panel sticky bottom-20 z-30 flex w-full shrink-0 justify-end rounded-xl border border-gray-100/80 bg-white/85 px-4 py-3 shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-gray-900/80 md:px-5 lg:bottom-4">
            <button data-testid="deployment-submit" type="submit" class="deploy-btn-primary flex min-h-11 w-fit items-center gap-2 bg-primary-600 px-6 text-sm font-medium text-white shadow-sm" :disabled="loading || (deploymentMode !== 'install' && !targetDeploymentId)">{{ submitLabel }}</button>
          </div>
        </form>

        <aside v-if="!remoteUpdate" data-testid="deployment-command-panel" class="deployment-command-panel self-start rounded-xl border border-gray-800 bg-gray-950 p-4 text-white shadow-sm xl:sticky xl:top-24 dark:border-white/15">
          <div class="mb-3 flex items-center justify-between"><h2 class="text-sm font-semibold">{{ t('deployments.oneTimeCommand') }}</h2><button type="button" class="deploy-btn-dark-success px-2 py-1 text-xs text-emerald-300 disabled:opacity-30" :disabled="!shownCommand" @click="copyCommand">{{ t('actions.copy') }}</button></div>
          <div class="mb-2 flex flex-wrap items-center gap-1"><button v-for="client in ['wget','curl']" :key="client" type="button" class="deploy-btn-dark px-3 py-1.5 text-xs" :class="output.client === client ? 'bg-white/15 text-white' : 'text-gray-400'" @click="output.client = client">{{ client }}</button><button v-if="output.diagnosticCurl || output.diagnosticWget" type="button" class="deploy-btn-dark ml-auto px-3 py-1.5 text-xs text-gray-300" @click="output.diagnostic = !output.diagnostic">{{ output.diagnostic ? t('deployments.hideTroubleshootingCommand') : t('deployments.showTroubleshootingCommand') }}</button></div>
          <textarea :value="shownCommand" readonly class="h-48 w-full resize-none border border-white/10 bg-black/30 p-3 font-mono text-xs leading-5 text-emerald-300" :placeholder="t('deployments.commandPlaceholder')"></textarea>
          <p v-if="output.expiresAt" class="mt-3 text-xs text-gray-400">{{ t('deployments.bootstrapExpires', { time: formatDate(output.expiresAt) }) }}</p>
        </aside>
      </section>
    </template>

    <template v-else-if="activeTab === 'deployments'">
      <div v-if="!deployments.length && !loading" class="rounded-xl border border-dashed border-gray-300 bg-white/60 py-16 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/50">{{ t('deployments.emptyDeployments') }}</div>
      <div class="space-y-3"><article v-for="deployment in deployments" :key="deployment.id" class="deployment-surface p-4">
        <div data-testid="deployment-record-layout" class="flex flex-col gap-3 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] xl:items-start">
          <div class="min-w-0 grow">
            <div class="flex min-w-0 items-center gap-2">
              <h2 class="truncate font-semibold">{{ deployment.name }}</h2>
              <span class="shrink-0 border px-2 py-0.5 text-xs" :class="statusClass(deployment.status)">{{ deploymentStatusText(deployment) }}</span>
            </div>

            <div data-testid="deployment-time-row" class="mt-1 flex min-w-0 items-center text-xs leading-5 text-gray-500" :title="deploymentTimeTitle(deployment)" :aria-label="deploymentTimeTitle(deployment)">
              <p class="min-w-0 truncate">
                <span data-testid="deployment-succeeded-at">{{ t('deployments.record.deployedDate', { date: formatCompactDate(deployment.deployedAt) || t('common.unknown') }) }}</span>
                <span aria-hidden="true"> · </span>
                <span data-testid="deployment-config-updated-at">{{ t('deployments.record.updatedDate', { date: formatCompactDate(deploymentConfigUpdatedAt(deployment)) || t('common.unknown') }) }}</span>
              </p>
              <DeploymentInfoPopover
                :open="deploymentInfoPopoverKey === deploymentInfoKey(deployment, 'time')"
                :label="t('deployments.record.timeDetails')"
                :test-id="`deployment-time-info-${deployment.id}`"
                @update:open="value => setDeploymentInfoPopover(deploymentInfoKey(deployment, 'time'), value)"
              >
                <template #icon><svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 11v5"/><path stroke-linecap="round" d="M12 8h.01"/></svg></template>
                <dl class="space-y-1.5">
                  <div class="grid grid-cols-[6rem_minmax(0,1fr)] gap-2"><dt class="text-gray-300">{{ t('deployments.record.deployed') }}</dt><dd class="break-words">{{ deployment.deployedAt ? formatDate(deployment.deployedAt) : t('common.unknown') }}</dd></div>
                  <div class="grid grid-cols-[6rem_minmax(0,1fr)] gap-2"><dt class="text-gray-300">{{ t('deployments.record.updated') }}</dt><dd class="break-words">{{ deploymentConfigUpdatedAt(deployment) ? formatDate(deploymentConfigUpdatedAt(deployment)) : t('common.unknown') }}</dd></div>
                </dl>
              </DeploymentInfoPopover>
            </div>

            <div data-testid="deployment-system-row" class="mt-0.5 flex min-w-0 items-center text-xs leading-5 text-gray-500">
              <p class="min-w-0 truncate">
                <span>{{ coreDisplayName(deployment.agent?.heartbeat?.core || deployment.configSummary?.runtime?.core) }}</span>
                <span aria-hidden="true"> · </span><span>{{ deployment.configSummary?.runtime?.tier || '-' }}</span>
                <span aria-hidden="true"> · </span><span>{{ t('deployments.nodeCount', { count: deployment.nodeCount || 0 }) }}</span>
                <span aria-hidden="true"> · </span><span data-testid="deployment-system-version">{{ compactSystemVersion(deployment) }}</span>
                <span aria-hidden="true"> · </span><span data-testid="deployment-runtime-version">{{ t('deployments.record.runtimeCompact', { version: deployment.agent?.heartbeat?.runtimeVersion || t('common.unknown') }) }}</span>
              </p>
              <DeploymentInfoPopover
                :open="deploymentInfoPopoverKey === deploymentInfoKey(deployment, 'system')"
                :label="t('deployments.record.systemDetails')"
                :test-id="`deployment-system-info-${deployment.id}`"
                @update:open="value => setDeploymentInfoPopover(deploymentInfoKey(deployment, 'system'), value)"
              >
                <template #icon><svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 11v5"/><path stroke-linecap="round" d="M12 8h.01"/></svg></template>
                <p v-if="deployment.capabilities?.degradedReason" class="mb-2 rounded-md bg-amber-400/15 px-2 py-1.5 text-amber-200">{{ deployment.capabilities.degradedReason }}</p>
                <dl class="space-y-1.5">
                  <div v-for="row in systemDetailRows(deployment)" :key="row.label" class="grid grid-cols-[6rem_minmax(0,1fr)] gap-2"><dt class="text-gray-300">{{ row.label }}</dt><dd class="break-words">{{ row.value }}</dd></div>
                </dl>
              </DeploymentInfoPopover>
            </div>

            <div data-testid="deployment-heartbeat-row" class="mt-0.5 flex min-w-0 items-center text-xs leading-5" :class="deployment.agent?.online ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-500'">
              <p class="min-w-0 truncate">{{ heartbeatSummary(deployment) }}</p>
              <DeploymentInfoPopover
                :open="deploymentInfoPopoverKey === deploymentInfoKey(deployment, 'heartbeat')"
                :label="t('deployments.record.heartbeatDetails')"
                :test-id="`deployment-heartbeat-info-${deployment.id}`"
                @update:open="value => setDeploymentInfoPopover(deploymentInfoKey(deployment, 'heartbeat'), value)"
              >
                <template #icon><svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 11v5"/><path stroke-linecap="round" d="M12 8h.01"/></svg></template>
                <p v-if="!capabilities.features?.heartbeats || deployment.agent?.requiresD1" class="text-gray-200">{{ t('deployments.record.heartbeatRequiresD1') }}</p>
                <p v-else-if="!deployment.agent?.heartbeat || !deployment.agent?.lastSeenAt" class="text-gray-200">{{ t('deployments.record.heartbeatMissing') }}</p>
                <dl v-else class="space-y-1.5">
                  <div v-for="row in heartbeatDetailRows(deployment)" :key="row.label" class="grid grid-cols-[6rem_minmax(0,1fr)] gap-2"><dt class="text-gray-300">{{ row.label }}</dt><dd class="break-words">{{ row.value }}</dd></div>
                </dl>
              </DeploymentInfoPopover>
            </div>
            <p v-if="deployment.deployedAt && deployment.capabilities?.tuicCertificatePinStatus === 'missing'" data-testid="tuic-certificate-pin-warning" class="mt-2 rounded-md bg-amber-400/15 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-200">{{ t('deployments.record.tuicCertificatePinMissing') }}</p>
          </div>
          <div class="flex flex-wrap gap-2 xl:justify-end">
            <button v-if="deployment.configSummary?.subscriptionServer?.pushEnabled" data-testid="deployment-push-history" type="button" class="min-h-9 border border-primary-200 bg-primary-50 px-3 text-xs font-medium text-primary-700 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300" @click="openPushHistory(deployment)">{{ t('pushHistory.open') }}</button>
            <button v-if="!deployment.demo && deployment.subscriptionSourceDisabled" data-testid="restore-deployment-source" type="button" class="min-h-9 border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300" :disabled="loading" @click="restoreSubscriptionSource(deployment)">{{ t('deployments.restoreSource') }}</button>
            <button v-if="!deployment.demo" :data-testid="deployment.reinstallable ? 'deployment-reinstall-config' : 'deployment-update-config'" type="button" class="deploy-btn-neutral min-h-9 border px-3 text-xs" :disabled="deployment.migrationRequired || loading" @click="requestUpdateConfig(deployment)">{{ t(deployment.reinstallable ? 'deployments.actions.reinstall' : 'deployments.actions.plan') }}</button>
            <button v-if="!deployment.demo" type="button" class="deploy-btn-neutral min-h-9 border px-3 text-xs" :disabled="deployment.migrationRequired || deployment.status === 'offline' || loading" @click="reuseDeploymentConfig(deployment)">{{ t('deployments.actions.apply') }}</button>
            <button v-if="!deployment.demo && capabilities.features?.localExecutor && deployment.controlTransport !== 'local-executor'" type="button" class="deploy-btn-neutral min-h-9 border px-3 text-xs" :disabled="loading" @click="connectLocalExecutor(deployment)">{{ t('deployments.remote.connectLocal') }}</button>
            <details v-if="!deployment.demo" data-remote-menu class="relative" :open="remoteMenuId === deployment.id">
              <summary data-testid="deployment-remote-trigger" class="deploy-btn-neutral deploy-remote-trigger inline-flex min-h-9 list-none items-center border px-3 text-xs" :aria-disabled="!capabilities.features.remoteCommands" :aria-expanded="remoteMenuId === deployment.id" :title="!capabilities.features.remoteCommands ? t('deployments.remote.requiresD1') : deployment.agent?.online ? t('deployments.remote.online') : t('deployments.remote.offline')" @click="toggleRemoteMenu(deployment, $event)" @keydown.enter="toggleRemoteMenu(deployment, $event)" @keydown.space="toggleRemoteMenu(deployment, $event)">{{ t('deployments.remote.title') }}</summary>
              <div v-if="capabilities.features.remoteCommands" class="absolute right-0 z-40 mt-1 grid min-w-40 gap-1 rounded-lg border border-gray-200 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-gray-900">
                <button type="button" data-testid="remote-update-config" class="deploy-btn-neutral min-h-9 border px-3 text-left text-xs" :disabled="!deployment.agent?.online || loading" @click="requestRemoteUpdateConfig(deployment)">{{ t('deployments.actions.plan') }}</button>
                <button v-for="([action,label]) in visibleDeploymentActions" :key="`remote-${action}`" type="button" class="deploy-btn-neutral min-h-9 border px-3 text-left text-xs" :disabled="!deployment.agent?.online || loading" @click="generateRemoteCommand(deployment, action)">{{ t(label) }}</button>
              </div>
            </details>
            <button v-for="([action,label]) in (deployment.demo ? [] : visibleDeploymentActions)" :key="action" type="button" class="min-h-9 border px-3 text-xs" :disabled="deployment.migrationRequired" :class="action === 'uninstall' ? 'deploy-btn-danger border-red-200 text-red-600' : 'deploy-btn-neutral'" @click="generateActionCommand(deployment, action)">{{ t(label) }}</button>
            <button v-if="!deployment.demo && deployment.configSummary?.edge?.hasManagedResources" type="button" class="deploy-btn-danger min-h-9 border border-red-200 px-3 text-xs text-red-600" :disabled="loading" @click="cleanupCloudflareResources(deployment)">{{ t('deployments.edge.cleanupResources') }}</button>
            <button v-if="!deployment.demo" type="button" class="deploy-btn-danger min-h-9 border border-red-200 px-3 text-xs text-red-600" @click="removeDeployment(deployment)">{{ t('deployments.deleteRecord') }}</button>
          </div></div>
      </article></div>
    </template>

    <template v-else>
      <div class="deployment-surface flex flex-col gap-3 p-4 sm:flex-row sm:items-end"><label class="grow text-sm font-medium">{{ t('deployments.selectDeployment') }}<select v-model="selectedDeploymentId" class="mt-1 w-full border bg-transparent px-3 py-2.5" @change="loadOperations()"><option value="">{{ t('deployments.pleaseSelect') }}</option><option v-for="deployment in deployments" :key="deployment.id" :value="deployment.id">{{ deployment.name }}</option></select></label><button type="button" class="deploy-btn-neutral min-h-11 border px-4 text-sm font-medium" :disabled="!selectedDeployment" @click="loadOperations()">{{ t('actions.refresh') }}</button></div>
      <div class="deployment-surface overflow-x-auto"><table v-if="operations.length" class="w-full min-w-[800px] text-left text-sm"><thead class="bg-gray-50 text-xs text-gray-500 dark:bg-white/5"><tr><th class="p-3">{{ t('deployments.table.action') }}</th><th class="p-3">{{ t('common.status') }}</th><th class="p-3">{{ t('deployments.table.stage') }}</th><th class="p-3">{{ t('deployments.table.host') }}</th><th class="p-3">{{ t('deployments.table.resources') }}</th><th class="p-3">{{ t('deployments.table.result') }}</th></tr></thead><tbody><tr v-for="operation in operations" :key="operation.id" class="border-t dark:border-white/10"><td class="p-3 font-mono">{{ operation.action }}</td><td class="p-3">{{ statusText(operation.status) }}</td><td class="p-3">{{ operation.events?.at(-1)?.stage || '-' }}</td><td data-testid="operation-host" class="p-3">{{ operationHostname(operation) }}</td><td class="p-3">{{ operationResources(operation) }}</td><td data-testid="operation-result" class="max-w-xs truncate p-3" :title="operationResult(operation)">{{ operationResult(operation) }}</td></tr></tbody></table><div v-else class="py-12 text-center text-sm text-gray-500">{{ t('deployments.emptyOperations') }}</div></div>
    </template>

    <Teleport to="body">
      <div v-if="pendingOperation" class="deployment-risk-dialog fixed inset-0 z-[104] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="deployment-operation-confirm-title" @click.self="cancelOperationCommand">
        <div data-testid="deployment-operation-confirm-dialog" class="deployment-risk-panel w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-white/10 dark:bg-gray-900">
          <h2 id="deployment-operation-confirm-title" class="text-lg font-semibold">{{ t('deployments.confirm.operationTitle') }}</h2>
          <p class="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{{ pendingOperationMessage }}</p>
          <div class="mt-5 flex justify-end gap-2"><button type="button" class="deploy-btn-neutral min-h-10 rounded-lg border px-4 text-sm" :disabled="loading" @click="cancelOperationCommand">{{ t('actions.cancel') }}</button><button data-testid="confirm-deployment-operation" type="button" class="deploy-btn-danger min-h-10 rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-600 disabled:opacity-50 dark:border-red-400/35 dark:text-red-300" :disabled="loading" @click="confirmOperationCommand">{{ t('deployments.confirm.generateOperation', { action: t(`deployments.actions.${pendingOperation.action}`) }) }}</button></div>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="showOperationCommandModal" class="fixed inset-0 z-[105] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="deployment-operation-command-title" @click.self="closeOperationCommandModal">
        <div data-testid="deployment-operation-command-dialog" class="deployment-command-panel w-full max-w-2xl rounded-xl border border-gray-800 bg-gray-950 p-5 text-white shadow-2xl dark:border-white/15">
          <div class="mb-4 flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><h2 id="deployment-operation-command-title" class="truncate text-base font-semibold">{{ t('deployments.operationCommand.title', { name: operationOutput.deploymentName, action: t(`deployments.actions.${operationOutput.action}`) }) }}</h2><p class="mt-1 text-xs text-gray-400">{{ t('deployments.operationCommand.hint') }}</p></div><button type="button" class="deploy-btn-dark shrink-0 px-3 py-1.5 text-xs text-gray-300" @click="closeOperationCommandModal">{{ t('actions.close') }}</button></div>
          <div class="mb-2 flex flex-wrap items-center gap-1"><button v-for="client in ['wget','curl']" :key="client" type="button" class="deploy-btn-dark px-3 py-1.5 text-xs" :class="operationOutput.client === client ? 'bg-white/15 text-white' : 'text-gray-400'" @click="operationOutput.client = client">{{ client }}</button><button v-if="operationOutput.diagnosticCurl || operationOutput.diagnosticWget" type="button" class="deploy-btn-dark ml-auto px-3 py-1.5 text-xs text-gray-300" @click="operationOutput.diagnostic = !operationOutput.diagnostic">{{ operationOutput.diagnostic ? t('deployments.hideTroubleshootingCommand') : t('deployments.showTroubleshootingCommand') }}</button></div>
          <textarea :value="shownOperationCommand" readonly class="h-56 w-full resize-none border border-white/10 bg-black/30 p-3 font-mono text-xs leading-5 text-emerald-300" :placeholder="t('deployments.commandPlaceholder')"></textarea>
          <div class="mt-3 flex flex-wrap items-center justify-between gap-3"><p v-if="operationOutput.expiresAt" class="text-xs text-gray-400">{{ t('deployments.bootstrapExpires', { time: formatDate(operationOutput.expiresAt) }) }}</p><span v-else></span><button data-testid="copy-deployment-operation-command" type="button" class="deploy-btn-dark-success min-h-9 px-4 text-xs font-medium text-emerald-300" :disabled="!shownOperationCommand" @click="copyOperationCommand">{{ t('actions.copy') }}</button></div>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="showQuickInboundDialog" class="deployment-risk-dialog fixed inset-0 z-[103] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="quick-inbound-dialog-title" @click.self="cancelQuickInboundDialog">
        <div data-testid="quick-inbound-dialog" class="deployment-risk-panel w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-white/10 dark:bg-gray-900">
          <h2 id="quick-inbound-dialog-title" class="text-lg font-semibold">{{ t('deployments.edge.quickDialogTitle') }}</h2>
          <p class="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{{ t('deployments.edge.quickDialogDescription') }}</p>
          <fieldset class="mt-4"><legend class="text-sm font-medium">{{ t('deployments.edge.quickProtocol') }}</legend><div class="mt-2 inline-flex overflow-hidden rounded-lg border dark:border-white/15"><label v-for="protocol in ['vless','vmess']" :key="protocol" class="cursor-pointer px-4 py-2 text-sm" :class="quickAutoProtocol === protocol ? 'bg-primary-600 text-white' : 'bg-transparent'"><input v-model="quickAutoProtocol" class="sr-only" type="radio" name="quick-auto-protocol" :value="protocol" />{{ protocol.toUpperCase() }}</label></div></fieldset>
          <p v-if="form.inbounds.length >= 20" class="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">{{ t('deployments.edge.quickLimitReached') }}</p>
          <div class="mt-5 flex flex-wrap justify-end gap-2"><button type="button" class="deploy-btn-neutral min-h-10 rounded-lg border px-4 text-sm" @click="cancelQuickInboundDialog">{{ t('actions.cancel') }}</button><button data-testid="quick-go-configure" type="button" class="deploy-btn-neutral min-h-10 rounded-lg border px-4 text-sm font-semibold" @click="focusQuickInboundConfiguration">{{ t('deployments.edge.goConfigure') }}</button><button data-testid="quick-auto-add" type="button" class="deploy-btn-primary min-h-10 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50" :disabled="form.inbounds.length >= 20" @click="autoAddQuickInbound">{{ t('deployments.edge.autoAdd') }}</button></div>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="showLoadConfigDialog" class="deployment-risk-dialog fixed inset-0 z-[101] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="load-config-title" @click.self="cancelLoadConfig">
        <div data-testid="load-config-dialog" class="deployment-risk-panel w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-white/10 dark:bg-gray-900">
          <h2 id="load-config-title" class="text-lg font-semibold">{{ t('deployments.loadConfig.title') }}</h2>
          <p class="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{{ t('deployments.loadConfig.description', { name: pendingTemplateRecord?.name || '' }) }}</p>
          <div class="mt-3 space-y-2 text-xs leading-5 text-gray-500 dark:text-gray-400"><p>{{ t('deployments.loadConfig.directDescription') }}</p><p>{{ t('deployments.loadConfig.loadDescription') }}</p><p>{{ t('deployments.loadConfig.reconfigureDescription') }}</p></div>
          <div class="mt-5 flex flex-wrap justify-end gap-2"><button type="button" class="deploy-btn-neutral min-h-10 rounded-lg border px-4 text-sm" :disabled="loading" @click="cancelLoadConfig">{{ t('actions.cancel') }}</button><button type="button" data-testid="direct-deployment-command" class="deploy-btn-neutral min-h-10 rounded-lg border px-4 text-sm font-semibold" :disabled="loading" @click="generateDirectPendingCommand">{{ t('deployments.loadConfig.directCommand') }}</button><button type="button" data-testid="reconfigure-deployment" class="deploy-btn-neutral min-h-10 rounded-lg border px-4 text-sm font-semibold" :disabled="loading" @click="reconfigureDeployment">{{ t('deployments.loadConfig.reconfigure') }}</button><button type="button" class="deploy-btn-primary min-h-10 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white shadow-sm" :disabled="loading" @click="confirmLoadConfig">{{ t('deployments.loadConfig.confirm') }}</button></div>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="showRiskDialog" class="deployment-risk-dialog fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="deploy-risk-title" @click.self="showRiskDialog = false">
        <div data-testid="deployment-risk-panel" class="deployment-risk-panel w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-white/10 dark:bg-gray-900">
          <h2 id="deploy-risk-title" class="text-lg font-semibold">{{ remoteUpdate ? t('deployments.remote.configConfirmTitle') : t('deployments.risk.title') }}</h2>
          <p class="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{{ remoteUpdate ? t('deployments.remote.configConfirm') : t('deployments.risk.system') }}</p>
          <p v-if="global.subscriptionServer.enabled" class="mt-2 text-sm leading-6 text-amber-700 dark:text-amber-300">{{ t('deployments.risk.subscription') }}</p>
          <div class="mt-5 flex justify-end gap-2"><button type="button" class="deploy-btn-neutral min-h-10 rounded-lg border px-4 text-sm" @click="showRiskDialog = false">{{ t('actions.cancel') }}</button><button type="button" class="deploy-btn-primary min-h-10 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white shadow-sm" @click="generateInstallCommand">{{ submitLabel }}</button></div>
        </div>
      </div>
    </Teleport>
    <PushHistoryModal v-model:show="showPushHistoryModal" :record="pushHistoryRecord" />
  </div>
</template>

<style scoped>
.deployment-surface {
  border: 1px solid var(--border-subtle-light);
  border-radius: 0.75rem;
  background: var(--surface-card-light);
  box-shadow: 0 1px 2px rgb(15 23 42 / 0.05);
}

:global(.dark .deployment-surface) {
  border-color: var(--border-subtle-dark);
  background: var(--surface-card-dark);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.28);
}

:global(.dark .deployments-page) {
  color: var(--text-primary-dark);
}

:global(.dark .deployments-page .text-gray-500) {
  color: var(--text-muted-dark);
}

:global(.dark .deployments-page .text-gray-600) {
  color: var(--text-secondary-dark);
}

.deployments-page :deep(input:not([type='checkbox']):not([type='radio'])),
.deployments-page :deep(select),
.deployments-page :deep(textarea) {
  transition: color 150ms, background-color 150ms, border-color 150ms, box-shadow 150ms;
}

:global(.dark .deployments-page input:not([type='checkbox']):not([type='radio'])),
:global(.dark .deployments-page select),
:global(.dark .deployments-page textarea) {
  border-color: var(--border-standard-dark);
  background-color: rgb(255 255 255 / 0.035);
  color: var(--text-primary-dark);
}

:global(.dark .deployments-page input::placeholder),
:global(.dark .deployments-page textarea::placeholder) {
  color: var(--text-muted-dark);
  opacity: 1;
}

:global(.dark .deployments-page input:not([type='checkbox']):not([type='radio']):focus),
:global(.dark .deployments-page select:focus),
:global(.dark .deployments-page textarea:focus) {
  border-color: var(--color-primary-400);
  box-shadow: var(--focus-ring);
  outline: none;
}

:global(.dark .deployments-page input:disabled),
:global(.dark .deployments-page select:disabled),
:global(.dark .deployments-page textarea:disabled) {
  background-color: rgb(255 255 255 / 0.02);
  color: var(--text-muted-dark);
}

:global(.dark .deployments-page select option) {
  background: var(--surface-panel-dark);
  color: var(--text-primary-dark);
}

:global(.dark .deployments-page select option:disabled) {
  color: var(--text-muted-dark);
}

.deployments-page :deep(input[type='checkbox']),
.deployments-page :deep(input[type='radio']) {
  accent-color: var(--color-primary-600);
}

.deployments-page button,
.deployments-page .deploy-remote-trigger {
  border-radius: 0.5rem;
  transition: color 150ms, background-color 150ms, border-color 150ms, box-shadow 150ms, transform 150ms;
}

.deployments-page button:not(:disabled),
.deployments-page .deploy-remote-trigger:not([aria-disabled='true']) {
  cursor: pointer;
}

.deployments-page button:focus-visible,
.deployments-page .deploy-remote-trigger:focus-visible {
  outline: 2px solid rgb(59 130 246 / 0.65);
  outline-offset: 2px;
}

.deployments-page button:not(:disabled):active,
.deployments-page .deploy-remote-trigger:not([aria-disabled='true']):active {
  transform: translateY(1px);
}

.deployments-page button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.deployments-page .deploy-remote-trigger[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.5;
}

.deployments-page .deploy-remote-trigger::-webkit-details-marker {
  display: none;
}

.deploy-btn-neutral {
  border-color: rgb(229 231 235);
  background: rgb(255 255 255 / 0.8);
  color: rgb(55 65 81);
}

.deploy-btn-neutral:not(:disabled):not([aria-disabled='true']):hover {
  border-color: rgb(209 213 219);
  background: rgb(243 244 246);
  color: rgb(17 24 39);
}

:global(.dark .deploy-btn-neutral) {
  border-color: rgb(255 255 255 / 0.1);
  background: rgb(255 255 255 / 0.04);
  color: rgb(209 213 219);
}

:global(.dark .deploy-btn-neutral:not(:disabled):not([aria-disabled='true']):hover) {
  border-color: rgb(255 255 255 / 0.18);
  background: rgb(255 255 255 / 0.1);
  color: rgb(255 255 255);
}

.deploy-btn-danger:not(:disabled):hover {
  border-color: rgb(252 165 165);
  background: rgb(254 242 242);
  color: rgb(220 38 38);
}

:global(.dark .deploy-btn-danger:not(:disabled):hover) {
  border-color: rgb(248 113 113 / 0.45);
  background: rgb(239 68 68 / 0.14);
  color: rgb(252 165 165);
}

:global(.dark .deploy-btn-danger) {
  border-color: rgb(248 113 113 / 0.3);
  color: rgb(252 165 165);
}

.deploy-btn-primary:not(:disabled):hover {
  background: rgb(29 78 216);
  box-shadow: 0 4px 10px rgb(37 99 235 / 0.24);
}

.deploy-btn-primary:not(:disabled):active {
  transform: scale(0.95);
}

.deploy-btn-dark:not(:disabled):hover {
  background: rgb(255 255 255 / 0.14);
  color: rgb(255 255 255);
}

.deploy-btn-dark-success:not(:disabled):hover {
  background: rgb(16 185 129 / 0.16);
  color: rgb(167 243 208);
}

:global(.dark .deployment-command-panel) {
  background: rgb(3 7 18);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.3);
}

:global(.dark .deployment-command-panel textarea) {
  border-color: rgb(255 255 255 / 0.12);
  background: rgb(0 0 0 / 0.42);
}

.deployment-risk-panel {
  color: var(--text-primary-light);
}

:global(.dark .deployment-risk-dialog) {
  background: rgb(0 0 0 / 0.68);
}

:global(.dark .deployment-risk-panel) {
  border-color: var(--border-standard-dark);
  background: var(--surface-panel-dark);
  color: var(--text-primary-dark);
}

.deployment-form input:not([type='checkbox']):not(.keep-square),
.deployment-form select {
  border-radius: 0.5rem;
}

.deployment-form .keep-square {
  border-radius: 0;
}

.deployment-form [data-testid^='generate-'] {
  border-radius: 0 7px 7px 0;
}
</style>

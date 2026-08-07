import { api } from './http.js';

export const listDeployments = () => api.get('/api/deployments');
export const getDeploymentTemplate = id => api.get(`/api/deployments/${encodeURIComponent(id)}/template`);
export const createDeployment = payload => api.post('/api/deployments', payload);
export const updateDeployment = (id, payload) => api.patch(`/api/deployments/${encodeURIComponent(id)}`, payload);
export const deleteDeployment = (id, options = {}) => {
  const params = new URLSearchParams();
  if (options.preserveCloudflareResources === true) params.set('preserveCloudflareResources', 'true');
  if (options.deleteSubscriptionSource === true) params.set('deleteSubscriptionSource', 'true');
  const query = params.toString();
  return api.del(`/api/deployments/${encodeURIComponent(id)}${query ? `?${query}` : ''}`);
};
export const deleteDeploymentSource = id => api.del(`/api/deployments/${encodeURIComponent(id)}/source`);
export const restoreDeploymentSource = id => api.post(`/api/deployments/${encodeURIComponent(id)}/source`);
export const createDeploymentCommand = (id, action, payload = {}) => api.post(`/api/deployments/${encodeURIComponent(id)}/operations`, { action, ...payload });
export const createRemoteDeploymentCommand = (id, action, payload = {}) => api.post(`/api/deployments/${encodeURIComponent(id)}/commands`, { action, delivery: 'agent', ...payload });
export const provisionLocalExecutor = id => api.post(`/api/deployments/${encodeURIComponent(id)}/local-executor`);
export const getSystemCapabilities = () => api.get('/api/system/capabilities');
export const listDeploymentOperations = id => api.get(`/api/deployments/${encodeURIComponent(id)}/operations`);
export const getDeploymentDefaults = () => api.get('/api/deployment-defaults');
export const saveDeploymentDefaults = defaults => api.put('/api/deployment-defaults', { defaults });
export const resetDeploymentDefaults = () => api.del('/api/deployment-defaults');
export const checkDeploymentEdgePermissions = payload => api.post('/api/deployment-edge/cloudflare/check', payload);
export const cleanupDeploymentCloudflareResources = (id, deploymentName) => api.del(`/api/deployments/${encodeURIComponent(id)}/cloudflare-resources`, { body: JSON.stringify({ deploymentName }) });
export const probeDeploymentEdge = (id, payload) => api.post(`/api/deployments/${encodeURIComponent(id)}/edge-probes`, payload);

import { redactSensitiveText } from '../../functions/modules/security-utils.js';

export function assertDeploymentCommandResult(result) {
  if (result?.success === false || typeof result?.data?.command !== 'string' || !result.data.command.trim()
    || typeof result?.data?.wgetCommand !== 'string' || !result.data.wgetCommand.trim()) {
    const error = new Error('Invalid deployment command response');
    error.name = 'DeploymentResponseError';
    throw error;
  }
}

export function formatDeploymentError(error, t) {
  const data = error?.data && typeof error.data === 'object' ? error.data : {};
  const status = Number(error?.status) || 0;
  const rawCode = data.code !== 'INTERNAL_ERROR' || status >= 500 ? (data.code || data.error) : data.error;
  const code = typeof rawCode === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(rawCode) ? rawCode : '';
  const key = `deployments.commandErrors.${code}`;
  const translated = code ? t(key) : key;
  const remoteMessages = { agent_offline: 'deployments.remote.offline', agent_controller_mismatch: 'deployments.remote.controllerMismatch' };
  let message = translated !== key ? translated : (Object.hasOwn(remoteMessages, code) ? t(remoteMessages[code]) : '');
  if (!message) {
    if (status === 401 || status === 403 || error?.message === 'UNAUTHORIZED') message = t('deployments.commandErrors.auth');
    else if (error?.name === 'AbortError' || error?.name === 'TimeoutError') message = t('deployments.commandErrors.timeout');
    else if (!status && error?.name === 'TypeError') message = t('deployments.commandErrors.network');
    else if (status === 413) message = t('deployments.commandErrors.tooLarge');
    else if (status === 429) message = t('deployments.commandErrors.rateLimited');
    else if (status === 503) message = t('deployments.commandErrors.unavailable');
    else if (status >= 500) message = t('deployments.commandErrors.DEPLOYMENT_COMMAND_FAILED');
    else if (status === 409 && /REVISION_CONFLICT|revision|changed/i.test(data.error || data.message || '')) message = t('deployments.errors.configRevisionConflict');
    else if (status >= 400 && typeof (data.message || data.error) === 'string') message = redactSensitiveText(data.message || data.error).slice(0, 600);
    else message = t('deployments.commandErrors.invalidResponse');
  }
  const requestId = typeof data.requestId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(data.requestId) ? data.requestId : '';
  return { message, status, code, requestId };
}

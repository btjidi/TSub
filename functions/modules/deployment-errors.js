import { createErrorResponse, createJsonResponse } from './utils.js';
import { StorageInitializationError } from '../storage-adapter.js';

// Only these application-owned messages may be exposed for server failures.
// Never use exception text, upstream response bodies or environment values here.
const diagnostics = Object.freeze({
  DEPLOYMENT_KEY_MISSING: '未配置 DEPLOYMENT_SECRET_KEY。请在 Cloudflare Pages 当前环境添加至少 16 位的独立随机 Secret，然后重新部署。已有部署请恢复原密钥，不要随意更换。',
  DEPLOYMENT_KEY_INVALID: 'DEPLOYMENT_SECRET_KEY 不符合要求。请使用至少 16 位的非空白密钥并重新部署；已有加密配置必须使用原密钥。',
  DEPLOYMENT_DECRYPT_FAILED: '无法解密已保存的部署配置。请检查 DEPLOYMENT_SECRET_KEY 是否与保存配置时一致，并恢复原密钥；不要删除原部署或随机更换密钥。',
  DEPLOYMENT_ASSET_OVERRIDE_INCOMPLETE: '核心资产覆盖变量不完整。请删除对应核心的整组自定义覆盖变量以使用内置资产，或补齐版本、AMD64/ARM64 下载地址和 SHA-256 后重新部署。',
  DEPLOYMENT_ASSET_INVALID: '核心资产地址、格式或 SHA-256 无效。请检查对应核心的 HTTPS 地址、64 位 SHA-256 和解压后二进制校验值，或删除整组覆盖变量后重新部署。',
  DEPLOYMENT_PINNED_MANIFEST_INVALID: '固定版本清单不是有效 JSON。请修正 TSUB_PINNED_CORE_MANIFEST，或切换到 stable 通道。',
  DEPLOYMENT_PINNED_ASSET_MISSING: '固定版本清单中没有所选核心版本。请补齐 TSUB_PINNED_CORE_MANIFEST，或切换到 stable 通道。',
  DEPLOYMENT_STORAGE_UNAVAILABLE: '部署存储不可用。请检查当前环境的 TSUB_DB/TSUB_KV 绑定、存储模式和数据库初始化状态，然后重新部署。',
  DEPLOYMENT_COMMAND_FAILED: '部署请求未完成。请先刷新部署记录和操作记录，确认是否已保存，再重试，避免重复创建。请保留请求编号用于排查。'
});

export class DeploymentConfigurationError extends Error {
  constructor(code) {
    super(diagnostics[code] || diagnostics.DEPLOYMENT_COMMAND_FAILED);
    this.name = 'DeploymentConfigurationError';
    this.code = Object.hasOwn(diagnostics, code) ? code : 'DEPLOYMENT_COMMAND_FAILED';
    this.status = 503;
  }
}

export async function deploymentErrorResponse(error, fallbackStatus = 500) {
  let code = error instanceof DeploymentConfigurationError ? error.code : '';
  if (!code && (error instanceof StorageInitializationError || /^(No KV binding found|D1 database not available|KV and D1 bindings are required)$/.test(error?.message || ''))) {
    code = 'DEPLOYMENT_STORAGE_UNAVAILABLE';
  }
  const status = code ? 503 : (error?.status || fallbackStatus);
  const requestId = crypto.randomUUID();
  let body;
  if (code || status >= 500) {
    code ||= 'DEPLOYMENT_COMMAND_FAILED';
    body = { success: false, code, error: code, message: diagnostics[code], requestId };
    console.error('[Deployment]', { code, status, requestId });
  } else {
    body = await createErrorResponse(error?.code || error?.message || 'Invalid deployment request', status).json();
    if (typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.code)) body.code = error.code;
    body.requestId = requestId;
  }
  return createJsonResponse(body, status, { 'Cache-Control': 'no-store' });
}

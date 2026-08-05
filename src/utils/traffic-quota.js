export const GIBIBYTE_BYTES = 1024 ** 3;
export const TEBIBYTE_BYTES = 1024 ** 4;
export const MAX_TRAFFIC_QUOTA_OVERRIDE_BYTES = Number.MAX_SAFE_INTEGER;
export const TRAFFIC_QUOTA_UNITS = ['GB', 'TB'];

export function validateTrafficQuotaOverride(value) {
  if (value === undefined || value === null || value === '') return { valid: true, value: null };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TRAFFIC_QUOTA_OVERRIDE_BYTES) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

export function resolveTrafficQuotaOverride(subscription) {
  const result = validateTrafficQuotaOverride(subscription?.trafficQuotaOverrideBytes);
  return result.valid ? result.value : null;
}

export function resolveEffectiveTrafficTotal(subscription, userInfo = subscription?.userInfo) {
  const override = resolveTrafficQuotaOverride(subscription);
  if (override !== null) return override;
  const total = Number(userInfo?.total);
  return Number.isFinite(total) && total >= 0 ? total : 0;
}

export function resolveEffectiveUserInfo(subscription, userInfo = subscription?.userInfo) {
  if (!userInfo || typeof userInfo !== 'object') return null;
  return { ...userInfo, total: resolveEffectiveTrafficTotal(subscription, userInfo) };
}

export function hasTrafficUsage(userInfo) {
  return Boolean(userInfo)
    && typeof userInfo.upload === 'number' && Number.isFinite(userInfo.upload)
    && typeof userInfo.download === 'number' && Number.isFinite(userInfo.download);
}

export function trafficQuotaFormToBytes(value, unit = 'GB') {
  if (value === undefined || value === null || String(value).trim() === '') return { valid: true, value: null };
  const numeric = Number(value);
  const factor = unit === 'TB' ? TEBIBYTE_BYTES : unit === 'GB' ? GIBIBYTE_BYTES : 0;
  if (!factor || !Number.isFinite(numeric) || numeric <= 0) return { valid: false, value: null };
  const bytes = Math.round(numeric * factor);
  return validateTrafficQuotaOverride(bytes);
}

export function trafficQuotaBytesToForm(value) {
  const result = validateTrafficQuotaOverride(value);
  if (!result.valid || result.value === null) return { value: '', unit: 'GB' };
  const unit = result.value >= TEBIBYTE_BYTES ? 'TB' : 'GB';
  const factor = unit === 'TB' ? TEBIBYTE_BYTES : GIBIBYTE_BYTES;
  return { value: Number((result.value / factor).toFixed(6)), unit };
}

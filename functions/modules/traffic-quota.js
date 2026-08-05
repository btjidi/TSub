export const MAX_TRAFFIC_QUOTA_OVERRIDE_BYTES = Number.MAX_SAFE_INTEGER;

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

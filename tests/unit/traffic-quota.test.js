import { describe, expect, it } from 'vitest';
import {
  hasTrafficUsage,
  resolveEffectiveTrafficTotal,
  resolveEffectiveUserInfo,
  validateTrafficQuotaOverride
} from '../../functions/modules/traffic-quota.js';
import { trafficQuotaBytesToForm, trafficQuotaFormToBytes } from '../../src/utils/traffic-quota.js';

describe('traffic quota overrides', () => {
  it('validates positive safe integer bytes and treats blank values as inherited', () => {
    expect(validateTrafficQuotaOverride(undefined)).toEqual({ valid: true, value: null });
    expect(validateTrafficQuotaOverride(null)).toEqual({ valid: true, value: null });
    expect(validateTrafficQuotaOverride(1)).toEqual({ valid: true, value: 1 });
    for (const value of [0, -1, 1.5, '1024', Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateTrafficQuotaOverride(value).valid).toBe(false);
    }
  });

  it('converts decimal GB and TB forms without persisting UI fields', () => {
    expect(trafficQuotaFormToBytes('', 'GB')).toEqual({ valid: true, value: null });
    expect(trafficQuotaFormToBytes('1.5', 'GB')).toEqual({ valid: true, value: Math.round(1.5 * 1024 ** 3) });
    expect(trafficQuotaFormToBytes('2', 'TB')).toEqual({ valid: true, value: 2 * 1024 ** 4 });
    expect(trafficQuotaFormToBytes('0', 'GB').valid).toBe(false);
    expect(trafficQuotaBytesToForm(2 * 1024 ** 4)).toEqual({ value: 2, unit: 'TB' });
  });

  it('overrides only total while retaining live usage and expiration', () => {
    const source = { trafficQuotaOverrideBytes: 500, userInfo: { upload: 100, download: 200, total: 1000, expire: 42 } };
    expect(resolveEffectiveTrafficTotal(source)).toBe(500);
    expect(resolveEffectiveUserInfo(source)).toEqual({ upload: 100, download: 200, total: 500, expire: 42 });
    expect(hasTrafficUsage(source.userInfo)).toBe(true);
    expect(hasTrafficUsage({ total: 500 })).toBe(false);
  });
});

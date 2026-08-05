import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendTgNotification } = vi.hoisted(() => ({ sendTgNotification: vi.fn() }));

vi.mock('../../functions/services/notification-service.js', () => ({
  sendTgNotification,
  sendEnhancedTgNotification: vi.fn(),
  tgEscape: value => value
}));

import { checkAndNotify } from '../../functions/modules/notifications.js';

describe('traffic quota notification override', () => {
  beforeEach(() => {
    sendTgNotification.mockReset();
    sendTgNotification.mockResolvedValue(true);
  });

  it('uses the custom quota for traffic threshold notifications', async () => {
    const subscription = {
      name: 'Quota Source',
      trafficQuotaOverrideBytes: 100,
      userInfo: { upload: 45, download: 50, total: 1000, expire: 0 }
    };
    await checkAndNotify(subscription, { NotifyThresholdPercent: 90 }, {});
    expect(sendTgNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('已使用 95%')
    );
    expect(subscription.lastNotifiedTraffic).toEqual(expect.any(Number));
  });

  it('does not fabricate usage notifications when counters are unavailable', async () => {
    await checkAndNotify({
      name: 'Quota Only', trafficQuotaOverrideBytes: 100, userInfo: { total: 1000, expire: 0 }
    }, { NotifyThresholdPercent: 90 }, {});
    expect(sendTgNotification).not.toHaveBeenCalled();
  });
});

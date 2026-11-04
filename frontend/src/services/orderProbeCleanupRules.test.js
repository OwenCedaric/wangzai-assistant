import { describe, expect, it } from 'vitest';
import { readProjectSource, readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const notificationCenterSource = readProjectSource('src/app/shell/NotificationCenterPopover.jsx');

describe('order background probe cleanup rules', () => {
  it('does not keep the deprecated startup order-change probe', () => {
    expect(appSource).not.toContain('requestOzonOrderChangeProbe');
    expect(appSource).not.toContain('OZON_ORDER_CHANGE_PROBE');
    expect(appSource).not.toContain('orderChangeProbe');
    expect(appSource).not.toContain('后台订单变化探测');
    expect(appSource).not.toContain('后台探测将在启动后自动执行');
  });

  it('keeps order notifications on the durable backend ledger instead of page-diff memory', () => {
    expect(appSource).not.toContain('onOrderNotifications={addOrderNotifications}');
    expect(appSource).not.toContain('externalRefreshTick={orderNotificationRefreshTick}');
    expect(notificationCenterSource).not.toContain('localOrderNotifications');
    expect(notificationCenterSource).toContain('listOzonNotifications');
    expect(notificationCenterSource).toContain('暂时没有新的订单、商品或售后变化');
  });
});

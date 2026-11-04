import { describe, expect, it } from 'vitest';

import {
  getOzonOrderBaseStatusLabel,
  getOzonOrderDisplayStatusLabel,
  getOzonOrderStatusTextColor,
  isOzonAwaitingDeliveryRawStatus,
  normalizeOzonOrderRawStatus,
  OZON_ORDER_RAW_STATUS,
} from './orderStatusRules.jsx';

describe('Ozon order status contract', () => {
  it('uses the real Ozon FBS awaiting_deliver value as the canonical waiting-for-shipment status', () => {
    expect(normalizeOzonOrderRawStatus('awaiting_deliver')).toBe(OZON_ORDER_RAW_STATUS.awaitingDeliver);
    expect(isOzonAwaitingDeliveryRawStatus('awaiting_deliver')).toBe(true);
    expect(getOzonOrderBaseStatusLabel('awaiting_deliver')).toBe('等待发货');
    expect(getOzonOrderDisplayStatusLabel('awaiting_deliver')).toBe('等待发货');
  });

  it('accepts the historical awaiting_delivery alias but normalizes it to the real value', () => {
    expect(normalizeOzonOrderRawStatus('awaiting_delivery')).toBe(OZON_ORDER_RAW_STATUS.awaitingDeliver);
    expect(isOzonAwaitingDeliveryRawStatus('awaiting_delivery')).toBe(true);
    expect(getOzonOrderDisplayStatusLabel('awaiting_delivery')).toBe('等待发货');
  });

  it('shows an unknown raw status explicitly instead of the vague pending-confirmation fallback', () => {
    expect(getOzonOrderDisplayStatusLabel('future_ozon_status')).toBe('未识别状态：future_ozon_status');
    expect(getOzonOrderDisplayStatusLabel('')).toBe('未返回');
  });

  it('assigns distinct muted text colors to every business status group', () => {
    const statuses = [
      '',
      'awaiting_packaging',
      'awaiting_deliver',
      'delivering',
      'delivered',
      'cancelled',
      'returning',
      'future_ozon_status',
    ];
    const colors = statuses.map(getOzonOrderStatusTextColor);
    expect(new Set(colors)).toHaveLength(statuses.length);
    colors.forEach((color) => expect(color).toMatch(/^#[0-9a-f]{6}$/u));
  });
});

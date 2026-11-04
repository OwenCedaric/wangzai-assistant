import { describe, expect, it } from 'vitest';
import {
  doesSalesOrderMatchPaymentDateRange,
  getSalesOrderPaymentDateKey,
  normalizeSalesOrderDateFilter,
} from './orderDateRules.jsx';

describe('order payment date range rules', () => {
  it('normalizes filter dates before matching both boundaries', () => {
    const order = { paymentDate: '2026-08-12T04:30:00.000Z' };

    expect(normalizeSalesOrderDateFilter('2026/8/1')).toBe('2026-08-01');
    expect(getSalesOrderPaymentDateKey(order)).toBe('2026-08-12');
    expect(doesSalesOrderMatchPaymentDateRange(order, '2026-08-01', '2026-08-12')).toBe(true);
    expect(doesSalesOrderMatchPaymentDateRange(order, '2026-08-13', '')).toBe(false);
    expect(doesSalesOrderMatchPaymentDateRange(order, '', '2026-08-11')).toBe(false);
  });

  it('按北京时间归属付款日期，不把零点前后的订单错分到 UTC 前一天', () => {
    const earlyMorningOrder = { paymentDate: '2026-08-11T18:30:00.000Z' };

    expect(getSalesOrderPaymentDateKey(earlyMorningOrder)).toBe('2026-08-12');
    expect(doesSalesOrderMatchPaymentDateRange(earlyMorningOrder, '2026-08-12', '2026-08-12')).toBe(true);
    expect(doesSalesOrderMatchPaymentDateRange(earlyMorningOrder, '2026-08-11', '2026-08-11')).toBe(false);
  });

  it('keeps undated rows only when no explicit date filter is active', () => {
    const undatedOrder = { paymentDate: '未返回' };

    expect(doesSalesOrderMatchPaymentDateRange(undatedOrder, '', '')).toBe(true);
    expect(doesSalesOrderMatchPaymentDateRange(undatedOrder, '2026-08-01', '')).toBe(false);
    expect(doesSalesOrderMatchPaymentDateRange(undatedOrder, '', '2026-08-31')).toBe(false);
  });

});

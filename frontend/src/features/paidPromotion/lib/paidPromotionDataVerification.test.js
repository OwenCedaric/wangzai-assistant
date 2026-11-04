import { describe, expect, it } from 'vitest';

import {
  verifyPromotionOrderReport,
  verifyPromotionOverviewData,
} from './paidPromotionDataVerification.js';

describe('paid promotion data verification', () => {
  it('cross-checks overview metrics against exact daily and expense sources', () => {
    const result = verifyPromotionOverviewData({
      summary: { impressions: '1 000', clicks: '100', spent: '1.234,56', orders: '2', revenue: '2 000,00' },
      campaigns: [{ id: '1', statusLabel: '运行中', alerts: {}, products: [] }],
      dailyStats: [{ impressions: 1000, clicks: 100, spent: 1234.56, orders: 2, revenue: 2000 }],
      expenseStats: [{ spent: '1 234,56' }],
      dataSets: {
        dailyStatistics: { status: 'success' },
        expenseStatistics: { status: 'success' },
      },
    });

    expect(result.summary).toMatchObject({ impressions: 1000, clicks: 100, spent: 1234.56, orders: 2, revenue: 2000 });
    expect(result.metrics.spent.state).toBe('verified');
    expect(result.metrics.orders.state).toBe('verified');
  });

  it('does not compare a partial expense scope against the whole-shop spend total', () => {
    const result = verifyPromotionOverviewData({
      summary: { spent: 30 },
      campaigns: [],
      dailyStats: [
        { campaignId: '1', date: '2026-08-19', spent: 10 },
        { campaignId: '2', date: '2026-08-19', spent: 20 },
      ],
      expenseStats: [{ campaignId: '1', date: '2026-08-19', spent: 10 }],
      dataSets: {
        dailyStatistics: { status: 'success' },
        expenseStatistics: { status: 'success' },
      },
    });

    expect(result.metrics.spent.state).toBe('verified');
    expect(result.metrics.spent.note).toContain('只覆盖部分计划/日期');
    expect(result.metrics.spent.note).not.toContain('花费明细 10');
  });

  it('marks conflicting Ozon sources without overwriting the returned summary value', () => {
    const result = verifyPromotionOverviewData({
      summary: { orders: 1, revenue: 160.33 },
      campaigns: [],
      dailyStats: [{ orders: 0, revenue: 0 }],
      dataSets: { dailyStatistics: { status: 'success' } },
    });

    expect(result.summary.orders).toBe(1);
    expect(result.metrics.orders).toMatchObject({ state: 'mismatch', label: '口径不一致' });
    expect(result.metrics.orders.note).toContain('计划统计汇总 1');
    expect(result.metrics.orders.note).toContain('计划日报 0');
  });

  it('does not call an empty detail report no-orders when overview confirms one order', () => {
    const result = verifyPromotionOrderReport({
      overviewSummary: { orders: 1, revenue: 160.33, spent: 2.49 },
      report: { ok: true, complete: true, summary: { orderCount: 0, revenue: 0, spent: 0 }, rows: [] },
      rows: [],
    });

    expect(result.availability).toMatchObject({ status: 'mismatch', label: '统计有 1 单，明细未返回' });
    expect(result.summary).toMatchObject({ orders: 1, revenue: 160.33, spent: 2.49 });
    expect(result.message).toContain('不生成虚假订单行');
  });

  it('calls no-orders only when summary and a completed detail report are both zero', () => {
    const result = verifyPromotionOrderReport({
      overviewSummary: { orders: 0, revenue: 0 },
      report: { ok: true, complete: true, summary: { orderCount: 0, revenue: 0 }, rows: [] },
      rows: [],
    });

    expect(result.availability).toMatchObject({ status: 'empty', label: '交叉核对后无推广订单' });
  });

  it('accepts matching detail rows and exposes their auditable summary', () => {
    const rows = [{ orderId: 'o-1', quantity: 2, revenue: 160.33, spent: 2.49 }];
    const result = verifyPromotionOrderReport({
      overviewSummary: { orders: 1, revenue: 160.33 },
      report: { ok: true, complete: true, summary: { orderCount: 1, revenue: 160.33, spent: 2.49 }, rows },
      rows,
    });

    expect(result.availability.status).toBe('success');
    expect(result.summary).toMatchObject({ orders: 1, revenue: 160.33, spent: 2.49, quantity: 2 });
  });

  it('marks non-empty detail counts that differ from the overview', () => {
    const rows = [
      { orderId: 'o-1', quantity: 1, revenue: 100 },
      { orderId: 'o-2', quantity: 1, revenue: 100 },
    ];
    const result = verifyPromotionOrderReport({
      overviewSummary: { orders: 1, revenue: 200 },
      report: { ok: true, complete: true, summary: { orderCount: 2, revenue: 200 }, rows },
      rows,
    });

    expect(result.availability).toMatchObject({ status: 'mismatch', label: '订单汇总与明细不一致' });
    expect(result.message).toContain('统计汇总为 1 单');
    expect(result.message).toContain('订单明细为 2 单');
  });
});

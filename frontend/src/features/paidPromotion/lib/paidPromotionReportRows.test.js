import { describe, expect, it } from 'vitest';

import {
  aggregatePromotionMetricRows,
  buildCompletePromotionDailyTrend,
  getPromotionBidDisplayState,
  getPromotionDataSetAvailability,
  getPromotionDataSetsAvailability,
  getPromotionScopedDataAvailability,
  mergePromotionExpenseRows,
  sortPromotionRowsNewestFirst,
} from './paidPromotionReportRows.js';

describe('paid promotion report rows', () => {
  it('fills the selected date range newest-first without fabricating missing-day zero metrics', () => {
    const rows = buildCompletePromotionDailyTrend(
      [
        { date: '2026-08-08', impressions: 10, clicks: 1, spent: 2, orders: 0, revenue: 0 },
        { date: '2026-08-10', impressions: 20, clicks: 2, spent: 4, orders: 1, revenue: 20 },
      ],
      '2026-08-08',
      '2026-08-10'
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ date: '2026-08-10', orders: 1, availabilityState: 'returned' });
    expect(rows[1]).toMatchObject({
      date: '2026-08-09',
      availabilityState: 'no-record',
      impressions: null,
      clicks: null,
      spent: null,
      orders: null,
      revenue: null,
    });
    expect(rows[2]).toMatchObject({ date: '2026-08-08', availabilityState: 'returned' });
  });

  it('aggregates only returned base facts and derives ratios from the cleaned totals', () => {
    const summary = aggregatePromotionMetricRows([
      { impressions: 100, clicks: 10, spent: 20, orders: 1, revenue: 100 },
      { impressions: 50, clicks: 5, spent: 10, orders: 0, revenue: 0 },
      { impressions: null, clicks: null, spent: null, orders: null, revenue: null },
    ]);

    expect(summary).toMatchObject({
      impressions: 150,
      clicks: 15,
      spent: 30,
      orders: 1,
      revenue: 100,
      ctr: 10,
      cpc: 2,
      acos: 30,
      roas: 3.33,
      returnedRowCount: 2,
    });
  });

  it('preserves an all-zero row as real data but keeps an all-missing group unavailable', () => {
    expect(aggregatePromotionMetricRows([{ impressions: 0, clicks: 0, spent: 0, orders: 0, revenue: 0 }])).toMatchObject({
      impressions: 0,
      clicks: 0,
      spent: 0,
      orders: 0,
      revenue: 0,
      returnedRowCount: 1,
    });
    expect(aggregatePromotionMetricRows([{ impressions: null, clicks: null }])).toMatchObject({
      impressions: null,
      clicks: null,
      spent: null,
      orders: null,
      revenue: null,
      returnedRowCount: 0,
    });
  });

  it('distinguishes empty, failed, skipped, and real bid values', () => {
    expect(getPromotionBidDisplayState({ recommendedBid: 0 }, 'recommendedBid')).toEqual({
      state: 'value',
      value: 0,
      label: '',
    });
    expect(
      getPromotionBidDisplayState(
        { bidAvailability: { competitive: { status: 'empty' } } },
        'competitiveBid'
      )
    ).toMatchObject({ state: 'empty', label: '暂无建议' });
    expect(
      getPromotionBidDisplayState(
        { bidAvailability: { minCpo: { status: 'failed' } } },
        'minCpoBid'
      )
    ).toMatchObject({ state: 'failed', label: '读取失败' });
    expect(
      getPromotionBidDisplayState(
        { bidAvailability: { minimumCpc: { status: 'empty' } } },
        'minimumCpcBid'
      )
    ).toMatchObject({ state: 'empty', label: '暂无建议' });
    expect(
      getPromotionBidDisplayState(
        {
          bidAvailability: {
            minCpo: { status: 'empty' },
            minimumCpc: { status: 'failed' },
          },
        },
        'minimumCpcBid'
      )
    ).toMatchObject({ state: 'failed', label: '读取失败' });
  });

  it('maps dataset availability to user-facing states', () => {
    expect(getPromotionDataSetAvailability({ status: 'success' }).label).toBe('已完整返回');
    expect(getPromotionDataSetAvailability({ status: 'empty' }).label).toBe('接口明确无记录');
    expect(getPromotionDataSetAvailability({ status: 'partial' }).label).toBe('部分数据已返回');
    expect(getPromotionDataSetAvailability({ status: 'failed' }).label).toBe('读取失败');
  });

  it('combines complementary product statistic sources without treating a skipped source as missing', () => {
    expect(
      getPromotionDataSetsAvailability([{ status: 'skipped' }, { status: 'success' }, { status: 'empty' }])
    ).toEqual(expect.objectContaining({ status: 'success', label: '已完整返回' }));
    expect(
      getPromotionDataSetsAvailability([{ status: 'success' }, { status: 'failed' }])
    ).toEqual(expect.objectContaining({ status: 'partial', label: '部分数据已返回' }));
    expect(
      getPromotionDataSetsAvailability([{ status: 'skipped' }, { status: 'skipped' }])
    ).toEqual(expect.objectContaining({ status: 'skipped', label: '尚未读取' }));
  });

  it('sorts every dated report newest-first and keeps undated rows stable at the end', () => {
    const rows = sortPromotionRowsNewestFirst([
      { id: 'old', date: '2026-08-09' },
      { id: 'undated-a' },
      { id: 'new', date: '2026-08-13' },
      { id: 'undated-b' },
      { id: 'middle', orderDate: '2026-08-11T12:00:00Z' },
    ]);

    expect(rows.map((row) => row.id)).toEqual(['new', 'middle', 'old', 'undated-a', 'undated-b']);
  });

  it('joins expense money with exact campaign-day traffic without leaking another campaign', () => {
    const rows = mergePromotionExpenseRows(
      [
        {
          campaignId: '35189852',
          campaignTitle: '卡罗拉内饰套装600',
          date: '2026-08-09',
          spent: 29.37,
          bonusSpent: 0,
          prepaymentSpent: 0,
        },
      ],
      [
        { campaignId: 'wrong', date: '2026-08-09', impressions: 9999, clicks: 999, orders: 99, revenue: 9999 },
        { campaignId: '35189852', date: '2026-08-09', impressions: 79, clicks: 9, spent: 999, orders: 0, revenue: 0 },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaignId: '35189852',
      date: '2026-08-09',
      impressions: 79,
      clicks: 9,
      spent: 29.37,
      orders: 0,
      revenue: 0,
      ctr: 11.39,
      cpc: 3.26,
      statisticsJoined: true,
    });
  });

  it('keeps expense rows explicit when no exact daily statistic exists', () => {
    const [row] = mergePromotionExpenseRows(
      [{ campaignId: '1', date: '2026-08-10', spent: 10, bonusSpent: 0 }],
      [{ campaignId: '2', date: '2026-08-10', impressions: 100, clicks: 10 }]
    );

    expect(row).toMatchObject({ spent: 10, bonusSpent: 0, statisticsJoined: false });
    expect(row.impressions).toBeNull();
    expect(row.clicks).toBeNull();
  });

  it('reports scoped empty and partial states instead of claiming global success', () => {
    const success = getPromotionDataSetAvailability({ status: 'success' });
    expect(getPromotionScopedDataAvailability(success, [])).toMatchObject({
      status: 'empty',
      label: '当前范围无记录',
    });
    expect(getPromotionScopedDataAvailability(success, [{ sku: 'missing' }])).toMatchObject({
      status: 'empty',
      label: '当前范围无统计记录',
    });
    expect(
      getPromotionScopedDataAvailability(success, [
        { sku: 'returned', clicks: 0, spent: 0 },
        { sku: 'missing' },
      ])
    ).toMatchObject({ status: 'partial', label: '部分统计已返回' });
  });
});

import {
  formatDataAnalysisCount,
  formatDataAnalysisChineseText,
  formatDataAnalysisMetric,
  formatDataAnalysisMoney,
  formatDataAnalysisOperationType,
  formatDataAnalysisTime,
  formatDataAnalysisUserMessage,
  normalizeDataAnalysisCachePayload,
  normalizePerformanceAnalysis,
} from './dataAnalysisFormatter.js';
import { describe, expect, it } from 'vitest';

describe('dataAnalysisFormatter', () => {
  it('normalizes cache payload without inventing rows', () => {
    const normalized = normalizeDataAnalysisCachePayload({
      rows: [{ id: 'a', rowCount: 3 }],
      total: 1,
      stats: { rowCount: 3 },
      cache: { enabled: true },
    });

    expect(normalized.total).toBe(1);
    expect(normalized.rowCount).toBe(3);
    expect(normalized.cache.enabled).toBe(true);
  });

  it('formats empty and non-empty counts', () => {
    expect(formatDataAnalysisCount(0)).toBe('0');
    expect(formatDataAnalysisCount(1200, '行')).toBe('1,200行');
    expect(formatDataAnalysisMoney(12.3, 'CNY')).toBe('￥12.30');
    expect(formatDataAnalysisMoney(12.8, 'CNY', { maximumFractionDigits: 0 })).toBe('￥13');
  });

  it('does not crash on empty cache time', () => {
    expect(formatDataAnalysisTime('')).toBe('暂无同步');
  });

  it('keeps unavailable metrics explicit instead of inventing zero', () => {
    expect(formatDataAnalysisMetric({ unit: 'money', status: 'insufficient_sources', value: null })).toBe('待补齐来源');
    expect(
      formatDataAnalysisMetric({
        unit: 'money',
        status: 'currency_unconfirmed',
        value: null,
        breakdown: [{ currency: 'UNKNOWN', value: -18.5 }],
      })
    ).toContain('币种未确认');
    expect(
      formatDataAnalysisMetric({ unit: 'money', status: 'currency_unconfirmed', value: 12.5, currency: '' })
    ).toBe('12.5（币种未确认）');
    expect(
      formatDataAnalysisMetric({ unit: 'money', status: 'currency_unconfirmed', value: null, currency: 'CNY', breakdown: [] })
    ).toBe('汇率未确认');
  });

  it('does not expose skipped performance statistics as real zero', () => {
    const normalized = normalizePerformanceAnalysis({
      ok: true,
      readDepth: 'fast',
      summary: { spent: 0, impressions: 0 },
      stages: [{ key: 'dailyStatistics', status: 'skipped' }],
    });
    expect(normalized.statisticsRead).toBe(false);
    expect(normalized.metrics.find((metric) => metric.id === 'adSpend').value).toBeNull();
  });

  it('does not mark an empty successful advertising stage as confirmed zero', () => {
    const normalized = normalizePerformanceAnalysis({
      ok: true,
      summary: { spent: 0, impressions: 0, clicks: 0, orders: 0 },
      campaigns: [
        { id: 'a', spent: null, impressions: null, clicks: null, orders: null },
        { id: 'b', spent: null, impressions: null, clicks: null, orders: null },
      ],
      stages: [{ key: 'productStatistics', status: 'success', count: 1 }],
    });
    expect(normalized.statisticsRead).toBe(false);
    expect(normalized.statisticsCoverage).toEqual({
      campaignCount: 2,
      returnedCampaignCount: 0,
      returnedRowCount: 0,
      percent: 0,
    });
    expect(normalized.metrics.find((metric) => metric.id === 'adImpressions').status).toBe('not_returned');
    expect(normalized.metrics.find((metric) => metric.id === 'adImpressions').value).toBeNull();
  });

  it('marks advertising statistics partial when only some campaigns returned fields', () => {
    const normalized = normalizePerformanceAnalysis({
      ok: true,
      summary: { spent: 10, impressions: 100 },
      campaigns: [
        { id: 'a', spent: 10, impressions: 100 },
        { id: 'b', spent: null, impressions: null },
      ],
      dailyStats: [{ campaignId: 'a', date: '2026-07-10', spent: 10, impressions: 100 }],
      stages: [{ key: 'dailyStatistics', status: 'success', count: 1 }],
    });
    expect(normalized.statisticsRead).toBe(true);
    expect(normalized.statisticsStatus).toBe('partial');
    expect(normalized.metrics.find((metric) => metric.id === 'adSpend').status).toBe('partial');
  });

  it('ignores advertising summary and lifecycle totals when period statistics did not return', () => {
    const normalized = normalizePerformanceAnalysis({
      ok: true,
      summary: { spent: 999, impressions: 9999, orders: 99 },
      campaigns: [{ id: 'a', spent: 888, impressions: 8888, orders: 88, statistics: { rows: [] } }],
      dailyStats: [],
      productStats: [],
      stages: [{ key: 'dailyStatistics', status: 'success', count: 0 }],
    });
    expect(normalized.statisticsRead).toBe(false);
    expect(normalized.metrics.find((metric) => metric.id === 'adSpend').value).toBeNull();
    expect(normalized.campaigns[0].spent).toBeNull();
    expect(normalized.campaigns[0].impressions).toBeNull();
  });

  it('keeps a returned advertising zero as a real zero and preserves field-level gaps', () => {
    const normalized = normalizePerformanceAnalysis({
      ok: true,
      campaigns: [{ id: 'a' }],
      dailyStats: [{ campaignId: 'a', date: '2026-07-10', spent: 0, impressions: 0 }],
    });
    expect(normalized.statisticsRead).toBe(true);
    expect(normalized.metrics.find((metric) => metric.id === 'adSpend').value).toBe(0);
    expect(normalized.metrics.find((metric) => metric.id === 'adSpend').status).toBe('confirmed');
    expect(normalized.metrics.find((metric) => metric.id === 'adClicks').value).toBeNull();
    expect(normalized.dailyTrend[0].spent).toBe(0);
    expect(normalized.dailyTrend[0].clicks).toBeNull();
  });

  it('turns interface terminology and common platform codes into Chinese', () => {
    expect(formatDataAnalysisChineseText('Ozon订单SQLite缓存')).toBe('平台订单本地数据库缓存');
    expect(formatDataAnalysisChineseText('SKU ID from Performance API')).toBe('商品编码 编号 来自 广告接口');
    expect(formatDataAnalysisChineseText('status=delivered')).toBe('状态为已送达');
    expect(formatDataAnalysisChineseText('FBS')).toBe('商家仓发');
    expect(formatDataAnalysisChineseText('is_defect=true')).toBe('存在质量异常');
  });

  it('uses Chinese finance categories and hides untranslated service errors', () => {
    expect(formatDataAnalysisOperationType('OperationAgentDeliveredToCustomer')).toBe('商品送达结算');
    expect(formatDataAnalysisOperationType('OperationMarketplaceServiceStorage')).toBe('仓储服务费');
    expect(formatDataAnalysisUserMessage('ECONNREFUSED localhost:3000', '数据服务暂不可用')).toBe('数据服务暂不可用');
  });
});

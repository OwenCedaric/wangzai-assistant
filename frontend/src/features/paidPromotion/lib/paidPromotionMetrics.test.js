import { describe, expect, it } from 'vitest';
import {
  getPaidPromotionMetricStateLabel,
  resolvePaidPromotionMetric,
} from './paidPromotionMetrics.js';

describe('paidPromotionMetrics', () => {
  it('calculates CTR, CPC, ACOS and ROAS from base facts instead of depending on optional API fields', () => {
    const row = {
      statistics: {
        impressions: 400,
        clicks: 20,
        spent: 50,
        revenue: 200,
        ctr: null,
        cpc: null,
        acos: null,
        roas: null,
      },
    };

    expect(resolvePaidPromotionMetric(row, 'ctr')).toEqual({ value: 5, state: 'value', source: 'calculated' });
    expect(resolvePaidPromotionMetric(row, 'cpc')).toEqual({ value: 2.5, state: 'value', source: 'calculated' });
    expect(resolvePaidPromotionMetric(row, 'acos')).toEqual({ value: 25, state: 'value', source: 'calculated' });
    expect(resolvePaidPromotionMetric(row, 'roas')).toEqual({ value: 4, state: 'value', source: 'calculated' });
  });

  it('cleans localized Ozon numeric strings and keeps calculation precision until display formatting', () => {
    const row = {
      impressions: '1 000',
      clicks: '3',
      spent: '10,00 RUB',
      revenue: '30,00 ₽',
    };

    expect(resolvePaidPromotionMetric(row, 'ctr')).toEqual({
      value: 0.3,
      state: 'value',
      source: 'calculated',
    });
    expect(resolvePaidPromotionMetric(row, 'cpc')).toEqual({
      value: 3.333333,
      state: 'value',
      source: 'calculated',
    });
    expect(resolvePaidPromotionMetric(row, 'acos')).toEqual({
      value: 33.333333,
      state: 'value',
      source: 'calculated',
    });
  });

  it('rejects invalid and negative facts instead of turning them into misleading metrics', () => {
    expect(resolvePaidPromotionMetric({ spent: '-1', clicks: 2 }, 'cpc')).toEqual({
      value: null,
      state: 'missing',
      source: 'unavailable',
    });
    expect(resolvePaidPromotionMetric({ ctr: '6,52%' }, 'ctr')).toEqual({
      value: 6.52,
      state: 'value',
      source: 'returned',
    });
  });

  it('does not show a fake zero fee ratio when there is spend but no advertising sale', () => {
    const row = { spent: 13.88, revenue: 0, acos: 0, roas: 999 };

    expect(resolvePaidPromotionMetric(row, 'acos')).toEqual({ value: null, state: 'no-sales', source: 'calculated' });
    expect(resolvePaidPromotionMetric(row, 'roas')).toEqual({ value: 0, state: 'value', source: 'calculated' });
    expect(getPaidPromotionMetricStateLabel('no-sales')).toBe('暂无成交');
  });

  it('distinguishes zero denominators from unavailable base facts', () => {
    expect(resolvePaidPromotionMetric({ impressions: 0, clicks: 0 }, 'ctr').state).toBe('no-impressions');
    expect(resolvePaidPromotionMetric({ spent: 0, clicks: 0 }, 'cpc').state).toBe('no-clicks');
    expect(resolvePaidPromotionMetric({ spent: 0, revenue: 0 }, 'roas').state).toBe('no-spend');
    expect(resolvePaidPromotionMetric({}, 'cpc')).toEqual({ value: null, state: 'missing', source: 'unavailable' });
  });

  it('falls back to a valid direct optional metric when its base facts were not returned', () => {
    expect(resolvePaidPromotionMetric({ ctr: 9.32 }, 'ctr')).toEqual({
      value: 9.32,
      state: 'value',
      source: 'returned',
    });
    expect(resolvePaidPromotionMetric({ roi: 3.5 }, 'roas')).toEqual({
      value: 3.5,
      state: 'value',
      source: 'returned',
    });
  });

  it('does not mix a missing current-period statistic with a campaign-level value from another scope', () => {
    const row = {
      revenue: 999,
      spent: 100,
      statistics: { revenue: null, spent: 10, acos: null },
    };

    expect(resolvePaidPromotionMetric(row, 'acos')).toEqual({
      value: null,
      state: 'missing',
      source: 'unavailable',
    });
  });
});

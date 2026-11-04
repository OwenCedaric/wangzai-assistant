import { describe, expect, it } from 'vitest';
import {
  createOzonTimeRangeScope,
  refreshOzonTimeRangeScope,
  toOzonDateBoundaryIso,
} from './orderShopScope.jsx';

describe('Ozon order Beijing date boundaries', () => {
  it('用固定北京时间生成查询边界，不受用户电脑时区影响', () => {
    expect(toOzonDateBoundaryIso('2026-06-01')).toBe('2026-05-31T16:00:00.000Z');
    expect(toOzonDateBoundaryIso('2026-06-01', true)).toBe('2026-06-01T15:59:59.999Z');
  });

  it('付款日期范围和页面二次过滤使用同一天', () => {
    const scope = createOzonTimeRangeScope({
      page: 'profit-calculation',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
    });

    expect(scope.apiRange).toEqual({
      since: '2026-05-31T16:00:00.000Z',
      to: '2026-06-01T15:59:59.999Z',
    });
    expect(scope.startDateKey).toBe('2026-06-01');
    expect(scope.endDateKey).toBe('2026-06-01');
  });

  it('手动刷新未限定日期的订单时把结束时间推进到当前时刻', () => {
    const scope = createOzonTimeRangeScope({
      page: 'sales-orders',
      defaultDays: 90,
      now: new Date('2026-09-02T10:00:00.000Z'),
    });

    const refreshed = refreshOzonTimeRangeScope(scope, new Date('2026-09-02T12:34:00.000Z'));

    expect(refreshed.to).toBe('2026-09-02T12:34:00.000Z');
    expect(refreshed.since).toBe('2026-06-04T12:34:00.000Z');
  });

  it('用户明确选择结束日期后刷新不改变日期范围', () => {
    const scope = createOzonTimeRangeScope({
      page: 'sales-orders',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    });

    expect(refreshOzonTimeRangeScope(scope, new Date('2026-09-02T12:34:00.000Z'))).toBe(scope);
  });
});

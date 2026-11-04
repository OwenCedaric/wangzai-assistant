import { describe, expect, it } from 'vitest';
import {
  getAfterSalesOrderRecordKey,
  getFriendlyOzonOrderError,
  getOzonApiErrorMessage,
  getOzonOrderDateRange,
  getProfitOrderRecordKey,
  getSalesOrderRecordKey,
  isOzonRetryableReadError,
  mergeRowsByKey,
} from './ozonOrderSafety.js';

describe('ozonOrderSafety', () => {
  it('does not blame Ozon when a local cache read times out or is incomplete', () => {
    expect(getFriendlyOzonOrderError(new Error('本地 API 请求超时'))).toBe('读取失败：本地订单读取超时，请稍后重试。');
    expect(getFriendlyOzonOrderError(new Error('local-api 请求超时：8000ms'))).toBe('读取失败：本地订单读取超时，请稍后重试。');
    expect(getFriendlyOzonOrderError(new Error('SALES_ORDER_RANGE_INCOMPLETE: changed'))).toBe('读取失败：订单范围已变化或尚未完整读取，请刷新重试。');
  });
  it('builds the initial quick date range from explicit days', () => {
    const range = getOzonOrderDateRange(30, new Date('2026-06-23T00:00:00.000Z'));

    expect(range.to).toBe('2026-06-23T00:00:00.000Z');
    expect(range.since).toBe('2026-05-24T00:00:00.000Z');
  });

  it('uses 90 days as the default order range', () => {
    const range = getOzonOrderDateRange(undefined, new Date('2026-06-30T00:00:00.000Z'));

    expect(range.to).toBe('2026-06-30T00:00:00.000Z');
    expect(range.since).toBe('2026-04-01T00:00:00.000Z');
  });

  it('uses stable order keys without mixing shops', () => {
    expect(getSalesOrderRecordKey({ recordKey: 'shop-a:posting-1' })).toBe('shop-a:posting-1');
    expect(getAfterSalesOrderRecordKey({ salesOrder: 'posting-2' })).toBe('posting-2');
    expect(getProfitOrderRecordKey({ shopId: 'shop-a', posting: 'posting-1' })).toBe('shop-a:posting-1');
    expect(getProfitOrderRecordKey({ shopId: 'shop-b', posting: 'posting-1' })).toBe('shop-b:posting-1');
  });

  it('deduplicates rows by key while preserving later data', () => {
    const rows = mergeRowsByKey([
      { id: 'a', status: 'old', amount: 1 },
      { id: 'a', status: 'new' },
      { id: '', status: 'ignored' },
    ]);

    expect(rows).toEqual([{ id: 'a', status: 'new', amount: 1 }]);
  });

  it('classifies retryable and non-retryable read errors', () => {
    expect(isOzonRetryableReadError(new Error('HTTP 429'))).toBe(true);
    expect(isOzonRetryableReadError(new Error('HTTP 500'))).toBe(true);
    expect(isOzonRetryableReadError(new Error('timeout'))).toBe(true);
    expect(isOzonRetryableReadError(new Error('HTTP 403'))).toBe(false);
  });

  it('normalizes user-facing Ozon errors', () => {
    expect(getOzonApiErrorMessage(new Error('/v3/posting/fbs/list 请求失败：HTTP 500'))).toBe('HTTP 500');
    expect(
      getOzonApiErrorMessage(
        new Error(
          "EPERM: operation not permitted, rename 'C:\\runtime\\purchase-bridge-license.json.tmp' -> 'C:\\runtime\\purchase-bridge-license.json'"
        )
      )
    ).toBe('本机授权状态同步短暂冲突，请点击刷新重试。');
    expect(getFriendlyOzonOrderError(new Error('HTTP 403'))).toBe('读取失败：店铺接口权限不足或密钥无效。');
    expect(getFriendlyOzonOrderError(new Error('HTTP 429'))).toBe('读取失败：Ozon 限流中，请稍后重试。');
  });
});

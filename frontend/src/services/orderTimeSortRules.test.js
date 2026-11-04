import { describe, expect, it, vi } from 'vitest';
import {
  getAfterSalesOrderActivityTimeMs,
  getOrderPaymentTimeMs,
  parseOrderTimeMs,
  sortAfterSalesRowsByNewestActivityTime,
  sortOrderRowsByNewestPaymentTime,
} from './orderTimeSortRules';

describe('order time sort rules', () => {
  it('parses each row time only once, not again for every comparison', () => {
    const parse = vi.spyOn(Date, 'parse');
    try {
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        id: `order-${i}`, paymentDate: `2026-09-${String((i * 17) % 28 + 1).padStart(2, '0')}T12:00:00Z`,
      }));
      sortOrderRowsByNewestPaymentTime(rows);
      expect(parse).toHaveBeenCalledTimes(rows.length);
    } finally { parse.mockRestore(); }
  });

  it('parses full and compact order time text without losing the year', () => {
    expect(parseOrderTimeMs('2026/07/01 14:56:50')).toBe(new Date(2026, 6, 1, 14, 56, 50).getTime());
    expect(parseOrderTimeMs('06/24 11:22', { fallbackYear: 2026 })).toBe(new Date(2026, 5, 24, 11, 22, 0).getTime());
    expect(parseOrderTimeMs('未返回')).toBe(0);
  });

  it('sorts sales and purchase rows by newest payment time before pagination', () => {
    const rows = [
      { id: 'old', paymentDate: '2026-06-24T13:02:00.000Z' },
      { id: 'new', paymentTime: '2026/07/01 14:56:50' },
      { id: 'middle', raw: { paid_at: '2026-06-30T09:00:00.000Z' } },
      { id: 'missing' },
    ];

    expect(sortOrderRowsByNewestPaymentTime(rows).map((row) => row.id)).toEqual(['new', 'middle', 'old', 'missing']);
    expect(getOrderPaymentTimeMs(rows[2])).toBe(Date.parse('2026-06-30T09:00:00.000Z'));
  });

  it('keeps split siblings in natural order when their payment time is the same', () => {
    const rows = [
      { id: 'TEST-SPLIT-0001-3', paymentDate: '2026-07-01T14:56:50.000Z' },
      { id: 'TEST-SPLIT-0001-1', paymentDate: '2026-07-01T14:56:50.000Z' },
      { id: 'TEST-SPLIT-0001-2', paymentDate: '2026-07-01T14:56:50.000Z' },
    ];

    expect(sortOrderRowsByNewestPaymentTime(rows).map((row) => row.id)).toEqual([
      'TEST-SPLIT-0001-1',
      'TEST-SPLIT-0001-2',
      'TEST-SPLIT-0001-3',
    ]);
  });

  it('matches the previous comparator for tied, missing, invalid dates, Unicode and natural numeric order', () => {
    const legacySort = (rows, getTime) => rows.map((row, index) => ({ row, index })).sort((a, b) => {
      const leftTime = getTime(a.row), rightTime = getTime(b.row);
      if (leftTime !== rightTime) return rightTime - leftTime;
      if (!leftTime && !rightTime) return a.index - b.index;
      const key = row => {
        const posting = String(row.id).trim().toUpperCase(), match = posting.match(/^(.*?)-(\d+)$/u);
        return { posting, base: match ? match[1] : posting, suffix: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER };
      };
      const left = key(a.row), right = key(b.row);
      return left.base.localeCompare(right.base, 'en', { numeric: true }) || left.suffix - right.suffix
        || left.posting.localeCompare(right.posting, 'en', { numeric: true });
    }).map(entry => entry.row);
    const dates = ['', '未返回', 'not-a-date', '2026-09-07T12:00:00Z', '2026-09-07T20:00:00+08:00', '2026/09/06 08:30:00', '09/05 12:20'];
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `${['中', 'ä', 'А', 'a', 'A2', 'A10', '01'][i % 7]}-${(i * 17) % 31}`,
      paymentDate: dates[i % dates.length], refundTime: dates[(i * 3) % dates.length],
    }));
    expect(sortOrderRowsByNewestPaymentTime(rows)).toEqual(legacySort(rows, getOrderPaymentTimeMs));
    expect(sortAfterSalesRowsByNewestActivityTime(rows)).toEqual(legacySort(rows, getAfterSalesOrderActivityTimeMs));
    expect(rows[0].id).toBe('中-0');
  });

  it('sorts after-sales rows by newest refund or activity time', () => {
    const rows = [
      { id: 'old', updated: '06/24 11:22' },
      { id: 'new-refund', refundTime: '2026-07-03T12:00:00.000Z' },
      { id: 'new-update', raw: { updated_at: '2026-07-02T09:00:00.000Z' } },
      { id: 'missing' },
    ];

    expect(sortAfterSalesRowsByNewestActivityTime(rows).map((row) => row.id)).toEqual([
      'new-refund',
      'new-update',
      'old',
      'missing',
    ]);
    expect(getAfterSalesOrderActivityTimeMs(rows[2])).toBe(Date.parse('2026-07-02T09:00:00.000Z'));
  });
});

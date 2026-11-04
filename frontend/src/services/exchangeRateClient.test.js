import { describe, expect, it } from 'vitest';
import {
  createRubCnyExchangeRateReader,
  getRubCnyRateForDate,
  normalizeRubCnyRatePayload,
} from './exchangeRateClient.js';

describe('exchangeRateClient', () => {
  it('keeps realtime and daily exchange rate as the only rate entrances', async () => {
    const calls = [];
    const readContext = createRubCnyExchangeRateReader({
      readRealtime: async () => {
        calls.push(['realtime']);
        return { ok: true, mode: 'realtime', rate: 0.092, source: 'unit-realtime', fetchedAt: 'now' };
      },
      readDaily: async (date) => {
        calls.push(['daily', date]);
        return { ok: true, mode: 'daily', date, rate: 0.091, source: 'unit-daily', fetchedAt: 'now' };
      },
    });

    const context = await readContext(['2026-07-03', '2026-07-04'], { todayKey: '2026-07-04' });

    expect(calls).toEqual([['realtime'], ['daily', '2026-07-03']]);
    expect(getRubCnyRateForDate('2026-07-04', context).rubToCnyRate).toBe(0.092);
    expect(getRubCnyRateForDate('2026-07-03', context).rubToCnyRate).toBe(0.091);
  });

  it('uses nearest daily rate when realtime rate is unavailable', async () => {
    const calls = [];
    const readContext = createRubCnyExchangeRateReader({
      readRealtime: async () => {
        calls.push(['realtime']);
        throw new Error('realtime unavailable');
      },
      readDaily: async (date, options) => {
        calls.push(['daily', date, options.allowNearest]);
        return {
          ok: true,
          mode: 'daily',
          requestedDate: date,
          date: '2026-07-03',
          nearestFallback: true,
          rate: 0.0876,
          source: 'unit-daily',
          fetchedAt: 'now',
        };
      },
    });

    const context = await readContext(['2026-07-04'], { todayKey: '2026-07-04' });

    expect(calls).toEqual([['realtime'], ['daily', '2026-07-04', true]]);
    expect(getRubCnyRateForDate('2026-07-04', context)).toMatchObject({
      mode: 'daily-nearest',
      date: '2026-07-03',
      requestedDate: '2026-07-04',
      nearestFallback: true,
      rubToCnyRate: 0.0876,
    });
  });

  it('does not fabricate a cached or fixed fallback rate', () => {
    expect(normalizeRubCnyRatePayload({ ok: true, rate: 0 })).toBeNull();
    expect(normalizeRubCnyRatePayload({ ok: false, rate: 0.09 })).toBeNull();
    expect(getRubCnyRateForDate('2026-07-02', { todayKey: '2026-07-04', dailyRates: new Map() })).toBeNull();
  });

  it('uses realtime rate as the temporary nearest available rate while historical daily rate is still loading', () => {
    const realtime = {
      mode: 'realtime',
      rubToCnyRate: 0.0876,
      source: 'unit-realtime',
    };

    expect(
      getRubCnyRateForDate('2026-06-22', {
        todayKey: '2026-07-04',
        realtime,
        dailyRates: new Map(),
      })
    ).toBe(realtime);
  });

  it('can skip daily rate reads for local-first profit page entry', async () => {
    const calls = [];
    const readContext = createRubCnyExchangeRateReader({
      readRealtime: async () => {
        calls.push(['realtime']);
        return { ok: true, mode: 'realtime', rate: 0.0876, source: 'unit-realtime', fetchedAt: 'now' };
      },
      readDaily: async (date) => {
        calls.push(['daily', date]);
        return { ok: true, mode: 'daily', date, rate: 0.091, source: 'unit-daily', fetchedAt: 'now' };
      },
    });

    const context = await readContext(['2026-06-22', '2026-06-24'], {
      todayKey: '2026-07-04',
      skipDailyRates: true,
    });

    expect(calls).toEqual([['realtime']]);
    expect(context.dailyRates.size).toBe(0);
    expect(getRubCnyRateForDate('2026-06-22', context)?.rubToCnyRate).toBe(0.0876);
  });

  it('reads multiple historical dates through one batch request', async () => {
    const calls = [];
    const readContext = createRubCnyExchangeRateReader({
      readRealtime: async () => {
        calls.push(['realtime']);
        return { ok: true, mode: 'realtime', rate: 0.092, source: 'unit-realtime', fetchedAt: 'now' };
      },
      readDaily: async (date) => {
        calls.push(['daily', date]);
        throw new Error('individual daily request must not run');
      },
      readDailyBatch: async (dates, options) => {
        calls.push(['daily-batch', dates, options.allowNearest]);
        return {
          ok: true,
          rates: {
            '2026-07-01': {
              requestedDate: '2026-07-01',
              date: '2026-07-01',
              rate: 0.089,
              source: 'unit-daily-batch',
            },
            '2026-07-02': {
              requestedDate: '2026-07-02',
              date: '2026-07-02',
              rate: 0.09,
              source: 'unit-daily-batch',
            },
          },
        };
      },
    });

    const context = await readContext(['2026-07-01', '2026-07-02', '2026-07-03'], {
      todayKey: '2026-07-03',
    });

    expect(calls).toEqual([['realtime'], ['daily-batch', ['2026-07-01', '2026-07-02'], true]]);
    expect(context.errors).toEqual([]);
    expect(getRubCnyRateForDate('2026-07-01', context)).toMatchObject({
      mode: 'daily',
      requestedDate: '2026-07-01',
      rubToCnyRate: 0.089,
    });
    expect(getRubCnyRateForDate('2026-07-03', context)?.rubToCnyRate).toBe(0.092);
  });

  it('records a batch failure without falling back to many individual daily requests', async () => {
    const calls = [];
    const readContext = createRubCnyExchangeRateReader({
      readRealtime: async () => {
        calls.push(['realtime']);
        return { ok: true, mode: 'realtime', rate: 0.092, source: 'unit-realtime', fetchedAt: 'now' };
      },
      readDaily: async (date) => {
        calls.push(['daily', date]);
        return { ok: true, mode: 'daily', date, rate: 0.09, source: 'unit-daily', fetchedAt: 'now' };
      },
      readDailyBatch: async (dates) => {
        calls.push(['daily-batch', dates]);
        throw new Error('batch unavailable');
      },
    });

    const context = await readContext(['2026-07-01', '2026-07-02', '2026-07-03'], {
      todayKey: '2026-07-03',
    });

    expect(calls).toEqual([['realtime'], ['daily-batch', ['2026-07-01', '2026-07-02']]]);
    expect(context.dailyRates.size).toBe(0);
    expect(context.errors).toHaveLength(1);
    expect(context.errors[0]).toMatchObject({ label: '历史日汇率批量读取' });
    expect(context.errors[0].error.message).toBe('batch unavailable');
    expect(getRubCnyRateForDate('2026-07-01', context)?.rubToCnyRate).toBe(0.092);
  });

  it('keeps the individual daily path when batch reads are explicitly disabled', async () => {
    const calls = [];
    const readContext = createRubCnyExchangeRateReader({
      readRealtime: async () => ({
        ok: true,
        mode: 'realtime',
        rate: 0.092,
        source: 'unit-realtime',
        fetchedAt: 'now',
      }),
      readDaily: async (date) => {
        calls.push(['daily', date]);
        return { ok: true, mode: 'daily', date, rate: 0.09, source: 'unit-daily', fetchedAt: 'now' };
      },
      readDailyBatch: async () => {
        calls.push(['daily-batch']);
        return { ok: true, rates: [] };
      },
    });

    const context = await readContext(['2026-07-01', '2026-07-02', '2026-07-03'], {
      todayKey: '2026-07-03',
      useBatchRates: false,
      dailyConcurrency: 2,
    });

    expect(calls).toEqual([
      ['daily', '2026-07-01'],
      ['daily', '2026-07-02'],
    ]);
    expect(context.errors).toEqual([]);
    expect(context.dailyRates.size).toBe(2);
  });
});

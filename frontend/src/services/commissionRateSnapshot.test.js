import { describe, expect, it } from 'vitest';

import {
  getCommissionRateDateKey,
  normalizeCommissionRateHistory,
  resolveDailyCommissionRateSnapshot,
  selectCommissionRateSnapshot,
  upsertDailyCommissionRateSnapshot,
} from './commissionRateSnapshot.js';

describe('commissionRateSnapshot', () => {
  it('stores one rFBS commission rate per local business date', () => {
    const history = upsertDailyCommissionRateSnapshot(
      {},
      {
        rate: '12%',
        mode: 'rFBS',
        source: 'ozon:/v5/product/info/prices',
        readAt: '2026-06-25T08:00:00.000Z',
      }
    );

    expect(getCommissionRateDateKey('2026-06-25T08:00:00.000Z')).toBe('2026-06-25');
    expect(history['2026-06-25']).toMatchObject({
      rate: 12,
      percent: 12,
      mode: 'rFBS',
      source: 'ozon:/v5/product/info/prices',
    });
  });

  it('keeps old date rates when a later Ozon read returns a new rate', () => {
    const juneHistory = upsertDailyCommissionRateSnapshot({}, { rate: 12, readAt: '2026-06-25T08:00:00.000Z' });
    const julyHistory = upsertDailyCommissionRateSnapshot(juneHistory, {
      rate: 15,
      readAt: '2026-07-01T08:00:00.000Z',
    });

    expect(normalizeCommissionRateHistory(julyHistory)).toMatchObject({
      '2026-06-25': { rate: 12 },
      '2026-07-01': { rate: 15 },
    });
  });

  it('uses a locked order rate date even when a newer rate exists', () => {
    const history = {
      '2026-06-25': { rate: 12, readAt: '2026-06-25T08:00:00.000Z' },
      '2026-07-01': { rate: 15, readAt: '2026-07-01T08:00:00.000Z' },
    };

    const snapshot = resolveDailyCommissionRateSnapshot(history, {
      lockedDateKey: '2026-06-25',
      orderDateKey: '2026-06-22',
      fallbackRate: 16,
      readAt: '2026-07-02T08:00:00.000Z',
    });

    expect(snapshot).toMatchObject({
      dateKey: '2026-06-25',
      rate: 12,
      locked: true,
    });
    expect(snapshot.history['2026-07-02'].rate).toBe(16);
  });

  it('falls back to latest available daily rate when exact order date is not stored', () => {
    const snapshot = selectCommissionRateSnapshot(
      {
        '2026-06-25': { rate: 12 },
        '2026-07-01': { rate: 15 },
      },
      '2026-06-28'
    );

    expect(snapshot).toMatchObject({
      dateKey: '2026-06-25',
      rate: 12,
    });
  });

  it('uses earliest stored rate when an older order predates all snapshots', () => {
    const snapshot = selectCommissionRateSnapshot(
      {
        '2026-06-25': { rate: 12 },
        '2026-07-01': { rate: 15 },
      },
      '2026-06-22'
    );

    expect(snapshot).toMatchObject({
      dateKey: '2026-06-25',
      rate: 12,
    });
  });

  it('never reuses an FBS daily snapshot for an rFBS order', () => {
    const snapshot = selectCommissionRateSnapshot(
      {
        '2026-06-25': { rate: 12, mode: 'rFBS' },
        '2026-06-28': { rate: 17, mode: 'FBS' },
      },
      '2026-06-28',
      'rFBS'
    );

    expect(snapshot).toMatchObject({
      dateKey: '2026-06-25',
      rate: 12,
      mode: 'rFBS',
    });
  });

  it('ignores a locked date when its saved rate belongs to a different fulfillment mode', () => {
    const snapshot = resolveDailyCommissionRateSnapshot(
      {
        '2026-06-25': { rate: 12, mode: 'rFBS' },
        '2026-06-28': { rate: 17, mode: 'FBS' },
      },
      {
        lockedDateKey: '2026-06-28',
        orderDateKey: '2026-06-28',
        mode: 'rFBS',
        fallbackRate: 12,
        readAt: '2026-07-01T00:00:00.000Z',
      }
    );

    expect(snapshot.locked).toBe(false);
    expect(snapshot.rate).toBe(12);
    expect(snapshot.mode).toBe('rFBS');
  });
});

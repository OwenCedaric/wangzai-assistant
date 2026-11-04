import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCanonical: vi.fn(),
  saveCanonical: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  enqueue: vi.fn((_, task) => task()),
}));

vi.mock('../../services/exchangeRateClient', () => ({
  readRubCnyExchangeRateContext: vi.fn(),
  readRubCnyRateCache: mocks.readCanonical,
  saveRubCnyRateCacheRecords: mocks.saveCanonical,
}));

vi.mock('../product/productLocalData.jsx', () => ({
  readLocalDataFile: mocks.readFile,
  writeLocalDataFile: mocks.writeFile,
  enqueueOzonLocalDataWrite: mocks.enqueue,
}));

import { readProfitExchangeRateCache, writeProfitExchangeRateCachePatch } from './profitExchangeRateCache';

const dailyRecord = {
  requestedDate: '2026-07-10',
  date: '2026-07-10',
  mode: 'daily',
  rubToCnyRate: 0.0895,
  source: 'cbr',
  immutable: true,
};

describe('profitExchangeRateCache', () => {
  afterEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

  it('reads canonical SQLite cache without parsing the legacy profit JSON', async () => {
    mocks.readCanonical.mockResolvedValue({ ok: true, records: [dailyRecord] });

    const cache = await readProfitExchangeRateCache('profit-local-cache');

    expect(cache.daily['2026-07-10']).toMatchObject({ rubToCnyRate: 0.0895, immutable: true });
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('imports the legacy rate cache only when SQLite has no rows', async () => {
    mocks.readCanonical.mockResolvedValue({ ok: true, records: [] });
    mocks.readFile.mockResolvedValue({ profitExchangeRates: { version: 1, daily: { '2026-07-10': dailyRecord }, realtime: {} } });
    mocks.saveCanonical.mockResolvedValue({ ok: true });

    const cache = await readProfitExchangeRateCache('profit-local-cache');

    expect(cache.daily['2026-07-10']).toMatchObject({ rubToCnyRate: 0.0895 });
    expect(mocks.saveCanonical).toHaveBeenCalledWith(
      [expect.objectContaining({ requestedDate: '2026-07-10', rubToCnyRate: 0.0895 })],
      { timeoutMs: 3000 }
    );
  });

  it('writes a fresh rate patch to SQLite without a normal JSON dual write', async () => {
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    const context = {
      todayKey: '2026-07-12',
      realtime: { ...dailyRecord, requestedDate: '2026-07-12', date: '2026-07-12', immutable: false },
      dailyRates: new Map([['2026-07-10', dailyRecord]]),
    };

    await writeProfitExchangeRateCachePatch(context, { now: () => new Date('2026-07-12T00:00:00.000Z') });

    expect(mocks.saveCanonical).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});

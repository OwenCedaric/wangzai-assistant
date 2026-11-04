import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfitLedgerSnapshot, createProfitLedgerRow, PROFIT_LEDGER_CALCULATION_VERSION } from '../../services/profitLedgerService.js';
import { createEmptyOzonLocalDataStore, mergeOzonSnapshotIntoLocalStore } from '../../services/ozonLocalDataLayer.js';
import {
  writeOzonLocalDataSnapshot,
  ozonLocalDataWriteQueues,
} from './productLocalData.jsx';
import {
  clearProfitLedgerLocalSnapshot,
  readProfitLedgerLocalSnapshot,
  writeProfitLedgerLocalSnapshot,
} from '../profit/profitLedgerPersistence.jsx';

const localDataFileClient = vi.hoisted(() => ({
  readLocalDataFile: vi.fn(),
  writeLocalDataFile: vi.fn(),
}));

const profitLedgerApi = vi.hoisted(() => ({
  getProfitLedgerStorageLayout: vi.fn(async () => ({ partitioned: false, independentShopIds: [] })),
  getProfitLedgerSnapshot: vi.fn(),
  saveProfitLedgerSnapshot: vi.fn(),
  clearProfitLedgerSnapshots: vi.fn(),
}));

vi.mock('../../services/localDataFileClient.js', () => ({
  isBlockedLegacyLocalDataFileKey: vi.fn(() => false),
  readLocalDataFile: localDataFileClient.readLocalDataFile,
  requestLocalDataFile: vi.fn(),
  writeLocalDataFile: localDataFileClient.writeLocalDataFile,
}));

vi.mock('../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfitLedgerStorageLayout: profitLedgerApi.getProfitLedgerStorageLayout,
  getProfitLedgerSnapshot: profitLedgerApi.getProfitLedgerSnapshot,
  saveProfitLedgerSnapshot: profitLedgerApi.saveProfitLedgerSnapshot,
  clearProfitLedgerSnapshots: profitLedgerApi.clearProfitLedgerSnapshots,
}));

describe('writeProfitLedgerLocalSnapshot', () => {
  beforeEach(() => {
    ozonLocalDataWriteQueues.clear();
    localDataFileClient.readLocalDataFile.mockReset();
    localDataFileClient.writeLocalDataFile.mockReset();
    localDataFileClient.writeLocalDataFile.mockResolvedValue({});
    profitLedgerApi.getProfitLedgerSnapshot.mockReset();
    profitLedgerApi.saveProfitLedgerSnapshot.mockReset();
    profitLedgerApi.clearProfitLedgerSnapshots.mockReset();
    profitLedgerApi.getProfitLedgerSnapshot.mockResolvedValue({ snapshot: null, snapshotKey: '' });
    profitLedgerApi.saveProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null, stats: { compacted: false } });
  });

  it('writes a fresh profit ledger only to SQLite', async () => {
    const currentKey = 'profit:shop-a:range:2026-06-02_2026-09-02:filter:all';
    const currentSnapshot = createProfitLedgerSnapshot(
      [{ id: 'current-order', amountValue: 16, currencyCode: 'CNY' }],
      { sourceKey: currentKey, fetchedAt: '2026-07-01T00:00:00.000Z' }
    );
    localDataFileClient.readLocalDataFile.mockResolvedValue({
      profitLedgerSnapshots: {
        [currentKey]: currentSnapshot,
      },
    });

    profitLedgerApi.saveProfitLedgerSnapshot.mockResolvedValue({
      ok: true,
      snapshot: currentSnapshot,
      stats: { compacted: false, removedSnapshots: 0 },
    });
    const result = await writeProfitLedgerLocalSnapshot('profit-local-cache', currentKey, currentSnapshot);

    expect(result.stats.changed).toBe(true);
    expect(result.stats.sqliteOnly).toBe(true);
    expect(profitLedgerApi.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(2);
    expect(profitLedgerApi.saveProfitLedgerSnapshot.mock.calls[0][0]).toContain(`${currentKey}::chunk:`);
    expect(profitLedgerApi.saveProfitLedgerSnapshot.mock.calls[0][2]).toEqual(expect.objectContaining({
      chunkOf: currentKey,
      chunkIndex: 0,
      chunkCount: 1,
    }));
    expect(profitLedgerApi.saveProfitLedgerSnapshot.mock.calls[1]).toEqual([
      currentKey,
      expect.objectContaining({
        persistenceFormat: 'profit-ledger-chunked-v1',
        rowCount: 1,
        chunkKeys: [expect.stringContaining(`${currentKey}::chunk:`)],
      }),
      { timeoutMs: 60_000 },
    ]);
    expect(localDataFileClient.readLocalDataFile.mock.calls.every(([fileKey]) => fileKey !== 'profit-local-cache')).toBe(
      true
    );
    expect(localDataFileClient.writeLocalDataFile.mock.calls.every(([fileKey]) => fileKey !== 'profit-local-cache')).toBe(
      true
    );
  });

  it('fails closed when SQLite write fails instead of writing a legacy JSON fallback', async () => {
    const currentKey = 'profit:shop-a:range:2026-06-02_2026-09-02:filter:all';
    const currentSnapshot = createProfitLedgerSnapshot(
      [{ id: 'current-order', amountValue: 16, currencyCode: 'CNY' }],
      { sourceKey: currentKey, fetchedAt: '2026-07-01T00:00:00.000Z' }
    );
    localDataFileClient.readLocalDataFile.mockResolvedValue({
      profitLedgerSnapshots: { [currentKey]: currentSnapshot },
    });
    profitLedgerApi.saveProfitLedgerSnapshot.mockRejectedValue(new Error('SQLite temporarily unavailable'));

    await expect(writeProfitLedgerLocalSnapshot('profit-local-cache', currentKey, currentSnapshot)).rejects.toThrow(
      'SQLite temporarily unavailable'
    );
    expect(profitLedgerApi.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(1);
    expect(localDataFileClient.readLocalDataFile.mock.calls.every(([fileKey]) => fileKey !== 'profit-local-cache')).toBe(
      true
    );
    expect(localDataFileClient.writeLocalDataFile.mock.calls.every(([fileKey]) => fileKey !== 'profit-local-cache')).toBe(
      true
    );
  });

  it('migrates an unchanged single-blob snapshot to chunked persistence', async () => {
    const currentKey = 'profit:shop-a:range:2026-06-02_2026-09-02:filter:all';
    const currentSnapshot = createProfitLedgerSnapshot(
      [{ id: 'current-order', amountValue: 16, currencyCode: 'CNY' }],
      { sourceKey: currentKey, fetchedAt: '2026-07-01T00:00:00.000Z' }
    );
    profitLedgerApi.getProfitLedgerSnapshot.mockResolvedValue({
      snapshot: currentSnapshot,
      snapshotKey: currentKey,
    });

    await writeProfitLedgerLocalSnapshot('profit-local-cache', currentKey, currentSnapshot);

    expect(profitLedgerApi.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(2);
    expect(profitLedgerApi.saveProfitLedgerSnapshot.mock.calls[1][1]).toEqual(expect.objectContaining({
      persistenceFormat: 'profit-ledger-chunked-v1',
      rowCount: 1,
    }));
  });
  it('rejects an ok:false chunk response instead of confirming a fresh SQLite ledger', async () => {
    profitLedgerApi.saveProfitLedgerSnapshot.mockResolvedValue({ ok: false });
    await expect(writeProfitLedgerLocalSnapshot('profit-local-cache', 'synthetic-key', createProfitLedgerSnapshot([
      { id: 'synthetic-order', amountValue: 16, currencyCode: 'CNY' },
    ]))).rejects.toThrow('PROFIT_LEDGER_CHUNK_WRITE_FAILED');
    expect(profitLedgerApi.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(1);
    expect(localDataFileClient.writeLocalDataFile).not.toHaveBeenCalled();
  });

  it('clears only the canonical SQLite ledger snapshot', async () => {
    const currentKey = 'profit:shop-a:range:2026-06-02_2026-09-02:filter:all';
    localDataFileClient.readLocalDataFile.mockResolvedValue({
      profitLedgerSnapshots: { [currentKey]: { rows: [] } },
    });
    profitLedgerApi.clearProfitLedgerSnapshots.mockResolvedValue({
      stats: { changed: true, removedSnapshots: 1 },
    });
    const result = await clearProfitLedgerLocalSnapshot('profit-local-cache', currentKey);

    expect(profitLedgerApi.clearProfitLedgerSnapshots).toHaveBeenCalledWith([currentKey]);
    expect(result).toEqual(
      expect.objectContaining({
        changed: true,
        removedSnapshots: 1,
        sqliteOnly: true,
      })
    );
    expect(localDataFileClient.readLocalDataFile).not.toHaveBeenCalled();
    expect(localDataFileClient.writeLocalDataFile).not.toHaveBeenCalled();
  });
});

describe('readProfitLedgerLocalSnapshot', () => {
  beforeEach(() => {
    ozonLocalDataWriteQueues.clear();
    localDataFileClient.readLocalDataFile.mockReset();
    localDataFileClient.writeLocalDataFile.mockReset();
    localDataFileClient.writeLocalDataFile.mockResolvedValue({});
    profitLedgerApi.getProfitLedgerSnapshot.mockReset();
    profitLedgerApi.saveProfitLedgerSnapshot.mockReset();
    profitLedgerApi.clearProfitLedgerSnapshots.mockReset();
  });

  it('does not return or promote a legacy JSON ledger when SQLite has no snapshot', async () => {
    const key = 'profit:shop-a:range:2026-06-02_2026-09-02:filter:all';
    const snapshot = createProfitLedgerSnapshot([{ id: 'order-1', amountValue: 16, currencyCode: 'CNY' }], {
      sourceKey: key,
      fetchedAt: '2026-07-01T00:00:00.000Z',
    });
    profitLedgerApi.getProfitLedgerSnapshot.mockResolvedValue({ snapshot: null, snapshotKey: '' });
    localDataFileClient.readLocalDataFile.mockResolvedValue({ profitLedgerSnapshots: { [key]: snapshot } });

    const result = await readProfitLedgerLocalSnapshot('profit-local-cache', key);

    expect(result).toBeNull();
    expect(profitLedgerApi.saveProfitLedgerSnapshot).not.toHaveBeenCalled();
    expect(localDataFileClient.readLocalDataFile).not.toHaveBeenCalled();
    expect(localDataFileClient.writeLocalDataFile).not.toHaveBeenCalled();
  });
  it('upgrades SQLite v15 rows before profit and purchase views check their version, without clearing evidence', async () => {
    const row = createProfitLedgerRow({ id: 'posting-1', shopId: 'shop-1', amountValue: 20, currencyCode: 'CNY' });
    row.calculationVersion = 'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge';
    row.amounts.actualCommissionFeeCny = { value: 2, status: 'ready', source: 'ozon-finance-detail' };
    const snapshot = { calculationVersion: row.calculationVersion, rows: [row] };
    profitLedgerApi.getProfitLedgerSnapshot.mockResolvedValue({ snapshotKey: 'key', snapshot });
    const result = await readProfitLedgerLocalSnapshot('profit-local-cache', 'key');
    expect(result.rows[0].calculationVersion).toBe(PROFIT_LEDGER_CALCULATION_VERSION);
    expect(result.rows[0].amounts).toEqual(row.amounts);
    expect(result.rows[0].results).toEqual(row.results);
    expect(profitLedgerApi.saveProfitLedgerSnapshot).not.toHaveBeenCalled();
  });
});

describe('writeOzonLocalDataSnapshot', () => {
  beforeEach(() => {
    ozonLocalDataWriteQueues.clear();
    localDataFileClient.readLocalDataFile.mockReset();
    localDataFileClient.writeLocalDataFile.mockReset();
    localDataFileClient.writeLocalDataFile.mockResolvedValue({});
  });

  it('removes only the verified legacy after-sales snapshot candidate after the canonical key is written', async () => {
    const legacyKey =
      'ozon-after-sales:ozon-shop:client:4616153:after-sales-orders:range:2026-04-12_2026-07-11:filter:all';
    const primaryKey =
      'ozon-after-sales:ozon-shop:id:ozon-shop-1:after-sales-orders:range:2026-04-13_2026-07-12:filter:all';
    const anotherShopKey =
      'ozon-after-sales:ozon-shop:id:ozon-shop-2:after-sales-orders:range:2026-04-13_2026-07-12:filter:all';
    let existingStore = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      legacyKey,
      {
        rows: [{ recordKey: 'legacy-shop:posting-1', shopClientId: '4616153', posting: 'posting-1', products: [] }],
      },
      { now: '2026-07-11T00:00:00.000Z' }
    ).store;
    existingStore = mergeOzonSnapshotIntoLocalStore(
      existingStore,
      anotherShopKey,
      {
        rows: [{ recordKey: 'other-shop:posting-1', shopClientId: 'other-shop', posting: 'posting-1', products: [] }],
      },
      { now: '2026-07-12T00:00:00.000Z' }
    ).store;
    localDataFileClient.readLocalDataFile.mockResolvedValue(existingStore);

    await writeOzonLocalDataSnapshot(
      'after-sales-display-snapshots',
      [primaryKey, legacyKey],
      {
        rows: [{ recordKey: 'stable-shop:posting-2', shopId: 'ozon-shop-1', shopClientId: '4616153', posting: 'posting-2', products: [] }],
      }
    );

    const writtenStore = localDataFileClient.writeLocalDataFile.mock.calls[0][1];
    expect(writtenStore.snapshots[legacyKey]).toBeUndefined();
    expect(writtenStore.snapshots[primaryKey]).toBeDefined();
    expect(writtenStore.snapshots[anotherShopKey]).toBeDefined();
  });
});

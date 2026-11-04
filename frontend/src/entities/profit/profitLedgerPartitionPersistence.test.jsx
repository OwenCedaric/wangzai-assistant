import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getProfitLedgerStorageLayout: vi.fn(), getProfitLedgerSnapshot: vi.fn(), saveProfitLedgerSnapshot: vi.fn(), clearProfitLedgerSnapshots: vi.fn() }));
vi.mock('../../api/localApiClient.js', async (original) => ({ ...(await original()), ...api }));
import { readProfitLedgerLocalSnapshot, writeProfitLedgerLocalSnapshot } from './profitLedgerPersistence.jsx';
import { enqueueOzonLocalDataWrite, ozonLocalDataWriteQueues } from '../product/productLocalData.jsx';
import { createProfitLedgerRow, createProfitLedgerSnapshot, mergeProfitLedgerSnapshotIntoStore } from '../../services/profitLedgerService.js';
import { compactProfitLedgerSnapshotForPersistence } from '../../services/profitLedgerPersistenceCompaction.js';
import * as execution from '../../services/profitLedgerStorageExecution.js';

const KEY = 'profit:all:range:all-history';
function makeRows() {
  return [1, 2, 3].map((n) => createProfitLedgerRow({ id: 'same-1', posting: 'same-1', shopId: `shop-${n}`, status: 'delivered', amountValue: 100, currencyCode: 'CNY' }, {
    amounts: { sourcePurchaseCostCny: n, actualCommissionFeeCny: n, actualPenaltyFeeCny: 0, actualAcquiringFeeCny: 0, actualDeliveryServiceFeeCny: 0, actualLogisticsFeeCny: 0, crossBorderBusFeeCny: 1 },
    actualFinanceStatus: 'confirmed', hasActualFinance: true, financeLookupChecked: true,
  }));
}
describe('shop 1 profit persistence pilot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ozonLocalDataWriteQueues.clear(); Object.values(api).forEach((fn) => fn.mockReset());
    api.getProfitLedgerStorageLayout.mockResolvedValue({ ok: true, partitioned: true, independentShopIds: ['shop-1'] });
    api.saveProfitLedgerSnapshot.mockResolvedValue({ ok: true, stats: {} });
  });
  it('does not write a chunk or manifest before remote merge completes, and rejects its failure', async () => {
    let rejectMerge;
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    vi.spyOn(execution, 'mergeProfitLedgerStoreForExecution').mockImplementation(() => new Promise((_resolve, reject) => { rejectMerge = reject; }));
    const pending = writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(makeRows().slice(0, 1)));
    const rejected = expect(pending).rejects.toThrow('fixture-remote-merge-failure');
    await vi.waitFor(() => expect(rejectMerge).toBeTypeOf('function'));
    expect(api.saveProfitLedgerSnapshot).not.toHaveBeenCalled();
    rejectMerge(new Error('fixture-remote-merge-failure'));
    await rejected;
    expect(api.saveProfitLedgerSnapshot).not.toHaveBeenCalled();
  });
  it('aggregates reads from the independent store and unchanged shared stores without mixing owner routes', async () => {
    const rows = makeRows();
    api.getProfitLedgerSnapshot.mockImplementation(async (_keys, route) => ({ ok: true, snapshotKey: KEY,
      snapshot: createProfitLedgerSnapshot(rows.filter((row) => route.shopId ? row.shopId === route.shopId : row.shopId !== 'shop-1')) }));
    const snapshot = await readProfitLedgerLocalSnapshot('profit', KEY);
    expect(snapshot.rows).toHaveLength(3); expect(new Set(snapshot.rows.map((r) => r.shopId)).size).toBe(3);
    expect(api.getProfitLedgerSnapshot.mock.calls.map(([, route]) => route)).toEqual([{ shopId: 'shop-1' }, { sharedOnly: true, excludedShopIds: ['shop-1'] }]);
  });
  it('saves shop 1 while the residual shared queue is blocked, without sending its rows to shared storage', async () => {
    const rows = makeRows();
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    let unblock;
    const blocking = enqueueOzonLocalDataWrite('profit:shared', () => new Promise((resolve) => { unblock = resolve; }));
    await Promise.resolve();
    const pending = writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(rows));
    await vi.waitFor(() => expect(api.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(2));
    expect(api.saveProfitLedgerSnapshot.mock.calls.every(([, , options]) => options.shopId === 'shop-1')).toBe(true);
    expect(api.saveProfitLedgerSnapshot.mock.calls[0][1].rows.map((r) => r.shopId)).toEqual(['shop-1']);
    unblock(); await blocking; await pending;
    const sharedChunks = api.saveProfitLedgerSnapshot.mock.calls.filter(([, s, route]) => route.sharedOnly && s.rows?.length);
    expect(sharedChunks).toHaveLength(1); expect(sharedChunks[0][1].rows.map((r) => r.shopId)).toEqual(['shop-2', 'shop-3']);
  });
  it('does not rewrite the unchanged stores when only shop 1 changes', async () => {
    const rows = makeRows();
    const stored = (subset) => {
      const original = createProfitLedgerSnapshot(subset, { sourceKey: KEY });
      const normalized = mergeProfitLedgerSnapshotIntoStore({ profitLedgerSnapshots: { [KEY]: original } }, KEY, original).snapshot;
      return { ...compactProfitLedgerSnapshotForPersistence(normalized), persistenceFormat: 'profit-ledger-chunked-v1' };
    };
    api.getProfitLedgerSnapshot.mockImplementation(async (_keys, route) => ({ ok: true, snapshotKey: KEY, snapshot: stored(rows.filter((r) => route.shopId ? r.shopId === 'shop-1' : r.shopId !== 'shop-1')) }));
    const changed = structuredClone(rows); changed[0].amounts.actualCommissionFeeCny.value = 0;
    await writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(changed, { sourceKey: KEY }));
    expect(api.saveProfitLedgerSnapshot.mock.calls.every(([, , route]) => route.shopId === 'shop-1')).toBe(true);
    expect(api.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(2);
  });
  it('keeps shop-specific error metadata with its owner and global diagnostics in shared storage', async () => {
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    const errors = [{ shopId: 'shop-1', message: 'one' }, { shopId: 'shop-2', message: 'two' }, { message: 'global' }];
    await writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(makeRows(), { errors }));
    const manifests = api.saveProfitLedgerSnapshot.mock.calls.filter(([, snapshot]) => snapshot.persistenceFormat === 'profit-ledger-chunked-v1');
    expect(manifests.find(([, , route]) => route.shopId === 'shop-1')[1].errors).toEqual(errors.slice(0, 1));
    expect(manifests.find(([, , route]) => route.sharedOnly)[1].errors).toEqual(errors.slice(1));
  });
  it('a shop-1-only update completes without even reading or queueing shared shops', async () => {
    api.getProfitLedgerSnapshot.mockImplementation(async (_keys, route) => {
      if (!route.shopId) throw new Error('must not touch other shops');
      return { ok: true, snapshot: null };
    });
    const result = await writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(makeRows().slice(0, 1)));
    expect(result.snapshot.rows.map((row) => row.shopId)).toEqual(['shop-1']);
    expect(result.stats.partialOwnerUpdate).toBe(true);
    expect(result.stats.updatedShopIds).toEqual(['shop-1']);
    expect(api.getProfitLedgerSnapshot.mock.calls.every(([, route]) => route.shopId === 'shop-1')).toBe(true);
    expect(api.saveProfitLedgerSnapshot.mock.calls.every(([, , route]) => route.shopId === 'shop-1')).toBe(true);
  });
  it('sends one verified atomic request for the independent owner instead of one request per chunk plus a header', async () => {
    api.getProfitLedgerStorageLayout.mockResolvedValue({ partitioned: true, independentShopIds: ['shop-1'], atomicBatchWrite: true });
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    api.saveProfitLedgerSnapshot.mockImplementation(async (_key, snapshot) => ({ ok: true, snapshot,
      stats: { readbackVerified: true, rowCount: snapshot.rowCount } }));
    await writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(makeRows().slice(0, 1)));
    expect(api.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(1);
    expect(api.saveProfitLedgerSnapshot.mock.calls[0][2]).toMatchObject({ shopId: 'shop-1', chunks: expect.any(Array) });
  });
  it('coalesces only identical queued owner snapshots and retains distinct updates', async () => {
    api.getProfitLedgerStorageLayout.mockResolvedValue({ partitioned: true, independentShopIds: ['shop-1'], atomicBatchWrite: true });
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    api.saveProfitLedgerSnapshot.mockImplementation(async (_key, snapshot) => ({ ok: true, snapshot,
      stats: { readbackVerified: true, rowCount: snapshot.rowCount } }));
    let unblock;
    const barrier = enqueueOzonLocalDataWrite('profit:shop:shop-1', () => new Promise((resolve) => { unblock = resolve; }));
    await Promise.resolve();
    const rows = makeRows().slice(0, 1);
    const a = writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(rows));
    const b = writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(structuredClone(rows)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unblock(); await barrier; await Promise.all([a, b]);
    expect(api.getProfitLedgerSnapshot).toHaveBeenCalledTimes(1);
    expect(api.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(1);
    const changed = structuredClone(rows); changed[0].amounts.actualCommissionFeeCny.value = 0;
    await writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(changed));
    expect(api.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(2);
    expect(api.saveProfitLedgerSnapshot.mock.calls[1][2].chunks[0].rows[0].amounts.actualCommissionFeeCny.value).toBe(0);
  });
  it('does not accept an unverified or mismatched atomic acknowledgement', async () => {
    api.getProfitLedgerStorageLayout.mockResolvedValue({ partitioned: true, independentShopIds: ['shop-1'], atomicBatchWrite: true });
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    api.saveProfitLedgerSnapshot.mockResolvedValue({ ok: true, stats: { readbackVerified: false, rowCount: 1 } });
    await expect(writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(makeRows().slice(0, 1))))
      .rejects.toThrow('PROFIT_LEDGER_BATCH_READBACK_MISMATCH');
  });
  it('does not combine equal data when the compatible read scopes differ', async () => {
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    let unblock;
    const barrier = enqueueOzonLocalDataWrite('profit:shop:shop-1', () => new Promise((resolve) => { unblock = resolve; }));
    await Promise.resolve();
    const snapshot = createProfitLedgerSnapshot(makeRows().slice(0, 1));
    const first = writeProfitLedgerLocalSnapshot('profit', [KEY, 'legacy-a'], snapshot);
    const second = writeProfitLedgerLocalSnapshot('profit', [KEY, 'legacy-b'], snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    unblock(); await barrier; await Promise.all([first, second]);
    expect(api.getProfitLedgerSnapshot).toHaveBeenCalledTimes(2);
    expect(api.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(4);
  });
  it('retains the original shared-store write protocol even when the independent store supports batches', async () => {
    api.getProfitLedgerStorageLayout.mockResolvedValue({ partitioned: true, independentShopIds: ['shop-1'], atomicBatchWrite: true });
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    await writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(makeRows().slice(1)));
    expect(api.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(2);
    expect(api.saveProfitLedgerSnapshot.mock.calls.every(([, , options]) => options.sharedOnly && !options.chunks)).toBe(true);
  });
  it('returns healthy partitions with explicit per-owner failures instead of rejecting every shop', async () => {
    api.getProfitLedgerStorageLayout.mockResolvedValue({ partitioned: true, independentShopIds: ['shop-1', 'shop-2', 'shop-3'] });
    api.getProfitLedgerSnapshot.mockImplementation(async (_keys, route) => {
      if (route.shopId === 'shop-2') throw new Error('synthetic shop-2 failure');
      return { ok: true, snapshotKey: KEY, snapshot: createProfitLedgerSnapshot(makeRows().filter(row => row.shopId === route.shopId)) };
    });
    const onPartition = vi.fn();
    const snapshot = await readProfitLedgerLocalSnapshot('profit', KEY, { onPartition });
    expect(snapshot.rows.map(row => row.shopId)).toEqual(['shop-1', 'shop-3']);
    expect(snapshot).toMatchObject({ partial: true, readComplete: false,
      partitionErrors: [{ shopId: 'shop-2', code: 'PROFIT_LEDGER_PARTITION_READ_FAILED', message: 'synthetic shop-2 failure' }] });
    expect(onPartition).toHaveBeenCalledTimes(4);
  });
  it('publishes one shop without waiting for a slow owner', async () => {
    let release;
    api.getProfitLedgerSnapshot.mockImplementation((_keys, route) => route.shopId
      ? Promise.resolve({ ok: true, snapshotKey: KEY, snapshot: createProfitLedgerSnapshot(makeRows().slice(0, 1)) })
      : new Promise(resolve => { release = resolve; }));
    const onPartition = vi.fn();
    const pending = readProfitLedgerLocalSnapshot('profit', KEY, { onPartition });
    await vi.waitFor(() => expect(onPartition).toHaveBeenCalledWith(expect.objectContaining({ shopId: 'shop-1', status: 'fulfilled' })));
    expect(onPartition).toHaveBeenCalledTimes(1);
    release({ ok: true, snapshot: null });
    expect((await pending).readComplete).toBe(true);
  });
  it('persists errors for a shop with no rows and preserves its previously saved rows', async () => {
    const rows = makeRows();
    api.getProfitLedgerStorageLayout.mockResolvedValue({ partitioned: true, independentShopIds: ['shop-1', 'shop-2', 'shop-3'] });
    api.getProfitLedgerSnapshot.mockImplementation(async (_keys, route) => ({ ok: true, snapshotKey: KEY,
      snapshot: route.shopId === 'shop-2' ? createProfitLedgerSnapshot(rows.slice(1, 2)) : null }));
    const error = { shopId: 'shop-2', message: 'synthetic order-sync failure' };
    const result = await writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(rows.slice(0, 1), { errors: [error] }));
    expect(result.snapshot.rows.map(row => row.shopId).sort()).toEqual(['shop-1', 'shop-2']);
    expect(result.snapshot.errors).toContainEqual(error);
    expect(api.saveProfitLedgerSnapshot.mock.calls.some(([, snapshot, route]) => route.shopId === 'shop-2' && snapshot.errors?.[0]?.message === error.message)).toBe(true);
  });
  it('records an errors-only shared diagnostic instead of silently skipping the write', async () => {
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    const result = await writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot([], { errors: [{ message: 'synthetic global failure' }] }));
    expect(result.snapshot.errors).toEqual([{ message: 'synthetic global failure' }]);
    expect(api.saveProfitLedgerSnapshot).toHaveBeenCalled();
  });
  it('rejects a partially failed save with the independently completed owners attached', async () => {
    api.getProfitLedgerSnapshot.mockImplementation(async (_keys, route) => {
      if (route.sharedOnly) throw new Error('synthetic shared failure');
      return { ok: true, snapshot: null };
    });
    await expect(writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(makeRows())))
      .rejects.toMatchObject({ partialResult: { stats: { partial: true, updatedShopIds: ['shop-1'] } },
        partitionErrors: [{ sharedOnly: true, message: 'synthetic shared failure' }] });
  });
  it('keeps penalty detail metadata from every partition in the preferred readback field', async () => {
    api.getProfitLedgerSnapshot.mockImplementation(async (_keys, route) => ({ ok: true, snapshotKey: KEY,
      snapshot: { ...createProfitLedgerSnapshot(makeRows().filter(row => route.shopId ? row.shopId === 'shop-1' : row.shopId !== 'shop-1')),
        penaltyDetails: { [route.shopId || 'shared']: { shopId: route.shopId || 'shop-2', postingNumber: 'same-1', amountCny: 1 } } } }));
    const snapshot = await readProfitLedgerLocalSnapshot('profit', KEY);
    expect(Object.keys(snapshot.profitPenaltyDetails).sort()).toEqual(['shared', 'shop-1']);
  });
  it('rejects a failed non-atomic chunk acknowledgement without publishing its manifest', async () => {
    api.getProfitLedgerSnapshot.mockResolvedValue({ ok: true, snapshot: null });
    api.saveProfitLedgerSnapshot.mockResolvedValue({ ok: false, error: { message: 'synthetic chunk rejection' } });
    await expect(writeProfitLedgerLocalSnapshot('profit', KEY, createProfitLedgerSnapshot(makeRows().slice(0, 1))))
      .rejects.toThrow('synthetic chunk rejection');
    expect(api.saveProfitLedgerSnapshot).toHaveBeenCalledTimes(1);
  });
});

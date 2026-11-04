import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createProfitLedgerRow, createProfitLedgerSnapshot, readProfitLedgerSnapshotFromStore, mergeProfitLedgerSnapshotIntoStore } from './profitLedgerService.js';
import { executeProfitBatch } from '../../../desktop/server-core/profitExecution.mjs';
import { createProfitCoreBatch, readProfitCoreResults } from './profitCoreWire.js';

let storage;
beforeAll(async () => {
  vi.stubEnv('VITE_PRIVATE_PROFIT_CORE', '1'); vi.resetModules();
  storage = await import('./profitLedgerStorageExecution.js');
});
afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });
const key = 'fixture-key';
const row = createProfitLedgerRow({ id: 'one', shopId: 'shop-one', amountValue: 100, currencyCode: 'CNY' }, { updatedAt: '2026-09-08T00:00:00Z' });
const snapshot = createProfitLedgerSnapshot([row], { fetchedAt: '2026-09-08T00:00:00Z' });
const store = { profitLedgerSnapshots: { [key]: snapshot } };
const server = async calls => readProfitCoreResults(executeProfitBatch(createProfitCoreBatch(calls)), calls);

it('pilot reads and writes invoke remote migration/merge instead of the disabled synchronous runner', async () => {
  const execute = vi.fn(server);
  expect(await storage.readProfitLedgerSnapshotForExecution(store, key, { execute })).toEqual(readProfitLedgerSnapshotFromStore(store, key));
  expect(await storage.mergeProfitLedgerStoreForExecution(store, key, snapshot, { execute }))
    .toEqual(mergeProfitLedgerSnapshotIntoStore(store, key, snapshot));
  expect(execute.mock.calls.map(([calls]) => calls[0].operation)).toEqual(['migrate-ledger', 'migrate-ledger', 'merge-ledger']);
});

it('pilot storage failures cannot fall through to a local calculation or success-shaped store', async () => {
  const execute = vi.fn().mockRejectedValue(new Error('fixture-server-offline'));
  await expect(storage.mergeProfitLedgerStoreForExecution(store, key, snapshot, { execute })).rejects.toThrow('fixture-server-offline');
  expect(execute).toHaveBeenCalledTimes(1);
});

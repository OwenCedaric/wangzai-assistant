import { afterEach, expect, it, vi } from 'vitest';
import {
  createProfitLedgerRow, createProfitLedgerSnapshot, mergeProfitLedgerRows,
  migrateProfitLedgerRowToCurrentVersion, readProfitLedgerSnapshotFromStore,
  mergeProfitLedgerSnapshotIntoStore, readProfitLedgerSnapshotSteps, mergeProfitLedgerStoreSteps,
  PROFIT_LEDGER_MIGRATABLE_CALCULATION_VERSIONS, PROFIT_LEDGER_CALCULATION_VERSION,
} from './profitLedgerService.js';
import { migrateProfitLedgerRowsRemotely, mergeProfitLedgerRowsRemotely, runRemoteProfitLedgerSteps } from './profitLedgerStorageExecution.js';
import { createProfitCoreBatch, readProfitCoreResults } from './profitCoreWire.js';
import { executeProfitBatch } from '../../../desktop/server-core/profitExecution.mjs';

afterEach(() => vi.useRealTimers());
const now = '2026-09-08T00:00:00.000Z';
const row = n => createProfitLedgerRow({ id: `fixture-${n}`, shopId: `shop-${n % 5}`, shopClientId: `account-${n % 5}`,
  status: n % 2 ? 'delivered' : 'cancelled', amountValue: n * 25, currencyCode: 'CNY',
}, { updatedAt: now, amounts: { sourcePurchaseCostCny: n + 10 } });
const server = async calls => readProfitCoreResults(executeProfitBatch(createProfitCoreBatch(calls)), calls);
function freezeTime() { vi.useFakeTimers(); vi.setSystemTime(new Date(now)); }

it('migrates old/current rows in bounded batches with exact old-rule results, dropping only unsupported rows', async () => {
  freezeTime();
  const versions = [PROFIT_LEDGER_CALCULATION_VERSION, ...PROFIT_LEDGER_MIGRATABLE_CALCULATION_VERSIONS, 'unsupported'];
  const rows = Array.from({ length: 81 }, (_, i) => ({ ...row(i), calculationVersion: versions[i % versions.length] }));
  const execute = vi.fn(server);
  expect(await migrateProfitLedgerRowsRemotely(rows, { execute })).toEqual(rows.map(migrateProfitLedgerRowToCurrentVersion).filter(Boolean));
  expect(execute.mock.calls.map(([calls]) => calls.length)).toEqual([40, 40, 1]);
});

it('preserves duplicate fresh rows, canonical keys, cached ranking, output order and unseen-row policy', async () => {
  freezeTime();
  const a = row(1), b = row(2), c = row(3);
  const cached = [a, b, { ...a, ledgerKey: 'legacy-key', orderKey: a.ledgerKey }, c];
  const fresh = [b, a, { ...b, updatedAt: now }];
  for (const keepUnseenCached of [true, false]) {
    expect(await mergeProfitLedgerRowsRemotely(cached, fresh, { execute: server, keepUnseenCached }))
      .toEqual(mergeProfitLedgerRows(cached, fresh, { keepUnseenCached }));
  }
  expect(await mergeProfitLedgerRowsRemotely(cached, [], { execute: server })).toEqual(mergeProfitLedgerRows(cached, []));
});

it('keeps complete read and merge-store outputs identical, including signatures, errors and migration stats', async () => {
  freezeTime();
  const key = 'isolated-profit-key';
  const old = { ...row(1), calculationVersion: 'profit-ledger-v12-explicit-no-forecast-evidence' };
  const store = { profitLedgerSnapshots: { [key]: createProfitLedgerSnapshot([old, row(2)], { sourceKey: key, fetchedAt: now }) } };
  expect(await runRemoteProfitLedgerSteps(readProfitLedgerSnapshotSteps(store, key), { execute: server }))
    .toEqual(readProfitLedgerSnapshotFromStore(store, key));
  for (const fresh of [createProfitLedgerSnapshot([row(1), row(3)], { fetchedAt: now }),
    createProfitLedgerSnapshot([], { errors: [{ message: 'fixture partial failure' }], fetchedAt: now })]) {
    expect(await runRemoteProfitLedgerSteps(mergeProfitLedgerStoreSteps(store, key, fresh), { execute: server }))
      .toEqual(mergeProfitLedgerSnapshotIntoStore(store, key, fresh));
  }
});

it('rejects wrong-owner, partial and late responses without advancing the store commit', async () => {
  freezeTime();
  await expect(migrateProfitLedgerRowsRemotely([row(1)], { execute: async () => [row(2)] })).rejects.toThrow('PROFIT_LEDGER_RESULT_OWNER_MISMATCH');
  await expect(migrateProfitLedgerRowsRemotely([row(1)], { execute: async () => [] })).rejects.toThrow('PROFIT_LEDGER_RESULT_INCOMPLETE');
  const controller = new AbortController(); let advanced = false;
  function* steps() { yield { operation: 'migrate-ledgers', rows: [row(1)] }; advanced = true; }
  await expect(runRemoteProfitLedgerSteps(steps(), { signal: controller.signal,
    execute: async calls => { const values = await server(calls); controller.abort(); return values; },
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(advanced).toBe(false);
});

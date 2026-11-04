import { expect, it } from 'vitest';
import { createProfitLedgerRow, createProfitLedgerSnapshot, createProfitLedgerSnapshotFromLedgers } from './profitLedgerService.js';

it('the persistence-only constructor preserves computed rows without recalculation', () => {
  const ledger = createProfitLedgerRow({ id: 'fixture', shopId: 'shop-1', amountValue: 100, currencyCode: 'CNY' });
  const options = { sourceKey: 'isolated', fetchedAt: '2026-09-07T00:00:00Z', errors: [{ message: 'fixture error' }] };
  const snapshot = createProfitLedgerSnapshotFromLedgers([ledger], options);
  expect(snapshot).toEqual(createProfitLedgerSnapshot([ledger], options));
  expect(snapshot.rows[0]).toBe(ledger);
  expect(createProfitLedgerSnapshotFromLedgers([], options).errors).toEqual(options.errors);
});

it('the persistence-only boundary rejects raw orders instead of falling back to a local formula', () => {
  for (const rows of [[{ id: 'raw-order', amountValue: 100 }], [null], [{ schemaVersion: 1 }], {}]) {
    expect(() => createProfitLedgerSnapshotFromLedgers(rows)).toThrow('PROFIT_LEDGER_SNAPSHOT_REQUIRES_LEDGER_ROWS');
  }
  // The legacy conversion API remains compatible for explicit old consumers.
  expect(createProfitLedgerSnapshot([{ id: 'raw-order', amountValue: 100 }]).rows).toHaveLength(1);
});

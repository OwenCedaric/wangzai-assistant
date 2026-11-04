import { describe, expect, it } from 'vitest';
import { createProfitLedgerRow, createProfitLedgerSnapshot, migrateProfitLedgerRowToCurrentVersion,
  mergeProfitLedgerRows, mergeProfitLedgerSnapshotIntoStore, readProfitLedgerSnapshotFromStore,
  PROFIT_LEDGER_CALCULATION_VERSION } from './profitLedgerService.js';
import { createProfitLedgerPersistencePlan } from './profitLedgerPersistenceCompaction.js';
import { randomUUID } from 'node:crypto';
import { normalizeOzonProfitOrder } from '../entities/profit/profitDisplayRules.jsx';

const V15 = 'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge';
function confirmed(shopId, commission) {
  const row = createProfitLedgerRow({ id: 'same-posting-1', posting: 'same-posting-1', shopId,
    status: 'delivered', amountValue: 47, currencyCode: 'CNY', purchasePriceValue: 2.9 }, {
    actualFinanceStatus: 'confirmed', hasActualFinance: true, financeLookupChecked: true, financeOperationCount: 4,
    amounts: { actualCommissionFeeCny: commission, actualPenaltyFeeCny: 0, actualAcquiringFeeCny: 0.94,
      actualDeliveryServiceFeeCny: 1.42, actualLogisticsFeeCny: 10.4, crossBorderBusFeeCny: 1.23 },
  });
  row.calculationVersion = V15;
  return row;
}
describe('storage migration must not redesign profit rules or invalidate confirmed evidence', () => {
  it('applies the same cold-load, hydrate, update and persistence rules to 24 newly generated shop identities', () => {
    const shops = Array.from({ length: 24 }, () => ({ id: `future-${randomUUID()}`, client: randomUUID() }));
    const posting = '98654321-0001-1';
    const cached = [];
    const overrides = {};
    for (const [i, shop] of shops.entries()) {
      const row = createProfitLedgerRow({ id: posting, posting, shopId: shop.id, shopClientId: shop.client,
        recordKey: `${shop.id}:${posting}`, status: 'delivered', amountValue: 100, currencyCode: 'CNY',
      }, { amounts: { sourcePurchaseCostCny: i + 1, actualCommissionFeeCny: 2, actualPenaltyFeeCny: 0,
        actualAcquiringFeeCny: 0, actualDeliveryServiceFeeCny: 0, actualLogisticsFeeCny: 0, crossBorderBusFeeCny: 1 },
        actualFinanceStatus: 'confirmed', hasActualFinance: true, financeLookupChecked: true });
      cached.push(row);
      const storageKeys = [posting, `${shop.client}:${posting}`, `${shop.id}:${posting}`, `${shop.id}:${shop.client}:${posting}`];
      // Shared posting numbers must use owner-scoped keys; exercise all stored
      // forms without allowing a bare posting from a different shop to win.
      const key = storageKeys[(i % 3) + 1];
      overrides[key] = { shopId: shop.id, sourceCostCny: i + 1 };
    }
    const identityOrder = (i) => ({ ...cached[i].orderSnapshot, id: posting, posting,
      recordKey: `${shops[i].id}:${posting}`, shopId: shops[i].id, shopClientId: shops[i].client,
      sourcePurchaseCostCny: undefined, purchaseCost: undefined });
    const coldRows = shops.map((_, i) => normalizeOzonProfitOrder(identityOrder(i), { purchaseLocalOverrides: {} }).profitLedger);
    const coldMerged = mergeProfitLedgerRows(cached, coldRows, { keepUnseenCached: false });
    const hydratedRows = shops.map((_, i) => normalizeOzonProfitOrder(identityOrder(i), { purchaseLocalOverrides: overrides }).profitLedger);
    const hydrated = mergeProfitLedgerRows(coldMerged, hydratedRows, { keepUnseenCached: false });
    const plan = createProfitLedgerPersistencePlan(createProfitLedgerSnapshot(hydrated), { targetBytes: 32 * 1024 });
    const loaded = plan.chunks.flatMap((chunk) => chunk.rows);
    expect(new Set(loaded.map((row) => row.shopId)).size).toBe(24);
    for (const row of loaded) {
      const index = shops.findIndex((shop) => shop.id === row.shopId);
      expect(row.amounts.sourcePurchaseCostCny.value).toBe(index + 1);
      expect(row.amounts.actualCommissionFeeCny.value).toBe(2);
      expect(row.results.actualProfitCny.value).toBe(cached[index].results.actualProfitCny.value);
    }
    const updated = structuredClone(loaded);
    updated.forEach((row, i) => { row.amounts.actualCommissionFeeCny.value = i % 2 ? 0 : 3; });
    const recomputed = mergeProfitLedgerRows(loaded, updated, { keepUnseenCached: false });
    expect(recomputed.every((row, i) => row.amounts.actualCommissionFeeCny.value === (i % 2 ? 0 : 3))).toBe(true);
  });
  it.each([['shop-1', 0], ['shop-2', 5.64], ['shop-3', 55]])('preserves every amount, rate and result for %s', (shopId, commission) => {
    const old = confirmed(shopId, commission);
    const before = structuredClone(old);
    const migrated = migrateProfitLedgerRowToCurrentVersion(old);
    expect(migrated.calculationVersion).toBe(PROFIT_LEDGER_CALCULATION_VERSION);
    expect(migrated.amounts).toEqual(old.amounts);
    expect(migrated.results).toEqual(old.results);
    expect(migrated.exchangeRates).toEqual(old.exchangeRates);
    expect(migrated.actualFinanceStatus).toBe('confirmed');
    expect(old).toEqual(before);
  });
  it('retains all shops through read, merge, chunk and reload, including identical posting numbers', () => {
    const oldRows = ['shop-1', 'shop-2', 'shop-3'].map((id, index) => confirmed(id, index * 2));
    const key = 'all-history';
    const old = { calculationVersion: V15, rows: oldRows };
    const store = { profitLedgerSnapshots: { [key]: old } };
    const read = readProfitLedgerSnapshotFromStore(store, key);
    const pending = oldRows.map((row) => createProfitLedgerRow(row.orderSnapshot, { hasActualFinance: false }));
    const merged = mergeProfitLedgerSnapshotIntoStore(store, key, createProfitLedgerSnapshot(pending)).snapshot;
    const plan = createProfitLedgerPersistencePlan(merged, { targetBytes: 64 * 1024 });
    expect(read.rows).toHaveLength(3);
    expect(merged.rows).toHaveLength(3);
    const loaded = plan.chunks.flatMap((chunk) => chunk.rows);
    expect(new Set(loaded.map((row) => row.shopId)).size).toBe(3);
    for (const row of loaded) {
      const source = oldRows.find((oldRow) => oldRow.shopId === row.shopId);
      expect(row.amounts.actualCommissionFeeCny.value).toBe(source.amounts.actualCommissionFeeCny.value);
      expect(row.results.actualProfitCny.status).toBe('ready');
      expect(row.results.actualProfitCny.value).toBe(source.results.actualProfitCny.value);
    }
  });
  it('still accepts a newer confirmed zero or negative value instead of freezing old amounts forever', () => {
    const old = migrateProfitLedgerRowToCurrentVersion(confirmed('shop-1', 5));
    const newer = structuredClone(old);
    newer.amounts.actualCommissionFeeCny.value = 0;
    expect(mergeProfitLedgerRows([old], [newer])[0].amounts.actualCommissionFeeCny.value).toBe(0);
  });
});

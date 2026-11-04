import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoProfitEvidenceDowngrade } from './profitSnapshotEvidenceGuard.js';
const amount = value => ({ value, status: 'ready', source: 'ozon-finance-detail' });
const row = () => ({ shopId: 'future-shop', ledgerKey: 'future-shop:98765432-0001-1',
  calculationVersion: 'profit-ledger-v16-per-order-finance-exchange-rate', hasActualFinance: true,
  orderSnapshot: { posting: '98765432-0001-1', hasFinanceRefund: true },
  amounts: { actualSalesAmountCny: amount(0), actualAcquiringFeeCny: amount(2), sourcePurchaseCostCny: amount(3) },
  results: { actualProfitCny: amount(-5) } });
test('retained finance cannot silently change ready fees or lose refund evidence', () => {
  const old = row();
  for (const change of [
    { amounts: { ...old.amounts, actualAcquiringFeeCny: amount(0) } },
    { amounts: { ...old.amounts, actualSalesAmountCny: amount(24) } },
    { orderSnapshot: { ...old.orderSnapshot, hasFinanceRefund: false } },
  ]) assert.throws(() => assertNoProfitEvidenceDowngrade({ rows: [old] },
    { rows: [{ ...old, ...change, financeReadbackState: 'retained' }] }), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
});
test('complete finance may change amounts; retained finance still permits purchase cost updates', () => {
  const old = row();
  assert.doesNotThrow(() => assertNoProfitEvidenceDowngrade({ rows: [old] }, { rows: [{ ...old,
    financeReadbackState: 'complete', amounts: { ...old.amounts, actualAcquiringFeeCny: amount(0) } }] }));
  assert.doesNotThrow(() => assertNoProfitEvidenceDowngrade({ rows: [old] }, { rows: [{ ...old,
    financeReadbackState: 'retained', amounts: { ...old.amounts, sourcePurchaseCostCny: amount(5) } }] }));
});

test('empty finance needs an owner-bound complete parent/child receipt, not an empty local cache', () => {
  const empty = { ...row(), shopClientId: 'future-client', financeReadbackState: 'empty-confirmed',
    financeOperationCount: 0, financeLookupChecked: true, financeEmptyReceipt: {
      version: 1, source: 'ozon-posting-finance', scope: 'posting-all-history', shopId: 'future-shop', clientId: 'future-client',
      operationCount: 0, postingNumbers: ['98765432-0001-1', '98765432-0001'], checkedAt: new Date().toISOString(),
    } };
  assert.doesNotThrow(() => assertNoProfitEvidenceDowngrade({ rows: [] }, { rows: [empty] }));
  for (const proof of [undefined, { ...empty.financeEmptyReceipt, shopId: 'other-shop' },
    { ...empty.financeEmptyReceipt, postingNumbers: ['98765432-0001-1'] },
    { ...empty.financeEmptyReceipt, source: 'sqlite' }]) {
    assert.throws(() => assertNoProfitEvidenceDowngrade({ rows: [] }, { rows: [{ ...empty, financeEmptyReceipt: proof }] }),
      { code: 'PROFIT_LEDGER_EMPTY_FINANCE_EVIDENCE_INVALID' });
  }
});

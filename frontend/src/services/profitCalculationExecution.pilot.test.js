import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createProfitLedgerRow } from './profitLedgerService.js';
import { createProfitCoreBatch, readProfitCoreResults } from './profitCoreWire.js';
import { executeProfitBatch } from '../../../desktop/server-core/profitExecution.mjs';
import { rebuildProfitLedgerWithManualOverride } from '../entities/profit/profitDisplayRules.jsx';

let execution;
beforeAll(async () => {
  vi.stubEnv('VITE_PRIVATE_PROFIT_CORE', '1');
  vi.resetModules();
  execution = await import('./profitCalculationExecution.js');
});
afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });
const items = Array.from({ length: 81 }, (_, i) => ({ order: {
  id: `posting-${i}`, shopId: `shop-${i % 5}`, shopClientId: `account-${i % 5}`,
  products: [], amountValue: i, currencyCode: 'CNY',
}, context: { purchaseLocalOverrides: {} } }));

it('the explicit pilot path submits 40-row batches rather than calling local normalization', async () => {
  expect(execution.usesPrivateProfitExecution).toBe(true);
  const execute = vi.fn(async calls => calls.map(call => ({ ...call.input.order, remoteFixture: true })));
  const rows = await execution.normalizeProfitOrdersForExecution(items, { execute });
  expect(execute.mock.calls.map(([calls]) => calls.length)).toEqual([40, 40, 1]);
  expect(rows).toEqual(items.map(item => ({ ...item.order, remoteFixture: true })));
});

it('the pilot cannot enter the synchronous local calculation driver', () => {
  const next = vi.fn();
  expect(() => execution.runLocalProfitCalculation({ next })).toThrow('PROFIT_LOCAL_EXECUTION_DISABLED');
  expect(next).not.toHaveBeenCalled();
});

it('the pilot never falls back locally or returns partial success when a later server batch fails', async () => {
  const execute = vi.fn().mockImplementationOnce(async calls => calls.map(call => call.input.order))
    .mockRejectedValueOnce(new Error('fixture-denied'));
  await expect(execution.normalizeProfitOrdersForExecution(items, { execute })).rejects.toThrow('fixture-denied');
  expect(execute).toHaveBeenCalledTimes(2);
});

it('manual fee edits use the real private operation and reject another shop ledger', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T00:00:00.000Z'));
  try {
    const row = { ...items[1].order, status: 'delivered' };
    row.profitLedger = createProfitLedgerRow(row, { amounts: { sourcePurchaseCostCny: 10 } });
    const execute = vi.fn(async calls => readProfitCoreResults(executeProfitBatch(createProfitCoreBatch(calls)), calls));
    const result = await execution.rebuildProfitLedgerForExecution(row, 'sourcePurchaseCostCny', 55, { execute });
    expect(execute.mock.calls[0][0][0].operation).toBe('manual-override');
    expect(result).toEqual(rebuildProfitLedgerWithManualOverride(row, 'sourcePurchaseCostCny', 55));
    await expect(execution.rebuildProfitLedgerForExecution(row, 'sourcePurchaseCostCny', 55,
      { execute: async () => [{ ...result, shopId: 'wrong-shop' }] })).rejects.toThrow('PROFIT_CALCULATION_OWNER_MISMATCH');
  } finally { vi.useRealTimers(); }
});

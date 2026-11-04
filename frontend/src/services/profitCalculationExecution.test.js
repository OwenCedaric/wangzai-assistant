import { afterEach, expect, it, vi } from 'vitest';
import { runLocalProfitCalculation, runRemoteProfitCalculations, usesPrivateProfitExecution } from './profitCalculationExecution.js';
import { executeProfitBatch } from '../../../desktop/server-core/profitExecution.mjs';
import { createProfitCoreBatch, readProfitCoreResults } from './profitCoreWire.js';
import { applyProfitLedgerToProfitOrder } from '../entities/profit/profitDisplayRules.jsx';

afterEach(() => vi.useRealTimers());
const order = n => ({ id: `fixture-${n}`, shopId: `shop-${n}`, shopClientId: `account-${n}`,
  amountValue: n * 100, currencyCode: 'RUB', purchasePriceValue: n * 4, status: 'delivered',
  products: [{ offerId: `sku-${n}`, priceValue: n * 100, qty: 1 }] });
function* flow(row) {
  const normalized = yield { operation: 'normalize', input: { order: row, context: {
    rubToCnyRate: 0.1, fetchedAt: '2026-09-07T00:00:00.000Z', purchaseLocalOverrides: {},
  } } };
  const ledger = yield { operation: 'rebuild-final', input: { order: row, ledger: normalized.profitLedger } };
  return applyProfitLedgerToProfitOrder(normalized, ledger);
}
const server = async calls => readProfitCoreResults(executeProfitBatch(createProfitCoreBatch(calls)), calls);

it('keeps current distribution local unless the explicit pilot build is selected', () => {
  expect(usesPrivateProfitExecution).toBe(false);
});

it('runs the original sequence locally or in remote batches with identical final rows for five shops', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T00:00:00.000Z'));
  const orders = Array.from({ length: 5 }, (_, i) => order(i + 1));
  const expected = orders.map(row => runLocalProfitCalculation(flow(row)));
  const execute = vi.fn(server);
  await expect(runRemoteProfitCalculations(orders.map(flow), { execute })).resolves.toEqual(expected);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0][0].every(call => call.operation === 'normalize')).toBe(true);
  expect(execute.mock.calls[1][0].every(call => call.operation === 'rebuild-final')).toBe(true);
});

it('rejects wrong-owner and partial results before advancing dependent calculations', async () => {
  const wrong = vi.fn(async calls => (await server(calls)).map(row => ({ ...row, shopId: 'other' })));
  await expect(runRemoteProfitCalculations([flow(order(1))], { execute: wrong })).rejects.toThrow('PROFIT_CALCULATION_OWNER_MISMATCH');
  expect(wrong).toHaveBeenCalledTimes(1);
  const partial = vi.fn(async () => []);
  await expect(runRemoteProfitCalculations([flow(order(1))], { execute: partial })).rejects.toThrow('PROFIT_CALCULATION_BATCH_INCOMPLETE');
  expect(partial).toHaveBeenCalledTimes(1);
});

it('cancellation closes generators and never advances or publishes a late result', async () => {
  const controller = new AbortController(); let advanced = false, closed = false;
  function* pending() {
    try { yield { operation: 'normalize', input: { order: order(1) } }; advanced = true; }
    finally { closed = true; }
  }
  const execute = async calls => { const result = await server(calls); controller.abort(); return result; };
  await expect(runRemoteProfitCalculations([pending()], { execute, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(advanced).toBe(false); expect(closed).toBe(true);
});

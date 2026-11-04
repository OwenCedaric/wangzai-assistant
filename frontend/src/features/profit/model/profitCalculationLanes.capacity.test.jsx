import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { setPriority, constants as osConstants } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfitLedgerRow } from '../../../services/profitLedgerService.js';
import { useProfitCalculationLanes } from './useProfitCalculationLanes.js';
import { useProfitCalculationLanes as useBaselineLanes } from './__fixtures__/useProfitCalculationLanes.baseline.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

// This is result-equivalence and scheduler measurement, not a full-page/FPS gate.
it('matches unchanged ledger calculation across ten isolated shops and incremental refresh', async () => {
  const count = Number(process.env.WANGZAI_PROFIT_CAPACITY_ORDERS || 2000);
  expect(Number.isSafeInteger(count) && count >= 10 && count <= 200000).toBe(true);
  try { setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* optional local scheduling hint */ }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('CAPACITY_FIXTURE_FORBIDS_NETWORK'));
  const shops = Array.from({ length: 10 }, (_, i) => ({ id: `capacity-shop-${i}`, clientId: `capacity-client-${i}` }));
  const rows = Array.from({ length: count }, (_, i) => ({ id: `capacity-order-${i}`, shopId: shops[i % 10].id,
    shopClientId: shops[i % 10].clientId, amountValue: 100 + i % 20, currencyCode: 'CNY',
    paymentDate: '2026-09-01T00:00:00Z', purchasePriceValue: 10, products: [{ offerId: `sku-${i}`, qty: 1 }] }));
  const inputs = { readableShops: shops, profitLocalFinanceContexts: { byShopId: new Map(), byClientId: new Map() },
    profitImageMap: new Map(), profitFinanceRows: {}, profitLedgerRows: {},
    profitLocalInputs: { purchaseLocalOverrides: {}, productSourceLinks: {} }, ratingPenaltyIndex: new Map() };
  const context = { hasActualFinance: true, exchangeRate: { rubToCnyRate: 0.08, source: 'synthetic-capacity' },
    amounts: { sourcePurchaseCostCny: 10, actualCommissionFeeCny: 2, actualPenaltyFeeCny: 0,
      actualAcquiringFeeCny: 0, actualDeliveryServiceFeeCny: 0, actualLogisticsFeeCny: 0,
      crossBorderBusFeeCny: 1, logisticsFeeCny: 3 } };
  const calculate = row => ({ ...row, ledgerHash: createProfitLedgerRow(row, context).fieldHash });
  let calls = 0;
  const calculateProfitRow = row => { calls += 1; return calculate(row); };
  const before = performance.now();
  const expected = rows.map(row => calculate(row).ledgerHash);
  const referenceFullMs = performance.now() - before;
  const initialProps = { ...inputs, baseProfitRows: rows, isActive: true, calculateProfitRow };
  const updated = rows.map((row, i) => ({ ...row, amountValue: i === 9 ? 200 : row.amountValue }));
  const expectedChanged = calculate(updated[9]).ledgerHash;
  expect(expectedChanged).not.toBe(expected[9]);
  const oldStarted = performance.now();
  const baseline = renderHook(useBaselineLanes, { initialProps });
  await waitFor(() => expect(baseline.result.current.rows).toHaveLength(count), { timeout: 120000, interval: 20 });
  const baselineInitialMs = performance.now() - oldStarted;
  expect(baseline.result.current.rows.map(row => row.ledgerHash)).toEqual(expected);
  calls = 0;
  const referenceStarted = performance.now();
  baseline.rerender({ ...initialProps, baseProfitRows: updated });
  await waitFor(() => expect(baseline.result.current.rows[9].ledgerHash).toBe(expectedChanged), { timeout: 120000, interval: 20 });
  const referenceWarmMs = performance.now() - referenceStarted;
  const oldWarmCalculatedRows = calls;
  expect(baseline.result.current.rows.map(row => row.ledgerHash)).toEqual(expected.map((hash, index) => index === 9 ? expectedChanged : hash));
  baseline.unmount();
  calls = 0;
  const started = performance.now();
  const { result, rerender } = renderHook(useProfitCalculationLanes, { initialProps });
  await waitFor(() => expect(result.current.rows).toHaveLength(count), { timeout: 120000, interval: 20 });
  const initialMs = performance.now() - started;
  expect(result.current.rows.map(row => row.ledgerHash)).toEqual(expected);
  expect(calls).toBe(count);
  expected[9] = expectedChanged;
  calls = 0;
  const warmStarted = performance.now();
  rerender({ ...initialProps, baseProfitRows: updated });
  await waitFor(() => expect(result.current.rows[9].ledgerHash).toBe(expectedChanged), { timeout: 120000, interval: 20 });
  const warmMs = performance.now() - warmStarted;
  expect(calls).toBe(1);
  expect(result.current.rows.map(row => row.ledgerHash)).toEqual(expected);
  expect(fetch).not.toHaveBeenCalled();
  const receipt = { kind: 'synthetic-ledger-equivalence-not-ui-acceptance', shops: 10, orders: count,
    matchedLedgerHashes: count, referenceFullMs, baselineInitialMs, initialMs, referenceWarmMs, warmMs,
    oldWarmCalculatedRows, newWarmCalculatedRows: calls, networkCalls: 0,
    heapUsedBytes: process.memoryUsage().heapUsed, rulesChanged: false, uiFpsVerified: false };
  console.log(JSON.stringify(receipt));
  if (process.env.WANGZAI_PROFIT_CAPACITY_RECEIPT === '1') {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const output = path.join(root, '.codex-temp/five-readiness-20260906/calculation');
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, `capacity-${count}.json`), JSON.stringify(receipt, null, 2));
  }
}, 180000);

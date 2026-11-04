import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProfitCalculationLanes } from './useProfitCalculationLanes.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const shops = [1, 2, 3].map(n => ({ id: `shop-${n}`, clientId: `client-${n}` }));
const rows = shops.map(shop => ({ id: 'same-posting', shopId: shop.id, shopClientId: shop.clientId, amount: 100 }));
function parameters() {
  return { isActive: true, baseProfitRows: rows, readableShops: shops,
    profitLocalFinanceContexts: { byShopId: new Map(), byClientId: new Map() },
    profitImageMap: new Map(), profitFinanceRows: {}, profitLedgerRows: {},
    profitLocalInputs: { purchaseLocalOverrides: {}, productSourceLinks: {} }, ratingPenaltyIndex: new Map() };
}

describe('profit calculation page owner signatures', () => {
  it('only recalculates the changed row, retaining exact full recalculation results', async () => {
    const calculate = row => ({ ...row, result: row.amount - 12 });
    const calculateProfitRow = vi.fn(calculate);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `posting-${i}`, shopId: 'shop-1', amount: 100 + i }));
    const initial = { ...parameters(), baseProfitRows: many, calculateProfitRow };
    const { result, rerender } = renderHook(useProfitCalculationLanes, { initialProps: initial });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.rows).toEqual(many.map(calculate));
    calculateProfitRow.mockClear();
    const updated = many.map((row, i) => ({ ...row, amount: i === 9 ? 200 : row.amount }));
    rerender({ ...initial, baseProfitRows: updated });
    await act(async () => { await Promise.resolve(); });
    expect(calculateProfitRow).toHaveBeenCalledTimes(1);
    expect(result.current.rows).toEqual(updated.map(calculate));
    calculateProfitRow.mockClear();
    const reversed = updated.slice(1).reverse();
    rerender({ ...initial, baseProfitRows: reversed });
    await act(async () => { await Promise.resolve(); });
    expect(calculateProfitRow).not.toHaveBeenCalled();
    expect(result.current.rows).toEqual(reversed.map(calculate));
  });

  it('invalidates all affected shop rows when shared financial evidence changes', async () => {
    const calculateProfitRow = vi.fn(row => row);
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `posting-${i}`, shopId: 'shop-1', amount: 100 }));
    const initial = { ...parameters(), baseProfitRows: [...many, rows[1]], calculateProfitRow };
    const { rerender } = renderHook(useProfitCalculationLanes, { initialProps: initial });
    await act(async () => { await Promise.resolve(); });
    calculateProfitRow.mockClear();
    rerender({ ...initial, profitLocalInputs: { purchaseLocalOverrides: { 'shop-1:posting-1': { shopId: 'shop-1', cost: 42 } }, productSourceLinks: {} } });
    await act(async () => { await Promise.resolve(); });
    expect(calculateProfitRow).toHaveBeenCalledTimes(10);
    expect(calculateProfitRow.mock.calls.every(([row]) => row.shopId === 'shop-1')).toBe(true);
  });

  it('retains whole-shop recalculation when empty-finance evidence can expire with time', async () => {
    const calculateProfitRow = vi.fn(row => row);
    const many = [{ id: 'posting-a', shopId: 'shop-1', amount: 10 }, { id: 'posting-b', shopId: 'shop-1', amount: 20 }];
    const initial = { ...parameters(), baseProfitRows: many, calculateProfitRow,
      profitLocalFinanceContexts: { byShopId: new Map([['shop-1', { emptyFinanceReceipts: new Map([['posting-b', { checkedAt: '2026-09-06T00:00:00Z' }]]) }]]), byClientId: new Map() } };
    const { rerender } = renderHook(useProfitCalculationLanes, { initialProps: initial });
    await act(async () => { await Promise.resolve(); });
    calculateProfitRow.mockClear();
    rerender({ ...initial, baseProfitRows: [{ ...many[0], amount: 30 }, many[1]] });
    await act(async () => { await Promise.resolve(); });
    expect(calculateProfitRow.mock.calls.map(([row]) => row.id)).toEqual(['posting-a', 'posting-b']);
  });
  it('recalculates only the changed owner even if all row objects and the global index are recreated', async () => {
    const calculateProfitRow = vi.fn(row => row);
    const initial = { ...parameters(), calculateProfitRow };
    const { result, rerender } = renderHook(useProfitCalculationLanes, { initialProps: initial });
    await act(async () => { await Promise.resolve(); });
    expect(calculateProfitRow).toHaveBeenCalledTimes(3);
    calculateProfitRow.mockClear();
    const updatedRows = rows.map((row, index) => ({ ...row, amount: index === 0 ? 120 : row.amount }));
    rerender({ ...initial, baseProfitRows: updatedRows, ratingPenaltyIndex: new Map() });
    await act(async () => { await Promise.resolve(); });
    expect(calculateProfitRow.mock.calls.map(([row]) => row.shopId)).toEqual(['shop-1']);
    expect(result.current.rows.map(row => row.amount)).toEqual([120, 100, 100]);
    calculateProfitRow.mockClear();
    rerender({ ...initial, baseProfitRows: updatedRows, profitLocalInputs: {
      purchaseLocalOverrides: { 'client-2:same-posting': { shopId: 'shop-2', cost: 55 } }, productSourceLinks: {},
    } });
    await act(async () => { await Promise.resolve(); });
    expect(calculateProfitRow.mock.calls.map(([row]) => row.shopId)).toEqual(['shop-2']);
  });

  it('updates view membership and ordering even when no remaining owner needs calculation', async () => {
    const calculateProfitRow = vi.fn(row => row);
    const initial = { ...parameters(), calculateProfitRow };
    const { result, rerender } = renderHook(useProfitCalculationLanes, { initialProps: initial });
    await act(async () => { await Promise.resolve(); });
    calculateProfitRow.mockClear();
    rerender({ ...initial, baseProfitRows: [rows[2], rows[0]] });
    expect(calculateProfitRow).not.toHaveBeenCalled();
    expect(result.current.rows.map(row => row.shopId)).toEqual(['shop-3', 'shop-1']);
  });

  it('never publishes an aborted generation after a new calculation starts', async () => {
    vi.useFakeTimers();
    const initial = { ...parameters(), baseProfitRows: Array.from({ length: 81 }, (_, index) => ({ id: `posting-${index}`, shopId: 'shop-1' })),
      calculateProfitRow: row => ({ ...row, generation: 1 }) };
    const { result, rerender } = renderHook(useProfitCalculationLanes, { initialProps: initial });
    rerender({ ...initial, baseProfitRows: initial.baseProfitRows.map(row => ({ ...row, revised: true })),
      calculateProfitRow: row => ({ ...row, generation: 2 }) });
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(result.current.rows).toHaveLength(81);
    expect(result.current.rows.every(row => row.generation === 2)).toBe(true);
  });
});

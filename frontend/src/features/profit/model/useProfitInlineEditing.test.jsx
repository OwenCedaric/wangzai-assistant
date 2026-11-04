import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProfitLedgerRow } from '../../../services/profitLedgerService.js';
import { useProfitInlineEditing } from './useProfitInlineEditing.js';

afterEach(cleanup);
const order = { id: 'posting-1', posting: 'posting-1', shopId: 'shop-1', status: 'delivered', currencyCode: 'CNY', amountValue: 100 };
const key = 'shop-1:posting-1';
const newLedger = createProfitLedgerRow(order, { amounts: { sourcePurchaseCostCny: 55 } });
function setup(upsert, persistOrders, rebuild = vi.fn(() => newLedger)) {
  return renderHook(({ selectedOrder, selectedOrderKey }) => {
    const [editor, setEditor] = React.useState({ orderKey: key, fieldId: 'sourcePurchaseCostCny', value: '55' });
    const [ledgerRows, setLedgerRows] = React.useState({});
    const [financeRows, setFinanceRows] = React.useState({});
    const editing = useProfitInlineEditing({ selectedOrder, selectedOrderKey, editor, setEditor,
      setLedgerRows, setFinanceRows, persistOrders, upsert, rebuild });
    return { editor, ledgerRows, financeRows, editing };
  }, { initialProps: { selectedOrder: order, selectedOrderKey: key } });
}

describe('profit manual input durable acknowledgement', () => {
  it('awaits remote recalculation and retries without writing the confirmed amount twice', async () => {
    let finish;
    const rebuild = vi.fn().mockRejectedValueOnce(new Error('synthetic remote failure'))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const upsert = vi.fn(() => ({ persistence: Promise.resolve({ failedKeys: [] }) }));
    const persist = vi.fn().mockResolvedValue({ snapshot: { rows: [newLedger] } });
    const { result } = setup(upsert, persist, rebuild);
    await act(async () => { expect(await result.current.editing.save()).toBe(false); });
    expect(result.current.editor.error).toContain('金额已保存');
    expect(persist).not.toHaveBeenCalled();
    let pending;
    await act(async () => { pending = result.current.editing.save(); await Promise.resolve(); });
    expect(result.current.editor.saving).toBe(true);
    expect(result.current.ledgerRows).toEqual({});
    expect(persist).not.toHaveBeenCalled();
    await act(async () => { finish(newLedger); expect(await pending).toBe(true); });
    expect(upsert).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
  });

  it('cancels recalculation on owner changes and does not persist or publish its late response', async () => {
    let finish, signal;
    const rebuild = vi.fn((_order, _field, _amount, options) => {
      signal = options.signal;
      return new Promise(resolve => { finish = resolve; });
    });
    const upsert = vi.fn(() => ({ persistence: Promise.resolve({ failedKeys: [] }) }));
    const persist = vi.fn();
    const { result, rerender } = setup(upsert, persist, rebuild);
    let pending;
    await act(async () => { pending = result.current.editing.save(); await Promise.resolve(); });
    rerender({ selectedOrder: { ...order, shopId: 'shop-2' }, selectedOrderKey: 'shop-2:posting-1' });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(newLedger); expect(await pending).toBe(false); });
    expect(persist).not.toHaveBeenCalled();
    expect(result.current.ledgerRows).toEqual({}); expect(result.current.financeRows).toEqual({});
  });

  it('keeps the draft and refuses to publish a failed authority write', async () => {
    const upsert = vi.fn(() => ({ persistence: Promise.resolve({ failedKeys: [key] }) }));
    const persist = vi.fn();
    const { result } = setup(upsert, persist);
    await act(async () => { expect(await result.current.editing.save()).toBe(false); });
    expect(result.current.editor).toMatchObject({ value: '55', saving: false, error: expect.stringContaining('保存失败') });
    expect(result.current.ledgerRows).toEqual({});
    expect(result.current.financeRows).toEqual({});
    expect(persist).not.toHaveBeenCalled();
  });

  it('waits for confirmation and deduplicates Enter plus blur while saving', async () => {
    let release;
    const upsert = vi.fn(() => ({ persistence: new Promise(resolve => { release = resolve; }) }));
    const persist = vi.fn().mockResolvedValue({ snapshot: { rows: [newLedger] } });
    const { result } = setup(upsert, persist);
    let pending;
    act(() => { pending = result.current.editing.save(); });
    expect(result.current.editor.saving).toBe(true);
    expect(result.current.ledgerRows).toEqual({});
    expect(result.current.editing.save()).toBe(pending);
    await act(async () => { release({ failedKeys: [] }); expect(await pending).toBe(true); });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.current.editor).toBeNull();
    expect(result.current.ledgerRows[key].amounts.sourcePurchaseCostCny.value).toBe(55);
  });

  it('keeps a confirmed source draft retryable when its derived ledger write fails', async () => {
    const upsert = vi.fn(() => ({ persistence: Promise.resolve({ failedKeys: [] }) }));
    const persist = vi.fn().mockRejectedValueOnce(new Error('synthetic database locked')).mockResolvedValue({ snapshot: { rows: [newLedger] } });
    const { result } = setup(upsert, persist);
    await act(async () => { expect(await result.current.editing.save()).toBe(false); });
    expect(result.current.editor.error).toContain('金额已保存');
    expect(result.current.ledgerRows).toEqual({});
    await act(async () => { expect(await result.current.editing.save()).toBe(true); });
    expect(result.current.editor).toBeNull();
    expect(result.current.ledgerRows[key].amounts.sourcePurchaseCostCny.value).toBe(55);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

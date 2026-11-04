import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProfitLedgerRow } from '../../../services/profitLedgerService.js';
import { useProfitLedgerReadback } from './useProfitLedgerReadback.js';

afterEach(cleanup);
const keys = ['synthetic-ledger'];
const row = shopId => createProfitLedgerRow({ id: 'posting', posting: 'posting', shopId, amountValue: 100, currencyCode: 'CNY' }, { orderKey: `${shopId}:posting` });
const first = row('shop-1'), stale = row('shop-2'), fresh = row('shop-2');
const signature = vi.fn(() => 'complete-signature');
function setup(read) {
  return renderHook(({ active }) => {
    const [rows, setRows] = React.useState({ 'shop-2:posting': stale });
    const [penalties, setPenaltyDetails] = React.useState({});
    const [cache, setCacheInfo] = React.useState({ status: 'hit', rowCount: 1 });
    const persistSignatureRef = React.useRef('old-signature');
    const retry = useProfitLedgerReadback({ isActive: active, hasShops: true, sourceKey: 'shops', fileKey: 'profit',
      snapshotKeys: keys, snapshotKeyToken: 'synthetic-ledger', setRows, setPenaltyDetails, setCacheInfo,
      persistSignatureRef, createPersistSignature: signature, read });
    return { rows, penalties, cache, retry, persistSignatureRef };
  }, { initialProps: { active: true } });
}

describe('profit partition readback publication', () => {
  it('publishes healthy owners before another read finishes and retains failed-owner data as stale', async () => {
    let callbacks, finish;
    const read = vi.fn((_file, _keys, options) => { callbacks = options; return new Promise(resolve => { finish = resolve; }); });
    const { result, rerender } = setup(read);
    const error = { shopId: 'shop-2', message: 'synthetic failure' };
    act(() => callbacks.onPartition({ shopId: 'shop-1', status: 'fulfilled', snapshot: { rows: [first] } }));
    expect(result.current.rows['shop-1:posting']).toEqual(first);
    expect(result.current.rows['shop-2:posting']).toEqual(stale);
    expect(result.current.cache.status).toBe('loading');
    act(() => callbacks.onPartition({ shopId: 'shop-2', status: 'rejected', error }));
    await act(async () => { finish({ rows: [first], partial: true, readComplete: false, partitionErrors: [error] }); });
    expect(result.current.cache).toMatchObject({ status: 'partial', partial: true, partitionErrors: [error] });
    expect(result.current.rows['shop-2:posting']).toEqual(stale);
    expect(result.current.persistSignatureRef.current).toBe('');
    read.mockResolvedValue({ rows: [first, fresh], persistenceFormat: 'profit-ledger-partitioned-v1', readComplete: true, partial: false });
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => { await Promise.resolve(); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.cache).toMatchObject({ status: 'hit', partial: false });
    expect(result.current.persistSignatureRef.current).toBe('complete-signature');
  });

  it('does not publish stale callbacks or failures from an inactive generation', async () => {
    let callbacks, fail;
    const read = vi.fn((_file, _keys, options) => { callbacks = options; return new Promise((_resolve, reject) => { fail = reject; }); });
    const { result, rerender } = setup(read);
    rerender({ active: false });
    act(() => callbacks.onPartition({ shopId: 'shop-1', status: 'fulfilled', snapshot: { rows: [first] } }));
    await act(async () => { fail(new Error('synthetic aborted read')); });
    expect(result.current.rows).toEqual({ 'shop-2:posting': stale });
    expect(result.current.cache.status).not.toBe('error');
  });
});

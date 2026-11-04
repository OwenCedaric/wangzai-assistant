import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), cache: vi.fn(), failure: vi.fn() }));
vi.mock('../../../../entities/order/orderRecordRules.jsx', () => ({ getSalesOrderRecordKey: row => row.id }));
vi.mock('../../../../entities/product/productLocalMirror.jsx', () => ({
  getOzonLocalRowsWithEstimatedCommissions: () => new Set(), getOzonLocalRowsWithProductImages: () => new Set(),
  hasOzonOrderRowEstimatedCommission: () => false, hasOzonOrderRowProductImage: () => false,
  readOzonLocalProductEntityRows: mocks.read,
}));
vi.mock('../../../../entities/product/productOzonApi.jsx', () => ({ getOzonApiErrorMessage: error => error.message }));
vi.mock('../../../../services/ozonOrderExperience', () => ({ readOzonOrderSupplementCacheRows: () => [], writeOzonOrderSupplementCacheRows: mocks.cache }));
vi.mock('../../../../services/requestCooldown', () => ({ recordRequestFailure: mocks.failure, shouldAttemptRequest: () => true }));
vi.mock('../../../../shared/config/appConfigCore.jsx', () => ({ LOCAL_OZON_DATA_LAYER_FILE_KEY: 'isolated' }));
vi.mock('../../../../shared/config/appConfigRuntime.jsx', () => ({ purchaseSupplementCooldown: {} }));

import { usePurchaseOrderSupplement } from './usePurchaseOrderSupplement.js';
afterEach(() => vi.resetAllMocks());
const initial = { scopeKey: 'profile/shop/generation-a', orderKey: 'order-a', snapshotAt: 'v1', isActive: true };
function useHarness(props) {
  const [imageMap, setImageMap] = React.useState(() => new Map());
  const [error, setError] = React.useState('');
  // Deliberately new arrays/objects every render, as enrichment produces.
  usePurchaseOrderSupplement({ ...props, loading: false, refreshing: false,
    visibleOrders: [{ id: props.orderKey }], readableShops: [{ id: props.scopeKey }], imageMap, setImageMap, setError });
  return { imageMap, error, reset: () => setImageMap(new Map()) };
}

it('a successful response without images/commission does not recursively reload itself', async () => {
  mocks.read.mockResolvedValue({ rows: [{ id: 'order-a' }] });
  const hook = renderHook(useHarness, { initialProps: initial });
  await waitFor(() => expect(hook.result.current.imageMap.has('order-a')).toBe(true));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.failure).not.toHaveBeenCalled();
  hook.rerender({ ...initial, snapshotAt: 'v2' });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  hook.rerender({ ...initial, snapshotAt: 'v2', isActive: false });
  expect(mocks.read).toHaveBeenCalledTimes(2);
  hook.rerender({ ...initial, snapshotAt: 'v2', isActive: true });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(3));
  await act(async () => hook.result.current.reset());
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(4));
});

it('page/owner changes read again and late previous-page results cannot update cache or view', async () => {
  let oldResolve;
  mocks.read.mockReturnValueOnce(new Promise(resolve => { oldResolve = resolve; }))
    .mockResolvedValueOnce({ rows: [{ id: 'order-b' }] });
  const hook = renderHook(useHarness, { initialProps: initial });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
  hook.rerender({ ...initial, scopeKey: 'profile/shop/generation-b', orderKey: 'order-b' });
  await waitFor(() => expect(hook.result.current.imageMap.has('order-b')).toBe(true));
  await act(async () => oldResolve({ rows: [{ id: 'order-a' }] }));
  expect(hook.result.current.imageMap.has('order-a')).toBe(false);
  expect(mocks.cache).toHaveBeenCalledTimes(1);
});

it('errors remain errors and invoke the existing retry cooldown, without a success update', async () => {
  mocks.read.mockRejectedValue(new Error('unavailable'));
  const hook = renderHook(useHarness, { initialProps: initial });
  await waitFor(() => expect(hook.result.current.error).toContain('unavailable'));
  expect(mocks.failure).toHaveBeenCalledTimes(1);
  expect(mocks.cache).not.toHaveBeenCalled();
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

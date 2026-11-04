import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useScopedPurchaseResource } from './useScopedPurchaseResource.js';

const empty = Object.freeze({});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

it('keeps same-scope values while hidden and still reloads on return', async () => {
  const first = { order: 1 }, next = { order: 2 }, pending = deferred();
  const read = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
  const base = { scopeKey: 'profile-a/shop-a/generation-1', read, emptyValue: empty };
  const hook = renderHook(props => useScopedPurchaseResource(props), { initialProps: { ...base, enabled: true } });
  await waitFor(() => expect(hook.result.current).toBe(first));
  hook.rerender({ ...base, enabled: false });
  expect(hook.result.current).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);
  hook.rerender({ ...base, enabled: true });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(hook.result.current).toBe(first);
  await act(async () => pending.resolve(next));
  expect(hook.result.current).toBe(next);
});

it('rejects old owner/incarnation data immediately and ignores its late response', async () => {
  const old = deferred(), fresh = deferred();
  const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const base = { enabled: true, read, emptyValue: empty };
  const hook = renderHook(props => useScopedPurchaseResource(props), { initialProps: { ...base, scopeKey: 'profile-a/shop/old' } });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  hook.rerender({ ...base, scopeKey: 'profile-b/shop/new' });
  expect(hook.result.current).toBe(empty);
  const current = { order: 'new' };
  await act(async () => fresh.resolve(current));
  await act(async () => old.resolve({ order: 'old' }));
  expect(hook.result.current).toBe(current);
  hook.rerender({ ...base, scopeKey: 'profile-c/shop/third', enabled: false });
  expect(hook.result.current).toBe(empty);
});

it('honors refresh requests and clears failed or removed scope resources', async () => {
  const read = vi.fn().mockResolvedValueOnce({ value: 1 }).mockRejectedValueOnce(new Error('read failed'));
  const base = { scopeKey: 'profile/shop', enabled: true, read, emptyValue: empty, refreshKey: 0 };
  const hook = renderHook(props => useScopedPurchaseResource(props), { initialProps: base });
  await waitFor(() => expect(hook.result.current).toEqual({ value: 1 }));
  hook.rerender({ ...base, refreshKey: 1 });
  await waitFor(() => expect(hook.result.current).toBe(empty));
  hook.rerender({ ...base, enabled: false, scopeKey: '' });
  expect(hook.result.current).toBe(empty);
  expect(read).toHaveBeenCalledTimes(2);
});

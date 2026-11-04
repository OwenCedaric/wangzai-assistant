import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useOzonRealtimeSnapshot } from './marketingSnapshotRuntime.jsx';
import { ozonSnapshotInFlight, ozonSnapshotMemoryCache } from '../../shared/config/appConfigRuntime.jsx';
const shop = { id: 'partial-fixture', clientId: 'partial-client', apiKey: 'fixture-key' };
const source = [shop];
afterEach(() => { ozonSnapshotInFlight.clear(); ozonSnapshotMemoryCache.clear(); });
const defer = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return { promise, resolve, reject }; };

it('first paint does not claim a complete snapshot or enter the authoritative memory cache', async () => {
  const done = defer(); let options;
  const loader = vi.fn((_source, value) => { options = value; return done.promise; });
  const { result } = renderHook(() => useOzonRealtimeSnapshot(source, loader, {
    refreshOnMount: true, cacheGroup: 'first-paint-test', cacheTtlMs: 60000, allowInitialPartialSnapshot: true,
  }));
  await waitFor(() => expect(options).toBeDefined());
  act(() => options.onInitialSnapshot({ rows: [{ id: 'first' }], complete: false, partial: true }));
  expect(result.current.data.rows[0].id).toBe('first');
  expect(result.current.loading).toBe(true); expect(result.current.hasLoaded).toBe(false);
  expect(ozonSnapshotMemoryCache.size).toBe(0);
  await act(async () => { done.resolve({ rows: [{ id: 'first' }, { id: 'last' }], complete: true, partial: false }); await done.promise; });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.data.rows).toHaveLength(2); expect(result.current.hasLoaded).toBe(true);
  expect(ozonSnapshotMemoryCache.size).toBe(1);
});

it('the partial dataset remains visibly incomplete if the remainder fails', async () => {
  const done = defer(); let options;
  const loader = (_source, value) => { options=value; return done.promise; };
  const { result } = renderHook(() => useOzonRealtimeSnapshot(source, loader, {
    refreshOnMount: true, cacheGroup: 'first-paint-failure', cacheTtlMs: 60000, allowInitialPartialSnapshot: true,
  }));
  await waitFor(() => expect(options).toBeDefined());
  act(() => options.onInitialSnapshot({ rows: [{ id: 'first' }], complete: false }));
  await act(async () => { done.reject(new Error('isolated second-page failure')); await done.promise.catch(() => undefined); });
  await waitFor(() => expect(result.current.error).not.toBe(''));
  expect(result.current.data.complete).toBe(false); expect(result.current.hasLoaded).toBe(false);
  expect(ozonSnapshotMemoryCache.size).toBe(0);
});

it('other snapshot consumers do not opt into first-paint behavior implicitly', async () => {
  const loader = vi.fn().mockResolvedValue({ rows: [], complete: true });
  renderHook(() => useOzonRealtimeSnapshot(source, loader, { refreshOnMount: true, cacheGroup: 'ordinary-snapshot' }));
  await waitFor(() => expect(loader).toHaveBeenCalled());
  expect(loader.mock.calls[0][1].onInitialSnapshot).toBeUndefined();
});

it.each([true, undefined])('a retained empty snapshot (%s) must not keep the first real orders off screen', async (complete) => {
  const done = defer(); let nextOptions;
  const loader = vi.fn().mockResolvedValueOnce({ rows: [], complete })
    .mockImplementationOnce((_source, options) => { nextOptions = options; return done.promise; });
  const { result } = renderHook(() => useOzonRealtimeSnapshot(source, loader, {
    refreshOnMount: true, cacheGroup: `retained-empty-${complete}`, cacheTtlMs: 60000,
    allowInitialPartialSnapshot: true, keepCurrentDataOnForceRefresh: true,
  }));
  await waitFor(() => expect(result.current.hasLoaded).toBe(true));
  act(() => { void result.current.reload({ force: true, loaderForceRefresh: false }); });
  await waitFor(() => expect(nextOptions).toBeDefined());
  act(() => nextOptions.onInitialSnapshot({ rows: [{ id: 'first-real-order' }], complete: false }));
  expect(result.current.data.rows).toEqual([{ id: 'first-real-order' }]);
  expect(result.current.hasLoaded).toBe(false);
  expect(result.current.loading).toBe(true);
  expect([...ozonSnapshotMemoryCache.values()].some(entry => entry.value?.complete === false)).toBe(false);
  await act(async () => { done.resolve({ rows: [{ id: 'first-real-order' }, { id: 'last-order' }], complete: true }); await done.promise; });
  await waitFor(() => expect(result.current.hasLoaded).toBe(true));
  expect(result.current.data.rows).toHaveLength(2);
});

it('a nonempty complete snapshot stays visible until the full refreshed range is ready', async () => {
  const done = defer(); let nextOptions;
  const loader = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'already-visible' }], complete: true })
    .mockImplementationOnce((_source, options) => { nextOptions = options; return done.promise; });
  const { result } = renderHook(() => useOzonRealtimeSnapshot(source, loader, {
    refreshOnMount: true, cacheGroup: 'retained-nonempty', cacheTtlMs: 60000,
    allowInitialPartialSnapshot: true, keepCurrentDataOnForceRefresh: true,
  }));
  await waitFor(() => expect(result.current.hasLoaded).toBe(true));
  act(() => { void result.current.reload({ force: true, loaderForceRefresh: false }); });
  await waitFor(() => expect(nextOptions).toBeDefined());
  act(() => nextOptions.onInitialSnapshot({ rows: [{ id: 'partial-replacement' }], complete: false }));
  expect(result.current.data.rows).toEqual([{ id: 'already-visible' }]);
  expect(result.current.hasLoaded).toBe(true);
  await act(async () => { done.resolve({ rows: [{ id: 'refreshed' }], complete: true }); await done.promise; });
  await waitFor(() => expect(result.current.data.rows).toEqual([{ id: 'refreshed' }]));
});

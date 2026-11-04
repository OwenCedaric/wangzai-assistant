import { afterEach, expect, it, vi } from 'vitest';
import { requestLocalOzon } from './localApiClient.js';

const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' }, json: async () => payload, text: async () => JSON.stringify(payload) });
const endpoint = '/v1/rating/index/fbs/posting/list';
const input = body => ({ endpoint, shop: { id: 'isolated-rating-shop' }, body });
afterEach(() => { vi.unstubAllGlobals(); delete globalThis.window?.wangzaiDesktop; });

it('waits for successful sync then reads fresh fees, instead of returning old fees immediately', async () => {
  const events = [];
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const path = new URL(url).pathname;
    events.push(path);
    if (path === '/api/cache/profit') return response({ ok: true, complete: ++reads > 1, rows: [{ operation_id: reads > 1 ? 'new-fee' : 'old-fee' }], total: 1 });
    if (path === '/api/sync/profit') {
      expect(JSON.parse(options.body).maxPages).toBe(50);
      return response({ ok: true, accepted: true, jobId: 'isolated-rating-job' }, 202);
    }
    if (path.endsWith('/isolated-rating-job')) return response({ ok: true, job: { jobId: 'isolated-rating-job', status: 'success' } });
    throw new Error(`Unexpected fixture route: ${path}`);
  }));
  const result = await requestLocalOzon(input({ forceRefresh: true }));
  expect(result.result.postings[0].operation_id).toBe('new-fee');
  expect(result.localApiCache.complete).toBe(true);
  expect(events[0]).toBe('/api/cache/profit');
  expect(events[1]).toBe('/api/sync/profit');
  expect(events.at(-1)).toBe('/api/cache/profit');
});

for (const status of ['partial', 'failed', 'canceled']) {
  it(`does not turn ${status} into a complete fee result`, async () => {
    vi.stubGlobal('fetch', vi.fn(async url => {
      const path = new URL(url).pathname;
      if (path === '/api/cache/profit') return response({ ok: true, complete: false, rows: [], total: 0 });
      if (path === '/api/sync/profit') return response({ ok: true, accepted: true, jobId: 'isolated-rating-job' }, 202);
      return response({ ok: true, job: { jobId: 'isolated-rating-job', status } });
    }));
    await expect(requestLocalOzon(input({}))).rejects.toMatchObject({ code: 'LOCAL_RATING_SYNC_INCOMPLETE' });
  });
}

it('does not claim a missing durable job receipt was accepted', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => response(new URL(url).pathname === '/api/cache/profit'
    ? { ok: true, complete: false, rows: [], total: 0 } : { ok: true, accepted: true })));
  await expect(requestLocalOzon(input({ forceRefresh: true }))).rejects.toMatchObject({ code: 'LOCAL_RATING_SYNC_NOT_ACCEPTED' });
});

it('honors disabled autosync while refusing an incomplete cached result', async () => {
  const fetchMock = vi.fn(async () => response({ ok: true, complete: false, rows: [], total: 0 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(requestLocalOzon(input({ autoSync: false }))).rejects.toMatchObject({ code: 'LOCAL_RATING_CACHE_INCOMPLETE' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not accept a legacy cache with no completeness receipt', async () => {
  const fetchMock = vi.fn(async () => response({ ok: true, rows: [], total: 0 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(requestLocalOzon(input({ autoSync: false }))).rejects.toMatchObject({ code: 'LOCAL_RATING_CACHE_INCOMPLETE' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('uses a complete cache without issuing a new synchronization', async () => {
  const fetchMock = vi.fn(async () => response({ ok: true, complete: true, rows: [], total: 0 }));
  vi.stubGlobal('fetch', fetchMock);
  const result = await requestLocalOzon(input({}));
  expect(result.result.postings).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('requires the fresh cache to have a scope-complete receipt too', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const path = new URL(url).pathname;
    if (path === '/api/cache/profit') return response({ ok: true, complete: false, rows: [], total: 0 });
    if (path === '/api/sync/profit') return response({ ok: true, accepted: true, jobId: 'isolated-rating-job' }, 202);
    return response({ ok: true, job: { jobId: 'isolated-rating-job', status: 'success' } });
  }));
  await expect(requestLocalOzon(input({ forceRefresh: true }))).rejects.toMatchObject({ code: 'LOCAL_RATING_CACHE_INCOMPLETE' });
});

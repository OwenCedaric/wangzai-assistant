import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ratingRequest = vi.hoisted(() => vi.fn());
vi.mock('../product/productOzonApi.jsx', async (original) => ({
  ...await original(),
  requestOzonReadOnlyVariantsWithRows: ratingRequest,
}));

import { getOzonFinanceDateChunks } from './profitFinanceEvidence.jsx';
import { extractOzonRatingPenaltyRows } from '../../services/profitRatingPenalty.js';
import {
  buildOzonRatingIndexPostingListBodies,
  getProfitRatingPenaltyDateRangeCacheKey,
  profitRatingPenaltyOperationCache,
  requestOzonRatingPenaltyOperationsForDateRange,
  requestOzonRatingPenaltyOperationsForDateRangeCached,
  requestOzonRatingPenaltyOperationsForPosting,
  requestOzonRatingPenaltyOperationsSnapshot,
} from './profitLedgerMapping.jsx';

const shop = { id: 'fixture-rating-pagination-shop', clientId: 'fixture-rating-pagination-client' };
const postingNumber = '12345678-0001-1';
const dateRange = { since: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' };
const dateChunks = getOzonFinanceDateChunks(dateRange.since, dateRange.to);
const rangeChunks = dateChunks.slice().reverse();
const singleChunkRange = { since: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' };
const operationRow = (id) => ({ operation_id: id, posting_number: postingNumber, error_fee_cny: 1 });
const payload = (...ids) => ({ result: { items: ids.map(operationRow) } });
const observed = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

beforeEach(() => {
  ratingRequest.mockReset();
  profitRatingPenaltyOperationCache.clear();
});
afterEach(() => profitRatingPenaltyOperationCache.clear());

describe('rating penalty complete-range caching', () => {
  it.each([0, 1])('rejects a failed date chunk at index %s, retains evidence and retries without caching partial success', async (failedIndex) => {
    const failure = new Error('fixture date chunk failure');
    ratingRequest.mockImplementation(async (_endpoint, _shop, bodies) => {
      const from = bodies[0].filter.date_from;
      if (from === rangeChunks[failedIndex].from) throw failure;
      return payload(`partial:${from}`);
    });

    const { error } = await observed(requestOzonRatingPenaltyOperationsForDateRangeCached(shop, dateRange));

    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(failure);
    expect(error.chunkErrors).toEqual([{ chunk: rangeChunks[failedIndex], error: failure }]);
    expect(error.partialOperations).toHaveLength(rangeChunks.length - 1);
    expect(error.partialOperations[0].operation_id).toContain('rating:partial:');
    expect(ratingRequest.mock.calls.map((call) => call[2][0].filter.date_from)).toEqual(rangeChunks.map((chunk) => chunk.from));
    const cacheKey = getProfitRatingPenaltyDateRangeCacheKey(shop, dateRange);
    expect(profitRatingPenaltyOperationCache.has(cacheKey)).toBe(false);

    ratingRequest.mockImplementation(async (_endpoint, _shop, bodies) => payload(`complete:${bodies[0].filter.date_from}`));
    const retry = await requestOzonRatingPenaltyOperationsForDateRangeCached(shop, dateRange);

    expect(retry).toHaveLength(rangeChunks.length);
    expect(retry.every((operation) => operation.operation_id.startsWith('rating:complete:'))).toBe(true);
    expect(ratingRequest).toHaveBeenCalledTimes(rangeChunks.length * 2);
    expect(profitRatingPenaltyOperationCache.get(cacheKey)?.value).toBe(retry);
    expect(await requestOzonRatingPenaltyOperationsForDateRangeCached(shop, dateRange)).toBe(retry);
    expect(ratingRequest).toHaveBeenCalledTimes(rangeChunks.length * 2);
  });

  it('does not cache a successful first page when the next page fails', async () => {
    const failure = new Error('fixture second page failure');
    const options = { pageLimit: 2 };
    ratingRequest.mockResolvedValueOnce(payload('partial-page-1', 'partial-page-2')).mockRejectedValueOnce(failure);

    const { error } = await observed(requestOzonRatingPenaltyOperationsForDateRangeCached(shop, singleChunkRange, options));

    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(failure);
    expect(error.chunkErrors).toHaveLength(1);
    expect(error.partialOperations.map((operation) => operation.operation_id)).toEqual(['rating:partial-page-1', 'rating:partial-page-2']);
    expect(ratingRequest.mock.calls.map((call) => call[2][0].offset)).toEqual([0, 2]);
    expect(profitRatingPenaltyOperationCache.has(getProfitRatingPenaltyDateRangeCacheKey(shop, singleChunkRange, options))).toBe(false);

    ratingRequest.mockResolvedValueOnce(payload('complete-page-1', 'complete-page-2')).mockResolvedValueOnce(payload('complete-page-3'));
    const retry = await requestOzonRatingPenaltyOperationsForDateRangeCached(shop, singleChunkRange, options);

    expect(retry).toHaveLength(3);
    expect(ratingRequest.mock.calls.map((call) => call[2][0].offset)).toEqual([0, 2, 0, 2]);
  });

  it('keeps all-failed reads rejected with every chunk error and no successful cache entry', async () => {
    const failure = new Error('fixture all chunks failed');
    ratingRequest.mockRejectedValue(failure);

    const { error } = await observed(requestOzonRatingPenaltyOperationsForDateRangeCached(shop, dateRange));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('错误指数分段读取全部失败');
    expect(error.cause).toBe(failure);
    expect(error.chunkErrors).toEqual(rangeChunks.map((chunk) => ({ chunk, error: failure })));
    expect(error.partialOperations).toEqual([]);
    expect(profitRatingPenaltyOperationCache.size).toBe(0);
  });

  it('reports the failed bulk read while continuing the existing posting fallback', async () => {
    const failure = new Error('fixture bulk chunk failure');
    ratingRequest.mockImplementation(async (_endpoint, _shop, bodies) => {
      const { date_from: from, posting_number: posting } = bodies[0].filter;
      if (posting) return payload(`fallback:${from}`);
      if (from === rangeChunks[0].from) throw failure;
      return payload(`partial:${from}`);
    });

    const result = await requestOzonRatingPenaltyOperationsSnapshot(shop, [{ id: postingNumber }], {
      dateRange,
      includeAllRows: true,
      maxLookupKeys: 1,
      preferBaseLookup: false,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ ok: false, label: '错误指数批量读取', error: { cause: failure } });
    expect(result.errors[0].error.partialOperations).toHaveLength(rangeChunks.length - 1);
    expect(result.operations).toHaveLength(dateChunks.length);
    expect(result.operations.every((operation) => operation.operation_id.startsWith('rating:fallback:'))).toBe(true);
    expect(ratingRequest.mock.calls.some((call) => call[2][0].filter.posting_number === postingNumber)).toBe(true);
    expect(profitRatingPenaltyOperationCache.has(getProfitRatingPenaltyDateRangeCacheKey(shop, dateRange))).toBe(false);
  });
});

describe.each([
  {
    name: 'date range', chunks: rangeChunks, posting: '',
    read: (options) => requestOzonRatingPenaltyOperationsForDateRange(shop, dateRange, options),
  },
  {
    name: 'posting', chunks: dateChunks, posting: postingNumber,
    read: (options) => requestOzonRatingPenaltyOperationsForPosting(shop, postingNumber, dateRange, {
      maxLookupKeys: 1, preferBaseLookup: false, ...options,
    }),
  },
])('rating penalty $name refresh paging', (reader) => {
  it.each([undefined, false, true])('passes forceRefresh=%s only on each date chunk first page without changing body variants', async (forceRefresh) => {
    ratingRequest.mockImplementation(async (_endpoint, _shop, bodies) => {
      const { filter, offset } = bodies[0];
      return offset === 0
        ? payload(`${filter.date_from}:first`, `${filter.date_from}:second`)
        : payload(`${filter.date_from}:last`);
    });
    const options = { pageLimit: 2, ...(forceRefresh === undefined ? {} : { forceRefresh }) };

    const operations = await reader.read(options);

    expect(operations).toHaveLength(reader.chunks.length * 3);
    expect(ratingRequest).toHaveBeenCalledTimes(reader.chunks.length * 2);
    ratingRequest.mock.calls.forEach((call, index) => {
      const chunk = reader.chunks[Math.floor(index / 2)];
      const offset = index % 2 === 0 ? 0 : 2;
      const expectedBodies = buildOzonRatingIndexPostingListBodies({
        from: chunk.from, to: chunk.to, postingNumber: reader.posting, limit: 2, offset,
      }).map((body) => forceRefresh && offset === 0 ? { ...body, forceRefresh: true } : body);

      expect(call).toEqual(['/v1/rating/index/fbs/posting/list', shop, expectedBodies, extractOzonRatingPenaltyRows]);
      expect(call[2][0]).toMatchObject({ filter: { date_from: chunk.from, date_to: chunk.to }, limit: 2, offset });
      call[2].forEach((body) => {
        if (forceRefresh && offset === 0) expect(body.forceRefresh).toBe(true);
        else expect(body).not.toHaveProperty('forceRefresh');
      });
    });
  });
});

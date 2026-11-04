import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requests = vi.hoisted(() => ({ finance: vi.fn(), rating: vi.fn(), afterSales: vi.fn() }));
vi.mock('../../shared/ozon/ozonRuntime.jsx', async (original) => ({
  ...await original(), requestOzonReadOnly: requests.finance,
}));
vi.mock('../product/productOzonApi.jsx', async (original) => ({
  ...await original(), requestOzonReadOnlyVariantsWithRows: requests.rating,
}));
vi.mock('./profitAfterSalesSnapshot.jsx', async (original) => ({
  ...await original(), requestOzonAfterSalesSnapshot: requests.afterSales,
}));

import {
  profitFinanceOperationCache, profitAfterSalesSnapshotCache,
  requestOzonFinanceOperationsForPostingCached, requestOzonProfitAfterSalesSnapshotForShop,
  getProfitFinanceOperationCacheKey, getProfitAfterSalesCacheKey,
  fenceProfitFinanceCachesForOwner, releaseProfitFinanceOwnerFence,
  invalidateProfitFinanceCacheEntriesForOwner, invalidateProfitAfterSalesCacheEntriesForOwner,
} from './profitFinanceEvidence.jsx';
import {
  profitRatingPenaltyOperationCache, requestOzonRatingPenaltyOperationsForPostingCached,
  requestOzonRatingPenaltyOperationsForDateRangeCached,
  getProfitRatingPenaltyOperationCacheKey, getProfitRatingPenaltyDateRangeCacheKey,
  fenceProfitRatingPenaltyCacheForOwner, releaseProfitRatingPenaltyOwnerFence,
  invalidateProfitRatingPenaltyCacheEntriesForOwner,
} from './profitLedgerMapping.jsx';

const shopA = { id: 'read-owner-a', clientId: 'read-client-a' };
const shopB = { id: 'read-owner-a:neighbor', clientId: 'read-client-b' };
const ids = [shopA.id, shopA.clientId, shopB.id, shopB.clientId];
const posting = '99887766-0001-1';
const range = { since: '2026-08-01T00:00:00.000Z', to: '2026-08-01T01:00:00.000Z' };
const options = { maxLookupKeys: 1, preferBaseLookup: false };
const marker = (value) => value?.[0]?.__raw?.marker ?? value?.[0]?.marker ?? value?.marker;
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const observed = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const financePayload = (label) => ({ operations: [{ operation_id: label, marker: label }], page_count: 1 });
const ratingPayload = (label) => ({ items: [{ posting_number: posting, operation_id: label, marker: label }] });

const readers = [
  { name: 'finance posting', cache: profitFinanceOperationCache, network: requests.finance, shopArgument: 1,
    read: (shop) => requestOzonFinanceOperationsForPostingCached(shop, posting, range, options),
    key: (shop) => getProfitFinanceOperationCacheKey(shop, posting, range, options), payload: financePayload,
    fence: fenceProfitFinanceCachesForOwner, release: releaseProfitFinanceOwnerFence,
    invalidate: invalidateProfitFinanceCacheEntriesForOwner, storesPromise: true },
  { name: 'rating posting', cache: profitRatingPenaltyOperationCache, network: requests.rating, shopArgument: 1,
    read: (shop) => requestOzonRatingPenaltyOperationsForPostingCached(shop, posting, range, options),
    key: (shop) => getProfitRatingPenaltyOperationCacheKey(shop, posting, range, options), payload: ratingPayload,
    fence: fenceProfitRatingPenaltyCacheForOwner, release: releaseProfitRatingPenaltyOwnerFence,
    invalidate: invalidateProfitRatingPenaltyCacheEntriesForOwner, storesPromise: true },
  { name: 'rating range', cache: profitRatingPenaltyOperationCache, network: requests.rating, shopArgument: 1,
    read: (shop) => requestOzonRatingPenaltyOperationsForDateRangeCached(shop, range, options),
    key: (shop) => getProfitRatingPenaltyDateRangeCacheKey(shop, range, options), payload: ratingPayload,
    fence: fenceProfitRatingPenaltyCacheForOwner, release: releaseProfitRatingPenaltyOwnerFence,
    invalidate: invalidateProfitRatingPenaltyCacheEntriesForOwner, storesPromise: true },
  { name: 'after-sales snapshot without in-flight cache', cache: profitAfterSalesSnapshotCache, network: requests.afterSales, shopArgument: 0,
    read: (shop) => requestOzonProfitAfterSalesSnapshotForShop(shop, { dateRange: range }),
    key: (shop) => getProfitAfterSalesCacheKey(shop, { dateRange: range }), payload: (label) => ({ marker: label, rows: [] }),
    fence: fenceProfitFinanceCachesForOwner, release: releaseProfitFinanceOwnerFence,
    invalidate: invalidateProfitAfterSalesCacheEntriesForOwner, storesPromise: false },
];

function resetCaches() {
  fenceProfitFinanceCachesForOwner(ids);
  fenceProfitRatingPenaltyCacheForOwner(ids);
  profitFinanceOperationCache.clear(); profitAfterSalesSnapshotCache.clear(); profitRatingPenaltyOperationCache.clear();
  releaseProfitFinanceOwnerFence(ids); releaseProfitRatingPenaltyOwnerFence(ids);
}
beforeEach(() => { resetCaches(); Object.values(requests).forEach((request) => request.mockReset()); });
afterEach(resetCaches);

describe.each(readers)('$name owner read lifecycle', (reader) => {
  it('late pre-fence success cannot overwrite a rebound same-ID cache and does not affect B', async () => {
    const oldA = deferred(); const newA = deferred(); const pendingB = deferred();
    let aReads = 0;
    reader.network.mockImplementation((...args) => {
      const shop = args[reader.shopArgument];
      return shop.id === shopA.id ? (++aReads === 1 ? oldA.promise : newA.promise) : pendingB.promise;
    });
    const oldRead = observed(reader.read(shopA));
    const bRead = reader.read(shopB);
    reader.fence([shopA.id, shopA.clientId]);
    reader.invalidate([shopA.id, shopA.clientId]);
    reader.release([shopA.id, shopA.clientId]);
    const freshRead = reader.read({ ...shopA });
    newA.resolve(reader.payload('new-A'));
    await freshRead;
    oldA.resolve(reader.payload('old-A'));
    await oldRead;
    pendingB.resolve(reader.payload('current-B'));
    await bRead;
    expect(marker(reader.cache.get(reader.key(shopA))?.value)).toBe('new-A');
    expect(marker(await reader.read(shopB))).toBe('current-B');
    expect(aReads).toBe(2);
    expect(reader.network).toHaveBeenCalledTimes(3);
  });

  it('late old failure cannot remove a newer pending promise or its final cache value', async () => {
    const oldA = deferred(); const newA = deferred();
    let reads = 0;
    reader.network.mockImplementation(() => ++reads === 1 ? oldA.promise : newA.promise);
    const oldRead = observed(reader.read(shopA));
    reader.fence([shopA.id, shopA.clientId]); reader.invalidate([shopA.id, shopA.clientId]); reader.release([shopA.id, shopA.clientId]);
    const freshRead = reader.read({ ...shopA });
    const entry = reader.cache.get(reader.key(shopA));
    oldA.reject(new Error('synthetic old request failure'));
    const oldResult = await oldRead;
    const preservedPendingEntry = reader.cache.get(reader.key(shopA)) === entry;
    const joinedRead = reader.storesPromise ? reader.read(shopA) : null;
    newA.resolve(reader.payload('new-A'));
    await freshRead;
    if (joinedRead) await joinedRead;
    expect(oldResult.error).toBeInstanceOf(Error);
    if (reader.storesPromise) expect(preservedPendingEntry).toBe(true);
    expect(marker(reader.cache.get(reader.key(shopA))?.value)).toBe('new-A');
    expect(reads).toBe(2);
  });

  it('canceling a client-ID-only fence allows a fresh read without reviving the old ticket', async () => {
    const oldA = deferred(); const newA = deferred();
    let reads = 0;
    reader.network.mockImplementation(() => ++reads === 1 ? oldA.promise : newA.promise);
    const oldRead = observed(reader.read(shopA));
    reader.fence([shopA.clientId]);
    reader.release([shopA.clientId]);
    const freshRead = reader.read({ ...shopA });
    const observedReads = reads;
    newA.resolve(reader.payload('new-A'));
    oldA.resolve(reader.payload('old-A'));
    await Promise.all([freshRead, oldRead]);
    expect(observedReads).toBe(2);
    expect(marker(reader.cache.get(reader.key(shopA))?.value)).toBe('new-A');
  });
});

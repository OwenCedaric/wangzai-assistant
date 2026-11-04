import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPerformanceAccountsPayload,
  createPurchaseBrowserErrorPayload,
  crossBorderChargeErrorStatus,
  getPayloadValues,
  historicalProductImportErrorStatus,
  mapSyncJobStatusRow,
  matchShopTestRoute,
  matchSingleParamRoute,
  normalizeMarketingLegacyImportEntries,
  normalizeOzonRequestMethod,
  normalizeText,
  purchaseBrowserErrorStatus,
} from './createAppRouteHelpers.js';

test('createApp route helpers preserve existing route values and public error mappings', () => {
  assert.equal(normalizeText('  shop-1  '), 'shop-1');
  assert.equal(normalizeOzonRequestMethod(' post '), 'POST');
  assert.equal(matchShopTestRoute('/api/shops/shop%202/test'), 'shop 2');
  assert.equal(matchSingleParamRoute('/api/jobs/job%2F1', /^\/api\/jobs\/([^/]+)$/u), 'job/1');
  assert.deepEqual(getPayloadValues({ values: { a: 1 }, credentials: { b: 2 }, a: 3 }), {
    a: 3,
    b: 2,
    values: { a: 1 },
    credentials: { b: 2 },
  });
  assert.deepEqual(
    normalizeMarketingLegacyImportEntries({ shopId: 'shop-1', snapshot: { activities: [] } }),
    [{ shopId: 'shop-1', snapshot: { activities: [] } }],
  );
  assert.equal(historicalProductImportErrorStatus({ code: 'HISTORICAL_IMPORT_NOT_FOUND' }), 404);
  assert.equal(crossBorderChargeErrorStatus({ code: 'CROSS_BORDER_CHARGE_MISMATCH' }), 409);
  assert.equal(purchaseBrowserErrorStatus({ code: 'PURCHASE_BROWSER_TARGET_NOT_FOUND' }), 404);
  assert.equal(createPurchaseBrowserErrorPayload({ code: 'PURCHASE_BROWSER_TARGET_NOT_FOUND', message: 'missing' }).error.code, 'PURCHASE_BROWSER_TARGET_NOT_FOUND');
  assert.deepEqual(createPerformanceAccountsPayload([{ id: 'account-1' }]), {
    ok: true,
    accounts: [{ id: 'account-1' }],
    rows: [{ id: 'account-1' }],
    total: 1,
    hasMore: false,
    nextCursor: '',
    storage: {
      encrypted: true,
      publicResponse: '返回 client_id 与 client_secret 固定遮罩；不返回明文 client_secret。',
    },
  });
  assert.deepEqual(mapSyncJobStatusRow({ id: 'job-1', status: 'success', progress_done: 2, progress_total: 3 }), {
    id: 'job-1',
    jobId: 'job-1',
    domain: undefined,
    shopId: null,
    endpointKey: null,
    action: null,
    priority: null,
    profile: null,
    source: null,
    status: 'success',
    stage: null,
    message: null,
    cacheKey: null,
    progressDone: 2,
    progressTotal: 3,
    progress: { done: 2, total: 3, itemsDone: 0, itemsTotal: 0 },
    changedCount: undefined,
    unchangedCount: undefined,
    failedCount: undefined,
    staleCount: undefined,
    retry: { count: 0, nextRetryAt: null, lastRetryAfterMs: null },
    snapshotId: null,
    lastError: null,
    createdAt: undefined,
    startedAt: null,
    updatedAt: undefined,
    finishedAt: null,
  });
});

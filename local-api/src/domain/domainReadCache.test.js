import assert from 'node:assert/strict';
import test from 'node:test';
import { withDomainReadCache } from './domainReadCache.js';

test('read-only order scans keep authoritative reads and deletion fences without duplicate cache writes', () => {
  const queries = [], cacheCalls = [];
  const service = withDomainReadCache('orders', { readCache(query) {
    queries.push(query); return { ok: true, rows: [{ shopId: query.shopId, revision: queries.length }] };
  } }, { resolveShopScopeToken: shopId => ({ shopId }), shopCacheCompatibilityStore: {
    readVerified() { cacheCalls.push('read'); return null; },
    commit() { cacheCalls.push('commit'); }, reconcile() { cacheCalls.push('reconcile'); return { matched: false }; },
  } });
  for (const control of [true, '1', 1, 'true']) {
    const result = service.readCache({ shopId: 'a', page: 2, pageSize: 1000, _readOnlyScan: control });
    assert.equal(result.runtimeCache.scope, 'authoritative-read-only-scan');
    assert.equal(result.rows[0].revision, queries.length);
  }
  assert.deepEqual(cacheCalls, []);
  assert.equal(service.countOwnerHotCache('a'), 0);
  assert.deepEqual(queries[0], { shopId: 'a', page: 2, pageSize: 1000 });
  service.fenceOwnerCache('a');
  assert.throws(() => service.readCache({ shopId: 'a', _readOnlyScan: 1 }), { code: 'ACCOUNT_REMOVAL_OWNER_QUIESCED' });
  assert.equal(queries.length, 4);
  service.releaseOwnerCacheFence('a');
  service.readCache({ shopId: 'a' });
  assert.ok(cacheCalls.includes('commit'));
  assert.equal(service.countOwnerHotCache('a'), 1);
});

test('typed domain cache isolates identical page reads by shop', () => {
  const calls = [];
  const service = withDomainReadCache('orders', {
    readCache(query) {
      calls.push(query.shopId);
      return { ok: true, rows: [{ shopId: query.shopId }] };
    },
  });

  assert.equal(service.readCache({ shopId: 'shop-a', page: 1 }).runtimeCache.hit, false);
  assert.equal(service.readCache({ shopId: 'shop-a', page: 1 }).runtimeCache.hit, true);
  assert.equal(service.readCache({ shopId: 'shop-b', page: 1 }).runtimeCache.hit, false);
  assert.deepEqual(calls, ['shop-a', 'shop-b']);
  assert.equal(service.countOwnerHotCache('shop-a'), 1);
  assert.equal(service.invalidateOwnerHotCache('shop-a').removed, 1);
  assert.equal(service.countOwnerHotCache('shop-a'), 0);
});

test('deletion fence prevents owned cache repopulation but does not block remaining owners after removal', () => {
  let owners = ['a', 'b'];
  const calls = [];
  const service = withDomainReadCache('orders', { readCache(query) { calls.push(query); return { ok: true, rows: [] }; } },
    { resolveActiveShopIds: () => owners });
  service.fenceOwnerCache('a');
  assert.throws(() => service.readCache({ shopId: 'a' }), { code: 'ACCOUNT_REMOVAL_OWNER_QUIESCED' });
  assert.throws(() => service.readCache({ shopId: '__all__' }), { code: 'ACCOUNT_REMOVAL_OWNER_QUIESCED' });
  assert.equal(service.readCache({ shopId: 'b' }).ok, true);
  owners = ['b'];
  assert.equal(service.readCache({}).ok, true);
  assert.equal(service.countOwnerHotCache('a'), 0);
  service.releaseOwnerCacheFence('a');
  assert.equal(service.readCache({ shopId: 'a' }).ok, true);
});

test('typed domain cache never stores all-shop or multi-shop aggregate reads in L1', () => {
  const calls = [];
  const service = withDomainReadCache('orders', {
    readCache(query) {
      calls.push({ ...query });
      return { ok: true, rows: [] };
    },
  });

  const allFirst = service.readCache({ page: 1 });
  const allSecond = service.readCache({ page: 1 });
  assert.equal(allFirst.runtimeCache.scope, 'aggregate-from-shop-rows');
  assert.equal(allFirst.runtimeCache.aggregationMode, 'canonical-domain-aggregate');
  assert.equal(allSecond.runtimeCache.hit, false);

  const multiFirst = service.readCache({ shopIds: 'shop-a,shop-b', page: 1 });
  const multiSecond = service.readCache({ shopIds: ['shop-a', 'shop-b'], page: 1 });
  assert.equal(multiFirst.runtimeCache.scope, 'aggregate-from-shop-rows');
  assert.equal(multiSecond.runtimeCache.hit, false);
  assert.equal(calls.length, 4);
});

test('typed domain cache treats a one-element shopIds selector as an exact shop lane', () => {
  let calls = 0;
  const service = withDomainReadCache('orders', {
    readCache() {
      calls += 1;
      return { ok: true, rows: [] };
    },
  });

  assert.equal(service.readCache({ shopIds: 'shop-a', page: 1 }).runtimeCache.hit, false);
  assert.equal(service.readCache({ shopIds: ['shop-a'], page: 1 }).runtimeCache.hit, true);
  assert.equal(calls, 1);
});

test('typed domain cache can bypass and replace a stale single-shop L1 entry', () => {
  let calls = 0;
  const receivedQueries = [];
  const service = withDomainReadCache('orders', {
    readCache(query) {
      calls += 1;
      receivedQueries.push(query);
      return { ok: true, version: calls, rows: [] };
    },
  });

  assert.equal(service.readCache({ shopId: 'shop-a', page: 1 }).version, 1);
  assert.equal(service.readCache({ shopId: 'shop-a', page: 1 }).runtimeCache.hit, true);
  const fresh = service.readCache({ shopId: 'shop-a', page: 1, _bypassHotCache: '1' });
  assert.equal(fresh.version, 2);
  assert.equal(fresh.runtimeCache.hit, false);
  assert.equal(service.readCache({ shopId: 'shop-a', page: 1 }).version, 2);
  assert.equal(calls, 2);
  assert.equal(receivedQueries.some((query) => '_bypassHotCache' in query), false);
});

test('typed domain cache mirrors the exact old DTO without changing its return contract', () => {
  const commits = [];
  const service = withDomainReadCache('orders', {
    readCache(query) {
      return { ok: true, total: 1, rows: [{ shopId: query.shopId, amount: 0, missing: null }] };
    },
  }, {
    shopCacheCompatibilityStore: {
      commit(input) {
        commits.push(input);
      },
    },
    resolveShopScopeToken: (shopId) => ({
      profileId: 'profile-a', shopId, shopIncarnation: `inc-${shopId}`, credentialRevision: 1,
    }),
  });

  const result = service.readCache({ shopId: 'shop-a', page: 1 });
  assert.deepEqual(result, {
    ok: true,
    total: 1,
    rows: [{ shopId: 'shop-a', amount: 0, missing: null }],
    runtimeCache: {
      tier: 'sqlite-l2',
      hit: false,
      verified: false,
      domain: 'orders',
      shopId: 'shop-a',
      fallback: true,
    },
  });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].payload, {
    ok: true, total: 1, rows: [{ shopId: 'shop-a', amount: 0, missing: null }],
  });
  assert.equal(commits[0].scopeToken.shopId, 'shop-a');
});

test('shadow cache failure never changes the existing typed DTO', () => {
  const service = withDomainReadCache('products', {
    readCache() {
      return { ok: true, rows: [{ id: 'product-a' }] };
    },
  }, {
    shopCacheCompatibilityStore: {
      commit() {
        throw new Error('simulated shadow failure');
      },
    },
    resolveShopScopeToken: (shopId) => ({ shopId, shopIncarnation: 'inc-a' }),
  });
  assert.deepEqual(service.readCache({ shopId: 'shop-a' }).rows, [{ id: 'product-a' }]);
});

test('typed domain cache verifies the shadow row but still returns the original calculation DTO', () => {
  const events = [];
  const authoritative = {
    ok: true,
    salesAmount: 798,
    orderCount: 8,
    averageOrderValue: 99.75,
    profit: 0,
    margin: null,
  };
  const service = withDomainReadCache('dashboard-overview', {
    readCache() {
      return authoritative;
    },
  }, {
    shopCacheCompatibilityStore: {
      commit(input) {
        events.push(['commit', input.payload]);
      },
      reconcile(input) {
        events.push(['reconcile', input.payload]);
        return { matched: true };
      },
    },
    resolveShopScopeToken: (shopId) => ({ shopId, shopIncarnation: 'inc-a' }),
  });

  const result = service.readCache({ shopId: 'shop-a', range: 'today' });
  assert.deepEqual({ ...result, runtimeCache: undefined }, { ...authoritative, runtimeCache: undefined });
  assert.deepEqual(events, [['commit', authoritative], ['reconcile', authoritative]]);
});

test('verified per-shop SQLite becomes the selected DTO and serves the next L1 miss', () => {
  let authoritativeCalls = 0;
  let verified = null;
  const authoritative = { ok: true, total: 1, rows: [{ shopId: 'shop-a', amount: 0 }] };
  const service = withDomainReadCache('orders', {
    readCache() {
      authoritativeCalls += 1;
      return authoritative;
    },
  }, {
    maxPayloadBytes: 1,
    shopCacheCompatibilityStore: {
      commit(input) {
        verified = { payload: structuredClone(input.payload), ageMs: 0 };
      },
      reconcile() {
        return { matched: true };
      },
      readVerified() {
        return verified;
      },
    },
    resolveShopScopeToken: (shopId) => ({ shopId, shopIncarnation: 'inc-a' }),
  });

  const first = service.readCache({ shopId: 'shop-a', page: 1 });
  assert.equal(first.runtimeCache.tier, 'shop-sqlite-l2');
  assert.equal(first.runtimeCache.verified, true);
  assert.equal(first.runtimeCache.hit, false);
  assert.equal(authoritativeCalls, 1);
  const second = service.readCache({ shopId: 'shop-a', page: 1 });
  assert.equal(second.runtimeCache.tier, 'shop-sqlite-l2');
  assert.equal(second.runtimeCache.hit, true);
  assert.equal(authoritativeCalls, 1);
});

test('owner invalidation clears the exact domain in memory and per-shop SQLite', () => {
  const invalidations = [];
  const service = withDomainReadCache('orders', {
    readCache() {
      return { ok: true, rows: [] };
    },
  }, {
    shopCacheCompatibilityStore: {
      invalidate(input) {
        invalidations.push(input);
        return { ok: true, removed: 3 };
      },
    },
    resolveShopScopeToken: (shopId) => ({ shopId, shopIncarnation: 'inc-a' }),
  });
  service.readCache({ shopId: 'shop-a' });
  const result = service.invalidateOwnerHotCache('shop-a');
  assert.equal(result.removed, 4);
  assert.equal(invalidations.length, 1);
  assert.equal(invalidations[0].scopeToken.shopId, 'shop-a');
  assert.equal(invalidations[0].domain, 'orders');
});

test('a failed verified shop read automatically falls back to the canonical service', () => {
  let authoritativeCalls = 0;
  const service = withDomainReadCache('orders', {
    readCache() {
      authoritativeCalls += 1;
      return { ok: true, rows: [{ orderId: 'canonical' }] };
    },
  }, {
    shopCacheCompatibilityStore: {
      readVerified() {
        const error = new Error('simulated shop database failure');
        error.code = 'SHOP_CACHE_TEST_FAILURE';
        throw error;
      },
      commit() {
        throw new Error('simulated commit failure');
      },
    },
    resolveShopScopeToken: (shopId) => ({ shopId, shopIncarnation: 'inc-a' }),
  });

  const result = service.readCache({ shopId: 'shop-a' });
  assert.deepEqual(result.rows, [{ orderId: 'canonical' }]);
  assert.equal(result.runtimeCache.tier, 'sqlite-l2');
  assert.equal(result.runtimeCache.fallback, true);
  assert.equal(authoritativeCalls, 1);
  assert.equal(service.getHotCacheStatus().shopReadThrough.canonicalFallbacks, 2);
});

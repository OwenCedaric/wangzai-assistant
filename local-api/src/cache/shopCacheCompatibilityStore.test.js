import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createShopDatabaseManager } from '../db/shopDatabaseManager.js';
import { createShopAggregateIndex } from '../db/shopAggregateIndex.js';
import { createShopCacheCompatibilityStore } from './shopCacheCompatibilityStore.js';

test('same cache contract remains physically isolated for two shops', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-'));
  const manager = createShopDatabaseManager({ root, profileId: 'profile-a' });
  const store = createShopCacheCompatibilityStore({
    shopDatabaseManager: manager,
    now: () => new Date('2026-09-03T11:00:00.000Z'),
  });
  const scopeA = { shopId: 'shop-a', shopIncarnation: 'inc-a' };
  const scopeB = { shopId: 'shop-b', shopIncarnation: 'inc-b' };
  try {
    const query = { shopId: 'ignored-by-physical-boundary', page: 1, pageSize: 20 };
    const payloadA = { ok: true, total: 1, rows: [{ shopId: 'shop-a', amount: 12.34 }] };
    const payloadB = { ok: true, total: 1, rows: [{ shopId: 'shop-b', amount: 56.78 }] };
    store.commit({ scopeToken: scopeA, domain: 'orders', query, payload: payloadA });
    store.commit({ scopeToken: scopeB, domain: 'orders', query, payload: payloadB });
    assert.deepEqual(store.read({ scopeToken: scopeA, domain: 'orders', query }).payload, payloadA);
    assert.deepEqual(store.read({ scopeToken: scopeB, domain: 'orders', query }).payload, payloadB);
    assert.equal(manager.snapshot().openCount, 2);
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('compatibility snapshot preserves zero, null, arrays, and exact old DTO fields', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-dto-'));
  const manager = createShopDatabaseManager({ root, profileId: 'profile-a' });
  const store = createShopCacheCompatibilityStore({ shopDatabaseManager: manager });
  const scopeToken = { shopId: 'shop-a', shopIncarnation: 'inc-a' };
  try {
    const payload = {
      ok: true,
      rows: [{ amount: 0, missing: null, tags: ['a', 'b'], nested: { value: false } }],
      total: 1,
      stale: false,
    };
    const first = store.commit({ scopeToken, domain: 'finance', query: { page: 1 }, payload });
    const second = store.commit({ scopeToken, domain: 'finance', query: { page: 1 }, payload });
    const readback = store.read({ scopeToken, domain: 'finance', query: { page: 1 } });
    assert.deepEqual(readback.payload, payload);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(readback.revision, 2);
    assert.deepEqual(store.getStatus(), {
      commits: 2,
      reads: 1,
      reconciliations: 0,
      mismatches: 0,
      indexNotifications: 0,
      indexNotificationFailures: 0,
      verifiedReadHits: 0,
      verifiedReadMisses: 0,
      verifiedReadStale: 0,
      indexReadVerifications: 0,
      indexReadVerificationFailures: 0,
      invalidations: 0,
      invalidatedContracts: 0,
      invalidationNotificationFailures: 0,
      failures: 0,
      lastErrorCode: '',
      mode: 'shadow-verified',
      readMode: 'verified-shop-l2-with-canonical-fallback',
      cutoverReady: false,
    });
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('compatibility snapshot detects payload tampering before returning a DTO', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-tamper-'));
  const manager = createShopDatabaseManager({ root, profileId: 'profile-a' });
  const store = createShopCacheCompatibilityStore({ shopDatabaseManager: manager });
  const scopeToken = { shopId: 'shop-a', shopIncarnation: 'inc-a' };
  try {
    const committed = store.commit({
      scopeToken,
      domain: 'products',
      query: { page: 1 },
      payload: { ok: true, rows: [{ id: 'product-a' }] },
    });
    const handle = manager.ensure(scopeToken);
    handle.db.prepare(`
      UPDATE shop_cache_contracts SET payload_json = ? WHERE contract_key = ?
    `).run('{"ok":true,"rows":[]}', committed.contractKey);
    assert.throws(() => store.read({
      scopeToken,
      domain: 'products',
      query: { page: 1 },
    }), { code: 'SHOP_CACHE_HASH_MISMATCH' });
    assert.equal(store.getStatus().failures, 1);
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('a committed shop cache updates the rebuildable lightweight aggregate index', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-index-'));
  const manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: 'profile-a' });
  const index = createShopAggregateIndex({
    databasePath: path.join(root, 'shop-aggregate-index.sqlite'),
    profileId: 'profile-a',
  });
  const store = createShopCacheCompatibilityStore({
    shopDatabaseManager: manager,
    onCommitted: (contract) => index.record(contract),
  });
  const scopeToken = { profileId: 'profile-a', shopId: 'shop-a', shopIncarnation: 'inc-a' };
  try {
    const committed = store.commit({
      scopeToken,
      domain: 'orders',
      query: { shopId: 'shop-a', page: 1 },
      payload: { ok: true, rows: [{ orderId: 'order-a' }] },
    });
    const indexed = index.list({ shopId: 'shop-a', domain: 'orders' });
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0].payloadHash, committed.payloadHash);
    assert.equal(indexed[0].revision, committed.revision);
    assert.equal('payload' in indexed[0], false);
  } finally {
    manager.closeAll();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an aggregate-index failure cannot roll back the committed shop cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-index-failure-'));
  const manager = createShopDatabaseManager({ root, profileId: 'profile-a' });
  const store = createShopCacheCompatibilityStore({
    shopDatabaseManager: manager,
    onCommitted() {
      const error = new Error('simulated aggregate index failure');
      error.code = 'SIMULATED_AGGREGATE_INDEX_FAILURE';
      throw error;
    },
  });
  const scopeToken = { profileId: 'profile-a', shopId: 'shop-a', shopIncarnation: 'inc-a' };
  try {
    const payload = { ok: true, rows: [{ orderId: 'order-a', amount: 0 }] };
    assert.doesNotThrow(() => store.commit({
      scopeToken,
      domain: 'orders',
      query: { shopId: 'shop-a' },
      payload,
    }));
    assert.deepEqual(store.read({
      scopeToken,
      domain: 'orders',
      query: { shopId: 'shop-a' },
    }).payload, payload);
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('line-for-line reconciliation preserves business totals, zero values, and nulls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-reconcile-'));
  const manager = createShopDatabaseManager({ root, profileId: 'profile-a' });
  const store = createShopCacheCompatibilityStore({ shopDatabaseManager: manager, onCommitted: () => undefined });
  const scopeToken = { shopId: 'shop-a', shopIncarnation: 'inc-a' };
  const payload = {
    ok: true,
    salesAmount: 798,
    orderCount: 8,
    averageOrderValue: 99.75,
    profit: 0,
    margin: null,
    rows: [
      { sku: 'sku-a', quantity: 3, revenue: 298, cost: 0, profit: 298 },
      { sku: 'sku-b', quantity: 5, revenue: 500, cost: 500, profit: 0 },
    ],
  };
  try {
    store.commit({ scopeToken, domain: 'dashboard-overview', query: { range: 'today' }, payload });
    const reconciliation = store.reconcile({
      scopeToken,
      domain: 'dashboard-overview',
      query: { range: 'today' },
      payload,
    });
    assert.equal(reconciliation.matched, true);
    assert.deepEqual(store.read({ scopeToken, domain: 'dashboard-overview', query: { range: 'today' } }).payload, payload);
    assert.equal(store.getStatus().cutoverReady, true);
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('verified shop read requires a fresh exact reconciliation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-verified-read-'));
  const manager = createShopDatabaseManager({ root, profileId: 'profile-a' });
  let clock = Date.parse('2026-09-03T11:00:00.000Z');
  const store = createShopCacheCompatibilityStore({
    shopDatabaseManager: manager,
    now: () => new Date(clock),
  });
  const scopeToken = { shopId: 'shop-a', shopIncarnation: 'inc-a' };
  const input = {
    scopeToken,
    domain: 'orders',
    query: { shopId: 'shop-a', page: 1 },
    payload: { ok: true, rows: [{ orderId: 'order-a', amount: 0 }] },
  };
  try {
    store.commit(input);
    assert.equal(store.readVerified({ ...input, maxAgeMs: 1000 }), null);
    assert.equal(store.reconcile(input).matched, true);
    assert.deepEqual(store.readVerified({ ...input, maxAgeMs: 1000 }).payload, input.payload);
    const verifiedClock = clock;
    clock = verifiedClock - 1;
    assert.equal(store.readVerified({ ...input, maxAgeMs: 1000 }), null);
    clock = verifiedClock + 1001;
    assert.equal(store.readVerified({ ...input, maxAgeMs: 1000 }), null);
    assert.equal(store.getStatus().verifiedReadHits, 1);
    assert.equal(store.getStatus().verifiedReadStale, 3);
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('shop read rejects contract metadata tampering even when payload bytes are unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-contract-tamper-'));
  const manager = createShopDatabaseManager({ root, profileId: 'profile-a' });
  const store = createShopCacheCompatibilityStore({ shopDatabaseManager: manager });
  const scopeToken = { shopId: 'shop-a', shopIncarnation: 'inc-a' };
  try {
    const committed = store.commit({
      scopeToken,
      domain: 'orders',
      query: { page: 1 },
      payload: { ok: true, rows: [{ orderId: 'order-a' }] },
    });
    manager.ensure(scopeToken).db.prepare(`
      UPDATE shop_cache_contracts SET domain = ? WHERE contract_key = ?
    `).run('finance', committed.contractKey);
    assert.throws(() => store.read({
      scopeToken,
      domain: 'orders',
      query: { page: 1 },
    }), { code: 'SHOP_CACHE_CONTRACT_MISMATCH' });
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('verified shop read fails closed when the aggregate pointer is absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-index-read-'));
  const manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: 'profile-a' });
  const index = createShopAggregateIndex({
    databasePath: path.join(root, 'shop-aggregate-index.sqlite'),
    profileId: 'profile-a',
  });
  const store = createShopCacheCompatibilityStore({
    shopDatabaseManager: manager,
    onCommitted: (contract) => index.record(contract),
    verifyIndexed(contract) {
      const row = index.getScopeContract(contract.layout, contract.contractKey);
      return Boolean(row && row.payloadHash === contract.payloadHash && row.revision === contract.revision);
    },
  });
  const input = {
    scopeToken: { profileId: 'profile-a', shopId: 'shop-a', shopIncarnation: 'inc-a' },
    domain: 'orders',
    query: { shopId: 'shop-a', page: 1 },
    payload: { ok: true, rows: [{ orderId: 'order-a' }] },
  };
  try {
    store.commit(input);
    store.reconcile(input);
    assert.deepEqual(store.readVerified({ ...input, maxAgeMs: 10_000 }).payload, input.payload);
    index.removeScope(manager.resolve(input.scopeToken));
    assert.equal(store.readVerified({ ...input, maxAgeMs: 10_000 }), null);
    assert.equal(store.getStatus().indexReadVerificationFailures, 1);
  } finally {
    manager.closeAll();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('domain invalidation removes only that shop domain and its aggregate pointers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-cache-invalidate-'));
  const manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: 'profile-a' });
  const index = createShopAggregateIndex({
    databasePath: path.join(root, 'shop-aggregate-index.sqlite'),
    profileId: 'profile-a',
  });
  const store = createShopCacheCompatibilityStore({
    shopDatabaseManager: manager,
    onCommitted: (contract) => index.record(contract),
    onInvalidated: (contract) => index.removeDomain(contract.layout, contract.domain),
  });
  const scopeA = { profileId: 'profile-a', shopId: 'shop-a', shopIncarnation: 'inc-a' };
  const scopeB = { profileId: 'profile-a', shopId: 'shop-b', shopIncarnation: 'inc-b' };
  try {
    store.commit({ scopeToken: scopeA, domain: 'orders', query: { page: 1 }, payload: { ok: true, rows: [1] } });
    store.commit({ scopeToken: scopeA, domain: 'products', query: { page: 1 }, payload: { ok: true, rows: [2] } });
    store.commit({ scopeToken: scopeB, domain: 'orders', query: { page: 1 }, payload: { ok: true, rows: [3] } });
    assert.equal(store.invalidate({ scopeToken: scopeA, domain: 'orders' }).removed, 1);
    assert.equal(store.read({ scopeToken: scopeA, domain: 'orders', query: { page: 1 } }), null);
    assert.deepEqual(store.read({ scopeToken: scopeA, domain: 'products', query: { page: 1 } }).payload.rows, [2]);
    assert.deepEqual(store.read({ scopeToken: scopeB, domain: 'orders', query: { page: 1 } }).payload.rows, [3]);
    assert.equal(index.list({ shopId: 'shop-a', domain: 'orders' }).length, 0);
    assert.equal(index.list({ shopId: 'shop-a', domain: 'products' }).length, 1);
    assert.equal(index.list({ shopId: 'shop-b', domain: 'orders' }).length, 1);
  } finally {
    manager.closeAll();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

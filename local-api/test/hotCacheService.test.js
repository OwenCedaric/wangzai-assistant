import assert from 'node:assert/strict';
import test from 'node:test';
import { createCacheMergeService } from '../src/cache/cacheMergeService.js';
import { createCacheReadService } from '../src/cache/cacheReadService.js';
import { createHotCacheService } from '../src/cache/hotCacheService.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

test('hot cache returns memory hits, SQLite fallback, paging, and durationMs', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'hot-cache-shop');
    const merge = createCacheMergeService(db);
    for (let index = 0; index < 5; index += 1) {
      merge.mergeResponse({ domain: 'orders', shopId, endpointKey: 'orders.fbsList', cacheKey: `orders:${index}`, payload: { index }, remoteHash: `h-${index}` });
    }
    const reader = createCacheReadService(db, { hotCacheOptions: { maxPayloadBytes: 1024 * 1024 } });
    const first = reader.readDomainCache('orders', { shopId, pageSize: 2 });
    assert.equal(first.source, 'sqlite');
    assert.equal(first.rows.length, 2);
    assert.equal(first.pageSize, 2);
    assert.equal(first.total, 5);
    assert.equal(typeof first.durationMs, 'number');
    const second = reader.readDomainCache('orders', { shopId, pageSize: 2 });
    assert.equal(second.source, 'memory');
  } finally {
    db.close();
  }
});

test('hot cache isolates profile/shop/contract versions, enforces byte budget, and invalidates by tag', () => {
  const cache = createHotCacheService({ maxEntries: 10, maxBytes: 100, maxPayloadBytes: 100 });
  const firstKey = cache.buildKey({
    profileId: 'profile-1', shopId: 'shop-1', domain: 'orders', cacheKey: 'list', contractVersion: 'v1',
  });
  const changedContractKey = cache.buildKey({
    profileId: 'profile-1', shopId: 'shop-1', domain: 'orders', cacheKey: 'list', contractVersion: 'v2',
  });
  assert.notEqual(firstKey, changedContractKey);

  assert.equal(cache.set(firstKey, { data: 'a'.repeat(50) }, { tags: ['domain:orders', 'shop:shop-1'] }).cached, true);
  assert.equal(cache.get(firstKey).source, 'memory');
  assert.equal(cache.set(changedContractKey, { data: 'b'.repeat(50) }, { tags: ['domain:orders', 'shop:shop-1'] }).cached, true);
  assert.equal(cache.get(firstKey), null);
  assert.equal(cache.getStatus().metrics.evictions, 1);

  const thirdKey = cache.buildKey({ profileId: 'profile-1', shopId: 'shop-2', domain: 'orders', cacheKey: 'list' });
  cache.set(thirdKey, { data: 'ok' }, { tags: ['domain:orders', 'shop:shop-2'] });
  assert.equal(cache.invalidate({ tags: ['shop:shop-2'] }).removed, 1);
  assert.equal(cache.get(thirdKey), null);
  assert.equal(cache.getStatus().metrics.invalidations, 1);
});

test('hot cache stays within its entry and byte budgets under repeated mixed-scope reads', () => {
  const cache = createHotCacheService({ maxEntries: 64, maxBytes: 16 * 1024, maxPayloadBytes: 1024 });
  for (let index = 0; index < 10_000; index += 1) {
    const key = cache.buildKey({
      profileId: `profile-${index % 2}`,
      shopId: `shop-${index % 7}`,
      domain: index % 2 ? 'orders' : 'products',
      cacheKey: `query-${index}`,
      page: (index % 5) + 1,
    });
    cache.set(key, { row: index, value: 'x'.repeat(96) }, {
      tags: [`shop:shop-${index % 7}`, `domain:${index % 2 ? 'orders' : 'products'}`],
    });
    if (index % 3 === 0) cache.get(key);
  }
  const status = cache.getStatus();
  assert.equal(status.entries <= 64, true);
  assert.equal(status.totalBytes <= 16 * 1024, true);
  assert.equal(status.metrics.evictions > 0, true);
  assert.equal(status.metrics.hits > 0, true);
});

test('cacheReadService caps pageSize and does not put large payload pages into memory', () => {
  const db = createMigratedTestDb();
  try {
    createCacheMergeService(db).mergeResponse({
      domain: 'products', endpointKey: 'products.infoList', cacheKey: 'products:large',
      payload: { text: 'x'.repeat(5000) }, remoteHash: 'large-hash',
    });
    const reader = createCacheReadService(db, { hotCacheOptions: { maxPayloadBytes: 100 } });
    const first = reader.readDomainCache('products', { pageSize: 1000 });
    assert.equal(first.pageSize, 100);
    assert.equal(first.source, 'sqlite');
    const second = reader.readDomainCache('products', { pageSize: 1000 });
    assert.equal(second.source, 'sqlite');
  } finally {
    db.close();
  }
});

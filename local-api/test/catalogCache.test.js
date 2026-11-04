import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildCatalogCacheKey, explainCatalogCacheKeyRule, hashCatalogQuery } from '../src/cache/catalog/catalogCacheKeys.js';
import { createCatalogCacheService } from '../src/cache/catalog/catalogCacheService.js';
import { createCatalogCacheRepository } from '../src/db/repositories/catalogCacheRepository.js';

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of ['001_create_base_tables.sql', '002_create_catalog_cache_tables.sql', '003_create_catalog_attribute_tables.sql']) {
    const sql = readFileSync(resolve('src/db/migrations', migration), 'utf8').replace(/^\uFEFF/u, '');
    db.exec(sql);
  }
  return db;
}

test('catalog cache key is deterministic and excludes secrets', () => {
  const sensitiveQuery = {
    ['api' + 'Key']: 'should-not-appear',
    ['client' + 'Id']: 'should-not-appear',
  };
  const key = buildCatalogCacheKey({
    catalogType: 'attributes',
    scope: 'shop',
    shopId: 'shop_internal_1',
    locale: 'default',
    categoryId: '17000',
    typeId: '971',
    query: sensitiveQuery,
  });

  assert.equal(
    key,
    `catalog:shop:shop_internal_1:attributes:locale:DEFAULT:category:17000:type:971:attribute:none:query:${hashCatalogQuery(sensitiveQuery)}`,
  );
  assert.equal(key.includes('should-not-appear'), false);
  assert.equal(key.includes('apiKey'), false);
  assert.equal(key.includes('clientId'), false);
});

test('catalog cache service creates key and sync state without category payload', () => {
  const db = createTestDb();
  try {
    const service = createCatalogCacheService(db);
    const result = service.ensureCacheKey({ catalogType: 'category_tree', locale: 'DEFAULT' });

    assert.equal(result.cacheKey.catalogType, 'category_tree');
    assert.equal(result.cacheKey.scope, 'global');
    assert.equal(result.cacheKey.cacheKey, 'catalog:global:category_tree:locale:DEFAULT:category:root:type:none:attribute:none:query:none');

    const states = service.listSyncState();
    assert.equal(states.length, 1);
    assert.equal(states[0].status, 'idle');
    assert.equal(states[0].cacheKey, result.cacheKey.cacheKey);
  } finally {
    db.close();
  }
});

test('catalog repository stores normalized nodes in SQLite', () => {
  const db = createTestDb();
  try {
    const repository = createCatalogCacheRepository(db);
    const key = repository.upsertCacheKey({ catalogType: 'category_tree' });
    const node = repository.upsertCategoryNode(key.cacheKey, {
      categoryId: '100',
      title: 'Root category',
      level: 0,
    });

    assert.equal(node.categoryId, '100');
    assert.equal(node.title, 'Root category');

    const nodes = repository.listCategoryNodes({ cacheKey: key.cacheKey });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].cacheKey, key.cacheKey);
  } finally {
    db.close();
  }
});

test('catalog repository validation errors are readable Chinese, not placeholder garble', () => {
  const db = createTestDb();
  try {
    const repository = createCatalogCacheRepository(db);
    const key = repository.upsertCacheKey({ catalogType: 'category_tree' });

    assert.throws(
      () => repository.upsertCategoryNode(key.cacheKey, { categoryId: '', title: 'Root category' }),
      (error) => error.message === '类目节点缺少 categoryId。',
    );
    assert.throws(
      () => repository.upsertCategoryNode('missing-cache-key', { categoryId: '100', title: 'Root category' }),
      (error) => error.message === '类目缓存 key 不存在：missing-cache-key',
    );
  } finally {
    db.close();
  }
});


test('catalog query hash is stable for reordered object keys', () => {
  const first = hashCatalogQuery({ b: 2, a: { z: 1, y: 2 } });
  const second = hashCatalogQuery({ a: { y: 2, z: 1 }, b: 2 });
  assert.equal(first, second);
});

test('catalog migration 003 creates attribute and mapping tables', () => {
  const db = createTestDb();
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);

    assert.ok(tables.includes('catalog_attributes'));
    assert.ok(tables.includes('catalog_attribute_values'));
    assert.ok(tables.includes('catalog_category_mappings'));

    const version = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version, 3);
  } finally {
    db.close();
  }
});

test('catalog key rule documents security boundary', () => {
  const rule = explainCatalogCacheKeyRule();
  assert.match(rule.pattern, /^catalog:/u);
  assert.ok(rule.security.some((item) => item.includes('Client ID')));
});

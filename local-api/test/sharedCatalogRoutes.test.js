import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import {
  getOzonSoftwareCategoryByIds,
  getSoftwareCategoryIndexMeta,
  resetSoftwareCategoryIndexForTests,
} from '../src/cache/catalog/softwareCategoryNameService.js';
import { createCatalogCacheRepository } from '../src/db/repositories/catalogCacheRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

const SEED = Object.freeze({
  language: 'ZH_HANS',
  fetchedAt: '2026-07-16T00:00:00.000Z',
  items: [{
    description_category_id: 10,
    category_name: '根类目',
    children: [{
      description_category_id: 20,
      category_name: '子类目',
      children: [{ type_id: 30, type_name: '商品类型' }],
    }],
  }],
});

function createConfig() {
  return {
    database: { path: 'shared-catalog-route-test.sqlite' },
    security: {},
    sync: { continuousEnabled: false },
    runtime: {},
    ozon: {},
  };
}

function createRouteApp(db, filePath, remoteCounter) {
  const config = createConfig();
  return createApp({
    db,
    config,
    getDatabaseStatus: () => ({ ok: true, userVersion: 59 }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: {
      async requestReadOnly() {
        remoteCounter.count += 1;
        throw new Error('Shared catalog GET must never reach Ozon.');
      },
    },
    sharedCatalogBootstrap: {
      enabled: true,
      filePath,
      platform: 'ozon',
      marketplace: 'ozon',
      locale: 'ZH_HANS',
      contractVersion: 'ozon-description-category-v1',
    },
  });
}

test('startup seed/backfill is idempotent and shared GET stays SQLite-only', async () => {
  const db = createMigratedTestDb();
  const tempRoot = mkdtempSync(join(tmpdir(), 'shared-catalog-route-'));
  const seedPath = join(tempRoot, 'ozonCategoryTree.zh.json');
  const remoteCounter = { count: 0 };
  writeFileSync(seedPath, JSON.stringify(SEED), 'utf8');

  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-legacy-catalog-route');
    const legacy = createCatalogCacheRepository(db);
    const legacyKey = legacy.upsertCacheKey({
      catalogType: 'category_tree',
      scope: 'shop',
      shopId,
      locale: 'ZH_HANS',
    });
    legacy.upsertCategoryNode(legacyKey.cacheKey, {
      categoryId: '90',
      title: '旧店铺类目',
      level: 0,
    });

    createRouteApp(db, seedPath, remoteCounter);
    const firstImportCount = db.prepare(
      'SELECT COUNT(*) AS count FROM shared_catalog_import_runs',
    ).get().count;
    assert.equal(firstImportCount, 2, 'one packaged seed plus one legacy backfill');

    const server = createRouteApp(db, seedPath, remoteCounter);
    const secondImportCount = db.prepare(
      'SELECT COUNT(*) AS count FROM shared_catalog_import_runs',
    ).get().count;
    assert.equal(secondImportCount, firstImportCount, 'restart must not append duplicate imports');

    const softwareCategory = getOzonSoftwareCategoryByIds({ typeId: '30' });
    assert.equal(softwareCategory?.pathText, '根类目 > 子类目 > 商品类型');
    assert.equal(softwareCategory?.source, 'sqlite-shared-catalog');
    assert.deepEqual(getSoftwareCategoryIndexMeta(), {
      loaded: true,
      source: 'sqlite-shared-catalog',
      filePath: '',
      catalogId: softwareCategory.catalogId,
      contentHash: getSoftwareCategoryIndexMeta().contentHash,
      categoryCount: 2,
      typeCount: 1,
    });

    rmSync(seedPath, { force: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const treeResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/shared/tree?locale=ZH_HANS`,
    );
    const tree = await treeResponse.json();
    assert.equal(treeResponse.status, 200);
    assert.equal(tree.source, 'sqlite-shared-catalog');
    assert.equal(tree.categoryCount, 2);
    assert.equal(tree.typeCount, 1);
    assert.equal(tree.nodes.find((node) => node.typeId === '30')?.parentCategoryId, '20');

    const pathResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/shared/path?locale=ZH_HANS&typeId=30`,
    );
    const path = await pathResponse.json();
    assert.equal(pathResponse.status, 200);
    assert.equal(path.pathText, '根类目 > 子类目 > 商品类型');
    assert.equal(remoteCounter.count, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM shared_catalog_import_runs').get().count,
      firstImportCount,
      'GET must be a pure SQLite query and must not seed/backfill',
    );

    await new Promise((resolve) => server.close(resolve));
  } finally {
    resetSoftwareCategoryIndexForTests({ clearConfiguration: true });
    rmSync(tempRoot, { recursive: true, force: true });
    db.close();
  }
});

test('software category resolver contains no filesystem or frontend seed fallback', () => {
  const source = readFileSync(
    new URL('../src/cache/catalog/softwareCategoryNameService.js', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes("from 'node:fs'"), false);
  assert.equal(source.includes('readFileSync'), false);
  assert.equal(source.includes('frontend/src/data'), false);
  assert.match(source, /source: 'sqlite-shared-catalog'/u);
});

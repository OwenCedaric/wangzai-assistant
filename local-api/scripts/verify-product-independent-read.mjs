import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProductRepository } from '../src/db/repositories/productRepository.js';
import { createShopProductRepositoryRouter } from '../src/db/shopProductRepositoryRouter.js';

const [canonicalPath, shopRoot] = process.argv.slice(2);
if (!canonicalPath || !shopRoot) throw new Error('Usage: node scripts/verify-product-independent-read.mjs <canonical.sqlite> <shop-root>');
function open(path) {
  const db = new DatabaseSync(resolve(path), { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
  return db;
}
const canonicalDb = open(canonicalPath);
const sessions = new Map();
let repository;
try {
  const activeShops = canonicalDb.prepare("SELECT id, profile_id, shop_incarnation FROM shops WHERE status = 'active'").all();
  for (const folder of readdirSync(resolve(shopRoot), { withFileTypes: true }).filter((item) => item.isDirectory() && item.name.startsWith('shop-'))) {
    for (const scope of readdirSync(join(resolve(shopRoot), folder.name), { withFileTypes: true }).filter((item) => item.isDirectory() && item.name.startsWith('scope-'))) {
      const path = join(resolve(shopRoot), folder.name, scope.name, 'shop-cache.sqlite');
      if (!existsSync(path)) continue;
      const db = open(path);
      const meta = db.prepare('SELECT * FROM shop_database_metadata WHERE singleton = 1').get();
      const active = activeShops.find((shop) => shop.id === meta?.shop_id && shop.profile_id === meta.profile_id && shop.shop_incarnation === meta.shop_incarnation);
      if (!active) { db.close(); continue; }
      sessions.set(meta.shop_id, { db, shopId: meta.shop_id, route: { scopeDigest: meta.scope_digest, databasePath: path } });
    }
  }
  assert.equal(sessions.size, activeShops.length, 'every active shop must have its own current database');
  const storage = {
    isDirectWriteShop: (id) => Boolean(id),
    snapshot: () => ({ directWriteAllShops: true }),
    resolveDirectWriteSession({ shopId }) {
      const session = sessions.get(shopId);
      assert.ok(session, 'unknown shop');
      const state = session.db.prepare('SELECT * FROM shop_product_storage_state WHERE singleton = 1').get();
      assert.equal(state.write_mode, 'direct');
      assert.equal(state.status, 'completed');
      assert.equal(state.last_error_code, null);
      return session;
    },
    recordDirectWrite() { throw new Error('LIVE_AUDIT_IS_READ_ONLY'); },
  };
  repository = createShopProductRepositoryRouter({
    canonicalDb, shopProductStorage: storage, listShopIds: () => [...sessions.keys()],
    canonicalRepository: createProductRepository(canonicalDb, { allowCompatibilityRepairs: false }),
  });
  const summaries = [];
  for (const [shopId, { db }] of sessions) {
    const started = performance.now();
    const first = repository.listProducts({ shopId, visibility: 'ALL', page: 1, pageSize: 20 });
    const lastPage = Math.max(1, Math.ceil(first.total / 20));
    const last = repository.listProducts({ shopId, visibility: 'ALL', page: lastPage, pageSize: 20 });
    assert.equal(first.total, db.prepare('SELECT COUNT(*) AS n FROM ozon_products WHERE shop_id = ? AND is_stale = 0').get(shopId).n);
    assert.equal(last.rows.length, first.total ? first.total - (lastPage - 1) * 20 : 0);
    if (lastPage > 1) assert.ok(!last.rows.some((row) => first.rows.some((old) => old.id === row.id)));
    assert.ok([...first.rows, ...last.rows].every((row) => row.shopId === shopId));
    repository.listProductMaterialProfiles({ shopId });
    repository.listProductSourceLinks({ shopId });
    summaries.push({ shopId, total: first.total, lastPage, lastPageRows: last.rows.length, readMs: Math.round(performance.now() - started) });
  }
  const started = performance.now();
  const aggregate = repository.listProducts({ shopId: 'all', page: 1, pageSize: 20 });
  assert.equal(aggregate.total, summaries.reduce((total, shop) => total + shop.total, 0));
  const lastPage = Math.max(1, Math.ceil(aggregate.total / 20));
  const last = repository.listProducts({ shopId: 'all', page: lastPage, pageSize: 20 });
  assert.equal(last.rows.length, aggregate.total ? aggregate.total - (lastPage - 1) * 20 : 0);
  console.log(JSON.stringify({ ok: true, readOnly: true, shops: summaries, aggregate: {
    total: aggregate.total, lastPage, lastPageRows: last.rows.length, readMs: Math.round(performance.now() - started),
  } }, null, 2));
} finally {
  repository?.closeProductReadConnections();
  for (const { db } of sessions.values()) db.close();
  canonicalDb.close();
}

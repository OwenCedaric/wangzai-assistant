import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinanceRepository } from '../../db/repositories/financeRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { saveUnitShop, createMigratedTestDb } from '../../../test/testDb.js';
import {
  buildFinanceRunScopeKey,
  buildFinanceTransactionCacheKey,
  normalizeLegacyFinanceScopeKey,
} from './financeCacheScope.js';
import { compactFinanceCacheScopes } from './financeCacheScopeCompaction.js';

const SHOP_ID = 'shop_finance_scope';
const STABLE_KEY = 'finance:transaction-list:shop_finance_scope:all:2026-07-01:2026-07-07:page:1';
const LEGACY_KEY_A = 'finance:transaction-list:shop_finance_scope:all:2026-07-01T10:00:00.000Z:2026-07-07T10:00:00.000Z:page:1';
const LEGACY_KEY_B = 'finance:transaction-list:shop_finance_scope:all:2026-07-01T12:00:00.000Z:2026-07-07T12:00:00.000Z:page:1';

function insertCacheRows(db, key, updatedAt, id) {
  db.prepare(`
    INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key, status, updated_at, payload_json)
    VALUES (?, 'finance', ?, 'finance.transactionList', ?, 'confirmed', ?, '{}')
  `).run(`response-${id}`, SHOP_ID, key, updatedAt);
  db.prepare(`
    INSERT INTO ozon_cache_keys (cache_key, domain, shop_id, endpoint_key, policy, allow_stale, created_at, updated_at)
    VALUES (?, 'finance', ?, 'finance.transactionList', 'ledger_snapshot', 1, ?, ?)
  `).run(key, SHOP_ID, updatedAt, updatedAt);
  db.prepare(`
    INSERT INTO ozon_sync_state (id, domain, shop_id, scope_key, status, updated_at)
    VALUES (?, 'finance', ?, ?, 'success', ?)
  `).run(`state-${id}`, SHOP_ID, key, updatedAt);
}

test('continuous finance cache identity uses calendar windows while manual intervals keep exact boundaries', () => {
  const first = buildFinanceTransactionCacheKey({
    shopId: SHOP_ID,
    from: '2026-07-01T10:00:00.000Z',
    to: '2026-07-07T10:00:00.000Z',
    page: 1,
    continuous: true,
  });
  const second = buildFinanceTransactionCacheKey({
    shopId: SHOP_ID,
    from: '2026-07-01T12:00:00.000Z',
    to: '2026-07-07T12:00:00.000Z',
    page: 1,
    continuous: true,
  });
  const manual = buildFinanceTransactionCacheKey({
    shopId: SHOP_ID,
    from: '2026-07-01T12:00:00.000Z',
    to: '2026-07-07T12:00:00.000Z',
    page: 1,
    continuous: false,
  });

  assert.equal(first, STABLE_KEY);
  assert.equal(second, STABLE_KEY);
  assert.notEqual(manual, STABLE_KEY);
  assert.equal(
    buildFinanceRunScopeKey({ from: '2026-07-01T12:00:00.000Z', to: '2026-07-07T12:00:00.000Z', continuous: true }),
    'finance:2026-07-01:2026-07-07',
  );
  assert.equal(normalizeLegacyFinanceScopeKey(LEGACY_KEY_A), STABLE_KEY);
});

test('finance cache scope compaction keeps canonical or newest variants without touching facts or another shop', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, SHOP_ID);
    saveUnitShop(shopRepository, 'shop_finance_other');
    insertCacheRows(db, STABLE_KEY, '2026-07-01T08:00:00.000Z', 'stable');
    insertCacheRows(db, LEGACY_KEY_A, '2026-07-01T10:00:00.000Z', 'legacy-a');
    insertCacheRows(db, LEGACY_KEY_B, '2026-07-01T12:00:00.000Z', 'legacy-b');
    insertCacheRows(db, 'finance:transaction-list:shop_finance_scope:all:2026-07-08T10:00:00.000Z:2026-07-14T10:00:00.000Z:page:1', '2026-07-08T10:00:00.000Z', 'different-window');
    db.prepare(`
      INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key, status, updated_at, payload_json)
      VALUES ('other-shop-response', 'finance', 'shop_finance_other', 'finance.transactionList', ?, 'confirmed', '2026-07-01T12:00:00.000Z', '{}')
    `).run(LEGACY_KEY_A);
    db.prepare(`
      INSERT INTO ozon_sync_state (id, domain, shop_id, scope_key, status, updated_at)
      VALUES ('other-shop-state', 'finance', 'shop_finance_other', ?, 'success', '2026-07-01T12:00:00.000Z')
    `).run(LEGACY_KEY_A);
    createFinanceRepository(db).upsertOperations({
      shopId: SHOP_ID,
      rows: [{ operation_id: 'finance-fact-1', operation_date: '2026-07-01T10:00:00.000Z', amount: 1, currency_code: 'CNY' }],
    });

    const result = compactFinanceCacheScopes(db, { shopId: SHOP_ID, maxDeleteRows: 20 });
    assert.equal(result.ok, true);
    assert.equal(result.deleted, 6);
    assert.deepEqual(result.byTable, {
      ozon_response_cache: 2,
      ozon_cache_keys: 2,
      ozon_sync_state: 2,
    });
    for (const table of ['ozon_response_cache', 'ozon_cache_keys', 'ozon_sync_state']) {
      const field = table === 'ozon_sync_state' ? 'scope_key' : 'cache_key';
      const values = db.prepare(`SELECT ${field} AS value FROM ${table} WHERE domain = 'finance' AND shop_id = ? ORDER BY value`).all(SHOP_ID).map((row) => row.value);
      assert.deepEqual(values, [
        STABLE_KEY,
        'finance:transaction-list:shop_finance_scope:all:2026-07-08T10:00:00.000Z:2026-07-14T10:00:00.000Z:page:1',
      ]);
    }
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_response_cache WHERE shop_id = 'shop_finance_other'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_sync_state WHERE shop_id = 'shop_finance_other'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_finance_transactions WHERE shop_id = ?`).get(SHOP_ID).count, 1);
  } finally {
    db.close();
  }
});

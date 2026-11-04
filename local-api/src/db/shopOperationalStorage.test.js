import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createFinanceRepository } from './repositories/financeRepository.js';
import { createProfitReportRepository } from './repositories/profitReportRepository.js';
import { createRatingPenaltyRepository } from './repositories/ratingPenaltyRepository.js';
import { createReturnRepository } from './repositories/returnRepository.js';
import { createShopRepository } from './repositories/shopRepository.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopOperationalStorage } from './shopOperationalStorage.js';
import { createShopScopedRepositoryRouter } from './shopScopedRepositoryRouter.js';

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-operational-'));
  const canonicalDb = createMigratedTestDb();
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-operational-direct',
    createIncarnation: () => 'inc-operational-direct',
  });
  shops.saveShop({ id: 'shop-1', name: 'Shop One', clientId: 'client-1', apiKey: 'secret-1', status: 'active' });
  const manager = createShopDatabaseManager({ root, profileId: shops.profileId });
  const databaseRouter = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const storage = createShopOperationalStorage({ canonicalDb, shopDatabaseRouter: databaseRouter, directWriteAllShops: true });
  return {
    root,
    canonicalDb,
    manager,
    databaseRouter,
    storage,
    async close() {
      manager.closeAll();
      canonicalDb.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function routeRepository(fixture, createRepository, writeMethods, readMethods) {
  return createShopScopedRepositoryRouter({
    canonicalRepository: createRepository(fixture.canonicalDb),
    createRepository,
    storage: fixture.storage,
    writeMethods,
    readMethods,
  });
}

test('profit input repositories write only to the exact shop database after direct initialization', async () => {
  const fixture = await createFixture();
  try {
    const initialized = fixture.storage.initializeDirectShop({ shopId: 'shop-1' });
    assert.equal(initialized.ready, true);
    const finance = routeRepository(fixture, createFinanceRepository, ['upsertOperations'], ['listOperations']);
    const returns = routeRepository(
      fixture,
      createReturnRepository,
      ['upsertReturns', 'saveReasonTranslation', 'markReasonTranslationFailed'],
      ['listReturns'],
    );
    const rating = routeRepository(fixture, createRatingPenaltyRepository, ['upsertPenalties'], ['listPenalties']);
    const report = routeRepository(fixture, createProfitReportRepository, ['upsertBalance', 'upsertStatements'], ['readReport']);

    finance.upsertOperations({
      shopId: 'shop-1',
      rows: [{ operation_id: 'fin-1', posting_number: 'posting-1', operation_date: '2026-09-04T00:00:00Z', amount: -1.5, currency_code: 'CNY' }],
    });
    returns.upsertReturns({
      shopId: 'shop-1',
      rows: [{ return_id: 'return-1', posting_number: 'posting-1', status: 'awaiting_seller', reason: 'buyer_changed_mind', created_at: '2026-09-04T00:00:00Z' }],
    });
    rating.upsertPenalties({
      shopId: 'shop-1',
      rows: [{ operation_id: 'penalty-1', posting_number: 'posting-1', operation_date: '2026-09-04T00:00:00Z', error_fee_cny: -2 }],
    });
    report.upsertStatements({
      shopId: 'shop-1',
      rows: [{ period: { id: 1, begin: '2026-09-01', end: '2026-09-04' }, payments: { currency_code: 'RUB', payment: 8 } }],
    });
    report.upsertBalance({
      shopId: 'shop-1',
      from: '2026-09-01',
      to: '2026-09-04',
      payload: { result: { balance: 55, currency: 'RUB' } },
    });

    for (const tableName of [
      'ozon_finance_transactions',
      'ozon_returns',
      'ozon_rating_penalties',
      'ozon_finance_statement_reports',
      'ozon_finance_balance_snapshots',
    ]) {
      assert.equal(fixture.canonicalDb.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total, 0);
      assert.equal(fixture.databaseRouter.open('shop-1').db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total, 1);
    }
    assert.equal(finance.listOperations({ shopId: 'shop-1' }).total, 1);
    assert.equal(returns.listReturns({ shopId: 'shop-1' }).total, 1);
    assert.equal(rating.listPenalties({ shopId: 'shop-1' }).total, 1);
    assert.equal(report.readReport({ shopId: 'shop-1', from: '2026-09-01', to: '2026-09-04' }).rows[0].shopName, 'Shop One');
    assert.equal(
      fixture.databaseRouter.open('shop-1').db
        .prepare('SELECT direct_write_revision FROM shop_operational_storage_state WHERE singleton=1').get().direct_write_revision,
      5,
    );
  } finally {
    await fixture.close();
  }
});

test('operational direct writes fail closed before the shop migration is complete', async () => {
  const fixture = await createFixture();
  try {
    const finance = routeRepository(fixture, createFinanceRepository, ['upsertOperations'], ['listOperations']);
    assert.throws(
      () => finance.upsertOperations({ shopId: 'shop-1', rows: [] }),
      (error) => error?.code === 'SHOP_OPERATIONAL_DIRECT_WRITE_NOT_READY',
    );
    assert.equal(fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_finance_transactions').get().total, 0);
  } finally {
    await fixture.close();
  }
});

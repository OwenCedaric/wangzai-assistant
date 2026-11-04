import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'vite';
import { initializeDatabase } from '../../local-api/src/db/database.js';
import { createShopRepository } from '../../local-api/src/db/repositories/shopRepository.js';
import { createShopLifecycleRepository } from '../../local-api/src/db/repositories/shopLifecycleRepository.js';
import { createShopIdentityLifecycleService } from '../../local-api/src/domain/shops/shopIdentityLifecycleService.js';
import { createShopDatabaseManager } from '../../local-api/src/db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../../local-api/src/db/shopDatabaseRouter.js';
import { createShopOrderStorage } from '../../local-api/src/db/shopOrderStorage.js';
import { createShopOperationalStorage } from '../../local-api/src/db/shopOperationalStorage.js';
import { createShopOrderRepositoryRouter } from '../../local-api/src/db/shopOrderRepositoryRouter.js';
import { createShopScopedRepositoryRouter } from '../../local-api/src/db/shopScopedRepositoryRouter.js';
import { createOrderRepository } from '../../local-api/src/db/repositories/orderRepository.js';
import { createFinanceRepository } from '../../local-api/src/db/repositories/financeRepository.js';
import { createProfitLedgerSnapshotRepository } from '../../local-api/src/db/repositories/profitLedgerSnapshotRepository.js';

test('shops bound after startup use their own order/finance databases and the unchanged profit pipeline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-future-profit-'));
  const { db } = initializeDatabase({ database: { path: join(root, 'profile.sqlite'), enableWal: false, busyTimeoutMs: 5000 } });
  const profileId = `test-${randomUUID()}`;
  const shops = createShopRepository(db, { profileId });
  const manager = createShopDatabaseManager({ root: join(root, 'shops'), profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const orderStorage = createShopOrderStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true, backgroundRunner() {} });
  const financeStorage = createShopOperationalStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  const provisionErrors = [];
  const lifecycle = createShopIdentityLifecycleService({
    shopRepository: shops,
    lifecycleRepository: createShopLifecycleRepository(db, { profileId, identityRepository: shops.identityRepository }),
    shopDatabaseManager: manager,
    onShopDatabaseError(error) { provisionErrors.push(error); },
    onNewShopDatabaseProvisioned({ scopeToken }) {
      orderStorage.initializeEmptyShop({ shopId: scopeToken.shopId, expectedScopeToken: scopeToken });
      orderStorage.initializeDirectShop({ shopId: scopeToken.shopId, expectedScopeToken: scopeToken });
      financeStorage.initializeDirectShop({ shopId: scopeToken.shopId, expectedScopeToken: scopeToken });
    },
  });
  const orders = createShopOrderRepositoryRouter({ canonicalRepository: createOrderRepository(db), shopOrderStorage: orderStorage,
    listShopIds: () => shops.listShops().map((shop) => shop.id) });
  const finance = createShopScopedRepositoryRouter({ canonicalRepository: createFinanceRepository(db), createRepository: createFinanceRepository,
    storage: financeStorage, writeMethods: ['upsertOperations'], readMethods: ['listOperations'] });
  const snapshots = createProfitLedgerSnapshotRepository(db);
  const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  try {
    const { createProfitLedgerRow, createProfitLedgerSnapshot, mergeProfitLedgerRows } = await server.ssrLoadModule('/src/services/profitLedgerService.js');
    const { createProfitLedgerPersistencePlan } = await server.ssrLoadModule('/src/services/profitLedgerPersistenceCompaction.js');
    const posting = '99887766-0001-1';
    const owners = [];
    let priorRows = [];
    let lastKey = '';
    const save = (key, rows) => {
      const plan = createProfitLedgerPersistencePlan(createProfitLedgerSnapshot(rows));
      const writeId = randomUUID();
      const chunkKeys = plan.chunks.map((chunk, index) => {
        const chunkKey = `${key}::chunk:${writeId}:${index}`;
        snapshots.saveSnapshot({ snapshotKey: chunkKey, snapshot: chunk, chunkOf: key, writeId, chunkIndex: index, chunkCount: plan.chunks.length });
        return chunkKey;
      });
      snapshots.saveSnapshot({ snapshotKey: key, snapshot: { ...plan.manifest, chunkKeys, writeId } });
      return snapshots.readSnapshot({ snapshotKey: key }).snapshot.rows;
    };
    for (let i = 0; i < 4; i++) {
      const id = `future-${randomUUID()}`;
      const clientId = `client-${randomUUID()}`;
      const binding = lifecycle.saveBinding({ id, name: `新绑定测试店${i}`, clientId, apiKey: `test-only-${randomUUID()}`, status: 'active' });
      assert.equal(binding.created, true);
      assert.equal(provisionErrors.length, 0);
      const layout = router.resolve(id);
      assert.ok(existsSync(layout.databasePath));
      owners.push({ id, clientId, path: layout.databasePath });
      orders.upsertOrders({ shopId: id, rows: [{ posting_number: posting, order_id: 'same-remote-order', status: 'delivered',
        in_process_at: '2026-09-04T00:00:00Z', products: [{ offer_id: 'same-sku', quantity: 1, price: 100 }], financial_data: { total_price: 100 } }] });
      finance.upsertOperations({ shopId: id, rows: [{ operation_id: 'same-operation', posting_number: posting, operation_type: 'OperationAgentDeliveredToCustomer',
        operation_date: '2026-09-04T00:00:00Z', amount: 90, sale_commission: -(i + 2), currency_code: 'CNY' }] });
      const input = finance.listOperations({ shopId: id }).rows[0];
      const sourceOrder = orders.listOrders({ shopId: id }).rows[0];
      assert.equal(sourceOrder.shopId, id);
      assert.equal(input.shopId, id);
      const row = createProfitLedgerRow({ id: posting, posting, recordKey: `${id}:${posting}`, shopId: id, shopClientId: clientId,
        status: 'delivered', amountValue: 100, currencyCode: 'CNY' }, {
        purchaseOverrides: { [`${clientId}:${posting}`]: { shopId: id, sourceCostCny: i + 10 } },
        actualFinanceStatus: 'confirmed', hasActualFinance: true, financeLookupChecked: true,
        amounts: { actualCommissionFeeCny: Math.abs(input.saleCommissionCny), actualPenaltyFeeCny: 0, actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0, actualLogisticsFeeCny: 0, crossBorderBusFeeCny: 1 },
      });
      assert.equal(row.amounts.sourcePurchaseCostCny.value, i + 10);
      assert.equal(row.results.actualProfitCny.value, 100 - (i + 10) - (i + 2) - 1);
      const newRows = [...priorRows, row];
      lastKey = `owners-${i}-${owners.map((owner) => owner.id).join('|')}`;
      if (priorRows.length) {
        const incomplete = structuredClone(newRows);
        incomplete[0].amounts.actualCommissionFeeCny = { value: null, status: 'pending' };
        assert.throws(() => save(lastKey, incomplete), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
      }
      priorRows = save(lastKey, newRows);
      assert.equal(priorRows.length, owners.length);
    }
    assert.equal(new Set(owners.map((owner) => owner.path)).size, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM ozon_finance_transactions').get().total, 0);
    assert.equal(orders.listOrders({ pageSize: 20 }).total, 4);
    manager.closeAll();
    for (const owner of owners) {
      assert.equal(orders.listOrders({ shopId: owner.id }).total, 1);
      assert.equal(finance.listOperations({ shopId: owner.id }).total, 1);
    }
    const restarted = snapshots.readSnapshot({ snapshotKey: lastKey }).snapshot.rows;
    assert.deepEqual(restarted.map((row) => row.results.actualProfitCny), priorRows.map((row) => row.results.actualProfitCny));
    const changed = structuredClone(restarted);
    changed[3].amounts.actualCommissionFeeCny.value = 0;
    const updated = save(lastKey, mergeProfitLedgerRows(restarted, changed, { keepUnseenCached: false }));
    assert.equal(updated[3].results.actualProfitCny.value, restarted[3].results.actualProfitCny.value + 5);
    const resultValue = (row) => ({ value: row.results.actualProfitCny.value, status: row.results.actualProfitCny.status });
    assert.deepEqual(updated.slice(0, 3).map(resultValue), restarted.slice(0, 3).map(resultValue));
  } finally {
    await server.close();
    manager.closeAll();
    db.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('wangzai-future-profit-'));
    rmSync(root, { recursive: true, force: true });
  }
});

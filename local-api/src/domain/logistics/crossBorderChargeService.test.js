import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import { createOrderRepository } from '../../db/repositories/orderRepository.js';
import { createPurchaseOrderOverrideRepository } from '../../db/repositories/purchaseOrderOverrideRepository.js';
import { createProfileSettingsRepository } from '../../db/repositories/profileSettingsRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createCrossBorderAccountService } from './crossBorderAccountService.js';
import { createCrossBorderChargeService } from './crossBorderChargeService.js';

function sourcePayload(shopId = '') {
  return {
    browserAccountRef: 'browser-profile-bus-a',
    externalAccountRef: 'bus-user-a',
    shopId,
    orders: [{
      id: 'bus-internal-774986',
      oid: '774986',
      order_number: '0123640791-0163-1',
      from_order: 'PO-774986',
      detailTotalCny: 99,
      feeBreakdown: { operationFeeCny: 1.5 },
    }],
    charges: [
      { oid: '774986', type: '支出', money: '0.10', reason: '预报', time: '2026-07-28 10:00:00' },
      { oid: '774986', type: '收入', money: '0.10', reason: '发货返还', time: '2026-07-28 11:00:00' },
      { oid: '774986', type: '支出', money: '1.50', reason: '实际服务费', time: '2026-07-28 11:00:01' },
    ],
  };
}

test('cross-border charge import detects multi-shop ambiguity and only projects an explicitly selected exact shop', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db, { tenantId: 'tenant-a', userId: 'user-a' });
    const shopA = saveUnitShop(shops, 'charge-shop-a');
    const shopB = saveUnitShop(shops, 'charge-shop-b');
    const orders = createOrderRepository(db);
    for (const shopId of [shopA, shopB]) {
      orders.upsertOrders({
        shopId,
        rows: [{ posting_number: '0123640791-0163-1', order_id: `ozon-${shopId}`, status: 'delivered' }],
      });
    }

    const service = createCrossBorderChargeService({ db, shopRepository: shops });
    const scope = { tenantId: 'tenant-a', userId: 'user-a' };
    const ambiguous = service.buildPreview(sourcePayload(), scope);
    assert.equal(ambiguous.summary.ambiguousCount, 1);
    assert.deepEqual(ambiguous.rows[0].candidateShopIds.sort(), [shopA, shopB].sort());

    const preview = service.buildPreview(sourcePayload(shopA), scope);
    assert.equal(preview.summary.exactCount, 1);
    assert.equal(preview.rows[0].shopId, shopA);
    assert.equal(preview.rows[0].actualFeeCny, 1.5);
    assert.equal(preview.rows[0].ledgerNetCny, 1.5);

    const confirmed = service.confirmImport({
      previewId: preview.previewId,
      confirmationToken: preview.confirmationToken,
    }, scope);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.readbackVerified, true);
    assert.equal(confirmed.exactCount, 1);

    const ledger = db.prepare(`
      SELECT tenant_id, user_id, profile_id, browser_account_ref, shop_id,
             posting_number, actual_fee_cny, match_status
      FROM cross_border_charge_links
    `).get();
    assert.deepEqual({ ...ledger }, {
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      profile_id: 'default',
      browser_account_ref: 'browser-profile-bus-a',
      shop_id: shopA,
      posting_number: '0123640791-0163-1',
      actual_fee_cny: 1.5,
      match_status: 'exact',
    });

    const override = createPurchaseOrderOverrideRepository(db).getOverride({
      shopId: shopA,
      orderKey: '0123640791-0163-1',
    });
    assert.equal(override.actualCrossBorderBusFeeCny, 1.5);
    assert.equal(override.actualCrossBorderBusFeeSource, 'cross-border-bus-ledger-cash-converted');
    assert.equal(override.crossBorderChargeEvidence.collectionNumber, '774986');

    const projected = db.prepare(`
      SELECT raw_json FROM cross_border_order_records
      WHERE shop_id = ? AND record_key = ?
    `).get(shopA, '774986');
    assert.equal(JSON.parse(projected.raw_json).actualCrossBorderBusFeeCny, 1.5);
  } finally {
    db.close();
  }
});

test('cross-border charge links remain isolated by tenant and user and confirmation is bound to its preview scope', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db, { tenantId: 'tenant-a', userId: 'user-a' });
    const shopId = saveUnitShop(shops, 'charge-isolation-shop');
    createOrderRepository(db).upsertOrders({
      shopId,
      rows: [{ posting_number: '0123640791-0163-1', order_id: 'ozon-isolation', status: 'delivered' }],
    });
    const service = createCrossBorderChargeService({ db, shopRepository: shops });
    const preview = service.buildPreview(sourcePayload(shopId), { tenantId: 'tenant-a', userId: 'user-a' });

    assert.throws(
      () => service.confirmImport({
        previewId: preview.previewId,
        confirmationToken: preview.confirmationToken,
      }, { tenantId: 'tenant-a', userId: 'user-b' }),
      /CROSS_BORDER_CHARGE_CONTEXT_MISMATCH/u,
    );

    const confirmed = service.confirmImport({
      previewId: preview.previewId,
      confirmationToken: preview.confirmationToken,
    }, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.equal(confirmed.ok, true);
    assert.equal(service.listLinks({}, { tenantId: 'tenant-a', userId: 'user-a' }).total, 1);
    assert.equal(service.listLinks({}, { tenantId: 'tenant-a', userId: 'user-b' }).total, 0);
    assert.equal(service.listLinks({}, { tenantId: 'tenant-b', userId: 'user-a' }).total, 0);
  } finally {
    db.close();
  }
});

test('cross-border actual fee stays zero when expense and income fully offset even if detail page shows a fee', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db, { tenantId: 'tenant-offset', userId: 'user-offset' });
    const shopId = saveUnitShop(shops, 'charge-offset-shop');
    createOrderRepository(db).upsertOrders({
      shopId,
      rows: [{ posting_number: 'OFFSET-1', order_id: 'offset-order', status: 'cancelled' }],
    });
    const service = createCrossBorderChargeService({ db, shopRepository: shops });
    const preview = service.buildPreview({
      browserAccountRef: 'browser-offset',
      shopId,
      orders: [{ oid: 'offset-collection', order_number: 'OFFSET-1', detailTotalCny: 8.8 }],
      charges: [
        { oid: 'offset-collection', type: '支出', money: 8.8, time: '2026-07-28 10:00:00' },
        { oid: 'offset-collection', type: '收入', money: 8.8, time: '2026-07-28 10:01:00' },
      ],
    }, { tenantId: 'tenant-offset', userId: 'user-offset' });
    assert.equal(preview.rows[0].ledgerNetCny, 0);
    assert.equal(preview.rows[0].actualFeeCny, 0);
  } finally {
    db.close();
  }
});

test('cross-border preview refuses a shop owned by another user in the same profile', () => {
  const db = createMigratedTestDb();
  try {
    const ownerA = createShopRepository(db, {
      profileId: 'shared-profile',
      tenantId: 'tenant-a',
      userId: 'user-a',
    });
    const ownerB = createShopRepository(db, {
      profileId: 'shared-profile',
      tenantId: 'tenant-b',
      userId: 'user-b',
    });
    const shopA = saveUnitShop(ownerA, 'charge-owner-a');
    const shopB = saveUnitShop(ownerB, 'charge-owner-b');
    createOrderRepository(db).upsertOrders({
      shopId: shopB,
      rows: [{ posting_number: 'OWNER-B-POSTING', order_id: 'owner-b-order', status: 'delivered' }],
    });

    const service = createCrossBorderChargeService({
      db,
      shopRepository: ownerA,
      profileId: 'shared-profile',
    });
    assert.ok(shopA);
    assert.throws(
      () => service.buildPreview({
        ...sourcePayload(shopB),
        orders: [{ oid: 'owner-b-collection', order_number: 'OWNER-B-POSTING' }],
      }, { tenantId: 'tenant-a', userId: 'user-a' }),
      /CROSS_BORDER_CHARGE_SHOP_FORBIDDEN/u,
    );
  } finally {
    db.close();
  }
});

test('cross-border charge matching is restricted to every Ozon shop bound to the selected bus account', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db, { tenantId: 'tenant-bound', userId: 'user-bound' });
    const shopA = saveUnitShop(shops, 'bound-shop-a');
    const shopB = saveUnitShop(shops, 'bound-shop-b');
    const shopC = saveUnitShop(shops, 'unbound-shop-c');
    const orders = createOrderRepository(db);
    for (const shopId of [shopA, shopB, shopC]) {
      orders.upsertOrders({
        shopId,
        rows: [{ posting_number: '0123640791-0163-1', order_id: `ozon-${shopId}`, status: 'delivered' }],
      });
    }
    const accountService = createCrossBorderAccountService({
      db,
      profileId: shops.profileId,
      tenantId: shops.tenantId,
      userId: shops.userId,
    });
    accountService.saveAccount({
      id: 'bus-bound-a',
      name: '跨境巴士 A',
      status: 'active',
      shopIds: [shopA, shopB],
    });
    const service = createCrossBorderChargeService({
      db,
      shopRepository: shops,
      crossBorderAccountService: accountService,
    });
    const scope = { tenantId: 'tenant-bound', userId: 'user-bound' };

    const ambiguous = service.buildPreview({
      ...sourcePayload(),
      crossBorderAccountId: 'bus-bound-a',
    }, scope);
    assert.deepEqual(ambiguous.rows[0].candidateShopIds.sort(), [shopA, shopB].sort());
    assert.equal(ambiguous.summary.boundShopCount, 2);
    assert.throws(
      () => service.buildPreview({
        ...sourcePayload(shopC),
        crossBorderAccountId: 'bus-bound-a',
      }, scope),
      /CROSS_BORDER_ACCOUNT_SHOP_FORBIDDEN/u,
    );

    const exact = service.buildPreview({
      ...sourcePayload(shopA),
      crossBorderAccountId: 'bus-bound-a',
    }, scope);
    assert.equal(exact.rows[0].shopId, shopA);
    assert.equal(exact.rows[0].crossBorderAccountId, 'bus-bound-a');

    accountService.saveAccount({ id: 'bus-bound-b', name: '跨境巴士 B', shopIds: [shopC] });
    assert.throws(
      () => service.buildPreview(sourcePayload(), scope),
      /CROSS_BORDER_ACCOUNT_AMBIGUOUS/u,
    );
  } finally {
    db.close();
  }
});

test('cross-border charge import matches and records more than one thousand paged rows without truncation', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db, { tenantId: 'tenant-large', userId: 'user-large' });
    const shopId = saveUnitShop(shops, 'charge-large-shop');
    const rowCount = 1205;
    const sourceOrders = Array.from({ length: rowCount }, (_, index) => ({
      oid: `COLLECTION-${index + 1}`,
      order_number: `POSTING-${index + 1}`,
    }));
    const sourceCharges = Array.from({ length: rowCount }, (_, index) => ({
      oid: `COLLECTION-${index + 1}`,
      type: '支出',
      money: 1,
      time: `2026-08-11 12:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
      reason: '订单发货费用',
    }));
    createOrderRepository(db).upsertOrders({
      shopId,
      rows: sourceOrders.map((row, index) => ({
        posting_number: row.order_number,
        order_id: `ozon-large-${index + 1}`,
        status: 'delivered',
      })),
    });
    const service = createCrossBorderChargeService({ db, shopRepository: shops });
    const scope = { tenantId: 'tenant-large', userId: 'user-large' };
    const preview = service.buildPreview({
      browserAccountRef: 'browser-large',
      orders: sourceOrders,
      charges: sourceCharges,
    }, scope);

    assert.equal(preview.summary.statementCount, rowCount);
    assert.equal(preview.summary.orderCount, rowCount);
    assert.equal(preview.summary.exactCount, rowCount);
    assert.equal(preview.summary.unmatchedCount, 0);

    const confirmed = service.confirmImport({
      previewId: preview.previewId,
      confirmationToken: preview.confirmationToken,
    }, scope);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.readbackVerified, true);
    assert.equal(confirmed.savedOrderCount, rowCount);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM cross_border_charge_records').get().total, rowCount);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM cross_border_charge_links').get().total, rowCount);
  } finally {
    db.close();
  }
});

test('cross-border charge import aggregates every collection of one Ozon order and remains idempotent', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db, { tenantId: 'tenant-real', userId: 'user-real' });
    const shopId = saveUnitShop(shops, 'charge-real-shop');
    createOrderRepository(db).upsertOrders({
      shopId,
      rows: [{ posting_number: '0134585898-0058-1', order_id: 'ozon-real-order', status: 'delivered' }],
    });
    const service = createCrossBorderChargeService({ db, shopRepository: shops });
    const scope = { tenantId: 'tenant-real', userId: 'user-real' };
    const payload = {
      browserAccountRef: 'browser-real',
      crossBorderAccountId: 'cross-border-main',
      shopId,
      orders: [
        { id: '49483557', oid: '483558', order_number: '0134585898-0058-1' },
        { id: '49484188', oid: '484189', order_number: '0134585898-0058-1' },
      ],
      charges: [
        { oid: '483558', type: '支出', money: 0.1, reason: '支付订单系统服务费', time: '1782125509' },
        { oid: '484189', type: '支出', money: 0.1, reason: '支付订单系统服务费', time: '1782125792' },
        { oid: '484189', type: '支出', money: 0.1, reason: '退还订单系统服务费', time: '1782385826' },
        { oid: '484189', type: '支出', money: 1.5, reason: '订单发货费用', time: '1782385826' },
        { oid: '484189', type: '支出', money: 1.5, reason: '取消发货,退回费用', time: '1782385840' },
        { oid: '484189', type: '支出', money: 1.5, reason: '订单发货费用', time: '1782385840' },
      ],
    };

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const preview = service.buildPreview(payload, scope);
      assert.equal(preview.summary.exactCount, 2);
      assert.equal(preview.summary.exactOrderCount, 1);
      assert.equal(preview.summary.exactActualFeeCny, 1.6);
      const confirmed = service.confirmImport({
        previewId: preview.previewId,
        confirmationToken: preview.confirmationToken,
      }, scope);
      assert.equal(confirmed.ok, true);
      assert.equal(confirmed.exactOrderCount, 1);
    }

    assert.equal(db.prepare('SELECT COUNT(*) total FROM cross_border_charge_records').get().total, 6);
    assert.equal(db.prepare('SELECT COUNT(*) total FROM cross_border_charge_links').get().total, 2);
    assert.equal(db.prepare("SELECT COUNT(*) total FROM cross_border_charge_records WHERE direction = 'income'").get().total, 2);
    const override = createPurchaseOrderOverrideRepository(db).getOverride({
      shopId,
      orderKey: '0134585898-0058-1',
    });
    assert.equal(override.actualCrossBorderBusFeeCny, 1.6);
    assert.deepEqual(override.crossBorderChargeEvidence.collectionNumbers, ['483558', '484189']);
    assert.equal(override.crossBorderChargeEvidence.expenseCny, 3.2);
    assert.equal(override.crossBorderChargeEvidence.incomeCny, 1.6);
    assert.equal(override.crossBorderChargeEvidence.ledgerNetCny, 1.6);
  } finally {
    db.close();
  }
});

test('correcting an old refund direction replaces the stale physical record instead of duplicating it', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db, { tenantId: 'tenant-repair', userId: 'user-repair' });
    const shopId = saveUnitShop(shops, 'charge-repair-shop');
    createOrderRepository(db).upsertOrders({
      shopId,
      rows: [{ posting_number: 'REPAIR-ORDER', order_id: 'repair-order', status: 'cancelled' }],
    });
    const createdAt = '2026-08-11T00:00:00.000Z';
    db.prepare(`
      INSERT INTO cross_border_charge_records (
        id, tenant_id, user_id, profile_id, browser_account_ref, external_account_ref,
        cross_border_account_id, shop_id, collection_number, posting_number, purchase_order_number,
        direction, amount_cny, balance_after_cny, reason, occurred_at, warehouse, service_company,
        source_record_hash, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, '', 'expense', ?, ?, ?, ?, '', '', ?, '{}', ?, ?)
    `).run(
      'legacy-wrong-record', 'tenant-repair', 'user-repair', 'default', 'browser-repair',
      shopId, 'repair-collection', 'REPAIR-ORDER', 1.5, 61.7,
      '取消发货,退回费用', '1782385840', 'legacy-direction-dependent-hash', createdAt, createdAt,
    );

    const service = createCrossBorderChargeService({ db, shopRepository: shops });
    const scope = { tenantId: 'tenant-repair', userId: 'user-repair' };
    const preview = service.buildPreview({
      browserAccountRef: 'browser-repair',
      shopId,
      orders: [{ oid: 'repair-collection', order_number: 'REPAIR-ORDER' }],
      charges: [{
        oid: 'repair-collection', type: '支出', money: 1.5, after_money: 61.7,
        reason: '取消发货,退回费用', time: '1782385840',
      }],
    }, scope);
    service.confirmImport({ previewId: preview.previewId, confirmationToken: preview.confirmationToken }, scope);

    const records = db.prepare('SELECT id, direction FROM cross_border_charge_records').all();
    assert.equal(records.length, 1);
    assert.equal(records[0].direction, 'income');
    assert.notEqual(records[0].id, 'legacy-wrong-record');
  } finally {
    db.close();
  }
});

test('saving a different recharge gift policy revalues stored charges without recapturing Cross-Border Bus', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db, { tenantId: 'tenant-rate', userId: 'user-rate' });
    const shopId = saveUnitShop(shops, 'charge-rate-shop');
    createOrderRepository(db).upsertOrders({
      shopId,
      rows: [{ posting_number: '0123640791-0163-1', order_id: 'ozon-rate', status: 'delivered' }],
    });
    const service = createCrossBorderChargeService({ db, shopRepository: shops });
    const scope = { tenantId: 'tenant-rate', userId: 'user-rate' };
    const preview = service.buildPreview(sourcePayload(shopId), scope);
    service.confirmImport({ previewId: preview.previewId, confirmationToken: preview.confirmationToken }, scope);
    assert.equal(
      createPurchaseOrderOverrideRepository(db).getOverride({ shopId, orderKey: '0123640791-0163-1' })
        .actualCrossBorderBusFeeCny,
      1.5,
    );

    createProfileSettingsRepository(db).saveSetting({
      namespace: 'fee-settings',
      value: {
        activeId: 'bus-rate',
        plans: [{
          id: 'bus-rate',
          name: '跨境巴士费用',
          settings: {
            platform: 'crossBorderBus',
            rechargeAmount: '300',
            giftAmount: '100',
            rechargeRateHistory: [{
              id: 'rate-300-100',
              effectiveAt: '2026-01-01T00:00:00.000Z',
              rechargeAmount: '300',
              giftAmount: '100',
            }],
          },
        }],
      },
    });
    const result = service.revalueStoredCharges(scope);
    assert.equal(result.collectionCount, 1);
    assert.equal(result.conversionPolicy.defaultRate, 0.75);
    assert.equal(result.actualFeeCny, 1.13);
    const override = createPurchaseOrderOverrideRepository(db).getOverride({
      shopId,
      orderKey: '0123640791-0163-1',
    });
    assert.equal(override.actualCrossBorderBusFeeCny, 1.13);
    assert.equal(override.crossBorderChargeEvidence.ledgerNetCny, 1.5);
    assert.equal(override.crossBorderChargeEvidence.cashNetCny, 1.125);
  } finally {
    db.close();
  }
});

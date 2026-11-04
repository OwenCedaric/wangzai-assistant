import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createPurchaseBrowserCaptureService } from './purchaseBrowserCaptureService.js';

const target = Object.freeze({
  targetId: 'target-1',
  shopId: 'shop-a',
  orderKey: 'order-1',
  ozonOrderId: 'ozon-1',
  sku: 'sku-1',
  offerId: 'offer-1',
  productTitle: '目标商品',
  quantity: 2,
});

const capture = Object.freeze({
  platform: '1688',
  pageType: 'order-detail',
  sourceUrl: 'https://detail.1688.com/offer/123.html',
  sourceProductId: '123',
  productTitle: '采购商品',
  quantity: 2,
  purchaseOrderNumber: 'PURCHASE-1001',
  purchaseOrderStatus: '待发货',
  purchaseOrderUrl: 'https://trade.1688.com/order/detail.html?orderId=PURCHASE-1001',
  purchasePrice: 12.5,
  currency: 'CNY',
});

test('capture preview requires exact confirmation and verifies transactional readback', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
    let clock = Date.parse('2026-07-18T00:00:00.000Z');
    const service = createPurchaseBrowserCaptureService(db, {
      now: () => clock,
      createPreviewId: (() => {
        let index = 0;
        return () => `preview-${++index}`;
      })(),
      createConfirmationToken: (() => {
        let index = 0;
        return () => `confirmation-token-${++index}`;
      })(),
    });
    const preview = service.preview({ target, capture });
    assert.deepEqual(preview.missingFields, []);
    assert.equal(preview.readbackRequired, true);
    assert.throws(
      () => service.confirm({
        previewId: preview.previewId,
        confirmationToken: 'wrong',
        captureHash: preview.captureHash,
        target,
      }),
      /PURCHASE_BROWSER_CONFIRMATION_REQUIRED/u,
    );
    const confirmed = service.confirm({
      previewId: preview.previewId,
      confirmationToken: preview.confirmationToken,
      captureHash: preview.captureHash,
      target,
    });
    assert.equal(confirmed.readbackVerified, true);
    assert.equal(confirmed.readback.override.purchaseOrderNumber, 'PURCHASE-1001');
    assert.equal(confirmed.readback.override.manualStatus, '待发货');
    assert.match(confirmed.readback.override.purchaseOrderUrl, /trade\.1688\.com/u);
    assert.equal(confirmed.readback.sourceLinks[0].url, capture.sourceUrl);
    assert.equal(service.readback(target).readbackVerified, true);
    db.prepare(
      'UPDATE purchase_order_overrides SET purchase_order_number = ? WHERE shop_id = ? AND order_key = ?',
    ).run('TAMPERED-ORDER', target.shopId, target.orderKey);
    assert.throws(
      () => service.readback(target),
      /PURCHASE_BROWSER_READBACK_FAILED/u,
    );
    // A completed idempotent confirmation must re-read durable state. It
    // must not silently return the old success after another writer changed
    // the stored purchase fields. The caller has to create a fresh preview
    // and explicitly accept the conflict to repair the data.
    assert.throws(
      () => service.confirm({
        previewId: preview.previewId,
        confirmationToken: preview.confirmationToken,
        captureHash: preview.captureHash,
        target,
      }),
      /PURCHASE_BROWSER_READBACK_FAILED/u,
    );
    const repairPreview = service.preview({ target, capture, idempotencyKey: 'capture-repair-1' });
    const repaired = service.confirm({
      previewId: repairPreview.previewId,
      idempotencyKey: repairPreview.idempotencyKey,
      confirmationToken: repairPreview.confirmationToken,
      captureHash: repairPreview.captureHash,
      target,
      acceptConflicts: true,
    });
    assert.equal(repaired.readbackVerified, true);
    clock += 1;
  } finally {
    db.close();
  }
});

test('capture confirmation fails closed for missing fields and changed targets', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
    const service = createPurchaseBrowserCaptureService(db, {
      createPreviewId: () => 'preview-2',
      createConfirmationToken: () => 'confirmation-token-2',
    });
    const preview = service.preview({ target, capture: { ...capture, purchaseOrderNumber: '' } });
    assert.ok(preview.missingFields.includes('purchaseOrderNumber'));
    assert.throws(
      () => service.confirm({
        previewId: preview.previewId,
        confirmationToken: preview.confirmationToken,
        captureHash: preview.captureHash,
        target,
      }),
      /PURCHASE_BROWSER_CAPTURE_FIELDS_MISSING/u,
    );
    assert.throws(
      () => service.confirm({
        previewId: preview.previewId,
        confirmationToken: preview.confirmationToken,
        captureHash: preview.captureHash,
        target: { ...target, orderKey: 'order-2' },
      }),
      /PURCHASE_BROWSER_TARGET_AMBIGUOUS/u,
    );
  } finally {
    db.close();
  }
});

test('confirmed PDD refund clears only the exact purchase record and keeps auditable refund evidence', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
    const service = createPurchaseBrowserCaptureService(db, {
      createPreviewId: (() => { let index = 0; return () => `refund-preview-${++index}`; })(),
      createConfirmationToken: () => 'refund-confirmation-token',
    });
    const paidPreview = service.preview({
      target,
      capture: {
        ...capture,
        platform: '拼多多',
        sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=123',
        purchaseOrderUrl: 'https://mobile.yangkeduo.com/order.html?order_sn=PURCHASE-1001',
      },
    });
    service.confirm({
      previewId: paidPreview.previewId,
      idempotencyKey: paidPreview.idempotencyKey,
      confirmationToken: paidPreview.confirmationToken,
      captureHash: paidPreview.captureHash,
      target,
    });

    const refundCapture = {
      platform: '拼多多',
      purchaseOrderNumber: 'PURCHASE-1001',
      purchaseOrderStatus: '极速退款成功',
      purchaseOrderUrl: 'https://mobile.yangkeduo.com/order.html?order_sn=PURCHASE-1001',
      capturedAt: '2026-08-10T12:15:00.000Z',
    };
    const refundPreview = service.previewRefund({
      target,
      capture: refundCapture,
      idempotencyKey: 'refund-PURCHASE-1001',
    });
    const refunded = service.confirmRefund({
      previewId: refundPreview.previewId,
      idempotencyKey: refundPreview.idempotencyKey,
      confirmationToken: refundPreview.confirmationToken,
      captureHash: refundPreview.captureHash,
      target,
    });

    assert.equal(refunded.readbackVerified, true);
    assert.equal(refunded.readback.override.purchasePlatform, '');
    assert.equal(refunded.readback.override.purchaseOrderNumber, '');
    assert.equal(refunded.readback.override.purchaseOrderUrl, '');
    assert.equal(refunded.readback.override.sourceCostCny, null);
    assert.equal(refunded.readback.override.manualStatus, '');
    assert.equal(refunded.readback.override.forcePurchaseStatus, '待拍单');
    assert.equal(refunded.readback.override.voidedPurchaseOrderNo, 'PURCHASE-1001');
    assert.equal(refunded.readback.override.purchaseRefundConfirmed, true);
    assert.equal(refunded.readback.override.purchaseRefundStatus, '极速退款成功');
    assert.equal(refunded.readback.override.transferPendingReason, '拼多多订单页已回读退款成功');
    assert.equal(refunded.readback.sourceLinks.length, 1, '货源资料保留，方便重新拍单');
    const durableRaw = JSON.parse(db.prepare(
      'SELECT raw_json FROM purchase_order_overrides WHERE shop_id = ? AND order_key = ?',
    ).get(target.shopId, target.orderKey).raw_json);
    for (const staleField of [
      'purchasePlatform', 'purchase_platform', 'platform',
      'purchaseOrderNumber', 'purchase_order_number', 'purchaseOrderUrl',
      'purchase_order_url', 'orderUrl', 'sourceCostCny', 'source_cost_cny',
      'cost', 'manualStatus', 'manual_status', 'purchaseOrderStatus',
    ]) {
      assert.equal(Object.hasOwn(durableRaw, staleField), false, `refund raw_json must remove ${staleField}`);
    }

    assert.throws(
      () => service.previewRefund({
        target,
        capture: { ...refundCapture, purchaseOrderNumber: 'OTHER-PURCHASE' },
      }),
      /PURCHASE_BROWSER_TARGET_AMBIGUOUS/u,
    );
  } finally {
    db.close();
  }
});

for (const platform of ['1688', '淘宝', '天猫', 'Ozon买家']) {
  test(`confirmed ${platform} refund clears the exact active purchase without platform residue`, () => {
    const db = createMigratedTestDb();
    try {
      db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
      const service = createPurchaseBrowserCaptureService(db, {
        createPreviewId: (() => { let index = 0; return () => `${platform}-refund-preview-${++index}`; })(),
        createConfirmationToken: () => `${platform}-refund-token`,
      });
      const platformCapture = {
        ...capture,
        platform,
        purchaseOrderNumber: `${platform}-PURCHASE-1001`,
        purchaseOrderUrl: `https://example.test/${encodeURIComponent(platform)}/order/PURCHASE-1001`,
        sourceUrl: `https://example.test/${encodeURIComponent(platform)}/product/123`,
      };
      const paidPreview = service.preview({ target, capture: platformCapture });
      service.confirm({
        previewId: paidPreview.previewId,
        idempotencyKey: paidPreview.idempotencyKey,
        confirmationToken: paidPreview.confirmationToken,
        captureHash: paidPreview.captureHash,
        target,
      });
      const refundPreview = service.previewRefund({
        target,
        capture: {
          platform,
          purchaseOrderNumber: platformCapture.purchaseOrderNumber,
          purchaseOrderStatus: '退款成功',
          purchaseOrderUrl: platformCapture.purchaseOrderUrl,
        },
      });
      const refunded = service.confirmRefund({
        previewId: refundPreview.previewId,
        idempotencyKey: refundPreview.idempotencyKey,
        confirmationToken: refundPreview.confirmationToken,
        captureHash: refundPreview.captureHash,
        target,
      });

      assert.equal(refunded.readbackVerified, true);
      assert.equal(refunded.readback.override.purchasePlatform, '');
      assert.equal(refunded.readback.override.purchaseOrderNumber, '');
      assert.equal(refunded.readback.override.sourceCostCny, null);
      assert.equal(refunded.readback.override.voidedPurchasePlatform, platform);
      assert.equal(refunded.readback.override.transferPendingReason, `${platform}订单页已回读退款成功`);
    } finally {
      db.close();
    }
  });
}

test('capture confirmation rejects unknown platforms and replays only the same idempotency key', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
    const service = createPurchaseBrowserCaptureService(db, {
      createPreviewId: (() => { let index = 0; return () => `preview-idempotent-${++index}`; })(),
      createConfirmationToken: (() => { let index = 0; return () => `token-${++index}`; })(),
    });
    const missing = service.preview({ target, capture: { ...capture, platform: 'unknown' } });
    assert.ok(missing.missingFields.includes('purchasePlatform'));
    const preview = service.preview({ target, capture, idempotencyKey: 'capture-key-1' });
    const first = service.confirm({
      previewId: preview.previewId,
      idempotencyKey: 'capture-key-1',
      confirmationToken: preview.confirmationToken,
      captureHash: preview.captureHash,
      target,
    });
    const replay = service.confirm({
      previewId: preview.previewId,
      idempotencyKey: 'capture-key-1',
      confirmationToken: preview.confirmationToken,
      captureHash: preview.captureHash,
      target,
    });
    assert.deepEqual(replay, first);
    assert.throws(
      () => service.confirm({
        previewId: preview.previewId,
        idempotencyKey: 'different-key',
        confirmationToken: preview.confirmationToken,
        captureHash: preview.captureHash,
        target,
      }),
      /PURCHASE_BROWSER_CONFIRMATION_REQUIRED/u,
    );
  } finally {
    db.close();
  }
});

test('capture preview refuses an ambiguous product scope instead of picking the first source row', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
    const links = db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, product_key, slot_index, is_primary,
        platform, url, source_product_id, title, price_value, currency_code, qty,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    links.run('link-a', 'shop-a', 'order-1', 'sku-1', 0, 1, '1688', capture.sourceUrl, '1', 'A', 10, 'CNY', '1', '2026-07-18', '2026-07-18');
    links.run('link-b', 'shop-a', 'order-1', 'sku-1', 1, 0, '1688', capture.sourceUrl, '2', 'B', 11, 'CNY', '1', '2026-07-18', '2026-07-18');
    const service = createPurchaseBrowserCaptureService(db);
    assert.throws(
      () => service.preview({ target, capture }),
      /PURCHASE_BROWSER_TARGET_AMBIGUOUS/u,
    );
  } finally {
    db.close();
  }
});

test('capture preview reports a missing source URL as a review field instead of crashing the parser', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
    const service = createPurchaseBrowserCaptureService(db);
    const preview = service.preview({ target, capture: { ...capture, sourceUrl: '', pageUrl: '' } });
    assert.ok(preview.missingFields.includes('sourceUrl'));
  } finally {
    db.close();
  }
});

test('capture preview accepts Ozon buyer pages with RUB currency', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
    db.prepare(`
      INSERT INTO exchange_rate_cache (
        requested_date, mode, rate_date, nearest_fallback, lookback_days_used,
        rub_to_cny_rate, source, fetched_at, expires_at, immutable, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('2026-07-23', 'daily', '2026-07-23', 0, 0, 0.09, 'test', '2026-07-23', null, 1, '2026-07-23');
    const service = createPurchaseBrowserCaptureService(db);
    const preview = service.preview({
      target,
      capture: {
        ...capture,
        platform: 'Ozon买家',
        sourceUrl: 'https://www.ozon.ru/product/test-123456789/',
        pageUrl: 'https://www.ozon.ru/product/test-123456789/',
        sourceProductId: '123456789',
        currency: 'RUB',
      },
    });
    assert.deepEqual(preview.missingFields, []);
    assert.equal(preview.after.override.purchasePlatform, 'Ozon买家');
    assert.equal(preview.after.override.sourceCostCny, 1.13);
    assert.equal(preview.after.sourceLink.currencyCode, 'RUB');
  } finally {
    db.close();
  }
});

test('Ozon buyer capture waits for a RUB/CNY rate instead of writing rubles into the CNY cost field', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run('shop-a', 'Shop A');
    const service = createPurchaseBrowserCaptureService(db);
    const preview = service.preview({
      target,
      capture: {
        ...capture,
        platform: 'Ozon买家',
        sourceUrl: 'https://www.ozon.ru/product/test-123456789/',
        currency: 'RUB',
      },
    });
    assert.ok(preview.missingFields.includes('sourceCostCny'));
    assert.equal(preview.after.override.sourceCostCny, null);
    assert.equal(preview.after.sourceLink.priceValue, capture.purchasePrice);
    assert.equal(preview.after.sourceLink.currencyCode, 'RUB');
  } finally {
    db.close();
  }
});

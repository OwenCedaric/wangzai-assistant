import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createApp } from './createApp.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('purchase browser capture HTTP flow previews, confirms and reads back both purchase stores', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-route', 'Route shop', 'active')").run();
    server = createApp({
      db,
      config: { security: { purchaseBrowserToken: 'route-token' }, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const target = {
      targetId: 'target-route',
      shopId: 'shop-route',
      orderKey: 'order-route',
      sku: 'sku-route',
    };
    const capture = {
      platform: '1688',
      pageType: 'order-detail',
      sourceUrl: 'https://detail.1688.com/offer/route-1.html',
      sourceProductId: 'route-1',
      productTitle: 'Route product',
      quantity: 1,
      purchaseOrderNumber: 'purchase-route-1',
      purchasePrice: 5.6,
      currency: 'CNY',
    };
    const preview = await request(`${base}/api/purchase/browser-capture/preview`, 'POST', { target, capture });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.readbackRequired, true);
    const confirmed = await request(`${base}/api/purchase/browser-capture/confirm`, 'POST', {
      previewId: preview.payload.previewId,
      confirmationToken: preview.payload.confirmationToken,
      captureHash: preview.payload.captureHash,
      target,
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.payload.readbackVerified, true);
    const readback = await request(
      `${base}/api/purchase/browser-capture/readback?targetId=${target.targetId}&shopId=${target.shopId}&orderKey=${target.orderKey}&sku=${target.sku}`,
      'GET',
    );
    assert.equal(readback.response.status, 200);
    assert.equal(readback.payload.override.purchaseOrderNumber, capture.purchaseOrderNumber);
    assert.equal(readback.payload.sourceLinks[0].priceValue, capture.purchasePrice);
  } finally {
    server?.close();
    db.close();
  }
});

test('purchase browser refund HTTP flow clears only the exact confirmed PDD purchase record', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-refund-route', 'Refund shop', 'active')").run();
    server = createApp({
      db,
      config: { security: { purchaseBrowserToken: 'route-token' }, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const target = {
      targetId: 'target-refund-route',
      shopId: 'shop-refund-route',
      orderKey: 'order-refund-route',
      sku: 'sku-refund-route',
    };
    const paidCapture = {
      platform: '拼多多',
      pageType: 'order-detail',
      sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=route-refund-1',
      sourceProductId: 'route-refund-1',
      productTitle: 'Refund route product',
      quantity: 1,
      purchaseOrderNumber: 'purchase-refund-route-1',
      purchaseOrderUrl: 'https://mobile.yangkeduo.com/order.html?order_sn=purchase-refund-route-1',
      purchaseOrderStatus: '待发货',
      purchasePrice: 52.71,
      currency: 'CNY',
    };
    const paidPreview = await request(`${base}/api/purchase/browser-capture/preview`, 'POST', {
      target,
      capture: paidCapture,
    });
    const paid = await request(`${base}/api/purchase/browser-capture/confirm`, 'POST', {
      previewId: paidPreview.payload.previewId,
      confirmationToken: paidPreview.payload.confirmationToken,
      captureHash: paidPreview.payload.captureHash,
      target,
    });
    assert.equal(paid.payload.readbackVerified, true);

    const refundPreview = await request(`${base}/api/purchase/browser-capture/refund/preview`, 'POST', {
      target,
      capture: {
        platform: '拼多多',
        purchaseOrderNumber: paidCapture.purchaseOrderNumber,
        purchaseOrderStatus: '极速退款成功',
        purchaseOrderUrl: paidCapture.purchaseOrderUrl,
      },
    });
    assert.equal(refundPreview.response.status, 200);
    const refunded = await request(`${base}/api/purchase/browser-capture/refund/confirm`, 'POST', {
      previewId: refundPreview.payload.previewId,
      idempotencyKey: refundPreview.payload.idempotencyKey,
      confirmationToken: refundPreview.payload.confirmationToken,
      captureHash: refundPreview.payload.captureHash,
      target,
    });
    assert.equal(refunded.response.status, 200);
    assert.equal(refunded.payload.readbackVerified, true);
    assert.equal(refunded.payload.readback.override.purchaseOrderNumber, '');
    assert.equal(refunded.payload.readback.override.sourceCostCny, null);
    assert.equal(refunded.payload.readback.override.forcePurchaseStatus, '待拍单');
    assert.equal(refunded.payload.readback.override.voidedPurchaseOrderNo, paidCapture.purchaseOrderNumber);
    assert.equal(refunded.payload.readback.sourceLinks.length, 1);
  } finally {
    server?.close();
    db.close();
  }
});

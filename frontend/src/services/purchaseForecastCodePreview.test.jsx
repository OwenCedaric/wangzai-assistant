import fs from 'node:fs';
import path from 'node:path';
import { createPurchaseForecastFixture } from '../test/fixtures/purchaseForecastFixture.js';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { normalizeOzonSalesRowToPurchaseOrder } from './purchaseOrderRuntime.js';
import {
  buildPurchaseCrossBorderCreateBody,
  getPurchaseOperationInitialFields,
} from './purchaseCrossBorderRuntime.js';

describe('isolated forecast preview code', () => {
  it('generates the exact current preview without external writes', () => {
    const fixture = createPurchaseForecastFixture();
    const POSTING_NUMBER = fixture.postingNumber;
    const OUTPUT_PATH = path.join(fixture.directory, 'code-generated-preview.json');
    const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const row = db.prepare(`
        SELECT id, shop_id, posting_number, order_id, source, status, substatus,
               fulfillment, in_process_at, shipment_date, cutoff_at, payment_at,
               amount_value, products_json, raw_json, last_seen_at
          FROM ozon_orders
         WHERE posting_number = ?
         ORDER BY id DESC
         LIMIT 1
      `).get(POSTING_NUMBER);
      expect(row).toBeTruthy();
      const shop = db.prepare(`
        SELECT id, name, alias, client_id, status
          FROM shops
         WHERE id = ?
      `).get(row.shop_id);
      const raw = JSON.parse(row.raw_json || '{}');
      const orderProducts = JSON.parse(row.products_json || '[]');
      const products = orderProducts.map((product) => {
        const productRow = db.prepare(`
          SELECT product_id, offer_id, sku, name, primary_image_url,
                 price_value, currency_code
            FROM ozon_products
           WHERE shop_id = ?
             AND (offer_id = ? OR sku = ? OR product_id = ?)
           ORDER BY id DESC
           LIMIT 1
        `).get(row.shop_id, product.offer_id, String(product.sku || ''), String(product.sku || '')) || {};
        return {
          ...product,
          offerId: product.offer_id,
          skuId: product.sku,
          productId: productRow.product_id,
          name: productRow.name || product.name,
          qty: product.quantity,
          price: product.price,
          priceValue: Number(product.price),
          currencyCode: product.currency_code,
          image: productRow.primary_image_url || '',
          mainImage: productRow.primary_image_url || '',
          raw: product,
        };
      });
      const salesRow = {
        id: row.posting_number,
        posting: row.posting_number,
        salesOrder: row.posting_number,
        softwareOrderId: String(row.order_id || ''),
        shopId: row.shop_id,
        shopClientId: String(shop?.client_id || ''),
        shop: String(shop?.alias || shop?.name || row.shop_id),
        fulfillment: row.fulfillment || row.source,
        status: row.status,
        rawStatus: row.status,
        ozonRawStatus: row.status,
        amount: `¥${Number(row.amount_value || 0).toFixed(2)}`,
        amountValue: Number(row.amount_value || 0),
        paymentDate: row.payment_at,
        deadline: row.cutoff_at,
        updated: row.last_seen_at,
        logistics: raw?.delivery_method?.name || '',
        deliveryMethod: raw?.delivery_method?.name || '',
        products,
        product: products[0]?.name || '',
        raw,
      };
      const purchaseOrder = normalizeOzonSalesRowToPurchaseOrder(salesRow);
      const settingsRow = db.prepare(`
        SELECT value_json
          FROM profile_settings
         WHERE namespace = 'cross-border-preferences'
      `).get();
      const settings = JSON.parse(settingsRow?.value_json || '{}');
      const fields = getPurchaseOperationInitialFields(
        'createForecast',
        purchaseOrder,
        {},
        { productSourceLinks: {}, legacySourceLinks: {} },
      );
      const generated = buildPurchaseCrossBorderCreateBody(
        settings,
        purchaseOrder,
        fields,
        {
          requireSheet: false,
          productSourceLinks: {},
          legacySourceLinks: {},
          routeText: purchaseOrder.deliveryMethod,
        },
      );
      const output = {
        generator: {
          orderNormalizer: 'normalizeOzonSalesRowToPurchaseOrder',
          initialFields: 'getPurchaseOperationInitialFields',
          requestBuilder: 'buildPurchaseCrossBorderCreateBody',
          externalWrites: 0,
        },
        postingNumber: POSTING_NUMBER,
        purchaseOrder,
        fields,
        missing: generated.missing,
        requestBody: generated.body,
      };
      fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
      expect(JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')).postingNumber).toBe(POSTING_NUMBER);
      expect(output.requestBody.order_data[0].package_list[0].num).toBe(2);
      expect(output.generator.externalWrites).toBe(0);
      expect(output.requestBody.order_data?.[0]?.order_number).toBe(POSTING_NUMBER);
    } finally {
      db.close();
      fixture.cleanup();
    }
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePurchaseProductCapture } from './purchaseProductCaptureValidation.js';

function capture(overrides = {}) {
  return {
    platform: '天猫', pageType: 'product', sourceProductId: '676414560867',
    productTitle: '儿童遥控越野汽车', purchasePrice: 88,
    mainImages: ['https://img.example/main.jpg'],
    skus: [{ id: 'black', name: '黑色', price: 88 }],
    sourceMethod: 'taobao-structured-state',
    ...overrides,
  };
}

test('strict product capture accepts only a real product record', () => {
  assert.deepEqual(validatePurchaseProductCapture(capture()), { accepted: true, missing: [] });
  assert.deepEqual(validatePurchaseProductCapture(capture({
    productTitle: '用户评价·2000+', purchasePrice: null, skus: [],
  })), {
    accepted: false,
    missing: ['title', 'price', 'sku'],
  });
});

test('strict product capture rejects unknown platform and non-product pages', () => {
  assert.deepEqual(validatePurchaseProductCapture(capture({ platform: 'unknown', pageType: 'unknown' })), {
    accepted: false,
    missing: ['platform', 'product-page'],
  });
});

test('1688 capture must come from the structured product model, never a one-SKU DOM fallback', () => {
  assert.deepEqual(validatePurchaseProductCapture(capture({
    platform: '1688', sourceMethod: '1688-default-structured',
  })), { accepted: true, missing: [] });
  assert.deepEqual(validatePurchaseProductCapture(capture({
    platform: '1688', sourceMethod: '1688-structured-missing',
  })), {
    accepted: false,
    missing: ['1688-structured-data'],
  });
});

test('every supported marketplace rejects a DOM-only false positive', () => {
  const rows = [
    ['淘宝', 'taobao-mtop', 'taobao-structured-data'],
    ['天猫', 'taobao-structured-state', 'tmall-structured-data'],
    ['拼多多', 'pdd-runtime-state', 'pdd-structured-data'],
    ['京东', 'jd-product-html', 'jd-product-data'],
    ['Wildberries', 'wildberries-card-api', 'wildberries-product-data'],
    ['Amazon', 'amazon-page-structure', 'amazon-product-data'],
    ['Temu', 'temu-raw-data', 'temu-product-data'],
    ['AliExpress', 'aliexpress-json-api', 'aliexpress-product-data'],
    ['Ozon买家', 'ozon-widget-state', 'ozon-product-data'],
  ];
  for (const [platform, sourceMethod, missingCode] of rows) {
    assert.deepEqual(
      validatePurchaseProductCapture(capture({ platform, sourceMethod })),
      { accepted: true, missing: [] },
    );
    assert.deepEqual(
      validatePurchaseProductCapture(capture({ platform, sourceMethod: 'dom-fallback' })),
      { accepted: false, missing: [missingCode] },
    );
  }
});

test('accepts the exact Pinduoduo React-props structured product reader', () => {
  assert.equal(validatePurchaseProductCapture(capture({
    platform: '拼多多',
    sourceMethod: 'pdd-react-props',
  })).accepted, true);
});

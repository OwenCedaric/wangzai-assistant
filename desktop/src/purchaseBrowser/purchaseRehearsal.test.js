import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountSupportsPurchaseRehearsal,
  createPurchaseRehearsalResult,
  normalizePurchaseRehearsalTargets,
  PURCHASE_REHEARSAL_STOP_STAGE,
  samplePurchaseRehearsalTarget,
} from './purchaseRehearsal.js';

const target = normalizePurchaseRehearsalTargets([{
  platform: '1688',
  url: 'https://detail.1688.com/offer/123456.html?spm=fixture',
  sourceProductId: '123456',
  sku: 'stored-order-sku',
}])[0];

test('normalizes only supported HTTPS product targets and strips duplicates', () => {
  const targets = normalizePurchaseRehearsalTargets([
    { url: 'https://mobile.yangkeduo.com/goods.html?goods_id=88', sku: 'pdd-1' },
    { url: 'https://mobile.yangkeduo.com/goods.html?goods_id=88', sku: 'pdd-1' },
    { url: 'http://detail.1688.com/offer/12.html' },
    { url: 'https://example.com/product/1' },
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].platformId, 'pinduoduo');
  assert.match(targets[0].targetHash, /^[a-f0-9]{64}$/u);
});

test('shares Taobao login state with Tmall without sharing other platforms', () => {
  assert.equal(accountSupportsPurchaseRehearsal({ platformName: '淘宝' }, 'tmall'), true);
  assert.equal(accountSupportsPurchaseRehearsal({ platformName: '1688' }, 'tmall'), false);
});

test('creates a read-only rehearsal that always stops before password input', () => {
  const result = createPurchaseRehearsalResult({
    platform: '1688',
    target,
    accountLogin: { loggedIn: true, cookieSaved: true },
    capture: {
      platform: '1688',
      pageType: 'product',
      sourceProductId: '123456',
      purchasePrice: 12.3,
      sourceMethod: '1688-structured-state',
      skus: [
        { id: 'sku-a', price: 12.3, attributes: [{ name: '颜色', value: '蓝色' }] },
        { id: 'sku-b', price: 14.5, attributes: [{ name: '尺寸', value: '大号' }] },
      ],
    },
    chooseIndex: () => 1,
    now: () => '2026-08-25T00:00:00.000Z',
  });
  assert.equal(result.stopStage, PURCHASE_REHEARSAL_STOP_STAGE);
  assert.equal(result.stages.at(-1).name, 'STOPPED_BEFORE_SECRET_INPUT');
  assert.equal(result.amountObserved, 14.5);
  assert.equal(result.safety.clickedSubmitOrder, false);
  assert.equal(result.safety.createdPendingOrder, false);
  assert.equal(result.safety.enteredPaymentPassword, false);
  assert.equal(result.safety.clickedFinalPay, false);
  assert.doesNotMatch(JSON.stringify(result), /stored-order-sku|sku-b|蓝色|大号/u);
});

test('rejects unauthenticated sessions and supports sampling with replacement', () => {
  assert.equal(samplePurchaseRehearsalTarget([target], '1688', () => 0), target);
  assert.throws(() => createPurchaseRehearsalResult({
    platform: '1688',
    target,
    accountLogin: { loggedIn: false, cookieSaved: false },
    capture: {},
  }), /PURCHASE_REHEARSAL_LOGIN_REQUIRED/u);
});


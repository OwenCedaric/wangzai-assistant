import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanOptionalText,
  isConfirmedPurchaseOrderStatus,
  isConfirmedPurchaseRefundStatus,
  isOzonAuthenticationDeniedResult,
  isPinduoduoProductUrl,
  normalizePinduoduoTopLevelUrl,
  normalizePurchaseWorkbenchForPlatform,
  purchaseOverrideIsVoided,
  purchasePlatformFromUrl,
  purchaseSourceProductId,
  requiredText,
  sanitizedErrorCode,
} from './purchaseBrowserControllerHelpers.js';

test('purchase browser controller helpers preserve exact platform and status decisions', () => {
  assert.equal(requiredText('  order-1  ', 'ORDER_REQUIRED'), 'order-1');
  assert.equal(cleanOptionalText('  hello\u0000 world  ', 20), 'hello world');
  assert.equal(purchasePlatformFromUrl('https://detail.1688.com/offer/123456.html'), '1688');
  assert.equal(purchasePlatformFromUrl('https://mobile.yangkeduo.com/goods.html?goods_id=123456'), '拼多多');
  assert.equal(purchaseSourceProductId('https://detail.1688.com/offer/123456.html'), '123456');
  assert.equal(isPinduoduoProductUrl('https://mobile.yangkeduo.com/goods.html?goods_id=123456'), true);
  assert.equal(normalizePinduoduoTopLevelUrl('https://www.pinduoduo.com/'), 'https://mobile.yangkeduo.com/');
  assert.deepEqual(normalizePurchaseWorkbenchForPlatform('1688', { target: 'same' }), { target: 'same' });
  assert.equal(isConfirmedPurchaseOrderStatus('买家已付款'), true);
  assert.equal(isConfirmedPurchaseRefundStatus('退款处理中'), false);
  assert.equal(purchaseOverrideIsVoided({ purchaseRefundConfirmed: true }), true);
  assert.equal(isOzonAuthenticationDeniedResult({ status: 401 }), true);
  assert.equal(sanitizedErrorCode({ code: 'FOLLOW_SELLER_SCHEME1_FAILED' }), 'FOLLOW_SELLER_SCHEME1_FAILED');
});

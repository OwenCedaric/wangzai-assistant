import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const nativeScript = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/PurchaseAutoOrderScript.cs', import.meta.url), 'utf8');
const browserSession = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/BrowserSession.cs', import.meta.url), 'utf8');
const desktopController = fs.readFileSync(new URL('./cefPurchaseBrowserController.js', import.meta.url), 'utf8');

test('native automatic order follows checkout navigation and keeps one idempotent submit state', () => {
  assert.match(nativeScript, /__wangzaiAutoOrderState/u);
  assert.match(nativeScript, /clickedSubmit/u);
  assert.match(nativeScript, /stage: 'checkout-progress'/u);
  assert.match(browserSession, /for \(int attempt = 0; attempt < 45/u);
  assert.match(browserSession, /IsLoading \|\| !Browser\.CanExecuteJavascriptInMainFrame/u);
  assert.match(browserSession, /checkout-progress/u);
});

test('native payment stage reads accessible cashier frames and enforces the configured amount cap', () => {
  assert.match(nativeScript, /iframe,frame/u);
  assert.match(nativeScript, /contentDocument \|\| frame\.contentWindow\?\.document/u);
  assert.match(nativeScript, /validatePaymentAmount/u);
  assert.match(nativeScript, /PURCHASE_AUTO_ORDER_AMOUNT_UNREADABLE/u);
  assert.match(nativeScript, /PURCHASE_AUTO_ORDER_MAX_PAYMENT_EXCEEDED/u);
  assert.match(nativeScript, /PURCHASE_AUTO_ORDER_SHIPPING_FEE_EXCEEDED/u);
  assert.match(nativeScript, /PURCHASE_AUTO_ORDER_SOURCE_PRICE_CHANGED/u);
  assert.match(nativeScript, /PURCHASE_AUTO_ORDER_PRESALE_SKIPPED/u);
  assert.match(nativeScript, /selectReceiverAddress/u);
  assert.match(nativeScript, /allowSimilarSku/u);
  assert.match(nativeScript, /existingOrderNumber/u);
  assert.match(nativeScript, /J-pwd-short/u);
  assert.match(nativeScript, /my-passcode-input-native-input/u);
  assert.match(nativeScript, /adm-input-element/u);
});

test('Taobao Tmall and 1688 require exact platform order readback after Alipay success', () => {
  assert.match(desktopController, /verifyNonPinduoduoAutoOrderReadback/u);
  assert.match(desktopController, /trade_order_detail\.htm\?biz_order_id=/u);
  assert.match(desktopController, /tradeStatus=all&page=1&pageSize=50/u);
  assert.match(desktopController, /PURCHASE_AUTO_ORDER_PAYMENT_READBACK_PENDING/u);
  assert.match(desktopController, /readbackVerified: true/u);
});

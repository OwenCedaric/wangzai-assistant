import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/PurchaseWaitPayScanScript.cs', import.meta.url), 'utf8');
const session = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/BrowserSession.cs', import.meta.url), 'utf8');
const controller = fs.readFileSync(new URL('./cefPurchaseBrowserController.js', import.meta.url), 'utf8');

test('wait-pay scanner covers PDD Taobao Tmall and 1688 structured order sources', () => {
  assert.match(script, /ordersStore\?\.initOdersList/u);
  assert.match(script, /data\?\.mainOrders/u);
  assert.match(script, /shopOrderContainer_/u);
  assert.match(script, /order-item, li\.order-item/u);
  assert.match(script, /shadowRoot/u);
});

test('native host and desktop controller expose the isolated wait-pay scan command', () => {
  assert.match(session, /case "purchase-wait-pay-scan"/u);
  assert.match(session, /ScanPurchaseWaitPayOrdersAsync/u);
  assert.match(controller, /scanPurchaseWaitPayOrders/u);
  assert.match(controller, /case 'scan-purchase-wait-pay-orders'/u);
});

test('wait-pay page reading is synchronous and retains PDD and Taobao amounts and identities', () => {
  const value = script.match(/public const string Value = """\r?\n([\s\S]*?)\r?\n"""/u)?.[1];
  assert.ok(value);
  const scan = session.slice(session.indexOf('private async Task<object> ScanPurchaseWaitPayOrdersAsync'), session.indexOf('private async Task<object> ExecutePurchaseAutoOrderAsync'));
  assert.match(scan, /EvaluateScriptAsync/u);
  assert.doesNotMatch(scan, /EvaluateScriptAsPromiseAsync/u);
  for (const [hostname, data, expected] of [
    ['mobile.yangkeduo.com', { rawData: { ordersStore: { initOdersList: { 1: [{ order_sn: 'PDD-12345678', display_amount: 12345, order_goods: [] }] } } } }, ['PDD-12345678', 123.45]],
    ['buyertrade.taobao.com', { data: { mainOrders: [{ id: 'TB-12345678', payInfo: { actualFee: '¥67.89' }, subOrders: [] }] } }, ['TB-12345678', 67.89]],
  ]) {
    const result = vm.runInNewContext(value, { ...data, location: { hostname, href: `https://${hostname}/` }, document: { querySelectorAll: () => [] } });
    assert.equal(typeof result, 'string', 'the native synchronous evaluator must receive JSON, not a Promise');
    const parsed = JSON.parse(result); assert.equal(parsed.ok, true);
    assert.equal(parsed.rows[0].orderNumber, expected[0]); assert.equal(parsed.rows[0].amount, expected[1]);
  }
});

test('payment login refresh synchronizes Electron cookies back into the exact native CEF account', () => {
  assert.match(session, /case "import-purchase-session-cookies"/u);
  assert.match(session, /ImportPurchaseSessionCookiesAsync/u);
  assert.match(session, /GetPurchaseLoginStatusAsync/u);
  assert.match(controller, /readPurchasePaymentLoginStatus/u);
  assert.match(controller, /case 'purchase-payment-login-status'/u);
  assert.match(controller, /import-purchase-session-cookies/u);
  const autoOrderStart = controller.indexOf('async function executePurchaseAutoOrder');
  const autoOrderEnd = controller.indexOf('async function scanPurchaseWaitPayOrders', autoOrderStart);
  assert.ok(autoOrderStart >= 0 && autoOrderEnd > autoOrderStart);
  assert.match(controller.slice(autoOrderStart, autoOrderEnd), /exportLoginCookies/u);
  assert.match(controller.slice(autoOrderStart, autoOrderEnd), /import-purchase-session-cookies/u);
});

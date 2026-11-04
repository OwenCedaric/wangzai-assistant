import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
const nativeRoot = path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost');
const readNative = (name) => fs.readFileSync(path.join(nativeRoot, name), 'utf8');

test('1688 order readback captures the authenticated MTOP response and parses real order fields', () => {
  const source = readNative('Alibaba1688OrderNetworkCapture.cs');
  assert.match(source, /mtop\.1688\.trading\.dataline\.service/u);
  assert.match(source, /Path\(outer, "data", "data", "result"\)/u);
  assert.match(source, /"sumPayment"/u);
  assert.match(source, /"newStepOrders"/u);
  assert.match(source, /"orderEntries"/u);
  assert.match(source, /"purchaseOrderNumber"/u);
  assert.match(source, /"purchasePrice"/u);
  assert.match(source, /"paymentConfirmed"/u);
  assert.match(source, /FindRefundSuccessStatus\(order, 0\)/u);
  assert.match(source, /TryFindExplicitRefundStatus\(text, out string refundStatus\)/u);
  assert.match(source, /1688-exact-detail-refund-response/u);
  assert.match(source, /\["purchaseOrderUrl"\] = capturePageUrl/u);
  assert.match(source, /A bare close\/cancel must remain non-refund and fail closed/u);
});

test('1688 order readback uses all frames first and a same-account exact order-list fallback', () => {
  const session = readNative('BrowserSession.cs');
  const host = readNative('BrowserHostForm.cs');
  const handler = readNative('FingerprintResourceRequestHandler.cs');
  assert.match(session, /GetAllFrames\(\)/u);
  assert.match(session, /InspectAlibaba1688OrderFramesAsync\(\)/u);
  assert.match(session, /CaptureAlibaba1688OrdersAsync\([\s\S]*ResolveAlibaba1688ExpectedOrderNumber/u);
  assert.match(session, /BuildOrderListUrl\(statusHint\)/u);
  assert.match(host, /ResolveAlibaba1688CaptureUrl\(requestedUrl\)/u);
  assert.match(host, /orderId\|order_id/u);
  assert.match(host, /new ChromiumWebBrowser\(url, requestContext\)/u);
  assert.match(host, /new InternalRequestHandler\(profile, extensions, capture\)/u);
  assert.match(handler, /GetResourceResponseFilter\(/u);
  assert.match(handler, /alibaba1688OrderCapture\?\.Accept\(/u);
});

test('manual payment and status commands allow the bounded 1688 response-capture window', () => {
  const controller = fs.readFileSync(
    path.join(desktopRoot, 'src', 'purchaseBrowser', 'cefPurchaseBrowserController.js'),
    'utf8',
  );
  assert.match(controller, /pagePlatform === '1688' \? 32_000 : 20_000/u);
  assert.match(controller, /\['read-payment-info', 'refresh-order-status', 'save-payment-info'\]\.includes\(command\)/u);
  assert.match(controller, /\? 45_000/u);
  assert.match(controller, /visibleOrderNumber \|\| \(boundPlatform === '1688' \? boundOrderNumber : ''\)/u);
});

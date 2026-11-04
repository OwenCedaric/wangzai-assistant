import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const nativeRoot = path.resolve(currentDirectory, '../../native/Wangzai.CefBrowserHost');

async function readNativeSource(fileName) {
  return readFile(path.join(nativeRoot, fileName), 'utf8');
}

test('1688 paid order read uses visible frame evidence to select an exact authenticated order-list capture', async () => {
  const parser = await readNativeSource('Alibaba1688OrderNetworkCapture.cs');
  const session = await readNativeSource('BrowserSession.cs');
  const host = await readNativeSource('BrowserHostForm.cs');

  assert.match(parser, /TryParseVisibleOrderText/u);
  assert.match(parser, /\(\?:订单号\|订单编号\)/u);
  assert.match(parser, /当前订单状态/u);
  assert.match(parser, /实付款/u);
  assert.match(parser, /paymentConfirmed/u);

  assert.match(session, /frame\.GetTextAsync\(\)/u);
  assert.match(session, /TryParseVisibleOrderText/u);
  assert.match(session, /ResolveAlibaba1688NetworkCaptureUrl\(frameEvidence\)/u);
  assert.match(session, /ResolveAlibaba1688ExpectedOrderNumber\(frameEvidence\)/u);
  assert.match(session, /BuildOrderListUrl\(statusHint\)/u);
  assert.match(session, /"waitsellersend"/u);
  assert.doesNotMatch(
    session.slice(session.indexOf('ResolveAlibaba1688NetworkCaptureUrl')),
    /new_step_order_detail\.htm\?orderId=/u,
  );
  assert.match(host, /string\? expectedOrderNumber = null/u);
  assert.match(parser, /result\["currentOrderNumber"\] = expectedOrderNumber/u);
  assert.match(session, /HasCompleteAlibabaOrderCandidate/u);
});

test('1688 visible text fallback does not use the Alipay transaction number as the order number', async () => {
  const parser = await readNativeSource('Alibaba1688OrderNetworkCapture.cs');
  const visibleFallback = parser.slice(parser.indexOf('TryParseVisibleOrderText'));

  assert.match(visibleFallback, /订单号\|订单编号/u);
  assert.doesNotMatch(visibleFallback.slice(0, visibleFallback.indexOf('VisibleOrderQuantity')), /交易号\|交易编号/u);
  assert.match(visibleFallback, /orderNumbers\.Length != 1/u);
});

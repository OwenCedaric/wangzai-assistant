import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
const source = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'PinduoduoOrderCaptureScript.cs'),
  'utf8',
);
const script = source.match(/public const string Value = """\r?\n([\s\S]*?)\r?\n""";/u)?.[1] || '';

function runCapture({ href, title = '拼多多', body = '', rawData = null, orderNodes = [] } = {}) {
  const url = new URL(href);
  const document = {
    title,
    body: { innerText: body },
    querySelectorAll: selector => selector === '[data-order-sn]' ? orderNodes : [],
  };
  const context = {
    Date,
    JSON,
    Number,
    Object,
    Set,
    String,
    URLSearchParams,
    document,
    location: {
      href: url.toString(),
      pathname: url.pathname,
      search: url.search,
    },
    window: {
      rawData,
      store: null,
      __NEXT_DATA__: null,
      __INITIAL_STATE__: null,
    },
  };
  return JSON.parse(vm.runInNewContext(script, context));
}

test('PDD checkout capture records the real amount but does not treat pending payment as complete', () => {
  const capture = runCapture({
    href: 'https://mobile.yangkeduo.com/goods.html?goods_id=98765',
    body: '商品名称：多层铁艺花架\n实付款：￥52.71\n立即支付\n数量 x1',
  });

  assert.equal(capture.platform, '拼多多');
  assert.equal(capture.sourceProductId, '98765');
  assert.equal(capture.purchasePrice, 52.71);
  assert.equal(capture.purchaseOrderStatus, '待付款');
  assert.equal(capture.paymentConfirmed, false);
  assert.equal(capture.purchaseOrderNumber, '');
});

test('PDD multi-order state only reads fields belonging to the URL order', () => {
  const result = runCapture({
    href: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-100001',
    body: '订单详情 实付款：19.90 待付款',
    rawData: { orders: [
      { orderSn: 'PDD-200002', payAmount: 19.9, orderStatusText: '待付款' },
      { orderSn: 'PDD-100001', payAmount: 52.71, orderStatusText: '待发货' },
    ] },
  });
  assert.equal(result.purchaseOrderNumber, 'PDD-100001');
  assert.equal(result.purchasePrice, 52.71);
  assert.equal(result.paymentConfirmed, true);
});

for (const [label, body, rawData] of [
  ['visible identity mismatch', '订单编号：PDD-200002 实付款：19.90 待发货', null],
  ['structured identity mismatch', '实付款：19.90 待发货', { orderInfo: { orderSn: 'PDD-200002', payAmount: 19.9, orderStatusText: '待发货' } }],
  ['multiple visible orders', '订单编号：PDD-100001 实付款：52.71 订单编号：PDD-200002 实付款：19.90 待发货', null],
]) {
  test(`PDD rejects ${label} without paid/refund side effects`, () => {
    const result = runCapture({ href: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-100001', body, rawData });
    assert.equal(result.purchaseOrderNumber, '');
    assert.equal(result.purchasePrice, null);
    assert.equal(result.paymentConfirmed, false);
    assert.equal(result.refundConfirmed, false);
    assert.equal(result.orderCaptureStatus, 'rejected');
  });
}

test('PDD a list without an explicit selected order is not a detail capture', () => {
  const result = runCapture({
    href: 'https://mobile.yangkeduo.com/orders.html', body: '我的订单',
    rawData: { orders: [{ orderSn: 'PDD-100001', payAmount: 52.71 }, { orderSn: 'PDD-200002', payAmount: 19.9 }] },
  });
  assert.equal(result.purchaseOrderNumber, '');
  assert.equal(result.purchasePrice, null);
});

test('PDD preserves a separator between quantity and the next numeric line', () => {
  const result = runCapture({ href: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-100001', body: '数量：2\n9.99\n待付款\n实付款：19.98' });
  assert.equal(result.quantity, '2');
  assert.equal(result.purchasePrice, 19.98);
});

test('PDD detects multiple attribute-only order identities before reading page money', () => {
  const result = runCapture({ href: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-100001', body: '实付款：19.90 待发货',
    orderNodes: ['PDD-100001', 'PDD-200002'].map(id => ({ getAttribute: name => name === 'data-order-sn' ? id : '', textContent: '' })) });
  assert.equal(result.purchaseOrderNumber, '');
  assert.equal(result.purchasePrice, null);
  assert.equal(result.paymentConfirmed, false);
});

test('PDD paid page capture returns order number, paid status and amount from real DOM/runtime shapes', () => {
  const capture = runCapture({
    href: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD20260810001',
    title: '支付成功',
    body: '支付成功\n订单状态：待发货\n实付款：￥52.71\n商品名称：多层铁艺花架\n数量：1\n隐藏模板残留：立即支付',
    rawData: { orderInfo: { orderSn: 'PDD20260810001', payAmount: 52.71, orderStatusText: '待发货' } },
  });

  assert.equal(capture.pageType, 'order-detail');
  assert.equal(capture.purchaseOrderNumber, 'PDD20260810001');
  assert.equal(capture.purchaseOrderStatus, '待发货');
  assert.equal(capture.purchasePrice, 52.71);
  assert.equal(capture.paymentConfirmed, true);
});

test('PDD paid order detail uses the real page title and paid actions when the body has no status label', () => {
  const capture = runCapture({
    href: 'https://mobile.yangkeduo.com/order.html?order_sn=260810-579034202431518',
    title: '待发货',
    body: '预计拼单成功后2天内发货\n多层铁艺花架客厅落地式可移动\n¥52.71 x1\n申请退款\n催发货\n实付：¥52.71\n订单号：260810-579034202431518',
  });

  assert.equal(capture.pageType, 'order-detail');
  assert.equal(capture.purchaseOrderNumber, '260810-579034202431518');
  assert.equal(capture.purchaseOrderStatus, '待发货');
  assert.equal(capture.purchasePrice, 52.71);
  assert.equal(capture.paymentConfirmed, true);
});

test('PDD refund result wins over stale paid runtime state for the exact order', () => {
  const capture = runCapture({
    href: 'https://mobile.yangkeduo.com/order.html?order_sn=260810-579034202431518',
    title: '极速退款成功',
    body: '极速退款成功\n订单号：260810-579034202431518\n实付：¥52.71',
    rawData: { orderInfo: { orderSn: '260810-579034202431518', payAmount: 52.71, orderStatusText: '待发货' } },
  });

  assert.equal(capture.pageType, 'order-detail');
  assert.equal(capture.purchaseOrderNumber, '260810-579034202431518');
  assert.equal(capture.purchaseOrderStatus, '极速退款成功');
  assert.equal(capture.refundConfirmed, true);
  assert.equal(capture.paymentConfirmed, false);
});

test('PDD refund success page is recognized without relying on the old paid status', () => {
  const capture = runCapture({
    href: 'https://mobile.yangkeduo.com/complaints_refund_success.html?order_sn=260810-579034202431518',
    title: '已退款',
    body: '已退款\n退款金额 ¥52.71\n订单号：260810-579034202431518',
  });

  assert.equal(capture.pageType, 'order-detail');
  assert.equal(capture.purchaseOrderStatus, '已退款');
  assert.equal(capture.refundConfirmed, true);
  assert.equal(capture.paymentConfirmed, false);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
const source = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'Alibaba1688OrderCaptureScript.cs'),
  'utf8',
);
const script = source.match(/public const string Value = """\r?\n([\s\S]*?)\r?\n""";/u)?.[1] || '';

function createElement({ text = '', directText = '', attributes = {}, matches = [] } = {}) {
  const node = {
    nodeType: 1,
    innerText: text,
    textContent: text,
    parentElement: null,
    childNodes: directText ? [{ nodeType: 3, textContent: directText }] : [],
    getClientRects() { return [1]; },
    getAttribute(name) { return attributes[name] || ''; },
    querySelectorAll(selector) {
      if (selector === 'a[href]') return matches.filter((item) => item.kind === 'link');
      return matches.filter((item) => item.kind === 'title');
    },
  };
  return node;
}

test('1688 native script reads the paid total and exact order card fields', () => {
  const productLink = createElement({
    text: '现代简约落地式铁艺花盆支架可移动拼装型多层室内外花盆收纳架',
    attributes: {
      href: 'https://detail.1688.com/offer/7788990011.html',
      title: '现代简约落地式铁艺花盆支架可移动拼装型多层室内外花盆收纳架',
    },
  });
  productLink.kind = 'title';
  const sourceLink = createElement({ attributes: { href: 'https://detail.1688.com/offer/7788990011.html' } });
  sourceLink.kind = 'link';
  const orderLink = createElement({ attributes: { href: 'https://trade.1688.com/order/order_detail.htm?orderId=3316316306834029783' } });
  orderLink.kind = 'link';
  const container = createElement({
    text: '订单号 3316316306834029783 下单时间 2026-08-10 20:48:43 现代简约落地式铁艺花盆支架 数量 1 待发货 总金额 ￥38.60 含运费0.10',
    matches: [productLink, sourceLink, orderLink],
  });
  const marker = createElement({ directText: '订单号 3316316306834029783' });
  marker.parentElement = container;
  const href = 'https://trade.1688.com/order/buyer_order_list.htm';
  const result = JSON.parse(vm.runInNewContext(script, {
    Date,
    JSON,
    Number,
    String,
    URL,
    URLSearchParams,
    location: { href },
    document: {
      title: '已买到的货品 - 1688',
      body: container,
      querySelectorAll: () => [marker],
    },
  }));

  assert.equal(result.platform, '1688');
  assert.equal(result.orderCandidates.length, 1);
  assert.equal(result.purchaseOrderNumber, '3316316306834029783');
  assert.equal(result.purchasePrice, 38.6);
  assert.equal(result.purchaseOrderStatus, '待发货');
  assert.equal(result.paymentConfirmed, true);
  assert.equal(result.sourceProductId, '7788990011');
});

test('1688 native script reads the real legacy buyer detail layout and calculates freight-inclusive payment', () => {
  const productTitle = '花架室内置物架铁艺多层带轮落地式绿萝花盆架家用客厅阳台花架';
  const productLink = createElement({
    text: productTitle,
    attributes: { href: 'https://detail.1688.com/offer/7788990011.html' },
  });
  productLink.kind = 'title';
  const sourceLink = createElement({ attributes: { href: 'https://detail.1688.com/offer/7788990011.html' } });
  sourceLink.kind = 'link';
  const container = createElement({
    text: [
      '当前订单状态：买家已付款，等待卖家发货',
      '订单号：3316316306834029783',
      '货品 单价（元） 数量 优惠（元） 货品状态',
      productTitle,
      '38.50 元/米 1 - 待发货',
      '运费 0.10',
    ].join(' '),
    matches: [productLink, sourceLink],
  });
  const marker = createElement({ directText: '订单号：3316316306834029783' });
  marker.parentElement = container;
  const href = 'https://trade.1688.com/order/order_detail.htm?orderId=3316316306834029783';
  const result = JSON.parse(vm.runInNewContext(script, {
    Date,
    JSON,
    Number,
    String,
    URL,
    URLSearchParams,
    location: { href },
    document: {
      title: '订单详情 - 1688',
      body: container,
      querySelectorAll: () => [marker],
    },
  }));

  assert.equal(result.orderCandidates.length, 1);
  assert.equal(result.purchaseOrderNumber, '3316316306834029783');
  assert.equal(result.purchaseOrderStatus, '买家已付款');
  assert.equal(result.paymentConfirmed, true);
  assert.equal(result.purchasePrice, 38.6);
  assert.equal(result.quantity, '1');
  assert.equal(result.productTitle, productTitle);
});

test('1688 native script prioritizes exact refunded item evidence over the trade closed header', () => {
  const productTitle = '花架室内置物架铁艺多层带轮落地式绿萝花盆架';
  const productLink = createElement({
    text: productTitle,
    attributes: { href: 'https://detail.1688.com/offer/7788990011.html' },
  });
  productLink.kind = 'title';
  const container = createElement({
    text: [
      '当前订单状态：交易关闭',
      '订单号：3316316306834029783',
      productTitle,
      '38.50 元/米 1 - 退款成功',
      '运费 0.10',
    ].join(' '),
    matches: [productLink],
  });
  const marker = createElement({ directText: '订单号：3316316306834029783' });
  marker.parentElement = container;
  const href = 'https://trade.1688.com/order/new_step_order_detail.htm?orderId=3316316306834029783';
  const result = JSON.parse(vm.runInNewContext(script, {
    Date,
    JSON,
    Number,
    String,
    URL,
    URLSearchParams,
    location: { href },
    document: {
      title: '订单详情 - 1688',
      body: container,
      querySelectorAll: () => [marker],
    },
  }));

  assert.equal(result.purchaseOrderNumber, '3316316306834029783');
  assert.equal(result.purchasePrice, 38.6);
  assert.equal(result.purchaseOrderStatus, '退款成功');
  assert.equal(result.refundConfirmed, true);
  assert.equal(result.paymentConfirmed, false);
});

test('1688 native script joins an exact detail page refund row outside the order summary container', () => {
  const summary = createElement({
    text: '当前订单状态：交易关闭 订单号：3316316306834029783 实付款 ￥38.60',
  });
  const marker = createElement({ directText: '订单号：3316316306834029783' });
  marker.parentElement = summary;
  const refundedLine = createElement({ directText: '退款成功' });
  const body = createElement({
    text: `${summary.textContent} 商品状态 退款成功`,
  });
  const href = 'https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=3316316306834029783';
  const result = JSON.parse(vm.runInNewContext(script, {
    Date,
    JSON,
    Number,
    String,
    URL,
    URLSearchParams,
    location: { href },
    document: {
      title: '订单详情 - 1688',
      body,
      querySelectorAll: () => [marker, refundedLine],
    },
  }));

  assert.equal(result.currentOrderNumber, '3316316306834029783');
  assert.equal(result.pageRefundStatus, '退款成功');
  assert.equal(result.purchaseOrderStatus, '退款成功');
  assert.equal(result.refundConfirmed, true);
});

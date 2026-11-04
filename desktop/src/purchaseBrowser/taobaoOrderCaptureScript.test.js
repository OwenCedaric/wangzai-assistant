import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/PurchaseCaptureScript.cs', import.meta.url), 'utf8');
const extractor = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/PurchaseProductPlatformExtractors.cs', import.meta.url), 'utf8');
const chunks = [...source.matchAll(/"""\r?\n([\s\S]*?)\r?\n"""/gu)].map(match => match[1]);
const platformScript = fs.readFileSync(new URL('./purchaseCaptureNumber.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ')
  + '\n' + extractor.match(/"""\r?\n([\s\S]*?)\r?\n"""/u)?.[1];
assert.equal(chunks.length, 2);
assert.ok(platformScript);
const script = `${chunks[0]}\n${platformScript}\n${chunks[1]}`;

async function capture({ query = 'biz_order_id=900000000000000001', body = '', title = '订单详情', pathname = '/trade/detail/trade_order_detail.htm', attributes = {} } = {}) {
  const location = new URL(`https://trade.taobao.com${pathname}?${query}`);
  const element = { textContent: attributes.text || '', getAttribute: name => attributes[name] ?? null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }) };
  const document = { title, body: { innerText: body }, images: [], documentElement: { outerHTML: '' },
    querySelector: () => null,
    querySelectorAll: selector => Object.keys(attributes).some(key => key !== 'text' && selector.includes(`[${key}]`)) ? [element] : [],
  };
  const context = { URL, URLSearchParams, location, document, Date, setTimeout, clearTimeout,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    fetch: async () => { throw new Error('UNIT_TEST_MUST_NOT_ACCESS_NETWORK'); } };
  context.window = context;
  return JSON.parse(await vm.runInNewContext(script, context, { timeout: 3000 }));
}

for (const key of ['biz_order_id', 'bizOrderId', 'orderId', 'order_id']) {
  test(`Taobao recognizes exact detail URL parameter ${key}`, async () => {
    const result = await capture({ query: `${key}=900000000000000001`, body: '买家已付款 实付款：83.42' });
    assert.equal(result.purchaseOrderNumber, '900000000000000001');
    assert.equal(result.amount, '83.42');
    assert.equal(result.paymentConfirmed, true);
  });
}

test('Taobao detail never falls back from a missing total to an item unit price', async () => {
  const result = await capture({ body: '订单编号：900000000000000001 买家已付款 数量：2 单价：9.99' });
  assert.equal(result.amount, '');
});

test('Taobao product-page price fallback is unchanged', async () => {
  const result = await capture({ query: 'id=12345678', pathname: '/item.htm', title: '商品详情', body: '单价：9.99' });
  assert.equal(result.amount, '9.99');
});

test('Taobao quantity cannot concatenate with the following price line', async () => {
  const result = await capture({ body: '数量：2\n9.99\n待付款\n实付款：19.98' });
  assert.equal(result.quantity, '2');
  assert.equal(result.amount, '19.98');
});

test('a missing image cannot resolve to the HTML order detail URL', async () => {
  const result = await capture({ body: '买家已付款 实付款：83.42' });
  assert.equal(result.imageUrl, '');
  assert.deepEqual(result.mainImages, []);
});

test('Taobao rejects a foreign visible order under an exact URL', async () => {
  const result = await capture({ body: '订单编号：900000000000000002 买家已付款 实付款：21.00' });
  assert.equal(result.purchaseOrderNumber, '');
  assert.equal(result.amount, '');
  assert.equal(result.paymentConfirmed, false);
  assert.equal(result.refundConfirmed, false);
});

test('Taobao recognizes attribute-only order identity and rejects attribute mismatch', async () => {
  const body = '买家已付款 实付款：83.42';
  const valid = await capture({ body, attributes: { 'data-order-id': '900000000000000001' } });
  assert.equal(valid.purchaseOrderNumber, '900000000000000001');
  const invalid = await capture({ body, attributes: { 'data-order-id': '900000000000000002' } });
  assert.equal(invalid.purchaseOrderNumber, '');
  assert.equal(invalid.paymentConfirmed, false);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../resources/browser-extensions/ozon-analytics-observer/content/ozon-analytics-observer.js'), 'utf8');
const key = '__WANGZAI_OZON_ANALYTICS_OBSERVER__';
const endpoint = 'https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3';
function page({ parent = null, origin = 'https://seller.ozon.ru', pathname = '/app/analytics', marker = 'root' } = {}) {
  class Xhr { addEventListener() {} open() {} send() {} setRequestHeader() {} }
  const window = { location: { href: origin + pathname, origin, pathname }, frames: [], setTimeout, clearTimeout,
    fetch: async () => new Response(JSON.stringify({ items: [{ sku: marker, title: marker, sale: 0 }], premium: { is_active: false } }), { status: 200, headers: { 'content-type': 'application/json' } }) };
  window.top = parent?.top || window; window.parent = parent || window;
  if (parent) parent.frames.push(window);
  vm.runInNewContext(source, { window, XMLHttpRequest: Xhr, Request, Response, Headers, URL, URLSearchParams,
    WeakMap, Map, Set, Date, JSON, Object, String, Number, Promise });
  return window;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function capture(window, headers = {}) { await window.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ offset: 0, limit: 1 }) }); await tick(); }

test('nested same-origin responses share one cursor, payload store and exact child classification', async () => {
  const root = page(), child = page({ parent: root, marker: 'child' });
  const nested = page({ parent: child, marker: 'nested', pathname: '/app/what-to-sell/ozon-bestsellers' });
  await capture(child); await capture(nested); await capture(root);
  const entries = root[key].read(0, 50, false).entries;
  assert.deepEqual(Array.from(entries, entry => entry.sequence), [1, 2, 3]);
  assert.equal(child[key].status().retainedPayloadCount, 0);
  assert.equal(nested[key].status().retainedPayloadCount, 0);
  assert.equal(root[key].status().retainedPayloadCount, 3);
  assert.equal(root[key].status().frameCapture.received, 2);
  assert.equal(root[key].normalize(0, 10).datasets[1].dataset, 'product-performance');
  assert.equal(root[key].normalize(0, 10).datasets[1].sourceFrameUrl, nested.location.href);
  for (const [index, marker] of ['child', 'nested', 'root'].entries()) {
    const result = JSON.parse(root[key].payload(index + 1, 0, 10000).chunk);
    assert.equal(result.items[0].sku, marker); assert.equal(result.items[0].sale, 0);
    assert.equal(result.premium.is_active, false);
  }
});

test('a foreign-origin or detached frame is not relayed into this page', async () => {
  const root = page(), foreign = page({ parent: root, origin: 'https://www.ozon.ru', marker: 'foreign' });
  const detached = page({ parent: root, marker: 'detached' }); root.frames = [foreign];
  await capture(foreign); await capture(detached);
  assert.equal(root[key].read(0, 50).entries.length, 0);
  assert.equal(foreign[key].status().queueLength, 1);
  assert.equal(detached[key].status().queueLength, 1);
  assert.equal(root[key].receiveFrameRecord({ location: root.location }, { recipe: { absoluteUrl: endpoint } }), null);
});

test('an explicit different company stays isolated instead of being assigned to the parent', async () => {
  const root = page(), child = page({ parent: root, marker: 'other-company' }); root.__companyId = 'company-a';
  await capture(child, { 'x-o3-company-id': 'company-b' });
  assert.equal(root[key].status().queueLength, 0);
  assert.equal(child[key].status().queueLength, 1);
  assert.equal(root[key].status().errors[0].code, 'OZON_DATA_FRAME_COMPANY_MISMATCH');
  assert.equal(root[key].status().frameCapture.scopeFailures, 1);
});

test('an explicit child company requires matching parent evidence', async () => {
  const root = page(), child = page({ parent: root });
  await capture(child, { 'x-o3-company-id': 'company-a' });
  assert.equal(root[key].status().frameCapture.scopeFailures, 1);
  assert.equal(root[key].status().queueLength, 0);
  const confirmed = page(), matching = page({ parent: confirmed }); confirmed.__companyId = 'company-a';
  await capture(matching, { 'x-o3-company-id': 'company-a' });
  assert.equal(confirmed[key].status().queueLength, 1);
  assert.equal(confirmed[key].status().frameCapture.scopeFailures, 0);
});

test('reinjection preserves an older live queue and never double-wraps fetch', async () => {
  const root = page(); await capture(root);
  const oldFetch = root.fetch, oldRuntime = root[key]; oldRuntime.version = '0.0.1';
  assert.doesNotThrow(() => vm.runInNewContext(source, { window: root }));
  assert.equal(root.fetch, oldFetch); assert.equal(root[key], oldRuntime);
  assert.equal(root[key].status().queueLength, 1);
});

test('the parent never retains the child response object by reference', () => {
  const root = page(), child = page({ parent: root });
  const payload = { items: [{ sku: 'isolation', amount: 12.5 }], premium: { is_active: false } };
  root[key].receiveFrameRecord(child, { recipe: { absoluteUrl: endpoint, method: 'POST', body: { kind: 'json', value: {} } }, status: 200, transport: 'fetch', payload });
  payload.items[0].amount = 999;
  assert.equal(root[key].read(0, 1).entries[0].payload.items[0].amount, 12.5);
});

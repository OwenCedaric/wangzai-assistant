import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionRoot = path.join(
  desktopRoot,
  'resources',
  'browser-extensions',
  'ozon-analytics-observer',
);

test('bundled Ozon observer is hidden, read-only and keeps legacy analytics surfaces observable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '2.6.16');
  assert.deepEqual(manifest.permissions, []);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://seller.ozon.ru/*',
    'https://www.ozon.ru/*',
    'https://ozon.ru/*',
  ]);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal('action' in manifest, false);
  assert.equal('options_page' in manifest, false);
  assert.match(source, /response\.clone\(\)\.json\(\)/u);
  assert.match(source, /what_to_sell/u);
  assert.match(source, /missing_items/u);
  assert.doesNotMatch(source, /Math\.random|isPremium|hasAccess|PREMIUM_PLUS|sessionStorage/iu);
  assert.doesNotMatch(source, /document\.(?:body|createElement|querySelector)/u);
  assert.match(source, /catalog/u);
  assert.match(source, /normalize/u);
  assert.match(source, /paginate/u);
  assert.match(source, /api\.seller\.ozon\.ru/u);
  assert.match(source, /get_seller_tree/u);
  assert.match(source, /gb\\\/price_segmentation/u);
  assert.match(source, /gb\\\/seller\\\/metrics/u);
  assert.match(source, /function payload\(/u);
  assert.match(source, /async function search\(/u);
  assert.match(source, /async function probe\(/u);
  assert.match(source, /function cancelPagination\(/u);
  assert.match(source, /PAGINATION_FETCH_TIMEOUT_MS = 20_000/u);
  assert.match(source, /fetchPaginatedPage/u);
  assert.match(source, /legacySurface/u);
});

test('bundled Ozon observer cancels an in-flight pagination without recording the late page', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  let releasePage;
  let notifyPageStarted;
  const pageStarted = new Promise((resolve) => { notifyPageStarted = resolve; });
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics', origin: 'https://seller.ozon.ru' },
    setTimeout,
    clearTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { offset: 0, limit: 2 };
      if (Number(body.offset) === 2) {
        notifyPageStarted();
        await new Promise((resolve) => { releasePage = resolve; });
      }
      return new Response(JSON.stringify({
        items: [
          { sku: Number(body.offset) + 1 },
          { sku: Number(body.offset) + 2 },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/exa-products-api/missing_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 2 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const pagination = runtime.paginate(first.sequence, 5, 250);
  await pageStarted;
  const cancellation = runtime.cancelPagination();
  releasePage();
  const result = await pagination;

  assert.equal(cancellation.cancelled, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.complete, false);
  assert.equal(result.stoppedSafely, false);
  assert.equal(result.pagesFetched, 0);
  assert.equal(runtime.read(first.sequence, 10, false).entries.length, 0);
});

test('bundled Ozon observer aborts a hanging pagination page and returns a typed bounded failure', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  let paginationAttempts = 0;
  const window = {
    AbortController,
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries', origin: 'https://seller.ozon.ru' },
    setTimeout: (callback, delay) => setTimeout(callback, Number(delay) >= 20_000 ? 0 : delay),
    clearTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { offset: 0, limit: 2 };
      if (Number(body.offset) > 0) {
        paginationAttempts += 1;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({
        items: [{ sku: 1 }, { sku: 2 }],
        total: 10,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
    Error,
  });

  await window.fetch('https://seller.ozon.ru/api/site/searchteam/Stats/queries/search/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 2 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const result = await runtime.paginate(first.sequence, 1, 250);

  assert.equal(paginationAttempts, 6);
  assert.equal(result.pagesFetched, 0);
  assert.equal(result.stopReason, 'network-error');
  assert.equal(result.failureCode, 'OZON_DATA_PAGINATION_FETCH_TIMEOUT');
  assert.equal(result.stoppedSafely, false);
});

test('bundled Ozon observer records a cloned real response without changing the page response', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
  }
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics' },
    fetch: async () => new Response(JSON.stringify({ items: [{ sku: 123, sales: 7 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    URL,
    WeakMap,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  const pageResponse = await window.fetch(
    'https://api.seller.ozon.ru/api/site/exa-products-api/missing_items',
    { method: 'POST' },
  );
  assert.deepEqual(await pageResponse.json(), { items: [{ sku: 123, sales: 7 }] });
  await Promise.resolve();
  const captured = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.read(0, 20, false);
  assert.equal(captured.entries.length, 1);
  assert.equal(captured.entries[0].endpoint, '/api/site/exa-products-api/missing_items');
  assert.equal(captured.entries[0].origin, 'https://api.seller.ozon.ru');
  assert.equal(captured.entries[0].quality, 'confirmed-data');
  assert.deepEqual(captured.entries[0].payload, { items: [{ sku: 123, sales: 7 }] });
  const catalog = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.catalog();
  assert.equal(catalog.endpointCount, 1);
  const normalized = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.normalize(0, 10);
  assert.equal(normalized.datasets[0].records[0].id, 123);
  assert.equal(normalized.datasets[0].records[0].sales, 7);
  assert.deepEqual(normalized.datasets[0].records[0].raw, { sku: 123, sales: 7 });
});

test('bundled Ozon observer preserves every returned missing-items business field with correct semantics', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const item = {
    productId: '6041234567',
    productName: 'платье женское',
    photo: 'https://ir.ozone.ru/product.jpg',
    brandName: 'Brand',
    category1Name: '服装',
    category2Name: '女装',
    category3Name: '连衣裙',
    gmvSum: 6479914.826,
    gmvGrowth: -30.43,
    totalItems: '1548',
    avgPrice: 4185.9914,
    adsDays: 269996.451,
    adqDays: '12',
  };
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell' },
    setTimeout,
    fetch: async () => new Response(JSON.stringify({ items: [item], total: 600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
    setTimeout,
  });

  await window.fetch('https://seller.ozon.ru/api/site/exa-products-api/missing_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filter: { product_name: '', price_segment: { from: 1, to: 30 } },
      limit: '10',
      offset: '0',
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [dataset] = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.normalize(0, 1).datasets;
  const [record] = dataset.records;
  assert.deepEqual(
    JSON.parse(JSON.stringify(dataset.requestBody.filter.price_segment)),
    { from: 1, to: 30 },
  );
  assert.equal(record.id, item.productId);
  assert.equal(record.sales, item.totalItems);
  assert.equal(record.productCount, null);
  assert.equal(record.category1, item.category1Name);
  assert.equal(record.category2, item.category2Name);
  assert.equal(record.category3, item.category3Name);
  assert.equal(record.averageDailyRevenue, item.adsDays);
  assert.equal(record.averageDailyUnits, item.adqDays);
  assert.equal(record.growth, item.gmvGrowth);
});

test('bundled Ozon observer flattens real charts by_sku productInfo and metric fields', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const actualPayload = {
    items: [{
      productInfo: {
        sku: '4146125120',
        name: 'Soft Toy',
        article: 'mz-26050109-135366',
        image: 'https://ir-20.ozonstatic.cn/product.jpg',
        currentPrice: 1999,
        ozonCardPrice: 1799,
        discountPercent: 10,
        rating: 4.8,
        reviewCount: 123,
      },
      metrics: { revenue: 1250.5, orderedUnits: 7 },
    }],
  };
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/graphs' },
    setTimeout,
    fetch: async () => new Response(JSON.stringify(actualPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
    setTimeout,
  });

  await window.fetch('https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/by_sku', {
    method: 'POST',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const normalized = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.normalize(0, 1);
  const [dataset] = normalized.datasets;
  const [record] = dataset.records;

  assert.equal(dataset.dataset, 'products');
  assert.equal(record.id, '4146125120');
  assert.equal(record.title, 'Soft Toy');
  assert.equal(record.article, 'mz-26050109-135366');
  assert.equal(record.imageUrl, 'https://ir-20.ozonstatic.cn/product.jpg');
  assert.equal(record.price, 1999);
  assert.equal(record.cardPrice, 1799);
  assert.equal(record.discount, 10);
  assert.equal(record.rating, 4.8);
  assert.equal(record.reviews, 123);
  assert.equal(record.sales, 7);
  assert.equal(record.orders, 7);
  assert.equal(record.revenue, 1250.5);
});

test('bundled Ozon observer retains a large raw response and exposes it losslessly in chunks', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const legacyField = 'данные'.repeat(190_000);
  const expectedPayload = {
    items: [{ sku: 987, sales: 12, legacyField }],
    total: 1000,
  };
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers' },
    setTimeout,
    fetch: async () => new Response(JSON.stringify(expectedPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://api.seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3', {
    method: 'POST',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const entry = runtime.read(0, 1, false).entries[0];
  assert.equal(entry.truncated, true);
  assert.equal(entry.payloadAvailable, true);
  assert.equal(entry.payloadComplete, false);

  let offset = 0;
  let serialized = '';
  while (true) {
    const part = runtime.payload(entry.sequence, offset, 200_000);
    serialized += part.chunk;
    offset = part.nextOffset;
    if (part.complete) break;
  }
  assert.deepEqual(JSON.parse(serialized), expectedPayload);
  const normalized = runtime.normalize(0, 1);
  assert.equal(normalized.datasets[0].recordCount, 1);
  assert.equal(normalized.datasets[0].records[0].raw.legacyField.length, legacyField.length);
});

test('bundled Ozon observer preserves the real legacy premium status response without fabrication', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const actualStatus = { premiumContentAvailable: false, current: 'NONE' };
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics' },
    fetch: async () => new Response(JSON.stringify(actualStatus), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://api.seller.ozon.ru/api/site/seller-analytics/premium/status');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const entry = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.read(0, 1, false).entries[0];
  assert.equal(entry.legacySurface, true);
  assert.equal(entry.classification, 'subscription-status');
  assert.deepEqual(entry.payload, actualStatus);
});

test('bundled Ozon observer safely paginates an observed analytics query', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { page: 1 };
      return new Response(JSON.stringify({ items: [{ sku: Number(body.page), sales: Number(body.page) * 10 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-o3-company-id': 'company-fixture' },
    body: JSON.stringify({ page: 1, limit: 1 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.read(0, 10, false).entries[0];
  assert.equal(first.request.pagination.kind, 'page');
  assert.equal(first.replaySafe, true);
  const paginated = await window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.paginate(first.sequence, 2, 250);
  assert.equal(paginated.pagesFetched, 2);
  assert.equal(paginated.recordsFetched, 2);
  assert.equal(paginated.totalRecordCount, 3);
  assert.equal(paginated.stopReason, 'max-pages-reached');
  assert.equal(paginated.failedPage, 0);
  assert.equal(paginated.retriesUsed, 0);
  assert.equal(paginated.resumeSourceSequence, paginated.capturedSequences.at(-1));
  assert.deepEqual(JSON.parse(JSON.stringify(paginated.integrity)), {
    uniquePayloads: true,
    uniqueCapturedSequences: true,
    pageValueCountMatchesAttempts: true,
  });
  const normalized = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.normalize(first.sequence, 10);
  assert.equal(JSON.stringify(normalized.datasets.map((dataset) => dataset.records[0].id)), '[2,3]');
});

test('bundled Ozon observer stops offset pagination when the server-reported total is reached', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const requestedOffsets = [];
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/market-bestsellers' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { offset: 0, limit: 2 };
      const offset = Number(body.offset) || 0;
      requestedOffsets.push(offset);
      return new Response(JSON.stringify({
        items: [{ sku: offset + 1 }, { sku: offset + 2 }],
        total: 6,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/exa-products-api/missing_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 2 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const paginated = await runtime.paginate(first.sequence, 5, 250);

  assert.deepEqual(requestedOffsets, [0, 2, 4]);
  assert.equal(paginated.pagesFetched, 2);
  assert.equal(paginated.totalRecordCount, 6);
  assert.equal(paginated.reportedTotalCount, 6);
  assert.equal(paginated.stopReason, 'reported-total-reached');
  assert.equal(paginated.stoppedSafely, true);
});

test('bundled Ozon observer conservatively expands a reported-total offset route without skipping rows', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const requests = [];
  const total = 250;
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { offset: 0, limit: 50 };
      const offset = Number(body.offset) || 0;
      const limit = Number(body.limit) || 50;
      const count = Math.max(0, Math.min(limit, total - offset));
      requests.push({ offset, limit, count });
      return new Response(JSON.stringify({
        items: Array.from({ length: count }, (_, index) => ({ query: `keyword-${offset + index + 1}` })),
        total,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/searchteam/Stats/queries/search/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 50 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const paginated = await runtime.paginate(first.sequence, 5, 250);

  assert.deepEqual(requests.map(({ offset, limit }) => ({ offset, limit })), [
    { offset: 0, limit: 50 },
    { offset: 50, limit: 50 },
    { offset: 100, limit: 50 },
    { offset: 150, limit: 50 },
    { offset: 200, limit: 50 },
  ]);
  assert.equal(paginated.pagesFetched, 4);
  assert.equal(paginated.recordsFetched, 200);
  assert.equal(paginated.totalRecordCount, total);
  assert.equal(paginated.reportedTotalCount, total);
  assert.equal(paginated.stopReason, 'reported-total-reached');
  assert.equal(paginated.complete, true);
});

test('bundled Ozon observer retries the same offset with the observed limit when expansion is rejected', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const requests = [];
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/market-bestsellers' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { offset: 0, limit: 10 };
      const offset = Number(body.offset) || 0;
      const limit = Number(body.limit) || 10;
      requests.push({ offset, limit });
      if (limit > 10) {
        return new Response(JSON.stringify({ error: 'unsupported limit' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        items: Array.from({ length: 10 }, (_, index) => ({ sku: offset + index + 1 })),
        total: 100,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/exa-products-api/missing_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 10 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const paginated = await runtime.paginate(first.sequence, 1, 100);

  assert.deepEqual(requests, [
    { offset: 0, limit: 10 },
    { offset: 10, limit: 50 },
    { offset: 10, limit: 10 },
  ]);
  assert.equal(paginated.pagesFetched, 1);
  assert.equal(paginated.recordsFetched, 10);
  assert.equal(paginated.failedPage, 0);
  assert.equal(paginated.stopReason, 'max-pages-reached');
  assert.equal(paginated.retriesUsed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(paginated.pageValues)), [10]);
});

test('bundled Ozon observer treats a confirmed empty object after successful pages as completed', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const requestedOffsets = [];
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { offset: 0, limit: 2 };
      const offset = Number(body.offset) || 0;
      requestedOffsets.push(offset);
      const payload = offset >= 4
        ? { items: [] }
        : { items: [{ sku: offset + 1 }, { sku: offset + 2 }] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/exa-products-api/missing_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 2 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const paginated = await runtime.paginate(first.sequence, 5, 100);

  assert.deepEqual(requestedOffsets, [0, 2, 4]);
  assert.equal(paginated.pagesFetched, 1);
  assert.equal(paginated.recordsFetched, 2);
  assert.equal(paginated.totalRecordCount, 4);
  assert.equal(paginated.failedPage, 0);
  assert.equal(paginated.stopReason, 'empty-page');
  assert.equal(paginated.complete, true);
  assert.equal(paginated.stoppedSafely, true);
});

test('bundled Ozon observer expands a limit-only read until the response becomes shorter than requested', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { limit: 2 };
      const count = Math.min(5, Number(body.limit) || 2);
      return new Response(JSON.stringify({ items: Array.from({ length: count }, (_, index) => ({ sku: index + 1 })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 2 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  assert.equal(first.request.pagination.kind, 'limit');
  const paginated = await runtime.paginate(first.sequence, 2, 250);
  assert.equal(paginated.pagesFetched, 2);
  assert.equal(paginated.recordsFetched, 5);
  assert.equal(paginated.totalRecordCount, 5);
  assert.equal(paginated.stopReason, 'short-page');
  assert.equal(JSON.stringify(paginated.pageValues), '[4,8]');
});

test('bundled Ozon observer reaches a large keyword limit exponentially and stops on the complete short response', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const requestedLimits = [];
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { limit: 50 };
      const limit = Number(body.limit) || 50;
      requestedLimits.push(limit);
      const count = Math.min(175, limit);
      return new Response(JSON.stringify({
        items: Array.from({ length: count }, (_, index) => ({ query: `keyword-${index + 1}` })),
        total: 175,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/searchteam/Stats/queries/search/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 50 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const paginated = await runtime.paginate(first.sequence, 10, 250);

  assert.deepEqual(requestedLimits, [50, 100, 175]);
  assert.equal(paginated.paginationKind, 'limit');
  assert.equal(paginated.pagesFetched, 2);
  assert.equal(paginated.recordsFetched, 175);
  assert.equal(paginated.totalRecordCount, 175);
  assert.equal(paginated.reportedTotalCount, 175);
  assert.equal(paginated.stopReason, 'reported-total-reached');
  assert.deepEqual(JSON.parse(JSON.stringify(paginated.pageValues)), [100, 175]);
});

test('bundled Ozon observer follows last_id cursor pagination used by drifting seller routes', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const requestedCursors = [];
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { last_id: '', limit: 2 };
      requestedCursors.push(body.last_id || '');
      const rows = body.last_id === 'cursor-2'
        ? [{ query: 'fifth' }]
        : [{ query: 'first' }, { query: 'second' }];
      const nextCursor = body.last_id === ''
        ? 'cursor-1'
        : body.last_id === 'cursor-1' ? 'cursor-2' : '';
      return new Response(JSON.stringify({ items: rows, next_cursor: nextCursor }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/searchteam/Stats/queries/search/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ last_id: '', limit: 2 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  assert.equal(first.request.pagination.kind, 'cursor');
  const paginated = await runtime.paginate(first.sequence, 5, 250);
  assert.deepEqual(requestedCursors, ['', 'cursor-1', 'cursor-2']);
  assert.equal(paginated.pagesFetched, 2);
  assert.equal(paginated.stopReason, 'short-page');
  assert.equal(paginated.complete, true);
});

test('bundled Ozon observer preserves successful pages and reports the exact failing page', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { offset: 0, limit: 2 };
      if (Number(body.offset) === 4) {
        return new Response('<html>temporary gateway error</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(JSON.stringify({
        items: [
          { sku: Number(body.offset) + 1 },
          { sku: Number(body.offset) + 2 },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/exa-products-api/missing_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 2 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const paginated = await runtime.paginate(first.sequence, 5, 250);
  assert.equal(paginated.pagesFetched, 1);
  assert.equal(paginated.recordsFetched, 2);
  assert.equal(paginated.totalRecordCount, 4);
  assert.equal(paginated.attemptedPages, 2);
  assert.equal(paginated.failedPage, 2);
  assert.equal(paginated.failedStatus, 502);
  assert.equal(paginated.stopReason, 'non-json-response');
  assert.equal(paginated.failureContentType, 'text/html');
  assert.equal(paginated.retriesUsed, 2);
  assert.equal(paginated.pageAttempts[1].attempts, 3);
  assert.equal(paginated.stoppedSafely, false);
  assert.equal(runtime.read(first.sequence, 10, false).entries.length, 1);
});

test('bundled Ozon observer retries a throttled page and keeps one successful page in the result', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  let offsetTwoAttempts = 0;
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { offset: 0, limit: 2 };
      if (Number(body.offset) === 2 && ++offsetTwoAttempts === 1) {
        return new Response(JSON.stringify({ error: 'rate-limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        items: [
          { sku: Number(body.offset) + 1 },
          { sku: Number(body.offset) + 2 },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/exa-products-api/missing_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 2 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const first = runtime.read(0, 1, false).entries[0];
  const paginated = await runtime.paginate(first.sequence, 1, 250);
  assert.equal(offsetTwoAttempts, 2);
  assert.equal(paginated.pagesFetched, 1);
  assert.equal(paginated.recordsFetched, 2);
  assert.equal(paginated.retriesUsed, 1);
  assert.equal(paginated.pageAttempts[0].attempts, 2);
  assert.equal(paginated.pageAttempts[0].status, 200);
  assert.equal(paginated.stoppedSafely, true);
});

test('bundled Ozon observer safely replays an observed keyword request with only the query changed', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const requests = [];
  const window = {
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries' },
    setTimeout,
    fetch: async (_url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : { text: '' };
      requests.push(body);
      return new Response(JSON.stringify({
        data: [{ query: body.text || 'initial', count: 123, customMetric: 456 }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://seller.ozon.ru/api/site/searchteam/Stats/queries/search/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '', limit: '50', offset: '0', period: 'days_7' }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const sourceEntry = runtime.read(0, 1, false).entries[0];
  const result = await runtime.search(sourceEntry.sequence, 'машинка на радиоуправлении');
  assert.equal(result.recordCount, 1);
  assert.equal(result.quality, 'confirmed-data');
  assert.equal(requests.at(-1).text, 'машинка на радиоуправлении');
  assert.equal(requests.at(-1).offset, 0);
  assert.equal(requests.at(-1).period, 'days_7');
  const captured = runtime.read(sourceEntry.sequence, 1, false).entries[0];
  assert.equal(captured.transport, 'search');
  assert.equal(captured.request.body.text, 'машинка на радиоуправлении');
  const normalized = runtime.normalize(sourceEntry.sequence, 1);
  assert.equal(normalized.datasets[0].records[0].title, 'машинка на радиоуправлении');
  assert.equal(normalized.datasets[0].records[0].raw.customMetric, 456);
});

test('bundled Ozon observer directly reads only an exact known Ozon analytics endpoint', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const requests = [];
  const window = {
    __companyId: 'company-42',
    location: { href: 'https://seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers', origin: 'https://seller.ozon.ru' },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({ items: [{ sku: 'known-1', orders: 8 }], total: 1000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  const runtime = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__;
  const result = await runtime.probe(
    '/api/site/seller-analytics/what_to_sell/data/v3',
    'POST',
    { limit: '50', offset: '0', filter: { period: 'monthly', categories: ['970988171'] } },
    'https://api.seller.ozon.ru',
    0,
  );
  assert.equal(result.status, 200);
  assert.equal(result.recordCount, 1);
  assert.equal(requests[0].url, 'https://api.seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3');
  assert.equal(requests[0].options.headers['x-o3-company-id'], 'company-42');
  assert.equal(JSON.parse(requests[0].options.body).filter.period, 'monthly');
  const captured = runtime.read(0, 1, false).entries[0];
  assert.equal(captured.transport, 'known-probe');
  assert.equal(captured.origin, 'https://api.seller.ozon.ru');
  const nativeBody = {
    limit: '50',
    offset: '0',
    filter: { period: 'monthly', categories: [], name: 'платье' },
  };
  const prepared = runtime.prepareProbe(
    '/api/site/seller-analytics/what_to_sell/data/v3',
    'POST',
    nativeBody,
    'https://api.seller.ozon.ru',
    0,
  );
  assert.equal(prepared.recipe.headers['x-o3-company-id'], 'company-42');
  assert.equal(JSON.stringify(prepared.recipe.body.value), JSON.stringify(nativeBody));
  const committed = runtime.commitProbe(
    '/api/site/seller-analytics/what_to_sell/data/v3',
    'POST',
    nativeBody,
    'https://api.seller.ozon.ru',
    0,
    200,
    { items: [{ sku: 'native-1', orders: 9 }], total: 1 },
  );
  assert.equal(committed.status, 200);
  assert.equal(committed.recordCount, 1);
  const nativeCapture = runtime.read(captured.sequence, 1, false).entries[0];
  assert.equal(nativeCapture.transport, 'native-probe');
  assert.equal(nativeCapture.payload.items[0].sku, 'native-1');
  await assert.rejects(
    runtime.probe('/api/site/products/update', 'POST', {}, 'https://seller.ozon.ru', 0),
    /OZON_DATA_PROBE_NOT_SAFE/u,
  );
});

test('bundled Ozon observer maps the Ozon products page into product-performance records', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'content', 'ozon-analytics-observer.js'),
    'utf8',
  );
  class FixtureXmlHttpRequest {
    addEventListener() {}
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const payload = {
    items: [{
      skuId: '778899',
      productName: 'RC Car',
      brandName: 'RC Pro',
      sellerName: 'Test Seller',
      vendorCode: 'RC-001',
      categoryName: 'Remote Control Toys',
      productFeature: 'sales-leader',
      searchResultPosition: 8,
      orderedAmount: 24500,
      salesDynamics: 12.4,
      orderedProductCount: 17,
      averagePurchasePrice: 1441.18,
      periodDays: 28,
      avgOrdersOnAccDays: 4.5,
      avgGmvOnAccDays: 6200.25,
      drr: 4.7,
      daysInPromo: 8,
      promoRevenueShare: 27.1,
      daysWithTrafarets: 4,
      qtyViewPdp: 1000,
      convToCartPdp: 8.8,
      sessionCountSearch: 4500,
      convToCartSearch: 3.2,
      convViewToOrder: 1.9,
      salesSchema: 'FBO',
      nullableRedemptionRate: 94.2,
      nullableCreateDate: '2026-06-30T00:00:00.000Z',
      attributes: [
        { key: '9454', value: 100 },
        { key: '9455', value: 200 },
        { key: '9456', value: 300 },
        { key: '4497', value: 1500 },
      ],
    }],
  };
  const window = {
    location: {
      href: 'https://seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers',
      pathname: '/app/analytics/what-to-sell/ozon-bestsellers',
    },
    setTimeout,
    fetch: async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: FixtureXmlHttpRequest,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    WeakMap,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Promise,
  });

  await window.fetch('https://api.seller.ozon.ru/api/site/seller-analytics/what_to_sell/get_platform_data', {
    method: 'POST',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [dataset] = window.__WANGZAI_OZON_ANALYTICS_OBSERVER__.normalize(0, 1).datasets;
  const [record] = dataset.records;

  assert.equal(dataset.dataset, 'product-performance');
  assert.equal(dataset.recordPath, '$.items');
  assert.equal(record.id, '778899');
  assert.equal(record.feature, 'sales-leader');
  assert.equal(record.searchPosition, 8);
  assert.equal(record.orderAmount, 24500);
  assert.equal(record.dynamics, 12.4);
  assert.equal(record.orderedProducts, 17);
  assert.equal(record.averagePurchasePrice, 1441.18);
  assert.equal(record.periodDays, 28);
  assert.equal(record.averageDailyUnits, 4.5);
  assert.equal(record.averageDailyRevenue, 6200.25);
  assert.equal(record.adSpendShare, 4.7);
  assert.equal(record.promoDays, 8);
  assert.equal(record.promoRevenueShare, 27.1);
  assert.equal(record.paidPromotionDays, 4);
  assert.equal(record.productCardViews, 1000);
  assert.equal(record.productCardToCartRate, 8.8);
  assert.equal(record.searchCatalogViews, 4500);
  assert.equal(record.searchCatalogToCartRate, 3.2);
  assert.equal(record.impressionToOrderRate, 1.9);
  assert.equal(record.fulfillmentModel, 'FBO');
  assert.equal(record.redemptionRate, 94.2);
  assert.equal(record.listedAt, '2026-06-30T00:00:00.000Z');
  assert.equal(record.raw.skuId, '778899');
  assert.equal(record.raw.attributes.length, 4);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  callExternalDataApi,
  createExternalDataApiDiagnostic,
  createExternalDataApiErrorPayload,
  normalizeExternalIntegrationBaseUrl,
  testExternalDataApiConnection,
} from './externalDataApiClient.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Seerfar connection test uses the free quota endpoint and Bearer auth', async () => {
  let captured;
  const result = await testExternalDataApiConnection(
    { integrationType: 'seerfar-open-api' },
    { baseUrl: 'api.seerfar.cn', apiKey: 'seerfar-secret' },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return jsonResponse({ code: 200, data: { remain: 9876 } });
      },
    },
  );
  assert.equal(captured.url, 'https://api.seerfar.cn/open-api/quota');
  assert.equal(captured.init.headers.Authorization, 'Bearer seerfar-secret');
  assert.equal(result.status, 'connected');
  assert.equal(result.metadata.quota.remain, 9876);
});

test('LinkFox connection test validates the key without a paid product query', async () => {
  let captured;
  const result = await testExternalDataApiConnection(
    { integrationType: 'linkfox-agent' },
    { baseUrl: 'https://tool-gateway.linkfox.com', apiKey: 'linkfox-secret' },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return jsonResponse({ errcode: 400, errmsg: 'shop id required' });
      },
    },
  );
  assert.equal(captured.url, 'https://tool-gateway.linkfox.com/seerfar/ozon/shopSearch');
  assert.equal(captured.init.headers.Authorization, 'linkfox-secret');
  assert.equal(captured.init.body, '{}');
  assert.equal(result.status, 'connected');
  assert.equal(result.metadata.validationOnly, true);
});

test('known providers reject a base URL outside their allowlist', () => {
  assert.throws(
    () => normalizeExternalIntegrationBaseUrl('seerfar-open-api', 'https://127.0.0.1:3000'),
    (error) => error?.code === 'EXTERNAL_INTEGRATION_HOST_NOT_ALLOWED',
  );
});

test('network failures preserve a safe Undici cause for retry and logging', async () => {
  const socketCause = Object.assign(new Error('socket closed by peer'), {
    code: 'ECONNRESET',
    syscall: 'read',
  });
  const fetchFailure = new TypeError('fetch failed');
  fetchFailure.cause = socketCause;
  let capturedError;

  await assert.rejects(
    callExternalDataApi(
      { integrationType: 'seerfar-open-api' },
      { baseUrl: 'https://api.seerfar.cn', apiKey: 'seerfar-secret' },
      {
        operation: 'seerfar-ozon-market-keyword-search',
        input: { page: { page: 2, pageSize: 100 }, keywords: ['платье'] },
      },
      { fetchImpl: async () => { throw fetchFailure; } },
    ),
    (error) => {
      capturedError = error;
      return error?.code === 'EXTERNAL_INTEGRATION_NETWORK_FAILED'
        && error?.provider === 'seerfar-open-api'
        && error?.causeCode === 'ECONNRESET'
        && error?.causeSyscall === 'read'
        && error?.message === '外部接口连接被重置（ECONNRESET）。';
    },
  );

  assert.deepEqual(createExternalDataApiDiagnostic(capturedError, {
    profileId: 'must-not-be-logged',
    operation: 'seerfar-ozon-market-keyword-search',
    input: {
      keywords: ['must-not-be-logged'],
      page: { page: 2 },
    },
  }), {
    code: 'EXTERNAL_INTEGRATION_NETWORK_FAILED',
    provider: 'seerfar-open-api',
    remoteStatus: null,
    causeCode: 'ECONNRESET',
    causeName: 'Error',
    causeSyscall: 'read',
    operation: 'seerfar-ozon-market-keyword-search',
    page: 2,
  });
  assert.deepEqual(createExternalDataApiErrorPayload(capturedError), {
    ok: false,
    error: {
      code: 'EXTERNAL_INTEGRATION_NETWORK_FAILED',
      message: '外部接口连接被重置（ECONNRESET）。',
      status: null,
      provider: 'seerfar-open-api',
      retryable: true,
      diagnostic: {
        causeCode: 'ECONNRESET',
        causeName: 'Error',
        causeSyscall: 'read',
      },
    },
  });
});

test('Seerfar market keyword search uses the official direct endpoint and adapts skill pagination', async () => {
  let captured;
  const result = await callExternalDataApi(
    { integrationType: 'seerfar-open-api' },
    { baseUrl: 'https://api.seerfar.cn', apiKey: 'seerfar-secret' },
    {
      operation: 'seerfar-ozon-market-keyword-search',
      input: {
        page: {
          page: 2,
          pageSize: 10,
          orders: [{ field: 'searchVolume', direction: 'desc' }],
        },
        keywords: ['машинка на радиоуправлении'],
        categories: ['17027488_17028981_95528'],
        matchType: 1,
        searchDate: '2026-04-01',
        searchVolume: { min: 1000 },
        sellers: { max: 50 },
        price: { min: 500, max: 3000 },
        uId: 'integration-user',
        memberId: 'integration-member',
      },
    },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return jsonResponse({ code: 200, msg: 'SUCCESS', data: { records: [], total: 0 } });
      },
    },
  );

  assert.equal(captured.url, 'https://api.seerfar.cn/open-api/market/search/ozon');
  assert.equal(captured.init.headers.Authorization, 'Bearer seerfar-secret');
  assert.deepEqual(JSON.parse(captured.init.body), {
    page: {
      pageNumber: 2,
      pageSize: 10,
      orders: [{ field: 'searchVolume', direction: 'DESC' }],
    },
    searchVolume: { min: 1000 },
    price: { min: 500, max: 3000 },
    sellers: { max: 50 },
    categories: ['17027488_17028981_95528'],
    keywords: ['машинка на радиоуправлении'],
    matchType: 1,
    searchDate: '2026-04-01',
    uId: 'integration-user',
    memberId: 'integration-member',
  });
  assert.equal(result.ok, true);
});

test('Seerfar market keyword search validates direct API limits before sending a paid request', async () => {
  let called = false;
  await assert.rejects(
    callExternalDataApi(
      { integrationType: 'seerfar-open-api' },
      { baseUrl: 'https://api.seerfar.cn', apiKey: 'seerfar-secret' },
      {
        operation: 'seerfar-ozon-market-keyword-search',
        input: { page: { page: 1, pageSize: 101 }, keywords: ['测试'] },
      },
      {
        fetchImpl: async () => {
          called = true;
          return jsonResponse({ code: 200 });
        },
      },
    ),
    (error) => error?.code === 'EXTERNAL_INTEGRATION_INPUT_INVALID',
  );
  assert.equal(called, false);
});

test('Seerfar keyword mining uses the official seed-keyword endpoint', async () => {
  let captured;
  const result = await callExternalDataApi(
    { integrationType: 'seerfar-open-api' },
    { baseUrl: 'https://api.seerfar.cn', apiKey: 'seerfar-secret' },
    {
      operation: 'seerfar-ozon-keyword-mining',
      input: {
        keyword: 'машинка на радиоуправлении',
        page: { page: 1, pageSize: 10 },
        matchType: 0,
        relevancy: { min: 1 },
      },
    },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return jsonResponse({ code: 200, msg: 'SUCCESS', data: { records: [], total: 0 } });
      },
    },
  );

  assert.equal(captured.url, 'https://api.seerfar.cn/open-api/keyword/mining/ozon');
  assert.equal(captured.init.headers.Authorization, 'Bearer seerfar-secret');
  assert.deepEqual(JSON.parse(captured.init.body), {
    keyword: 'машинка на радиоуправлении',
    page: {
      pageNumber: 1,
      pageSize: 10,
      orders: [{ field: 'relevancy', direction: 'DESC' }],
    },
    relevancy: { min: 1 },
    matchType: 0,
  });
  assert.equal(result.ok, true);
});

const seerfarDirectReadContracts = [
  {
    name: 'shop products',
    operation: 'ozon-shop-search',
    input: {
      id: 1275208,
      page: { page: 1, pageSize: 5, orders: [{ field: 'sales', direction: 'desc' }] },
    },
    path: '/open-api/shop/detail/search/ozon',
    expectedBody: {
      id: 1275208,
      page: { pageNumber: 1, pageSize: 5, orders: [{ field: 'sales', direction: 'DESC' }] },
    },
    responseData: { productCount: 143, products: [{ sku: 2107989735 }], hasNextPage: true },
  },
  {
    name: 'product detail',
    operation: 'seerfar-ozon-product-detail-search',
    input: { sku: '175924376' },
    path: '/open-api/product/detail/search/ozon',
    expectedBody: { sku: '175924376', dateRange: 'past_30_days' },
    responseData: { product: { sku: 175924376 }, salesTrendVOList: [] },
  },
  {
    name: 'category products',
    operation: 'seerfar-ozon-category-search',
    input: {
      categoryId: '15621032_15621049_115951147',
      fulfillment: 'FBO',
      page: { page: 2, pageSize: 5, orders: [{ field: 'revenue', direction: 'desc' }] },
    },
    path: '/open-api/category/detail/search/ozon',
    expectedBody: {
      page: { pageNumber: 2, pageSize: 5, orders: [{ field: 'revenue', direction: 'DESC' }] },
      categoryId: '15621032_15621049_115951147',
      fulfillment: 'FBO',
    },
    responseData: { id: '15621032_15621049_115951147', productList: [{ sku: 3067874110 }] },
  },
  {
    name: 'product report',
    operation: 'seerfar-ozon-product-report-search',
    input: {
      skus: ['175924376'],
      monthlySales: { min: 10 },
      page: { page: 1, pageSize: 5, orders: [{ field: 'revenue', direction: 'desc' }] },
    },
    path: '/open-api/productReport/search/ozon',
    expectedBody: {
      page: { pageNumber: 1, pageSize: 5, orders: [{ field: 'revenue', direction: 'DESC' }] },
      monthlySales: { min: 10 },
      skus: [175924376],
    },
    responseData: { records: [{ sku: 175924376 }], total: 1, timeInterval: {} },
  },
  {
    name: 'keyword back search',
    operation: 'seerfar-ozon-keyword-back-search',
    input: {
      skuIds: ['4380710124'],
      hasVariant: 0,
      type: ['0'],
      page: { page: 1, pageSize: 5, orders: [{ field: 'exposure', direction: 'desc' }] },
    },
    path: '/open-api/keyword/backSearch/ozon',
    expectedBody: {
      skuIds: [4380710124],
      hasVariant: 0,
      page: { pageNumber: 1, pageSize: 5, orders: [{ field: 'exposure', direction: 'DESC' }] },
      type: ['0'],
    },
    responseData: { records: [{ query: 'платье женское летнее' }], total: 397 },
  },
];

for (const contract of seerfarDirectReadContracts) {
  test(`Seerfar direct ${contract.name} uses the official path and request contract`, async () => {
    let captured;
    const result = await callExternalDataApi(
      { integrationType: 'seerfar-open-api' },
      { baseUrl: 'https://api.seerfar.cn', apiKey: 'seerfar-secret' },
      { operation: contract.operation, input: contract.input },
      {
        fetchImpl: async (url, init) => {
          captured = { url, init };
          return jsonResponse({ code: 200, msg: 'SUCCESS', data: contract.responseData });
        },
      },
    );

    assert.equal(captured.url, `https://api.seerfar.cn${contract.path}`);
    assert.equal(captured.init.headers.Authorization, 'Bearer seerfar-secret');
    assert.deepEqual(JSON.parse(captured.init.body), contract.expectedBody);
    assert.deepEqual(result.data.data, contract.responseData);
  });
}

test('Seerfar exhausted quota is reported as balance insufficient instead of invalid credentials', async () => {
  await assert.rejects(
    callExternalDataApi(
      { integrationType: 'seerfar-open-api' },
      { baseUrl: 'https://api.seerfar.cn', apiKey: 'seerfar-secret' },
      {
        operation: 'seerfar-ozon-market-keyword-search',
        input: { page: { page: 1, pageSize: 10 }, keywords: ['игрушечная машинка'] },
      },
      {
        fetchImpl: async () => jsonResponse({ code: 8000, msg: 'Api Key limit exhausted' }, 403),
      },
    ),
    (error) => error?.code === 'EXTERNAL_INTEGRATION_BALANCE_INSUFFICIENT'
      && error?.statusCode === 402
      && error?.remoteStatus === 403,
  );
});

test('LinkFox read adapter only permits built-in skill operations', async () => {
  let captured;
  const result = await callExternalDataApi(
    { integrationType: 'linkfox-agent' },
    { baseUrl: 'https://tool-gateway.linkfox.com', apiKey: 'linkfox-secret' },
    { operation: 'seerfar-ozon-shop-search', input: { id: 123 } },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return jsonResponse({ code: '200', products: [] });
      },
    },
  );
  assert.equal(captured.url, 'https://tool-gateway.linkfox.com/seerfar/ozon/shopSearch');
  assert.deepEqual(JSON.parse(captured.init.body), { id: 123 });
  assert.equal(result.ok, true);

  await assert.rejects(
    callExternalDataApi(
      { integrationType: 'linkfox-agent' },
      { baseUrl: 'https://tool-gateway.linkfox.com', apiKey: 'linkfox-secret' },
      { operation: 'arbitrary-path', input: {} },
      { fetchImpl: async () => jsonResponse({}) },
    ),
    (error) => error?.code === 'EXTERNAL_INTEGRATION_OPERATION_NOT_ALLOWED',
  );

  await assert.rejects(
    callExternalDataApi(
      { integrationType: 'linkfox-agent' },
      { baseUrl: 'https://tool-gateway.linkfox.com', apiKey: 'linkfox-secret' },
      { operation: 'seerfar-ozon-shop-search', input: { id: 123 } },
      { fetchImpl: async () => jsonResponse({ errcode: 400, errmsg: 'invalid shop id' }) },
    ),
    (error) => error?.code === 'EXTERNAL_INTEGRATION_REMOTE_FAILED'
      && error?.statusCode === 502
      && error.message === 'invalid shop id',
  );
});

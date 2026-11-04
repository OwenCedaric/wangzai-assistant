import assert from 'node:assert/strict';
import test from 'node:test';

import { executePerformanceWriteAction } from './performanceApiClient.js';

const CONFIRMATION_CODE = 'EXECUTE_OZON_PERFORMANCE_WRITE';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createWriteHarness({ writePath, writeMethod, writeResponse = { ok: true }, campaigns = [], products = [], searchProducts = [] }) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    const recordedRequest = { path: parsed.pathname, method, body };
    if (parsed.search) recordedRequest.query = Object.fromEntries(parsed.searchParams.entries());
    requests.push(recordedRequest);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'write-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === writePath && method === writeMethod) return jsonResponse(writeResponse);
    if (parsed.pathname === '/api/client/campaign' && method === 'GET') {
      return jsonResponse({ list: campaigns, total: campaigns.length });
    }
    if (/\/api\/client\/campaign\/[^/]+\/v2\/products$/u.test(parsed.pathname) && method === 'GET') {
      return jsonResponse({ list: products, total: products.length });
    }
    if (parsed.pathname === '/api/client/campaign/search_promo/v2/products' && method === 'POST') {
      return jsonResponse({ products: searchProducts, total: searchProducts.length });
    }
    return jsonResponse({ error: { message: `unexpected endpoint ${method} ${parsed.pathname}` } }, 404);
  };
  return { fetchImpl, requests };
}

async function executeRealWrite(action, payload, harness) {
  return executePerformanceWriteAction(
    {
      type: 'ozon-performance',
      values: {
        accountId: `write-${action}`,
        performanceClientId: 'performance-client',
        performanceClientSecret: 'performance-secret',
      },
      action,
      payload,
      confirmWrite: true,
      confirmationCode: CONFIRMATION_CODE,
      realWrite: true,
      dryRun: false,
    },
    {
      fetchImpl: harness.fetchImpl,
      writeReadbackDelaysMs: [0],
    },
  );
}

test('Performance dry-run always returns a preview instead of submitting a remote write', async () => {
  const result = await executePerformanceWriteAction({
    values: { accountId: 'preview-only' },
    action: 'toggleCampaign',
    payload: { campaignId: 'campaign-1', mode: 'activate' },
    confirmWrite: true,
    confirmationCode: CONFIRMATION_CODE,
    dryRun: true,
  });

  assert.equal(result.executed, false);
  assert.equal(result.preview, true);
  assert.match(result.safety.message, /仅返回预览/u);
});

test('Performance creates a current CPC product campaign and confirms the exact Ozon readback', async () => {
  const harness = createWriteHarness({
    writePath: '/api/client/campaign/cpc/v2/product',
    writeMethod: 'POST',
    writeResponse: { campaignId: 'campaign-new' },
    campaigns: [{
      id: 'campaign-new',
      title: '新品计划',
      state: 'CAMPAIGN_STATE_RUNNING',
      fromDate: '2026-08-24',
      toDate: '2026-09-24',
      placement: 'PLACEMENT_SEARCH_AND_CATEGORY',
      productAutopilotStrategy: 'MAX_CLICKS',
      weeklyBudget: '4000000000',
    }],
  });
  const result = await executeRealWrite('createCampaign', {
    createMode: 'productCpc',
    title: '新品计划',
    fromDate: '2026-08-24',
    toDate: '2026-09-24',
    placement: 'PLACEMENT_SEARCH_AND_CATEGORY',
    productAutopilotStrategy: 'MAX_CLICKS',
    weeklyBudgetRubles: 4000,
    campaignProductCount: 2,
  }, harness);

  assert.equal(result.executed, true);
  assert.equal(result.realWrite, true);
  assert.equal(result.readback.confirmed, true);
  assert.deepEqual(harness.requests[1], {
    path: '/api/client/campaign/cpc/v2/product',
    method: 'POST',
    body: {
      title: '新品计划',
      placement: 'PLACEMENT_SEARCH_AND_CATEGORY',
      productAutopilotStrategy: 'MAX_CLICKS',
      fromDate: '2026-08-24',
      toDate: '2026-09-24',
      weeklyBudget: '4000000000',
    },
  });
});

test('Performance edits only fields currently accepted by Ozon campaign PATCH', async () => {
  const harness = createWriteHarness({
    writePath: '/api/client/campaign/campaign-1',
    writeMethod: 'PATCH',
    campaigns: [{ id: 'campaign-1', title: '原计划', fromDate: '2026-08-25', toDate: '2026-09-30' }],
  });
  const result = await executeRealWrite('editCampaign', {
    campaignId: 'campaign-1',
    fromDate: '2026-08-25',
    toDate: '2026-09-30',
  }, harness);

  assert.equal(result.readback.confirmed, true);
  assert.deepEqual(harness.requests[1].body, { fromDate: '2026-08-25', toDate: '2026-09-30' });
});

test('Performance converts weekly budget rubles to Ozon micros and reads it back', async () => {
  const harness = createWriteHarness({
    writePath: '/api/client/campaign/campaign-1',
    writeMethod: 'PATCH',
    campaigns: [{ id: 'campaign-1', weeklyBudget: '2000000000' }],
  });
  const result = await executeRealWrite('updateBudget', {
    campaignId: 'campaign-1',
    budgetKind: 'weeklyBudget',
    budgetRubles: 2000,
    campaignProductCount: 1,
  }, harness);

  assert.equal(result.readback.confirmed, true);
  assert.deepEqual(harness.requests[1].body, { weeklyBudget: '2000000000' });
});

for (const operation of [
  { action: 'addProducts', method: 'POST' },
  { action: 'setProductBids', method: 'PUT' },
]) {
  test(`Performance ${operation.action} converts CPC rubles to micros and confirms product readback`, async () => {
    const harness = createWriteHarness({
      writePath: '/api/client/campaign/campaign-1/products',
      writeMethod: operation.method,
      campaigns: [{ id: 'campaign-1', title: '计划一' }],
      products: [{ sku: '10001', bid: '12500000' }],
    });
    const result = await executeRealWrite(operation.action, {
      campaignId: 'campaign-1',
      strategyCode: 'TARGET_BIDS',
      bids: [{ sku: '10001', bid: 12.5, targetCir: 15, topPosition: 'Топ-20' }],
    }, harness);

    assert.equal(result.readback.confirmed, true);
    assert.deepEqual(harness.requests[1].body, { bids: [{ sku: '10001', bid: '12500000' }] });
  });
}

test('Performance removes campaign products with the official sku array field', async () => {
  const harness = createWriteHarness({
    writePath: '/api/client/campaign/campaign-1/products/delete',
    writeMethod: 'POST',
    campaigns: [{ id: 'campaign-1', title: '计划一' }],
    products: [],
  });
  const result = await executeRealWrite('removeProducts', {
    campaignId: 'campaign-1',
    skus: ['10001', '10002'],
  }, harness);

  assert.equal(result.readback.confirmed, true);
  assert.deepEqual(harness.requests[1].body, { sku: ['10001', '10002'] });
});

test('Performance writes pay-per-order bids as percentages without CPC micros conversion', async () => {
  const harness = createWriteHarness({
    writePath: '/api/client/campaign/search_promo/v2/bids/set',
    writeMethod: 'POST',
    searchProducts: [{ sku: '10001', bid: 15 }],
  });
  const result = await executeRealWrite('setSearchPromoBids', {
    bids: [{ sku: '10001', bid: 15, targetCir: 20, topPosition: 'Топ-4' }],
  }, harness);

  assert.equal(result.readback.confirmed, true);
  assert.deepEqual(harness.requests[1].body, { bids: [{ sku: '10001', bid: 15 }] });
});

test('Performance deletes pay-per-order bids with the official singular sku field', async () => {
  const harness = createWriteHarness({
    writePath: '/api/client/campaign/search_promo/v2/bids/delete',
    writeMethod: 'POST',
    searchProducts: [{ sku: '10001', bid: null }],
  });
  const result = await executeRealWrite('deleteSearchPromoBids', { skus: ['10001'] }, harness);

  assert.equal(result.readback.confirmed, true);
  assert.deepEqual(harness.requests[1].body, { sku: ['10001'] });
});

test('Performance enables and disables pay-per-order products through Ozon and confirms their state', async () => {
  for (const mode of ['enable', 'disable']) {
    const enabled = mode === 'enable';
    const harness = createWriteHarness({
      writePath: `/api/client/search_promo/product/${mode}`,
      writeMethod: 'POST',
      searchProducts: [{ sku: '10001', enabled }],
    });
    const result = await executeRealWrite('toggleSearchPromoProduct', { skus: ['10001'], mode }, harness);
    assert.equal(result.readback.confirmed, true);
    assert.deepEqual(harness.requests[1].body, { skus: ['10001'] });
  }
});

test('Performance activates and pauses campaigns through their official Ozon endpoints', async () => {
  for (const mode of ['activate', 'deactivate']) {
    const harness = createWriteHarness({
      writePath: `/api/client/campaign/campaign-1/${mode}`,
      writeMethod: 'POST',
      campaigns: [{
        id: 'campaign-1',
        state: mode === 'activate' ? 'CAMPAIGN_STATE_RUNNING' : 'CAMPAIGN_STATE_STOPPED',
      }],
    });
    const result = await executeRealWrite('toggleCampaign', { campaignId: 'campaign-1', mode }, harness);
    assert.equal(result.readback.confirmed, true);
    assert.equal(harness.requests[1].body, undefined);
  }
});

test('Performance controls all-SKU pay-per-order promotion through official Ozon endpoints', async () => {
  for (const mode of ['activate', 'deactivate']) {
    const harness = createWriteHarness({
      writePath: `/api/client/campaign/all_sku_promo/${mode}`,
      writeMethod: 'GET',
      writeResponse: mode === 'activate' ? { selectedBid: 5 } : {},
    });
    const result = await executeRealWrite('toggleAllSkuPromo', { mode }, harness);
    assert.equal(result.readback.confirmed, true);
    assert.equal(result.readback.confirmationSource, 'ozon-write-response');
  }

  const bidHarness = createWriteHarness({
    writePath: '/api/client/campaign/all_sku_promo/set_bid',
    writeMethod: 'GET',
    writeResponse: { selectedBid: 7 },
  });
  const bidResult = await executeRealWrite('setAllSkuPromoBid', { bid: 7 }, bidHarness);
  assert.equal(bidResult.readback.confirmed, true);
  assert.deepEqual(bidHarness.requests[1].query, { bid: '7' });
});

test('Performance enables and disables Морковск products with the official skus body', async () => {
  for (const mode of ['enable', 'disable']) {
    const harness = createWriteHarness({
      writePath: `/api/client/campaign/search_promo/carrots/${mode}`,
      writeMethod: 'POST',
      writeResponse: { skuToInfo: { 10001: { isDisabled: mode === 'disable' } } },
    });
    const result = await executeRealWrite('toggleCarrots', { mode, skus: ['10001'] }, harness);
    assert.equal(result.readback.confirmed, true);
    assert.deepEqual(harness.requests[1].body, { skus: ['10001'] });
  }
});

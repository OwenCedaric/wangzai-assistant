import assert from 'node:assert/strict';
import test from 'node:test';

import { readPerformanceRealtimeOverview } from './performanceApiClient.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Performance promotion orders reads the complete official order report and preserves raw fields', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({ path: parsed.pathname, method: String(init.method || 'GET').toUpperCase() });
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'orders-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/statistic/orders/generate/json') {
      return jsonResponse({ UUID: 'orders-report-1' });
    }
    if (parsed.pathname === '/api/client/statistics/orders-report-1') {
      return jsonResponse({ state: 'OK', link: '/api/client/statistics/orders-report-1/result' });
    }
    if (parsed.pathname === '/api/client/statistics/orders-report-1/result') {
      return jsonResponse({
        rows: [
          {
            order_id: 'posting-001',
            order_date: '2026-07-05T10:11:12Z',
            campaign_id: '30496576',
            campaign_name: '按订单付费计划',
            sku: '10001',
            offer_id: 'WZ-10001',
            product_name: '测试商品一',
            quantity: '2',
            orders_money: '3.008,00',
            money_spent: '902,40 RUB',
            future_remote_field: 'must-be-preserved',
          },
          {
            postingNumber: 'posting-002',
            createdAt: '2026-07-06T08:00:00Z',
            advCampaignId: '30496577',
            campaignTitle: '第二个推广计划',
            title: '测试商品二',
            ozonSku: '10002',
            vendorCode: 'WZ-10002',
            productTitle: '测试商品二',
            count: 1,
            revenue: 500,
            expense: 75,
          },
        ],
      });
    }
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const result = await readPerformanceRealtimeOverview(
    {
      values: {
        accountId: 'orders-account',
        performanceClientId: 'orders-client',
        performanceClientSecret: 'orders-secret',
        dateFrom: '2026-07-01',
        dateTo: '2026-07-31',
        readDepth: 'orders',
      },
    },
    { fetchImpl },
  );

  assert.equal(result.ok, true);
  assert.equal(result.source, 'ozon-performance-realtime');
  assert.equal(result.total, 2);
  assert.equal(result.summary.orderCount, 2);
  assert.equal(result.summary.itemQuantity, 3);
  assert.equal(result.summary.revenue, 3508);
  assert.equal(result.summary.spent, 977.4);
  assert.equal(result.rows[0].orderId, 'posting-001');
  assert.equal(result.rows[0].campaignId, '30496576');
  assert.equal(result.rows[0].offerId, 'WZ-10001');
  assert.equal(result.rows[0].productTitle, '测试商品一');
  assert.equal(result.rows[0].quantity, 2);
  assert.equal(result.rows[0].revenue, 3008);
  assert.equal(result.rows[0].spent, 902.4);
  assert.equal(result.rows[0].raw.future_remote_field, 'must-be-preserved');
  assert.equal(result.rows[1].orderId, 'posting-002');
  assert.equal(result.rows[1].campaignId, '30496577');
  assert.equal(result.rows[1].campaignTitle, '第二个推广计划');
  assert.equal(result.rows[1].productTitle, '测试商品二');
  assert.deepEqual(requests, [
    { path: '/api/client/token', method: 'POST' },
    { path: '/api/client/statistic/orders/generate/json', method: 'POST' },
    { path: '/api/client/statistics/orders-report-1', method: 'GET' },
    { path: '/api/client/statistics/orders-report-1/result', method: 'GET' },
  ]);
});

test('Performance overview reads complete synchronous datasets and preserves every raw field', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    requests.push({ path: parsed.pathname, method, query: parsed.searchParams.toString(), body: init.body || '' });

    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [
          {
            id: '11',
            title: '测试计划',
            state: 'CAMPAIGN_STATE_RUNNING',
            advObjectType: 'SKU',
            PaymentType: 'CPC',
            budgetType: 'WEEKLY',
            weeklyBudget: '100000000',
            ProductAdvPlacements: ['PLACEMENT_SEARCH_AND_CATEGORY'],
            autoIncrease: true,
            autopilot: false,
            autostopStatus: 'ACTIVE',
            expenseStrategy: 'MAX_CLICKS',
            isAutocreated: false,
            productCampaignMode: 'PRODUCT_CAMPAIGN_MODE_AUTO',
          },
        ],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/campaign/11/v2/products') {
      return jsonResponse({ list: [{ sku: '1001', bid: 12, title: '测试商品', extraProductField: '保留' }], total: 1 });
    }
    if (parsed.pathname === '/api/client/campaign/11/objects') {
      return jsonResponse({ list: [{ id: 'object-1', sku: '1001', status: 'APPROVED', extraObjectField: 7 }] });
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') {
      return jsonResponse([
        {
          id: '11',
          title: '测试计划',
          date: '2026-08-12',
          views: 10,
          clicks: 2,
          moneySpent: 12.5,
          orders: 1,
          ordersMoney: 30,
          extraDailyField: '保留',
        },
      ]);
    }
    if (parsed.pathname === '/api/client/statistics/campaign/product/json') {
      return jsonResponse([
        {
          id: '11',
          title: '测试计划',
          objectType: 'SKU',
          status: 'CAMPAIGN_STATE_RUNNING',
          placement: 'PLACEMENT_SEARCH_AND_CATEGORY',
          weeklyBudget: 100,
          clickPrice: 2,
          toCart: 4,
          views: 10,
          clicks: 2,
          moneySpent: 12.5,
          orders: 1,
          ordersMoney: 30,
          extraCampaignStatisticField: '保留',
        },
      ]);
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        campaignIds: ['11'],
        dateFrom: '2026-08-11',
        dateTo: '2026-08-12',
      });
      return jsonResponse([
        {
          campaignId: '11',
          sku: '1001',
          date: '2026-08-12',
          avgCpc: 6.25,
          clicks: 2,
          ctr: 20,
          drr: 41.67,
          expense: 12.5,
          modelOrders: 1,
          modelSales: 30,
          orders: 1,
          price: 35,
          sales: 30,
          toCart: 4,
          views: 10,
          extraSkuStatisticField: '保留',
        },
      ]);
    }
    if (parsed.pathname === '/api/client/statistics/expense/json') {
      return jsonResponse([
        {
          id: '11',
          title: '测试计划',
          date: '2026-08-12',
          moneySpent: 12.5,
          bonusSpent: 2.5,
          prepaymentSpent: 10,
          extraExpenseField: '保留',
        },
      ]);
    }
    if (parsed.pathname === '/api/client/statistics/campaign/media/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/list') return jsonResponse({ list: [] });
    if (parsed.pathname === '/api/client/statistics/externallist') return jsonResponse({ list: [] });
    if (parsed.pathname === '/api/client/campaign/available') return jsonResponse({ modes: ['SKU', 'MEDIA'] });
    if (parsed.pathname === '/api/client/limits/list') {
      return jsonResponse({ limits: [{ objectType: 'SKU', minBid: 1, maxBid: 100, step: 0.1 }] });
    }
    if (parsed.pathname === '/api/client/products_with_bonuses') return jsonResponse({ skus: ['1001'] });
    if (parsed.pathname === '/api/client/organisation/vendor_tag') return jsonResponse({ tag: 'test-vendor' });

    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      type: 'ozon-performance',
      values: {
        performanceClientId: 'client-id',
        performanceClientSecret: 'client-secret',
        dateFrom: '2026-08-06',
        dateTo: '2026-08-12',
        readDepth: 'full',
      },
    },
    { fetchImpl, now: new Date('2026-08-12T08:00:00.000Z') },
  );

  assert.equal(overview.ok, true);
  assert.equal(overview.readDepth, 'full');
  assert.equal(overview.summary.total, 1);
  assert.equal(overview.summary.spent, 12.5);
  assert.equal(overview.campaigns[0].paymentType, 'CPC');
  assert.equal(overview.campaigns[0].budgetType, 'WEEKLY');
  assert.equal(overview.campaigns[0].weeklyBudget, 100);
  assert.equal(overview.campaigns[0].budgetRemaining, 87.5);
  assert.equal(overview.campaigns[0].budgetRemainingSource, 'calculated');
  assert.equal(overview.campaigns[0].budgetStatus, '预算正常');
  assert.deepEqual(overview.campaigns[0].budgetRemainingPeriod, {
    kind: 'weekly',
    dateFrom: '2026-08-10',
    dateTo: '2026-08-12',
    budget: 100,
    spent: 12.5,
  });
  assert.deepEqual(overview.campaigns[0].productAdvPlacements, ['PLACEMENT_SEARCH_AND_CATEGORY']);
  assert.equal(overview.productStats[0].sku, '1001');
  assert.equal(overview.productStats[0].modelSales, 30);
  assert.equal(overview.campaignProductStats[0].clickPrice, 2);
  assert.equal(overview.expenseStats[0].bonusSpent, 2.5);
  assert.equal(overview.expenseStats[0].prepaymentSpent, 10);

  assert.equal(overview.dataSets.campaigns.rows[0].PaymentType, 'CPC');
  assert.equal(overview.dataSets.campaignProducts.rows[0].extraProductField, '保留');
  assert.equal(overview.dataSets.campaignObjects.rows[0].extraObjectField, 7);
  assert.equal(overview.dataSets.dailyStatistics.rows[0].extraDailyField, '保留');
  assert.equal(
    overview.dataSets.campaignProductStatistics.rows[0].extraCampaignStatisticField,
    '保留',
  );
  assert.equal(overview.dataSets.productSkuStatistics.rows[0].extraSkuStatisticField, '保留');
  assert.match(overview.dataSets.productSkuStatistics.note, /2026-08-11 至 2026-08-12/u);
  assert.equal(overview.dataSets.expenseStatistics.rows[0].extraExpenseField, '保留');
  assert.deepEqual(overview.dataSets.availableModes.rows.map((row) => row.value), ['SKU', 'MEDIA']);
  assert.equal(overview.dataSets.limits.rows[0].minBid, 1);
  assert.equal(overview.dataSets.bonusProducts.rows[0].value, '1001');
  assert.equal(overview.dataSets.vendorTag.rows[0].tag, 'test-vendor');
  assert.equal(overview.dataCatalog.length, 17);
  assert.equal(overview.dataSets.campaignBidInsights.status, 'skipped');

  assert.equal(
    requests.some((request) => request.path === '/api/client/statistics/expense'),
    false,
    'JSON 花费接口成功后不应再误读 CSV 路径',
  );
  assert.equal(
    requests.some((request) => request.path === '/api/client/statistics/campaign/media/json'),
    true,
  );
  const expenseRequest = requests.find((request) => request.path === '/api/client/statistics/expense/json');
  assert.match(expenseRequest.query, /campaignIds=11/u);
  assert.doesNotMatch(expenseRequest.query, /campaigns=/u);
});

test('Performance detail enriches objects and search bids with exact campaign product data', async () => {
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'detail-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [{ id: '901', title: '精确计划', state: 'CAMPAIGN_STATE_INACTIVE', advObjectType: 'SKU' }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/campaign/901/v2/products') {
      return jsonResponse({ list: [{ sku: 'sku-901', bid: 9, title: '精确商品' }], total: 1 });
    }
    if (parsed.pathname === '/api/client/campaign/901/objects') {
      return jsonResponse({ list: [{ id: 'sku-901' }] });
    }
    if (parsed.pathname === '/api/client/search_promo/bids/recommendation') {
      assert.equal(String(init.method || 'GET').toUpperCase(), 'POST');
      return jsonResponse({ recommendedBids: { 'sku-901': 11 } });
    }
    if (parsed.pathname === '/api/client/campaign/901/products/bids/competitive') {
      return jsonResponse({ list: [{ sku: 'sku-901', bid: 13 }] });
    }
    if (parsed.pathname === '/api/client/search_promo/get_cpo_min_bids') {
      return jsonResponse({ list: [{ sku: 'sku-901', minBid: 8 }] });
    }
    if (parsed.pathname === '/api/client/min/sku') {
      assert.deepEqual(JSON.parse(init.body), {
        marketplaceId: 'RU',
        paymentType: 'CPC',
        sku: ['sku-901'],
      });
      return jsonResponse({ minBids: [{ sku: 'sku-901', bid: 6.5 }] });
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') {
      return jsonResponse([{ id: '901', date: '2026-08-13', views: 100, clicks: 10, moneySpent: 25, orders: 2, ordersMoney: 125 }]);
    }
    if (parsed.pathname === '/api/client/statistics/campaign/product/json') {
      return jsonResponse([{ campaignId: '901', sku: 'sku-901', status: 'CAMPAIGN_STATE_INACTIVE', date: '2026-08-13', views: 100, clicks: 10, moneySpent: 25, orders: 2, ordersMoney: 125 }]);
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/expense/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/media/json') return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'detail-client',
        performanceClientSecret: 'detail-secret',
        campaignId: '901',
        dateFrom: '2026-08-13',
        dateTo: '2026-08-13',
        readDepth: 'detail',
        includeCampaignObjects: true,
        includeBidInsights: true,
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  const product = overview.campaigns[0].products[0];
  const object = overview.campaigns[0].objects[0];
  assert.equal(product.statusLabel, '已暂停');
  assert.equal(product.recommendedBid, 11);
  assert.equal(product.competitiveBid, 13);
  assert.equal(product.minCpoBid, 8);
  assert.equal(product.minimumCpcBid, 6.5);
  assert.equal(product.bidAvailability.recommended.status, 'returned');
  assert.equal(product.bidAvailability.competitive.status, 'returned');
  assert.equal(product.bidAvailability.minCpo.status, 'returned');
  assert.equal(product.bidAvailability.minimumCpc.status, 'returned');
  assert.equal(object.sku, 'sku-901');
  assert.equal(object.title, '精确商品');
  assert.equal(object.statusLabel, '已暂停');
  assert.equal(object.statusSource, 'product-statistics');
  assert.equal(object.impressions, 100);
  assert.equal(object.clicks, 10);
  assert.equal(object.spent, 25);
  assert.equal(object.orders, 2);
  assert.equal(object.revenue, 125);
  assert.equal(object.reviewReasonState, 'empty');
  assert.equal(overview.dataSets.campaignBidInsights.status, 'success');
  assert.equal(overview.dataSets.campaignBidInsights.rows[0].minimumCpcBid, 6.5);
  assert.equal(overview.detailRead, undefined);
  assert.equal(overview.campaigns[0].detailRead.bidInsights, true);
});

test('Performance detail keeps one missing official bid source explicit and never reuses a stale product value', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'partial-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [{ id: '902', title: '缺失来源计划', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/campaign/902/v2/products') {
      return jsonResponse({
        list: [{ sku: 'sku-902', bid: 9, title: '缺失来源商品', minimumCpcBid: 99 }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/campaign/902/objects') {
      return jsonResponse({ list: [{ id: 'sku-902' }] });
    }
    if (parsed.pathname === '/api/client/search_promo/bids/recommendation') {
      return jsonResponse({ recommendedBids: { 'sku-902': 11 } });
    }
    if (parsed.pathname === '/api/client/campaign/902/products/bids/competitive') {
      return jsonResponse({ list: [{ sku: 'sku-902', bid: 13 }] });
    }
    if (parsed.pathname === '/api/client/search_promo/get_cpo_min_bids') {
      return jsonResponse({ list: [{ sku: 'sku-902', minBid: 8 }] });
    }
    if (parsed.pathname === '/api/client/min/sku') {
      return jsonResponse({ error: { message: 'minimum CPC temporarily unavailable' } }, 503);
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') {
      return jsonResponse([]);
    }
    if (parsed.pathname === '/api/client/statistics/campaign/product/json') {
      return jsonResponse([]);
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/expense/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/media/json') return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'partial-client',
        performanceClientSecret: 'partial-secret',
        campaignId: '902',
        dateFrom: '2026-08-13',
        dateTo: '2026-08-13',
        readDepth: 'detail',
        includeCampaignObjects: true,
        includeBidInsights: true,
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  const product = overview.campaigns[0].products[0];
  assert.equal(overview.dataSets.campaignBidInsights.status, 'partial');
  assert.equal(product.recommendedBid, 11);
  assert.equal(product.competitiveBid, 13);
  assert.equal(product.minCpoBid, 8);
  assert.equal(product.minimumCpcBid, null);
  assert.equal(product.bidAvailability.minimumCpc.status, 'failed');
  assert.equal(
    overview.dataSets.campaignBidInsights.rows[0].minimumCpcBid,
    null,
  );
  assert.match(
    overview.dataSets.campaignBidInsights.note,
    /最低 CPC 出价读取失败|出价参考接口未完整返回/u,
  );
});

test('Performance search bid insights batch every product instead of truncating after 200 SKUs', async () => {
  const productRows = Array.from({ length: 205 }, (_, index) => ({
    sku: `sku-${String(index + 1).padStart(3, '0')}`,
    bid: 1,
    title: `商品 ${index + 1}`,
  }));
  const requestedRecommendationBatches = [];
  const requestedCompetitiveBatches = [];
  const requestedMinCpoBatches = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'batch-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({ list: [{ id: 'batch-1', title: '批量计划', advObjectType: 'SKU' }], total: 1 });
    }
    if (parsed.pathname === '/api/client/campaign/batch-1/v2/products') {
      return jsonResponse({ list: productRows, total: productRows.length });
    }
    if (parsed.pathname === '/api/client/campaign/batch-1/objects') return jsonResponse({ list: [] });
    if (parsed.pathname === '/api/client/search_promo/bids/recommendation') {
      const skus = JSON.parse(init.body).skus;
      requestedRecommendationBatches.push(skus);
      return jsonResponse({ recommendedBids: Object.fromEntries(skus.map((sku) => [sku, 2])) });
    }
    if (parsed.pathname === '/api/client/campaign/batch-1/products/bids/competitive') {
      const skus = parsed.searchParams.getAll('skus');
      requestedCompetitiveBatches.push(skus);
      return jsonResponse({ list: skus.map((sku) => ({ sku, bid: 3 })) });
    }
    if (parsed.pathname === '/api/client/search_promo/get_cpo_min_bids') {
      const skus = JSON.parse(init.body).skus;
      requestedMinCpoBatches.push(skus);
      return jsonResponse({ list: skus.map((sku) => ({ sku, minBid: 1 })) });
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/product/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/expense/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/media/json') return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'batch-client',
        performanceClientSecret: 'batch-secret',
        campaignId: 'batch-1',
        dateFrom: '2026-08-13',
        dateTo: '2026-08-13',
        readDepth: 'detail',
        includeCampaignObjects: true,
        includeBidInsights: true,
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  assert.deepEqual(requestedRecommendationBatches.map((batch) => batch.length), [200, 5]);
  assert.deepEqual(requestedCompetitiveBatches.map((batch) => batch.length), [200, 5]);
  assert.deepEqual(requestedMinCpoBatches.map((batch) => batch.length), [200, 5]);
  assert.equal(overview.campaigns[0].products.length, 205);
  assert.equal(overview.campaigns[0].products[204].recommendedBid, 2);
  assert.equal(overview.campaigns[0].products[204].competitiveBid, 3);
  assert.equal(overview.campaigns[0].products[204].minCpoBid, 1);
});

test('Performance campaign totals use returned campaign-product zero rows when daily rows are absent', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'zero-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [{ id: '30507521', title: '电雨刷器', state: 'CAMPAIGN_STATE_ARCHIVED' }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/product/json') {
      return jsonResponse([{
        id: '30507521',
        title: '电雨刷器',
        moneySpent: '0,00',
        views: '0',
        clicks: '0',
        orders: '0',
        ordersMoney: '0,00',
        toCart: '0',
      }]);
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/expense/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/media/json') return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'zero-client',
        performanceClientSecret: 'zero-secret',
        dateFrom: '2026-08-06',
        dateTo: '2026-08-12',
        readDepth: 'dashboard',
      },
    },
    { fetchImpl, now: new Date('2026-08-12T08:00:00.000Z') },
  );

  const campaign = overview.campaigns[0];
  assert.equal(campaign.statistics.spent, 0);
  assert.equal(campaign.statistics.impressions, 0);
  assert.equal(campaign.statistics.clicks, 0);
  assert.equal(campaign.statistics.orders, 0);
  assert.equal(campaign.statistics.revenue, 0);
  assert.equal(campaign.statistics.toCart, 0);
  assert.equal(campaign.statistics.availability.status, 'returned');
  assert.deepEqual(campaign.statistics.availability.returnedSources, ['campaignProduct']);
  assert.equal(campaign.statistics.fieldSources.spent, 'campaignProduct');
  assert.equal(campaign.statistics.rows.length, 1);
  assert.equal(overview.summary.spent, 0);
});

test('Performance campaign totals fall back field by field without double counting overlapping sources', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'fallback-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({ list: [{ id: '22', title: '字段级回退' }], total: 1 });
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') {
      return jsonResponse([{ id: '22', date: '2026-08-12', views: 100, clicks: 10, orders: 2, ordersMoney: 50 }]);
    }
    if (parsed.pathname === '/api/client/statistics/campaign/product/json') {
      return jsonResponse([{ id: '22', views: 100, clicks: 10, moneySpent: 30, orders: 2, ordersMoney: 50, toCart: 7 }]);
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/expense/json') {
      return jsonResponse([{ id: '22', date: '2026-08-12', moneySpent: 30, bonusSpent: 4, prepaymentSpent: 26 }]);
    }
    if (parsed.pathname === '/api/client/statistics/campaign/media/json') return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'fallback-client',
        performanceClientSecret: 'fallback-secret',
        dateFrom: '2026-08-06',
        dateTo: '2026-08-12',
        readDepth: 'dashboard',
      },
    },
    { fetchImpl, now: new Date('2026-08-12T08:00:00.000Z') },
  );

  const statistics = overview.campaigns[0].statistics;
  assert.equal(statistics.impressions, 100);
  assert.equal(statistics.clicks, 10);
  assert.equal(statistics.spent, 30);
  assert.equal(statistics.orders, 2);
  assert.equal(statistics.revenue, 50);
  assert.equal(statistics.toCart, 7);
  assert.equal(statistics.bonusSpent, 4);
  assert.equal(statistics.prepaymentSpent, 26);
  assert.equal(statistics.fieldSources.impressions, 'daily');
  assert.equal(statistics.fieldSources.spent, 'campaignProduct');
  assert.equal(statistics.fieldSources.bonusSpent, 'expense');
  assert.equal(overview.summary.spent, 30);
  assert.equal(overview.dailyTrend[0].spent, 30);
});

test('Performance AI snapshot reads the dedicated pay-per-order report and maps its rows to the CPO campaign', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    requests.push({ path: parsed.pathname, method, body: init.body || '' });
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'cpo-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [{ id: '30496576', title: '按订单计费', PaymentType: 'CPO', advObjectType: 'SEARCH_PROMO' }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/product/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/expense/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/media/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistic/products/generate/json') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        from: '2026-08-06T00:00:00Z',
        to: '2026-08-12T23:59:59Z',
      });
      return jsonResponse({ UUID: 'cpo-report' });
    }
    if (parsed.pathname === '/api/client/statistics/cpo-report') {
      return jsonResponse({
        UUID: 'cpo-report',
        state: 'OK',
        link: '/api/client/statistics/report?UUID=cpo-report',
      });
    }
    if (parsed.pathname === '/api/client/statistics/report') {
      return jsonResponse({
        rows: [{ id: 'report-product-7788', moneySpent: 9, orders: 2, ordersMoney: 90, clicks: 0, views: 0 }],
      });
    }
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'cpo-client',
        performanceClientSecret: 'cpo-secret',
        dateFrom: '2026-08-06',
        dateTo: '2026-08-12',
        readDepth: 'ai',
      },
    },
    { fetchImpl, now: new Date('2026-08-12T08:00:00.000Z') },
  );

  const campaign = overview.campaigns[0];
  assert.equal(campaign.statistics.spent, 9);
  assert.equal(campaign.statistics.orders, 2);
  assert.equal(campaign.statistics.revenue, 90);
  assert.equal(campaign.statistics.availability.status, 'returned');
  assert.deepEqual(campaign.statistics.availability.returnedSources, ['async']);
  assert.equal(overview.searchPromoStats[0].campaignId, '30496576');
  assert.equal(overview.dataSets.searchPromoProductStatistics.count, 1);
  assert.equal(requests.some((request) => request.path === '/api/client/statistic/products/generate/json'), true);
});

test('Performance dashboard never blocks realtime metrics on the pay-per-order report task', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed.pathname);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'dashboard-cpo-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [{ id: '30496576', title: '按订单计费', PaymentType: 'CPO', advObjectType: 'SEARCH_PROMO' }],
        total: 1,
      });
    }
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'dashboard-cpo-client',
        performanceClientSecret: 'dashboard-cpo-secret',
        dateFrom: '2026-08-06',
        dateTo: '2026-08-12',
        readDepth: 'dashboard',
      },
    },
    { fetchImpl, now: new Date('2026-08-12T08:00:00.000Z') },
  );

  assert.equal(overview.ok, true);
  assert.equal(overview.aiReadiness.ready, false);
  assert.equal(requests.includes('/api/client/statistic/products/generate/json'), false);
  assert.equal(overview.dataSets.searchPromoProductStatistics.status, 'skipped');
});

test('Performance dashboard batches statistics without reading every campaign detail', async () => {
  const requests = [];
  const campaigns = Array.from({ length: 39 }, (_, index) => ({
    id: String(index + 1),
    title: `计划 ${index + 1}`,
    state: 'CAMPAIGN_STATE_RUNNING',
    advObjectType: 'SKU',
  }));
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({ path: parsed.pathname, method: String(init.method || 'GET').toUpperCase() });
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'dashboard-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') return jsonResponse({ list: campaigns, total: campaigns.length });
    if (parsed.pathname === '/api/client/statistics/daily/json') {
      return jsonResponse(campaigns.map((campaign) => ({ id: campaign.id, views: 10, clicks: 1, moneySpent: 2 })));
    }
    if (parsed.pathname === '/api/client/statistics/campaign/product/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/expense/json') return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistics/campaign/media/json') return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'dashboard-client',
        performanceClientSecret: 'dashboard-secret',
        dateFrom: '2026-08-06',
        dateTo: '2026-08-12',
        readDepth: 'dashboard',
      },
    },
    { fetchImpl, now: new Date('2026-08-12T08:00:00.000Z') },
  );

  assert.equal(overview.readDepth, 'dashboard');
  assert.equal(overview.campaigns.length, 39);
  assert.equal(overview.summary.spent, 78);
  assert.equal(requests.filter((request) => /\/campaign\/\d+\/v2\/products$/u.test(request.path)).length, 0);
  assert.equal(requests.filter((request) => /\/campaign\/\d+\/objects$/u.test(request.path)).length, 0);
  assert.equal(requests.filter((request) => request.path === '/api/client/statistics/daily/json').length, 1);
  assert.equal(requests.some((request) => request.path === '/api/client/statistics/list'), false);
  assert.equal(requests.some((request) => request.path === '/api/client/campaign/available'), false);
});

test('Performance detail reads only the selected campaign product and object endpoints', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push(parsed.pathname);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'detail-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({ list: [{ id: '1', title: '计划一' }, { id: '2', title: '计划二' }], total: 2 });
    }
    if (parsed.pathname === '/api/client/campaign/2/v2/products') return jsonResponse({ list: [{ sku: 'sku-2' }] });
    if (parsed.pathname === '/api/client/campaign/2/objects') return jsonResponse({ list: [{ id: 'object-2' }] });
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'detail-client',
        performanceClientSecret: 'detail-secret',
        campaignId: '2',
        readDepth: 'detail',
      },
    },
    { fetchImpl, now: new Date('2026-08-12T08:00:00.000Z') },
  );

  assert.equal(overview.readDepth, 'detail');
  assert.equal(overview.campaigns.length, 1);
  assert.equal(overview.campaigns[0].id, '2');
  assert.equal(overview.campaigns[0].products[0].sku, 'sku-2');
  assert.equal(overview.campaigns[0].detailRead.products, true);
  assert.equal(overview.campaigns[0].detailRead.objects, true);
  assert.equal(requests.includes('/api/client/campaign/1/v2/products'), false);
  assert.equal(requests.includes('/api/client/campaign/1/objects'), false);
  assert.equal(requests.includes('/api/client/statistics/daily/json'), true);
  assert.equal(requests.includes('/api/client/statistics/campaign/product/json'), true);
  assert.equal(requests.includes('/api/client/statistics/expense/json'), true);
  assert.equal(requests.includes('/api/client/statistics/campaign/media/json'), true);
  assert.equal(requests.includes('/api/client/statistics/list'), false);
});

test('Performance products depth reads every campaign, skips objects, and converts bid micros to rubles', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({ path: parsed.pathname, method: String(init.method || 'GET').toUpperCase() });
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'products-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [
          { id: '1', title: '计划一', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' },
          { id: '2', title: '计划二', state: 'CAMPAIGN_STATE_INACTIVE', advObjectType: 'SKU' },
        ],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/campaign/1/v2/products') {
      return jsonResponse({
        list: [
          { sku: 'sku-shared', title: '商品一', bid: '12000000', previousBid: '11000000' },
          { sku: 'sku-direct-rubles', title: '直接卢布商品', bid: '12', previousBid: '11' },
        ],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/campaign/2/v2/products') {
      return jsonResponse({
        list: [{ sku: 'sku-2', title: '商品二', currentBid: '9500000', recommendedBid: '10000000', competitiveBid: '10500000' }],
        total: 1,
      });
    }
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'products-client',
        performanceClientSecret: 'products-secret',
        readDepth: 'products',
        campaignId: '2',
        includeCampaignObjects: false,
      },
    },
    { fetchImpl, now: new Date('2026-08-12T08:00:00.000Z') },
  );

  assert.equal(overview.readDepth, 'products');
  assert.equal(overview.campaigns.length, 2);
  assert.equal(overview.campaignScope.requestedCampaignId, '2');
  assert.equal(overview.campaignScope.appliedCampaignId, '');
  assert.equal(overview.products.length, 3);
  assert.deepEqual(
    requests
      .filter((request) => /\/campaign\/\d+\/v2\/products$/u.test(request.path))
      .map((request) => request.path)
      .sort(),
    ['/api/client/campaign/1/v2/products', '/api/client/campaign/2/v2/products'],
  );
  assert.equal(requests.some((request) => /\/campaign\/\d+\/objects$/u.test(request.path)), false);
  assert.equal(overview.campaigns[0].detailRead.products, true);
  assert.equal(overview.campaigns[0].detailRead.objects, false);
  assert.equal(overview.campaigns[0].products[0].bid, 12);
  assert.equal(overview.campaigns[0].products[0].previousBid, 11);
  assert.equal(overview.campaigns[0].products[1].bid, 12);
  assert.equal(overview.campaigns[0].products[1].previousBid, 11);
  assert.equal(overview.campaigns[1].products[0].bid, 9.5);
  assert.equal(overview.campaigns[1].products[0].recommendedBid, 10);
  assert.equal(overview.campaigns[1].products[0].competitiveBid, 10.5);
});

test('Performance products depth merges the selected historical range with recent SKU statistics', async () => {
  const reportBodies = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'history-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [{ id: '101', title: '完整日期计划', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/campaign/101/v2/products') {
      return jsonResponse({
        list: [
          { sku: 'sku-101', productId: 'product-101', offerId: 'offer-101', title: '完整日期商品' },
          { sku: 'sku-101-unmatched', productId: 'product-101-unmatched', title: '无历史记录商品' },
        ],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') {
      return jsonResponse([
        {
          campaignId: '101',
          sku: 'sku-101',
          date: '2026-08-12',
          impressions: 4,
          clicks: 1,
          moneySpent: 2,
          orders: 0,
          ordersMoney: 0,
        },
      ]);
    }
    if (parsed.pathname === '/api/client/statistics/json') {
      reportBodies.push(JSON.parse(init.body));
      return jsonResponse({ UUID: 'historical-products-1' });
    }
    if (parsed.pathname === '/api/client/statistics/historical-products-1') {
      return jsonResponse({
        rows: [
          {
            campaignId: '101',
            productId: 'product-101',
            date: '2026-08-08',
            impressions: 10,
            clicks: 2,
            moneySpent: 5,
            orders: 1,
            ordersMoney: 50,
          },
        ],
      });
    }
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'history-client',
        performanceClientSecret: 'history-secret',
        dateFrom: '2026-08-07',
        dateTo: '2026-08-13',
        readDepth: 'products',
        includeCampaignObjects: false,
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  assert.deepEqual(reportBodies, [
    {
      campaigns: ['101'],
      dateFrom: '2026-08-07',
      dateTo: '2026-08-11',
      groupBy: 'DATE',
    },
  ]);
  assert.deepEqual(overview.historicalProductStatisticsRange, {
    available: true,
    dateFrom: '2026-08-07',
    dateTo: '2026-08-11',
  });
  const product = overview.campaigns[0].products[0];
  assert.equal(product.statisticsRows.length, 2);
  assert.equal(product.impressions, 14);
  assert.equal(product.clicks, 3);
  assert.equal(product.spent, 7);
  assert.equal(product.orders, 1);
  assert.equal(product.revenue, 50);
  assert.equal(product.ctr, 21.43);
  assert.equal(product.cpc, 2.33);
  assert.equal(product.acos, 14);
  assert.equal(overview.dataSets.historicalProductStatistics.count, 1);
  assert.equal(
    overview.stages.find((stage) => stage.key === 'historicalProductStatistics')?.status,
    'success',
  );
});

test('Performance products use exact campaign totals only when the campaign has one product', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'single-product-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [
          { id: '401', title: '单商品计划', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' },
          { id: '402', title: '多商品计划', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' },
          { id: '403', title: '零数据单商品计划', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' },
        ],
        total: 3,
      });
    }
    if (parsed.pathname === '/api/client/campaign/401/v2/products') {
      return jsonResponse({ list: [{ sku: 'single-401', title: '单商品' }], total: 1 });
    }
    if (parsed.pathname === '/api/client/campaign/402/v2/products') {
      return jsonResponse({
        list: [{ sku: 'multi-402-a' }, { sku: 'multi-402-b' }],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/campaign/403/v2/products') {
      return jsonResponse({ list: [{ sku: 'single-403', title: '零数据商品' }], total: 1 });
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') {
      return jsonResponse([
        { id: '401', date: '2026-08-12', views: 100, clicks: 10, moneySpent: 25, orders: 2, ordersMoney: 125 },
        { id: '402', date: '2026-08-12', views: 200, clicks: 20, moneySpent: 50, orders: 4, ordersMoney: 250 },
        { id: '403', date: '2026-08-12', views: 0, clicks: 0, moneySpent: 0, orders: 0, ordersMoney: 0 },
      ]);
    }
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'single-product-client',
        performanceClientSecret: 'single-product-secret',
        dateFrom: '2026-08-12',
        dateTo: '2026-08-13',
        readDepth: 'products',
        includeCampaignObjects: false,
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  const singleProduct = overview.campaigns.find((campaign) => campaign.id === '401').products[0];
  assert.equal(singleProduct.impressions, 100);
  assert.equal(singleProduct.clicks, 10);
  assert.equal(singleProduct.spent, 25);
  assert.equal(singleProduct.orders, 2);
  assert.equal(singleProduct.revenue, 125);
  assert.equal(singleProduct.statisticsSource, 'single-product-campaign');
  assert.equal(singleProduct.statisticsFieldSources.spent, 'daily');

  const multiProducts = overview.campaigns.find((campaign) => campaign.id === '402').products;
  assert.equal(multiProducts.every((product) => product.impressions === null), true);
  assert.equal(multiProducts.every((product) => product.spent === null), true);
  assert.equal(multiProducts.every((product) => product.statisticsSource === ''), true);

  const zeroProduct = overview.campaigns.find((campaign) => campaign.id === '403').products[0];
  assert.equal(zeroProduct.impressions, 0);
  assert.equal(zeroProduct.clicks, 0);
  assert.equal(zeroProduct.spent, 0);
  assert.equal(zeroProduct.orders, 0);
  assert.equal(zeroProduct.revenue, 0);
  assert.equal(zeroProduct.statisticsSource, 'single-product-campaign');
});

test('Performance product statistics match SKU, product id, and offer id without crossing campaigns', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'identity-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [
          { id: '201', title: '身份计划一', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' },
          { id: '202', title: '身份计划二', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' },
        ],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/campaign/201/v2/products') {
      return jsonResponse({
        list: [
          { sku: 'shared-sku', productId: 'product-201', offerId: 'offer-201', title: '身份商品一' },
          { sku: 'unmatched-sku', productId: 'unmatched-product', title: '无统计商品' },
        ],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/campaign/202/v2/products') {
      return jsonResponse({
        list: [{ sku: 'shared-sku', productId: 'product-202', offerId: 'offer-202', title: '身份商品二' }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') {
      return jsonResponse([
        {
          productId: 'product-201',
          date: '2026-08-12',
          impressions: 10,
          clicks: 2,
          moneySpent: 3,
          orders: 1,
          ordersMoney: 30,
        },
        {
          campaignId: '202',
          offerId: 'offer-202',
          date: '2026-08-12',
          impressions: 0,
          clicks: 0,
          moneySpent: 0,
          orders: 0,
          ordersMoney: 0,
        },
        {
          sku: 'shared-sku',
          date: '2026-08-12',
          impressions: 999,
          clicks: 999,
          moneySpent: 999,
          orders: 999,
          ordersMoney: 999,
        },
      ]);
    }
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'identity-client',
        performanceClientSecret: 'identity-secret',
        dateFrom: '2026-08-12',
        dateTo: '2026-08-13',
        readDepth: 'products',
        includeCampaignObjects: false,
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  const firstProduct = overview.campaigns[0].products[0];
  const unmatchedProduct = overview.campaigns[0].products[1];
  const secondProduct = overview.campaigns[1].products[0];
  assert.equal(firstProduct.statisticsRows.length, 1);
  assert.equal(firstProduct.impressions, 10);
  assert.equal(firstProduct.spent, 3);
  assert.equal(secondProduct.statisticsRows.length, 1);
  assert.equal(secondProduct.impressions, 0);
  assert.equal(secondProduct.clicks, 0);
  assert.equal(secondProduct.spent, 0);
  assert.equal(secondProduct.orders, 0);
  assert.equal(secondProduct.revenue, 0);
  assert.equal(unmatchedProduct.statisticsRows.length, 0);
  assert.equal(unmatchedProduct.impressions, null);
  assert.equal(firstProduct.impressions === 999 || secondProduct.impressions === 999, false);
});

test('Performance historical product reports batch at most ten campaigns per sequential task', async () => {
  const campaignIds = Array.from({ length: 11 }, (_, index) => String(index + 301));
  const reportBodies = [];
  let reportIndex = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'batch-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: campaignIds.map((id) => ({ id, title: `计划 ${id}`, advObjectType: 'SKU' })),
        total: campaignIds.length,
      });
    }
    const productMatch = parsed.pathname.match(/^\/api\/client\/campaign\/(\d+)\/v2\/products$/u);
    if (productMatch) {
      return jsonResponse({
        list: [
          { sku: `sku-${productMatch[1]}-a` },
          { sku: `sku-${productMatch[1]}-b` },
        ],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/statistics/json') {
      reportBodies.push(JSON.parse(init.body));
      reportIndex += 1;
      return jsonResponse({ UUID: `batch-report-${reportIndex}` });
    }
    const reportMatch = parsed.pathname.match(/^\/api\/client\/statistics\/batch-report-(\d+)$/u);
    if (reportMatch) {
      return jsonResponse({
        rows: [{
          campaignId: reportBodies[Number(reportMatch[1]) - 1].campaigns[0],
          sku: `sku-${reportBodies[Number(reportMatch[1]) - 1].campaigns[0]}`,
          date: '2026-08-08',
          impressions: 1,
        }],
      });
    }
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'batch-client',
        performanceClientSecret: 'batch-secret',
        dateFrom: '2026-08-07',
        dateTo: '2026-08-13',
        readDepth: 'products',
        includeCampaignObjects: false,
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  assert.equal(reportBodies.length, 2);
  assert.deepEqual(reportBodies.map((body) => body.campaigns.length), [10, 1]);
  assert.equal(reportBodies.every((body) => body.dateFrom === '2026-08-07'), true);
  assert.equal(reportBodies.every((body) => body.dateTo === '2026-08-11'), true);
  assert.equal(
    overview.stages.find((stage) => stage.key === 'historicalProductStatistics')?.segmentCount,
    2,
  );
  assert.equal(overview.dataSets.historicalProductStatistics.status, 'success');
});

test('Performance historical product reports stop before creating another task while one is pending', async () => {
  const campaignIds = Array.from({ length: 11 }, (_, index) => String(index + 501));
  const reportBodies = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'pending-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: campaignIds.map((id) => ({ id, title: `待生成计划 ${id}`, advObjectType: 'SKU' })),
        total: campaignIds.length,
      });
    }
    const productMatch = parsed.pathname.match(/^\/api\/client\/campaign\/(\d+)\/v2\/products$/u);
    if (productMatch) {
      return jsonResponse({
        list: [{ sku: `sku-${productMatch[1]}-a` }, { sku: `sku-${productMatch[1]}-b` }],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/statistics/json') {
      reportBodies.push(JSON.parse(init.body));
      return jsonResponse({ UUID: 'pending-product-report' });
    }
    if (parsed.pathname === '/api/client/statistics/pending-product-report') {
      return jsonResponse({ state: 'IN_PROGRESS' });
    }
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'pending-client',
        performanceClientSecret: 'pending-secret',
        dateFrom: '2026-08-07',
        dateTo: '2026-08-13',
        readDepth: 'products',
        includeCampaignObjects: false,
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  assert.equal(reportBodies.length, 1);
  assert.equal(reportBodies[0].campaigns.length, 10);
  const stage = overview.stages.find((item) => item.key === 'historicalProductStatistics');
  assert.equal(stage.segmentCount, 1);
  assert.equal(stage.failedSegmentCount, 1);
  assert.equal(stage.status, 'failed');
});

test('Performance historical product reports resume the exact active task after Ozon returns 429', async () => {
  let createCount = 0;
  let statusReadCount = 0;
  let externalListCount = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'resume-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [{ id: '601', title: '可恢复历史计划', advObjectType: 'SKU' }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/campaign/601/v2/products') {
      return jsonResponse({
        list: [{ sku: 'resume-601-a' }, { sku: 'resume-601-b' }],
        total: 2,
      });
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') {
      return jsonResponse([{ id: '601', date: '2026-08-12', views: 0, clicks: 0, moneySpent: 0 }]);
    }
    if (parsed.pathname === '/api/client/statistics/json') {
      createCount += 1;
      if (createCount === 1) return jsonResponse({ UUID: 'resumable-product-report' });
      return jsonResponse({ error: { message: 'active report limit' } }, 429);
    }
    if (parsed.pathname === '/api/client/statistics/externallist') {
      externalListCount += 1;
      return jsonResponse({
        items: [{
          meta: {
            UUID: 'resumable-product-report',
            state: 'IN_PROGRESS',
            createdAt: '2026-08-13T01:00:00Z',
            request: {
              campaigns: ['601'],
              dateFrom: '2026-08-07',
              dateTo: '2026-08-11',
              groupBy: 'DATE',
            },
          },
        }],
        total: 1,
      });
    }
    if (parsed.pathname === '/api/client/statistics/resumable-product-report') {
      statusReadCount += 1;
      if (statusReadCount <= 4) return jsonResponse({ UUID: 'resumable-product-report', state: 'IN_PROGRESS' });
      return jsonResponse({
        UUID: 'resumable-product-report',
        state: 'OK',
        link: '/api/client/statistics/report?UUID=resumable-product-report',
      });
    }
    if (parsed.pathname === '/api/client/statistics/report') {
      return jsonResponse({
        rows: [{
          campaignId: '601',
          sku: 'resume-601-a',
          date: '2026-08-08',
          impressions: 8,
          clicks: 2,
          moneySpent: 4,
          orders: 1,
          ordersMoney: 40,
        }],
      });
    }
    if (parsed.pathname.startsWith('/api/client/statistics/')) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };
  const payload = {
    values: {
      performanceClientId: 'resume-client',
      performanceClientSecret: 'resume-secret',
      dateFrom: '2026-08-07',
      dateTo: '2026-08-13',
      readDepth: 'products',
      includeCampaignObjects: false,
    },
  };
  const options = { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') };

  const pendingOverview = await readPerformanceRealtimeOverview(payload, options);
  assert.equal(
    pendingOverview.stages.find((item) => item.key === 'historicalProductStatistics').status,
    'failed',
  );
  const resumedOverview = await readPerformanceRealtimeOverview(payload, options);

  assert.equal(createCount, 2);
  assert.equal(externalListCount, 1);
  assert.equal(resumedOverview.dataSets.historicalProductStatistics.status, 'success');
  const resumedProduct = resumedOverview.campaigns[0].products[0];
  assert.equal(resumedProduct.impressions, 8);
  assert.equal(resumedProduct.spent, 4);
  assert.equal(resumedProduct.orders, 1);
});

test('Performance coalescing keeps different campaign detail reads isolated', async () => {
  let campaignListReads = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'coalescing-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      campaignListReads += 1;
      return jsonResponse({ list: [{ id: '1', title: '计划一' }, { id: '2', title: '计划二' }], total: 2 });
    }
    const productMatch = parsed.pathname.match(/^\/api\/client\/campaign\/(\d+)\/v2\/products$/u);
    if (productMatch) return jsonResponse({ list: [{ sku: `sku-${productMatch[1]}` }] });
    return jsonResponse([]);
  };
  const baseValues = {
    accountId: 'coalescing-account',
    performanceClientId: 'coalescing-client',
    performanceClientSecret: 'coalescing-secret',
    readDepth: 'detail',
    includeCampaignObjects: false,
  };

  const [first, second] = await Promise.all([
    readPerformanceRealtimeOverview(
      { values: { ...baseValues, campaignId: '1' } },
      { fetchImpl, coalesce: true, now: new Date('2026-08-12T08:00:00.000Z') },
    ),
    readPerformanceRealtimeOverview(
      { values: { ...baseValues, campaignId: '2' } },
      { fetchImpl, coalesce: true, now: new Date('2026-08-12T08:00:00.000Z') },
    ),
  ]);

  assert.equal(campaignListReads, 2);
  assert.equal(first.campaigns[0].id, '1');
  assert.equal(first.campaigns[0].products[0].sku, 'sku-1');
  assert.equal(second.campaigns[0].id, '2');
  assert.equal(second.campaigns[0].products[0].sku, 'sku-2');
});

test('Performance dashboard splits ranges longer than 62 days and aggregates every statistics source once', async () => {
  const statisticsRequests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'segmented-dashboard-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({ list: [{ id: '77', title: '长日期计划', state: 'CAMPAIGN_STATE_RUNNING' }], total: 1 });
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (
      [
        '/api/client/statistics/daily/json',
        '/api/client/statistics/campaign/product/json',
        '/api/client/statistics/expense/json',
        '/api/client/statistics/campaign/media/json',
      ].includes(parsed.pathname)
    ) {
      const dateFrom = parsed.searchParams.get('dateFrom');
      const dateTo = parsed.searchParams.get('dateTo');
      statisticsRequests.push({ path: parsed.pathname, dateFrom, dateTo });
      const isFirstSegment = dateFrom === '2026-06-07';
      if (parsed.pathname === '/api/client/statistics/daily/json') {
        return jsonResponse([{
          id: '77',
          date: isFirstSegment ? '2026-06-07' : '2026-08-08',
          views: isFirstSegment ? 100 : 50,
          clicks: isFirstSegment ? 10 : 5,
          moneySpent: isFirstSegment ? 20 : 10,
          orders: isFirstSegment ? 2 : 1,
          ordersMoney: isFirstSegment ? 80 : 40,
        }]);
      }
      if (parsed.pathname === '/api/client/statistics/campaign/product/json') {
        return jsonResponse([{
          campaignId: '77',
          sku: isFirstSegment ? 'sku-a' : 'sku-b',
          date: isFirstSegment ? '2026-06-07' : '2026-08-08',
          views: isFirstSegment ? 100 : 50,
          clicks: isFirstSegment ? 10 : 5,
          moneySpent: isFirstSegment ? 20 : 10,
          orders: isFirstSegment ? 2 : 1,
          ordersMoney: isFirstSegment ? 80 : 40,
        }]);
      }
      if (parsed.pathname === '/api/client/statistics/expense/json') {
        return jsonResponse([{
          campaignId: '77',
          date: isFirstSegment ? '2026-06-07' : '2026-08-08',
          moneySpent: isFirstSegment ? 20 : 10,
        }]);
      }
      return jsonResponse([{
        campaignId: '77',
        mediaType: 'SEARCH',
        date: isFirstSegment ? '2026-06-07' : '2026-08-08',
        views: isFirstSegment ? 100 : 50,
      }]);
    }
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'segmented-dashboard-client',
        performanceClientSecret: 'segmented-dashboard-secret',
        dateFrom: '2026-06-07',
        dateTo: '2026-08-13',
        readDepth: 'dashboard',
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  const expectedSegments = [
    { dateFrom: '2026-06-07', dateTo: '2026-08-07' },
    { dateFrom: '2026-08-08', dateTo: '2026-08-13' },
  ];
  for (const path of [
    '/api/client/statistics/daily/json',
    '/api/client/statistics/campaign/product/json',
    '/api/client/statistics/expense/json',
    '/api/client/statistics/campaign/media/json',
  ]) {
    assert.deepEqual(
      statisticsRequests
        .filter((request) => request.path === path)
        .map(({ dateFrom, dateTo }) => ({ dateFrom, dateTo })),
      expectedSegments,
    );
  }
  assert.equal(overview.summary.spent, 30);
  assert.equal(overview.summary.clicks, 15);
  assert.equal(overview.summary.orders, 3);
  assert.equal(overview.summary.revenue, 120);
  assert.equal(overview.dataSets.dailyStatistics.count, 2);
  assert.equal(overview.dataSets.dailyStatistics.status, 'success');
  assert.equal(overview.readIssues.length, 0);
  const dailyStage = overview.stages.find((stage) => stage.key === 'dailyStatistics');
  assert.equal(dailyStage.segmentCount, 2);
  assert.equal(dailyStage.successfulSegmentCount, 2);
  assert.equal(dailyStage.failedSegmentCount, 0);
});

test('Performance dashboard preserves successful segments and reports the exact failed range', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'partial-segment-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({ list: [{ id: '88', title: '分段失败计划' }], total: 1 });
    }
    if (parsed.pathname === '/api/client/statistics/products/sku') return jsonResponse([]);
    if (
      ['/api/client/statistics/daily/json', '/api/client/statistics/daily'].includes(parsed.pathname) &&
      parsed.searchParams.get('dateFrom') === '2026-08-08'
    ) {
      return jsonResponse({ error: { message: 'second segment failed' } }, 500);
    }
    if (parsed.pathname === '/api/client/statistics/daily/json') {
      return jsonResponse([{
        id: '88', date: '2026-06-07', views: 10, clicks: 2, moneySpent: 5, orders: 1, ordersMoney: 25,
      }]);
    }
    if (
      [
        '/api/client/statistics/campaign/product/json',
        '/api/client/statistics/expense/json',
        '/api/client/statistics/campaign/media/json',
      ].includes(parsed.pathname)
    ) return jsonResponse([]);
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'partial-segment-client',
        performanceClientSecret: 'partial-segment-secret',
        dateFrom: '2026-06-07',
        dateTo: '2026-08-13',
        readDepth: 'dashboard',
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  assert.equal(overview.summary.spent, 5);
  assert.equal(overview.dataSets.dailyStatistics.count, 1);
  assert.equal(overview.dataSets.dailyStatistics.status, 'partial');
  const dailyStage = overview.stages.find((stage) => stage.key === 'dailyStatistics');
  assert.equal(dailyStage.segmentCount, 2);
  assert.equal(dailyStage.successfulSegmentCount, 1);
  assert.equal(dailyStage.failedSegmentCount, 1);
  const issue = overview.readIssues.find((item) => item.kind === 'campaign-daily-statistics');
  assert.equal(issue.dateFrom, '2026-08-08');
  assert.equal(issue.dateTo, '2026-08-13');
  assert.match(issue.message, /second segment failed/u);
});

test('Performance promotion orders split long ranges and deduplicate stable order rows', async () => {
  const generatedRanges = [];
  let reportIndex = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'segmented-orders-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/statistic/orders/generate/json') {
      const body = JSON.parse(init.body);
      generatedRanges.push(body);
      reportIndex += 1;
      return jsonResponse({ UUID: `orders-segment-${reportIndex}` });
    }
    if (parsed.pathname === '/api/client/statistics/orders-segment-1') {
      return jsonResponse({
        rows: [
          { orderId: 'shared-order', sku: '100', offerId: 'WZ-100', orderDate: '2026-08-07', count: 1, revenue: 100, expense: 20 },
          { orderId: 'first-order', sku: '101', offerId: 'WZ-101', orderDate: '2026-07-01', count: 1, revenue: 200, expense: 30 },
        ],
      });
    }
    if (parsed.pathname === '/api/client/statistics/orders-segment-2') {
      return jsonResponse({
        rows: [
          { orderId: 'shared-order', sku: '100', offerId: 'WZ-100', orderDate: '2026-08-07', count: 1, revenue: 100, expense: 20 },
          { orderId: 'second-order', sku: '102', offerId: 'WZ-102', orderDate: '2026-08-09', count: 1, revenue: 300, expense: 40 },
        ],
      });
    }
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const result = await readPerformanceRealtimeOverview(
    {
      values: {
        accountId: 'segmented-orders-account',
        performanceClientId: 'segmented-orders-client',
        performanceClientSecret: 'segmented-orders-secret',
        dateFrom: '2026-06-07',
        dateTo: '2026-08-13',
        readDepth: 'orders',
      },
    },
    { fetchImpl },
  );

  assert.deepEqual(generatedRanges, [
    { from: '2026-06-07T00:00:00Z', to: '2026-08-07T23:59:59Z' },
    { from: '2026-08-08T00:00:00Z', to: '2026-08-13T23:59:59Z' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.segmentCount, 2);
  assert.equal(result.total, 3);
  assert.equal(result.summary.orderCount, 3);
  assert.equal(result.summary.revenue, 600);
  assert.equal(result.summary.spent, 90);
});

test('Performance AI CPO product report splits long ranges and keeps every segment contribution', async () => {
  const generatedRanges = [];
  let reportIndex = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/client/token') {
      return jsonResponse({ access_token: 'segmented-cpo-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.pathname === '/api/client/campaign') {
      return jsonResponse({
        list: [{ id: '30496576', title: '长日期 CPO', PaymentType: 'CPO', advObjectType: 'SEARCH_PROMO' }],
        total: 1,
      });
    }
    if (
      [
        '/api/client/statistics/daily/json',
        '/api/client/statistics/campaign/product/json',
        '/api/client/statistics/products/sku',
        '/api/client/statistics/expense/json',
        '/api/client/statistics/campaign/media/json',
      ].includes(parsed.pathname)
    ) return jsonResponse([]);
    if (parsed.pathname === '/api/client/statistic/products/generate/json') {
      generatedRanges.push(JSON.parse(init.body));
      reportIndex += 1;
      return jsonResponse({ UUID: `products-segment-${reportIndex}` });
    }
    if (parsed.pathname === '/api/client/statistics/products-segment-1') {
      return jsonResponse({ rows: [{ campaignId: '30496576', sku: 'sku-1', date: '2026-07-01', moneySpent: 10, orders: 1, ordersMoney: 50 }] });
    }
    if (parsed.pathname === '/api/client/statistics/products-segment-2') {
      return jsonResponse({ rows: [{ campaignId: '30496576', sku: 'sku-1', date: '2026-08-09', moneySpent: 20, orders: 2, ordersMoney: 100 }] });
    }
    return jsonResponse({ error: { message: `unexpected endpoint ${parsed.pathname}` } }, 404);
  };

  const overview = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: 'segmented-cpo-client',
        performanceClientSecret: 'segmented-cpo-secret',
        dateFrom: '2026-06-07',
        dateTo: '2026-08-13',
        readDepth: 'ai',
      },
    },
    { fetchImpl, now: new Date('2026-08-13T08:00:00.000Z') },
  );

  assert.deepEqual(generatedRanges, [
    { from: '2026-06-07T00:00:00Z', to: '2026-08-07T23:59:59Z' },
    { from: '2026-08-08T00:00:00Z', to: '2026-08-13T23:59:59Z' },
  ]);
  assert.equal(overview.searchPromoStats.length, 2);
  assert.equal(overview.searchPromoProductsReport.rows.length, 2);
  assert.equal(overview.searchPromoProductsReport.ok, true);
  assert.equal(overview.campaigns[0].statistics.spent, 30);
  assert.equal(overview.campaigns[0].statistics.orders, 3);
  assert.equal(overview.campaigns[0].statistics.revenue, 150);
});

import { describe, expect, it, vi } from 'vitest';
import {
  buildSmartToolOzonBrowserResult,
  canUseSmartToolOzonBrowserData,
  runSmartToolDraftWithOzonBrowserData,
} from './smartToolOzonBrowserDataService.js';

describe('smartToolOzonBrowserDataService', () => {
  it('merges repeated SKU responses by filling missing fields from older captures', () => {
    const result = buildSmartToolOzonBrowserResult({
      toolId: 'ozon-product-search',
      datasets: [
        {
          sequence: 20,
          dataset: 'product-performance',
          quality: 'confirmed-data',
          capturedAt: '2026-07-29T06:02:00.000Z',
          records: [{ id: '6041234567', title: 'платье', price: 4185, revenue: 6479914 }],
        },
        {
          sequence: 19,
          dataset: 'product-performance',
          quality: 'confirmed-data',
          capturedAt: '2026-07-29T06:01:00.000Z',
          records: [
            {
              id: '6041234567',
              sales: 1548,
              category1: '服装',
              category2: '女装',
              category3: '连衣裙',
              averageDailyUnits: 12,
            },
          ],
        },
      ],
    });

    expect(result.browserData.records).toHaveLength(1);
    expect(result.browserData.records[0]).toMatchObject({
      price: 4185,
      revenue: 6479914,
      sales: 1548,
      category1: '服装',
      category2: '女装',
      category3: '连衣裙',
      averageDailyUnits: 12,
    });
  });

  it('returns more than the old 100-row cap when Ozon provides more records', () => {
    const records = Array.from({ length: 125 }, (_, index) => ({
      id: String(7000000000 + index),
      title: `商品 ${index + 1}`,
      price: index + 100,
    }));
    const result = buildSmartToolOzonBrowserResult({
      toolId: 'ozon-product-search',
      datasets: [{ sequence: 1, dataset: 'product-performance', quality: 'confirmed-data', records }],
    });
    expect(result.browserData.returnedRecordCount).toBe(125);
    expect(result.productAnalysis.recordCount).toBe(125);
  });

  it('matches a Chinese query against captured Russian product titles', () => {
    const result = buildSmartToolOzonBrowserResult({
      toolId: 'ozon-product-search',
      values: { '关键词或 SKU': '遥控汽车' },
      catalog: { endpointCount: 3 },
      observerVersion: '2.6.3',
      datasets: [
        {
          sequence: 2,
          dataset: 'product-performance',
          quality: 'confirmed-data',
          capturedAt: '2026-07-29T06:00:00.000Z',
          records: [
            { id: 'sku-car', title: 'Машина на пульте управления багги монстр трак 70 км/ч', price: 1999 },
            { id: 'sku-helicopter', title: 'Вертолет GPS дрон на пульте управления с камерой', price: 2599 },
            { id: 'sku-dinosaur', title: 'Динозавр детская интерактивная игрушка на пульте с паром', price: 1599 },
            { id: 'sku-dress', title: 'Женское платье', price: 899 },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      status: 'browser_data_ready',
      browserData: {
        queryMatched: true,
        queryAliases: expect.arrayContaining(['машинка на радиоуправлении']),
        returnedRecordCount: 1,
      },
    });
    expect(result.browserData.records[0].id).toBe('sku-car');
    expect(result.productAnalysis).toMatchObject({
      recordCount: 1,
      priceStats: { count: 1, median: 1999 },
      revenueStats: { count: 0, total: null },
    });
    expect(result).not.toHaveProperty('sections');
  });

  it.each([
    ['遥控汽车', 'радиоуправляемая машина', 'car-1'],
    ['连衣裙', 'женское платье', 'dress-1'],
    ['运动鞋', 'белые кроссовки', 'shoe-1'],
    ['手机壳', 'чехол для телефона', 'case-1'],
    ['кофемашина', 'автоматическая кофемашина', 'coffee-1'],
  ])('returns a stable product row for multiple keyword query %s', (query, title, id) => {
    const result = buildSmartToolOzonBrowserResult({
      toolId: 'ozon-product-search',
      values: { '关键词或 SKU': query },
      datasets: [
        {
          sequence: 10,
          dataset: 'product-performance',
          quality: 'confirmed-data',
          records: [
            { id, title, price: 1999, sales: 12 },
            { id: 'noise-1', title: 'несвязанный товар', price: 2999, sales: 2 },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      status: 'browser_data_ready',
      browserData: { queryMatched: true, returnedRecordCount: 1 },
      productAnalysis: { recordCount: 1 },
    });
    expect(result.browserData.records[0]).toMatchObject({ id, title, price: 1999, sales: 12 });
  });

  it('reuses the market mapper and preserves expanded product-performance fields in search results', () => {
    const result = buildSmartToolOzonBrowserResult({
      toolId: 'ozon-product-search',
      captureMode: 'product-search',
      query: 'машинка на радиоуправлении',
      serverQueryMatched: true,
      datasets: [
        {
          sequence: 30,
          endpoint: '/api/site/seller-analytics/what_to_sell/data/v3',
          dataset: 'product-performance',
          quality: 'confirmed-data',
          capturedAt: '2026-07-30T02:00:00.000Z',
          records: [
            {
              raw: {
                skuId: 'expanded-1',
                productName: 'Радиоуправляемая машина',
                drr: 4.7,
                daysInPromo: 8,
                discount: 12.5,
                promo_revenue_share: 27.1,
                daysWithTrafarets: 4,
                qtyViewPdp: 1000,
                convToCartPdp: 8.8,
                sessionCountSearch: 4500,
                convToCartSearch: 3.2,
                convViewToOrder: 2.1,
                custom_click_rate: 7.4,
                salesSchema: 'FBO',
                nullableRedemptionRate: 96,
                depth: 100,
                width: 200,
                height: 300,
                weightGrams: 850,
                nullableCreateDate: '2026-06-01T00:00:00.000Z',
                sellers: [{ id: 'seller-1' }, { id: 'seller-2' }],
                follow_min_price: 1200,
                follow_max_price: 1500,
                rfbs_rate: { moscow: 12.5 },
                fbp_rate: { moscow: 87.5 },
              },
            },
          ],
        },
      ],
    });

    expect(result.browserData.records[0]).toMatchObject({
      id: 'expanded-1',
      title: 'Радиоуправляемая машина',
      adSpendShare: 4.7,
      promoDays: 8,
      promoDiscount: 12.5,
      promoRevenueShare: 27.1,
      paidPromotionDays: 4,
      productCardViews: 1000,
      productCardToCartRate: 8.8,
      searchCatalogViews: 4500,
      searchCatalogToCartRate: 3.2,
      impressionToOrderRate: 2.1,
      clickThroughRate: 7.4,
      fulfillmentModel: 'FBO',
      redemptionRate: 96,
      returnCancelRate: 4,
      packageDimensions: '100 × 200 × 300 mm',
      packageWeight: '850 g',
      followSellerCount: 2,
      followMinPrice: 1200,
      followMaxPrice: 1500,
      rfbsRate: '12.5%',
      fbpRate: '87.5%',
    });
    expect(result.productAnalysis.fieldCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'adSpendShare', count: 1, percent: 100 }),
        expect.objectContaining({ key: 'productCardViews', count: 1, percent: 100 }),
        expect.objectContaining({ key: 'fulfillmentModel', count: 1, percent: 100 }),
        expect.objectContaining({ key: 'packageDimensions', count: 1, percent: 100 }),
        expect.objectContaining({ key: 'followSellerCount', count: 1, percent: 100 }),
      ])
    );
  });

  it('trusts the fresh Ozon server-filtered product-performance pages even when titles are localized', () => {
    const result = buildSmartToolOzonBrowserResult({
      toolId: 'ozon-product-search',
      values: { '关键词或 SKU': '遥控汽车' },
      captureMode: 'product-search',
      serverQueryMatched: true,
      queryPlan: {
        queryMode: 'product',
        matchSource: 'alias+shared-catalog',
        confidence: 'exact',
        catalogHydrated: true,
        categoryMatch: { name: '遥控玩具', pathText: '儿童用品 > 无线电遥控玩具 > 遥控玩具' },
      },
      datasets: [
        {
          sequence: 30,
          dataset: 'product-performance',
          quality: 'confirmed-data',
          records: [
            { id: '3522577361', title: 'DASDORRIO Radio Controlled Toy', price: 5398, sales: 1168 },
            { id: '1805953983', title: 'YoukRC Radio Controlled Toy', price: 5519, sales: 288 },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      status: 'browser_data_ready',
      browserData: {
        queryMatched: true,
        serverQueryMatched: true,
        returnedRecordCount: 2,
        queryPlan: {
          queryMode: 'product',
          categoryPath: '儿童用品 > 无线电遥控玩具 > 遥控玩具',
          catalogHydrated: true,
        },
      },
    });
  });

  it('turns a Chinese input into a background product query before building the Skill result', async () => {
    let currentUrl = 'https://seller.ozon.ru/app/dashboard/main';
    let probed = false;
    const state = () => ({
      activeTabId: 'collector-tab',
      tabs: [
        {
          tabId: 'collector-tab',
          browserRole: 'market-collector',
          background: true,
          loading: false,
          url: currentUrl,
        },
      ],
    });
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return state();
      if (input.command === 'navigate') {
        currentUrl = input.url;
        return state();
      }
      if (input.command === 'ozon-data-status') {
        return {
          result: { installed: true, enabled: true, ready: true, version: '2.6.3', lastSequence: probed ? 1 : 0 },
        };
      }
      if (input.command === 'ozon-data-probe') {
        if (input.path?.endsWith('/what_to_sell/data/v3')) {
          probed = true;
          return {
            result: {
              quality: 'confirmed-data',
              capturedSequence: 2,
              recordCount: 1,
            },
          };
        }
        throw new Error(`unexpected probe: ${input.path}`);
      }
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 6, version: '2.6.3' } };
      if (input.command === 'ozon-data-normalize') {
        return {
          result: {
            datasets: probed
              ? [
                  {
                    sequence: 2,
                    dataset: 'product-performance',
                    quality: 'confirmed-data',
                    capturedAt: '2026-07-29T06:00:00.000Z',
                    records: [{ id: 'dress-1', title: 'Женское платье', price: 899 }],
                  },
                ]
              : [],
          },
        };
      }
      throw new Error(`unexpected command: ${input.command}`);
    });

    const draft = await runSmartToolDraftWithOzonBrowserData(
      {
        id: 'ozon-product-search',
        title: 'Ozon 商品搜索',
        skillProfile: { usageInputs: ['关键词或 SKU'] },
      },
      { '关键词或 SKU': '连衣裙' },
      {
        command,
        productSearchOptions: {
          productSearchWarmupMs: 0,
          productSearchTimeoutMs: 0,
          captureSettleMs: 0,
          pagination: false,
          productPerformancePreferCategoryOnly: false,
        },
      }
    );

    expect(
      command.mock.calls.find(
        ([input]) => input.command === 'ozon-data-probe' && input.path?.endsWith('/what_to_sell/data/v3')
      )?.[0]
    ).toMatchObject({
      path: '/api/site/seller-analytics/what_to_sell/data/v3',
      body: {
        filter: {
          name: 'платье',
        },
      },
    });
    expect(draft.result).toMatchObject({
      status: 'browser_data_ready',
      browserData: {
        captureMode: 'product-search',
        query: 'платье',
        returnedRecordCount: 1,
      },
    });
    expect(draft.result.browserData.records[0].id).toBe('dress-1');
  }, 15_000);

  it('reports a probe network failure instead of claiming that the observer was not injected', async () => {
    let currentUrl = 'https://seller.ozon.ru/app/dashboard/main';
    const state = () => ({
      tabs: [
        {
          tabId: 'collector-tab',
          browserRole: 'market-collector',
          background: true,
          loading: false,
          url: currentUrl,
        },
      ],
    });
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return state();
      if (input.command === 'navigate') {
        currentUrl = input.url;
        return state();
      }
      if (input.command === 'ozon-data-status') {
        return { result: { installed: true, enabled: true, ready: true, version: '2.6.6', lastSequence: 0 } };
      }
      if (input.command === 'ozon-data-normalize') return { result: { datasets: [] } };
      if (input.command === 'ozon-data-probe') {
        const error = new Error('OZON_DATA_OBSERVER_PROBE_FAILED');
        error.code = error.message;
        throw error;
      }
      throw new Error(`unexpected command: ${input.command}`);
    });

    const draft = await runSmartToolDraftWithOzonBrowserData(
      {
        id: 'ozon-product-search',
        title: 'Ozon 商品搜索',
        skillProfile: { usageInputs: ['关键词或 SKU'] },
      },
      { '关键词或 SKU': '遥控汽车' },
      {
        command,
        productSearchOptions: {
          productSearchWarmupMs: 0,
          productPerformanceRecipeRetryMs: 0,
          productSearchTimeoutMs: 0,
          captureSettleMs: 0,
          pagination: false,
        },
      }
    );

    expect(draft.result).toMatchObject({
      status: 'browser_data_error',
      errorCode: 'OZON_DATA_OBSERVER_PROBE_FAILED',
    });
    expect(draft.result.summary).toContain('商品查询网络请求失败');
    expect(draft.result.summary).not.toContain('观察器未能注入');
  }, 15_000);

  it('does not reuse a passive browser snapshot when an active product query has no input', async () => {
    const productSearchRunner = vi.fn(async () => ({
      queryPlan: { input: '', query: '', aliases: [], categoryIds: [], queryMode: 'product' },
      snapshot: null,
    }));
    const command = vi.fn();

    const draft = await runSmartToolDraftWithOzonBrowserData(
      { id: 'ozon-product-search', title: 'Ozon 商品搜索', skillProfile: { usageInputs: ['关键词或 SKU'] } },
      { '关键词或 SKU': '' },
      { command, productSearchRunner }
    );

    expect(command).not.toHaveBeenCalled();
    expect(draft.result).toMatchObject({
      status: 'browser_data_empty',
      browserData: { captureMode: 'product-search', recordCount: 0, records: [] },
    });
  });

  it('parses a supplied source link on the dedicated browser and uses its category for market search', async () => {
    const command = vi.fn();
    const productLinkParser = vi.fn(async () => ({
      platform: '1688',
      platformKey: '1688',
      productTitle: '测试连衣裙',
      category: '连衣裙',
      price: 26.8,
      currency: 'CNY',
      lengthCm: 30,
      widthCm: 20,
      heightCm: 8,
      weightKg: 0.45,
    }));
    const productSearchRunner = vi.fn(async () => ({
      queryPlan: { input: '连衣裙', query: 'платье', aliases: [], categoryIds: [], queryMode: 'product' },
      snapshot: {
        captureMode: 'product-search',
        query: 'платье',
        serverQueryMatched: true,
        observerVersion: '2.7.0',
        catalog: { endpointCount: 8 },
        datasets: [
          {
            sequence: 40,
            dataset: 'product-performance',
            quality: 'confirmed-data',
            records: [{ id: 'dress-1', title: 'Платье', price: 2400, categoryCommission: 16 }],
          },
        ],
      },
    }));

    const draft = await runSmartToolDraftWithOzonBrowserData(
      { id: 'ozon-product-search', title: 'Ozon 商品搜索', skillProfile: { usageInputs: ['关键词或 SKU'] } },
      {
        '关键词或 SKU': '',
        '产品链接（可选）': 'https://detail.1688.com/offer/123.html',
      },
      { command, productSearchRunner, productLinkParser }
    );

    expect(productLinkParser).toHaveBeenCalledWith('https://detail.1688.com/offer/123.html', { bridge: command });
    expect(productSearchRunner).toHaveBeenCalledWith({ '关键词或 SKU': '连衣裙' }, expect.any(Object));
    expect(draft.result).toMatchObject({
      productLinkStatus: { status: 'ready' },
      targetProduct: {
        platform: '1688',
        sourceCostCny: 26.8,
        suggestedSalePriceRub: 2400,
        estimatedCommissionRub: 384,
      },
    });
  });

  it('preserves a parsed target product when Ozon returns no market comparison rows', async () => {
    const productLinkParser = vi.fn(async () => ({
      platform: 'Ozon',
      platformKey: 'ozon-buyer',
      sourceProductId: '3876911440',
      productTitle: '测试商品',
      price: 1999,
      currency: 'RUB',
      lengthCm: 25,
      widthCm: 15,
      heightCm: 8,
      weightKg: 0.6,
    }));
    const productSearchRunner = vi.fn(async () => ({
      queryPlan: { input: '测试商品', query: '测试商品', aliases: [], categoryIds: [], queryMode: 'product' },
      snapshot: {
        captureMode: 'product-search',
        query: '测试商品',
        serverQueryMatched: false,
        observerVersion: '2.7.0',
        catalog: { endpointCount: 8 },
        datasets: [],
      },
    }));

    const draft = await runSmartToolDraftWithOzonBrowserData(
      { id: 'ozon-product-search', title: 'Ozon 商品搜索', skillProfile: { usageInputs: ['关键词或 SKU'] } },
      {
        '关键词或 SKU': '',
        '产品链接（可选）': 'https://www.ozon.ru/product/test-3876911440/',
      },
      { productLinkParser, productSearchRunner }
    );

    expect(draft.result).toMatchObject({
      status: 'browser_data_empty',
      productLinkStatus: { status: 'ready' },
      targetProduct: {
        sourceProductId: '3876911440',
        capturedPrice: 1999,
        suggestedSalePriceRub: 1999,
      },
    });
  });

  it('preserves a parsed target product when the follow-up Ozon market query fails', async () => {
    const productLinkParser = vi.fn(async () => ({
      platform: 'Ozon',
      platformKey: 'ozon-buyer',
      sourceProductId: '3876911440',
      productTitle: '测试商品',
      price: 1999,
      currency: 'RUB',
    }));
    const productSearchRunner = vi.fn(async () => {
      const error = new Error('OZON_PRODUCT_SEARCH_EMPTY');
      error.code = error.message;
      throw error;
    });

    const draft = await runSmartToolDraftWithOzonBrowserData(
      { id: 'ozon-product-search', title: 'Ozon 商品搜索', skillProfile: { usageInputs: ['关键词或 SKU'] } },
      {
        '关键词或 SKU': '',
        '产品链接（可选）': 'https://www.ozon.ru/product/test-3876911440/',
      },
      { productLinkParser, productSearchRunner }
    );

    expect(draft.result).toMatchObject({
      status: 'browser_data_empty',
      productLinkStatus: { status: 'ready' },
      targetProduct: {
        sourceProductId: '3876911440',
        capturedPrice: 1999,
      },
    });
    expect(draft.result.marketSearchWarning).toBeTruthy();
  });

  it('does not route the completed report analyzer through browser plugin snapshots', () => {
    const result = buildSmartToolOzonBrowserResult({
      toolId: 'ozon-skill-1688-channel-shopdata-analyzer',
      observerVersion: '2.4.0',
      catalog: { endpointCount: 4 },
      datasets: [
        {
          sequence: 1,
          dataset: 'traffic-conversion',
          quality: 'access-denied',
          records: [{ title: '不得使用' }],
        },
      ],
    });

    expect(result).toBeNull();
    expect(canUseSmartToolOzonBrowserData({ id: 'ozon-skill-1688-channel-shopdata-analyzer' })).toBe(false);
  });

  it('keeps generic Skills off the browser bridge and hands them to the async runtime', async () => {
    const command = vi.fn();
    const tool = {
      id: 'custom-local-skill',
      title: '自定义本地 Skill',
      skillProfile: { usageInputs: ['处理内容'] },
    };
    const draft = await runSmartToolDraftWithOzonBrowserData(tool, { 处理内容: '遥控汽车' }, { command });

    expect(canUseSmartToolOzonBrowserData(tool)).toBe(false);
    expect(command).not.toHaveBeenCalled();
    expect(draft.result.status).toBe('generic_runtime_required');
    expect(draft.result.summary).toContain('真实接口和模型调用由异步服务执行');
  });
});

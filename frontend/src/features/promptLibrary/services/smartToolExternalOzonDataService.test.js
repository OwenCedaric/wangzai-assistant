import { describe, expect, it, vi } from 'vitest';
import {
  buildSmartToolExternalOzonInput,
  canUseSmartToolExternalOzonData,
  enrichSmartToolExternalOzonProduct,
  readAllSmartToolExternalOzonPages,
  resolveSmartToolExternalOzonInput,
  runSmartToolDraftWithExternalOzonData,
  selectSmartToolExternalProfile,
  splitSmartToolExternalOzonInputs,
} from './smartToolExternalOzonDataService.js';

const tools = {
  shop: { id: 'linkfox-seerfar-ozon-shop-search', operation: 'ozon-shop-search', providerType: 'seerfar-open-api' },
  detail: { id: 'linkfox-seerfar-ozon-product-detail-search', operation: 'seerfar-ozon-product-detail-search', providerType: 'seerfar-open-api' },
  category: { id: 'linkfox-seerfar-ozon-category-search', operation: 'seerfar-ozon-category-search', providerType: 'seerfar-open-api' },
  report: { id: 'linkfox-seerfar-ozon-product-report-search', operation: 'seerfar-ozon-product-report-search', providerType: 'seerfar-open-api' },
  mining: { id: 'linkfox-seerfar-ozon-keyword-mining', operation: 'seerfar-ozon-keyword-mining', providerType: 'seerfar-open-api' },
  market: { id: 'linkfox-seerfar-ozon-market-keyword-search', operation: 'seerfar-ozon-market-keyword-search', providerType: 'seerfar-open-api' },
  back: { id: 'linkfox-seerfar-ozon-keyword-back-search', operation: 'seerfar-ozon-keyword-back-search', providerType: 'seerfar-open-api' },
};

describe('smartToolExternalOzonDataService', () => {
  it('builds the official read input for all seven tools', () => {
    expect(buildSmartToolExternalOzonInput(tools.shop, { input: 'https://www.ozon.ru/seller/demo-1275208/' }))
      .toMatchObject({ id: 1275208, page: { pageSize: 20 } });
    expect(buildSmartToolExternalOzonInput(tools.shop, { input: '-2' }))
      .toMatchObject({ id: -2, page: { pageSize: 20 } });
    expect(buildSmartToolExternalOzonInput(tools.detail, { input: 'https://www.ozon.ru/product/demo-175924376/' }))
      .toMatchObject({ sku: '175924376', dateRange: 'past_30_days', analysisMode: 'competitor' });
    expect(buildSmartToolExternalOzonInput(tools.detail, {
      分析对象: 'own',
      '商品 SKU 或链接': '175924376',
      '商品成本（₽）': '1200',
      '平台佣金率（%）': '15',
      '履约费用（₽/单）': '350',
      '税费率（%）': '6',
      '退货取消率（%）': '8.5',
    })).toMatchObject({
      sku: '175924376',
      analysisMode: 'own',
      manualData: {
        productCostRub: 1200,
        commissionRate: 15,
        fulfillmentFeeRub: 350,
        taxRate: 6,
        returnCancelRate: 8.5,
      },
    });
    expect(buildSmartToolExternalOzonInput(tools.category, { input: '15621031_200000933_93182' }))
      .toMatchObject({ categoryId: '15621031_200000933_93182' });
    expect(buildSmartToolExternalOzonInput(tools.report, { input: 'платье\n175924376' }))
      .toMatchObject({ keywords: ['платье'], skus: ['175924376'], variationsMerge: 0 });
    expect(buildSmartToolExternalOzonInput(tools.mining, { input: 'машинка на радиоуправлении' }))
      .toMatchObject({ keyword: 'машинка на радиоуправлении', matchType: 0 });
    expect(buildSmartToolExternalOzonInput(tools.market, { input: 'платье\nюбка' }))
      .toMatchObject({ keywords: ['платье', 'юбка'], matchType: 1 });
    expect(buildSmartToolExternalOzonInput(tools.back, { input: '4380710124\n175924376' }))
      .toMatchObject({ skuIds: ['4380710124', '175924376'], hasVariant: 0 });
  });

  it('maps every supported market-keyword Skill filter into the paid query input', () => {
    expect(buildSmartToolExternalOzonInput(tools.market, {
      input: [
        '连衣裙',
        '日期：2026-04-01',
        '类目：15621031_200000933_93182',
        '搜索量>=10000',
        '卖家数<=50',
        '平台：Ozon',
        '排序：月搜增长降序',
      ].join('\n'),
    })).toMatchObject({
      keywords: ['连衣裙'],
      categories: ['15621031_200000933_93182'],
      searchDate: '2026-04-01',
      searchVolume: { min: 10000 },
      sellers: { max: 50 },
      platformFilter: [0],
      matchType: 1,
      page: { pageSize: 100, orders: [{ field: 'count30GrowthRate', direction: 'DESC' }] },
    });
  });

  it('does not route the seven paid API tools through browser capture', () => {
    expect(Object.values(tools).every(canUseSmartToolExternalOzonData)).toBe(true);
    expect(canUseSmartToolExternalOzonData('ozon-product-search')).toBe(false);
  });

  it('maps a Chinese product idea to an exact Seerfar leaf category before the paid report query', async () => {
    const getCategoryTree = vi.fn(async ({ query }) => ({
      nodes: query === '遥控玩具' ? [{
        id: '17027488_17028981_95528',
        level: 3,
        cnTitle: '遥控玩具',
        title: 'Игрушка радиоуправляемая',
        hasChildren: false,
      }] : [],
    }));
    const original = buildSmartToolExternalOzonInput(tools.report, { input: '遥控车' });
    const resolved = await resolveSmartToolExternalOzonInput(tools.report, original, {
      getCategoryTree,
    });

    expect(resolved).toMatchObject({
      categoryIds: ['17027488_17028981_95528'],
      variationsMerge: 0,
    });
    expect(resolved).not.toHaveProperty('keywords');
    expect(getCategoryTree).toHaveBeenCalledWith(expect.objectContaining({ query: '遥控玩具' }));
  });

  it('keeps the original keyword when no exact leaf category is available', async () => {
    const original = buildSmartToolExternalOzonInput(tools.report, { input: '自定义商品词' });
    const resolved = await resolveSmartToolExternalOzonInput(tools.report, original, {
      getCategoryTree: vi.fn().mockResolvedValue({ nodes: [] }),
    });

    expect(resolved.keywords).toEqual(['自定义商品词']);
    expect(resolved).not.toHaveProperty('categoryIds');
  });

  it('maps Chinese keyword inputs for keyword mining and market search without touching SKU tools', async () => {
    await expect(resolveSmartToolExternalOzonInput(tools.mining, {
      keyword: '遥控车',
    }, {
      getCategoryTree: vi.fn().mockResolvedValue({ nodes: [{
        id: '17027488_17028981_95528',
        cnTitle: '遥控玩具',
        title: 'Игрушка радиоуправляемая',
        hasChildren: false,
      }] }),
    })).resolves.toMatchObject({
      keyword: 'машинки радиоуправляемые',
      _seerfarRecoveryCategories: ['17027488_17028981_95528'],
    });
    await expect(resolveSmartToolExternalOzonInput(tools.market, {
      keywords: ['连衣裙', '遥控车'],
    }, {
      getCategoryTree: vi.fn().mockResolvedValue({ nodes: [] }),
    })).resolves.toMatchObject({
      keywords: ['платье', 'машинки радиоуправляемые'],
    });
  });

  it('uses the resolved leaf category for the report request while preserving the user keyword in results', async () => {
    const readIntegration = vi.fn().mockResolvedValue({
      ok: true,
      provider: 'seerfar-open-api',
      operation: 'seerfar-ozon-product-report-search',
      data: {
        code: 200,
        data: {
          total: 1,
          records: [{ sku: 3522577361, title: 'Машинка на пульте управления', sales: 120 }],
        },
      },
    });
    const draft = await runSmartToolDraftWithExternalOzonData(tools.report, { input: '遥控车' }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-a', integrationType: 'seerfar-open-api', hasApiKey: true,
      }] }),
      getCategoryTree: vi.fn(async ({ query }) => ({
        nodes: query === '遥控玩具' ? [{
          id: '17027488_17028981_95528',
          level: 3,
          cnTitle: '遥控玩具',
          hasChildren: false,
        }] : [],
      })),
      readIntegration,
    });

    expect(readIntegration).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ categoryIds: ['17027488_17028981_95528'] }),
    }), { timeoutMs: 120000 });
    expect(readIntegration.mock.calls[0][0].input).not.toHaveProperty('keywords');
    expect(draft.result.summary).toContain('完整读取 1 条');
    expect(draft.result.sections.at(-1).rows[0]).toContain('关键词 遥控车');
  });

  it('reads and merges every API page with the provider maximum page size', async () => {
    const readIntegration = vi.fn(async ({ input }) => {
      const page = Number(input.page.page) || 1;
      const first = (page - 1) * 100 + 1;
      const last = Math.min(205, first + 99);
      return {
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-market-keyword-search',
        data: {
          code: 200,
          data: {
            total: 205,
            records: Array.from({ length: last - first + 1 }, (_, index) => ({
              query: `keyword-${first + index}`,
              searchVolume: 1000 - index,
            })),
          },
        },
      };
    });
    const progress = vi.fn();
    const { response, pageCount } = await readAllSmartToolExternalOzonPages({
      profileId: 'seerfar-a',
      operation: 'seerfar-ozon-market-keyword-search',
      input: { page: { page: 1, pageSize: 20, orders: [] } },
    }, { readIntegration, onProgress: progress });

    expect(pageCount).toBe(3);
    expect(readIntegration).toHaveBeenCalledTimes(3);
    expect(readIntegration.mock.calls.map(([request]) => request.input.page.page).sort()).toEqual([1, 2, 3]);
    expect(readIntegration.mock.calls.every(([request]) => request.input.page.pageSize === 100)).toBe(true);
    expect(response.data.data.records).toHaveLength(205);
    expect(response.data.data).toMatchObject({ allPagesLoaded: true, loadedPages: 3, hasNextPage: false });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ loaded: 205, total: 205 }));
  });

  it('returns the first page to the UI before the remaining full-data pages finish', async () => {
    let releaseRemainingPages;
    const remainingPages = new Promise((resolve) => {
      releaseRemainingPages = resolve;
    });
    const readIntegration = vi.fn(async ({ input }) => {
      const page = Number(input.page.page) || 1;
      if (page > 1) await remainingPages;
      return {
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-market-keyword-search',
        data: {
          code: 200,
          data: {
            total: 205,
            records: Array.from({ length: page === 3 ? 5 : 100 }, (_, index) => ({
              query: `page-${page}-keyword-${index + 1}`,
            })),
          },
        },
      };
    });
    const onFirstPage = vi.fn();
    const pending = readAllSmartToolExternalOzonPages({
      profileId: 'seerfar-a',
      operation: 'seerfar-ozon-market-keyword-search',
      input: { page: { page: 1, pageSize: 20, orders: [] } },
    }, { readIntegration, onFirstPage });

    await vi.waitFor(() => expect(onFirstPage).toHaveBeenCalledWith(expect.objectContaining({
      loaded: 100,
      total: 205,
      totalPages: 3,
    })));
    // The provider lane is intentionally serial: page 2 is in flight while
    // page 3 waits, preventing the real API from returning HTTP 429.
    expect(readIntegration).toHaveBeenCalledTimes(2);
    releaseRemainingPages();
    const result = await pending;
    expect(readIntegration).toHaveBeenCalledTimes(3);
    expect(result.response.data.data.records).toHaveLength(205);
  });

  it('serializes paid pages and retries a provider 429 without losing the full result', async () => {
    let activeRequests = 0;
    let secondPageAttempts = 0;
    const readIntegration = vi.fn(async ({ input }) => {
      const page = Number(input.page.page) || 1;
      activeRequests += 1;
      if (activeRequests > 1) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      try {
        if (page === 2) {
          secondPageAttempts += 1;
          if (secondPageAttempts === 1) {
            throw Object.assign(new Error('local-api 请求失败：429'), {
              status: 429,
              payload: { error: { status: 429, message: 'Too Many Requests' } },
            });
          }
        }
        return {
          ok: true,
          data: {
            code: 200,
            data: {
              total: 205,
              records: Array.from({ length: page === 3 ? 5 : 100 }, (_, index) => ({
                query: `page-${page}-keyword-${index + 1}`,
              })),
            },
          },
        };
      } finally {
        activeRequests -= 1;
      }
    });

    const pending = readAllSmartToolExternalOzonPages({
      profileId: 'seerfar-a',
      operation: 'seerfar-ozon-market-keyword-search',
      input: { page: { page: 1, pageSize: 100, orders: [] } },
    }, { readIntegration });
    const result = await pending;

    expect(secondPageAttempts).toBe(2);
    expect(result.response.data.data.records).toHaveLength(205);
    expect(result.response.data.data).toMatchObject({ allPagesLoaded: true, loadedPages: 3 });
  }, 10000);

  it('retries only the interrupted paid page after a transient network failure', async () => {
    const pageAttempts = new Map();
    const onRetry = vi.fn();
    const readIntegration = vi.fn(async ({ input }) => {
      const page = Number(input.page.page) || 1;
      pageAttempts.set(page, (pageAttempts.get(page) || 0) + 1);
      if (page === 2 && pageAttempts.get(page) === 1) {
        throw Object.assign(new Error('外部接口无法连接：fetch failed'), {
          code: 'EXTERNAL_INTEGRATION_NETWORK_FAILED',
          payload: {
            error: {
              code: 'EXTERNAL_INTEGRATION_NETWORK_FAILED',
              diagnostic: { causeCode: 'ECONNRESET' },
            },
          },
        });
      }
      return {
        ok: true,
        data: {
          code: 200,
          data: {
            total: 205,
            records: Array.from({ length: page === 3 ? 5 : 100 }, (_, index) => ({
              query: `page-${page}-keyword-${index + 1}`,
            })),
          },
        },
      };
    });

    const result = await readAllSmartToolExternalOzonPages({
      profileId: 'seerfar-a',
      operation: 'seerfar-ozon-market-keyword-search',
      input: { page: { page: 1, pageSize: 100, orders: [] } },
    }, {
      readIntegration,
      onRetry,
      retryBaseDelayMs: 0,
    });

    expect(Object.fromEntries(pageAttempts)).toEqual({ 1: 1, 2: 2, 3: 1 });
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith({
      page: 2,
      retry: 1,
      retryLimit: 2,
      delayMs: 0,
      reason: 'network',
      code: 'EXTERNAL_INTEGRATION_NETWORK_FAILED',
    });
    expect(result.response.data.data.records).toHaveLength(205);
    expect(result.response.data.data).toMatchObject({ allPagesLoaded: true, loadedPages: 3 });
  });

  it('caps an unfiltered market scan without pretending that all provider pages were loaded', async () => {
    const readIntegration = vi.fn(async ({ input }) => ({
      ok: true,
      data: {
        code: 200,
        data: {
          total: 540449,
          records: Array.from({ length: 100 }, (_, index) => ({
            query: `market-${input.page.page}-${index}`,
          })),
        },
      },
    }));

    const result = await readAllSmartToolExternalOzonPages({
      profileId: 'seerfar-a',
      operation: 'seerfar-ozon-market-keyword-search',
      input: { page: { page: 1, pageSize: 100, orders: [] } },
    }, { readIntegration, maxPages: 2 });

    expect(readIntegration).toHaveBeenCalledTimes(2);
    expect(result.response.data.data.records).toHaveLength(200);
    expect(result.response.data.data).toMatchObject({
      total: 540449,
      providerTotalPages: 5405,
      loadedPages: 2,
      allPagesLoaded: false,
      hasNextPage: true,
      truncated: true,
    });
  });

  it('does not retry permanent authentication failures', async () => {
    const readIntegration = vi.fn(async () => {
      throw Object.assign(new Error('API Key / Token 无效。'), {
        code: 'EXTERNAL_INTEGRATION_AUTH_FAILED',
        status: 401,
      });
    });

    await expect(readAllSmartToolExternalOzonPages({
      profileId: 'seerfar-a',
      operation: 'seerfar-ozon-market-keyword-search',
      input: { page: { page: 1, pageSize: 100, orders: [] } },
    }, { readIntegration, retryBaseDelayMs: 0 })).rejects.toMatchObject({
      code: 'EXTERNAL_INTEGRATION_AUTH_FAILED',
    });
    expect(readIntegration).toHaveBeenCalledOnce();
  });

  it('splits mixed SKU and category filters so they are merged as alternatives instead of an empty intersection', () => {
    expect(splitSmartToolExternalOzonInputs(tools.report, {
      skus: ['175924376'],
      categoryIds: ['17027488_17028981_95528'],
      variationsMerge: 0,
      page: { page: 1, pageSize: 100 },
    })).toEqual([
      expect.objectContaining({ skus: ['175924376'] }),
      expect.objectContaining({ categoryIds: ['17027488_17028981_95528'] }),
    ]);
  });

  it('selects a ready official profile without exposing its key', () => {
    expect(selectSmartToolExternalProfile([
      { id: 'old', integrationType: 'seerfar-open-api', hasApiKey: true, updatedAt: '2026-01-01' },
      { id: 'ready', integrationType: 'seerfar-open-api', hasApiKey: true, lastTestStatus: 'connected', lastTestAt: new Date().toISOString(), updatedAt: '2025-01-01' },
    ])?.id).toBe('ready');
  });

  it('executes one read and formats the returned records', async () => {
    const readIntegration = vi.fn().mockResolvedValue({
      ok: true,
      provider: 'seerfar-open-api',
      operation: 'seerfar-ozon-market-keyword-search',
      data: { code: 200, data: { total: 1, records: [{ query: 'платье', searchVolume: 12000 }] } },
    });
    const draft = await runSmartToolDraftWithExternalOzonData({
      ...tools.market,
      operation: 'stale-persisted-operation',
      providerType: 'stale-provider',
    }, { input: 'платье' }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-a', integrationType: 'seerfar-open-api', hasApiKey: true,
        lastTestStatus: 'connected', lastTestAt: new Date().toISOString(),
      }] }),
      getCategoryTree: vi.fn().mockResolvedValue({ nodes: [] }),
      readIntegration,
    });

    expect(readIntegration).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'seerfar-a',
      operation: 'seerfar-ozon-market-keyword-search',
    }), { timeoutMs: 120000 });
    expect(draft.result.status).toBe('ready');
    expect(draft.result.viewType).toBe('market-keywords');
    expect(draft.result.marketKeywordAnalysis.records[0])
      .toMatchObject({ query: 'платье', searchVolume: 12000 });
  });

  it('falls back to the product report when the detail index returns data null', async () => {
    const readIntegration = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-product-detail-search',
        data: { requestId: 'detail-empty', code: 200, msg: 'SUCCESS', data: null },
      })
      .mockResolvedValueOnce({
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-product-report-search',
        data: {
          code: 200,
          data: {
            records: [{
              sku: 4391289819,
              title: '筛选通道补回的商品',
              price: 699,
              monthlySales: 25,
              monthlyRevenue: 17475,
              stock: 11,
            }],
            total: 1,
            timeInterval: { min: '2026-06-30', max: '2026-07-29' },
          },
        },
      });

    const draft = await runSmartToolDraftWithExternalOzonData(tools.detail, {
      '商品 SKU 或链接': 'https://ozon.ru/product/4391289819',
      '商品成本（₽）': '200',
      '平台佣金率（%）': '10',
      '履约费用（₽/单）': '50',
      '税费率（%）': '5',
      '退货取消率（%）': '12',
    }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-a', integrationType: 'seerfar-open-api', hasApiKey: true,
      }] }),
      readIntegration,
    });

    expect(readIntegration).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operation: 'seerfar-ozon-product-detail-search',
      input: expect.objectContaining({ sku: '4391289819', dateRange: 'past_30_days' }),
    }), { timeoutMs: 120000 });
    expect(readIntegration.mock.calls[0][0].input).not.toHaveProperty('manualData');
    expect(readIntegration).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: 'seerfar-ozon-product-report-search',
      input: expect.objectContaining({ skus: ['4391289819'], variationsMerge: 0 }),
    }), { timeoutMs: 120000 });
    expect(draft.result).toMatchObject({ status: 'ready', returned: 1 });
    expect(draft.result.externalAnalysis.records[0]).toMatchObject({
      sku: '4391289819',
      price: 699,
      sales: 25,
      revenue: 17475,
      stock: 11,
      returnCancelRate: 12,
      returnCancelRateSource: '手动补充',
    });
    expect(draft.result.externalAnalysis.records[0].unitProfit.estimatedUnitProfitRub)
      .toBeCloseTo(344.15, 8);
  });

  it('falls back to the product report when the detail endpoint throws a server error', async () => {
    const readIntegration = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Server error'), {
        status: 502,
        payload: { error: { code: 'EXTERNAL_INTEGRATION_REMOTE_FAILED', status: 200 } },
      }))
      .mockResolvedValueOnce({
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-product-report-search',
        data: {
          code: 200,
          data: {
            records: [{ sku: 3559566970, title: '自有商品', monthlySales: 31, monthlyRevenue: 9300 }],
            total: 1,
          },
        },
      });

    const draft = await runSmartToolDraftWithExternalOzonData(tools.detail, {
      input: '3559566970',
    }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-a', integrationType: 'seerfar-open-api', hasApiKey: true,
      }] }),
      readIntegration,
      retryBaseDelayMs: 0,
    });

    expect(readIntegration).toHaveBeenCalledTimes(2);
    expect(readIntegration).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'seerfar-ozon-product-report-search',
      input: expect.objectContaining({ skus: ['3559566970'] }),
    }), { timeoutMs: 120000 });
    expect(draft.result).toMatchObject({ status: 'ready', returned: 1 });
    expect(draft.result.records[0]).toMatchObject({ sku: '3559566970', sales: 31, revenue: 9300 });
  });

  it('uses the matching Seerfar category directly when the official seed endpoint is empty', async () => {
    const readIntegration = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-market-keyword-search',
        data: {
          code: 200,
          data: {
            records: [
              { query: 'платье', searchVolume: 392841 },
              { query: 'сарафан женский летний', searchVolume: 280634 },
            ],
            total: 2,
          },
        },
      });

    const draft = await runSmartToolDraftWithExternalOzonData(tools.mining, { input: '连衣裙' }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-a', integrationType: 'seerfar-open-api', hasApiKey: true,
      }] }),
      getCategoryTree: vi.fn().mockResolvedValue({ nodes: [{
        id: '15621031_200000933_93182',
        cnTitle: '连衣裙',
        title: 'Платье',
        hasChildren: false,
      }] }),
      readIntegration,
    });

    expect(readIntegration).toHaveBeenCalledOnce();
    expect(readIntegration).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'seerfar-ozon-market-keyword-search',
      input: expect.objectContaining({ categories: ['15621031_200000933_93182'] }),
    }), { timeoutMs: 120000 });
    expect(readIntegration.mock.calls[0][0].input).not.toHaveProperty('keywords');
    expect(draft.result).toMatchObject({ status: 'ready', returned: 2 });
    expect(draft.result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ query: 'платье', relevancy: 100 }),
      expect.objectContaining({ query: 'сарафан женский летний', sfRecoverySource: 'market-category-recovery' }),
    ]));
  });

  it('routes a filtered market query through its category instead of the provider 500 path', async () => {
    const readIntegration = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-market-keyword-search',
        data: {
          code: 200,
          data: {
            records: [{ query: 'платье женское летнее', searchVolume: 785437 }],
            total: 1,
          },
        },
      });

    const draft = await runSmartToolDraftWithExternalOzonData(tools.market, { input: '连衣裙' }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-a', integrationType: 'seerfar-open-api', hasApiKey: true,
      }] }),
      getCategoryTree: vi.fn().mockResolvedValue({ nodes: [{
        id: '15621031_200000933_93182',
        cnTitle: '连衣裙',
        title: 'Платье',
        hasChildren: false,
      }] }),
      readIntegration,
    });

    expect(readIntegration).toHaveBeenCalledOnce();
    expect(readIntegration.mock.calls[0][0].input).toMatchObject({
      categories: ['15621031_200000933_93182'],
    });
    expect(draft.result).toMatchObject({ status: 'ready', returned: 1 });
    expect(draft.result.marketKeywordAnalysis.records[0])
      .toMatchObject({ query: 'платье женское летнее', searchVolume: 785437 });
  });

  it('returns a truthful empty state when both detail and SKU report have no record', async () => {
    const readIntegration = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-product-detail-search',
        data: { requestId: 'detail-empty', code: 200, msg: 'SUCCESS', data: null },
      })
      .mockResolvedValueOnce({
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-product-report-search',
        data: { code: 200, data: { records: [], total: 0 } },
      });

    const draft = await runSmartToolDraftWithExternalOzonData(tools.detail, {
      input: '4391289819',
    }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-a', integrationType: 'seerfar-open-api', hasApiKey: true,
      }] }),
      readIntegration,
    });

    expect(readIntegration).toHaveBeenCalledTimes(2);
    expect(draft.result).toMatchObject({
      status: 'empty',
      statusLabel: '没有查到数据',
      returned: 0,
    });
    expect(draft.result.summary).toContain('SKU 4391289819');
  });

  it('enriches a clicked SF Top product with the complete product-detail response', async () => {
    const readIntegration = vi.fn().mockResolvedValue({
      ok: true,
      provider: 'seerfar-open-api',
      operation: 'seerfar-ozon-product-detail-search',
      data: {
        code: 200,
        data: {
          product: {
            sku: 2962820304,
            title: '商品详情',
            price: 599,
            brandName: 'Brand A',
            sellerName: 'Seller A',
            imageUrls: ['https://cdn.example.test/product.jpg'],
            reviewRating: 4.8,
            reviewCount: 123,
            sessionCount: 900,
            sessionCountSearch: 700,
            convToCartPdp: 12.3,
            convToCartSearch: 8.4,
            convViewToOrder: 4.2,
            returnCancellationRate: 3.1,
            fulfillment: ['FBO'],
            weight: 85,
            dimension: '10 × 8 × 2 cm',
            upDays: 120,
          },
          totalSales: 456,
          totalRevenue: 273144,
          dailySales: 15.2,
          stock: 88,
          salesTrendVOList: [{ date: '2026-07-30', sales: 15, revenue: 8985 }],
        },
      },
    });
    const product = await enrichSmartToolExternalOzonProduct({
      sku: '2962820304',
      sfEnrich: true,
      sfSource: 'seerfar-open-api',
    }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-detail',
        integrationType: 'seerfar-open-api',
        hasApiKey: true,
        lastTestStatus: 'connected',
        lastTestAt: new Date().toISOString(),
      }] }),
      readIntegration,
    });

    expect(readIntegration).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'seerfar-ozon-product-detail-search',
      input: expect.objectContaining({ sku: '2962820304', dateRange: 'past_30_days' }),
    }), { timeoutMs: 120000 });
    expect(product).toMatchObject({
      sku: '2962820304',
      price: 599,
      sales: 456,
      revenue: 273144,
      stock: 88,
      brand: 'Brand A',
      seller: 'Seller A',
      rating: 4.8,
      reviews: 123,
      productCardViews: 900,
      searchCatalogViews: 700,
      packageDimensions: '10 × 8 × 2 cm',
      packageWeight: 85,
    });
  });

  it('keeps both SF platforms in the data model and applies an optional client-side platform filter', async () => {
    const draft = await runSmartToolDraftWithExternalOzonData(tools.market, {
      input: 'платье\n平台：Ozon',
    }, {
      listProfiles: vi.fn().mockResolvedValue({ profiles: [{
        id: 'seerfar-a', integrationType: 'seerfar-open-api', hasApiKey: true,
        lastTestStatus: 'connected', lastTestAt: new Date().toISOString(),
      }] }),
      getCategoryTree: vi.fn().mockResolvedValue({ nodes: [] }),
      readIntegration: vi.fn().mockResolvedValue({
        ok: true,
        provider: 'seerfar-open-api',
        operation: 'seerfar-ozon-market-keyword-search',
        data: {
          code: 200,
          data: {
            total: 2,
            records: [
              { id: 'ozon-row', query: 'платье', platform: 0, searchVolume: 12000 },
              { id: 'wb-row', query: 'платье', platform: 1, searchVolume: 9000 },
            ],
          },
        },
      }),
    });

    expect(draft.result.marketKeywordAnalysis.records).toEqual([
      expect.objectContaining({ id: 'ozon-row', platform: 0 }),
    ]);
    expect(draft.result.marketKeywordAnalysis.platformCounts).toEqual({ ozon: 1, wildberries: 0 });
  });

  it('rejects more than ten product references instead of silently dropping them', () => {
    const value = Array.from({ length: 11 }, (_, index) => String(175924376 + index)).join('\n');
    expect(() => buildSmartToolExternalOzonInput(tools.report, { input: value }))
      .toThrow('最多填写 10 个 SKU');
  });

  it('rejects an unrelated URL before a paid query can be sent', () => {
    expect(() => buildSmartToolExternalOzonInput(tools.detail, {
      input: 'https://example.com/product/demo-175924376/',
    })).toThrow('Ozon 商品链接');
    expect(() => buildSmartToolExternalOzonInput(tools.report, {
      input: 'https://example.com/product/demo-175924376/',
    })).toThrow('没有识别到 SKU');
  });
});

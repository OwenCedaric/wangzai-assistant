import { describe, expect, it, vi } from 'vitest';
import {
  searchDataAnalysisMarketBrowserData,
  syncDataAnalysisMarketBrowserData,
} from './dataAnalysisMarketBrowserService.js';
import {
  OZON_MARKET_CAPTURE_ROUTES,
  OZON_MARKET_PAGINATION_POLICIES,
} from '../../../services/ozonMarketCapture/marketCaptureRoutes.js';
import { readNormalizedDatasetWindow } from '../../../services/ozonMarketCapture/marketCaptureTransport.js';
import { createDataAnalysisMarketCaptureAccumulator } from '../lib/dataAnalysisMarketAccumulator.js';
import { normalizeDataAnalysisMarketBrowserSnapshot } from '../lib/dataAnalysisMarketSnapshot.js';

describe('dataAnalysisMarketBrowserService', () => {
  it('reads every normalized observer batch instead of stopping at the first 20 responses', async () => {
    const datasets = Array.from({ length: 45 }, (_, index) => ({ sequence: index + 1, dataset: 'keywords' }));
    const command = vi.fn(async ({ afterSequence, limit }) => ({
      result: { datasets: datasets.filter((dataset) => dataset.sequence > afterSequence).slice(0, limit) },
    }));

    const result = await readNormalizedDatasetWindow(command, 'ozon-tab', 0);
    expect(result).toHaveLength(45);
    expect(result.at(-1).sequence).toBe(45);
    expect(command).toHaveBeenCalledTimes(3);
  });

  it('includes the hidden Ozon products route in the background polling loop', () => {
    expect(OZON_MARKET_CAPTURE_ROUTES).toContainEqual({
      id: 'ozon-bestsellers',
      url: 'https://seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers',
      datasets: ['product-performance'],
      preferProbe: true,
      paginationMode: 'complete',
      timeoutMs: 10_000,
      settleMs: 3_000,
      probes: [{
        path: '/api/site/seller-analytics/what_to_sell/data/v3',
        method: 'POST',
        origin: 'https://api.seller.ozon.ru',
        body: { limit: 50, offset: 0, filter: { period: 'monthly', categories: [] } },
      }],
    });
    expect(OZON_MARKET_CAPTURE_ROUTES).toContainEqual(expect.objectContaining({
      id: 'market-bestsellers',
      preferProbe: true,
      probes: [expect.objectContaining({
        path: '/api/site/exa-products-api/missing_items',
        body: expect.objectContaining({ limit: '10', offset: '0' }),
      })],
    }));
    expect(OZON_MARKET_CAPTURE_ROUTES.map((route) => route.id)).not.toEqual(expect.arrayContaining([
      'categories-comparison',
      'categories-comparison-brands',
      'trends',
      'competitive-position',
    ]));
  });

  it('builds competitor, search and opportunity sections from confirmed plugin data', () => {
    const result = normalizeDataAnalysisMarketBrowserSnapshot({
      observerVersion: '2.4.0',
      capturedAt: '2026-07-22T03:00:00.000Z',
      catalog: { endpointCount: 14 },
      tabId: 'ozon-tab',
      tab: { accountId: 'ozon-profile-a' },
      datasets: [
        {
          sequence: 3,
          dataset: 'missing-items',
          quality: 'confirmed-data',
          capturedAt: '2026-07-22T03:00:00.000Z',
          records: [{ id: 'm-1', title: '缺货遥控汽车', category: 'Игрушки', stock: 0 }],
        },
        {
          sequence: 2,
          dataset: 'keywords',
          quality: 'confirmed-data',
          capturedAt: '2026-07-22T02:00:00.000Z',
          records: [{ id: 'k-1', title: 'радиоуправляемая машина', views: 12000, conversion: 3.2 }],
        },
        {
          sequence: 1,
          dataset: 'market-products',
          quality: 'confirmed-data',
          capturedAt: '2026-07-22T01:00:00.000Z',
          records: [
            { id: '3568698657', title: 'Радиоуправляемая машина', category: 'Игрушки', brand: 'A', price: 1999, sales: 42, revenue: 72435232.79 },
            { id: '2', title: 'Грузовик', category: 'Игрушки', brand: 'B', price: 999, sales: 18 },
          ],
        },
        {
          sequence: 4,
          dataset: 'trends',
          quality: 'access-denied',
          records: [{ id: 'forbidden', title: '不得进入结果' }],
        },
        {
          sequence: 5,
          dataset: 'subscription-status',
          quality: 'confirmed-data',
          capturedAt: '2026-07-22T03:10:00.000Z',
          records: [{ raw: { subscription: 'PREMIUM_LITE', available: false } }],
        },
      ],
    });

    expect(result).toMatchObject({
      status: 'ready',
      statusLabel: '已接入 3 个真实数据集',
      observerVersion: '2.4.0',
      endpointCount: 14,
      confirmedDatasetCount: 3,
      profileId: 'ozon-profile-a',
    });
    expect(result.sections.competitor).toMatchObject({ status: 'ready', recordCount: 2 });
    expect(result.sections.search).toMatchObject({ status: 'ready', recordCount: 1 });
    expect(result.sections.opportunity).toMatchObject({ status: 'ready', recordCount: 3 });
    expect(result.sections.search.records[0].title).toBe('радиоуправляемая машина');
    expect(JSON.stringify(result)).not.toContain('不得进入结果');
    expect(result.datasetViews.map((dataset) => dataset.dataset)).not.toContain('subscription-status');
    expect(result.subscriptionStatus).toMatchObject({ recordCount: 1 });
  });

  it('navigates the hidden Ozon search page, replays the observed keyword recipe, then returns confirmed datasets', async () => {
    const calls = [];
    const command = async (input) => {
      calls.push(input);
      if (input.command === 'state') return { tabs: [{ tabId: 'ozon-tab', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/analytics/graphs' }] };
      if (input.command === 'ozon-data-status') return { result: { ready: true, installed: true, enabled: true, lastSequence: 5 } };
      if (input.command === 'navigate') return { ok: true };
      if (input.command === 'ozon-data-search') {
        return { result: { ready: true, capturedSequence: 7, quality: 'confirmed-data', recordCount: 1 } };
      }
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 9 } };
      if (input.command === 'ozon-data-normalize') {
        if (input.afterSequence === 5) {
          return { result: { datasets: [
            { sequence: 6, dataset: 'keywords', quality: 'confirmed-data', records: [{ id: 'recipe', title: '旧词' }] },
            { sequence: 8, dataset: 'market-products', quality: 'confirmed-data', records: [{ id: 'sku-1', title: '遥控汽车' }] },
          ] } };
        }
        if (input.afterSequence === 6) {
          return { result: { datasets: [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', records: [{ id: 'kw-1', title: '遥控汽车' }] }] } };
        }
        return { result: { datasets: [
          { sequence: 7, dataset: 'keywords', quality: 'confirmed-data', capturedAt: '2026-07-22T03:00:00.000Z', records: [{ id: 'kw-1', title: '遥控汽车' }] },
          { sequence: 8, dataset: 'market-products', quality: 'confirmed-data', records: [{ id: 'sku-1', title: '遥控汽车' }] },
        ] } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    const result = await searchDataAnalysisMarketBrowserData('遥控汽车', { command, background: false, searchTimeoutMs: 0, searchResultTimeoutMs: 0 });
    expect(result.query).toBe('遥控汽车');
    expect(result.datasetViews.map((item) => item.dataset)).toEqual(['keywords', 'market-products']);
    expect(calls.findIndex((item) => item.command === 'navigate')).toBeLessThan(calls.findIndex((item) => item.command === 'ozon-data-search'));
    expect(calls.find((item) => item.command === 'ozon-data-search')).toMatchObject({ sourceSequence: 6, query: '遥控汽车' });
  });

  it('automatically opens the default Ozon market page and returns its no-search datasets', async () => {
    const calls = [];
    const command = async (input) => {
      calls.push(input);
      if (input.command === 'state') return { tabs: [{ tabId: 'ozon-tab', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/dashboard/main' }] };
      if (input.command === 'ozon-data-status') return { result: { ready: true, installed: true, enabled: true, lastSequence: 0 } };
      if (input.command === 'navigate') return { ok: true };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 6 } };
      if (input.command === 'ozon-data-normalize') return { result: { datasets: [{
        sequence: 1,
        dataset: 'market-products',
        quality: 'confirmed-data',
        capturedAt: '2026-07-22T03:00:00.000Z',
        records: [{ id: 'category-1', title: '运动鞋', revenue: 13349422463, sales: 3125187, price: 4272 }],
      }] } };
      throw new Error(`unexpected command: ${input.command}`);
    };

    const result = await syncDataAnalysisMarketBrowserData({ command, background: false, defaultTimeoutMs: 0 });
    expect(result.datasetViews[0]).toMatchObject({ dataset: 'market-products', recordCount: 1 });
    expect(calls.find((item) => item.command === 'navigate').url).toContain('/market-bestsellers');
  });

  it('resets the observer cursor when navigation creates a new page runtime', async () => {
    const normalizeAfterSequences = [];
    let navigated = false;
    const command = async (input) => {
      if (input.command === 'state') {
        return { tabs: [{ tabId: 'ozon-tab', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/analytics/graphs' }] };
      }
      if (input.command === 'navigate') {
        navigated = true;
        return { ok: true };
      }
      if (input.command === 'ozon-data-status') {
        return { result: { ready: true, installed: true, enabled: true, lastSequence: navigated ? 3 : 87 } };
      }
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      if (input.command === 'ozon-data-normalize') {
        normalizeAfterSequences.push(input.afterSequence);
        return { result: { datasets: input.afterSequence === 0 ? [{
          sequence: 1,
          dataset: 'missing-items',
          endpoint: '/api/site/exa-products-api/missing_items',
          quality: 'confirmed-data',
          records: [{ id: 'fresh-page-row', title: '新页面第一批数据' }],
        }] : [] } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    const result = await syncDataAnalysisMarketBrowserData({
      command,
      background: false,
      defaultTimeoutMs: 0,
      captureSettleMs: 0,
    });

    expect(normalizeAfterSequences).toEqual(expect.arrayContaining([0]));
    expect(result.datasetViews.find((dataset) => dataset.dataset === 'missing-items')).toMatchObject({
      recordCount: 1,
    });
  });

  it('waits for the CEF tab URL to commit before reading the new route observer', async () => {
    let stateReadsAfterNavigate = 0;
    let navigated = false;
    let normalizedBeforeCommit = false;
    const targetUrl = 'https://seller.ozon.ru/app/analytics/what-to-sell/market-bestsellers';
    const state = (url) => ({
      tabs: [{ tabId: 'ozon-tab', browserRole: 'market-collector', background: true, loading: false, url }],
    });
    const command = async (input) => {
      if (input.command === 'state') {
        if (!navigated) return state('https://seller.ozon.ru/app/dashboard/main');
        stateReadsAfterNavigate += 1;
        return state(stateReadsAfterNavigate >= 2 ? targetUrl : 'https://seller.ozon.ru/app/dashboard/main');
      }
      if (input.command === 'navigate') {
        navigated = true;
        return state('https://seller.ozon.ru/app/dashboard/main');
      }
      if (input.command === 'ozon-data-status') return { result: { ready: true, installed: true, enabled: true, lastSequence: 0 } };
      if (input.command === 'ozon-data-probe') return { result: { quality: 'empty', recordCount: 0, capturedSequence: 0 } };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      if (input.command === 'ozon-data-normalize') {
        if (stateReadsAfterNavigate < 2) normalizedBeforeCommit = true;
        return { result: { datasets: [{
          sequence: 1,
          dataset: 'missing-items',
          endpoint: '/api/site/exa-products-api/missing_items',
          quality: 'confirmed-data',
          records: [{ id: 'missing-1', title: '真实新页面数据' }],
        }] } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    const result = await syncDataAnalysisMarketBrowserData({
      command,
      background: false,
      defaultTimeoutMs: 0,
      captureSettleMs: 0,
      navigationPollIntervalMs: 1,
    });

    expect(stateReadsAfterNavigate).toBeGreaterThanOrEqual(2);
    expect(normalizedBeforeCommit).toBe(false);
    expect(result.datasetViews.find((dataset) => dataset.dataset === 'missing-items')).toMatchObject({ recordCount: 1 });
  });

  it('publishes the audited default route and expands all replayed pages', async () => {
    const calls = [];
    let paginated = false;
    let resolveExpanded;
    const expandedReady = new Promise((resolve) => {
      resolveExpanded = resolve;
    });
    const command = async (input) => {
      calls.push(input);
      if (input.command === 'state') return { tabs: [{ tabId: 'ozon-tab', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/dashboard/main' }] };
      if (input.command === 'ozon-data-status') return { result: { ready: true, installed: true, enabled: true, lastSequence: 0 } };
      if (input.command === 'navigate') return { ok: true };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      if (input.command === 'ozon-data-paginate') {
        paginated = true;
        return { result: {
          pagesFetched: 2,
          attemptedPages: 2,
          recordsFetched: 2,
          totalRecordCount: 4,
          stopReason: 'max-pages-reached',
          resumeSourceSequence: 3,
        } };
      }
      if (input.command === 'ozon-data-normalize') {
        const datasets = [{
          sequence: 1,
          dataset: 'missing-items',
          endpoint: '/api/site/exa-products-api/missing_items',
          quality: 'confirmed-data',
          records: [{ id: 'row-1', title: '第一页 1' }, { id: 'row-2', title: '第一页 2' }],
        }];
        if (paginated) datasets.push(
          { sequence: 2, dataset: 'missing-items', quality: 'confirmed-data', records: [{ id: 'row-3', title: '第二页' }] },
          { sequence: 3, dataset: 'missing-items', quality: 'confirmed-data', records: [{ id: 'row-4', title: '第三页' }] },
        );
        return { result: { datasets } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    const initial = await syncDataAnalysisMarketBrowserData({
      command,
      background: true,
      scanRoutes: false,
      defaultTimeoutMs: 0,
      paginationMaxPages: 2,
      paginationBatchPages: 2,
      onProgress: (snapshot, route) => {
        if (route.phase === 'pagination-complete') resolveExpanded(snapshot);
      },
    });
    const expanded = await expandedReady;

    expect(initial.datasetViews.find((item) => item.dataset === 'missing-items').recordCount).toBe(2);
    expect(expanded.datasetViews.find((item) => item.dataset === 'missing-items').recordCount).toBe(4);
    expect(expanded.pagination).toMatchObject({
      pagesFetched: 2,
      recordsFetched: 2,
      complete: false,
      safeToPersist: true,
      incompleteDatasets: ['missing-items'],
    });
    expect(calls.find((item) => item.command === 'ozon-data-paginate')).toMatchObject({
      sourceSequence: 1,
      maxPages: 2,
    });
  });

  it('replays the exact audited probe instead of a later drifting natural request', async () => {
    const paginationSources = [];
    let probed = false;
    const endpoint = '/api/site/exa-products-api/missing_items';
    const command = async (input) => {
      if (input.command === 'state') {
        return {
          tabs: [{
            tabId: 'ozon-tab',
            browserRole: 'market-collector',
            background: true,
            url: 'https://seller.ozon.ru/app/dashboard/main',
          }],
        };
      }
      if (input.command === 'ozon-data-status') {
        return { result: { ready: true, installed: true, enabled: true, lastSequence: 0 } };
      }
      if (input.command === 'navigate') return { ok: true };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      if (input.command === 'ozon-data-probe') {
        probed = true;
        return { result: { quality: 'confirmed-data', capturedSequence: 7, recordCount: 1 } };
      }
      if (input.command === 'ozon-data-paginate') {
        paginationSources.push(input.sourceSequence);
        return { result: {
          pagesFetched: 0,
          attemptedPages: 1,
          recordsFetched: 0,
          totalRecordCount: 1,
          stopReason: 'short-page',
        } };
      }
      if (input.command === 'ozon-data-normalize') {
        if (!probed) {
          return { result: { datasets: [{
            sequence: 1,
            dataset: 'missing-items',
            endpoint,
            quality: 'confirmed-data',
            records: [{ id: 'natural-before-probe' }],
          }] } };
        }
        return { result: { datasets: [{
          sequence: 7,
          dataset: 'missing-items',
          endpoint,
          quality: 'confirmed-data',
          records: [{ id: 'exact-probe-page' }],
        }, {
          sequence: 8,
          dataset: 'missing-items',
          endpoint,
          quality: 'confirmed-data',
          records: [{ id: 'later-natural-request' }],
        }] } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    await syncDataAnalysisMarketBrowserData({
      command,
      background: true,
      awaitBackground: true,
      scanRoutes: false,
      defaultTimeoutMs: 0,
      probeTimeoutMs: 0,
      paginationMaxPages: 1,
      paginationBatchPages: 1,
    });

    expect(paginationSources).toEqual([7]);
  });

  it('waits for the route request burst and paginates every safe recipe', async () => {
    const paginationSources = [];
    let normalizeReads = 0;
    let paginated = false;
    let resolveExpanded;
    const expandedReady = new Promise((resolve) => {
      resolveExpanded = resolve;
    });
    const command = async (input) => {
      if (input.command === 'state') return { tabs: [{ tabId: 'ozon-tab', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/dashboard/main' }] };
      if (input.command === 'ozon-data-status') return { result: { ready: true, installed: true, enabled: true, lastSequence: 0 } };
      if (input.command === 'navigate') return { ok: true };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 2 } };
      if (input.command === 'ozon-data-paginate') {
        paginationSources.push(input.sourceSequence);
        if (input.sourceSequence === 1) throw new Error('OZON_DATA_OBSERVER_PAGINATION_UNAVAILABLE');
        paginated = true;
        return { result: {
          pagesFetched: 1,
          attemptedPages: 1,
          recordsFetched: 1,
          totalRecordCount: 2,
          stopReason: 'short-page',
        } };
      }
      if (input.command === 'ozon-data-normalize') {
        normalizeReads += 1;
        const datasets = [{
          sequence: 1,
          dataset: 'missing-items',
          endpoint: '/api/site/exa-products-api/missing_items/totals',
          quality: 'confirmed-data',
          records: [{ id: 'totals', title: '先返回但不可翻页' }],
        }];
        if (normalizeReads > 1) datasets.push({
          sequence: 2,
          dataset: 'missing-items',
          endpoint: '/api/site/exa-products-api/missing_items',
          quality: 'confirmed-data',
          records: [{ id: 'row-1', title: '稍后返回且可翻页' }],
        });
        if (paginated) datasets.push({
          sequence: 3,
          dataset: 'missing-items',
          endpoint: '/api/site/exa-products-api/missing_items',
          quality: 'confirmed-data',
          records: [{ id: 'row-2', title: '翻页结果' }],
        });
        return { result: { datasets } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    await syncDataAnalysisMarketBrowserData({
      command,
      background: true,
      scanRoutes: false,
      defaultTimeoutMs: 50,
      pollIntervalMs: 1,
      captureSettleMs: 2,
      paginationMaxPages: 1,
      paginationBatchPages: 1,
      onProgress: (snapshot, route) => {
        if (route.phase === 'pagination-complete') resolveExpanded(snapshot);
      },
    });
    const expanded = await expandedReady;

    expect(paginationSources).toEqual([2, 1]);
    expect(expanded.datasetViews.find((item) => item.dataset === 'missing-items').recordCount).toBe(3);
    expect(expanded.pagination).toMatchObject({
      pagesFetched: 1,
      recordsFetched: 1,
      complete: true,
      safeToPersist: true,
    });
  });

  it('keeps Ozon product-performance rows separate and merges paginated records', () => {
    const result = normalizeDataAnalysisMarketBrowserSnapshot({
      capturedAt: '2026-07-22T14:00:00.000Z',
      datasets: [
        {
          sequence: 20,
          dataset: 'product-performance',
          endpoint: '/api/site/seller-analytics/what_to_sell/data/v3',
          quality: 'confirmed-data',
          capturedAt: '2026-07-22T13:59:00.000Z',
          records: [{ id: 'sku-1', title: '遥控汽车', orderAmount: 1200, orderedProducts: 3, averagePurchasePrice: 400 }],
        },
        {
          sequence: 21,
          dataset: 'product-performance',
          endpoint: '/api/site/seller-analytics/what_to_sell/data/v3',
          quality: 'confirmed-data',
          capturedAt: '2026-07-22T14:00:00.000Z',
          records: [
            { id: 'sku-1', title: '遥控汽车', orderAmount: 1200, orderedProducts: 3, averagePurchasePrice: 400 },
            { id: 'sku-2', title: '遥控越野车', orderAmount: 2500, orderedProducts: 5, averagePurchasePrice: 500 },
          ],
        },
      ],
    });

    const dataset = result.datasetViews.find((item) => item.dataset === 'product-performance');
    expect(dataset).toMatchObject({ recordCount: 2, status: 'ready' });
    expect(dataset.records.map((record) => record.id)).toEqual(['sku-1', 'sku-2']);
    expect(dataset.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '订购金额', value: 3700, kind: 'money' }),
      expect.objectContaining({ label: '已订购商品', value: 8 }),
    ]));
  });

  it('uses the audited product-performance probe as the full pagination source', async () => {
    const probeOffsets = [];
    const paginationSources = [];
    let paginated = false;
    let onProductsPage = false;
    let resolveExpanded;
    const expandedReady = new Promise((resolve) => { resolveExpanded = resolve; });
    const excludedRouteIds = OZON_MARKET_CAPTURE_ROUTES
      .map((route) => route.id)
      .filter((id) => id !== 'ozon-bestsellers');
    const command = async (input) => {
      if (input.command === 'state') return { tabs: [{ tabId: 'ozon-tab', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/dashboard/main' }] };
      if (input.command === 'ozon-data-status') return { result: { ready: true, installed: true, enabled: true, lastSequence: 0 } };
      if (input.command === 'navigate') {
        onProductsPage = String(input.url).includes('/ozon-bestsellers');
        return { ok: true };
      }
      if (input.command === 'ozon-data-probe') {
        const offset = Number(input.body?.offset) || 0;
        probeOffsets.push(offset);
        return { result: { quality: 'confirmed-data', capturedSequence: 1, recordCount: 50 } };
      }
      if (input.command === 'ozon-data-paginate') {
        paginationSources.push(input.sourceSequence);
        paginated = true;
        return { result: {
          paginationKind: 'offset',
          pagesFetched: 2,
          attemptedPages: 2,
          recordsFetched: 70,
          totalRecordCount: 120,
          stopReason: 'short-page',
        } };
      }
      if (input.command === 'ozon-data-normalize') {
        if (!onProductsPage || !probeOffsets.length) return { result: { datasets: [] } };
        const datasets = [{
          sequence: 1,
          dataset: 'product-performance',
          endpoint: '/api/site/seller-analytics/what_to_sell/data/v3',
          quality: 'confirmed-data',
          records: Array.from({ length: 50 }, (_, rowIndex) => ({
            id: `sku-${rowIndex}`,
            title: `商品-${rowIndex}`,
            orderAmount: 100 + rowIndex,
            orderedProducts: 1,
          })),
        }];
        if (paginated) datasets.push({
          sequence: 2,
          dataset: 'product-performance',
          endpoint: '/api/site/seller-analytics/what_to_sell/data/v3',
          quality: 'confirmed-data',
          records: Array.from({ length: 50 }, (_, rowIndex) => ({ id: `sku-${50 + rowIndex}`, title: `商品-${50 + rowIndex}` })),
        }, {
          sequence: 3,
          dataset: 'product-performance',
          endpoint: '/api/site/seller-analytics/what_to_sell/data/v3',
          quality: 'confirmed-data',
          records: Array.from({ length: 20 }, (_, rowIndex) => ({ id: `sku-${100 + rowIndex}`, title: `商品-${100 + rowIndex}` })),
        });
        return { result: { datasets } };
      }
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      throw new Error(`unexpected command: ${input.command}`);
    };

    await syncDataAnalysisMarketBrowserData({
      command,
      background: true,
      awaitBackground: true,
      defaultTimeoutMs: 0,
      routeTimeoutMs: 0,
      captureSettleMs: 0,
      excludedRouteIds,
      onProgress: (snapshot, route) => {
        if (route.phase === 'pagination-complete') resolveExpanded(snapshot);
      },
    });
    const expanded = await expandedReady;
    // The default missing-items route and the product-performance route each
    // run their own audited probe.  Product performance must no longer borrow
    // a drifting natural request merely because it already contains metrics.
    expect(probeOffsets).toEqual([0, 0]);
    expect(paginationSources).toEqual([1]);
    expect(expanded.datasetViews.find((dataset) => dataset.dataset === 'product-performance')).toMatchObject({ recordCount: 120 });
    expect(expanded.pagination).toMatchObject({
      pagesFetched: 2,
      recordsFetched: 70,
      complete: true,
      safeToPersist: true,
      incompleteDatasets: [],
    });
  }, 20_000);

  it('keeps every earlier pagination batch after observer eviction and does not overwrite another category', () => {
    const accumulator = createDataAnalysisMarketCaptureAccumulator();
    const snapshot = (datasets) => ({
      observerVersion: '2.6.0',
      tabId: 'ozon-tab',
      tab: { accountId: 'ozon-profile-a' },
      catalog: { endpointCount: 8 },
      capturedAt: '2026-07-22T16:00:00.000Z',
      datasets,
    });
    accumulator.add(snapshot([{
      sequence: 1,
      dataset: 'keywords',
      endpoint: '/api/site/searchteam/Stats/queries/search/v2',
      quality: 'confirmed-data',
      records: [{ id: 'keyword-1', title: '遥控汽车' }],
    }, {
      sequence: 2,
      dataset: 'missing-items',
      endpoint: '/api/site/exa-products-api/missing_items',
      quality: 'confirmed-data',
      records: Array.from({ length: 10 }, (_, index) => ({ id: `missing-${index}`, title: `机会-${index}` })),
    }]));

    for (let batch = 0; batch < 10; batch += 1) {
      accumulator.add(snapshot(Array.from({ length: 10 }, (_, page) => {
        const pageIndex = 1 + batch * 10 + page;
        const rowStart = pageIndex * 10;
        return {
          sequence: 3 + batch * 10 + page,
          dataset: 'missing-items',
          endpoint: '/api/site/exa-products-api/missing_items',
          quality: 'confirmed-data',
          records: Array.from({ length: pageIndex === 99 ? 0 : 10 }, (_, index) => ({
            id: `missing-${rowStart + index}`,
            title: `机会-${rowStart + index}`,
          })),
        };
      })));
    }

    const result = accumulator.snapshot();
    expect(OZON_MARKET_PAGINATION_POLICIES['missing-items']).toMatchObject({ maxPages: 250, batchPages: 5 });
    expect(result.datasetViews.find((dataset) => dataset.dataset === 'missing-items')).toMatchObject({
      recordCount: 1000,
      datasetCount: 100,
    });
    expect(result.datasetViews.find((dataset) => dataset.dataset === 'keywords')).toMatchObject({ recordCount: 1 });
  });

  it('reuses the latest retained keyword request when navigation does not emit a fresh keyword response', async () => {
    const paginationSources = [];
    const excludedRouteIds = OZON_MARKET_CAPTURE_ROUTES
      .map((route) => route.id)
      .filter((id) => id !== 'all-queries');
    const command = async (input) => {
      if (input.command === 'state') return { tabs: [{ tabId: 'ozon-tab', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/dashboard/main' }] };
      if (input.command === 'ozon-data-status') return { result: { ready: true, installed: true, enabled: true, lastSequence: 100 } };
      if (input.command === 'navigate') return { ok: true };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      if (input.command === 'ozon-data-normalize') {
        return { result: { datasets: Number(input.afterSequence) === 0 ? [{
          sequence: 5,
          dataset: 'keywords',
          endpoint: '/api/site/searchteam/Stats/queries/search/v2',
          quality: 'confirmed-data',
          recordCount: 50,
          records: [{ id: 'keyword-1', title: '遥控汽车' }],
        }] : [] } };
      }
      if (input.command === 'ozon-data-paginate') {
        paginationSources.push(input.sourceSequence);
        return { result: {
          paginationKind: 'offset', pagesFetched: 1, attemptedPages: 1, recordsFetched: 10,
          totalRecordCount: 60, stopReason: 'short-page', resumeSourceSequence: 0,
        } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    const result = await syncDataAnalysisMarketBrowserData({
      command,
      awaitBackground: true,
      defaultTimeoutMs: 0,
      routeTimeoutMs: 0,
      captureSettleMs: 0,
      excludedRouteIds,
    });

    expect(paginationSources).toEqual([5]);
    expect(result.routeResults.find((route) => route.routeId === 'all-queries')).toMatchObject({
      status: 'success',
      source: 'retained-recipe',
      pagesFetched: 1,
      stopReasons: ['short-page'],
      safeToPersist: true,
    });
  });

  it('preserves the audited first page when pagination is unavailable', async () => {
    const command = async (input) => {
      if (input.command === 'state') return {
        tabs: [{
          tabId: 'ozon-tab',
          accountId: 'ozon-profile-a',
          browserRole: 'market-collector',
          background: true,
          url: 'https://seller.ozon.ru/app/dashboard/main',
        }],
      };
      if (input.command === 'navigate') return { ok: true };
      if (input.command === 'ozon-data-status') return {
        result: { ready: true, installed: true, enabled: true, lastSequence: 0 },
      };
      if (input.command === 'ozon-data-probe') return {
        result: { quality: 'empty', capturedSequence: 0, recordCount: 0 },
      };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      if (input.command === 'ozon-data-normalize') return {
        result: {
          datasets: [{
            sequence: 1,
            dataset: 'missing-items',
            endpoint: '/api/site/exa-products-api/missing_items',
            quality: 'confirmed-data',
            capturedAt: '2026-08-06T09:00:00.000Z',
            records: Array.from({ length: 10 }, (_, index) => ({
              id: `missing-${index}`,
              title: `缺货机会-${index}`,
            })),
          }],
        },
      };
      if (input.command === 'ozon-data-paginate') {
        const error = new Error('OZON_DATA_OBSERVER_PAGINATION_UNAVAILABLE');
        error.code = 'OZON_DATA_OBSERVER_PAGINATION_UNAVAILABLE';
        throw error;
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    const result = await syncDataAnalysisMarketBrowserData({
      command,
      awaitBackground: true,
      scanRoutes: false,
      defaultTimeoutMs: 0,
      captureSettleMs: 0,
    });

    expect(result.datasetViews.find((dataset) => dataset.dataset === 'missing-items'))
      .toMatchObject({ recordCount: 10 });
    expect(result.routeResults[0]).toMatchObject({
      routeId: 'market-bestsellers',
      status: 'safe-partial',
      complete: false,
      safeToPersist: true,
      incompleteDatasets: ['missing-items'],
      safePartialDatasets: ['missing-items'],
      paginationWarnings: [{
        dataset: 'missing-items',
        coverageStatus: 'pagination-unavailable',
        limitationCode: 'OZON_DATA_OBSERVER_PAGINATION_UNAVAILABLE',
        stopReason: 'pagination-unavailable',
        preserveExisting: true,
      }],
      paginationErrors: [],
    });
  });

  it('reports an unexpected full-pagination failure without shrinking cached data', async () => {
    let paginationCalls = 0;
    const command = async (input) => {
      if (input.command === 'state') return {
        tabs: [{
          tabId: 'ozon-tab',
          accountId: 'ozon-profile-a',
          browserRole: 'market-collector',
          background: true,
          url: 'https://seller.ozon.ru/app/dashboard/main',
        }],
      };
      if (input.command === 'navigate') return { ok: true };
      if (input.command === 'ozon-data-status') return {
        result: { ready: true, installed: true, enabled: true, lastSequence: 0 },
      };
      if (input.command === 'ozon-data-probe') return {
        result: { quality: 'empty', capturedSequence: 0, recordCount: 0 },
      };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      if (input.command === 'ozon-data-normalize') return {
        result: {
          datasets: [{
            sequence: 1,
            dataset: 'missing-items',
            endpoint: '/api/site/exa-products-api/missing_items',
            quality: 'confirmed-data',
            capturedAt: '2026-07-29T09:00:00.000Z',
            records: Array.from({ length: 10 }, (_, index) => ({
              id: `missing-${index}`,
              title: `缺货机会-${index}`,
            })),
          }],
        },
      };
      if (input.command === 'ozon-data-paginate') {
        paginationCalls += 1;
        throw new Error('generic pagination must not run for market-bestsellers');
      }
      throw new Error(`unexpected command: ${input.command}`);
    };

    const result = await syncDataAnalysisMarketBrowserData({
      command,
      awaitBackground: true,
      scanRoutes: false,
      defaultTimeoutMs: 0,
      captureSettleMs: 0,
    });

    expect(result.datasetViews.find((dataset) => dataset.dataset === 'missing-items'))
      .toMatchObject({ recordCount: 10 });
    expect(result.routeResults[0]).toMatchObject({
      routeId: 'market-bestsellers',
      status: 'partial',
      complete: false,
      safeToPersist: false,
      incompleteDatasets: ['missing-items'],
      paginationWarnings: [],
      paginationErrors: [expect.objectContaining({
        dataset: 'missing-items',
        stopReason: 'command-error',
      })],
    });
    expect(paginationCalls).toBe(1);
  });
});

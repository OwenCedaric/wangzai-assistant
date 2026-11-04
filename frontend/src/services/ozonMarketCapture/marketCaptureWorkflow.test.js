import { describe, expect, it, vi } from 'vitest';
import { searchOzonProductCaptureData } from './marketCaptureWorkflow.js';

describe('searchOzonProductCaptureData', () => {
  it('uses the dedicated collector tab, searches the product dataset and returns only the fresh capture', async () => {
    let currentUrl = 'https://seller.ozon.ru/app/dashboard/main';
    let probed = false;
    let probeAttempts = 0;
    const calls = [];
    const state = () => ({
      activeTabId: 'collector-tab',
      tabs: [{
        tabId: 'collector-tab',
        browserRole: 'market-collector',
        background: true,
        loading: false,
        url: currentUrl,
      }],
    });
    const command = vi.fn(async (input) => {
      calls.push(input);
      if (input.command === 'state') return state();
      if (input.command === 'navigate') {
        currentUrl = input.url;
        return state();
      }
      if (input.command === 'ozon-data-status') {
        if (!currentUrl.includes('/ozon-bestsellers')) {
          const error = new Error('OZON_DATA_OBSERVER_NOT_READY');
          error.code = error.message;
          throw error;
        }
        return { result: { installed: true, enabled: true, ready: true, version: '2.6.6', lastSequence: probed ? 2 : 1 } };
      }
      if (input.command === 'ozon-data-probe') {
        probeAttempts += 1;
        if (probeAttempts <= 2) {
          const error = new Error('OZON_DATA_OBSERVER_PROBE_FAILED');
          error.code = error.message;
          throw error;
        }
        probed = true;
        return { result: { quality: 'confirmed-data', capturedSequence: 2, recordCount: 1 } };
      }
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 6, version: '2.6.6' } };
      if (input.command === 'ozon-data-normalize') {
        return {
          result: {
            datasets: [{
              sequence: probed ? 2 : 1,
              dataset: 'product-performance',
              quality: 'confirmed-data',
              capturedAt: '2026-07-29T06:00:00.000Z',
              records: probed
                ? [{ id: 'dress-1', title: 'Женское платье', price: 899 }]
                : [{ id: 'warmup-1', title: 'Стартовая страница' }],
            }, ...(probed ? [{
              sequence: 3,
              dataset: 'product-performance',
              quality: 'confirmed-data',
              records: [{ id: 'unrelated-page-load', title: 'Несвязанный фоновый ответ' }],
            }] : [])],
          },
        };
      }
      throw new Error(`unexpected command: ${input.command}`);
    });

    const result = await searchOzonProductCaptureData('платье', {
      command,
      productSearchWarmupMs: 0,
      productPerformanceRecipeRetryMs: 0,
      productSearchTimeoutMs: 0,
      captureSettleMs: 0,
      pagination: false,
      productPerformanceProbeRetries: 2,
      productPerformanceRetryDelayMs: 1,
    });

    expect(result).toMatchObject({
      captureMode: 'product-search',
      query: 'платье',
      serverQueryMatched: true,
      observerVersion: '2.6.6',
      datasets: [{ dataset: 'product-performance', quality: 'confirmed-data' }],
    });
    expect(result.datasets).toHaveLength(1);
    expect(result.datasets[0].records.map((record) => record.id)).toEqual(['dress-1']);
    expect(calls.find((item) => item.command === 'navigate')?.url).toContain('/ozon-bestsellers');
    expect(calls.findIndex((item) => item.command === 'navigate')).toBeLessThan(
      calls.findIndex((item) => item.command === 'ozon-data-probe'),
    );
    expect(calls.find((item) => item.command === 'ozon-data-probe')).toMatchObject({
      sourceSequence: 1,
      path: '/api/site/seller-analytics/what_to_sell/data/v3',
      origin: 'https://api.seller.ozon.ru',
      body: {
        filter: {
          period: 'monthly',
          categories: [],
          name: 'платье',
        },
        limit: '50',
        offset: '0',
      },
    });
    expect(calls.filter((item) => item.command === 'ozon-data-probe').map((item) => item.origin)).toEqual([
      'https://api.seller.ozon.ru',
      'https://seller.ozon.ru',
      'https://api.seller.ozon.ru',
    ]);
  });

  it('uses an exact category-only read when a cold cross-origin name search fails', async () => {
    let currentUrl = 'https://seller.ozon.ru/app/dashboard/main';
    let captured = false;
    const probes = [];
    const state = () => ({
      tabs: [{
        tabId: 'collector-tab',
        browserRole: 'market-collector',
        background: true,
        loading: false,
        url: currentUrl,
      }],
    });
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return state();
      if (input.command === 'navigate') {
        currentUrl = input.url;
        return state();
      }
      if (input.command === 'ozon-data-status') {
        return { result: { installed: true, enabled: true, ready: true, version: '2.6.8', lastSequence: captured ? 2 : 1 } };
      }
      if (input.command === 'ozon-data-probe') {
        probes.push(input);
        if (input.origin === 'https://api.seller.ozon.ru') {
          const error = new Error('OZON_DATA_OBSERVER_PROBE_FAILED');
          error.code = error.message;
          throw error;
        }
        if (input.body?.filter?.name) {
          return { result: { quality: 'confirmed-object', capturedSequence: 0, recordCount: 0 } };
        }
        captured = true;
        return { result: { quality: 'confirmed-data', capturedSequence: 2, recordCount: 50 } };
      }
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 8, version: '2.6.8' } };
      if (input.command === 'ozon-data-normalize') {
        return { result: { datasets: captured ? [{
          sequence: 2,
          dataset: 'product-performance',
          quality: 'confirmed-data',
          capturedAt: '2026-07-29T13:40:00.000Z',
          records: [{ id: 'dress-1', title: 'Женское платье', category3: 'Платья' }],
        }] : [] } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    });

    const result = await searchOzonProductCaptureData('платье', {
      command,
      productSearchAlternatives: ['платья'],
      productPerformanceCategoryIds: ['93182'],
      productSearchWarmupMs: 0,
      productPerformanceRecipeRetryMs: 0,
      productSearchTimeoutMs: 0,
      captureSettleMs: 0,
      pagination: false,
      productPerformanceProbeRetries: 1,
    });

    expect(result).toMatchObject({
      captureMode: 'product-search',
      query: 'платье',
      serverQueryMatched: true,
      datasets: [{ records: [{ id: 'dress-1' }] }],
    });
    expect(probes.at(-1)).toMatchObject({
      origin: 'https://seller.ozon.ru',
      body: {
        filter: {
          categories: ['93182'],
          name: '',
        },
      },
    });
  });

  it('continues to the exact category query when every textual origin throws a cold network error', async () => {
    let currentUrl = 'https://seller.ozon.ru/app/dashboard/main';
    let captured = false;
    const probes = [];
    const state = () => ({
      tabs: [{
        tabId: 'collector-tab',
        browserRole: 'market-collector',
        background: true,
        loading: false,
        url: currentUrl,
      }],
    });
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return state();
      if (input.command === 'navigate') {
        currentUrl = input.url;
        return state();
      }
      if (input.command === 'ozon-data-status') {
        return { result: { installed: true, enabled: true, ready: true, version: '2.6.8', lastSequence: captured ? 2 : 1 } };
      }
      if (input.command === 'ozon-data-probe') {
        probes.push(input);
        if (input.body?.filter?.name || input.origin === 'https://api.seller.ozon.ru') {
          const error = new Error('OZON_DATA_OBSERVER_PROBE_FAILED');
          error.code = error.message;
          throw error;
        }
        captured = true;
        return { result: { quality: 'confirmed-data', capturedSequence: 2, recordCount: 50 } };
      }
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 8, version: '2.6.8' } };
      if (input.command === 'ozon-data-normalize') {
        return { result: { datasets: captured ? [{
          sequence: 2,
          dataset: 'product-performance',
          quality: 'confirmed-data',
          records: [{ id: 'shoe-1', title: 'Athletic Shoes', category3: '运动鞋' }],
        }] : [] } };
      }
      throw new Error(`unexpected command: ${input.command}`);
    });

    const result = await searchOzonProductCaptureData('кроссовки', {
      command,
      productPerformanceCategoryIds: ['91248'],
      productSearchWarmupMs: 0,
      productPerformanceRecipeRetryMs: 0,
      productSearchTimeoutMs: 0,
      captureSettleMs: 0,
      pagination: false,
      productPerformanceProbeRetries: 1,
    });

    expect(result.datasets[0].records[0].id).toBe('shoe-1');
    expect(probes.some((probe) => probe.body?.filter?.name === 'кроссовки')).toBe(true);
    expect(probes.at(-1)).toMatchObject({
      origin: 'https://seller.ozon.ru',
      body: { filter: { categories: ['91248'], name: '' } },
    });
  });

  it('reads all 20 product-performance pages through the recoverable probe path and returns 1000 rows', async () => {
    let currentUrl = 'https://seller.ozon.ru/app/dashboard/main';
    const captured = [];
    const probes = [];
    const state = () => ({
      tabs: [{
        tabId: 'collector-tab',
        browserRole: 'market-collector',
        background: true,
        loading: false,
        url: currentUrl,
      }],
    });
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return state();
      if (input.command === 'navigate') {
        currentUrl = input.url;
        return state();
      }
      if (input.command === 'ozon-data-status') {
        return {
          result: {
            installed: true,
            enabled: true,
            ready: true,
            version: '2.6.10',
            lastSequence: Math.max(1, ...captured.map((dataset) => dataset.sequence)),
          },
        };
      }
      if (input.command === 'ozon-data-probe') {
        probes.push(input);
        const offset = Number(input.body?.offset) || 0;
        const pageIndex = offset / 50;
        const sequence = pageIndex + 2;
        const dataset = {
          sequence,
          dataset: 'product-performance',
          quality: 'confirmed-data',
          capturedAt: `2026-07-30T07:${String(pageIndex).padStart(2, '0')}:00.000Z`,
          recordCount: 50,
          records: Array.from({ length: 50 }, (_, index) => ({
            id: String(1_760_000_000 + offset + index),
            title: `Платье ${offset + index + 1}`,
            price: 1_000 + index,
          })),
        };
        captured.push(dataset);
        return {
          result: {
            status: 200,
            quality: 'confirmed-data',
            capturedSequence: sequence,
            recordCount: 50,
          },
        };
      }
      if (input.command === 'ozon-data-catalog') {
        return { result: { endpointCount: 8, version: '2.6.10' } };
      }
      if (input.command === 'ozon-data-normalize') {
        return {
          result: {
            datasets: captured
              .filter((dataset) => dataset.sequence > Number(input.afterSequence || 0))
              .slice(0, Number(input.limit) || 20),
          },
        };
      }
      throw new Error(`unexpected command: ${input.command}`);
    });

    const result = await searchOzonProductCaptureData('платье', {
      command,
      productSearchWarmupMs: 0,
      productPerformanceRecipeRetryMs: 0,
      productSearchTimeoutMs: 0,
      captureSettleMs: 0,
      paginationDelayMs: 0,
      productPerformanceProbeRetries: 1,
      followSellerEnrichment: false,
    });

    expect(probes).toHaveLength(20);
    expect(probes.map((probe) => probe.body.offset)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index * 50)),
    );
    expect(result.pagination).toMatchObject({
      pagesFetched: 19,
      recordsFetched: 950,
      complete: true,
      sources: [{
        totalRecordCount: 1000,
        stopReason: 'record-limit-reached',
      }],
    });
    expect(result.datasets).toHaveLength(20);
    expect(result.datasets.flatMap((dataset) => dataset.records)).toHaveLength(1000);
  });
});

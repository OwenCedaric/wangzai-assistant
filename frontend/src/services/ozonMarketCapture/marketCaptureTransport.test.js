import { describe, expect, it, vi } from 'vitest';
import {
  paginateCapturedDatasets,
  paginationCandidates,
  paginationSummary,
  probeRouteDatasets,
  navigateToExactMarketRoute,
  waitForNavigationCommit,
} from './marketCaptureTransport.js';

describe('paginationCandidates', () => {
  it('keeps an earlier explicit paging recipe when a later natural request drops its paging fields', () => {
    const endpoint = '/api/site/searchteam/Stats/queries/search/v2';
    const candidates = paginationCandidates([{
      sequence: 7,
      dataset: 'keywords',
      endpoint,
      quality: 'confirmed-data',
      requestBody: { period: 'days_7', limit: '50', offset: '0' },
    }, {
      sequence: 8,
      dataset: 'keywords',
      endpoint,
      quality: 'confirmed-data',
      requestBody: { period: 'days_7' },
    }], ['keywords']);

    expect(candidates.map((dataset) => dataset.sequence)).toEqual([7]);
  });
});

describe('waitForNavigationCommit', () => {
  it('does not accept an unchanged URL until the native CEF navigation generation commits', async () => {
    const targetUrl = 'https://seller.ozon.ru/app/analytics/what-to-sell/market-bestsellers';
    let stateReads = 0;
    const state = (completed) => ({
      tabs: [{
        tabId: 'collector-tab',
        url: targetUrl,
        loading: false,
        navigationSequence: 8,
        navigationStartedSequence: 8,
        navigationCompletedSequence: completed,
      }],
    });
    const command = vi.fn(async ({ command: name }) => {
      expect(name).toBe('state');
      stateReads += 1;
      return state(stateReads >= 2 ? 8 : 7);
    });

    const committed = await waitForNavigationCommit(
      command,
      'collector-tab',
      targetUrl,
      state(7),
      { navigationTimeoutMs: 100, navigationPollIntervalMs: 1 },
    );

    expect(stateReads).toBe(2);
    expect(committed.navigationCompletedSequence).toBe(8);
  });

  it('keeps compatibility with command bridges that do not expose a native generation', async () => {
    const targetUrl = 'https://seller.ozon.ru/app/analytics/what-to-sell/market-bestsellers';
    const command = vi.fn();
    const committed = await waitForNavigationCommit(
      command,
      'collector-tab',
      targetUrl,
      { tabs: [{ tabId: 'collector-tab', url: targetUrl, loading: false }] },
      { navigationTimeoutMs: 100, navigationPollIntervalMs: 1 },
    );

    expect(committed.url).toBe(targetUrl);
    expect(command).not.toHaveBeenCalled();
  });
});

describe('navigateToExactMarketRoute', () => {
  it('retries one transient route mismatch and confirms the exact second navigation', async () => {
    const targetUrl = 'https://seller.ozon.ru/app/analytics/what-to-sell/market-bestsellers';
    let navigations = 0;
    const command = vi.fn(async (input) => {
      if (input.command === 'navigate') {
        navigations += 1;
        return { tabs: [{
          tabId: 'collector-tab',
          url: navigations === 1
            ? 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries'
            : targetUrl,
          loading: false,
        }] };
      }
      if (input.command === 'state') return { tabs: [{
        tabId: 'collector-tab',
        url: navigations === 1
          ? 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries'
          : targetUrl,
        loading: false,
      }] };
      throw new Error(`unexpected command ${input.command}`);
    });

    const committed = await navigateToExactMarketRoute(command, 'collector-tab', targetUrl, {
      navigationTimeoutMs: 10,
      navigationPollIntervalMs: 1,
      navigationRetryDelayMs: 1,
    });

    expect(navigations).toBe(2);
    expect(committed.url).toBe(targetUrl);
  });
});

describe('probeRouteDatasets', () => {
  it('returns only the exact probe capture as the pagination recipe when a later natural request drifts', async () => {
    const command = vi.fn(async (input) => {
      if (input.command === 'ozon-data-probe') return {
        result: { quality: 'confirmed-data', capturedSequence: 7, recordCount: 50 },
      };
      if (input.command === 'ozon-data-normalize') return {
        result: {
          datasets: [
            { sequence: 6, dataset: 'keywords', endpoint: '/Stats/queries/search/v2', quality: 'confirmed-data' },
            { sequence: 7, dataset: 'keywords', endpoint: '/Stats/queries/search/v2', quality: 'confirmed-data' },
            { sequence: 8, dataset: 'keywords', endpoint: '/Stats/queries/search/v2', quality: 'confirmed-data' },
          ],
        },
      };
      throw new Error(`unexpected command: ${input.command}`);
    });
    const route = {
      id: 'all-queries',
      datasets: ['keywords'],
      probes: [{
        path: '/api/site/searchteam/Stats/queries/search/v2',
        method: 'POST',
        origin: 'https://seller.ozon.ru',
        body: { text: '', limit: '50', offset: '0', period: 'days_7' },
      }],
      settleMs: 0,
    };

    const result = await probeRouteDatasets(command, 'collector-tab', route, 0, {
      probeTimeoutMs: 0,
      captureSettleMs: 0,
    });

    expect(result.matching.map((dataset) => dataset.sequence)).toEqual([7]);
    expect(result.paginationMatching.map((dataset) => dataset.sequence)).toEqual([7]);
    expect(result.probeResponse).toMatchObject({ capturedSequence: 7, recordCount: 50 });
  });
});

describe('paginateCapturedDatasets', () => {
  it('uses a 100ms inter-page delay by default', async () => {
    const command = vi.fn(async () => ({ result: {
      pagesFetched: 1,
      attemptedPages: 1,
      recordsFetched: 20,
      totalRecordCount: 70,
      capturedSequences: [8],
      stopReason: 'short-page',
      complete: true,
    } }));

    await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
    );

    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'ozon-data-paginate',
      delayMs: 100,
    }));
  });

  it('retains the exact captured sequences across resume batches', async () => {
    let batch = 0;
    const command = vi.fn(async () => {
      batch += 1;
      return {
        result: batch === 1
          ? {
              pagesFetched: 2,
              attemptedPages: 2,
              recordsFetched: 100,
              totalRecordCount: 150,
              capturedSequences: [8, 9],
              resumeSourceSequence: 9,
              stopReason: 'max-pages-reached',
            }
          : {
              pagesFetched: 1,
              attemptedPages: 1,
              recordsFetched: 20,
              totalRecordCount: 170,
              capturedSequences: [10],
              stopReason: 'short-page',
              complete: true,
            },
      };
    });

    const [result] = await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'product-performance', quality: 'confirmed-data', recordCount: 50 }],
      ['product-performance'],
      { paginationMaxPages: 3, paginationBatchPages: 2, paginationDelayMs: 250 },
    );

    expect(result.capturedSequences).toEqual([8, 9, 10]);
    expect(result.pagesFetched).toBe(3);
    expect(result.complete).toBe(true);
    expect(command.mock.calls.map(([input]) => input.maxPages)).toEqual([2, 1]);
  });

  it('stops before a second native page when the shared time budget is exhausted', async () => {
    let currentTime = 0;
    const command = vi.fn(async () => {
      currentTime = 95;
      return { result: {
        pagesFetched: 1,
        attemptedPages: 1,
        recordsFetched: 50,
        totalRecordCount: 100,
        capturedSequences: [8],
        resumeSourceSequence: 8,
        stopReason: 'max-pages-reached',
      } };
    });

    const [result] = await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
      {
        paginationMaxPages: 5,
        paginationBatchPages: 1,
        paginationDeadlineAt: 100,
        paginationCommandReserveMs: 10,
        now: () => currentTime,
      },
    );

    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0][0].maxPages).toBe(1);
    expect(result).toMatchObject({
      pagesFetched: 1,
      complete: false,
      safePartial: true,
      safeToPersist: true,
      preserveExisting: true,
      stopReason: 'time-budget-exhausted',
      coverageStatus: 'time-budget-exhausted',
      limitationCode: 'OZON_DATA_PAGINATION_TIME_BUDGET_EXHAUSTED',
    });
  });

  it('reports the configured page ceiling as an explicit safe partial', async () => {
    const command = vi.fn(async () => ({ result: {
      pagesFetched: 1,
      attemptedPages: 1,
      recordsFetched: 50,
      totalRecordCount: 100,
      capturedSequences: [8],
      resumeSourceSequence: 8,
      stopReason: 'max-pages-reached',
    } }));

    const [result] = await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
      { paginationMaxPages: 1, paginationCommandReserveMs: 0 },
    );

    expect(command.mock.calls[0][0].maxPages).toBe(1);
    expect(result).toMatchObject({
      complete: false,
      safePartial: true,
      safeToPersist: true,
      stopReason: 'max-page-limit',
      coverageStatus: 'page-budget-exhausted',
      limitationCode: 'OZON_DATA_PAGINATION_PAGE_BUDGET_EXHAUSTED',
    });
  });

  it('treats a native page timeout as a cache-preserving safe partial', async () => {
    const onPaginationError = vi.fn();
    const command = vi.fn(async () => {
      const error = new Error('PURCHASE_BROWSER_COMMAND_TIMEOUT');
      error.code = 'PURCHASE_BROWSER_COMMAND_TIMEOUT';
      throw error;
    });

    const [result] = await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
      { onPaginationError, paginationMaxAttempts: 1 },
    );

    expect(result).toMatchObject({
      complete: false,
      safePartial: true,
      safeToPersist: true,
      preserveExisting: true,
      stopReason: 'page-timeout',
      coverageStatus: 'page-timeout',
      limitationCode: 'PURCHASE_BROWSER_COMMAND_TIMEOUT',
      errorCode: '',
    });
    expect(onPaginationError).not.toHaveBeenCalled();
  });

  it('retries only the failed native batch and preserves its exact resume sequence', async () => {
    let calls = 0;
    const retries = [];
    const command = vi.fn(async (input) => {
      calls += 1;
      if (calls <= 2) {
        const error = new Error('PURCHASE_BROWSER_COMMAND_TIMEOUT');
        error.code = 'PURCHASE_BROWSER_COMMAND_TIMEOUT';
        throw error;
      }
      return { result: {
        pagesFetched: 1,
        attemptedPages: 1,
        recordsFetched: 20,
        totalRecordCount: 70,
        capturedSequences: [8],
        stopReason: 'short-page',
        complete: true,
        echoedSourceSequence: input.sourceSequence,
      } };
    });

    const [result] = await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
      {
        paginationMaxAttempts: 3,
        paginationRetryDelayMs: 0,
        onPaginationRetry: (entry) => retries.push(entry),
      },
    );

    expect(command).toHaveBeenCalledTimes(3);
    expect(command.mock.calls.map(([input]) => input.sourceSequence)).toEqual([7, 7, 7]);
    expect(retries.map((entry) => entry.nextAttempt)).toEqual([2, 3]);
    expect(result).toMatchObject({
      complete: true,
      commandAttempts: 3,
      retryCount: 2,
      lastRetryCode: 'PURCHASE_BROWSER_COMMAND_TIMEOUT',
      pagesFetched: 1,
    });
  });

  it('preserves the trusted dataset after bounded observer-timeout retries are exhausted', async () => {
    const command = vi.fn(async () => {
      const error = new Error('OZON_DATA_OBSERVER_NOT_READY');
      error.code = 'OZON_DATA_OBSERVER_NOT_READY';
      throw error;
    });

    const [result] = await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
      { paginationMaxAttempts: 3, paginationRetryDelayMs: 0 },
    );

    expect(command).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      complete: false,
      safePartial: true,
      safeToPersist: true,
      preserveExisting: true,
      stopReason: 'observer-timeout',
      coverageStatus: 'observer-timeout',
      limitationCode: 'OZON_DATA_OBSERVER_NOT_READY',
      commandAttempts: 3,
      retryCount: 2,
    });
  });

  it('returns a cache-preserving safe partial when the observer cannot paginate a valid first page', async () => {
    const onPaginationError = vi.fn();
    const command = vi.fn(async () => {
      const error = new Error('OZON_DATA_OBSERVER_PAGINATION_UNAVAILABLE');
      error.code = 'OZON_DATA_OBSERVER_PAGINATION_UNAVAILABLE';
      throw error;
    });

    const results = await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
      { onPaginationError },
    );

    expect(results).toEqual([expect.objectContaining({
      dataset: 'keywords',
      complete: false,
      stoppedSafely: true,
      safePartial: true,
      safeToPersist: true,
      preserveExisting: true,
      coverageStatus: 'pagination-unavailable',
      stopReason: 'pagination-unavailable',
      limitationCode: 'OZON_DATA_OBSERVER_PAGINATION_UNAVAILABLE',
      errorCode: '',
    })]);
    expect(onPaginationError).not.toHaveBeenCalled();
    expect(paginationSummary(results)).toMatchObject({
      complete: false,
      safeToPersist: true,
      incompleteDatasets: ['keywords'],
      safePartialDatasets: ['keywords'],
    });
  });

  it('preserves the trusted cache when an endpoint repeats its first page', async () => {
    const results = await paginateCapturedDatasets(
      async () => ({ result: {
        pagesFetched: 0,
        attemptedPages: 1,
        recordsFetched: 0,
        stopReason: 'duplicate-page',
        stoppedSafely: false,
        failureCode: 'OZON_DATA_PAGINATION_DUPLICATE_PAGE',
      } }),
      'collector-tab',
      [{ sequence: 7, dataset: 'market-products', quality: 'confirmed-data', recordCount: 12 }],
      ['market-products'],
    );

    expect(results).toEqual([expect.objectContaining({
      dataset: 'market-products',
      complete: false,
      stoppedSafely: true,
      safePartial: true,
      safeToPersist: true,
      preserveExisting: true,
      coverageStatus: 'pagination-ignored',
      stopReason: 'duplicate-page',
      limitationCode: 'OZON_DATA_PAGINATION_DUPLICATE_PAGE',
      errorCode: '',
    })]);
    expect(paginationSummary(results)).toMatchObject({
      complete: false,
      safeToPersist: true,
      incompleteDatasets: ['market-products'],
      safePartialDatasets: ['market-products'],
    });
  });

  it('keeps unexpected pagination command failures as hard failures', async () => {
    const onPaginationError = vi.fn();
    const command = vi.fn(async () => {
      throw new Error('network disconnected');
    });

    const results = await paginateCapturedDatasets(
      command,
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
      { onPaginationError },
    );

    expect(results[0]).toMatchObject({
      complete: false,
      stoppedSafely: false,
      safePartial: false,
      safeToPersist: false,
      preserveExisting: true,
      coverageStatus: 'failed',
      stopReason: 'command-error',
      errorCode: 'network disconnected',
    });
    expect(onPaginationError).toHaveBeenCalledTimes(1);
    expect(paginationSummary(results)).toMatchObject({
      complete: false,
      safeToPersist: false,
      incompleteDatasets: ['keywords'],
      safePartialDatasets: [],
    });
  });

  it('does not disguise an unsafe first-page response as page-budget exhaustion', async () => {
    const results = await paginateCapturedDatasets(
      async () => ({ result: {
        pagesFetched: 0,
        attemptedPages: 1,
        recordsFetched: 0,
        stopReason: 'network-error',
        stoppedSafely: false,
        failureCode: 'FAILED_TO_FETCH',
      } }),
      'collector-tab',
      [{ sequence: 7, dataset: 'keywords', quality: 'confirmed-data', recordCount: 50 }],
      ['keywords'],
      { paginationMaxPages: 1, paginationCommandReserveMs: 0 },
    );

    expect(results[0]).toMatchObject({
      complete: false,
      stoppedSafely: false,
      safePartial: false,
      safeToPersist: false,
      coverageStatus: 'failed',
      stopReason: 'network-error',
      errorCode: 'FAILED_TO_FETCH',
    });
  });
});

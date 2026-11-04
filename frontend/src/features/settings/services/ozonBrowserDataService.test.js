import { describe, expect, it, vi } from 'vitest';
import {
  normalizeOzonBrowserData,
  paginateAllOzonBrowserData,
  paginateOzonBrowserData,
  probeKnownOzonBrowserData,
  readOzonBrowserData,
  readOzonBrowserDataCatalog,
  readOzonBrowserDataPayload,
  readOzonBrowserDataStatus,
  searchOzonBrowserData,
  waitForOzonBrowserDataObserver,
} from './ozonBrowserDataService.js';

const state = {
  ok: true,
  engine: 'cef',
  activeTabId: 'tab-ozon',
  tabs: [{ tabId: 'tab-ozon', accountId: 'profile-ozon' }],
};

describe('ozonBrowserDataService', () => {
  it('waits for installed, enabled and page-ready observer readback', async () => {
    let attempts = 0;
    const command = vi.fn(async () => ({
      ok: true,
      result: {
        installed: true,
        enabled: true,
        ready: ++attempts >= 2,
        extensionVersion: '2.0.0',
      },
      state,
    }));

    const first = await readOzonBrowserDataStatus({ tabId: 'tab-ozon', command });
    expect(first.result.ready).toBe(false);
    const ready = await waitForOzonBrowserDataObserver({
      tabId: 'tab-ozon',
      command,
      intervalMs: 1,
      timeoutMs: 1000,
    });
    expect(ready.result).toMatchObject({ installed: true, enabled: true, ready: true });
  });

  it('reads a bounded cursor page without exposing browser cookies', async () => {
    const command = vi.fn(async () => ({
      ok: true,
      result: {
        ready: true,
        lastSequence: 4,
        entries: [{ sequence: 4, endpoint: '/api/site/exa-products-api/missing_items' }],
      },
      state,
    }));

    const result = await readOzonBrowserData({
      tabId: 'tab-ozon',
      afterSequence: 3,
      limit: 999,
      drain: true,
      command,
    });
    expect(result.result.entries).toHaveLength(1);
    expect(command).toHaveBeenCalledWith({
      command: 'ozon-data-read',
      tabId: 'tab-ozon',
      afterSequence: 3,
      limit: 50,
      drain: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/cookie|authorization/iu);
  });

  it('exposes endpoint catalog, normalized datasets and bounded pagination commands', async () => {
    const command = vi.fn(async (input) => ({
      ok: true,
      result: input.command === 'ozon-data-catalog'
        ? { endpointCount: 2, endpoints: [] }
        : input.command === 'ozon-data-normalize'
          ? { datasets: [{ sequence: 4, records: [{ id: 123 }] }] }
          : { sourceSequence: input.sourceSequence, pagesFetched: input.maxPages },
      state,
    }));

    const catalog = await readOzonBrowserDataCatalog({ tabId: 'tab-ozon', command });
    expect(catalog.result.endpointCount).toBe(2);
    const normalized = await normalizeOzonBrowserData({
      tabId: 'tab-ozon',
      afterSequence: 3,
      limit: 99,
      command,
    });
    expect(normalized.result.datasets[0].records[0].id).toBe(123);
    const paginated = await paginateOzonBrowserData({
      tabId: 'tab-ozon',
      sourceSequence: 4,
      maxPages: 99,
      delayMs: 1,
      command,
    });
    expect(paginated.result.pagesFetched).toBe(99);
    expect(command.mock.calls.at(-1)[0]).toEqual({
      command: 'ozon-data-paginate',
      tabId: 'tab-ozon',
      sourceSequence: 4,
      maxPages: 99,
      delayMs: 250,
    });
  });

  it('reads a bounded chunk of the retained raw Ozon payload', async () => {
    const command = vi.fn(async (input) => ({
      ok: true,
      result: {
        sourceSequence: input.sourceSequence,
        offset: input.offset,
        nextOffset: input.offset + 2,
        totalChars: 2,
        complete: true,
        encoding: 'json',
        chunk: '{}',
      },
      state,
    }));
    const result = await readOzonBrowserDataPayload({
      tabId: 'tab-ozon',
      sourceSequence: 4,
      offset: -5,
      limit: 9999999,
      command,
    });
    expect(result.result.chunk).toBe('{}');
    expect(command).toHaveBeenCalledWith({
      command: 'ozon-data-payload',
      tabId: 'tab-ozon',
      sourceSequence: 4,
      offset: 0,
      limit: 512 * 1024,
    });
  });

  it('replays an observed keyword query with a validated search term', async () => {
    const command = vi.fn(async (input) => ({
      ok: true,
      result: { capturedSequence: 8, query: input.query, recordCount: 5 },
      state,
    }));
    const result = await searchOzonBrowserData({
      tabId: 'tab-ozon',
      sourceSequence: 4,
      query: '  машинка на радиоуправлении  ',
      command,
    });
    expect(result.result).toMatchObject({
      capturedSequence: 8,
      query: 'машинка на радиоуправлении',
      recordCount: 5,
    });
    expect(command).toHaveBeenCalledWith({
      command: 'ozon-data-search',
      tabId: 'tab-ozon',
      sourceSequence: 4,
      query: 'машинка на радиоуправлении',
    });
  });

  it('probes a fixed read-only Ozon endpoint through the browser session', async () => {
    const command = vi.fn(async (input) => ({
      ok: true,
      result: { endpoint: input.path, status: 200, recordCount: 50 },
      state,
    }));
    const result = await probeKnownOzonBrowserData({
      tabId: 'tab-ozon',
      path: '/api/site/seller-analytics/what_to_sell/data/v3',
      origin: 'https://api.seller.ozon.ru',
      body: { limit: '50', offset: '0' },
      command,
    });
    expect(result.result.recordCount).toBe(50);
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'ozon-data-probe',
      path: '/api/site/seller-analytics/what_to_sell/data/v3',
      origin: 'https://api.seller.ozon.ru',
    }));
  });

  it('retries a transient known-endpoint probe before returning the successful response', async () => {
    let attempts = 0;
    const command = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('temporary fetch failure'), { code: 'TEMPORARY' });
      return {
        ok: true,
        result: { status: 200, recordCount: 50, capturedSequence: 8 },
        state,
      };
    });
    const response = await probeKnownOzonBrowserData({
      tabId: 'tab-ozon',
      path: '/api/site/seller-analytics/what_to_sell/data/v3',
      body: { limit: '50', offset: '0' },
      retryDelayMs: 1,
      command,
    });
    expect(command).toHaveBeenCalledTimes(3);
    expect(response.result).toMatchObject({
      status: 200,
      recordCount: 50,
      attempts: 3,
      retriesUsed: 2,
    });
  });

  it('continues a partial page run from its resume sequence and verifies the aggregate', async () => {
    const command = vi.fn(async (input) => {
      if (input.sourceSequence === 4) {
        return {
          ok: true,
          result: {
            ready: true,
            version: '2.4.0',
            sourceSequence: 4,
            sourceRecordCount: 10,
            pagesFetched: 2,
            recordsFetched: 20,
            capturedSequences: [5, 6],
            pageValues: [10, 20],
            retriesUsed: 2,
            stopReason: 'network-error',
            failedPage: 3,
            failedStatus: 0,
            resumeSourceSequence: 6,
            stoppedSafely: false,
          },
          state,
        };
      }
      return {
        ok: true,
        result: {
          ready: true,
          version: '2.4.0',
          sourceSequence: input.sourceSequence,
          sourceRecordCount: 10,
          pagesFetched: 3,
          recordsFetched: 30,
          capturedSequences: [7, 8, 9],
          pageValues: [30, 40, 50],
          retriesUsed: 0,
          stopReason: 'max-pages-reached',
          failedPage: 0,
          failedStatus: 0,
          resumeSourceSequence: 9,
          stoppedSafely: true,
        },
        state,
      };
    });
    const progress = vi.fn();
    const response = await paginateAllOzonBrowserData({
      tabId: 'tab-ozon',
      sourceSequence: 4,
      maxPages: 5,
      chunkPages: 3,
      delayMs: 250,
      recoveryDelayMs: 1,
      onProgress: progress,
      command,
    });
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[0][0]).toMatchObject({ sourceSequence: 4, maxPages: 3 });
    expect(command.mock.calls[1][0]).toMatchObject({ sourceSequence: 6, maxPages: 3 });
    expect(response.result).toMatchObject({
      status: 'limit-reached',
      datasetComplete: false,
      limitReached: true,
      pagesFetched: 5,
      recordsFetched: 50,
      sourceRecordCount: 10,
      totalRecordCount: 60,
      retriesUsed: 2,
      recoveryAttemptsUsed: 1,
      resumeSourceSequence: 9,
      capturedSequences: [5, 6, 7, 8, 9],
      pageValues: [10, 20, 30, 40, 50],
      integrity: {
        uniqueCapturedSequences: true,
        uniquePageValues: true,
        duplicateSequences: 0,
        duplicatePageValues: 0,
        capturedPageCountConsistent: true,
        recordCountConsistent: true,
      },
    });
    expect(progress).toHaveBeenCalledTimes(2);
  });
});

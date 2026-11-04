import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmDatabaseCompaction,
  confirmManualShopScopeResolution,
  confirmTechnicalRetention,
  clearProfitLedgerSnapshots,
  getLocalApiBaseUrl,
  getLocalDataConsistencyAudit,
  getDatabaseCompactionPreview,
  getManualShopScopeResolutionPreview,
  getRecoveryBackupPreview,
  getProfitLedgerSnapshot,
  getRubCnyDailyRates,
  saveProfitLedgerSnapshot,
  getTechnicalRetentionPreview,
  listIntegrationProfiles,
  listPerformanceAccounts,
  listPurchaseAccounts,
  previewDomainWrite,
  readExternalIntegration,
  requestLocalApi,
  requestLocalOzon,
  saveDataAnalysisSnapshot,
  testLocalShopConnection,
  waitForLocalOrderSyncJob,
} from './localApiClient.js';

function createAbortablePendingRequest() {
  return vi.fn((_url, options = {}) => {
    return new Promise((_resolve, reject) => {
      const rejectAsAborted = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (options.signal?.aborted) {
        rejectAsAborted();
        return;
      }
      options.signal?.addEventListener('abort', rejectAsAborted, { once: true });
    });
  });
}

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete globalThis.window?.wangzaiDesktop;
});

describe('localApiClient abort and timeout handling', () => {
  it('honors the Vite local-api override instead of silently falling back to port 3790', () => {
    vi.stubEnv('VITE_LOCAL_API_BASE_URL', 'http://127.0.0.1:3791/');

    expect(getLocalApiBaseUrl()).toBe('http://127.0.0.1:3791');
  });

  it('keeps the internal timeout effective when an external AbortSignal is supplied', async () => {
    vi.useFakeTimers();
    const fetchMock = createAbortablePendingRequest();
    vi.stubGlobal('fetch', fetchMock);
    const externalController = new AbortController();

    const request = requestLocalApi('/slow', {
      timeoutMs: 50,
      signal: externalController.signal,
      observe: false,
    });
    const rejection = expect(request).rejects.toMatchObject({
      name: 'LocalApiError',
      code: 'LOCAL_API_TIMEOUT',
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(externalController.signal.aborted).toBe(false);
  });

  it('preserves an external cancellation as AbortError instead of reporting a timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = createAbortablePendingRequest();
    vi.stubGlobal('fetch', fetchMock);
    const externalController = new AbortController();

    const request = requestLocalApi('/cancelled', {
      timeoutMs: 5000,
      signal: externalController.signal,
      observe: false,
    });
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    externalController.abort();
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts all requested dates to the daily batch endpoint', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, rates: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getRubCnyDailyRates(['2026-07-01', '2026-07-02'], {
      timeoutMs: 500,
      allowNearest: true,
      maxLookbackDays: 7,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3790/api/exchange-rate/rub-cny/daily-batch');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      dates: ['2026-07-01', '2026-07-02'],
      allowNearest: true,
      maxLookbackDays: 7,
    });
  });

  it('surfaces the shop connection payload error instead of a generic local-api 502', async () => {
    const payload = {
      ok: false,
      connected: false,
      error: {
        code: 'OZON_AUTHENTICATION_FAILED',
        message: 'roles 测试失败：API Key 无效、已撤销或与当前 Client ID 不匹配。',
        endpointKey: 'shop.roles',
        status: 404,
        ozonCode: '5',
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => createJsonResponse(payload, 502)));

    await expect(testLocalShopConnection('shop-auth-failed', { timeoutMs: 500 })).rejects.toMatchObject({
      name: 'LocalApiError',
      code: 'OZON_AUTHENTICATION_FAILED',
      status: 502,
      message: payload.error.message,
      payload,
    });
  });

  it('surfaces a controlled backend error message through browser fetch', async () => {
    const payload = {
      ok: false,
      error: {
        code: 'IMAGE_PROMPT_PLAN_GENERATION_FAILED',
        message: '分析模型响应超时，原图仍然保留，请稍后重试或更换分析模型。',
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => createJsonResponse(payload, 400)));

    await expect(requestLocalApi('/api/image-prompt-plans/generate', {
      method: 'POST',
      body: {},
      observe: false,
    })).rejects.toMatchObject({
      name: 'LocalApiError',
      code: 'IMAGE_PROMPT_PLAN_GENERATION_FAILED',
      status: 400,
      message: payload.error.message,
      payload,
    });
  });

  it('uses the dedicated SQLite ledger route for read, write, and clear operations', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, snapshot: { rows: [] }, stats: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await getProfitLedgerSnapshot(['key-a', 'key-b'], { timeoutMs: 500 });
    await saveProfitLedgerSnapshot('key-a', { rows: [{ ledgerKey: 'ledger-a' }] }, { timeoutMs: 500 });
    await clearProfitLedgerSnapshots(['key-a', 'key-b'], { timeoutMs: 500 });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3790/api/profit/ledger-snapshot?keys=key-a%2Ckey-b');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:3790/api/profit/ledger-snapshot');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      snapshotKey: 'key-a',
      snapshot: { rows: [{ ledgerKey: 'ledger-a' }] },
    });
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ snapshotKeys: ['key-a', 'key-b'] });
  });

  it('uses the Electron IPC proxy without exposing its capability token', async () => {
    const bridge = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } }));
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await requestLocalApi('/api/app/status', { observe: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/app/status', method: 'GET' }));
    expect(JSON.stringify(bridge.mock.calls[0][0])).not.toContain('token');
  });

  it('retries transient packaged GET failures before showing a module error', async () => {
    vi.useFakeTimers();
    const bridge = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 0, error: '无法连接本地 API' })
      .mockResolvedValueOnce({ ok: false, status: 0, error: 'ECONNRESET' })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { rows: ['ready'] } });
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };

    const pending = requestLocalApi('/api/cache/logistics?shopId=shop-a', {
      timeoutMs: 100,
      observe: false,
    });
    await vi.advanceTimersByTimeAsync(700);

    await expect(pending).resolves.toEqual({ rows: ['ready'] });
    expect(bridge).toHaveBeenCalledTimes(3);
  });

  it('does not retry a packaged GET that already consumed its local-api timeout budget', async () => {
    const bridge = vi.fn(async () => ({ ok: false, status: 0, error: '本地 API 请求超时' }));
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };

    await expect(requestLocalApi('/api/cache/products?shopId=shop-a', {
      timeoutMs: 12000,
      observe: false,
    })).rejects.toMatchObject({ name: 'LocalApiError', status: 0 });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it('never retries a failed POST because it could duplicate writes or charges', async () => {
    const bridge = vi.fn(async () => ({ ok: false, status: 0, error: '无法连接本地 API' }));
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };

    await expect(requestLocalApi('/api/product-images/generate', {
      method: 'POST',
      body: { productId: 'product-a' },
      observe: false,
    })).rejects.toMatchObject({ name: 'LocalApiError', status: 0 });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it('stops polling an order sync after two consecutive local-api transport failures', async () => {
    vi.useFakeTimers();
    const bridge = vi.fn(async () => ({ ok: false, status: 0, error: '无法连接本地 API' }));
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };

    const pending = waitForLocalOrderSyncJob(
      { jobId: 'orders-sync-down', status: 'running' },
      { timeoutMs: 180_000, intervalMs: 100, maxTransportPollFailures: 2 }
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      timedOut: false,
      transportFailed: true,
      transportFailureCount: 2,
    });
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it('retries only an explicitly safe local write preview after a transient bridge disconnect', async () => {
    vi.useFakeTimers();
    const bridge = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 0, error: '无法连接本地 API' })
      .mockResolvedValueOnce({ ok: false, status: 0, error: 'ECONNRESET' })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, previewId: 'preview-ready' } });
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };

    const pending = previewDomainWrite('products', {
      shopId: 'shop-a',
      action: 'product.updateInfo',
      idempotencyKey: 'collection-preview-safe-retry',
    }, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(700);

    await expect(pending).resolves.toMatchObject({ ok: true, previewId: 'preview-ready' });
    expect(bridge).toHaveBeenCalledTimes(3);
    expect(bridge.mock.calls.every(([request]) => request.method === 'POST')).toBe(true);
    expect(bridge.mock.calls.every(([request]) => request.path === '/api/write/products/preview')).toBe(true);
  });

  it('does not retry a controlled HTTP failure from local-api', async () => {
    const bridge = vi.fn(async () => ({
      ok: false,
      status: 403,
      data: { error: { code: 'PERMISSION_DENIED', message: '缺少权限' } },
    }));
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };

    await expect(requestLocalApi('/api/cache/logistics?shopId=shop-a', {
      observe: false,
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it('surfaces a controlled backend error message through the Electron bridge', async () => {
    const payload = {
      ok: false,
      error: {
        code: 'IMAGE_PROMPT_PLAN_GENERATION_FAILED',
        message: '分析模型响应超时，原图仍然保留，请稍后重试或更换分析模型。',
      },
    };
    const bridge = vi.fn(async () => ({ ok: false, status: 400, data: payload }));
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };

    await expect(requestLocalApi('/api/image-prompt-plans/generate', {
      method: 'POST',
      body: {},
      observe: false,
    })).rejects.toMatchObject({
      name: 'LocalApiError',
      code: 'IMAGE_PROMPT_PLAN_GENERATION_FAILED',
      status: 400,
      message: payload.error.message,
      payload,
    });
  });

  it('preserves the original Ozon return reason through the local cache compatibility adapter', async () => {
    const bridge = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        rows: [{
          id: '98262584',
          return_id: '98262584',
          shopId: 'shop-a',
          reason: '售后原因翻译中',
          return_reason: '售后原因翻译中',
          reasonRaw: 'Нет части товара или комплекта',
          reason_raw: 'Нет части товара или комплекта',
          return_reason_raw: 'Нет части товара или комплекта',
          reasonZh: null,
          reasonTranslationStatus: 'pending',
          raw: {
            return_reason: { id: 23, name: 'Нет части товара или комплекта' },
          },
        }],
        total: 1,
      },
    }));
    globalThis.window.wangzaiDesktop = { localApiRequest: bridge };

    const payload = await requestLocalOzon({
      endpoint: '/v2/returns/rfbs/list',
      shop: { id: 'shop-a' },
      body: { limit: 100 },
    });

    expect(payload.returns[0]).toMatchObject({
      reason: '售后原因翻译中',
      reasonRaw: 'Нет части товара или комплекта',
      reason_raw: 'Нет части товара или комплекта',
      return_reason_raw: 'Нет части товара или комплекта',
      reasonTranslationStatus: 'pending',
    });
  });

  it('propagates external cancellation through the Electron IPC bridge', async () => {
    let resolveBridge;
    const bridge = vi.fn(() => new Promise((resolve) => { resolveBridge = resolve; }));
    const cancel = vi.fn(async () => {
      resolveBridge({ ok: false, status: 0, error: '本地 API 请求超时' });
      return { ok: true, canceled: true };
    });
    globalThis.window.wangzaiDesktop = {
      localApiRequest: bridge,
      cancelLocalApiRequest: cancel,
    };
    const controller = new AbortController();
    const pending = requestLocalApi('/api/cache/data-analysis?shopId=shop-a', {
      signal: controller.signal,
      timeoutMs: 60_000,
      observe: false,
    });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    controller.abort();
    await rejection;

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(bridge.mock.calls[0][0].requestId);
  });

  it('reads platform and purchase account configuration only from their normal SQLite routes', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, rows: [], total: 0, hasMore: false, nextCursor: '' }));
    vi.stubGlobal('fetch', fetchMock);

    await listIntegrationProfiles({ timeoutMs: 500 });
    await listPerformanceAccounts({ timeoutMs: 500 });
    await listPurchaseAccounts();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3790/api/integrations/profiles',
      'http://127.0.0.1:3790/api/performance/accounts',
      'http://127.0.0.1:3790/api/purchase/accounts',
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('sends an external data read through the local-api adapter route', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, data: { products: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await readExternalIntegration({
      profileId: 'linkfox-1',
      operation: 'seerfar-ozon-shop-search',
      input: { keyword: 'платье' },
    }, { timeoutMs: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3790/api/integrations/read');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      profileId: 'linkfox-1',
      operation: 'seerfar-ozon-shop-search',
      input: { keyword: 'платье' },
    });
  });

  it('writes the compact Ozon market snapshot through the data-analysis cache route', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, row: { sourceKey: 'ozon-profile-a' } }));
    vi.stubGlobal('fetch', fetchMock);

    await saveDataAnalysisSnapshot({
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'ozon-profile-a',
      payload: { marketData: { sections: {} } },
    }, { timeoutMs: 500 });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3790/api/cache/data-analysis/snapshot');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sourceKey).toBe('ozon-profile-a');
  });

  it('reads recovery backup capacity preview without recording it as a page business request', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, status: 'fits_standard' }));
    vi.stubGlobal('fetch', fetchMock);

    await getRecoveryBackupPreview({ shopId: 'shop-1' }, { timeoutMs: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3790/api/app/recovery-backup-preview?shopId=shop-1');
  });

  it('reads the explicit local data consistency audit without creating a business sync request', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, mode: 'read-only-data-consistency-audit' }));
    vi.stubGlobal('fetch', fetchMock);

    await getLocalDataConsistencyAudit({ timeoutMs: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3790/api/app/data-consistency-audit');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('requires an explicit backup acknowledgement and sends the exact technical-retention confirmation payload', async () => {
    expect(() => confirmTechnicalRetention('preview-fingerprint')).toThrow(/保护副本/u);

    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, deleted: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getTechnicalRetentionPreview({ timeoutMs: 500 });
    await confirmTechnicalRetention('preview-fingerprint', { backupAcknowledged: true, timeoutMs: 500 });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3790/api/app/technical-retention-preview');
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:3790/api/app/technical-retention/confirm');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      confirmation: 'APPLY_TECHNICAL_RETENTION',
      previewFingerprint: 'preview-fingerprint',
      backupAcknowledged: true,
    });
  });

  it('requires at least one explicit manual shop assignment and sends only normalized candidate choices', async () => {
    expect(() => confirmManualShopScopeResolution('manual-fingerprint', [])).toThrow(/至少一条/u);

    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, applied: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getManualShopScopeResolutionPreview({ timeoutMs: 500 });
    await confirmManualShopScopeResolution('manual-fingerprint', [
      { candidateId: 'candidate-1', targetShopId: 'shop-b', ignored: 'not-sent' },
    ], { timeoutMs: 500 });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3790/api/app/shop-scope-manual-preview');
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:3790/api/app/shop-scope-manual-resolution/confirm');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      confirmation: 'APPLY_MANUAL_SHOP_SCOPE_RESOLUTION',
      previewFingerprint: 'manual-fingerprint',
      assignments: [{ candidateId: 'candidate-1', targetShopId: 'shop-b' }],
    });
  });

  it('requires a backup acknowledgement and sends the exact SQLite compaction confirmation payload', async () => {
    expect(() => confirmDatabaseCompaction('compaction-fingerprint')).toThrow(/保护副本/u);

    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, mode: 'confirmed-vacuum' }));
    vi.stubGlobal('fetch', fetchMock);

    await getDatabaseCompactionPreview({ timeoutMs: 500 });
    await confirmDatabaseCompaction('compaction-fingerprint', { backupAcknowledged: true, timeoutMs: 500 });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3790/api/app/database-compaction-preview');
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:3790/api/app/database-compaction/confirm');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      confirmation: 'APPLY_DATABASE_COMPACTION',
      previewFingerprint: 'compaction-fingerprint',
      backupAcknowledged: true,
    });
  });
});

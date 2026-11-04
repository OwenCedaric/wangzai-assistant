import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulateOrderTestSplit } from '../api/localApiClient';
import { buildSimulatedSalesOrderSplitResult } from '../entities/marketing/marketingOrderFields.jsx';
import { getOrderWriteStatusMessage, requestOrderWriteOperation } from './orderWriteClient';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('orderWriteClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('previews and confirms Ozon order writes through generic local-api write guard routes', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/api/write/orders/preview')) {
        return jsonResponse({ ok: true, previewId: 'orders-preview-1', requiresConfirmation: true });
      }
      if (path.includes('/api/write/orders/confirm')) {
        return jsonResponse({
          ok: true,
          previewId: 'orders-preview-1',
          action: 'shipFbsPosting',
          endpointKey: 'orders.shipFbsPosting',
          writeStatus: 'submitted_waiting_readback',
          schedulerResult: { ok: true, accepted: true, data: { status: 'accepted' } },
          readBack: { status: 'pending', rows: 0 },
          readBackJobs: { scheduled: true, jobs: [{ jobId: 'orders-readback-1' }] },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'UNEXPECTED_ROUTE' } }, 404);
    });

    const result = await requestOrderWriteOperation({
      shopId: 'shop-1',
      action: 'shipFbsPosting',
      endpointKey: 'orders.shipFbsPosting',
      payload: { posting_number: 'FBS-1' },
      idempotencyKey: 'orders:shipFbsPosting:shop-1:FBS-1',
      realWrite: true,
      dryRun: false,
    });

    const calls = fetchMock.mock.calls.map(([url, options]) => ({ url: String(url), body: JSON.parse(options.body) }));
    expect(calls[0].url).toContain('/api/write/orders/preview');
    expect(calls[1].url).toContain('/api/write/orders/confirm');
    expect(calls.every((call) => !call.url.includes('/api/' + 'ozon/request'))).toBe(true);
    expect(calls[1].body).toMatchObject({
      previewId: 'orders-preview-1',
      confirm: true,
      realWrite: true,
      dryRun: false,
      action: 'shipFbsPosting',
      endpointKey: 'orders.shipFbsPosting',
    });
    expect(result.localApiWrite).toMatchObject({
      domain: 'orders',
      action: 'shipFbsPosting',
      endpointKey: 'orders.shipFbsPosting',
      writeStatus: 'submitted_waiting_readback',
    });
    expect(result.localApiWrite.message).toContain('后台回读已排队');
    expect(result.localApiWrite.readBackJobs).toMatchObject({ scheduled: true });
    expect(result.localApiWrite.message).not.toContain('写入完成');
  });

  it('preserves split relation and queued readback evidence returned by local-api', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: true, previewId: 'orders-preview-split' }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          previewId: 'orders-preview-split',
          action: 'splitFbsPosting',
          endpointKey: 'orders.splitFbsPosting',
          writeStatus: 'submitted_waiting_readback',
          schedulerResult: { ok: true, accepted: true, data: { status: 'accepted' } },
          splitRelation: {
            parentPostingNumber: 'parent-1',
            childPostingNumbers: ['child-1', 'child-2'],
            readbackStatus: 'pending',
            childrenConfirmed: false,
          },
          readBack: { status: 'pending', rows: 0 },
          readBackJobs: { scheduled: true, jobs: [{ jobId: 'split-readback-1' }] },
        })
      );

    const result = await requestOrderWriteOperation({
      shopId: 'shop-1',
      action: 'splitFbsPosting',
      endpointKey: 'orders.splitFbsPosting',
      payload: { posting_number: 'parent-1', postings: [] },
      idempotencyKey: 'orders:splitFbsPosting:shop-1:parent-1',
      realWrite: true,
      dryRun: false,
    });

    expect(result.writeStatus).toBe('submitted_waiting_readback');
    expect(result.splitRelation).toMatchObject({
      parentPostingNumber: 'parent-1',
      childPostingNumbers: ['child-1', 'child-2'],
      readbackStatus: 'pending',
    });
    expect(result.readBackJobs).toMatchObject({ scheduled: true });
    expect(result.localApiWrite.splitRelation).toMatchObject({ parentPostingNumber: 'parent-1' });
    expect(result.localApiWrite.readBackJobs).toMatchObject({ scheduled: true });
    expect(result.localApiWrite.message).toContain('后台回读已排队');
  });

  it('uses real write gate status copy when the real write switch blocks the confirm step', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: true, previewId: 'order-preview-2' }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: false,
          writeStatus: 'blocked_real_write_disabled',
          error: { code: 'REAL_OZON_WRITE_DISABLED' },
        })
      );

    await expect(
      requestOrderWriteOperation({
        shopId: 'shop-2',
        action: 'cancelFbsPosting',
        endpointKey: 'orders.cancelFbsPosting',
        payload: { posting_number: 'FBS-2' },
        realWrite: true,
        dryRun: false,
      })
    ).rejects.toThrow('真实 Ozon 写入总开关未开启，本次不会提交 Ozon。');
  });

  it('defaults confirmed order operations to real Ozon write instead of dry-run', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: true, previewId: 'order-preview-default-real' }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          previewId: 'order-preview-default-real',
          action: 'cancelFbsPosting',
          endpointKey: 'orders.cancelFbsPosting',
          writeStatus: 'submitted_waiting_readback',
          schedulerResult: { ok: true, accepted: true },
        })
      );

    await requestOrderWriteOperation({
      shopId: 'shop-3',
      action: 'cancelFbsPosting',
      endpointKey: 'orders.cancelFbsPosting',
      payload: { posting_number: 'FBS-3' },
    });

    const confirmBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(confirmBody).toMatchObject({
      confirm: true,
      realWrite: true,
      dryRun: false,
    });
  });

  it('does not describe submitted writes as completed before readback merge', () => {
    const submitted = getOrderWriteStatusMessage({ writeStatus: 'submitted_waiting_readback' });
    const merged = getOrderWriteStatusMessage({ writeStatus: 'readback_merged' });

    expect(submitted).toContain('等待回读确认');
    expect(submitted).not.toContain('写入完成');
    expect(merged).toContain('SQLite 已合并');
  });

  it('routes TEST-SPLIT list simulation through local-api SQLite endpoint', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        ok: true,
        simulated: true,
        writeStatus: 'readback_merged',
        resultPostingNumbers: ['TEST-SPLIT-0001-1', 'TEST-SPLIT-0001-2'],
        childPostingNumbers: ['TEST-SPLIT-0001-2'],
      })
    );

    const result = await simulateOrderTestSplit({
      shopId: 'ozon-shop-1',
      postingNumber: 'TEST-SPLIT-0001-1',
      splitQuantities: [1, 2],
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/orders/test-split-simulation');
    expect(JSON.parse(options.body)).toMatchObject({
      shopId: 'ozon-shop-1',
      postingNumber: 'TEST-SPLIT-0001-1',
      splitQuantities: [1, 2],
    });
    expect(result).toMatchObject({
      ok: true,
      writeStatus: 'readback_merged',
      resultPostingNumbers: ['TEST-SPLIT-0001-1', 'TEST-SPLIT-0001-2'],
      childPostingNumbers: ['TEST-SPLIT-0001-2'],
    });
  });

  it('keeps TEST-SPLIT simulation as parent plus child rows, not parent plus every part again', () => {
    const result = buildSimulatedSalesOrderSplitResult({ posting: 'TEST-SPLIT-0001-1' }, [1, 1, 1]);

    expect(result.resultPostingNumbers).toEqual(['TEST-SPLIT-0001-1', 'TEST-SPLIT-0001-2', 'TEST-SPLIT-0001-3']);
    expect(result.childPostingNumbers).toEqual(['TEST-SPLIT-0001-2', 'TEST-SPLIT-0001-3']);
    expect(result.payload.result.parent_posting).toMatchObject({
      posting_number: 'TEST-SPLIT-0001-1',
      quantity: 1,
    });
    expect(result.payload.result.postings).toEqual([
      { posting_number: 'TEST-SPLIT-0001-2', quantity: 1 },
      { posting_number: 'TEST-SPLIT-0001-3', quantity: 1 },
    ]);
  });
});

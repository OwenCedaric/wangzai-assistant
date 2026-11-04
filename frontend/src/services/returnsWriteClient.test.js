import { afterEach, describe, expect, it, vi } from 'vitest';
import { getReturnsWriteStatusMessage, requestReturnsWriteOperation } from './returnsWriteClient';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('returnsWriteClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('previews and confirms Ozon returns writes through generic local-api write guard routes', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/api/write/returns/preview')) {
        return jsonResponse({ ok: true, previewId: 'returns-preview-1', requiresConfirmation: true });
      }
      if (path.includes('/api/write/returns/confirm')) {
        return jsonResponse({
          ok: true,
          previewId: 'returns-preview-1',
          action: 'verifyRfbsReturn',
          endpointKey: 'returns.verifyRfbsReturn',
          writeStatus: 'submitted_waiting_readback',
          schedulerResult: { ok: true, accepted: true, data: { status: 'accepted' } },
          readBack: { status: 'pending', rows: 0 },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'UNEXPECTED_ROUTE' } }, 404);
    });

    const result = await requestReturnsWriteOperation({
      shopId: 'shop-returns-1',
      action: 'verifyRfbsReturn',
      endpointKey: 'returns.verifyRfbsReturn',
      payload: { return_id: 'ret-1' },
      idempotencyKey: 'returns:verifyRfbsReturn:shop-returns-1:ret-1',
      realWrite: true,
      dryRun: false,
    });

    const calls = fetchMock.mock.calls.map(([url, options]) => ({ url: String(url), body: JSON.parse(options.body) }));
    expect(calls[0].url).toContain('/api/write/returns/preview');
    expect(calls[1].url).toContain('/api/write/returns/confirm');
    expect(calls.every((call) => !call.url.includes('/api/' + 'ozon/request'))).toBe(true);
    expect(calls[1].body).toMatchObject({
      previewId: 'returns-preview-1',
      confirm: true,
      realWrite: true,
      dryRun: false,
      action: 'verifyRfbsReturn',
      endpointKey: 'returns.verifyRfbsReturn',
    });
    expect(result.localApiWrite).toMatchObject({
      domain: 'returns',
      action: 'verifyRfbsReturn',
      endpointKey: 'returns.verifyRfbsReturn',
      writeStatus: 'submitted_waiting_readback',
    });
    expect(result.localApiWrite.message).toContain('等待回读确认');
    expect(result.localApiWrite.message).not.toContain('写入完成');
  });

  it('uses real write gate status copy when the real write switch blocks the confirm step', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: true, previewId: 'returns-preview-2' }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: false,
          writeStatus: 'blocked_real_write_disabled',
          error: { code: 'REAL_OZON_WRITE_DISABLED' },
        })
      );

    await expect(
      requestReturnsWriteOperation({
        shopId: 'shop-returns-2',
        action: 'refundRfbsReturn',
        endpointKey: 'returns.refundRfbsReturn',
        payload: { return_id: 'ret-2' },
        realWrite: true,
        dryRun: false,
      })
    ).rejects.toThrow('真实 Ozon 写入总开关未开启，本次不会提交 Ozon。');
  });

  it('defaults confirmed returns operations to real Ozon write instead of dry-run', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: true, previewId: 'returns-preview-default-real' }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          previewId: 'returns-preview-default-real',
          action: 'refundRfbsReturn',
          endpointKey: 'returns.refundRfbsReturn',
          writeStatus: 'submitted_waiting_readback',
          schedulerResult: { ok: true, accepted: true },
        })
      );

    await requestReturnsWriteOperation({
      shopId: 'shop-returns-3',
      action: 'refundRfbsReturn',
      endpointKey: 'returns.refundRfbsReturn',
      payload: { return_id: 'ret-3' },
    });

    const confirmBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(confirmBody).toMatchObject({
      confirm: true,
      realWrite: true,
      dryRun: false,
    });
  });

  it('does not describe submitted returns writes as completed before readback merge', () => {
    const submitted = getReturnsWriteStatusMessage({ writeStatus: 'submitted_waiting_readback' });
    const merged = getReturnsWriteStatusMessage({ writeStatus: 'readback_merged' });

    expect(submitted).toContain('等待回读确认');
    expect(submitted).not.toContain('写入完成');
    expect(merged).toContain('SQLite 已合并');
  });
});

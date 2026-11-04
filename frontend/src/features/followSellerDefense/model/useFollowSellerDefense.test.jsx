import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureFollowSellersForTargets,
  collectFollowSellerScheme2EvidenceInBrowser,
  confirmFollowSellerCase,
  finalizeFollowSellerEvidence,
  getFollowSellerLogins,
  getFollowSellerOverview,
  prepareFollowSellerCases,
  prepareFollowSellerQuickCases,
  prepareFollowSellerVerification,
  recordFollowSellerCapture,
  retryFollowSellerCapture,
  recordFollowSellerSubmissionResult,
  showActiveFollowSellerQuickBrowser,
  toggleActiveFollowSellerVerificationBrowser,
  startFollowSellerPatrol,
  submitFollowSellerComplaintInBrowser,
  submitFollowSellerQuickBatchInBrowser,
  verifyFollowSellerCase,
} from '../services/followSellerDefenseService.js';
import { useFollowSellerDefense } from './useFollowSellerDefense.js';

vi.mock('../services/followSellerDefenseService.js', () => ({
  captureFollowSellersForTargets: vi.fn(),
  collectFollowSellerScheme2EvidenceInBrowser: vi.fn(),
  confirmFollowSellerCase: vi.fn(),
  createFollowSellerLoginProfile: vi.fn(),
  getFollowSellerLogins: vi.fn(),
  getFollowSellerOverview: vi.fn(),
  finalizeFollowSellerEvidence: vi.fn(),
  openFollowSellerLoginBrowser: vi.fn(),
  prepareFollowSellerCases: vi.fn(),
  prepareFollowSellerQuickCases: vi.fn(),
  prepareFollowSellerVerification: vi.fn(),
  recordFollowSellerSubmissionResult: vi.fn(),
  recordFollowSellerCapture: vi.fn(),
  retryFollowSellerCapture: vi.fn(),
  resolveFollowSellerProduct: vi.fn(),
  selectFollowSellerLogin: vi.fn(),
  showActiveFollowSellerQuickBrowser: vi.fn(),
  toggleActiveFollowSellerVerificationBrowser: vi.fn(),
  startFollowSellerPatrol: vi.fn(),
  submitFollowSellerComplaintInBrowser: vi.fn(),
  submitFollowSellerQuickBatchInBrowser: vi.fn(),
  verifyFollowSellerCase: vi.fn(),
}));

const pendingCases = [
  { id: 'case-1', caseId: 'case-1', sku: '900000001', offerId: 'OFFER-1', status: 'pending_capture' },
  { id: 'case-2', caseId: 'case-2', sku: '900000002', offerId: 'OFFER-2', status: 'pending_capture' },
];

describe('useFollowSellerDefense full-shop patrol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFollowSellerOverview.mockResolvedValue({ cases: [], patrols: [], counts: { total: 0 } });
    getFollowSellerLogins.mockResolvedValue({
      profiles: [{
        id: 'follow-login-1',
        platformName: 'Ozon 前台巡查 1',
        connected: true,
      }],
      selectedProfileId: 'follow-login-1',
    });
    startFollowSellerPatrol.mockResolvedValue({
      patrol: { id: 'patrol-1', totalCount: 2, scannedCount: 0, failedCount: 0 },
      cases: pendingCases,
      captureTargets: pendingCases.map((item) => ({ caseId: item.id, sku: item.sku })),
    });
    captureFollowSellersForTargets.mockImplementation(async ({ onBatch, onProgress }) => {
      await onBatch({
        done: 1,
        total: 2,
        failed: 0,
        results: [{ sku: '900000001', followSellerCount: 1 }],
      });
      onProgress({ done: 1, total: 2, failed: 0 });
      await onBatch({
        done: 2,
        total: 2,
        failed: 0,
        results: [{ sku: '900000002', followSellerCount: 0 }],
      });
      onProgress({ done: 2, total: 2, failed: 0 });
      return { ok: true, results: [], failed: 0 };
    });
    recordFollowSellerCapture.mockImplementation(async (body) => {
      if (body.final === true) {
        return {
          patrol: { id: 'patrol-1', totalCount: 2, scannedCount: 2, followedCount: 1, clearCount: 1, failedCount: 0 },
          updatedCases: [],
        };
      }
      const detected = body.results[0].sku === '900000001';
      return {
        patrol: { id: 'patrol-1', totalCount: 2, scannedCount: detected ? 1 : 2, followedCount: 1, clearCount: detected ? 0 : 1, failedCount: 0 },
        updatedCases: [{
          ...(detected ? pendingCases[0] : pendingCases[1]),
          status: detected ? 'detected' : 'clear',
          followCountBefore: detected ? 1 : 0,
        }],
      };
    });
  });

  it('persists and renders every completed browser batch before finalizing', async () => {
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    await act(async () => {
      await result.current.scanShop();
    });

    expect(recordFollowSellerCapture).toHaveBeenCalledTimes(3);
    expect(captureFollowSellersForTargets).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'follow-login-1',
      shopId: 'shop-1',
    }));
    expect(getFollowSellerLogins).toHaveBeenCalledWith();
    expect(recordFollowSellerCapture.mock.calls.map(([body]) => body.final)).toEqual([false, false, true]);
    expect(result.current.currentCases.map((item) => item.status)).toEqual(['detected', 'clear']);
    expect(result.current.progress).toEqual({ done: 2, total: 2, failed: 0 });
    expect(result.current.notice).toBe('巡查完成，发现 1 个被跟卖商品。');
  });

  it('updates one SKU row immediately while the browser batch is still running', async () => {
    let releaseBatch;
    captureFollowSellersForTargets.mockImplementation(async ({ onResult, onProgress, onBatch }) => {
      onResult({
        result: { sku: '900000001', confirmed: true, followSellerConfirmed: true, followSellerCount: 4 },
      });
      onProgress({ done: 1, total: 2, failed: 0 });
      await new Promise((resolve) => { releaseBatch = resolve; });
      onResult({
        result: { sku: '900000002', confirmed: true, followSellerConfirmed: true, followSellerCount: 0 },
      });
      await onBatch({
        done: 2,
        total: 2,
        failed: 0,
        results: [
          { sku: '900000001', confirmed: true, followSellerCount: 4 },
          { sku: '900000002', confirmed: true, followSellerCount: 0 },
        ],
      });
      onProgress({ done: 2, total: 2, failed: 0 });
      return { ok: true, results: [], failed: 0 };
    });
    recordFollowSellerCapture.mockImplementation(async (body) => ({
      patrol: {
        id: 'patrol-1', totalCount: 2, scannedCount: body.final ? 2 : 2,
        followedCount: 1, clearCount: 1, failedCount: 0,
      },
      updatedCases: body.final ? [] : [
        { ...pendingCases[0], status: 'detected', followCountBefore: 4 },
        { ...pendingCases[1], status: 'clear', followCountBefore: 0 },
      ],
    }));
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    let scanPromise;
    await act(async () => {
      scanPromise = result.current.scanShop();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.currentCases[0]).toMatchObject({ status: 'detected', followCountBefore: 4 });
      expect(result.current.currentCases[1]).toMatchObject({ status: 'pending_capture' });
      expect(result.current.progress.done).toBe(1);
    });

    await act(async () => {
      releaseBatch();
      await scanPromise;
    });
    expect(result.current.currentCases.map((item) => item.status)).toEqual(['detected', 'clear']);
  });

  it('tells the user to refresh the surfaced failed page and drag the Ozon slider', async () => {
    let releaseVerification;
    captureFollowSellersForTargets.mockImplementation(({ onRecovery }) => {
      onRecovery({
        attempt: 1,
        delayMs: 0,
        networkMode: 'direct',
        reason: 'manual_verification',
      });
      return new Promise((resolve) => {
        releaseVerification = () => resolve({ ok: true, results: [], failed: 0 });
      });
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    let scanPromise;
    await act(async () => {
      scanPromise = result.current.scanShop();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.notice).toContain('请在该页面刷新一次并拖动滑块'));
    expect(result.current.busyAction).toBe('scanning');

    await act(async () => {
      releaseVerification();
      await scanPromise;
    });
  });

  it('one-click retries only the failed patrol targets and reuses the saved patrol', async () => {
    getFollowSellerOverview.mockResolvedValue({
      cases: [],
      patrols: [{ id: 'patrol-failed', failedCount: 2 }],
      counts: { total: 2, capture_failed: 2 },
    });
    retryFollowSellerCapture.mockResolvedValue({
      retry: true,
      patrol: { id: 'patrol-failed', totalCount: 2, scannedCount: 0, failedCount: 0 },
      cases: pendingCases,
      captureTargets: pendingCases.map((item) => ({ caseId: item.id, sku: item.sku })),
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.retryCaptureCount).toBe(2));

    await act(async () => {
      await result.current.retryFailedCaptures(['case-2']);
    });

    expect(retryFollowSellerCapture).toHaveBeenCalledWith(
      { shopId: 'shop-1', patrolRunId: 'patrol-failed', caseIds: ['case-2'] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(startFollowSellerPatrol).not.toHaveBeenCalled();
    expect(recordFollowSellerCapture).toHaveBeenCalled();
    expect(result.current.progress).toEqual({ done: 2, total: 2, failed: 0 });
  });

  it('runs scheme 2 from evidence preparation through browser receipt without per-case input', async () => {
    prepareFollowSellerCases.mockResolvedValue({
      ok: true,
      previews: [{ case: { id: 'case-1' }, preview: { previewId: 'preview-1' } }],
      cases: [{ id: 'case-1', status: 'preview_ready' }],
    });
    confirmFollowSellerCase
      .mockResolvedValueOnce({
        ok: true,
        requiresEvidenceCapture: true,
        captureRequest: {
          caseId: 'case-1',
          shopId: 'shop-1',
          previewId: 'preview-1',
          evidenceId: 'evidence-1',
          originalSku: '900000001',
          followerSkus: ['3771432837'],
        },
        cases: [{ id: 'case-1', status: 'preview_ready' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        requiresBrowserSubmission: true,
        submission: {
          caseId: 'case-1',
          previewId: 'preview-1',
          evidenceId: 'evidence-1',
          listingDate: '2026-08-01',
          speech: {
            initialEvidenceRu: 'Фактическое обращение',
            supplementRu: 'Дополнение',
            followerBatchRu: '3771432837',
          },
          files: [
            { kind: 'psd', path: 'C:/follow-seller-evidence/evidence.psd', sha256: 'a'.repeat(64) },
            { kind: 'pdf', path: 'C:/follow-seller-evidence/evidence.pdf', sha256: 'b'.repeat(64) },
          ],
        },
        cases: [{ id: 'case-1', status: 'submission_ready' }],
      });
    collectFollowSellerScheme2EvidenceInBrowser.mockResolvedValue({
      ok: true,
      evidenceId: 'evidence-1',
      listingDate: '2026-08-01',
      ownProductPage: { path: 'C:/follow-seller-evidence/own-product-page.png' },
      ownSellerList: { path: 'C:/follow-seller-evidence/own-seller-list.png' },
      followerProductPages: [{ path: 'C:/follow-seller-evidence/follower.png' }],
    });
    finalizeFollowSellerEvidence.mockResolvedValue({ ok: true });
    submitFollowSellerComplaintInBrowser.mockResolvedValue({
      ok: true,
      ticketId: 'ticket-10001',
      messageId: 'ticket-10001',
    });
    recordFollowSellerSubmissionResult.mockResolvedValue({
      ok: true,
      cases: [{ id: 'case-1', status: 'verification_ready' }],
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    let completed;
    await act(async () => {
      completed = await result.current.runScheme2(['case-1']);
    });

    expect(completed).toEqual({ ok: true, submitted: 1, failed: 0 });
    expect(prepareFollowSellerCases).toHaveBeenCalledWith(
      { caseIds: ['case-1'], shopId: 'shop-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(confirmFollowSellerCase).toHaveBeenCalledWith(
      { caseId: 'case-1', previewId: 'preview-1', shopId: 'shop-1' },
      expect.any(Object),
    );
    expect(confirmFollowSellerCase).toHaveBeenCalledTimes(2);
    expect(collectFollowSellerScheme2EvidenceInBrowser).toHaveBeenCalledWith(expect.objectContaining({
      captureRequest: expect.objectContaining({ evidenceId: 'evidence-1', originalSku: '900000001' }),
      signal: expect.any(AbortSignal),
    }));
    expect(finalizeFollowSellerEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: 'case-1', previewId: 'preview-1', shopId: 'shop-1' }),
      expect.any(Object),
    );
    expect(collectFollowSellerScheme2EvidenceInBrowser.mock.invocationCallOrder[0])
      .toBeLessThan(finalizeFollowSellerEvidence.mock.invocationCallOrder[0]);
    expect(finalizeFollowSellerEvidence.mock.invocationCallOrder[0])
      .toBeLessThan(submitFollowSellerComplaintInBrowser.mock.invocationCallOrder[0]);
    expect(submitFollowSellerComplaintInBrowser).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'follow-login-1',
    }));
    expect(recordFollowSellerSubmissionResult).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: 'case-1', previewId: 'preview-1', shopId: 'shop-1' }),
      expect.any(Object),
    );
    expect(result.current.notice).toContain('已取得 Ozon 回执 1 个');
  });

  it('runs scheme 1 as one exact-shop backend batch and records every explicit receipt', async () => {
    const submission = { caseId: 'case-1', previewId: 'scheme1-preview-1', shopId: 'shop-1' };
    prepareFollowSellerQuickCases.mockResolvedValue({
      ok: true,
      submissions: [{ case: { id: 'case-1', status: 'submission_ready' }, submission }],
      cases: [{ id: 'case-1', status: 'submission_ready' }],
    });
    submitFollowSellerQuickBatchInBrowser.mockImplementation(async ({ onProgress }) => {
      onProgress?.({
        stage: 'select:quality-control',
        status: 'running',
        message: '正在选择“质量监督”',
        caseId: 'case-1',
      });
      return {
        ok: true,
        results: [{ caseId: 'case-1', previewId: 'scheme1-preview-1', result: { ok: true, ticketId: 'ticket-scheme1-1' } }],
      };
    });
    recordFollowSellerSubmissionResult.mockResolvedValue({
      ok: true,
      cases: [{ id: 'case-1', status: 'verification_ready' }],
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));
    let completed;
    await act(async () => {
      completed = await result.current.runScheme1(['case-1']);
    });
    expect(completed).toEqual({ ok: true, submitted: 1, failed: 0 });
    expect(prepareFollowSellerQuickCases).toHaveBeenCalledWith(
	  { caseIds: ['case-1'], shopId: 'shop-1', resumeExisting: false },
      expect.any(Object),
    );
    expect(submitFollowSellerQuickBatchInBrowser).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-1', submissions: [submission],
    }));
    expect(recordFollowSellerSubmissionResult).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: 'case-1', previewId: 'scheme1-preview-1', shopId: 'shop-1' }),
	  expect.objectContaining({ timeoutMs: 180_000 }),
    );
    expect(result.current.scheme1Progress.map((item) => item.message)).toEqual(expect.arrayContaining([
      '正在选择“质量监督”',
      '方案1执行结束：取得 Ozon 工单回执 1 个，失败 0 个；本次不消耗积分',
    ]));
  });

  it('shows the live scheme 1 browser only while the native browser surface is active', async () => {
    const submission = { caseId: 'case-1', previewId: 'scheme1-preview-1', shopId: 'shop-1' };
    let finishBrowserBatch;
    prepareFollowSellerQuickCases.mockResolvedValue({
      ok: true,
      submissions: [{ case: { id: 'case-1', status: 'submission_ready' }, submission }],
      cases: [{ id: 'case-1', status: 'submission_ready' }],
    });
    submitFollowSellerQuickBatchInBrowser.mockImplementation(({ onProgress }) => new Promise((resolve) => {
      finishBrowserBatch = resolve;
      onProgress?.({
        stage: 'browser-surface-ready',
        status: 'running',
        message: '方案1内置浏览器已经就绪',
        caseId: 'case-1',
      });
    }));
    showActiveFollowSellerQuickBrowser.mockResolvedValue({ ok: true, visible: true });
    recordFollowSellerSubmissionResult.mockResolvedValue({
      ok: true,
      cases: [{ id: 'case-1', status: 'verification_ready' }],
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    let runPromise;
    act(() => {
      runPromise = result.current.runScheme1(['case-1']);
    });
    await waitFor(() => expect(result.current.scheme1BrowserAvailable).toBe(true));

    await act(async () => {
      await result.current.showScheme1Browser();
    });
    expect(showActiveFollowSellerQuickBrowser).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toContain('关闭观察窗口不会中断自动处理');

    await act(async () => {
      finishBrowserBatch({
        ok: true,
        results: [{
          caseId: 'case-1',
          previewId: 'scheme1-preview-1',
          result: { ok: true, ticketId: 'ticket-scheme1-1' },
        }],
      });
      await runPromise;
    });
    expect(result.current.scheme1BrowserAvailable).toBe(false);
  });

  it('uses one cancellation signal to stop scheme 1 and keeps unfinished cases unchanged', async () => {
    const submission = { caseId: 'case-1', previewId: 'scheme1-preview-1', shopId: 'shop-1' };
    let receivedSignal;
    prepareFollowSellerQuickCases.mockResolvedValue({
      ok: true,
      submissions: [{ case: { id: 'case-1', status: 'submission_ready' }, submission }],
      cases: [{ id: 'case-1', status: 'submission_ready' }],
    });
    submitFollowSellerQuickBatchInBrowser.mockImplementation(({ signal }) => {
      receivedSignal = signal;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({
        ok: false,
        canceled: true,
        results: [],
      }), { once: true }));
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    let runPromise;
    act(() => {
      runPromise = result.current.runScheme1(['case-1']);
    });
    await waitFor(() => expect(result.current.canStopTask).toBe(true));
    act(() => {
      expect(result.current.cancelCurrentTask()).toBe(true);
    });
    let completed;
    await act(async () => {
      completed = await runPromise;
    });

    expect(receivedSignal.aborted).toBe(true);
    expect(completed).toEqual(expect.objectContaining({ ok: false, canceled: true, submitted: 0 }));
    expect(recordFollowSellerSubmissionResult).not.toHaveBeenCalled();
    expect(result.current.busyAction).toBe('');
    expect(result.current.notice).toContain('未完成项可稍后继续');
  });

	it('continues the previous scheme 1 ticket from its saved breakpoint without charging twice', async () => {
	  const submission = {
		caseId: 'case-1',
		previewId: 'scheme1-preview-1',
		shopId: 'shop-1',
		continuation: {
		  requested: true,
		  ticketId: '90620788',
		  pageUrl: 'https://seller.ozon.ru/app/messenger/?id=resume-ticket-1&group=support_v2',
		  phase: 'wait-evidence-prompt',
		  previousSubmissionStarted: true,
		},
	  };
	  prepareFollowSellerQuickCases.mockResolvedValue({
		ok: true,
		submissions: [{ case: { id: 'case-1', status: 'submission_ready' }, submission }],
		cases: [{ id: 'case-1', status: 'submission_ready' }],
	  });
	  submitFollowSellerQuickBatchInBrowser.mockResolvedValue({
		ok: true,
		results: [{ caseId: 'case-1', previewId: 'scheme1-preview-1', result: { ok: true, ticketId: '90620788' } }],
	  });
	  recordFollowSellerSubmissionResult.mockResolvedValue({
		ok: true,
		cases: [{ id: 'case-1', status: 'verification_ready' }],
	  });
	  const { result } = renderHook(() => useFollowSellerDefense({
		shops: [{ id: 'shop-1' }],
		activeShopId: 'shop-1',
		isActive: true,
	  }));
	  await waitFor(() => expect(result.current.loginReady).toBe(true));

	  await act(async () => {
		await result.current.continueScheme1('case-1');
	  });

	  expect(prepareFollowSellerQuickCases).toHaveBeenCalledWith(
		{ caseIds: ['case-1'], shopId: 'shop-1', resumeExisting: true },
		expect.any(Object),
	  );
	  expect(submitFollowSellerQuickBatchInBrowser).toHaveBeenCalledWith(expect.objectContaining({ submissions: [submission] }));
	  expect(result.current.scheme1Progress.map((item) => item.message))
		.toContain('已找到 1 个上次工单，正在打开原对话并判断需要继续提交哪一步');
	});

  it('keeps the scheme 2 daily complaint limit result without any point flow', async () => {
    prepareFollowSellerCases.mockResolvedValue({
      ok: true,
      previews: [{ case: { id: 'case-1' }, preview: { previewId: 'preview-1' } }],
      cases: [{ id: 'case-1', status: 'preview_ready' }],
    });
    confirmFollowSellerCase.mockResolvedValue({
      ok: true,
      requiresBrowserSubmission: true,
      submission: { caseId: 'case-1', previewId: 'preview-1' },
    });
    submitFollowSellerComplaintInBrowser.mockResolvedValue({
      ok: false,
      submissionStarted: true,
      error: { code: 'FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT', message: 'Ozon daily limit' },
    });
    recordFollowSellerSubmissionResult.mockResolvedValue({
      ok: false,
      result: { error: { code: 'FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT', message: 'Ozon daily limit' } },
      cases: [{ id: 'case-1', status: 'submission_failed' }],
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    let completed;
    await act(async () => {
      completed = await result.current.runScheme2(['case-1']);
    });

    expect(completed).toEqual({ ok: false, submitted: 0, failed: 1 });
    expect(result.current.notice).toContain('本次不消耗积分');
  });

  it('does not query a point balance before opening the scheme 1 browser', async () => {
    prepareFollowSellerQuickCases.mockResolvedValue({
      ok: true,
      submissions: [{
        case: { id: 'case-1', status: 'submission_ready' },
        submission: { caseId: 'case-1', previewId: 'preview-1', shopId: 'shop-1' },
      }],
    });
    submitFollowSellerQuickBatchInBrowser.mockResolvedValue({
      ok: true,
      results: [{ caseId: 'case-1', previewId: 'preview-1', result: { ok: true, ticketId: 'ticket-1' } }],
    });
    recordFollowSellerSubmissionResult.mockResolvedValue({
      ok: true,
      cases: [{ id: 'case-1', status: 'verification_ready' }],
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    await act(async () => {
      await result.current.runScheme1(['case-1']);
    });

    expect(prepareFollowSellerQuickCases).toHaveBeenCalled();
    expect(submitFollowSellerQuickBatchInBrowser).toHaveBeenCalled();
    expect(result.current.notice).toContain('本次不消耗积分');
  });

  it('keeps the Ozon daily-limit result visible when saving the failed browser result also times out', async () => {
    const submission = { caseId: 'case-1', previewId: 'scheme1-preview-1', shopId: 'shop-1' };
    prepareFollowSellerQuickCases.mockResolvedValue({
      ok: true,
      submissions: [{ case: { id: 'case-1', status: 'submission_ready' }, submission }],
      cases: [{ id: 'case-1', status: 'submission_ready' }],
    });
    submitFollowSellerQuickBatchInBrowser.mockResolvedValue({
      ok: false,
      results: [{
        caseId: 'case-1',
        previewId: 'scheme1-preview-1',
        result: {
          ok: false,
          error: {
            code: 'FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT',
            message: 'Ozon daily limit',
          },
        },
      }],
    });
    recordFollowSellerSubmissionResult.mockRejectedValue(new Error('local-api 请求超时：180000ms'));
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));
    let failure;
    await act(async () => {
      try {
        await result.current.runScheme1(['case-1']);
      } catch (error) {
        failure = error;
      }
    });
    expect(failure?.code).toBe('FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT');
    expect(result.current.error).toContain('24 小时后重试');
    expect(recordFollowSellerSubmissionResult).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: 'case-1', result: expect.objectContaining({ ok: false }) }),
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
    expect(result.current.scheme1Progress.map((item) => item.message))
      .toContain('浏览器流程已结束，正在保存每个商品的提交结果');
  });

  it('rescans the exact product once and treats any follow-count decrease as success', async () => {
    prepareFollowSellerVerification.mockResolvedValue({
      ok: true,
      target: { caseId: 'case-1', sku: '900000001' },
      baseline: { followCountBefore: 11, sellerSkus: ['3771432837'] },
    });
    captureFollowSellersForTargets.mockResolvedValue({
      ok: true,
      results: [{ sku: '900000001', confirmed: true, followSellerCount: 10 }],
      failed: 0,
    });
    verifyFollowSellerCase.mockResolvedValue({
      ok: true,
      detached: true,
      decreasedBy: 1,
      followCountBefore: 11,
      followCountAfter: 10,
      case: { id: 'case-1', status: 'detached', followCountAfter: 10 },
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    await act(async () => {
      await result.current.resume('case-1');
    });

    expect(prepareFollowSellerVerification).toHaveBeenCalledWith(
      { caseId: 'case-1', shopId: 'shop-1' },
      expect.any(Object),
    );
    expect(captureFollowSellersForTargets).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{ caseId: 'case-1', sku: '900000001' }],
      profileId: 'follow-login-1',
      concurrency: 1,
      cooldownDelaysMs: [],
    }));
    expect(captureFollowSellersForTargets).toHaveBeenCalledTimes(1);
    expect(verifyFollowSellerCase).toHaveBeenCalledWith(
      {
        caseId: 'case-1',
        result: expect.objectContaining({ sku: '900000001', followSellerCount: 10 }),
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.current.notice).toBe('');
  });

  it('runs a standalone recheck without opening support and marks zero followers as completed', async () => {
    prepareFollowSellerVerification.mockResolvedValue({
      ok: true,
      mode: 'standalone',
      target: { caseId: 'case-1', sku: '900000001' },
      baseline: { followCountBefore: 11, sellerSkus: ['3771432837'] },
    });
    captureFollowSellersForTargets.mockResolvedValue({
      ok: true,
      results: [{ sku: '900000001', confirmed: true, followSellerCount: 0 }],
      failed: 0,
    });
    verifyFollowSellerCase.mockResolvedValue({
      ok: true,
      detached: true,
      followCountBefore: 11,
      followCountAfter: 0,
      case: { id: 'case-1', status: 'detached', followCountAfter: 0 },
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    await act(async () => {
      await result.current.recheck('case-1');
    });

    expect(prepareFollowSellerVerification).toHaveBeenCalledWith(
      { caseId: 'case-1', shopId: 'shop-1', mode: 'standalone' },
      expect.any(Object),
    );
    expect(verifyFollowSellerCase).toHaveBeenCalledWith(
      {
        caseId: 'case-1',
        mode: 'standalone',
        result: expect.objectContaining({ sku: '900000001', followSellerCount: 0 }),
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(submitFollowSellerComplaintInBrowser).not.toHaveBeenCalled();
    expect(submitFollowSellerQuickBatchInBrowser).not.toHaveBeenCalled();
    expect(result.current.notice).toBe('复查完成：当前已没有跟卖，已标记为处理成功。');
  });

  it('keeps a failed recheck browser available and toggles the same page from the visualization action', async () => {
    prepareFollowSellerVerification.mockResolvedValue({
      ok: true,
      mode: 'standalone',
      target: { caseId: 'case-1', sku: '900000001' },
      baseline: { followCountBefore: 11 },
    });
    captureFollowSellersForTargets.mockImplementation(async ({ onBrowserState }) => {
      onBrowserState?.({ available: true, visible: true, tabId: 'follow-verify-1' });
      throw Object.assign(new Error('Ozon 仍在等待人工验证'), {
        code: 'FOLLOW_SELLER_MANUAL_VERIFICATION_TIMEOUT',
      });
    });
    toggleActiveFollowSellerVerificationBrowser.mockResolvedValue({
      ok: true,
      available: true,
      visible: false,
      tabId: 'follow-verify-1',
    });
    const { result } = renderHook(() => useFollowSellerDefense({
      shops: [{ id: 'shop-1' }],
      activeShopId: 'shop-1',
      isActive: true,
    }));
    await waitFor(() => expect(result.current.loginReady).toBe(true));

    await act(async () => {
      await result.current.recheck('case-1').catch(() => undefined);
    });
    expect(result.current.operationBrowserAvailable).toBe(true);
    expect(result.current.operationBrowserVisible).toBe(true);

    await act(async () => {
      await result.current.toggleOperationBrowser();
    });
    expect(toggleActiveFollowSellerVerificationBrowser).toHaveBeenCalledTimes(1);
    expect(result.current.operationBrowserAvailable).toBe(true);
    expect(result.current.operationBrowserVisible).toBe(false);
  });
});

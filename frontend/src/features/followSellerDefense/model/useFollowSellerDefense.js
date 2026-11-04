import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  captureFollowSellersForTargets,
  collectFollowSellerScheme2EvidenceInBrowser,
  confirmFollowSellerCase,
  createFollowSellerLoginProfile,
  getFollowSellerLogins,
  getFollowSellerOverview,
  finalizeFollowSellerEvidence,
  openFollowSellerLoginBrowser,
  prepareFollowSellerCases,
  prepareFollowSellerQuickCases,
  prepareFollowSellerVerification,
  recordFollowSellerSubmissionResult,
  recordFollowSellerCapture,
  retryFollowSellerCapture,
  resolveFollowSellerProduct,
  selectFollowSellerLogin,
	showActiveFollowSellerQuickBrowser,
  toggleActiveFollowSellerVerificationBrowser,
  startFollowSellerPatrol,
  submitFollowSellerComplaintInBrowser,
  submitFollowSellerQuickBatchInBrowser,
  verifyFollowSellerCase,
} from '../services/followSellerDefenseService.js';
import { formatFollowSellerError } from '../lib/followSellerDefenseDisplay.js';

function text(value) {
  return String(value ?? '').trim();
}

function errorMessage(error) {
  return formatFollowSellerError({
    code: error?.payload?.error?.code || error?.code,
    message: error?.payload?.error?.message || error?.message,
  }) || '操作没有完成，请重试。';
}

function scheme1BrowserFailure(results = []) {
  const failed = (Array.isArray(results) ? results : []).find((item) => item?.result?.ok !== true);
  if (!failed) return null;
  const code = text(failed?.result?.error?.code || failed?.result?.code || 'FOLLOW_SELLER_SCHEME1_SUBMIT_FAILED');
  const failure = new Error(code || text(failed?.result?.error?.message) || 'Ozon 卖家后台提交失败。');
  failure.code = code;
  failure.browserMessage = text(failed?.result?.error?.message);
  return failure;
}

function mergeCases(current = [], updates = []) {
  const byId = new Map((Array.isArray(current) ? current : []).map((item) => [text(item?.id || item?.caseId), item]));
  for (const update of Array.isArray(updates) ? updates : []) {
    const id = text(update?.id || update?.caseId);
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...update, id, caseId: id });
  }
  return [...byId.values()];
}

function applyStreamedCaptureResult(current = [], result = {}) {
  const sku = text(result?.sku);
  if (!sku) return current;
  const confirmed = result?.confirmed === true || result?.followSellerConfirmed === true;
  const count = Number(result?.followSellerCount);
  return current.map((item) => {
    if (text(item?.sku) !== sku) return item;
    if (!confirmed || !Number.isFinite(count) || count < 0) {
      return {
        ...item,
        status: 'capture_failed',
        lastErrorCode: text(result?.errorCode || result?.code) || 'FOLLOW_SELLER_CAPTURE_UNCONFIRMED',
        lastErrorMessage: text(result?.errorMessage || result?.detail) || '跟卖结果缺少真实数量。',
      };
    }
    const normalizedCount = Math.max(0, Math.floor(count));
    return {
      ...item,
      status: normalizedCount > 0 ? 'detected' : 'clear',
      followCountBefore: normalizedCount,
      followMinPrice: Number.isFinite(Number(result?.followMinPrice)) ? Number(result.followMinPrice) : null,
      followMaxPrice: Number.isFinite(Number(result?.followMaxPrice)) ? Number(result.followMaxPrice) : null,
      lastErrorCode: '',
      lastErrorMessage: '',
    };
  });
}

export function useFollowSellerDefense({ shops = [], activeShopId = '', isActive = true } = {}) {
  const [overview, setOverview] = useState({ cases: [], patrols: [], counts: { total: 0 } });
  const [currentPatrol, setCurrentPatrol] = useState(null);
  const [currentCases, setCurrentCases] = useState([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [scheme1Progress, setScheme1Progress] = useState([]);
	const [scheme1BrowserAvailable, setScheme1BrowserAvailable] = useState(false);
	const [scheme1BrowserOpening, setScheme1BrowserOpening] = useState(false);
  const [verificationBrowserState, setVerificationBrowserState] = useState({ available: false, visible: false });
  const [verificationBrowserOpening, setVerificationBrowserOpening] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loginProfiles, setLoginProfiles] = useState([]);
  const [selectedLoginProfileId, setSelectedLoginProfileId] = useState('');
  const [loginPendingProfileId, setLoginPendingProfileId] = useState('');
  const requestGenerationRef = useRef(0);
  const loginGenerationRef = useRef(0);
  const taskControllerRef = useRef(null);
  const scheme1ProgressSequenceRef = useRef(0);

  const beginCancelableTask = useCallback((action) => {
    taskControllerRef.current?.abort();
    const controller = new AbortController();
    taskControllerRef.current = controller;
    setBusyAction(action);
    return controller;
  }, []);

  const updateCancelableTask = useCallback((controller, action) => {
    if (taskControllerRef.current !== controller || controller.signal.aborted) return false;
    setBusyAction(action);
    return true;
  }, []);

  const finishCancelableTask = useCallback((controller) => {
    if (taskControllerRef.current !== controller) return false;
    taskControllerRef.current = null;
    setBusyAction('');
    return true;
  }, []);

  const appendScheme1Progress = useCallback((entry = {}) => {
    const message = text(entry.message);
    if (!message) return;
    const normalized = {
      id: `scheme1-progress-${scheme1ProgressSequenceRef.current += 1}`,
      stage: text(entry.stage) || 'working',
      status: text(entry.status) || 'running',
      message,
      caseId: text(entry.caseId),
      offerId: text(entry.offerId),
      originalSku: text(entry.originalSku),
      at: text(entry.at) || new Date().toISOString(),
    };
    setScheme1Progress((current) => {
      const last = current.at(-1);
      if (last
        && last.stage === normalized.stage
        && last.status === normalized.status
        && last.caseId === normalized.caseId
        && last.message === normalized.message) {
        return [...current.slice(0, -1), { ...last, at: normalized.at }];
      }
      return [...current, normalized].slice(-80);
    });
  }, []);

  const activeShop = useMemo(
    () => shops.find((shop) => text(shop.id) === text(activeShopId)) || null,
    [activeShopId, shops],
  );
  const selectedLoginProfile = useMemo(
    () => loginProfiles.find((profile) => text(profile?.id) === text(selectedLoginProfileId)) || null,
    [loginProfiles, selectedLoginProfileId],
  );
  const loginReady = selectedLoginProfile?.connected === true;
  const retryPatrol = useMemo(() => {
    if (currentPatrol?.failedCount > 0) return currentPatrol;
    return (overview.patrols || []).find((item) => item?.failedCount > 0) || null;
  }, [currentPatrol, overview.patrols]);
  const retryCaptureCount = Math.max(0, Number(retryPatrol?.failedCount) || 0);

  useEffect(() => {
    taskControllerRef.current?.abort();
    taskControllerRef.current = null;
    setCurrentPatrol(null);
    setCurrentCases([]);
    setProgress({ done: 0, total: 0, failed: 0 });
    setScheme1Progress([]);
    setError('');
    setNotice('');
  }, [activeShopId]);

  useEffect(() => () => taskControllerRef.current?.abort(), []);

  const refresh = useCallback(async () => {
    if (!text(activeShopId)) {
      setOverview({ cases: [], patrols: [], counts: { total: 0 } });
      return null;
    }
    const generation = ++requestGenerationRef.current;
    const result = await getFollowSellerOverview({ shopId: activeShopId });
    if (generation !== requestGenerationRef.current) return result;
    setOverview(result);
    return result;
  }, [activeShopId]);

  const refreshLoginProfiles = useCallback(async () => {
    const generation = ++loginGenerationRef.current;
    const result = await getFollowSellerLogins();
    if (generation !== loginGenerationRef.current) return result;
    const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
    const selectedId = text(result?.selectedProfileId);
    setLoginProfiles(profiles);
    setSelectedLoginProfileId(selectedId);
    if (loginPendingProfileId && profiles.some((profile) => (
      text(profile?.id) === text(loginPendingProfileId) && profile?.connected === true
    ))) {
      setLoginPendingProfileId('');
      setNotice('Ozon 前台巡查账号已保存，可供全部店铺巡查使用。');
    }
    return result;
  }, [loginPendingProfileId]);

  useEffect(() => {
    if (!isActive) return undefined;
    refresh().catch((failure) => setError(errorMessage(failure)));
    refreshLoginProfiles().catch((failure) => setError(errorMessage(failure)));
    return undefined;
  }, [isActive, refresh, refreshLoginProfiles]);

  useEffect(() => {
    if (!isActive || !loginPendingProfileId) return undefined;
    const timer = globalThis.setInterval(() => {
      refreshLoginProfiles().catch(() => undefined);
    }, 2_000);
    return () => globalThis.clearInterval(timer);
  }, [isActive, loginPendingProfileId, refreshLoginProfiles]);

  const chooseLoginProfile = useCallback(async (profileId) => {
    const normalizedProfileId = text(profileId);
    if (!normalizedProfileId) return null;
    setBusyAction('selecting-login');
    setError('');
    try {
      const result = await selectFollowSellerLogin({
        profileId: normalizedProfileId,
      });
      setLoginProfiles(Array.isArray(result?.profiles) ? result.profiles : []);
      setSelectedLoginProfileId(text(result?.selectedProfileId || normalizedProfileId));
      return result;
    } catch (failure) {
      setError(errorMessage(failure));
      throw failure;
    } finally {
      setBusyAction('');
    }
  }, []);

  const openLoginProfile = useCallback(async (profile = selectedLoginProfile) => {
    if (!profile?.id) {
      const failure = new Error('请先新增一个 Ozon 前台巡查账号。');
      setError(failure.message);
      throw failure;
    }
    setBusyAction('opening-login');
    setError('');
    try {
      const result = await openFollowSellerLoginBrowser({
        profileId: profile.id,
        profileName: profile.platformName,
      });
      setLoginPendingProfileId(text(profile.id));
      setNotice('独立 Ozon 前台窗口已打开。登录后点击“保存账号”，保存成功会自动关闭。');
      return result;
    } catch (failure) {
      setError(errorMessage(failure));
      throw failure;
    } finally {
      setBusyAction('');
    }
  }, [selectedLoginProfile]);

  const createLoginProfile = useCallback(async () => {
    setBusyAction('creating-login');
    setError('');
    try {
      const profile = await createFollowSellerLoginProfile({
        sequence: loginProfiles.length + 1,
      });
      await refreshLoginProfiles();
      setSelectedLoginProfileId(text(profile.id));
      const result = await openFollowSellerLoginBrowser({
        profileId: profile.id,
        profileName: profile.platformName,
      });
      setLoginPendingProfileId(text(profile.id));
      setNotice('已新建全店共享的 Ozon 前台巡查账号。请登录并点击“保存账号”。');
      return result;
    } catch (failure) {
      setError(errorMessage(failure));
      throw failure;
    } finally {
      setBusyAction('');
    }
  }, [loginProfiles.length, refreshLoginProfiles]);

  const runScan = useCallback(async (createTask) => {
    if (!loginReady || !selectedLoginProfile?.id) {
      const failure = new Error('请先新增并保存 Ozon 前台巡查账号。该账号可供全部店铺共享。');
      setError(failure.message);
      throw failure;
    }
    const controller = beginCancelableTask('scanning');
    setError('');
    setNotice('');
    setProgress({ done: 0, total: 0, failed: 0 });
    try {
      const task = await createTask(controller.signal);
      const baseDone = Math.max(0, Number(task.patrol?.scannedCount) || 0)
        + Math.max(0, Number(task.patrol?.failedCount) || 0);
      const captureTargets = Array.isArray(task.captureTargets) ? task.captureTargets : [];
      setCurrentPatrol(task.patrol);
      setCurrentCases(task.cases || []);
      setProgress({
        done: baseDone,
        total: Math.max(Number(task.patrol?.totalCount) || 0, baseDone + captureTargets.length),
        failed: Math.max(0, Number(task.patrol?.failedCount) || 0),
      });
      await captureFollowSellersForTargets({
        targets: captureTargets,
        profileId: selectedLoginProfile.id,
        shopId: activeShopId,
        signal: controller.signal,
        onProgress: (next) => setProgress({
          done: baseDone + next.done,
          total: Math.max(Number(task.patrol?.totalCount) || 0, baseDone + next.total),
          failed: Math.max(0, Number(task.patrol?.failedCount) || 0) + next.failed,
        }),
        onResult: ({ result }) => {
          setCurrentCases((current) => applyStreamedCaptureResult(current, result));
        },
        onRecovery: ({ attempt, delayMs, networkMode, reason }) => {
          const seconds = Math.max(0, Math.ceil((Number(delayMs) || 0) / 1000));
          const route = networkMode === 'direct' ? '直连' : '系统/VPN';
          setNotice(reason === 'manual_verification'
            ? '已弹出本次连接失败的 Ozon 页面。请在该页面刷新一次并拖动滑块；页面恢复后巡查会自动继续，已完成进度不会丢失。'
            : reason === 'manual_verification_complete'
              ? `Ozon 滑块验证已通过，正在从原进度继续巡查（${route}）。`
              : reason === 'risk_control'
                ? `Ozon 正在验证巡查浏览器，系统已降为单路请求，冷却 ${seconds} 秒后进行第 ${attempt} 次复查（${route}）。已完成进度不会丢失。`
                : `当前线路未返回数据，冷却 ${seconds} 秒后进行第 ${attempt} 次恢复（${route}）。已完成进度不会丢失。`);
        },
        onBatch: async ({ results, done, total, failed }) => {
          const recordedBatch = await recordFollowSellerCapture({
            patrolRunId: task.patrol.id,
            results,
            final: false,
          }, { signal: controller.signal });
          setCurrentPatrol(recordedBatch.patrol);
          setCurrentCases((current) => mergeCases(current, recordedBatch.updatedCases || recordedBatch.cases));
          setProgress({
            done: baseDone + done,
            total: Math.max(Number(task.patrol?.totalCount) || 0, baseDone + total),
            failed: Math.max(0, Number(task.patrol?.failedCount) || 0) + failed,
          });
        },
      });
      const recorded = await recordFollowSellerCapture({
        patrolRunId: task.patrol.id,
        results: [],
        final: true,
      }, { signal: controller.signal });
      setCurrentPatrol(recorded.patrol);
      setCurrentCases((current) => mergeCases(current, recorded.updatedCases || recorded.cases));
      setProgress({
        done: recorded.patrol?.totalCount || captureTargets.length,
        total: recorded.patrol?.totalCount || captureTargets.length,
        failed: recorded.patrol?.failedCount || 0,
      });
      const followed = recorded.patrol?.followedCount || 0;
      setNotice(followed > 0 ? `巡查完成，发现 ${followed} 个被跟卖商品。` : '巡查完成，当前没有发现跟卖。');
      await refresh();
      return recorded;
    } catch (failure) {
      if (controller.signal.aborted || failure?.name === 'AbortError') {
        setNotice('巡查已停止，已经返回的结果已保存；再次点击会从未完成商品继续。');
        await refresh().catch(() => undefined);
        return null;
      }
      setNotice('');
      setError(errorMessage(failure));
      await refreshLoginProfiles().catch(() => undefined);
      throw failure;
    } finally {
      finishCancelableTask(controller);
    }
  }, [activeShopId, beginCancelableTask, finishCancelableTask, loginReady, refresh, refreshLoginProfiles, selectedLoginProfile]);

  const scanManual = useCallback((identifier) => runScan((signal) => resolveFollowSellerProduct({
    shopId: activeShopId,
    identifier,
  }, { signal })), [activeShopId, runScan]);

  const scanShop = useCallback(() => runScan((signal) => startFollowSellerPatrol({
    shopId: activeShopId,
  }, { signal })), [activeShopId, runScan]);

  const retryFailedCaptures = useCallback((caseIds = []) => runScan((signal) => retryFollowSellerCapture({
    shopId: activeShopId,
    patrolRunId: retryPatrol?.id || '',
    caseIds,
  }, { signal })), [activeShopId, retryPatrol?.id, runScan]);

  const cancelCurrentTask = useCallback(() => {
    if (!taskControllerRef.current || taskControllerRef.current.signal.aborted) return false;
    setBusyAction('canceling');
    taskControllerRef.current.abort();
    return true;
  }, []);

  const cancelScan = cancelCurrentTask;

  const prepare = useCallback(async (caseIds, { taskController = null } = {}) => {
    const ownsTask = !taskController;
    const controller = taskController || beginCancelableTask('preparing');
    if (!ownsTask) updateCancelableTask(controller, 'preparing');
    setError('');
    setNotice('');
    try {
      const result = await prepareFollowSellerCases(
        { caseIds, shopId: activeShopId },
        { signal: controller.signal },
      );
      setCurrentCases(result.cases || []);
      if (!result.ok) throw new Error('没有生成可用预览，请查看商品错误原因。');
      const evidenceModes = (result.previews || []).map((item) => text(item.preview?.evidence?.reuse?.mode));
      const reusedCount = evidenceModes.filter((mode) => mode === 'reused').length;
      const updatedCount = evidenceModes.filter((mode) => mode === 'updated').length;
      setNotice(`已整理 ${new Set((result.previews || []).map((item) => item.preview?.previewId)).size} 个处理预览；复用 ${reusedCount} 个既有证据包，更新 ${updatedCount} 个证据版本。`);
      await refresh();
      return result;
    } catch (failure) {
      if (controller.signal.aborted || failure?.name === 'AbortError') {
        setError('');
        setNotice('当前任务已停止，已完成的数据已保留。');
        await refresh().catch(() => undefined);
        return null;
      }
      setError(errorMessage(failure));
      throw failure;
    } finally {
      if (ownsTask) finishCancelableTask(controller);
    }
  }, [activeShopId, beginCancelableTask, finishCancelableTask, refresh, updateCancelableTask]);

  const confirm = useCallback(async ({ caseId, previewId }, { taskController = null } = {}) => {
    const ownsTask = !taskController;
    const controller = taskController || beginCancelableTask('confirming');
    if (!ownsTask) updateCancelableTask(controller, 'confirming');
    setError('');
    setNotice('');
    try {
      let result = await confirmFollowSellerCase(
        { caseId, previewId, shopId: activeShopId },
        { timeoutMs: 240_000, signal: controller.signal },
      );
      if (result?.requiresEvidenceCapture === true) {
        updateCancelableTask(controller, 'collecting-scheme2-evidence');
        const capture = await collectFollowSellerScheme2EvidenceInBrowser({
          captureRequest: result.captureRequest,
          signal: controller.signal,
        });
        await finalizeFollowSellerEvidence({
          caseId,
          previewId,
          shopId: activeShopId,
          capture,
        }, { timeoutMs: 240_000, signal: controller.signal });
        updateCancelableTask(controller, 'confirming');
        result = await confirmFollowSellerCase(
          { caseId, previewId, shopId: activeShopId },
          { timeoutMs: 240_000, signal: controller.signal },
        );
        if (result?.requiresEvidenceCapture === true) {
          const failure = new Error('方案2页面证据整合后仍未达到提交条件。');
          failure.code = 'FOLLOW_SELLER_SCHEME2_CAPTURE_NOT_APPLIED';
          throw failure;
        }
      }
      if (result?.requiresBrowserSubmission === true) {
        updateCancelableTask(controller, 'submitting-complaint');
        let browserResult;
        try {
          browserResult = await submitFollowSellerComplaintInBrowser({
            submission: result.submission,
            profileId: selectedLoginProfileId,
            signal: controller.signal,
          });
        } catch (failure) {
          if (controller.signal.aborted || failure?.name === 'AbortError') throw failure;
          browserResult = {
            ok: false,
            submissionStarted: failure?.submissionStarted === true,
            error: {
              code: text(failure?.code || failure?.message) || 'FOLLOW_SELLER_COMPLAINT_SUBMIT_FAILED',
              message: errorMessage(failure),
            },
          };
        }
        result = await recordFollowSellerSubmissionResult({
          caseId,
          previewId,
          shopId: activeShopId,
          result: browserResult,
        }, { timeoutMs: 60_000, signal: controller.signal });
        if (result?.ok !== true) {
          const failure = new Error(result?.result?.error?.message || 'Ozon 投诉提交失败，证据包已保留，可直接重试。');
          failure.code = result?.result?.error?.code || 'FOLLOW_SELLER_COMPLAINT_SUBMIT_FAILED';
          throw failure;
        }
      }
      const cases = result.cases || [];
      setNotice(cases.some((item) => item.status === 'verification_ready')
        ? '投诉已提交；可稍后点击“复查剔除结果”，重新扫描当前商品跟卖数量。'
        : '投诉处理状态已更新。');
      await refresh();
      return result;
    } catch (failure) {
      if (controller.signal.aborted || failure?.name === 'AbortError') {
        setError('');
        setNotice('当前任务已停止，已完成的数据已保留。');
        await refresh().catch(() => undefined);
        return null;
      }
      setError(errorMessage(failure));
      throw failure;
    } finally {
      if (ownsTask) finishCancelableTask(controller);
    }
  }, [activeShopId, beginCancelableTask, finishCancelableTask, refresh, selectedLoginProfileId, updateCancelableTask]);

  const runScheme2 = useCallback(async (caseIds) => {
    const ids = [...new Set((Array.isArray(caseIds) ? caseIds : []).map(text).filter(Boolean))];
    if (!ids.length) return { ok: false, submitted: 0, failed: 0 };
    const controller = beginCancelableTask('scheme2-preparing');
    setError('');
    try {
      setNotice('方案2正在检查状态并复用已有 PSD + PDF；本次不消耗积分。');
      const prepared = await prepare(ids, { taskController: controller });
      if (controller.signal.aborted || !prepared) return { ok: false, submitted: 0, failed: ids.length, canceled: true };
      const previews = Array.isArray(prepared?.previews) ? prepared.previews : [];
      let submitted = 0;
      let failed = ids.length - previews.length;
      for (const item of previews) {
        const caseId = text(item?.case?.id || item?.case?.caseId);
        const previewId = text(item?.preview?.previewId || item?.case?.previewId);
        if (!caseId || !previewId) {
          failed += 1;
          continue;
        }
        try {
          const confirmed = await confirm({ caseId, previewId }, { taskController: controller });
          if (controller.signal.aborted || !confirmed) {
            return { ok: false, submitted, failed: ids.length - submitted, canceled: true };
          }
          submitted += 1;
        } catch (failure) {
          failed += 1;
        }
      }
      setNotice(`方案2处理完成：已取得 Ozon 回执 ${submitted} 个，失败 ${failed} 个；本次不消耗积分，失败案件已保留证据包。`);
      await refresh();
      return { ok: submitted > 0 && failed === 0, submitted, failed };
    } catch (failure) {
      if (controller.signal.aborted || failure?.name === 'AbortError') {
        setError('');
        setNotice('方案2任务已停止，已完成的结果已保留。');
        await refresh().catch(() => undefined);
        return { ok: false, submitted: 0, failed: ids.length, canceled: true };
      }
      setError(errorMessage(failure));
      throw failure;
    } finally {
      finishCancelableTask(controller);
    }
  }, [beginCancelableTask, confirm, finishCancelableTask, prepare, refresh]);

  const runScheme1 = useCallback(async (caseIds, { resumeExisting = false } = {}) => {
    const ids = [...new Set((Array.isArray(caseIds) ? caseIds : []).map(text).filter(Boolean))];
    if (!ids.length) return { ok: false, submitted: 0, failed: 0 };
    const controller = beginCancelableTask('scheme1-preparing');
    setError('');
    setNotice('');
	setScheme1BrowserAvailable(false);
    setScheme1Progress([]);
    appendScheme1Progress({
      stage: 'prepare-materials',
      message: resumeExisting
		? `正在读取 ${ids.length} 个商品上次失败的 Ozon 工单和断点`
		: `正在检查 ${ids.length} 个商品的状态和方案1材料`,
    });
    try {
      const prepared = await prepareFollowSellerQuickCases({
		caseIds: ids,
		shopId: activeShopId,
		resumeExisting,
	  }, { timeoutMs: 240_000, signal: controller.signal });
      const submissions = (Array.isArray(prepared?.submissions) ? prepared.submissions : [])
        .map((item) => item?.submission)
        .filter(Boolean);
      if (!submissions.length) throw new Error('没有生成可提交的方案1材料，请查看商品错误原因。');
	  const continuingExistingCount = submissions
		.filter((item) => item?.continuation?.requested === true)
		.length;
      appendScheme1Progress({
        stage: 'materials-ready',
		message: continuingExistingCount > 0
		  ? `已找到 ${continuingExistingCount} 个上次工单，正在打开原对话并判断需要继续提交哪一步`
		  : `材料准备完成，共 ${submissions.length} 个商品，开始连接 Ozon 客服`,
      });
      updateCancelableTask(controller, 'scheme1-submitting');
      const browserBatch = await submitFollowSellerQuickBatchInBrowser({
        submissions,
        shopId: activeShopId,
		signal: controller.signal,
		onProgress: (entry = {}) => {
		  if (entry.stage === 'browser-surface-ready') setScheme1BrowserAvailable(true);
		  if (entry.stage === 'browser-closed') setScheme1BrowserAvailable(false);
		  appendScheme1Progress({
			...entry,
			message: entry.status === 'failed'
			  ? formatFollowSellerError({ code: entry.code, message: entry.message })
			  : entry.message,
		  });
		},
      });
      const primaryBrowserFailure = scheme1BrowserFailure(browserBatch.results);
      appendScheme1Progress({
        stage: 'save-results',
        message: '浏览器流程已结束，正在保存每个商品的提交结果',
      });
      const recordResults = await Promise.allSettled((browserBatch.results || []).map((item) => recordFollowSellerSubmissionResult({
        caseId: item.caseId,
        previewId: item.previewId,
        shopId: activeShopId,
        result: item.result,
      }, {
        timeoutMs: 180_000,
        ...(controller.signal.aborted ? {} : { signal: controller.signal }),
      })));
      if (browserBatch.canceled === true || controller.signal.aborted) {
        appendScheme1Progress({
          stage: 'canceled',
          status: 'warning',
          message: '方案1任务已停止，已完成的商品结果已保留，未完成商品保持原状态',
        });
        setNotice('方案1任务已停止，已完成的结果已保留，未完成项可稍后继续。');
        await refresh().catch(() => undefined);
        return {
          ok: false,
          canceled: true,
          submitted: recordResults.filter((item) => item.status === 'fulfilled' && item.value?.ok === true).length,
          failed: ids.length - (browserBatch.results || []).length,
        };
      }
      if (primaryBrowserFailure) throw primaryBrowserFailure;
      const recordFailure = recordResults.find((item) => item.status === 'rejected');
      if (recordFailure) throw recordFailure.reason;
      const recorded = recordResults.map((item) => item.value);
      const submitted = recorded.filter((item) => item?.ok === true).length;
      const failed = ids.length - submitted;
      appendScheme1Progress({
        stage: 'completed',
        status: failed === 0 ? 'completed' : 'warning',
        message: `方案1执行结束：取得 Ozon 工单回执 ${submitted} 个，失败 ${failed} 个；本次不消耗积分`,
      });
	    setNotice(`方案1已取得 Ozon 工单回执 ${submitted} 个，失败 ${failed} 个；本次不消耗积分，可直接点击“复查剔除结果”，已提交记录不会重复提交。`);
      await refresh();
      return { ok: failed === 0 && submitted > 0, submitted, failed };
    } catch (failure) {
      if (controller.signal.aborted || failure?.name === 'AbortError') {
        appendScheme1Progress({
          stage: 'canceled',
          status: 'warning',
          message: '方案1任务已停止，已完成的数据已保留',
        });
        setError('');
        setNotice('方案1任务已停止，临时浏览器已关闭，未完成项保持原状态。');
        await refresh().catch(() => undefined);
        return { ok: false, canceled: true, submitted: 0, failed: ids.length };
      }
      const readable = errorMessage(failure);
      appendScheme1Progress({
        stage: 'failed',
        status: 'failed',
        message: readable,
      });
      setError(readable);
      await refresh().catch(() => undefined);
      throw failure;
    } finally {
	  setScheme1BrowserAvailable(false);
      finishCancelableTask(controller);
    }
  }, [activeShopId, appendScheme1Progress, beginCancelableTask, finishCancelableTask, refresh, updateCancelableTask]);

	const showScheme1Browser = useCallback(async () => {
		setScheme1BrowserOpening(true);
		setError('');
		try {
			const result = await showActiveFollowSellerQuickBrowser();
			setNotice('已显示方案1正在使用的内置浏览器；关闭观察窗口不会中断自动处理。');
			return result;
		} catch (failure) {
			setError(errorMessage(failure));
			throw failure;
		} finally {
			setScheme1BrowserOpening(false);
		}
	}, []);

  const toggleOperationBrowser = useCallback(async () => {
    if (!verificationBrowserState.available) return showScheme1Browser();
    setVerificationBrowserOpening(true);
    setError('');
    try {
      const result = await toggleActiveFollowSellerVerificationBrowser();
      setVerificationBrowserState({ available: true, visible: result?.visible === true });
      setNotice(result?.visible === true
        ? '已显示当前复查使用的内置浏览器。'
        : '已隐藏当前复查浏览器，任务和登录会话继续保留。');
      return result;
    } catch (failure) {
      setVerificationBrowserState({ available: false, visible: false });
      setError(errorMessage(failure));
      throw failure;
    } finally {
      setVerificationBrowserOpening(false);
    }
  }, [showScheme1Browser, verificationBrowserState.available]);

	const continueScheme1 = useCallback((caseId) => runScheme1([caseId], { resumeExisting: true }), [runScheme1]);

  const resume = useCallback(async (caseId, { standalone = false } = {}) => {
    const controller = beginCancelableTask(standalone ? 'rechecking' : 'verifying');
    setError('');
    setNotice('');
    try {
      const prepared = await prepareFollowSellerVerification({
        caseId,
        shopId: activeShopId,
        ...(standalone ? { mode: 'standalone' } : {}),
      }, { timeoutMs: 60_000, signal: controller.signal });
      const target = prepared?.target;
      if (!target?.caseId || !target?.sku) {
        const failure = new Error('复查任务缺少当前商品 SKU，已停止扫描。');
        failure.code = 'FOLLOW_SELLER_VERIFICATION_TARGET_INVALID';
        throw failure;
      }
      setNotice(standalone
        ? '正在单独复查当前商品，本次只重新读取跟卖列表，不进入客服。'
        : '正在复查当前商品，本次只扫描一个商品并与提交前跟卖数量对比。');
      const capture = await captureFollowSellersForTargets({
        targets: [target],
        profileId: selectedLoginProfileId,
        shopId: activeShopId,
        concurrency: 1,
        cooldownDelaysMs: [],
        signal: controller.signal,
        onProgress: setProgress,
        onBrowserState: (state = {}) => setVerificationBrowserState({
          available: state.available === true,
          visible: state.visible === true,
        }),
      });
      const captured = (capture.results || []).find((item) => text(item?.sku) === text(target.sku)) || {
        sku: target.sku,
        errorCode: 'FOLLOW_SELLER_VERIFICATION_CAPTURE_MISSING',
        errorMessage: '本次没有取得当前商品的跟卖数量。',
      };
      const result = await verifyFollowSellerCase({
        caseId,
        result: captured,
        ...(standalone ? { mode: 'standalone' } : {}),
      }, { signal: controller.signal });
      if (result?.ok !== true) {
        const failure = new Error(result?.case?.lastErrorMessage || '本次没有取得可比较的跟卖数量，请重试。');
        failure.code = result?.case?.lastErrorCode || 'FOLLOW_SELLER_VERIFICATION_CAPTURE_FAILED';
        throw failure;
      }
      setNotice(standalone
        ? result.detached
          ? '复查完成：当前已没有跟卖，已标记为处理成功。'
          : `复查完成：当前仍有 ${Number(result.followCountAfter) || 0} 个跟卖，已更新最新数量。`
        : '');
      await refresh();
      return result;
    } catch (failure) {
      if (controller.signal.aborted || failure?.name === 'AbortError') {
        setError('');
        setNotice('复查任务已停止，未完成项保持原状态。');
        await refresh().catch(() => undefined);
        return null;
      }
      setNotice('');
      setError(errorMessage(failure));
      await refresh().catch(() => undefined);
      throw failure;
    } finally {
      finishCancelableTask(controller);
    }
  }, [activeShopId, beginCancelableTask, finishCancelableTask, refresh, selectedLoginProfileId]);

  const recheck = useCallback((caseId) => resume(caseId, { standalone: true }), [resume]);

  return {
    activeShop,
    loginProfiles,
    selectedLoginProfileId,
    selectedLoginProfile,
    loginReady,
    loginPendingProfileId,
    overview,
    currentPatrol,
    currentCases,
    progress,
    scheme1Progress,
	scheme1BrowserAvailable,
	scheme1BrowserOpening,
    operationBrowserAvailable: verificationBrowserState.available || scheme1BrowserAvailable,
    operationBrowserOpening: verificationBrowserOpening || scheme1BrowserOpening,
    operationBrowserVisible: verificationBrowserState.available && verificationBrowserState.visible,
    retryCaptureCount,
    busyAction,
    error,
    notice,
    clearFeedback: () => { setError(''); setNotice(''); },
    refresh,
    refreshLoginProfiles,
    chooseLoginProfile,
    createLoginProfile,
    openLoginProfile,
    scanManual,
    scanShop,
    retryFailedCaptures,
    cancelScan,
    cancelCurrentTask,
    canStopTask: Boolean(taskControllerRef.current && !taskControllerRef.current.signal.aborted),
    prepare,
    confirm,
    runScheme1,
	continueScheme1,
	showScheme1Browser,
    toggleOperationBrowser,
    runScheme2,
    resume,
    recheck,
  };
}

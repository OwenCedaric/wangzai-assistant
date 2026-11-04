import React from 'react';
import {
  confirmPurchaseCapture,
  normalizePurchaseBrowserTarget,
  previewPurchaseCapture,
  readPurchaseCapture,
} from '../services/purchaseBrowserCaptureClient.js';
import {
  getPurchaseBrowserErrorMessage,
  PURCHASE_BROWSER_TARGET_PHASES,
  recoverPurchaseBrowser,
  setPurchaseBrowserTarget,
  clearPurchaseBrowserTarget,
} from '../services/purchaseBrowserLoginClient.js';

function validTargetPhase(value, fallback = 'idle') {
  return PURCHASE_BROWSER_TARGET_PHASES.includes(value) ? value : fallback;
}

function targetKey(value) {
  if (!value) return '';
  return JSON.stringify([
    value.targetId,
    value.shopId,
    value.orderKey,
    value.ozonOrderId,
    value.sku,
    value.offerId,
    value.productTitle,
    value.quantity,
    value.purchaseRecordId,
    [...(Array.isArray(value.requiredFields) ? value.requiredFields : [])].sort(),
  ]);
}

export function usePurchaseBrowserTargetMode({
  tabId = '',
  target = null,
  targetPhase: externalTargetPhase = '',
} = {}) {
  const initialTarget = target ? normalizePurchaseBrowserTarget(target) : null;
  const [targetState, setTargetState] = React.useState(initialTarget);
  const [targetLocked, setTargetLocked] = React.useState(Boolean(initialTarget));
  const [targetPhase, setTargetPhase] = React.useState(() =>
    validTargetPhase(externalTargetPhase, initialTarget ? 'target-locked' : 'idle')
  );
  const [targetCandidates, setTargetCandidates] = React.useState([]);
  const [targetError, setTargetError] = React.useState('');
  const [captureResult, setCaptureResult] = React.useState(null);
  const [capturePreview, setCapturePreview] = React.useState(null);
  const [captureBusy, setCaptureBusy] = React.useState(false);
  const [captureError, setCaptureError] = React.useState('');
  const [recoveryState, setRecoveryState] = React.useState('idle');
  const abortRef = React.useRef(null);
  const targetKeyRef = React.useRef(targetKey(initialTarget));
  const externalPhaseRef = React.useRef(externalTargetPhase);

  React.useEffect(() => {
    const nextTarget = target ? normalizePurchaseBrowserTarget(target) : null;
    const nextTargetKey = targetKey(nextTarget);
    const targetChanged = nextTargetKey !== targetKeyRef.current;
    const phaseChanged = externalTargetPhase !== externalPhaseRef.current;
    if (!nextTarget) {
      setTargetState(null);
      setTargetLocked(false);
      if (targetChanged || phaseChanged) setTargetPhase('idle');
      targetKeyRef.current = '';
      externalPhaseRef.current = externalTargetPhase;
      return;
    }
    setTargetState(nextTarget);
    setTargetLocked(true);
    if (targetChanged || phaseChanged) {
      if (targetChanged) {
        // A preview is bound to the previous target hash. Never leave it
        // confirmable after an explicit target switch or recovery.
        setCapturePreview(null);
        setCaptureResult(null);
        setCaptureError('');
      }
      setTargetPhase(validTargetPhase(externalTargetPhase, 'target-locked'));
    }
    targetKeyRef.current = nextTargetKey;
    externalPhaseRef.current = externalTargetPhase;
  }, [externalTargetPhase, target]); // target snapshots are the authoritative native state

  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    []
  );

  const selectTarget = React.useCallback(
    async (value) => {
      const normalized = normalizePurchaseBrowserTarget(value);
      if (!normalized.targetId || !normalized.shopId || !normalized.orderKey) {
        setTargetError('目标订单缺少店铺或订单键，不能锁定。');
        setTargetPhase('error');
        return null;
      }
      if (!tabId) {
        setTargetError('请先打开内置采购浏览器。');
        setTargetPhase('error');
        return null;
      }
      setTargetError('');
      setTargetPhase('target-selecting');
      try {
        const result = await setPurchaseBrowserTarget({ tabId, target: normalized });
        setTargetState(normalized);
        setTargetLocked(true);
        setCapturePreview(null);
        setCaptureResult(null);
        setCaptureError('');
        const nextPhase = validTargetPhase(result?.targetPhase, 'target-locked');
        targetKeyRef.current = targetKey(normalized);
        externalPhaseRef.current = nextPhase;
        setTargetPhase(nextPhase);
        return result;
      } catch (error) {
        setTargetPhase('error');
        setTargetError(getPurchaseBrowserErrorMessage(error));
        return null;
      }
    },
    [tabId]
  );

  const enterTargetMode = React.useCallback((value) => selectTarget(value), [selectTarget]);

  const clearTarget = React.useCallback(async () => {
    setTargetPhase('target-selecting');
    if (tabId) {
      try {
        await clearPurchaseBrowserTarget(tabId);
      } catch (error) {
        setTargetPhase('error');
        setTargetError(getPurchaseBrowserErrorMessage(error));
        return null;
      }
    }
    setTargetState(null);
    setTargetLocked(false);
    setCaptureResult(null);
    setCapturePreview(null);
    setCaptureError('');
    setTargetError('');
    targetKeyRef.current = '';
    externalPhaseRef.current = 'idle';
    setTargetPhase('idle');
    return { ok: true, target: null };
  }, [tabId]);

  const capture = React.useCallback(async () => {
    if (!tabId) {
      setCaptureError('请先打开内置采购浏览器。');
      return null;
    }
    if (!targetState || !targetLocked) {
      setCaptureError('请先锁定目标订单，再捕捉采购信息。');
      return null;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCaptureBusy(true);
    setCaptureError('');
    setCapturePreview(null);
    setCaptureResult(null);
    setTargetPhase('capturing');
    try {
      const result = await previewPurchaseCapture({ tabId, target: targetState, signal: controller.signal });
      setCaptureResult(result.capture);
      setCapturePreview(result.preview);
      setTargetPhase(validTargetPhase(result?.targetPhase, result.preview ? 'capture-preview' : 'target-locked'));
      return result;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setTargetPhase('error');
        setCaptureError(getPurchaseBrowserErrorMessage(error));
      }
      return null;
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setCaptureBusy(false);
      }
    }
  }, [tabId, targetLocked, targetState]);

  const openPreview = React.useCallback(() => capturePreview, [capturePreview]);

  const confirmCapture = React.useCallback(
    async ({ acceptConflicts = false } = {}) => {
      if (!capturePreview || !targetState) {
        setCaptureError('当前没有可确认的捕捉预览。');
        setTargetPhase('error');
        return null;
      }
      if (capturePreview.target?.targetId && capturePreview.target.targetId !== targetState.targetId) {
        setCaptureError('捕捉预览已不属于当前目标，请重新捕捉。');
        setTargetPhase('error');
        return null;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setCaptureBusy(true);
      setCaptureError('');
      setTargetPhase('confirming');
      try {
        setTargetPhase('saving');
        const result = await confirmPurchaseCapture({
          tabId,
          preview: capturePreview,
          target: targetState,
          acceptConflicts,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return null;
        if (result?.readbackVerified !== true) {
          const error = new Error('PURCHASE_BROWSER_READBACK_FAILED');
          error.code = 'PURCHASE_BROWSER_READBACK_FAILED';
          throw error;
        }
        setTargetPhase('readback');
        setCapturePreview(null);
        setTargetPhase('completed');
        return result;
      } catch (error) {
        // Keep both the preview and the captured fields so the user can retry
        // after a transient API/readback failure without losing their review.
        if (error?.name !== 'AbortError' && !controller.signal.aborted) {
          setTargetPhase('error');
          setCaptureError(getPurchaseBrowserErrorMessage(error));
        }
        return null;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setCaptureBusy(false);
        }
      }
    },
    [capturePreview, tabId, targetState]
  );

  const cancelCapture = React.useCallback(() => {
    abortRef.current?.abort();
    setCapturePreview(null);
    setCaptureError('');
    setCaptureBusy(false);
    setTargetPhase(targetState ? 'target-locked' : 'idle');
  }, [targetState]);

  const recover = React.useCallback(
    async (tabOverride = '') => {
      const recoveryTabId = String(tabOverride || tabId || '').trim();
      setRecoveryState('recovering');
      setCaptureError('');
      setTargetPhase(targetState ? 'target-selecting' : 'idle');
      try {
        const result = await recoverPurchaseBrowser(recoveryTabId);
        setRecoveryState('ready');
        if (targetState) setTargetPhase('target-locked');
        return result;
      } catch (error) {
        setRecoveryState('failed');
        setTargetPhase('error');
        setCaptureError(getPurchaseBrowserErrorMessage(error));
        return null;
      }
    },
    [tabId, targetState]
  );

  const readback = React.useCallback(async () => {
    if (!targetState) return null;
    setTargetPhase('readback');
    try {
      const result = await readPurchaseCapture(targetState);
      setTargetPhase(result?.readbackVerified === true ? 'completed' : 'target-locked');
      return result;
    } catch (error) {
      setTargetPhase('error');
      setCaptureError(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [targetState]);

  return {
    target: targetState,
    targetLocked,
    targetPhase,
    targetCandidates,
    setTargetCandidates,
    targetError,
    captureResult,
    capturePreview,
    captureBusy,
    captureError,
    recoveryState,
    enterTargetMode,
    selectTarget,
    clearTarget,
    capture,
    openPreview,
    confirmCapture,
    cancelCapture,
    recover,
    readback,
  };
}

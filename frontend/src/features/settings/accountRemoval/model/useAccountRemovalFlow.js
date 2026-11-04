import React from 'react';
import {
  ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_CODE,
  confirmAccountRemoval,
  prepareAccountRemovalPreview,
  releaseAccountRemovalPreview,
  verifyAccountRemovalClientCleanup,
} from '../services/accountRemovalClient.js';
import { exportDataBackup } from '../../../dataBackup/services/dataBackupDesktopClient.js';
import {
  cleanupAndVerifyAccountRemovalClientResources,
  prepareAccountRemovalBarrier,
  releaseAccountRemovalBarrier,
  releaseAccountRemovalRendererBarrier,
} from '../services/accountRemovalRuntime.js';
import {
  canUseAccountRemovalRecentBackup,
  getAccountRemovalErrorMessage,
  isAccountRemovalBackupAuthorizationCurrent,
  normalizeAccountRemovalBackupReview,
} from '../lib/accountRemovalPresentation.js';
import { findAccountRemovalActivity, registerAccountRemovalActivity, releaseAccountRemovalActivity, updateAccountRemovalActivity } from '../services/accountRemovalActivity.js';
import { accountRemovalGenerationKey, continuePendingAccountRemovalTask, lookupPendingAccountRemovalTask, pendingTaskError, readPendingAccountRemovalTask } from '../services/accountRemovalPendingTask.js';
import { reportAccountRemovalCleanupFailure } from '../services/accountRemovalFailureReport.js';
import { publishAccountRemovalCompletion } from '../services/accountRemovalCompletion.js';

const INITIAL_FLOW = Object.freeze({
  open: false,
  mode: 'review',
  stage: 'idle',
  owner: null,
  account: null,
  ownerGeneration: null,
  preview: null,
  backupReview: null,
  backupAuthorization: null,
  backupError: '',
  operation: null,
  confirmationUncertain: false,
  error: null,
  errorMessage: '',
});

const EXECUTING_STAGES = new Set(['barrier', 'executing', 'client-cleanup', 'verifying']);
const RECOVERABLE_STAGES = new Set(['error', 'pending']);
const BUSY_STAGES = new Set([...EXECUTING_STAGES, 'loading', 'backup-exporting', 'backup-validating', 'releasing']);
const BACKUP_GATE_ERROR_CODES = new Set([
  'ACCOUNT_REMOVAL_SNAPSHOT_FINGERPRINT_MISMATCH',
  'ACCOUNT_REMOVAL_PREVIEW_FINGERPRINT_MISMATCH',
  'ACCOUNT_REMOVAL_BACKUP_REVIEW_REQUIRED',
  'ACCOUNT_REMOVAL_BACKUP_PREVIEW_MISMATCH',
  'ACCOUNT_REMOVAL_BACKUP_STALE',
  'ACCOUNT_REMOVAL_BACKUP_NOT_VERIFIED',
  'ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_REQUIRED',
]);
const DIRECT_AUTO_RECOVERY_CODES = new Set([
  'ACCOUNT_REMOVAL_DATABASE_BUSY',
  'ACCOUNT_REMOVAL_EXECUTION_FAILED',
  'ACCOUNT_REMOVAL_QUIESCE_TIMEOUT',
  'ACCOUNT_REMOVAL_REMOTE_RECOVERY_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_REMOTE_RECOVERY_PURGE_FAILED',
  'ACCOUNT_REMOVAL_PROTECTION_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_PROTECTION_PURGE_FAILED',
  'ACCOUNT_REMOVAL_PHYSICAL_ERASURE_INCOMPLETE',
]);
const DIRECT_AUTO_RECOVERY_ATTEMPTS = 3;

function ownerKey(owner = {}) {
  const value = owner && typeof owner === 'object' ? owner : {};
  return `${String(value.ownerType || '').trim()}\u0000${String(value.ownerId || '').trim()}`;
}

function createIdempotencyKey() {
  const randomId = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `account-removal:${randomId}`;
}

function normalizePreviewPayload(payload = {}) {
  if (!payload?.preview || !payload?.account) throw new Error('ACCOUNT_REMOVAL_PREVIEW_INVALID');
  return {
    preview: payload.preview,
    account: payload.account,
    ownerGeneration: payload.ownerGeneration || null,
    backupReview: normalizeAccountRemovalBackupReview(payload.backupReview, payload.preview),
    backupAuthorization: null,
    backupError: '',
  };
}

function operationOwnerGeneration(operation = {}) {
  const generation = operation?.deletionSummary?.removedOwnerGeneration;
  return generation && typeof generation === 'object' && !Array.isArray(generation)
    ? generation
    : null;
}

function runtimePreview(preview, ownerGeneration) {
  return ownerGeneration ? { ...preview, ownerGeneration } : preview;
}

function accountRemovalErrorCode(error) {
  return String(error?.code || error?.payload?.error?.code || '');
}

function backupAuthorization(review, preview, outcome, backupId = '') {
  return {
    outcome,
    ...(backupId ? { backupId } : {}),
    previewFingerprint: String(preview?.previewFingerprint || review?.previewFingerprint || ''),
    dataFingerprint: String(review?.dataFingerprint || ''),
    ...(outcome === 'explicitly-skipped'
      ? { skipConfirmationCode: ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_CODE }
      : {}),
  };
}

function isExactBackupAuthorization(review, preview, authorization) {
  if (!isAccountRemovalBackupAuthorizationCurrent(review, preview, authorization)) return false;
  if (review?.required !== true) return true;
  if (authorization?.outcome === 'explicitly-skipped') {
    return authorization.skipConfirmationCode === ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_CODE;
  }
  return ['exported', 'recent-verified'].includes(authorization?.outcome);
}

function backupFlowError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function useAccountRemovalFlow() {
  const [flow, setFlow] = React.useState(INITIAL_FLOW);
  const completionCallbackRef = React.useRef(null);
  const missingCallbackRef = React.useRef(null);
  const beforePreviewCallbackRef = React.useRef(null);
  const idempotencyKeysRef = React.useRef(new Map());
  const confirmInFlightRef = React.useRef(null);
  const recoveryInFlightRef = React.useRef(null);
  const directInFlightRef = React.useRef(null);
  const uncertainConfirmationRef = React.useRef(null);
  const durableOperationRef = React.useRef(null);
  const completedConfirmationsRef = React.useRef(new Set());
  const activeOwnerRef = React.useRef(null);
  const openPromiseRef = React.useRef(null);
  const preparedOwnerRef = React.useRef(null);
  const desktopBarrierFingerprintRef = React.useRef('');
  const mountedRef = React.useRef(true);
  const activityIdRef = React.useRef(Symbol('account-removal-flow'));
  const activityLeaseRef = React.useRef(null);
  const activityContinuationRef = React.useRef(null);

  React.useEffect(() => {
    // StrictMode replays effect setup after its development-only cleanup.
    mountedRef.current = true;
    const activityId = activityIdRef.current;
    return () => {
      mountedRef.current = false;
      releaseAccountRemovalActivity(activityId, activityLeaseRef.current);
      if (preparedOwnerRef.current && !uncertainConfirmationRef.current && !durableOperationRef.current?.operationId) {
        void releaseAccountRemovalPreview(preparedOwnerRef.current).catch(() => undefined);
      }
    };
  }, []);

  const patchFlow = React.useCallback((patch) => {
    if (!mountedRef.current) return;
    const next = patch.stage === 'error' && accountRemovalErrorCode(patch.error) === 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS'
      ? { ...patch, stage: 'pending' } : patch;
    if (Object.prototype.hasOwnProperty.call(next, 'operation')) {
      durableOperationRef.current = next.operation;
      updateAccountRemovalActivity(activityIdRef.current, next.operation);
    }
    setFlow((current) => ({ ...current, ...next }));
  }, []);

  const requestCurrentPreview = React.useCallback(async (owner) => {
    const beforePreview = beforePreviewCallbackRef.current;
    if (beforePreview) await beforePreview(owner);
    const payload = normalizePreviewPayload(await prepareAccountRemovalPreview(owner));
    if (!mountedRef.current) {
      await releaseAccountRemovalPreview(owner).catch(() => undefined);
      return payload;
    }
    preparedOwnerRef.current = owner;
    return payload;
  }, []);

  const releaseUnsubmittedOwner = React.useCallback(async (owner, preview, ownerGeneration) => {
    const released = await releaseAccountRemovalPreview(owner);
    if (released?.ok !== true && released?.released !== true) throw new Error('ACCOUNT_REMOVAL_RELEASE_NOT_VERIFIED');
    releaseAccountRemovalRendererBarrier(runtimePreview({ ...preview, owner }, ownerGeneration), { verifiedNoOperation: true });
    if (desktopBarrierFingerprintRef.current) {
      await releaseAccountRemovalBarrier({ previewFingerprint: desktopBarrierFingerprintRef.current });
      desktopBarrierFingerprintRef.current = '';
    }
    preparedOwnerRef.current = null;
  }, []);

  const resetOpenRequest = React.useCallback((owner) => {
    if (!owner || ownerKey(activeOwnerRef.current) === ownerKey(owner)) {
      activeOwnerRef.current = null;
      releaseAccountRemovalActivity(activityIdRef.current, activityLeaseRef.current);
      activityLeaseRef.current = null;
      openPromiseRef.current = null;
    }
  }, []);

  const completeFlow = React.useCallback(async (operation, completedOwner = flow.owner, completedOwnerGeneration = flow.ownerGeneration) => {
    if (operation?.completed !== true) throw new Error('ACCOUNT_REMOVAL_COMPLETION_NOT_VERIFIED');
    const completedKey = completedOwner && idempotencyKeysRef.current.get(ownerKey(completedOwner));
    if (completedKey) completedConfirmationsRef.current.add(completedKey);
    if (completedConfirmationsRef.current.size > 100) completedConfirmationsRef.current.delete(completedConfirmationsRef.current.values().next().value);
    uncertainConfirmationRef.current = null;
    try {
      await releaseAccountRemovalBarrier({ previewFingerprint: operation.previewFingerprint });
    } catch {
      // Completion is already durable. Keeping the main-process barrier fenced
      // is safer than downgrading or retrying the irreversible deletion.
    }
    try {
      releaseAccountRemovalRendererBarrier(runtimePreview({
        owner: completedOwner, previewFingerprint: operation.previewFingerprint,
      }, operationOwnerGeneration(operation) || completedOwnerGeneration), { completed: true });
    } catch { /* Verified completion remains final even if a safe local fence needs a retry. */ }
    patchFlow({ stage: 'completed', operation, confirmationUncertain: false, error: null, errorMessage: '' });
    publishAccountRemovalCompletion(operation, completedOwner, operationOwnerGeneration(operation) || completedOwnerGeneration);
    const callback = completionCallbackRef.current;
    if (callback) {
      try {
        await callback(operation);
      } catch {
        // Server and client readback already completed. A local presentation
        // refresh failure must not downgrade the irreversible operation.
      }
    }
    completionCallbackRef.current = null;
    missingCallbackRef.current = null;
    beforePreviewCallbackRef.current = null;
    preparedOwnerRef.current = null;
    desktopBarrierFingerprintRef.current = '';
    resetOpenRequest(completedOwner);
    if (completedOwner) idempotencyKeysRef.current.delete(ownerKey(completedOwner));
    return operation;
  }, [flow.owner, flow.ownerGeneration, patchFlow, resetOpenRequest]);

  const finishClientCleanup = React.useCallback(async (operation, preview) => {
    const challenge = operation?.clientCleanup;
    if (!operation?.operationId || !challenge?.nonce || !Array.isArray(challenge.resourceIds)) {
      throw new Error('ACCOUNT_REMOVAL_CLIENT_CLEANUP_CHALLENGE_INVALID');
    }
    patchFlow({ stage: 'client-cleanup', operation });
    try {
      const resourceObservations = await cleanupAndVerifyAccountRemovalClientResources(
        { ...preview.owner, ...(preview.ownerGeneration || {}) }, challenge.resourceIds,
        { operationId: operation.operationId },
      );
      patchFlow({ stage: 'verifying', operation });
      return await verifyAccountRemovalClientCleanup({
        operationId: operation.operationId, nonce: challenge.nonce,
        previewFingerprint: preview.previewFingerprint, resourceObservations,
      });
    } catch (error) {
      try { await reportAccountRemovalCleanupFailure(operation, preview.previewFingerprint, error); }
      catch { /* Diagnostics must neither replace the original failure nor confirm deletion. */ }
      throw error;
    }
  }, [patchFlow]);

  const recoverExistingOperation = React.useCallback(async (owner, { directDelete = false } = {}) => {
    const known = durableOperationRef.current;
    const found = known?.operationId && ownerKey(activeOwnerRef.current) === ownerKey(owner)
      ? {
          operation: await readPendingAccountRemovalTask({ ...known, pendingOwner: owner }),
          ownerGeneration: known.pendingOwnerGeneration || operationOwnerGeneration(known) || flow.ownerGeneration,
        }
      : await lookupPendingAccountRemovalTask(owner);
    const operation = found.operation;
    if (operation.completed === true) return completeFlow(operation, owner, found.ownerGeneration);
    uncertainConfirmationRef.current = null;
    patchFlow({ owner, operation, ownerGeneration: found.ownerGeneration, confirmationUncertain: false,
      preview: { owner, previewFingerprint: operation.previewFingerprint } });
    const completed = await continuePendingAccountRemovalTask(operation, {
      directDelete, finishClientCleanup,
      onStage: (stage, current, scopedPreview) => {
        desktopBarrierFingerprintRef.current = scopedPreview.previewFingerprint;
        patchFlow({ stage, operation: current });
      },
    });
    return completeFlow(completed, owner, found.ownerGeneration);
  }, [completeFlow, finishClientCleanup, flow.ownerGeneration, patchFlow]);

  const loadPreview = React.useCallback(async (owner, { resetIdempotency = false } = {}) => {
    const key = ownerKey(owner);
    if (resetIdempotency || !idempotencyKeysRef.current.has(key)) {
      idempotencyKeysRef.current.set(key, createIdempotencyKey());
    }
    patchFlow({
      open: true,
      mode: 'review',
      stage: 'loading',
      owner,
      account: null,
      ownerGeneration: null,
      preview: null,
      backupReview: null,
      backupAuthorization: null,
      backupError: '',
      operation: null,
      error: null,
      errorMessage: '',
    });
    try {
      const payload = await requestCurrentPreview(owner);
      patchFlow({ stage: 'preview', ...payload });
      return payload;
    } catch (error) {
      const code = accountRemovalErrorCode(error);
      if (code === 'ACCOUNT_REMOVAL_OWNER_NOT_FOUND') {
        try {
          patchFlow({ stage: 'executing', error: null, errorMessage: '' });
          const operation = await recoverExistingOperation(owner);
          return { operation, recovered: true };
        } catch (recoveryError) {
          if (accountRemovalErrorCode(recoveryError) !== 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND') {
            patchFlow({ stage: 'error', error: recoveryError, errorMessage: getAccountRemovalErrorMessage(recoveryError) });
            throw recoveryError;
          }
          const onMissing = missingCallbackRef.current;
          if (onMissing) {
            try {
              await onMissing(owner);
            } catch (missingCallbackError) {
              patchFlow({
                stage: 'error',
                error: missingCallbackError,
                errorMessage: getAccountRemovalErrorMessage(missingCallbackError),
              });
              throw missingCallbackError;
            }
            completionCallbackRef.current = null;
            missingCallbackRef.current = null;
            beforePreviewCallbackRef.current = null;
            resetOpenRequest(owner);
            idempotencyKeysRef.current.delete(ownerKey(owner));
            patchFlow({ ...INITIAL_FLOW });
            return { owner, missing: true };
          }
        }
      }
      patchFlow({ stage: 'error', error, errorMessage: getAccountRemovalErrorMessage(error) });
      throw error;
    }
  }, [patchFlow, recoverExistingOperation, requestCurrentPreview, resetOpenRequest]);

  const openAccountRemoval = React.useCallback((owner, options = {}) => {
    const normalizedOwner = {
      ownerType: String(owner?.ownerType || '').trim(),
      ownerId: String(owner?.ownerId || '').trim(),
    };
    const key = ownerKey(normalizedOwner);
    const activeKey = activeOwnerRef.current ? ownerKey(activeOwnerRef.current) : '';
    if (activeKey) {
      // A durable failed removal may be dismissed without canceling its
      // operation or safety fences. Any later delete click restores that exact
      // task instead of silently doing nothing or starting a second removal.
      if (!flow.open) patchFlow({ open: true });
      return openPromiseRef.current?.promise || Promise.resolve(null);
    }
    activeOwnerRef.current = normalizedOwner;
    activityLeaseRef.current = registerAccountRemovalActivity(activityIdRef.current, normalizedOwner,
      task => activityContinuationRef.current?.(task));
    completionCallbackRef.current = typeof options.onCompleted === 'function' ? options.onCompleted : null;
    missingCallbackRef.current = typeof options.onMissing === 'function' ? options.onMissing : null;
    beforePreviewCallbackRef.current = typeof options.beforePreview === 'function' ? options.beforePreview : null;
    const promise = loadPreview(normalizedOwner).catch(() => null);
    openPromiseRef.current = { key, promise };
    return promise;
  }, [flow.open, loadPreview, patchFlow]);

  const refreshPreview = React.useCallback(() => {
    if (recoveryInFlightRef.current) return recoveryInFlightRef.current;
    if (directInFlightRef.current) return directInFlightRef.current.promise;
    if (flow.stage === 'completed') return Promise.resolve({ operation: flow.operation, recovered: true });
    const request = (async () => {
    if (!flow.owner) return null;
    if (RECOVERABLE_STAGES.has(flow.stage)) {
      try {
        patchFlow({ stage: 'executing', error: null, errorMessage: '' });
        const operation = await recoverExistingOperation(flow.owner);
        return { operation, recovered: true };
      } catch (error) {
        if (accountRemovalErrorCode(error) !== 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND') {
          patchFlow({ stage: 'error', error, errorMessage: getAccountRemovalErrorMessage(error) });
          return null;
        }
        uncertainConfirmationRef.current = null;
        patchFlow({ confirmationUncertain: false });
        if (flow.preview?.previewFingerprint) {
          try { await releaseUnsubmittedOwner(flow.owner, flow.preview, flow.ownerGeneration); }
          catch (releaseError) {
            patchFlow({ stage: 'error', error: releaseError, errorMessage: getAccountRemovalErrorMessage(releaseError) });
            return null;
          }
        }
      }
    }
    return loadPreview(flow.owner);
    })();
    recoveryInFlightRef.current = request;
    void request.finally(() => { if (recoveryInFlightRef.current === request) recoveryInFlightRef.current = null; }).catch(() => undefined);
    return request;
  }, [flow.operation, flow.owner, flow.ownerGeneration, flow.preview, flow.stage, loadPreview, patchFlow, recoverExistingOperation, releaseUnsubmittedOwner]);

  const exportBackupBeforeRemoval = React.useCallback(async () => {
    if (!flow.owner || !flow.preview || flow.backupReview?.required !== true || BUSY_STAGES.has(flow.stage)) {
      return null;
    }
    patchFlow({ stage: 'backup-exporting', backupError: '', error: null, errorMessage: '' });
    try {
      const result = await exportDataBackup({
        owner: flow.owner,
        expectedDataFingerprint: flow.backupReview.dataFingerprint,
      });
      if (result?.canceled) {
        patchFlow({ stage: 'preview', backupError: '已取消导出，账号尚未进入删除流程。' });
        return result;
      }

      patchFlow({ stage: 'backup-validating' });
      const refreshed = await requestCurrentPreview(flow.owner);
      const recent = refreshed.backupReview.latestVerifiedBackup;
      const exportedBackupId = String(result?.backupId || result?.id || '').trim();
      if (
        !exportedBackupId
        || !canUseAccountRemovalRecentBackup(refreshed.backupReview)
        || recent?.backupId !== exportedBackupId
      ) {
        throw backupFlowError(
          'ACCOUNT_REMOVAL_BACKUP_NOT_VERIFIED',
          '备份文件已导出，但删除预览尚未确认它覆盖当前数据，请重新备份。',
        );
      }
      const authorization = backupAuthorization(
        refreshed.backupReview,
        refreshed.preview,
        'exported',
        exportedBackupId,
      );
      patchFlow({
        stage: 'preview',
        ...refreshed,
        backupAuthorization: authorization,
        backupError: '',
      });
      return authorization;
    } catch (error) {
      patchFlow({
        stage: 'preview',
        backupAuthorization: null,
        backupError: getAccountRemovalErrorMessage(error),
      });
      return null;
    }
  }, [flow.backupReview, flow.owner, flow.preview, flow.stage, patchFlow, requestCurrentPreview]);

  const useRecentBackupBeforeRemoval = React.useCallback(async () => {
    if (!flow.owner || !flow.preview || flow.backupReview?.required !== true || BUSY_STAGES.has(flow.stage)) {
      return null;
    }
    patchFlow({ stage: 'backup-validating', backupError: '', error: null, errorMessage: '' });
    try {
      const refreshed = await requestCurrentPreview(flow.owner);
      if (!canUseAccountRemovalRecentBackup(refreshed.backupReview)) {
        throw backupFlowError('ACCOUNT_REMOVAL_BACKUP_NOT_VERIFIED');
      }
      const authorization = backupAuthorization(
        refreshed.backupReview,
        refreshed.preview,
        'recent-verified',
        refreshed.backupReview.latestVerifiedBackup.backupId,
      );
      patchFlow({
        stage: 'preview',
        ...refreshed,
        backupAuthorization: authorization,
        backupError: '',
      });
      return authorization;
    } catch (error) {
      patchFlow({
        stage: 'preview',
        backupAuthorization: null,
        backupError: getAccountRemovalErrorMessage(error),
      });
      return null;
    }
  }, [flow.backupReview, flow.owner, flow.preview, flow.stage, patchFlow, requestCurrentPreview]);

  const skipBackupBeforeRemoval = React.useCallback(async () => {
    if (!flow.owner || !flow.preview || flow.backupReview?.required !== true || BUSY_STAGES.has(flow.stage)) {
      return null;
    }
    patchFlow({ stage: 'backup-validating', backupError: '', error: null, errorMessage: '' });
    try {
      const refreshed = await requestCurrentPreview(flow.owner);
      if (refreshed.backupReview.required !== true) {
        patchFlow({ stage: 'preview', ...refreshed, backupAuthorization: null, backupError: '' });
        return null;
      }
      const authorization = backupAuthorization(
        refreshed.backupReview,
        refreshed.preview,
        'explicitly-skipped',
      );
      patchFlow({
        stage: 'preview',
        ...refreshed,
        backupAuthorization: authorization,
        backupError: '',
      });
      return authorization;
    } catch (error) {
      patchFlow({
        stage: 'preview',
        backupAuthorization: null,
        backupError: getAccountRemovalErrorMessage(error),
      });
      return null;
    }
  }, [flow.backupReview, flow.owner, flow.preview, flow.stage, patchFlow, requestCurrentPreview]);

  const confirmRemoval = React.useCallback(() => {
    if (confirmInFlightRef.current) return confirmInFlightRef.current;
    if (recoveryInFlightRef.current) return recoveryInFlightRef.current;
    if (directInFlightRef.current) return directInFlightRef.current.promise;
    if (flow.stage === 'completed') return Promise.resolve(flow.operation);
    const request = (async () => {
    if (!flow.preview || !flow.owner || EXECUTING_STAGES.has(flow.stage)) return null;
    if (RECOVERABLE_STAGES.has(flow.stage) && (flow.operation?.operationId || uncertainConfirmationRef.current)) return refreshPreview();
    if (!isExactBackupAuthorization(flow.backupReview, flow.preview, flow.backupAuthorization)) {
      patchFlow({
        stage: 'preview',
        backupError: getAccountRemovalErrorMessage(
          backupFlowError('ACCOUNT_REMOVAL_BACKUP_AUTHORIZATION_REQUIRED'),
        ),
        error: null,
        errorMessage: '',
      });
      return null;
    }
    const key = ownerKey(flow.owner);
    const idempotencyKey = idempotencyKeysRef.current.get(key) || createIdempotencyKey();
    idempotencyKeysRef.current.set(key, idempotencyKey);
    let barrierStarted = false;
    let confirmedPreview = flow.preview;
    let confirmedOwnerGeneration = flow.ownerGeneration;
    let confirmedBackupAuthorization = flow.backupAuthorization;
    try {
      patchFlow({ stage: 'barrier', backupError: '', error: null, errorMessage: '' });
      const initialScopedPreview = runtimePreview(flow.preview, flow.ownerGeneration);
      barrierStarted = true;
      const barrierProof = await prepareAccountRemovalBarrier(initialScopedPreview);
      desktopBarrierFingerprintRef.current = flow.preview.previewFingerprint;
      const current = await requestCurrentPreview(flow.owner);
      if (current.preview.previewFingerprint !== flow.preview.previewFingerprint) {
        await releaseUnsubmittedOwner(flow.owner, flow.preview, flow.ownerGeneration);
        desktopBarrierFingerprintRef.current = '';
        barrierStarted = false;
        patchFlow({
          stage: 'preview',
          ...current,
          backupAuthorization: null,
          backupError: getAccountRemovalErrorMessage(
            backupFlowError('ACCOUNT_REMOVAL_BACKUP_PREVIEW_CHANGED'),
          ),
        });
        return null;
      }
      if (!isExactBackupAuthorization(current.backupReview, current.preview, flow.backupAuthorization)) {
        await releaseUnsubmittedOwner(flow.owner, flow.preview, flow.ownerGeneration);
        desktopBarrierFingerprintRef.current = '';
        barrierStarted = false;
        patchFlow({
          stage: 'preview',
          ...current,
          backupAuthorization: null,
          backupError: getAccountRemovalErrorMessage(
            backupFlowError('ACCOUNT_REMOVAL_BACKUP_AUTHORIZATION_REQUIRED'),
          ),
        });
        return null;
      }
      confirmedPreview = current.preview;
      confirmedOwnerGeneration = current.ownerGeneration || flow.ownerGeneration;
      confirmedBackupAuthorization = current.backupReview.required === true ? flow.backupAuthorization : null;
      const scopedPreview = runtimePreview(confirmedPreview, confirmedOwnerGeneration);
      uncertainConfirmationRef.current = { owner: flow.owner, idempotencyKey };
      patchFlow({ stage: 'executing', confirmationUncertain: true });
      let operation = await confirmAccountRemoval({
        preview: confirmedPreview,
        idempotencyKey,
        barrierProof,
        backupAuthorization: confirmedBackupAuthorization,
      });
      if (!operation?.operationId) throw new Error('ACCOUNT_REMOVAL_CONFIRM_RESPONSE_INVALID');
      uncertainConfirmationRef.current = null;
      patchFlow({ operation, confirmationUncertain: false });
      if (operation?.requiresClientCleanup) {
        operation = await finishClientCleanup(operation, scopedPreview);
      }
      return await completeFlow(operation, flow.owner, confirmedOwnerGeneration);
    } catch (error) {
      if (completedConfirmationsRef.current.has(idempotencyKey)) return null;
      const code = accountRemovalErrorCode(error);
      if (!barrierStarted) {
        patchFlow({
          stage: 'preview',
          backupAuthorization: null,
          backupError: getAccountRemovalErrorMessage(error),
          error: null,
          errorMessage: '',
        });
        return null;
      }
      if (BACKUP_GATE_ERROR_CODES.has(code)) {
        if (uncertainConfirmationRef.current) {
          try {
            const { operation } = await lookupPendingAccountRemovalTask(flow.owner);
            uncertainConfirmationRef.current = null;
            patchFlow({ operation, confirmationUncertain: false, stage: 'error', error, errorMessage: getAccountRemovalErrorMessage(error) });
            return null;
          } catch (recoveryError) {
            if (accountRemovalErrorCode(recoveryError) !== 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND') {
              patchFlow({ stage: 'error', error: recoveryError, errorMessage: getAccountRemovalErrorMessage(recoveryError) });
              return null;
            }
            uncertainConfirmationRef.current = null;
            patchFlow({ confirmationUncertain: false });
          }
        }
        try { await releaseUnsubmittedOwner(flow.owner, confirmedPreview, confirmedOwnerGeneration); }
        catch (releaseError) {
          patchFlow({ stage: 'error', error: releaseError, errorMessage: getAccountRemovalErrorMessage(releaseError) });
          return null;
        }
        desktopBarrierFingerprintRef.current = '';
        try {
          const refreshed = await requestCurrentPreview(flow.owner);
          patchFlow({
            stage: 'preview',
            ...refreshed,
            backupAuthorization: null,
            backupError: getAccountRemovalErrorMessage(error),
            error: null,
            errorMessage: '',
          });
        } catch {
          patchFlow({ stage: 'error', error, errorMessage: getAccountRemovalErrorMessage(error) });
        }
        return null;
      }
      if (!uncertainConfirmationRef.current && !durableOperationRef.current?.operationId) {
        try { await releaseUnsubmittedOwner(flow.owner, confirmedPreview, confirmedOwnerGeneration); }
        catch { /* Preserve the failed-release fence and original failure for retry. */ }
      }
      patchFlow({ stage: 'error', error, errorMessage: getAccountRemovalErrorMessage(error) });
      return null;
    }
    })();
    confirmInFlightRef.current = request;
    void request.finally(() => { if (confirmInFlightRef.current === request) confirmInFlightRef.current = null; }).catch(() => undefined);
    return request;
  }, [
    completeFlow,
    finishClientCleanup,
    flow.backupAuthorization,
    flow.backupReview,
    flow.operation,
    flow.owner,
    flow.ownerGeneration,
    flow.preview,
    flow.stage,
    patchFlow,
    refreshPreview,
    requestCurrentPreview,
    releaseUnsubmittedOwner,
  ]);

  const deleteAccountDirectly = React.useCallback((owner, options = {}) => {
    const normalizedOwner = {
      ownerType: String(owner?.ownerType || '').trim(),
      ownerId: String(owner?.ownerId || '').trim(),
    };
    const key = ownerKey(normalizedOwner);
    if (directInFlightRef.current?.key === key) return directInFlightRef.current.promise;
    const activeKey = activeOwnerRef.current ? ownerKey(activeOwnerRef.current) : '';
    if (activeKey && activeKey !== key) {
      patchFlow({ open: true });
      return openPromiseRef.current?.promise || Promise.resolve(null);
    }
    if (recoveryInFlightRef.current) return recoveryInFlightRef.current;
    if (confirmInFlightRef.current) return confirmInFlightRef.current;
    if (activeKey === key && BUSY_STAGES.has(flow.stage)) {
      patchFlow({ open: true });
      return openPromiseRef.current?.promise || Promise.resolve(null);
    }
    if (!activeKey) {
      activeOwnerRef.current = normalizedOwner;
      activityLeaseRef.current = registerAccountRemovalActivity(activityIdRef.current, normalizedOwner,
        task => activityContinuationRef.current?.(task));
      completionCallbackRef.current = typeof options.onCompleted === 'function' ? options.onCompleted : null;
      missingCallbackRef.current = typeof options.onMissing === 'function' ? options.onMissing : null;
      beforePreviewCallbackRef.current = typeof options.beforePreview === 'function' ? options.beforePreview : null;
    }

    const run = (async () => {
      patchFlow({
        open: true,
        mode: 'direct',
        stage: 'loading',
        owner: normalizedOwner,
        account: flow.account,
        ownerGeneration: flow.ownerGeneration,
        preview: flow.preview,
        backupReview: null,
        backupAuthorization: null,
        backupError: '',
        operation: flow.operation,
        error: null,
        errorMessage: '',
      });
      let preparedForRollback = null;
      try {
        const beforePreview = beforePreviewCallbackRef.current;
        if (beforePreview) await beforePreview(normalizedOwner);
        const recoverDirectOperation = async () => {
          let lastError = null;
          for (let attempt = 0; attempt < DIRECT_AUTO_RECOVERY_ATTEMPTS; attempt += 1) {
            try {
              return await recoverExistingOperation(normalizedOwner, { directDelete: true });
            } catch (error) {
              const code = accountRemovalErrorCode(error);
              if (code === 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND') return null;
              lastError = error;
              if (!DIRECT_AUTO_RECOVERY_CODES.has(code)) throw error;
            }
          }
          throw lastError;
        };
        // A previous click may already have created a durable operation. Resume
        // that exact operation first; the user never has to enter a separate
        // retry screen or create a second deletion task.
        {
          patchFlow({ stage: 'executing' });
          const operation = await recoverDirectOperation();
          if (operation) return operation;
          uncertainConfirmationRef.current = null;
          patchFlow({ confirmationUncertain: false });
        }

        let prepared = await requestCurrentPreview(normalizedOwner);
        let barrierStarted = false;
        for (let snapshotAttempt = 0; snapshotAttempt < 2; snapshotAttempt += 1) {
          preparedForRollback = prepared;
          const authorization = prepared.backupReview?.required === true
            ? backupAuthorization(
                prepared.backupReview,
                prepared.preview,
                'explicitly-skipped',
              )
            : null;
          patchFlow({
            mode: 'direct',
            stage: 'barrier',
            ...prepared,
            backupAuthorization: authorization,
            backupError: '',
            error: null,
            errorMessage: '',
          });
          const scopedPreview = runtimePreview(prepared.preview, prepared.ownerGeneration);
          const barrierProof = await prepareAccountRemovalBarrier(scopedPreview);
          barrierStarted = true;
          desktopBarrierFingerprintRef.current = prepared.preview.previewFingerprint;

          const current = await requestCurrentPreview(normalizedOwner);
          if (current.preview.previewFingerprint !== prepared.preview.previewFingerprint) {
            await releaseUnsubmittedOwner(normalizedOwner, prepared.preview, prepared.ownerGeneration);
            desktopBarrierFingerprintRef.current = '';
            barrierStarted = false;
            prepared = current;
            continue;
          }

          const keyForOwner = ownerKey(normalizedOwner);
          const idempotencyKey = idempotencyKeysRef.current.get(keyForOwner) || createIdempotencyKey();
          idempotencyKeysRef.current.set(keyForOwner, idempotencyKey);
          patchFlow({ stage: 'executing' });
          let operation;
          try {
            uncertainConfirmationRef.current = { owner: normalizedOwner, idempotencyKey };
            patchFlow({ confirmationUncertain: true });
            operation = await confirmAccountRemoval({
              preview: current.preview,
              idempotencyKey,
              barrierProof,
              backupAuthorization: current.backupReview?.required === true
                ? backupAuthorization(current.backupReview, current.preview, 'explicitly-skipped')
                : null,
            });
          } catch (confirmationError) {
            // A timeout can happen after the server has already accepted the
            // deletion. Continue by owner so one click still converges on the
            // same durable operation instead of asking the user to retry.
            try {
              const recovered = await recoverDirectOperation();
              if (!recovered) throw confirmationError;
              return recovered;
            } catch (resumeError) {
              if (accountRemovalErrorCode(resumeError) === 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND') {
                throw confirmationError;
              }
              throw resumeError;
            }
          }
          if (!operation?.operationId) throw new Error('ACCOUNT_REMOVAL_CONFIRM_RESPONSE_INVALID');
          uncertainConfirmationRef.current = null;
          patchFlow({ operation, confirmationUncertain: false });
          if (operation?.requiresClientCleanup) {
            operation = await finishClientCleanup(
              operation,
              runtimePreview(current.preview, current.ownerGeneration),
            );
          }
          return await completeFlow(operation, normalizedOwner, current.ownerGeneration);
        }
        if (barrierStarted) {
          await releaseUnsubmittedOwner(normalizedOwner, prepared.preview, prepared.ownerGeneration);
          desktopBarrierFingerprintRef.current = '';
        }
        throw backupFlowError('ACCOUNT_REMOVAL_BACKUP_PREVIEW_CHANGED');
      } catch (error) {
        if (accountRemovalErrorCode(error) === 'ACCOUNT_REMOVAL_OWNER_NOT_FOUND') {
          const onMissing = missingCallbackRef.current;
          if (onMissing) {
            await onMissing(normalizedOwner);
            completionCallbackRef.current = null;
            missingCallbackRef.current = null;
            beforePreviewCallbackRef.current = null;
            preparedOwnerRef.current = null;
            desktopBarrierFingerprintRef.current = '';
            resetOpenRequest(normalizedOwner);
            idempotencyKeysRef.current.delete(key);
            patchFlow({ ...INITIAL_FLOW });
            return { owner: normalizedOwner, missing: true };
          }
        }
        if (preparedForRollback && !uncertainConfirmationRef.current && !durableOperationRef.current?.operationId) {
          try { await releaseUnsubmittedOwner(normalizedOwner, preparedForRollback.preview, preparedForRollback.ownerGeneration); }
          catch { /* Never reset a fence whose cancellation was not acknowledged. */ }
        }
        patchFlow({
          open: true,
          mode: 'direct',
          stage: 'error',
          error,
          errorMessage: getAccountRemovalErrorMessage(error),
        });
        return null;
      }
    })();
    directInFlightRef.current = { key, promise: run };
    void run.finally(() => { if (directInFlightRef.current?.promise === run) directInFlightRef.current = null; }).catch(() => undefined);
    openPromiseRef.current = { key, promise: run };
    return run;
  }, [
    completeFlow,
    finishClientCleanup,
    flow.account,
    flow.operation,
    flow.ownerGeneration,
    flow.preview,
    flow.stage,
    patchFlow,
    requestCurrentPreview,
    resetOpenRequest,
    releaseUnsubmittedOwner,
    recoverExistingOperation,
  ]);

  const closeAccountRemoval = React.useCallback(async () => {
    const hasDurableOperation = Boolean(flow.operation?.operationId);
    if (BUSY_STAGES.has(flow.stage) || uncertainConfirmationRef.current || (RECOVERABLE_STAGES.has(flow.stage) && hasDurableOperation)) {
      // A running or irreversible operation must not trap the whole settings
      // screen. Dismiss only the modal while retaining the owner lock, desktop
      // barrier, callbacks and retry state. Reopening any delete action restores
      // this exact task; the underlying operation is never canceled here.
      patchFlow({ open: false });
      return true;
    }
    const closingOwner = flow.owner || preparedOwnerRef.current;
    if (flow.stage === 'completed') {
      // Completion already releases both the desktop barrier and the local-api
      // runtime fences. Do not issue a redundant release-preview request here:
      // it adds a full network timeout to an already completed deletion when
      // the local service is shutting down or rotating its owner snapshot.
      preparedOwnerRef.current = null;
      completionCallbackRef.current = null;
      missingCallbackRef.current = null;
      beforePreviewCallbackRef.current = null;
      resetOpenRequest(closingOwner);
      patchFlow({ ...INITIAL_FLOW });
      return true;
    }
    patchFlow({ stage: 'releasing' });
    if (closingOwner) {
      try { await releaseUnsubmittedOwner(closingOwner, flow.preview, flow.ownerGeneration); }
      catch (error) {
        patchFlow({ stage: 'error', error, errorMessage: getAccountRemovalErrorMessage(error) });
        return false;
      }
    }
    preparedOwnerRef.current = null;
    completionCallbackRef.current = null;
    missingCallbackRef.current = null;
    beforePreviewCallbackRef.current = null;
    resetOpenRequest(closingOwner);
    patchFlow({ ...INITIAL_FLOW });
    return true;
  }, [flow.operation?.operationId, flow.owner, flow.ownerGeneration, flow.preview, flow.stage, patchFlow, releaseUnsubmittedOwner, resetOpenRequest]);

  const resumePendingOperation = React.useCallback((task) => {
    const operationId = String(task?.operationId || '').trim();
    if (!operationId || task?.recoveryUnavailable) return Promise.reject(pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE'));
    const other = findAccountRemovalActivity(activityIdRef.current, task);
    if (other.matching) return other.matching.resume(task);
    if (other.blocked) return Promise.reject(pendingTaskError('ACCOUNT_REMOVAL_ACTIVE_TASK_EXISTS'));
    const active = activeOwnerRef.current;
    if (active && (!task.pendingOwner || ownerKey(active) !== ownerKey(task.pendingOwner)
      || (durableOperationRef.current?.operationId && durableOperationRef.current.operationId !== operationId))) {
      return Promise.reject(pendingTaskError('ACCOUNT_REMOVAL_ACTIVE_TASK_EXISTS'));
    }
    if (active && task.pendingOwnerGeneration && flow.ownerGeneration
      && accountRemovalGenerationKey(task.pendingOwnerGeneration) !== accountRemovalGenerationKey(flow.ownerGeneration)) {
      return Promise.reject(pendingTaskError('ACCOUNT_REMOVAL_ACTIVE_TASK_EXISTS'));
    }
    const running = recoveryInFlightRef.current || confirmInFlightRef.current || directInFlightRef.current?.promise;
    if (running) { patchFlow({ open: true }); return running; }
    const request = (async () => {
      patchFlow({ open: true, mode: 'resume', stage: 'loading', error: null, errorMessage: '' });
      try {
        const operation = await readPendingAccountRemovalTask(task);
        if (operation.completed === true) {
          if (durableOperationRef.current?.operationId === operationId && active) return completeFlow(operation, active);
          if (active) {
            const error = pendingTaskError('ACCOUNT_REMOVAL_ACTIVE_TASK_EXISTS');
            patchFlow({ stage: 'error', error, errorMessage: getAccountRemovalErrorMessage(error) });
            return operation;
          }
          patchFlow({ stage: 'completed', operation, owner: null, account: null, confirmationUncertain: false });
          return operation;
        }
        const currentActivity = findAccountRemovalActivity(activityIdRef.current, task);
        if (currentActivity.matching || currentActivity.blocked) throw pendingTaskError('ACCOUNT_REMOVAL_ACTIVE_TASK_EXISTS');
        const owner = operation.pendingOwner;
        activeOwnerRef.current = owner;
        if (!activityLeaseRef.current) activityLeaseRef.current = registerAccountRemovalActivity(activityIdRef.current, owner,
          pending => activityContinuationRef.current?.(pending));
        uncertainConfirmationRef.current = null;
        const preview = { owner, previewFingerprint: operation.previewFingerprint };
        patchFlow({ owner, account: null, operation, preview, ownerGeneration: operation.pendingOwnerGeneration || null,
          confirmationUncertain: false, backupReview: null, backupAuthorization: null });
        const completed = await continuePendingAccountRemovalTask(operation, {
          finishClientCleanup,
          onStage: (stage, current, scopedPreview) => {
            desktopBarrierFingerprintRef.current = scopedPreview.previewFingerprint;
            patchFlow({ stage, operation: current });
          },
        });
        return await completeFlow(completed, owner, operation.pendingOwnerGeneration);
      } catch (error) {
        patchFlow({ stage: 'error', error, errorMessage: getAccountRemovalErrorMessage(error) });
        return null;
      }
    })();
    recoveryInFlightRef.current = request;
    void request.finally(() => { if (recoveryInFlightRef.current === request) recoveryInFlightRef.current = null; }).catch(() => undefined);
    return request;
  }, [completeFlow, finishClientCleanup, flow.ownerGeneration, patchFlow]);
  activityContinuationRef.current = resumePendingOperation;

  return {
    flow,
    openAccountRemoval,
    deleteAccountDirectly,
    resumePendingOperation,
    refreshPreview,
    exportBackupBeforeRemoval,
    useRecentBackupBeforeRemoval,
    skipBackupBeforeRemoval,
    confirmRemoval,
    closeAccountRemoval,
    busy: BUSY_STAGES.has(flow.stage),
    activeOwnerId: activeOwnerRef.current?.ownerId || '',
  };
}

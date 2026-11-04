import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_CODE: 'SKIP_BACKUP_AND_DELETE_PERMANENTLY',
  confirmAccountRemoval: vi.fn(),
  prepareAccountRemovalPreview: vi.fn(),
  recoverAccountRemoval: vi.fn(),
  recoverAccountRemovalDirectly: vi.fn(),
  releaseAccountRemovalPreview: vi.fn(),
  verifyAccountRemovalClientCleanup: vi.fn(),
  getAccountRemovalOperation: vi.fn(),
  resumeAccountRemovalOperation: vi.fn(),
  reportAccountRemovalClientFailure: vi.fn(),
  listPendingAccountRemovals: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  cleanupAndVerifyAccountRemovalClientResources: vi.fn(),
  prepareAccountRemovalBarrier: vi.fn(),
  releaseAccountRemovalBarrier: vi.fn(),
  releaseAccountRemovalRendererBarrier: vi.fn(),
}));

const backupMocks = vi.hoisted(() => ({
  exportDataBackup: vi.fn(),
}));

vi.mock('../services/accountRemovalClient.js', () => clientMocks);
vi.mock('../services/accountRemovalRuntime.js', () => runtimeMocks);
vi.mock('../../../dataBackup/services/dataBackupDesktopClient.js', () => backupMocks);

import { useAccountRemovalFlow } from './useAccountRemovalFlow.js';

const owner = Object.freeze({ ownerType: 'model_api_account', ownerId: 'model-hook-owner' });
const preview = Object.freeze({
  owner,
  previewFingerprint: 'f'.repeat(64),
  plannedResources: [{ id: 'registry:model-api-accounts' }],
  preserveResources: [],
});
const account = Object.freeze({ ...owner, displayName: 'Model hook owner' });
const ozonOwner = Object.freeze({ ownerType: 'ozon_shop', ownerId: 'shop-backup-gate' });
const ozonPreview = Object.freeze({ ...preview, owner: ozonOwner });
const requiredBackupReview = Object.freeze({
  required: true,
  previewFingerprint: ozonPreview.previewFingerprint,
  dataFingerprint: 'd'.repeat(64),
  totalRecords: 21,
  domains: [{ domain: 'manual-order-facts', label: '采购补录', recordCount: 21 }],
  latestVerifiedBackup: null,
});

function ozonPreviewPayload(backupReview = requiredBackupReview) {
  return {
    ok: true,
    preview: ozonPreview,
    account: { ...ozonOwner, displayName: 'Ozon backup gate' },
    backupReview,
  };
}

function pendingOperation() {
  return {
    ok: true,
    operationId: 'operation-hook-1',
    phase: 'external-delete-pending',
    status: 'pending',
    completed: false,
    requiresClientCleanup: true,
    previewFingerprint: preview.previewFingerprint,
    clientCleanup: {
      nonce: 'client-cleanup-nonce',
      resourceIds: ['memory:renderer-model-api-settings'],
    },
  };
}

function completedOperation() {
  return {
    ...pendingOperation(),
    phase: 'completed',
    status: 'completed',
    completed: true,
    requiresClientCleanup: false,
    clientCleanup: null,
  };
}

function stubRecovery(operation = pendingOperation(), recoveredOwner = owner, generation = null) {
  const observed = { ...pendingOperation(), ...operation, completed: false, phase: 'external-delete-pending',
    pendingOwner: recoveredOwner, pendingOwnerGeneration: generation || operation.deletionSummary?.removedOwnerGeneration || null };
  clientMocks.listPendingAccountRemovals.mockResolvedValue({ ok: true, operations: [observed] });
  clientMocks.getAccountRemovalOperation.mockResolvedValue(observed);
  clientMocks.resumeAccountRemovalOperation.mockResolvedValue(operation);
  return observed;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  expect(clientMocks.recoverAccountRemoval).not.toHaveBeenCalled();
  expect(clientMocks.recoverAccountRemovalDirectly).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

beforeEach(() => {
  runtimeMocks.prepareAccountRemovalBarrier.mockResolvedValue({ version: 'barrier-proof' });
  runtimeMocks.releaseAccountRemovalBarrier.mockResolvedValue({ released: true });
  runtimeMocks.releaseAccountRemovalRendererBarrier.mockReset().mockReturnValue({ released: true });
  clientMocks.releaseAccountRemovalPreview.mockResolvedValue({ released: true });
  clientMocks.getAccountRemovalOperation.mockReset();
  clientMocks.resumeAccountRemovalOperation.mockReset();
  clientMocks.reportAccountRemovalClientFailure.mockReset().mockResolvedValue({ reported: true, completed: false });
  clientMocks.listPendingAccountRemovals.mockReset().mockResolvedValue({ ok: true, operations: [] });
  clientMocks.recoverAccountRemoval.mockReset().mockRejectedValue(Object.assign(new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND'), {
    code: 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND',
  }));
});

describe('useAccountRemovalFlow', () => {
  it('restores an orphan pending task by operation id only after establishing new barriers', async () => {
    const ownedPending = { ...pendingOperation(), pendingOwner: owner, pendingOwnerGeneration: null };
    const barrier = deferred();
    clientMocks.getAccountRemovalOperation.mockResolvedValue(ownedPending);
    runtimeMocks.prepareAccountRemovalBarrier.mockReturnValueOnce(barrier.promise);
    clientMocks.resumeAccountRemovalOperation.mockResolvedValue(ownedPending);
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockResolvedValue([]);
    clientMocks.verifyAccountRemovalClientCleanup.mockResolvedValue(completedOperation());
    const { result } = renderHook(useAccountRemovalFlow);
    let resumed;
    act(() => { resumed = result.current.resumePendingOperation(ownedPending); });
    await waitFor(() => expect(runtimeMocks.prepareAccountRemovalBarrier).toHaveBeenCalled());
    expect(clientMocks.resumeAccountRemovalOperation).not.toHaveBeenCalled();
    await act(async () => { barrier.resolve({}); await resumed; });
    expect(clientMocks.getAccountRemovalOperation).toHaveBeenCalledWith(ownedPending.operationId);
    expect(clientMocks.resumeAccountRemovalOperation).toHaveBeenCalledWith(ownedPending.operationId);
    expect(clientMocks.confirmAccountRemoval).not.toHaveBeenCalled();
    expect(result.current.flow.stage).toBe('completed');
  });
  it('refuses an orphan task when another live flow owns a different deletion and allows it after that flow unmounts', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    const first = renderHook(useAccountRemovalFlow);
    const second = renderHook(useAccountRemovalFlow);
    await act(async () => { await first.result.current.openAccountRemoval(owner); });
    const task = { ...pendingOperation(), operationId: 'other-operation', pendingOwner: { ...owner, ownerId: 'other-owner' } };
    await expect(second.result.current.resumePendingOperation(task)).rejects.toMatchObject({ code: 'ACCOUNT_REMOVAL_ACTIVE_TASK_EXISTS' });
    expect(clientMocks.getAccountRemovalOperation).not.toHaveBeenCalled();
    first.unmount();
    clientMocks.getAccountRemovalOperation.mockResolvedValue({ operationId: task.operationId, completed: true });
    await act(async () => { await second.result.current.resumePendingOperation(task); });
    expect(second.result.current.flow.stage).toBe('completed');
    expect(clientMocks.resumeAccountRemovalOperation).not.toHaveBeenCalled();
  });
  it('reports only trusted cleanup failure metadata and preserves the original failure if diagnostics also fail', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockResolvedValue(pendingOperation());
    const original = Object.assign(new Error('private diagnostic text must not leave this boundary'), {
      code: 'RECOVERY_REMOTE_ACCESS_DENIED', resourceId: 'memory:renderer-model-api-settings',
    });
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockRejectedValueOnce(original);
    clientMocks.reportAccountRemovalClientFailure.mockRejectedValueOnce(new Error('diagnostic endpoint down'));
    const { result } = renderHook(useAccountRemovalFlow);
    await act(async () => { await result.current.openAccountRemoval(owner); });
    await act(async () => { await result.current.confirmRemoval(); });
    expect(clientMocks.reportAccountRemovalClientFailure).toHaveBeenCalledWith({
      operationId: 'operation-hook-1', nonce: 'client-cleanup-nonce', previewFingerprint: preview.previewFingerprint,
      errorCode: 'RECOVERY_REMOTE_ACCESS_DENIED', resourceId: 'memory:renderer-model-api-settings',
    }, { timeoutMs: 2000 });
    expect(result.current.flow.error).toBe(original);
    expect(result.current.flow.stage).toBe('error');
    expect(result.current.flow.errorMessage).toContain('远端恢复服务拒绝访问');
  });
  it('survives the development StrictMode setup-cleanup-setup cycle and still publishes deletion preview state', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    const { result } = renderHook(() => useAccountRemovalFlow(), {
      reactStrictMode: true,
    });
    await act(async () => { await result.current.openAccountRemoval(owner); });
    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledWith(owner);
    expect(result.current.flow).toMatchObject({ open: true, stage: 'preview', owner, preview, account });
  });
  it('drains owner writes before requesting a deletion preview', async () => {
    const drain = deferred();
    const beforePreview = vi.fn(() => drain.promise);
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    const { result } = renderHook(() => useAccountRemovalFlow());

    let opening;
    act(() => {
      opening = result.current.openAccountRemoval(owner, { beforePreview });
    });
    await waitFor(() => expect(beforePreview).toHaveBeenCalledWith(owner));
    expect(result.current.flow.stage).toBe('loading');
    expect(clientMocks.prepareAccountRemovalPreview).not.toHaveBeenCalled();

    await act(async () => {
      drain.resolve();
      await opening;
    });
    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledWith(owner);
    expect(result.current.flow.stage).toBe('preview');
  });

  it('removes a local-only draft only after preview and recovery both prove the owner is missing', async () => {
    const missingOwner = new Error('ACCOUNT_REMOVAL_OWNER_NOT_FOUND');
    missingOwner.code = 'ACCOUNT_REMOVAL_OWNER_NOT_FOUND';
    const missingOperation = new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
    missingOperation.code = 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND';
    const onCompleted = vi.fn();
    const onMissing = vi.fn();
    clientMocks.prepareAccountRemovalPreview.mockRejectedValue(missingOwner);
    clientMocks.recoverAccountRemoval.mockRejectedValue(missingOperation);
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(owner, { onCompleted, onMissing });
    });

    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledWith(owner);
    expect(clientMocks.listPendingAccountRemovals).toHaveBeenCalledWith({ owner });
    expect(onMissing).toHaveBeenCalledWith(owner);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(result.current.flow).toMatchObject({ open: false, stage: 'idle', owner: null });
  });

  it('does not call onCompleted until client cleanup and server readback both return completed', async () => {
    const verification = deferred();
    const onCompleted = vi.fn();
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockResolvedValue(pendingOperation());
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockResolvedValue([
      { resourceId: 'memory:renderer-model-api-settings', state: 'absent' },
    ]);
    clientMocks.verifyAccountRemovalClientCleanup.mockReturnValue(verification.promise);
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(owner, { onCompleted });
    });
    expect(result.current.flow.stage).toBe('preview');

    let confirmation;
    act(() => {
      confirmation = result.current.confirmRemoval();
    });
    await waitFor(() => expect(clientMocks.verifyAccountRemovalClientCleanup).toHaveBeenCalledTimes(1));
    expect(onCompleted).not.toHaveBeenCalled();
    expect(result.current.flow.stage).toBe('verifying');

    await act(async () => {
      verification.resolve(completedOperation());
      await confirmation;
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ completed: true }));
    expect(result.current.flow.stage).toBe('completed');
    expect(runtimeMocks.releaseAccountRemovalBarrier).toHaveBeenCalledWith({
      previewFingerprint: preview.previewFingerprint,
    });
  });

  it('closes a completed deletion immediately without a redundant preview-release request', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockResolvedValue(pendingOperation());
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockResolvedValue([
      { resourceId: 'memory:renderer-model-api-settings', state: 'absent' },
    ]);
    clientMocks.verifyAccountRemovalClientCleanup.mockResolvedValue(completedOperation());
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(owner);
    });
    await act(async () => {
      await result.current.confirmRemoval();
    });
    expect(result.current.flow.stage).toBe('completed');

    await act(async () => {
      await expect(result.current.closeAccountRemoval()).resolves.toBe(true);
    });
    expect(clientMocks.releaseAccountRemovalPreview).not.toHaveBeenCalled();
    expect(result.current.flow).toMatchObject({ open: false, stage: 'idle', owner: null });
  });

  it('keeps the flow failed and withholds the callback if final verification is not completed', async () => {
    const onCompleted = vi.fn();
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockResolvedValue({
      operationId: 'operation-incomplete',
      completed: false,
      requiresClientCleanup: false,
    });
    const { result } = renderHook(() => useAccountRemovalFlow());
    await act(async () => {
      await result.current.openAccountRemoval(owner, { onCompleted });
    });
    await act(async () => {
      await result.current.confirmRemoval();
    });

    expect(onCompleted).not.toHaveBeenCalled();
    expect(result.current.flow.stage).toBe('error');
    expect(result.current.flow.error.message).toBe('ACCOUNT_REMOVAL_COMPLETION_NOT_VERIFIED');
    await act(async () => {
      await expect(result.current.closeAccountRemoval()).resolves.toBe(true);
    });
    expect(result.current.flow).toMatchObject({
      open: false,
      stage: 'error',
      operation: { operationId: 'operation-incomplete' },
    });
    expect(runtimeMocks.releaseAccountRemovalBarrier).not.toHaveBeenCalled();
    expect(clientMocks.releaseAccountRemovalPreview).not.toHaveBeenCalled();
    const previewRequestCount = clientMocks.prepareAccountRemovalPreview.mock.calls.length;

    await act(async () => {
      await result.current.openAccountRemoval(owner);
    });
    expect(result.current.flow.open).toBe(true);
    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledTimes(previewRequestCount);
  });

  it('coalesces repeated delete clicks into one prepared preview and keeps the first callbacks', async () => {
    const opening = deferred();
    const firstCompleted = vi.fn();
    const repeatedCompleted = vi.fn();
    clientMocks.prepareAccountRemovalPreview.mockReturnValue(opening.promise);
    const { result } = renderHook(() => useAccountRemovalFlow());

    let first;
    let repeated;
    act(() => {
      first = result.current.openAccountRemoval(owner, { onCompleted: firstCompleted });
      repeated = result.current.openAccountRemoval(owner, { onCompleted: repeatedCompleted });
    });
    expect(repeated).toBe(first);
    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledTimes(1);

    await act(async () => {
      opening.resolve({ ok: true, preview, account });
      await first;
    });
    expect(result.current.flow.stage).toBe('preview');
    expect(repeatedCompleted).not.toHaveBeenCalled();
  });

  it('dismisses a busy removal without canceling it and finishes the hidden task', async () => {
    const opening = deferred();
    clientMocks.prepareAccountRemovalPreview.mockReturnValue(opening.promise);
    const { result } = renderHook(() => useAccountRemovalFlow());

    let pendingOpen;
    act(() => {
      pendingOpen = result.current.openAccountRemoval(owner);
    });
    expect(result.current.flow).toMatchObject({ open: true, stage: 'loading' });

    await act(async () => {
      await expect(result.current.closeAccountRemoval()).resolves.toBe(true);
    });
    expect(result.current.flow).toMatchObject({ open: false, stage: 'loading' });
    expect(clientMocks.releaseAccountRemovalPreview).not.toHaveBeenCalled();
    expect(runtimeMocks.releaseAccountRemovalBarrier).not.toHaveBeenCalled();

    await act(async () => {
      opening.resolve({ ok: true, preview, account });
      await pendingOpen;
    });
    expect(result.current.flow).toMatchObject({ open: false, stage: 'preview' });
  });

  it('releases the prepared local-api owner fence when the user cancels', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    const { result } = renderHook(() => useAccountRemovalFlow());
    await act(async () => {
      await result.current.openAccountRemoval(owner);
    });
    await act(async () => {
      await result.current.closeAccountRemoval();
    });
    expect(clientMocks.releaseAccountRemovalPreview).toHaveBeenCalledWith(owner);
    expect(result.current.flow).toMatchObject({ open: false, stage: 'idle' });
  });

  it('releases fences after recovery proves an unsuccessful confirmation created no operation', async () => {
    const policyError = new Error('本地 API 缺少明确的授权策略');
    policyError.code = 'LOCAL_API_AUTH_POLICY_MISSING';
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockRejectedValue(policyError);
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(owner);
    });
    await act(async () => {
      await result.current.confirmRemoval();
    });
    expect(result.current.flow).toMatchObject({
      open: true,
      stage: 'error',
      operation: null,
    });

    await act(async () => {
      await expect(result.current.closeAccountRemoval()).resolves.toBe(true);
    });
    expect(runtimeMocks.releaseAccountRemovalBarrier).not.toHaveBeenCalled();
    expect(result.current.flow).toMatchObject({ open: false, confirmationUncertain: true, owner });
    await act(async () => { await result.current.refreshPreview(); });
    expect(clientMocks.listPendingAccountRemovals).toHaveBeenCalledWith({ owner });
    await act(async () => { await result.current.closeAccountRemoval(); });
    expect(runtimeMocks.releaseAccountRemovalBarrier).toHaveBeenCalledWith({
      previewFingerprint: preview.previewFingerprint,
    });
    expect(clientMocks.releaseAccountRemovalPreview).toHaveBeenCalledWith(owner);
    expect(result.current.flow).toMatchObject({ open: false, stage: 'idle' });
  });
  it('keeps an uncertain confirmation recoverable when its HTTP response is lost', async () => {
    const onCompleted = vi.fn();
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'LOCAL_API_TIMEOUT' }));
    const { result } = renderHook(useAccountRemovalFlow);
    await act(async () => { await result.current.openAccountRemoval(owner, { onCompleted }); });
    await act(async () => { await result.current.confirmRemoval(); });
    expect(result.current.flow).toMatchObject({ operation: null, confirmationUncertain: true, stage: 'error' });
    await act(async () => { await result.current.closeAccountRemoval(); });
    expect(result.current.flow).toMatchObject({ open: false, owner, confirmationUncertain: true });
    expect(clientMocks.releaseAccountRemovalPreview).not.toHaveBeenCalled();
    expect(runtimeMocks.releaseAccountRemovalRendererBarrier).not.toHaveBeenCalled();
    stubRecovery(completedOperation());
    await act(async () => { await result.current.openAccountRemoval(owner); await result.current.refreshPreview(); });
    expect(result.current.flow).toMatchObject({ stage: 'completed', confirmationUncertain: false });
    expect(clientMocks.confirmAccountRemoval).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
  it('rolls back a failed pre-confirm barrier only after the server acknowledges no durable owner operation', async () => {
    const released = deferred();
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    runtimeMocks.prepareAccountRemovalBarrier.mockRejectedValueOnce(new Error('synthetic drain failure'));
    clientMocks.releaseAccountRemovalPreview.mockReturnValueOnce(released.promise);
    const { result } = renderHook(useAccountRemovalFlow);
    await act(async () => { await result.current.openAccountRemoval(owner); });
    let pendingConfirm;
    act(() => { pendingConfirm = result.current.confirmRemoval(); });
    await waitFor(() => expect(clientMocks.releaseAccountRemovalPreview).toHaveBeenCalledWith(owner));
    expect(runtimeMocks.releaseAccountRemovalRendererBarrier).not.toHaveBeenCalled();
    await act(async () => { released.resolve({ ok: true }); await pendingConfirm; });
    expect(runtimeMocks.releaseAccountRemovalRendererBarrier).toHaveBeenCalledWith(
      expect.objectContaining({ owner, previewFingerprint: preview.previewFingerprint }), { verifiedNoOperation: true },
    );
    expect(clientMocks.confirmAccountRemoval).not.toHaveBeenCalled();
  });
  it('observes a pending browser cleanup once and resumes its existing operation without confirming again', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockResolvedValue(pendingOperation());
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockReset()
      .mockRejectedValueOnce(Object.assign(new Error('pending'), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS' }))
      .mockResolvedValue([]);
    const { result } = renderHook(useAccountRemovalFlow);
    await act(async () => { await result.current.openAccountRemoval(owner); });
    await act(async () => { await result.current.confirmRemoval(); });
    expect(result.current.flow).toMatchObject({ stage: 'pending', operation: { operationId: 'operation-hook-1' } });
    expect(result.current.flow.errorMessage).toBe('清理仍在进行，可稍后继续查看。');
    expect(clientMocks.reportAccountRemovalClientFailure).not.toHaveBeenCalled();
    await act(async () => { await result.current.closeAccountRemoval(); });
    expect(result.current.flow).toMatchObject({ open: false, stage: 'pending', owner });
    expect(runtimeMocks.releaseAccountRemovalRendererBarrier).not.toHaveBeenCalled();
    stubRecovery({ ...pendingOperation(), clientCleanup: { ...pendingOperation().clientCleanup, nonce: 'recovered-nonce' } });
    clientMocks.verifyAccountRemovalClientCleanup.mockResolvedValue(completedOperation());
    await act(async () => {
      const first = result.current.refreshPreview();
      const second = result.current.refreshPreview();
      expect(first).toBe(second);
      await first;
    });
    expect(clientMocks.resumeAccountRemovalOperation).toHaveBeenCalledTimes(1);
    expect(clientMocks.confirmAccountRemoval).toHaveBeenCalledTimes(1);
    expect(clientMocks.verifyAccountRemovalClientCleanup).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: 'operation-hook-1', nonce: 'recovered-nonce' }));
    expect(result.current.flow.stage).toBe('completed');
  });
  it('coalesces same-turn confirmations into one request and one nonce verification', async () => {
    const confirmation = deferred();
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockReturnValue(confirmation.promise);
    clientMocks.verifyAccountRemovalClientCleanup.mockResolvedValue(completedOperation());
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockResolvedValue([]);
    const { result } = renderHook(useAccountRemovalFlow);
    await act(async () => { await result.current.openAccountRemoval(owner); });
    let first, second;
    act(() => { first = result.current.confirmRemoval(); second = result.current.confirmRemoval(); });
    expect(first).toBe(second);
    await act(async () => { confirmation.resolve(pendingOperation()); await first; });
    expect(clientMocks.confirmAccountRemoval).toHaveBeenCalledTimes(1);
    expect(clientMocks.verifyAccountRemovalClientCleanup).toHaveBeenCalledTimes(1);
    expect(result.current.flow.stage).toBe('completed');
    await act(async () => { await result.current.confirmRemoval(); });
    expect(clientMocks.confirmAccountRemoval).toHaveBeenCalledTimes(1);
  });
  it('does not release a possibly committed deletion merely because the settings component unmounts', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'LOCAL_API_TIMEOUT' }));
    const { result, unmount } = renderHook(useAccountRemovalFlow);
    await act(async () => { await result.current.openAccountRemoval(owner); });
    await act(async () => { await result.current.confirmRemoval(); });
    unmount();
    expect(clientMocks.releaseAccountRemovalPreview).not.toHaveBeenCalled();
    expect(runtimeMocks.releaseAccountRemovalBarrier).not.toHaveBeenCalled();
  });
  it('does not let a completed owner suppress errors for a later owner generation', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockResolvedValue(completedOperation());
    const { result } = renderHook(useAccountRemovalFlow);
    await act(async () => { await result.current.openAccountRemoval(owner); });
    await act(async () => { await result.current.confirmRemoval(); });
    const nextOwner = { ...owner, ownerId: 'next-owner' };
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview: { ...preview, owner: nextOwner }, account: { ...account, ...nextOwner } });
    clientMocks.confirmAccountRemoval.mockRejectedValue(new Error('next-owner failed'));
    await act(async () => { await result.current.openAccountRemoval(nextOwner); });
    await act(async () => { await result.current.confirmRemoval(); });
    expect(result.current.flow).toMatchObject({ owner: nextOwner, stage: 'error', confirmationUncertain: true });
  });

  it('refreshes a safe preview when the server detects a last-moment snapshot change', async () => {
    const changed = new Error('ACCOUNT_REMOVAL_SNAPSHOT_FINGERPRINT_MISMATCH');
    changed.code = 'ACCOUNT_REMOVAL_SNAPSHOT_FINGERPRINT_MISMATCH';
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockRejectedValue(changed);
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(owner);
    });
    await act(async () => {
      await result.current.confirmRemoval();
    });

    expect(runtimeMocks.releaseAccountRemovalBarrier).toHaveBeenCalledWith({
      previewFingerprint: preview.previewFingerprint,
    });
    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledTimes(3);
    expect(result.current.flow).toMatchObject({
      open: true,
      stage: 'preview',
      operation: null,
      backupAuthorization: null,
      error: null,
    });
    expect(result.current.flow.backupError).toContain('发生变化');
  });

  it('recovers an external-delete-pending operation after restart when preview finds no account row', async () => {
    const onCompleted = vi.fn();
    const missingOwner = new Error('ACCOUNT_REMOVAL_OWNER_NOT_FOUND');
    missingOwner.code = 'ACCOUNT_REMOVAL_OWNER_NOT_FOUND';
    clientMocks.prepareAccountRemovalPreview.mockRejectedValue(missingOwner);
    stubRecovery(pendingOperation());
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockResolvedValue([
      { resourceId: 'memory:renderer-model-api-settings', state: 'absent' },
    ]);
    clientMocks.verifyAccountRemovalClientCleanup.mockResolvedValue(completedOperation());
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(owner, { onCompleted });
    });

    expect(clientMocks.listPendingAccountRemovals).toHaveBeenCalledWith({ owner });
    expect(clientMocks.resumeAccountRemovalOperation).toHaveBeenCalledWith('operation-hook-1');
    expect(runtimeMocks.cleanupAndVerifyAccountRemovalClientResources).toHaveBeenCalledWith(
      owner,
      ['memory:renderer-model-api-settings'],
      { operationId: 'operation-hook-1' },
    );
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(result.current.flow.stage).toBe('completed');
    expect(result.current.flow.operation.completed).toBe(true);
  });

  it('direct delete resumes an existing operation and completes from one user click', async () => {
    const onCompleted = vi.fn();
    const busyError = new Error('ACCOUNT_REMOVAL_DATABASE_BUSY');
    busyError.code = 'ACCOUNT_REMOVAL_DATABASE_BUSY';
    stubRecovery(pendingOperation());
    clientMocks.resumeAccountRemovalOperation
      .mockRejectedValueOnce(busyError)
      .mockRejectedValueOnce(busyError)
      .mockResolvedValue(pendingOperation());
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockResolvedValue([
      { resourceId: 'memory:renderer-model-api-settings', state: 'absent' },
    ]);
    clientMocks.verifyAccountRemovalClientCleanup.mockResolvedValue(completedOperation());
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.deleteAccountDirectly(owner, { onCompleted });
    });

    expect(clientMocks.resumeAccountRemovalOperation).toHaveBeenCalledTimes(3);
    expect(clientMocks.resumeAccountRemovalOperation).toHaveBeenLastCalledWith('operation-hook-1', { directDelete: true });
    clientMocks.resumeAccountRemovalOperation.mock.invocationCallOrder.forEach((order, index) => {
      expect(runtimeMocks.prepareAccountRemovalBarrier.mock.invocationCallOrder[index]).toBeLessThan(order);
    });
    expect(clientMocks.prepareAccountRemovalPreview).not.toHaveBeenCalled();
    expect(clientMocks.confirmAccountRemoval).not.toHaveBeenCalled();
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(result.current.flow).toMatchObject({ mode: 'direct', stage: 'completed' });
  });
  it('coalesces same-turn direct deletion recovery instead of starting a second cleanup', async () => {
    const recovery = deferred();
    stubRecovery(completedOperation());
    clientMocks.resumeAccountRemovalOperation.mockReturnValue(recovery.promise);
    const onCompleted = vi.fn();
    const { result } = renderHook(useAccountRemovalFlow);
    let first, second;
    act(() => {
      first = result.current.deleteAccountDirectly(owner, { onCompleted });
      second = result.current.deleteAccountDirectly(owner, { onCompleted });
    });
    expect(first).toBe(second);
    await act(async () => { recovery.resolve(completedOperation()); await first; });
    expect(clientMocks.resumeAccountRemovalOperation).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
  it('retains a direct deletion after both confirmation and follow-up recovery lose their HTTP responses', async () => {
    clientMocks.listPendingAccountRemovals.mockReset()
      .mockResolvedValueOnce({ ok: true, operations: [] })
      .mockRejectedValue(Object.assign(new Error('timeout'), { code: 'LOCAL_API_TIMEOUT' }));
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'LOCAL_API_TIMEOUT' }));
    const { result } = renderHook(useAccountRemovalFlow);
    await act(async () => { await result.current.deleteAccountDirectly(owner); });
    expect(result.current.flow).toMatchObject({ mode: 'direct', stage: 'error', confirmationUncertain: true, operation: null });
    await act(async () => { await result.current.closeAccountRemoval(); });
    expect(result.current.flow).toMatchObject({ open: false, owner, confirmationUncertain: true });
    expect(clientMocks.releaseAccountRemovalPreview).not.toHaveBeenCalled();
    expect(runtimeMocks.releaseAccountRemovalBarrier).not.toHaveBeenCalled();
  });

  it('direct delete creates and finishes a new Ozon removal without backup or retry screens', async () => {
    const missingOperation = new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
    missingOperation.code = 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND';
    clientMocks.recoverAccountRemovalDirectly.mockRejectedValue(missingOperation);
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue(ozonPreviewPayload());
    clientMocks.confirmAccountRemoval.mockResolvedValue(pendingOperation());
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockResolvedValue([
      { resourceId: 'memory:renderer-model-api-settings', state: 'absent' },
    ]);
    clientMocks.verifyAccountRemovalClientCleanup.mockResolvedValue(completedOperation());
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.deleteAccountDirectly(ozonOwner);
    });

    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledTimes(2);
    expect(clientMocks.confirmAccountRemoval).toHaveBeenCalledWith(expect.objectContaining({
      preview: ozonPreview,
      backupAuthorization: {
        outcome: 'explicitly-skipped',
        previewFingerprint: ozonPreview.previewFingerprint,
        dataFingerprint: requiredBackupReview.dataFingerprint,
        skipConfirmationCode: 'SKIP_BACKUP_AND_DELETE_PERMANENTLY',
      },
    }));
    expect(result.current.flow).toMatchObject({ mode: 'direct', stage: 'completed' });
  });

  it('refreshes an error by resuming an existing operation even while the account row still exists', async () => {
    const onCompleted = vi.fn();
    const retryable = new Error('ACCOUNT_REMOVAL_QUIESCE_TIMEOUT');
    retryable.code = 'ACCOUNT_REMOVAL_QUIESCE_TIMEOUT';
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({ ok: true, preview, account });
    clientMocks.confirmAccountRemoval.mockRejectedValue(retryable);
    stubRecovery(completedOperation());
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(owner, { onCompleted });
    });
    await act(async () => {
      await result.current.confirmRemoval();
    });
    expect(result.current.flow.stage).toBe('error');

    await act(async () => {
      await result.current.refreshPreview();
    });
    expect(clientMocks.listPendingAccountRemovals).toHaveBeenCalledWith({ owner });
    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledTimes(2);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(result.current.flow.stage).toBe('completed');
  });

  it('uses the authoritative Ozon generation for the normal deletion barrier without echoing it into the server preview', async () => {
    const ozonOwner = { ownerType: 'ozon_shop', ownerId: 'shop-generation-normal' };
    const ozonPreview = { ...preview, owner: ozonOwner };
    const ownerGeneration = {
      ownerId: ozonOwner.ownerId,
      clientId: 'client-generation-normal',
      profileId: 'default',
      shopIncarnation: 'incarnation-normal',
      credentialRevision: 4,
    };
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue({
      ok: true,
      preview: ozonPreview,
      account: { ...ozonOwner, displayName: 'Generation normal' },
      ownerGeneration,
    });
    clientMocks.confirmAccountRemoval.mockResolvedValue({
      ...completedOperation(),
      previewFingerprint: ozonPreview.previewFingerprint,
    });
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(ozonOwner);
    });
    await act(async () => {
      await result.current.confirmRemoval();
    });

    expect(runtimeMocks.prepareAccountRemovalBarrier).toHaveBeenCalledWith({
      ...ozonPreview,
      ownerGeneration,
    });
    expect(clientMocks.confirmAccountRemoval).toHaveBeenCalledWith(expect.objectContaining({
      preview: ozonPreview,
    }));
    expect(clientMocks.confirmAccountRemoval.mock.calls[0][0].preview).not.toHaveProperty('ownerGeneration');
  });

  it('recovers the removed Ozon generation from durable deletion summary after a renderer restart', async () => {
    const ozonOwner = { ownerType: 'ozon_shop', ownerId: 'shop-generation-recovery' };
    const ownerGeneration = {
      ownerId: ozonOwner.ownerId,
      clientId: 'client-generation-recovery',
      profileId: 'default',
      shopIncarnation: 'incarnation-recovery',
      credentialRevision: 7,
    };
    const missingOwner = new Error('ACCOUNT_REMOVAL_OWNER_NOT_FOUND');
    missingOwner.code = 'ACCOUNT_REMOVAL_OWNER_NOT_FOUND';
    clientMocks.prepareAccountRemovalPreview.mockRejectedValue(missingOwner);
    stubRecovery({
      ...pendingOperation(),
      deletionSummary: { removedOwnerGeneration: ownerGeneration },
      clientCleanup: {
        nonce: 'ozon-recovery-cleanup',
        resourceIds: ['memory:renderer-product-list-l0'],
      },
    }, ozonOwner, ownerGeneration);
    runtimeMocks.cleanupAndVerifyAccountRemovalClientResources.mockResolvedValue([
      { resourceId: 'memory:renderer-product-list-l0', state: 'absent' },
    ]);
    clientMocks.verifyAccountRemovalClientCleanup.mockResolvedValue(completedOperation());
    const { result } = renderHook(() => useAccountRemovalFlow());

    await act(async () => {
      await result.current.openAccountRemoval(ozonOwner);
    });

    expect(runtimeMocks.prepareAccountRemovalBarrier).toHaveBeenCalledWith({
      owner: ozonOwner,
      previewFingerprint: preview.previewFingerprint,
      ownerGeneration,
    });
    expect(runtimeMocks.cleanupAndVerifyAccountRemovalClientResources).toHaveBeenCalledWith(
      { ...ozonOwner, ...ownerGeneration },
      ['memory:renderer-product-list-l0'],
      { operationId: 'operation-hook-1' },
    );
  });

  it('blocks a required backup before starting the deletion barrier even when confirmRemoval is called directly', async () => {
    clientMocks.prepareAccountRemovalPreview.mockResolvedValue(ozonPreviewPayload());
    const { result } = renderHook(() => useAccountRemovalFlow());
    await act(async () => {
      await result.current.openAccountRemoval(ozonOwner);
    });
    await act(async () => {
      await result.current.confirmRemoval();
    });

    expect(runtimeMocks.prepareAccountRemovalBarrier).not.toHaveBeenCalled();
    expect(clientMocks.confirmAccountRemoval).not.toHaveBeenCalled();
    expect(result.current.flow.stage).toBe('preview');
    expect(result.current.flow.backupError).toMatch(/先完成备份审阅/u);
  });

  it('exports and re-reads a verified backup before authorizing the existing deletion flow', async () => {
    const verifiedReview = {
      ...requiredBackupReview,
      latestVerifiedBackup: {
        backupId: 'backup-exported',
        status: 'verified',
        dataFingerprint: requiredBackupReview.dataFingerprint,
        survivesAccountRemoval: true,
        verifiedAt: '2026-07-17T10:00:00.000Z',
      },
    };
    clientMocks.prepareAccountRemovalPreview
      .mockResolvedValueOnce(ozonPreviewPayload())
      .mockResolvedValueOnce(ozonPreviewPayload(verifiedReview))
      .mockResolvedValueOnce(ozonPreviewPayload(verifiedReview));
    backupMocks.exportDataBackup.mockResolvedValue({ id: 'backup-exported', verified: true, canceled: false });
    clientMocks.confirmAccountRemoval.mockResolvedValue({
      ...completedOperation(),
      previewFingerprint: ozonPreview.previewFingerprint,
    });
    const { result } = renderHook(() => useAccountRemovalFlow());
    await act(async () => {
      await result.current.openAccountRemoval(ozonOwner);
    });

    await act(async () => {
      await result.current.exportBackupBeforeRemoval();
    });
    expect(backupMocks.exportDataBackup).toHaveBeenCalledWith({
      owner: ozonOwner,
      expectedDataFingerprint: requiredBackupReview.dataFingerprint,
    });
    expect(runtimeMocks.prepareAccountRemovalBarrier).not.toHaveBeenCalled();
    expect(result.current.flow.backupAuthorization).toEqual({
      outcome: 'exported',
      backupId: 'backup-exported',
      previewFingerprint: ozonPreview.previewFingerprint,
      dataFingerprint: requiredBackupReview.dataFingerprint,
    });

    await act(async () => {
      await result.current.confirmRemoval();
    });
    expect(runtimeMocks.prepareAccountRemovalBarrier).toHaveBeenCalledTimes(1);
    expect(clientMocks.confirmAccountRemoval).toHaveBeenCalledWith(expect.objectContaining({
      preview: ozonPreview,
      backupAuthorization: {
        outcome: 'exported',
        backupId: 'backup-exported',
        previewFingerprint: ozonPreview.previewFingerprint,
        dataFingerprint: requiredBackupReview.dataFingerprint,
      },
    }));
  });

  it('creates a skip authorization only after refreshing the exact preview', async () => {
    clientMocks.prepareAccountRemovalPreview
      .mockResolvedValueOnce(ozonPreviewPayload())
      .mockResolvedValueOnce(ozonPreviewPayload());
    const { result } = renderHook(() => useAccountRemovalFlow());
    await act(async () => {
      await result.current.openAccountRemoval(ozonOwner);
    });
    await act(async () => {
      await result.current.skipBackupBeforeRemoval();
    });
    expect(result.current.flow.backupError).toBe('');
    expect(result.current.flow.backupAuthorization).toEqual({
      outcome: 'explicitly-skipped',
      previewFingerprint: ozonPreview.previewFingerprint,
      dataFingerprint: requiredBackupReview.dataFingerprint,
      skipConfirmationCode: 'SKIP_BACKUP_AND_DELETE_PERMANENTLY',
    });
    expect(clientMocks.prepareAccountRemovalPreview).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.prepareAccountRemovalBarrier).not.toHaveBeenCalled();
  });
});

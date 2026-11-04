function toPublicStagedRecovery(descriptor = {}) {
  const generationId = descriptor.generationId;
  return {
    ok: true,
    restoreId: descriptor.restoreId,
    generationId,
    generationIds: Array.isArray(descriptor.generationIds) ? descriptor.generationIds : [generationId],
    mode: descriptor.mode,
    profile: descriptor.profile,
    shopCount: Array.isArray(descriptor.shops) ? descriptor.shops.length : 1,
  };
}

/** Keeps staging paths in the main process until an explicit user-confirmed activation. */
export function createRecoveryIpcBridge({
  requestRecovery,
  activateRecovery,
  refreshRecoveryAuthorization = null,
  hasPendingAccountRemoval = async () => false,
} = {}) {
  if (typeof requestRecovery !== 'function') throw new Error('RECOVERY_IPC_REQUEST_HANDLER_REQUIRED');
  if (typeof activateRecovery !== 'function') throw new Error('RECOVERY_IPC_ACTIVATOR_REQUIRED');
  if (typeof hasPendingAccountRemoval !== 'function') throw new Error('RECOVERY_IPC_ACCOUNT_REMOVAL_STATUS_REQUIRED');
  if (refreshRecoveryAuthorization !== null && typeof refreshRecoveryAuthorization !== 'function') throw new Error('RECOVERY_IPC_AUTH_REFRESH_HANDLER_INVALID');

  const stagedRecoveries = new Map();
  const accountRemovalBarriers = new Set();
  let commandQueue = Promise.resolve();
  let authorizationRefresh = null;

  function publicRemoteFailure(error) {
    if (!/^RECOVERY_REMOTE_(?:LOGIN_REQUIRED|AUTH_REQUIRED|ACCESS_DENIED|ENDPOINT_UNAVAILABLE|UNAVAILABLE)$/u.test(String(error?.code || ''))) throw error;
    const status = error.code === 'RECOVERY_REMOTE_UNAVAILABLE' ? 503 : Number(error.status || error.remoteStatus) || 401;
    return { ok: false, status, data: { ok: false, error: {
      code: error.code, message: error.message, remoteStatus: Number(error.remoteStatus) || 0, safeAuthRetry: false,
    } } };
  }

  async function requestWithFreshAuthorization(input) {
    // This private side channel is created here, populated only by the desktop
    // request handler, and never returned to the renderer or copied into input.
    const authContext = {};
    let result;
    try { result = await requestRecovery(input, { authContext }); }
    catch (error) { return publicRemoteFailure(error); }
    const failure = result?.data?.error;
    if (result?.status !== 401 || failure?.code !== 'RECOVERY_REMOTE_AUTH_REQUIRED'
      || failure.remoteStatus !== 401 || failure.safeAuthRetry !== true
      || !String(authContext.accessToken || '').trim() || !refreshRecoveryAuthorization) return result;
    try {
      if (!authorizationRefresh) {
        authorizationRefresh = Promise.resolve().then(() => refreshRecoveryAuthorization({
          rejectedAccessToken: authContext.accessToken,
        })).finally(() => { authorizationRefresh = null; });
      }
      await authorizationRefresh;
    } catch (error) { return publicRemoteFailure(error); }
    // Exactly one replay of the identical request is admitted. A second 401,
    // uncertain result, 403, 404 or post-mutation failure is returned unchanged.
    try { return await requestRecovery(input, { authContext: {} }); }
    catch (error) { return publicRemoteFailure(error); }
  }

  async function accountRemovalPending() {
    if (accountRemovalBarriers.size > 0) return true;
    try {
      return await hasPendingAccountRemoval() === true;
    } catch {
      return true;
    }
  }

  async function executeRecoveryRequest(input = {}) {
    const command = String(input?.command || '').trim();
    if (!RENDERER_RECOVERY_COMMANDS.has(command)) {
      return { ok: false, status: 403, error: 'RECOVERY_RENDERER_COMMAND_NOT_ALLOWED' };
    }
    if (command === 'begin-account-removal-barrier') {
      const previewFingerprint = String(input?.previewFingerprint || '').trim();
      if (!/^[a-f0-9]{64}$/iu.test(previewFingerprint)) {
        return { ok: false, status: 400, error: 'ACCOUNT_REMOVAL_RECOVERY_BARRIER_INVALID' };
      }
      accountRemovalBarriers.add(previewFingerprint);
      return { ok: true, status: 200, data: { ok: true, fenced: true } };
    }
    if (command === 'end-account-removal-barrier') {
      const previewFingerprint = String(input?.previewFingerprint || '').trim();
      if (!/^[a-f0-9]{64}$/iu.test(previewFingerprint)) {
        return { ok: false, status: 400, error: 'ACCOUNT_REMOVAL_RECOVERY_BARRIER_INVALID' };
      }
      const released = accountRemovalBarriers.delete(previewFingerprint);
      return { ok: true, status: 200, data: { ok: true, released, fenced: accountRemovalBarriers.size > 0 } };
    }
    if (
      ['activate-restore', 'backup-all-shops', 'backup-shop', 'stage-restore'].includes(command)
      && await accountRemovalPending()
    ) {
      return { ok: false, status: 409, error: 'ACCOUNT_REMOVAL_RECOVERY_FENCED' };
    }
    if (command === 'activate-restore') {
      const restoreId = String(input?.restoreId || '').trim();
      const descriptor = stagedRecoveries.get(restoreId);
      if (!descriptor) return { ok: false, status: 404, error: '恢复暂存不存在或已失效。' };
      const result = await activateRecovery(descriptor);
      stagedRecoveries.delete(restoreId);
      return { ok: true, status: 200, data: result };
    }

    const result = await requestWithFreshAuthorization(input);
    if (command !== 'stage-restore' || !result?.ok || !result?.data?.restoreId) return result;
    stagedRecoveries.set(result.data.restoreId, result.data);
    return { ...result, data: toPublicStagedRecovery(result.data) };
  }

  return function handleRecoveryRequest(input = {}) {
    // Read-only remote listings cannot hold the mutation/barrier lane. Barrier
    // acquisition still waits for an already-running backup/restore mutation;
    // acknowledging it early would race deletion with a durable backup write.
    // Releasing a completed barrier is an immediate, idempotent local action.
    if (['list-generations', 'status', 'end-account-removal-barrier'].includes(String(input?.command || '').trim())) {
      return executeRecoveryRequest(input);
    }
    const task = commandQueue.then(() => executeRecoveryRequest(input));
    commandQueue = task.catch(() => undefined);
    return task;
  };
}
const RENDERER_RECOVERY_COMMANDS = new Set([
  'activate-restore',
  'backup-all-shops',
  'backup-shop',
  'begin-account-removal-barrier',
  'end-account-removal-barrier',
  'list-generations',
  'purge-account-owner',
  'purge-account-owner-protection',
  'stage-restore',
  'status',
]);

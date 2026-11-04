function getRecoveryBridge() {
  return globalThis.window?.wangzaiDesktop?.recoveryRequest || null;
}

function toRecoveryError(result) {
  const error = new Error(result?.error || result?.data?.error?.message || '灾难备份请求失败。');
  error.status = Number(result?.status || 0);
  error.code = result?.data?.error?.code || 'RECOVERY_REQUEST_FAILED';
  return error;
}

async function requestRecovery(command, input = {}) {
  const bridge = getRecoveryBridge();
  if (!bridge) {
    const error = new Error('灾难备份只能在桌面端登录会话中使用。');
    error.code = 'RECOVERY_DESKTOP_BRIDGE_REQUIRED';
    throw error;
  }
  const result = await bridge({ command, ...input });
  if (!result?.ok) throw toRecoveryError(result);
  return result.data;
}

/** First enrollment needs passphrase once; later calls omit it and never receive login tokens. */
export function backupShopRecovery({ shopId, passphrase } = {}) {
  return requestRecovery('backup-shop', { shopId, ...(passphrase ? { passphrase } : {}) });
}

export function getRecoveryStatus() {
  return requestRecovery('status');
}

export function stageRecoveryGeneration({ generationId, passphrase } = {}) {
  return stageRecoveryGenerations({ generationIds: [generationId], passphrase });
}

/** A profile switch always stages every selected shop generation into one fresh SQLite candidate. */
export function stageRecoveryGenerations({ generationIds, passphrase } = {}) {
  const ids = Array.isArray(generationIds)
    ? generationIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!ids.length) {
    const error = new Error('请至少选择一个可恢复备份。');
    error.code = 'RECOVERY_GENERATION_REQUIRED';
    return Promise.reject(error);
  }
  return requestRecovery('stage-restore', { generationIds: ids, passphrase });
}

export function activateStagedRecovery({ restoreId } = {}) {
  return requestRecovery('activate-restore', { restoreId });
}

export function reloadDesktopAfterRestore() {
  return globalThis.window?.wangzaiDesktop?.reloadWindow?.() || Promise.resolve();
}

export async function listRecoveryGenerations() {
  const payload = await requestRecovery('list-generations');
  return Array.isArray(payload?.generations) ? payload.generations : [];
}

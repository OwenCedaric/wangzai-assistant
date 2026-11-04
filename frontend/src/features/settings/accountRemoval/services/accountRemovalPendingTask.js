import { getAccountRemovalOperation, listPendingAccountRemovals, resumeAccountRemovalOperation } from './accountRemovalClient.js';
import { prepareAccountRemovalBarrier } from './accountRemovalRuntime.js';
import { accountRemovalOwnerLabels } from '../lib/accountRemovalPresentation.js';
import { normalizeOzonShopGenerationScope } from '../../../../shared/ozon/ozonShopGeneration.js';
import { observePendingAccountRemoval } from './accountRemovalCompletion.js';

export function accountRemovalGenerationKey(value = {}) {
  const scope = normalizeOzonShopGenerationScope(value);
  return JSON.stringify([String(value?.profileId || '').trim(), scope.ownerId, scope.clientId, scope.shopIncarnation, scope.credentialRevision]);
}

export function pendingTaskError(code) {
  return Object.assign(new Error(code), { code });
}

export async function readPendingAccountRemovalTask(task, { read = getAccountRemovalOperation } = {}) {
  const operationId = String(task?.operationId || '').trim();
  if (!operationId || task?.recoveryUnavailable) throw pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE');
  const payload = await read(operationId);
  const operation = payload?.operation || payload;
  if (operation?.operationId !== operationId) throw pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE');
  if (operation.completed === true) return operation;
  const owner = operation.pendingOwner;
  if (operation.recoveryUnavailable || !Object.hasOwn(accountRemovalOwnerLabels, owner?.ownerType)
    || !String(owner?.ownerId || '').trim() || !/^[a-f0-9]{64}$/iu.test(operation.previewFingerprint || '')) {
    throw pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE');
  }
  if (task.pendingOwner && (task.pendingOwner.ownerType !== owner.ownerType || task.pendingOwner.ownerId !== owner.ownerId)) {
    throw pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE');
  }
  if (task.pendingOwnerGeneration && operation.pendingOwnerGeneration
    && accountRemovalGenerationKey(task.pendingOwnerGeneration) !== accountRemovalGenerationKey(operation.pendingOwnerGeneration)) {
    throw pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE');
  }
  return operation;
}

export async function continuePendingAccountRemovalTask(operation, {
  barrier = prepareAccountRemovalBarrier, resume = resumeAccountRemovalOperation, finishClientCleanup, onStage = () => {},
  directDelete = false,
} = {}) {
  const preview = { owner: operation.pendingOwner, previewFingerprint: operation.previewFingerprint,
    ...(operation.pendingOwnerGeneration ? { ownerGeneration: operation.pendingOwnerGeneration } : {}) };
  observePendingAccountRemoval(operation);
  onStage('barrier', operation, preview);
  await barrier(preview);
  onStage('executing', operation, preview);
  let next = directDelete ? await resume(operation.operationId, { directDelete: true }) : await resume(operation.operationId);
  if (next?.operationId !== operation.operationId) throw pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_RESPONSE_INVALID');
  onStage('executing', next, preview);
  if (next.requiresClientCleanup) next = await finishClientCleanup(next, preview);
  return next;
}

export async function lookupPendingAccountRemovalTask(owner, { list = listPendingAccountRemovals, read = getAccountRemovalOperation } = {}) {
  const payload = await list({ owner });
  if (payload?.ok === false || !Array.isArray(payload?.operations) || payload.operations.length > 1) {
    throw pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE');
  }
  if (!payload.operations.length) throw pendingTaskError('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
  const listed = payload.operations[0];
  if (listed?.recoveryUnavailable || listed?.pendingOwner?.ownerType !== owner.ownerType || listed?.pendingOwner?.ownerId !== owner.ownerId) {
    throw pendingTaskError('ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE');
  }
  const operation = await readPendingAccountRemovalTask(listed, { read });
  return { operation, ownerGeneration: operation.pendingOwnerGeneration || listed.pendingOwnerGeneration || null };
}

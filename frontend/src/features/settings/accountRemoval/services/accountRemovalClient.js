import { requestLocalApi } from '../../../../api/localApiClient.js';

export const ACCOUNT_REMOVAL_CONFIRMATION_CODE = 'DELETE_ACCOUNT_PERMANENTLY';
export const ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION = 'account-removal-safety-barriers-v1';
export const ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_CODE = 'SKIP_BACKUP_AND_DELETE_PERMANENTLY';

function request(path, options = {}) {
  return requestLocalApi(path, {
    timeoutMs: options.timeoutMs || 120000,
    signal: options.signal,
    ...options,
  });
}

export function previewAccountRemoval(owner, options = {}) {
  return request('/api/account-removal/preview', {
    method: 'POST',
    body: { owner },
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function prepareAccountRemovalPreview(owner, options = {}) {
  return request('/api/account-removal/prepare-preview', {
    method: 'POST',
    body: { owner },
    timeoutMs: options.timeoutMs || 60000,
    signal: options.signal,
  });
}

export function releaseAccountRemovalPreview(owner, options = {}) {
  return request('/api/account-removal/release-preview', {
    method: 'POST',
    body: { owner },
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function buildAccountRemovalConfirm(preview, idempotencyKey) {
  return {
    version: preview.version,
    contractVersion: preview.version,
    owner: { ...preview.owner },
    requestedOwnerType: preview.requestedOwnerType,
    requestedOwnerId: preview.requestedOwnerId,
    requestedResourceIdsSemantics: preview.requestedResourceIdsSemantics,
    requestedResourceIds: [...preview.requestedResourceIds],
    catalogVersion: preview.catalogVersion,
    catalogFingerprint: preview.catalogFingerprint,
    resourceObservations: preview.resourceObservations.map((entry) => ({ ...entry })),
    snapshotFingerprint: preview.snapshotFingerprint,
    previewFingerprint: preview.previewFingerprint,
    idempotencyKey,
  };
}

export function confirmAccountRemoval({ preview, idempotencyKey, barrierProof, backupAuthorization }, options = {}) {
  return request('/api/account-removal/confirm', {
    method: 'POST',
    body: {
      preview,
      confirm: buildAccountRemovalConfirm(preview, idempotencyKey),
      barrierProof,
      backupAuthorization: backupAuthorization || null,
      confirmationCode: ACCOUNT_REMOVAL_CONFIRMATION_CODE,
    },
    timeoutMs: options.timeoutMs || 180000,
    signal: options.signal,
  });
}

export function verifyAccountRemovalClientCleanup(payload, options = {}) {
  return request('/api/account-removal/client-verify', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 120000,
    signal: options.signal,
  });
}

export function reportAccountRemovalClientFailure(payload, options = {}) {
  return request('/api/account-removal/client-failure', {
    method: 'POST', body: payload, timeoutMs: options.timeoutMs || 2000, signal: options.signal,
  });
}

export function recoverAccountRemoval(owner, options = {}) {
  return request('/api/account-removal/recover', {
    method: 'POST',
    body: { owner },
    timeoutMs: options.timeoutMs || 180000,
    signal: options.signal,
  });
}

export function recoverAccountRemovalDirectly(owner, options = {}) {
  return request('/api/account-removal/recover-direct', {
    method: 'POST',
    body: { owner },
    timeoutMs: options.timeoutMs || 180000,
    signal: options.signal,
  });
}

export function getAccountRemovalOperation(operationId, options = {}) {
  return request(`/api/account-removal/operations/${encodeURIComponent(operationId)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function resumeAccountRemovalOperation(operationId, options = {}) {
  return request(`/api/account-removal/operations/${encodeURIComponent(operationId)}/resume`, {
    method: 'POST',
    ...(options.directDelete === true ? { body: { directDelete: true } } : {}),
    timeoutMs: options.timeoutMs || 180000,
    signal: options.signal,
  });
}

export function listPendingAccountRemovals(options = {}) {
  const owner = options.owner;
  if (owner && (!owner.ownerType || !owner.ownerId)) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  const query = owner ? `?ownerType=${encodeURIComponent(owner.ownerType)}&ownerId=${encodeURIComponent(owner.ownerId)}` : '';
  return request(`/api/account-removal/pending${query}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

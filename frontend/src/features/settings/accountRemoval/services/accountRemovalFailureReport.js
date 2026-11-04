import { reportAccountRemovalClientFailure } from './accountRemovalClient.js';

const allowedCodes = new Set([
  'ACCOUNT_REMOVAL_CLIENT_CLEANUP_FAILED', 'ACCOUNT_REMOVAL_CLIENT_RESOURCE_DUPLICATE',
  'ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID', 'ACCOUNT_REMOVAL_CLIENT_RESOURCE_UNREGISTERED',
  'ACCOUNT_REMOVAL_CLIENT_VERIFY_FAILED', 'ACCOUNT_REMOVAL_RECOVERY_BARRIER_FAILED',
  'ACCOUNT_REMOVAL_RECOVERY_BARRIER_UNAVAILABLE', 'ACCOUNT_REMOVAL_REMOTE_RECOVERY_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_REMOTE_RECOVERY_PURGE_FAILED', 'ACCOUNT_REMOVAL_PROTECTION_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_PROTECTION_PURGE_FAILED', 'ACCOUNT_REMOVAL_PURCHASE_BRIDGE_PURGE_FAILED',
  'ACCOUNT_REMOVAL_PURCHASE_BRIDGE_UNAVAILABLE', 'ACCOUNT_REMOVAL_PURCHASE_BROWSER_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_PURCHASE_BROWSER_PURGE_FAILED', 'RECOVERY_REMOTE_LOGIN_REQUIRED',
  'RECOVERY_REMOTE_AUTH_REQUIRED', 'RECOVERY_REMOTE_ACCESS_DENIED',
  'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE', 'RECOVERY_REMOTE_UNAVAILABLE',
]);

export function buildAccountRemovalFailureReport(operation, previewFingerprint, error) {
  const challenge = operation?.clientCleanup;
  const code = String(error?.code || error?.payload?.error?.code || error?.message || '').trim();
  if (code === 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS' || operation?.completed === true
    || operation?.phase !== 'external-delete-pending' || !operation?.operationId || !challenge?.nonce
    || !Array.isArray(challenge.resourceIds) || operation.previewFingerprint !== previewFingerprint
    || !/^[a-f0-9]{64}$/iu.test(previewFingerprint || '')) return null;
  return {
    operationId: operation.operationId, nonce: challenge.nonce, previewFingerprint,
    errorCode: allowedCodes.has(code) ? code : 'ACCOUNT_REMOVAL_CLIENT_CLEANUP_FAILED',
    ...(challenge.resourceIds.includes(error?.resourceId) ? { resourceId: error.resourceId } : {}),
  };
}

export async function reportAccountRemovalCleanupFailure(operation, fingerprint, error) {
  const payload = buildAccountRemovalFailureReport(operation, fingerprint, error);
  if (payload) await reportAccountRemovalClientFailure(payload, { timeoutMs: 2000 });
}

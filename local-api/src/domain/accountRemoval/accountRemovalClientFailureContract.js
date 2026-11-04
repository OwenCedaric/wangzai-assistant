import { failAccountRemovalContract } from './accountRemovalErrors.js';

export const ACCOUNT_REMOVAL_CLIENT_FAILURE_CODES = Object.freeze([
  'ACCOUNT_REMOVAL_CLIENT_CLEANUP_FAILED',
  'ACCOUNT_REMOVAL_CLIENT_RESOURCE_DUPLICATE',
  'ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID',
  'ACCOUNT_REMOVAL_CLIENT_RESOURCE_UNREGISTERED',
  'ACCOUNT_REMOVAL_CLIENT_VERIFY_FAILED',
  'ACCOUNT_REMOVAL_RECOVERY_BARRIER_FAILED',
  'ACCOUNT_REMOVAL_RECOVERY_BARRIER_UNAVAILABLE',
  'ACCOUNT_REMOVAL_REMOTE_RECOVERY_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_REMOTE_RECOVERY_PURGE_FAILED',
  'ACCOUNT_REMOVAL_PROTECTION_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_PROTECTION_PURGE_FAILED',
  'ACCOUNT_REMOVAL_PURCHASE_BRIDGE_PURGE_FAILED',
  'ACCOUNT_REMOVAL_PURCHASE_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_PURCHASE_BROWSER_BRIDGE_UNAVAILABLE',
  'ACCOUNT_REMOVAL_PURCHASE_BROWSER_PURGE_FAILED',
  'RECOVERY_REMOTE_LOGIN_REQUIRED',
  'RECOVERY_REMOTE_AUTH_REQUIRED',
  'RECOVERY_REMOTE_ACCESS_DENIED',
  'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE',
  'RECOVERY_REMOTE_UNAVAILABLE',
].sort());
const codes = new Set(ACCOUNT_REMOVAL_CLIENT_FAILURE_CODES);
const fields = new Set(['operationId', 'nonce', 'previewFingerprint', 'errorCode', 'resourceId']);

/** Diagnostic codes only: never persist client messages, stack traces or owner data. */
export function createAccountRemovalClientFailureDto(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !fields.has(key))
    || typeof input.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(input.operationId)
    || typeof input.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/u.test(input.nonce)
    || typeof input.previewFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(input.previewFingerprint)
    || !codes.has(input.errorCode)) {
    failAccountRemovalContract('ACCOUNT_REMOVAL_CLIENT_FAILURE_INVALID');
  }
  if (Object.hasOwn(input, 'resourceId') && (typeof input.resourceId !== 'string'
    || !input.resourceId || input.resourceId !== input.resourceId.trim()
    || input.resourceId.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.resourceId))) {
    failAccountRemovalContract('ACCOUNT_REMOVAL_CLIENT_FAILURE_RESOURCE_INVALID');
  }
  return Object.freeze({ operationId: input.operationId, nonce: input.nonce,
    previewFingerprint: input.previewFingerprint, errorCode: input.errorCode,
    ...(Object.hasOwn(input, 'resourceId') ? { resourceId: input.resourceId } : {}) });
}

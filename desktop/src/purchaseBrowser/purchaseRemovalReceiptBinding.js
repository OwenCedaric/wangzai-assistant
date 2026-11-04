import { createHash } from 'node:crypto';

export const PURCHASE_REMOVAL_RECEIPT_VERSION = 'purchase-browser-removal-receipt-v2';

function rejectBinding() {
  throw Object.assign(new Error('PURCHASE_BROWSER_ACCOUNT_REMOVAL_RECEIPT_BINDING_INVALID'), {
    code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_RECEIPT_BINDING_INVALID',
  });
}

/** Main-only validation: no value from the renderer participates in this scope. */
export function validatePurchaseRemovalReceiptBinding(value, { operationId, binding = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== PURCHASE_REMOVAL_RECEIPT_VERSION
    || value.operationId !== operationId
    || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value.nonce)
    || typeof value.ownerGenerationHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.ownerGenerationHash)) rejectBinding();
  if (binding) {
    const ownerType = binding.ownerType || 'purchase_account';
    if (!['purchase_account', 'integration_profile'].includes(ownerType)
      || typeof binding.accountId !== 'string' || !binding.accountId.trim()
      || typeof binding.accountIncarnation !== 'string' || !binding.accountIncarnation.trim()) rejectBinding();
    const expected = createHash('sha256')
      .update(`${ownerType}\0${binding.accountId}\0${binding.accountIncarnation}`, 'utf8')
      .digest('hex');
    if (value.ownerGenerationHash !== expected) rejectBinding();
  }
  return Object.freeze({
    version: value.version,
    operationId: value.operationId,
    nonce: value.nonce,
    ownerGenerationHash: value.ownerGenerationHash,
  });
}

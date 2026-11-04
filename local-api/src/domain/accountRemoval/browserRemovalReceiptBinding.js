import { createHash, timingSafeEqual } from 'node:crypto';

export const BROWSER_REMOVAL_RECEIPT_VERSION = 'purchase-browser-removal-receipt-v2';
const text = value => String(value ?? '').trim();
const digest = value => createHash('sha256').update(value).digest();

export function createBrowserRemovalReceiptBinding(operation) {
  const owner = operation?.payload?.confirm?.owner;
  if (!['purchase_account', 'integration_profile'].includes(owner?.ownerType)
    || !text(operation?.operationId) || !text(operation?.clientCleanupNonce)
    || !text(operation?.payload?.ownerIncarnation)) {
    throw Object.assign(new Error('PURCHASE_BROWSER_ACCOUNT_REMOVAL_OPERATION_INVALID'), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_OPERATION_INVALID' });
  }
  return Object.freeze({ version: BROWSER_REMOVAL_RECEIPT_VERSION,
    operationId: operation.operationId, nonce: operation.clientCleanupNonce,
    ownerGenerationHash: digest(`${owner.ownerType}\0${owner.ownerId}\0${operation.payload.ownerIncarnation}`).toString('hex'),
  });
}

export function assertBrowserRemovalReceiptBinding(operation, proof = {}) {
  const expected = createBrowserRemovalReceiptBinding(operation);
  const actual = proof.receiptBinding;
  const keys = ['version', 'operationId', 'nonce', 'ownerGenerationHash'];
  const valid = actual && typeof actual === 'object' && !Array.isArray(actual)
    && Object.keys(actual).length === keys.length
    && keys.every(key => typeof actual[key] === 'string')
    && timingSafeEqual(digest(JSON.stringify(keys.map(key => actual[key]))), digest(JSON.stringify(keys.map(key => expected[key]))));
  if (!valid) throw Object.assign(new Error('PURCHASE_BROWSER_ACCOUNT_REMOVAL_PROOF_BINDING_INVALID'), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_PROOF_BINDING_INVALID' });
  return true;
}

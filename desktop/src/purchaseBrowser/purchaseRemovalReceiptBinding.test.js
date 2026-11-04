import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PURCHASE_REMOVAL_RECEIPT_VERSION, validatePurchaseRemovalReceiptBinding } from './purchaseRemovalReceiptBinding.js';

const binding = { ownerType: 'purchase_account', accountId: 'fixture-account', accountIncarnation: '2026-09-05T00:00:00.000Z' };
const valid = {
  version: PURCHASE_REMOVAL_RECEIPT_VERSION,
  operationId: 'fixture-operation',
  nonce: 'fixture-server-nonce',
  ownerGenerationHash: createHash('sha256').update(`${binding.ownerType}\0${binding.accountId}\0${binding.accountIncarnation}`).digest('hex'),
};

test('receipt binding copies only the four server fields and matches exact owner generation', () => {
  const copied = validatePurchaseRemovalReceiptBinding({ ...valid, rendererField: 'ignored' }, { operationId: valid.operationId, binding });
  assert.deepEqual(copied, valid);
  assert.equal(Object.isFrozen(copied), true);
});

test('receipt binding rejects stale operation, nonce, type, account and incarnation', () => {
  for (const candidate of [null, { ...valid, version: 'legacy' }, { ...valid, operationId: 'different-operation' }, { ...valid, nonce: '' }, { ...valid, ownerGenerationHash: '' }, { ...valid, ownerGenerationHash: 'b'.repeat(64) }]) {
    assert.throws(() => validatePurchaseRemovalReceiptBinding(candidate, { operationId: valid.operationId, binding }), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_RECEIPT_BINDING_INVALID' });
  }
  for (const changed of [{ ...binding, ownerType: 'integration_profile' }, { ...binding, accountId: 'other' }, { ...binding, accountIncarnation: '2026-09-06T00:00:00.000Z' }]) {
    assert.throws(() => validatePurchaseRemovalReceiptBinding(valid, { operationId: valid.operationId, binding: changed }), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_RECEIPT_BINDING_INVALID' });
  }
});

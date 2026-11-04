import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserRemovalReceiptBinding, assertBrowserRemovalReceiptBinding } from './browserRemovalReceiptBinding.js';
const operation = (id, incarnation = 'inc-a', nonce = 'challenge-a') => ({ operationId: id, clientCleanupNonce: nonce,
  payload: { ownerIncarnation: incarnation, confirm: { owner: { ownerType: 'purchase_account', ownerId: 'same-id' } } } });

test('browser deletion receipt is bound to the operation, challenge and owner generation', () => {
  const source = operation('old');
  const proof = { receiptBinding: createBrowserRemovalReceiptBinding(source) };
  assert.equal(assertBrowserRemovalReceiptBinding(source, proof), true);
  for (const changed of [operation('new'), operation('old', 'inc-b'), operation('old', 'inc-a', 'challenge-b')]) {
    assert.throws(() => assertBrowserRemovalReceiptBinding(changed, proof), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_PROOF_BINDING_INVALID' });
  }
  assert.throws(() => assertBrowserRemovalReceiptBinding(source, {}), { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_PROOF_BINDING_INVALID' });
});

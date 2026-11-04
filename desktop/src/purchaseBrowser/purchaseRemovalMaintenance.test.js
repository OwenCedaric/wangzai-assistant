import assert from 'node:assert/strict';
import test from 'node:test';
import { createPurchaseRemovalMaintenance } from './purchaseRemovalMaintenance.js';

test('maintenance refuses forged verification and changed trusted scope', async () => {
  for (const run of [
    async (_operationId, update) => { update({ ownerRef: 'a'.repeat(40) }); return { verified: true, proof: { verified: true, ownerRef: 'b'.repeat(40) } }; },
    async (_operationId, update) => { update({ ownerRef: 'a'.repeat(40) }); update({ ownerRef: 'b'.repeat(40) }); },
    async () => ({ ok: true }),
  ]) {
    const maintenance = createPurchaseRemovalMaintenance({ run });
    await assert.rejects(maintenance.request('removal-a'));
  }
});

test('only genuinely settled failures can retry the same operation', async () => {
  let attempts = 0;
  const maintenance = createPurchaseRemovalMaintenance({ run: async (_operationId, update) => {
    attempts += 1;
    update({ ownerRef: 'a'.repeat(40) });
    if (attempts === 1) throw Object.assign(new Error('fixture receipt unavailable'), { code: 'ECONNRESET' });
    return { verified: true, proof: { verified: true, ownerRef: 'a'.repeat(40), receiptBinding: {
      version: 'purchase-browser-removal-receipt-v2', operationId: _operationId, nonce: 'fixture-nonce', ownerGenerationHash: 'a'.repeat(64),
    } } };
  } });
  await assert.rejects(maintenance.request('removal-a'), { code: 'ECONNRESET' });
  assert.equal((await maintenance.request('removal-a')).verified, true);
  assert.equal((await maintenance.request('removal-a')).verified, true);
  assert.equal(attempts, 2);
});

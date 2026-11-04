import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_COLLECTION_PRICING_EVIDENCE_PATH,
  verifyCollectionPricingEvidence,
} from './verify-collection-pricing-evidence.mjs';

test('release keeps at least 20 real input-bound server-signed collection pricing samples', () => {
  const evidence = verifyCollectionPricingEvidence(DEFAULT_COLLECTION_PRICING_EVIDENCE_PATH);
  assert.ok(evidence.sampleCount >= 20);
  assert.ok(evidence.productCount >= 3);
  assert.ok(evidence.uniqueInputCount >= 3);
  assert.equal(evidence.checks.allResponsesServerSigned, true);
  assert.equal(evidence.checks.allRowsInputBound, true);
  assert.equal(evidence.checks.allAmountsClosed, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  readEvidenceArtifact,
  verifyArtifact,
  verifyEvidenceBundle,
  verifyMigratedSnapshot,
  verifySourceSnapshot,
} from "../scripts/verify-real-sku-evidence.mjs";

test("real SKU evidence bundle is durable, redacted and fail-closed", () => {
  const result = verifyEvidenceBundle();
  assert.equal(result.failClosed, true);
  assert.equal(result.credentialsRetained, false);
  assert.ok(result.sourceProofBytes > 0 && result.sourceProofBytes < 2 * 1024 * 1024);
  assert.match(result.artifactSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.sourceProofSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.targetRowSha256, /^[a-f0-9]{64}$/u);
});

test("real SKU evidence classifies legacy commission zero sentinels as unavailable", () => {
  const result = verifyArtifact(readEvidenceArtifact());
  assert.deepEqual(result, {
    offerId: "mzr-20260520-638834907-9348",
    outcome: "OZON_EXPLICITLY_UNAVAILABLE",
    commissionModes: 4,
    coverageBalanced: true,
  });
});

test("durable redacted SQLite proof still proves the persisted SKU facts", async () => {
  const result = await verifySourceSnapshot(readEvidenceArtifact());
  assert.equal(result.quickCheck, "ok");
  assert.equal(result.targetRowVerified, true);
});

test("legacy proof migrates into the unique normalized DTO without guessing commission or stock", () => {
  const result = verifyMigratedSnapshot(readEvidenceArtifact());
  assert.equal(result.normalizedCommissionModes, 4);
  assert.equal(result.normalizedFacets, 10);
  assert.equal(result.canonicalDtoVerified, true);
  assert.equal(result.cacheClearVerified, true);
  assert.equal(result.shopDeleteVerified, true);
  assert.equal(result.sharedCatalogPreserved, true);
  assert.equal(result.tombstoneVerified, true);
  assert.equal(result.deletedRebindVerified, true);
  assert.equal(result.oldIncarnationRejected, true);
  assert.equal(result.rebindBootstrapDomains.length, 7);
  assert.equal(result.quickCheck, "ok");
});

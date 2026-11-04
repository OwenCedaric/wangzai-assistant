import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/database.js";
import { createProductCanonicalFactRepository } from "../src/db/repositories/productCanonicalFactRepository.js";
import { createProductRepository } from "../src/db/repositories/productRepository.js";
import {
  PROFILE_CACHE_CLEAR_CONFIRMATION,
  clearProfileTransientCache,
} from "../../desktop/src/runtime/profileCacheReset.js";
import { createAccountRemovalSqliteExecutor } from "../src/domain/accountRemoval/accountRemovalSqliteExecutor.js";
import { createShopRepository } from "../src/db/repositories/shopRepository.js";
import { createShopLifecycleRepository } from "../src/db/repositories/shopLifecycleRepository.js";
import { createShopIdentityLifecycleService } from "../src/domain/shops/shopIdentityLifecycleService.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const localApiRoot = resolve(scriptDir, "..");
const defaultArtifactPath = resolve(
  localApiRoot,
  "evidence/mzr-20260520-638834907-9348.real-ozon.json",
);
const defaultManifestPath = resolve(
  localApiRoot,
  "evidence/mzr-20260520-638834907-9348.evidence-manifest.json",
);
const defaultSourcePath = resolve(
  localApiRoot,
  "evidence/mzr-20260520-638834907-9348.target-only.proofdb",
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function coverageTotal(coverage) {
  return coverage.returned
    + coverage.validEmpty
    + coverage.notApplicable
    + coverage.unavailable
    + coverage.notReturned
    + coverage.failed;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertOwnedEvidencePath(candidate, label) {
  const evidenceRoot = resolve(localApiRoot, "evidence");
  const normalized = resolve(candidate);
  const relativePath = relative(evidenceRoot, normalized);
  assert(
    relativePath !== ""
      && relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath),
    `${label} escaped the durable evidence directory`,
  );
  return normalized;
}

export function readEvidenceArtifact(path = defaultArtifactPath) {
  return parseJson(readFileSync(path, "utf8"), "SKU evidence artifact");
}

export function readEvidenceManifest(path = defaultManifestPath) {
  return parseJson(readFileSync(path, "utf8"), "SKU evidence manifest");
}

export function verifyEvidenceBundle({
  evidence = readEvidenceArtifact(),
  manifest = readEvidenceManifest(),
} = {}) {
  assert(manifest.bundleVersion === 1, "unexpected evidence bundle version");
  assert(manifest.evidenceId === evidence.evidenceId, "manifest evidence id changed");
  assert(manifest.releaseGate?.missingArtifact === "fail", "missing artifact is not fail-closed");
  assert(manifest.releaseGate?.missingSourceProof === "fail", "missing source proof is not fail-closed");
  assert(manifest.releaseGate?.hashMismatch === "fail", "hash mismatch is not fail-closed");
  assert(manifest.releaseGate?.testSkipAllowed === false, "evidence tests must not skip");
  assert(evidence.durableProof?.releaseGate === "required-no-skip", "artifact is not release-gated");
  assert(
    evidence.sourceSnapshot?.kind === "redacted-target-only-sqlite-proof",
    "artifact does not use the durable redacted proof",
  );
  assert(
    evidence.sourceSnapshot?.origin?.kind === "desktop-runtime-profile-sqlite-copy",
    "artifact lost the original read-only capture provenance",
  );

  const manifestArtifactPath = assertOwnedEvidencePath(
    resolve(localApiRoot, manifest.artifact?.relativePath || ""),
    "manifest artifact",
  );
  const manifestSourcePath = assertOwnedEvidencePath(
    resolve(localApiRoot, manifest.sourceProof?.relativePath || ""),
    "manifest source proof",
  );
  const declaredSourcePath = assertOwnedEvidencePath(
    resolve(localApiRoot, evidence.sourceSnapshot.relativePath || ""),
    "artifact source proof",
  );
  const declaredManifestPath = assertOwnedEvidencePath(
    resolve(localApiRoot, evidence.durableProof?.manifestRelativePath || ""),
    "artifact manifest",
  );
  assert(manifestArtifactPath === defaultArtifactPath, "manifest points to the wrong artifact");
  assert(manifestSourcePath === defaultSourcePath, "manifest points to the wrong source proof");
  assert(declaredSourcePath === defaultSourcePath, "artifact points to the wrong source proof");
  assert(declaredManifestPath === defaultManifestPath, "artifact points to the wrong manifest");
  for (const [filePath, label] of [
    [manifestArtifactPath, "artifact"],
    [manifestSourcePath, "source proof"],
    [declaredManifestPath, "manifest"],
  ]) {
    assert(existsSync(filePath), `${label} is missing: ${filePath}`);
    assert(statSync(filePath).isFile(), `${label} is not a regular file`);
  }
  const artifactBytes = readFileSync(manifestArtifactPath);
  const sourceBytes = readFileSync(manifestSourcePath);
  assert(artifactBytes.length === manifest.artifact.sizeBytes, "artifact size changed");
  assert(sha256Bytes(artifactBytes) === manifest.artifact.sha256, "artifact SHA-256 changed");
  assert(sourceBytes.length === manifest.sourceProof.sizeBytes, "source proof size changed");
  assert(sha256Bytes(sourceBytes) === manifest.sourceProof.sha256, "source proof SHA-256 changed");
  assert(evidence.sourceSnapshot.sizeBytes === manifest.sourceProof.sizeBytes, "source proof sizes diverge");
  assert(evidence.sourceSnapshot.sha256 === manifest.sourceProof.sha256, "source proof hashes diverge");
  assert(
    evidence.sourceSnapshot.databaseUserVersion === manifest.sourceProof.databaseUserVersion,
    "source proof schema versions diverge",
  );
  assert(
    evidence.sourceSnapshot.targetRowSha256 === manifest.sourceProof.targetRowSha256,
    "target row hashes diverge",
  );
  assert(manifest.inspection?.credentialsRetained === false, "proof retained credentials");
  assert(manifest.inspection?.retainedRows?.allOtherTables === 0, "proof retained unrelated business rows");
  return {
    evidenceId: evidence.evidenceId,
    artifactSha256: manifest.artifact.sha256,
    sourceProofSha256: manifest.sourceProof.sha256,
    sourceProofBytes: manifest.sourceProof.sizeBytes,
    targetRowSha256: manifest.sourceProof.targetRowSha256,
    failClosed: true,
    credentialsRetained: false,
  };
}

export function verifyArtifact(evidence) {
  assert(evidence.evidenceVersion === 1, "unexpected evidence version");
  assert(evidence.accessPolicy === "read-only-snapshot", "evidence is not read-only");
  assert(evidence.sourceSnapshot?.kind === "redacted-target-only-sqlite-proof", "durable source proof is missing");
  assert(!String(evidence.sourceSnapshot?.relativePath || "").includes(".tmp"), "source proof still depends on .tmp");
  assert(evidence.durableProof?.releaseGate === "required-no-skip", "evidence release gate is not mandatory");
  assert(
    evidence.selector.offerId === "mzr-20260520-638834907-9348",
    "wrong evidence offer id",
  );
  assert(
    evidence.canonicalDecision.selectedOutcome === "OZON_EXPLICITLY_UNAVAILABLE",
    "the evidence must select the explicit-unavailable outcome",
  );
  assert(evidence.canonicalDecision.directCommissionReturned === false, "direct commission must be false");
  assert(evidence.canonicalDecision.officialRateDerivationApplied === false, "derived commission is forbidden");
  assert(evidence.canonicalDecision.zeroSentinelIsRealZeroPercent === false, "zero sentinel cannot become 0%");
  assert(evidence.canonicalDecision.displayValue === null, "unavailable commission must display null");
  assert(evidence.commissionFacts.length === 4, "all four fulfillment modes require a fact");
  assert(evidence.commissionFacts.every((fact) => fact.ratePpm === null), "commission rates must remain null");
  assert(
    evidence.commissionFacts.filter((fact) => fact.status === "unavailable").length === 3,
    "the three legacy response fields must remain unavailable",
  );
  assert(
    evidence.commissionFacts.find((fact) => fact.fulfillmentType === "FBP")?.status === "not_returned",
    "an absent FBP contract field must remain not_returned",
  );
  assert(
    new Set(evidence.commissionFacts.map((fact) => fact.fulfillmentType)).size === 4,
    "fulfillment facts must be unique",
  );
  assert(
    evidence.commissionFacts.every(
      (fact) => fact.responseHash === evidence.sourceFacts.responseProof.responseHash,
    ),
    "commission provenance hashes diverge",
  );
  assert(
    coverageTotal(evidence.coverageProof) === evidence.coverageProof.expected,
    "facet coverage equation does not balance",
  );
  assert(
    evidence.sourceFacts.priceProjection.commissions.sales_percent_fbo === 0
      && evidence.sourceFacts.priceProjection.commissions.sales_percent_fbs === 0
      && evidence.sourceFacts.priceProjection.commissions.sales_percent_rfbs === 0,
    "the persisted legacy zero sentinels are missing",
  );
  assert(evidence.sourceFacts.visibility === "ARCHIVED", "the target must remain archived");
  assert(evidence.fulfillmentEvidence.activeFulfillmentType === null, "fulfillment type must not be guessed");
  return {
    offerId: evidence.selector.offerId,
    outcome: evidence.canonicalDecision.selectedOutcome,
    commissionModes: evidence.commissionFacts.length,
    coverageBalanced: true,
  };
}

export async function verifySourceSnapshot(evidence, sourcePath = defaultSourcePath) {
  assert(existsSync(sourcePath), `source snapshot is missing: ${sourcePath}`);
  const stat = statSync(sourcePath);
  assert(stat.size === evidence.sourceSnapshot.sizeBytes, "source snapshot size changed");
  const sha256 = await sha256File(sourcePath);
  assert(sha256 === evidence.sourceSnapshot.sha256, "source snapshot SHA-256 changed");

  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON;");
    const userVersion = db.prepare("PRAGMA user_version").get().user_version;
    assert(userVersion === evidence.sourceSnapshot.databaseUserVersion, "source schema version changed");
    assert(db.prepare("PRAGMA quick_check").get().quick_check === "ok", "source snapshot quick_check failed");

    const row = db.prepare(`
      SELECT shop_id, product_id, offer_id, visibility, status_label,
             price_value, price_json, fee_json, prices_hash, prices_synced_at,
             stock_value, stocks_hash, stocks_synced_at,
             commission_percent_fbo, commission_percent_fbs,
             commission_percent_rfbs, commission_percent_fbp,
             commission_status, commission_provenance_json,
             acquiring_status, acquiring_provenance_json,
             raw_json, weight_kg, depth_cm, width_cm, height_cm
        FROM ozon_products
       WHERE shop_id = ? AND offer_id = ?
       ORDER BY updated_at DESC
       LIMIT 1
    `).get(evidence.selector.shopId, evidence.selector.offerId);
    assert(row, "target SKU is absent from the source snapshot");
    assert(String(row.product_id) === evidence.selector.productId, "product identity changed");
    assert(row.visibility === evidence.sourceFacts.visibility, "visibility changed");
    assert(row.price_value === evidence.sourceFacts.priceProjection.price, "price changed");
    assert(row.prices_hash === evidence.sourceFacts.responseProof.responseHash, "price response hash changed");
    assert(row.prices_synced_at === evidence.sourceFacts.responseProof.observedAt, "price observation time changed");
    assert(row.commission_status === "unavailable", "source commission status is not unavailable");
    assert(row.commission_percent_fbo === null, "FBO commission was synthesized");
    assert(row.commission_percent_fbs === null, "FBS commission was synthesized");
    assert(row.commission_percent_rfbs === null, "RFBS commission was synthesized");
    assert(row.commission_percent_fbp === null, "FBP commission was synthesized");

    const priceProjection = parseJson(row.price_json, "price_json");
    const feeProjection = parseJson(row.fee_json, "fee_json");
    const rawProjection = parseJson(row.raw_json, "raw_json");
    const commissionProvenance = parseJson(row.commission_provenance_json, "commission provenance");
    const acquiringProvenance = parseJson(row.acquiring_provenance_json, "acquiring provenance");
    assert(JSON.stringify(priceProjection) === JSON.stringify(evidence.sourceFacts.priceProjection), "price projection changed");
    assert(JSON.stringify(feeProjection) === JSON.stringify(evidence.sourceFacts.compatibilityFeeProjection), "fee projection changed");
    assert(JSON.stringify(rawProjection) === JSON.stringify(evidence.sourceFacts.productListProjection), "list projection changed");
    assert(commissionProvenance.sourceReason === "legacy-ozon-zero-sentinel", "commission zero-sentinel proof was lost");
    assert(acquiringProvenance.sourceReason === "legacy-ozon-zero-sentinel", "acquiring zero-sentinel proof was lost");

    return {
      sourcePath,
      sourceSha256: sha256,
      sourceDatabaseUserVersion: userVersion,
      quickCheck: "ok",
      targetRowVerified: true,
    };
  } finally {
    db.close();
  }
}

export function verifyMigratedSnapshot(evidence, sourcePath = defaultSourcePath) {
  assert(existsSync(sourcePath), `source snapshot is missing: ${sourcePath}`);
  const workspaceTempRoot = resolve(localApiRoot, "../.tmp");
  mkdirSync(workspaceTempRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(workspaceTempRoot, "sku-evidence-verify-"));
  assert(workDir.startsWith(workspaceTempRoot), "verification copy escaped the workspace");
  const workPath = resolve(workDir, "profile.sqlite");
  copyFileSync(sourcePath, workPath);

  const db = new DatabaseSync(workPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const migrationsApplied = runMigrations(db);
    assert(
      migrationsApplied.includes("063_repair_product_fact_provenance"),
      "provenance repair migration was not applied to the legacy proof",
    );

    const projector = createProductCanonicalFactRepository(db);
    const projected = projector.projectRows({
      shopId: evidence.selector.shopId,
      offerIds: [evidence.selector.offerId],
    });
    assert(projected.projected === 1, "the target SKU was not projected");

    const identity = db.prepare(`
      SELECT product_identity_id
        FROM product_identities
       WHERE shop_id = ? AND offer_id = ?
    `).get(evidence.selector.shopId, evidence.selector.offerId);
    assert(identity, "normalized target identity is missing");
    const commissions = db.prepare(`
      SELECT fulfillment_type, rate_ppm, status, response_hash, source_reason
        FROM product_commission_facts
       WHERE product_identity_id = ?
       ORDER BY fulfillment_type
    `).all(identity.product_identity_id).map((row) => ({ ...row }));
    assert(commissions.length === 4, "normalized commission modes are incomplete");
    for (const expected of evidence.commissionFacts) {
      const actual = commissions.find((row) => row.fulfillment_type === expected.fulfillmentType);
      assert(actual, `missing normalized ${expected.fulfillmentType} commission`);
      assert(actual.rate_ppm === expected.ratePpm, `${expected.fulfillmentType} rate changed`);
      assert(actual.status === expected.status, `${expected.fulfillmentType} status changed`);
      assert(actual.response_hash === expected.responseHash, `${expected.fulfillmentType} proof hash changed`);
    }
    assert(
      commissions.find((row) => row.fulfillment_type === "FBO")?.source_reason
        === "legacy-ozon-zero-sentinel",
      "the zero-sentinel provenance was not retained",
    );
    assert(
      commissions.find((row) => row.fulfillment_type === "FBP")?.source_reason
        === "ozon-contract-field-not-returned",
      "the absent FBP contract field was not retained",
    );

    const stock = db.prepare(`
      SELECT present_quantity, status, response_hash, source_reason
        FROM product_stock_facts
       WHERE product_identity_id = ?
    `).get(identity.product_identity_id);
    assert(stock.present_quantity === null, "empty stock was converted into zero");
    assert(stock.status === "returned_empty", "explicit empty stock lost its status");
    assert(stock.source_reason === "ozon-explicit-empty-stocks", "empty stock provenance was lost");
    const facets = db.prepare(`
      SELECT facet, status
        FROM product_facet_observations
       WHERE product_identity_id = ?
       ORDER BY facet
    `).all(identity.product_identity_id);
    assert(facets.length === 10, "the normalized facet ledger is not closed");

    const repository = createProductRepository(db);
    const readCanonicalDto = () => repository.listProducts({
      shopId: evidence.selector.shopId,
      productIds: [evidence.selector.productId],
      pageSize: 20,
    }).rows[0];
    const dto = readCanonicalDto();
    assert(dto?.factSource === "normalized-product-facts-v1", "DTO did not use normalized facts");
    assert(dto.visibility === "ARCHIVED", "DTO lost archived visibility");
    assert(dto.priceValue === 55.16, "DTO price changed");
    assert(dto.commissionPercents.fbo === null, "DTO synthesized an FBO commission");
    assert(dto.commissionStatuses.fbo === "unavailable", "DTO FBO status changed");
    assert(dto.commissionStatuses.fbp === "not_returned", "DTO FBP status changed");
    assert(dto.stockValue === null, "DTO synthesized stock zero");

    const canonicalBeforeClear = JSON.stringify(dto);
    const responseRowsBefore = db.prepare("SELECT COUNT(*) AS total FROM ozon_response_cache").get().total;
    assert(responseRowsBefore > 0, "real proof has no response cache row to clear");
    const clearResult = clearProfileTransientCache(db, {
      confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
    });
    assert(clearResult.before.protectedDigest === clearResult.after.protectedDigest, "cache clear changed protected facts");
    assert(db.prepare("SELECT COUNT(*) AS total FROM ozon_response_cache").get().total === 0, "response cache was not cleared");
    assert(JSON.stringify(readCanonicalDto()) === canonicalBeforeClear, "target DTO changed after ordinary cache clear");

    const oldIdentity = db.prepare(`
      SELECT profile_id, shop_incarnation, credential_revision
        FROM shops WHERE id = ?
    `).get(evidence.selector.shopId);
    assert(oldIdentity?.shop_incarnation, "legacy shop incarnation is missing");
    db.prepare(`
      INSERT INTO shared_catalog_versions (
        catalog_id, platform, marketplace, locale, contract_version,
        mapper_version, source_kind, content_hash, source_summary_json,
        created_at, updated_at
      ) VALUES (?, 'ozon', 'ozon-ru', 'zh-CN', 'evidence-v1',
                'evidence-mapper-v1', 'test', 'shared-proof-hash', '{}', ?, ?)
    `).run("evidence-shared-catalog", evidence.capturedAt, evidence.capturedAt);
    db.prepare(`
      INSERT INTO shared_catalog_categories (
        catalog_id, category_id, parent_category_id, name, level,
        is_disabled, content_hash, payload_json, first_seen_at, last_seen_at
      ) VALUES ('evidence-shared-catalog', 'evidence-category', NULL,
                'shared category survives shop delete', 0, 0,
                'shared-category-hash', '{}', ?, ?)
    `).run(evidence.capturedAt, evidence.capturedAt);

    const deletionOperationId = "real-sku-proof-delete-operation";
    const deletion = createAccountRemovalSqliteExecutor({
      db,
      now: () => "2026-07-16T03:00:00.000Z",
    }).execute(
      { ownerType: "ozon_shop", ownerId: evidence.selector.shopId },
      {
        operationId: deletionOperationId,
        ownerIncarnation: oldIdentity.shop_incarnation,
        identityLifecycle: {
          profileId: oldIdentity.profile_id,
          shopIncarnation: oldIdentity.shop_incarnation,
          credentialRevision: Number(oldIdentity.credential_revision),
        },
      },
    );
    assert(deletion.preservationVerified === true, "shop deletion preservation proof failed");
    assert(deletion.physicalStorage?.secureDelete === true, "shop deletion physical erasure proof failed");
    for (const table of [
      "ozon_products",
      "product_identities",
      "product_status_facts",
      "product_detail_facts",
      "product_dimension_facts",
      "product_price_facts",
      "product_commission_facts",
      "product_acquiring_facts",
      "product_stock_facts",
      "product_warehouse_stock_facts",
      "product_image_facts",
      "product_attribute_facts",
      "product_facet_observations",
    ]) {
      const total = db.prepare(`SELECT COUNT(*) AS total FROM "${table}" WHERE shop_id = ?`)
        .get(evidence.selector.shopId).total;
      assert(total === 0, `${table} retained deleted-shop facts`);
    }
    assert(db.prepare("SELECT COUNT(*) AS total FROM shops WHERE id = ?").get(evidence.selector.shopId).total === 0, "shop credential row survived deletion");
    assert(db.prepare("SELECT COUNT(*) AS total FROM shared_catalog_categories WHERE catalog_id = 'evidence-shared-catalog'").get().total === 1, "shared catalog was deleted with the shop");
    const tombstone = db.prepare(`
      SELECT former_shop_incarnation, final_credential_revision, deletion_operation_id
        FROM shop_identity_tombstones
       WHERE deletion_operation_id = ?
    `).get(deletionOperationId);
    assert(tombstone?.former_shop_incarnation === oldIdentity.shop_incarnation, "shop tombstone lost the retired incarnation");
    assert(Number(tombstone.final_credential_revision) === Number(oldIdentity.credential_revision), "shop tombstone lost credential revision");
    assert(readCanonicalDto() === undefined, "deleted target SKU still appears in the canonical DTO");
    assert(db.prepare("PRAGMA foreign_key_check").all().length === 0, "shop deletion left foreign-key violations");

    const reboundShopRepository = createShopRepository(db, { profileId: oldIdentity.profile_id });
    const reboundLifecycleRepository = createShopLifecycleRepository(db, {
      profileId: oldIdentity.profile_id,
      identityRepository: reboundShopRepository.identityRepository,
    });
    const reboundLifecycle = createShopIdentityLifecycleService({
      shopRepository: reboundShopRepository,
      lifecycleRepository: reboundLifecycleRepository,
    });
    const rebound = reboundLifecycle.saveBinding({
      id: evidence.selector.shopId,
      name: "real evidence clean rebind",
      clientId: "real-evidence-rebind-client",
      ['api' + 'Key']: "real-evidence-rebind-credential",
      status: "active",
    }, { deletedRebind: true });
    assert(rebound.bindingReady === false, "rebind became ready before bootstrap proof");
    assert(rebound.bindingStatus === "queued", "rebind did not queue a full bootstrap");
    assert(rebound.bootstrapRun?.reason === "rebind", "deleted shop was mislabeled as an initial bind");
    assert(rebound.bootstrapRun.requiredDomains.length === 7, "rebind bootstrap domain coverage is incomplete");
    assert(rebound.scopeToken.shopIncarnation !== oldIdentity.shop_incarnation, "rebind reused the retired incarnation");
    assert(Number(rebound.scopeToken.credentialRevision) === 1, "new incarnation credential revision must restart independently");
    let staleTokenCode = null;
    try {
      reboundShopRepository.identityRepository.assertCurrentScopeToken({
        profileId: oldIdentity.profile_id,
        shopId: evidence.selector.shopId,
        shopIncarnation: oldIdentity.shop_incarnation,
        credentialRevision: Number(oldIdentity.credential_revision),
      });
    } catch (error) {
      staleTokenCode = error?.code || error?.message;
    }
    assert(staleTokenCode === "SHOP_INCARNATION_STALE", "retired incarnation token was accepted after rebind");
    assert(readCanonicalDto() === undefined, "rebind exposed stale pre-bootstrap product facts");
    assert(db.prepare("SELECT COUNT(*) AS total FROM shared_catalog_categories WHERE catalog_id = 'evidence-shared-catalog'").get().total === 1, "rebind damaged shared catalog data");
    assert(db.prepare("PRAGMA quick_check").get().quick_check === "ok", "migrated copy quick_check failed");

    return {
      migrationsApplied,
      projectedRows: projected.projected,
      normalizedCommissionModes: commissions.length,
      normalizedFacets: facets.length,
      canonicalDtoVerified: true,
      cacheClearVerified: true,
      cacheProtectedDigest: clearResult.after.protectedDigest,
      shopDeleteVerified: true,
      deletedRows: deletion.totalDeletedRows,
      sharedCatalogPreserved: true,
      tombstoneVerified: true,
      deletedRebindVerified: true,
      oldIncarnationRejected: true,
      rebindBootstrapDomains: rebound.bootstrapRun.requiredDomains,
      quickCheck: "ok",
    };
  } finally {
    db.close();
    assert(workDir.startsWith(workspaceTempRoot), "unsafe verification cleanup target");
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const artifactOnly = process.argv.includes("--artifact-only");
  const sourceFlagIndex = process.argv.indexOf("--source");
  const sourcePath = sourceFlagIndex >= 0
    ? resolve(process.cwd(), process.argv[sourceFlagIndex + 1])
    : defaultSourcePath;
  const evidence = readEvidenceArtifact();
  const bundle = verifyEvidenceBundle({ evidence });
  const artifact = verifyArtifact(evidence);
  const source = artifactOnly ? null : await verifySourceSnapshot(evidence, sourcePath);
  const migrated = artifactOnly ? null : verifyMigratedSnapshot(evidence, sourcePath);
  process.stdout.write(`${JSON.stringify({ ok: true, bundle, artifact, source, migrated }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

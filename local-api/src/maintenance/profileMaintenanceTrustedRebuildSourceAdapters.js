import { createStableHash, stableStringify } from '../utils/stableHash.js';
import { PROFILE_DOMAIN_REBUILD_PROOF_VERSION } from './profileMaintenanceCommandService.js';

export const PROFILE_MAINTENANCE_TRUSTED_REBUILD_SOURCE_ADAPTERS_VERSION =
  'profile-maintenance-trusted-rebuild-source-adapters-v1';

const PRODUCT_IMAGE_HEALTH_DOMAIN = 'product-image-health';
const PRODUCT_IMAGE_HEALTH_ADAPTER_ID =
  'local-api.product-image-health.canonical-product-facts-v1';

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function nullableText(value) {
  return normalizeText(value) || null;
}

function productKeyFromIdentity(row) {
  const productId = normalizeText(row.product_id);
  if (productId) return `product:${productId}`;
  const offerId = normalizeText(row.offer_id);
  if (offerId) return `offer:${offerId}`;
  const sku = normalizeText(row.sku);
  if (sku) return `sku:${sku}`;
  return `identity:${normalizeText(row.product_identity_id)}`;
}

function imageHealthId({ shopId, productKey, imageUrl }) {
  return `image:${shopId}:${createStableHash(`${productKey}:${imageUrl}`, { length: 24 })}`;
}

function projectRequiredColumns(row, requiredColumns) {
  return Object.fromEntries(requiredColumns.map((column) => {
    if (!Object.hasOwn(row, column)) {
      throw new Error(`PROFILE_MAINTENANCE_PRODUCT_IMAGE_HEALTH_SCHEMA_UNSUPPORTED:${column}`);
    }
    return [column, row[column]];
  }));
}

function readCanonicalProductImageFacts(db) {
  return db.prepare(`
    SELECT
      image.product_identity_id,
      image.shop_id,
      image.image_index,
      image.image_url,
      image.is_primary,
      image.operation_id,
      image.contract_version,
      image.mapper_version,
      image.response_hash,
      image.run_id,
      image.snapshot_id,
      image.observed_at,
      image.row_hash,
      image.updated_at,
      identity.product_id,
      identity.offer_id,
      identity.sku,
      identity.row_hash AS identity_row_hash,
      identity.created_at AS identity_created_at
    FROM product_image_facts AS image
    INNER JOIN product_identities AS identity
      ON identity.product_identity_id = image.product_identity_id
     AND identity.shop_id = image.shop_id
    WHERE TRIM(image.shop_id) <> ''
      AND TRIM(image.image_url) <> ''
      AND TRIM(image.row_hash) <> ''
      AND TRIM(image.mapper_version) <> ''
      AND TRIM(identity.row_hash) <> ''
    ORDER BY
      image.shop_id ASC,
      image.image_url ASC,
      image.observed_at DESC,
      image.is_primary DESC,
      image.image_index ASC,
      image.product_identity_id ASC
  `).all();
}

function createProductImageHealthAdapter({ db, now }) {
  return Object.freeze({
    adapterId: PRODUCT_IMAGE_HEALTH_ADAPTER_ID,
    source: 'derived',
    readVerifiedCandidate({ requiredColumns }) {
      const sourceRows = readCanonicalProductImageFacts(db);
      const latestByShopAndUrl = new Map();
      for (const sourceRow of sourceRows) {
        const key = `${sourceRow.shop_id}\u0000${sourceRow.image_url}`;
        if (!latestByShopAndUrl.has(key)) latestByShopAndUrl.set(key, sourceRow);
      }

      const rows = [...latestByShopAndUrl.values()].map((sourceRow) => {
        const shopId = normalizeText(sourceRow.shop_id);
        const productKey = productKeyFromIdentity(sourceRow);
        const imageUrl = normalizeText(sourceRow.image_url);
        const rebuiltAt = normalizeText(sourceRow.updated_at)
          || normalizeText(sourceRow.observed_at)
          || new Date(now()).toISOString();
        const fullRow = {
          id: imageHealthId({ shopId, productKey, imageUrl }),
          shop_id: shopId,
          product_key: productKey || null,
          product_id: nullableText(sourceRow.product_id),
          offer_id: nullableText(sourceRow.offer_id),
          image_url: imageUrl,
          status: 'unknown',
          http_status: null,
          source: 'canonical-product-image-facts',
          checked_at: null,
          raw_json: stableStringify({
            contractVersion: sourceRow.contract_version || null,
            mapperVersion: sourceRow.mapper_version,
            observedAt: sourceRow.observed_at,
            productIdentityId: sourceRow.product_identity_id,
            rebuildSource: 'product_image_facts',
            responseHash: sourceRow.response_hash || null,
            rowHash: sourceRow.row_hash,
            runId: sourceRow.run_id || null,
            snapshotId: sourceRow.snapshot_id || null,
          }),
          created_at: normalizeText(sourceRow.identity_created_at) || rebuiltAt,
          updated_at: rebuiltAt,
        };
        return projectRequiredColumns(fullRow, requiredColumns);
      });

      const latestObservedAt = sourceRows.reduce(
        (latest, row) => String(row.observed_at || '').localeCompare(latest) > 0
          ? String(row.observed_at)
          : latest,
        '',
      );
      const sourceDigest = createStableHash(sourceRows.map((row) => ({
        identityRowHash: row.identity_row_hash,
        imageIndex: row.image_index,
        imageUrl: row.image_url,
        observedAt: row.observed_at,
        productIdentityId: row.product_identity_id,
        rowHash: row.row_hash,
        shopId: row.shop_id,
      })), { length: 40 });

      return Object.freeze({
        rows,
        evidence: Object.freeze({
          contractVersion: PROFILE_DOMAIN_REBUILD_PROOF_VERSION,
          domain: PRODUCT_IMAGE_HEALTH_DOMAIN,
          source: 'derived',
          proofId: `canonical-product-images:${sourceDigest}`,
          observedAt: latestObservedAt || new Date(now()).toISOString(),
          verificationKind: 'internal-source-adapter',
        }),
      });
    },
  });
}

/**
 * Production adapters intentionally read only existing canonical facts.  They
 * do not accept renderer rows/proofs and do not create a second persisted
 * source of truth.
 */
export function createProfileMaintenanceTrustedRebuildSourceAdapters({
  db,
  now = () => Date.now(),
} = {}) {
  if (!db?.prepare) throw new Error('PROFILE_MAINTENANCE_TRUSTED_SOURCE_DATABASE_REQUIRED');
  return Object.freeze({
    [PRODUCT_IMAGE_HEALTH_DOMAIN]: createProductImageHealthAdapter({ db, now }),
  });
}

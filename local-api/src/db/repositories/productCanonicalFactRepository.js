import { createStableHash } from '../../utils/stableHash.js';

const FACET_STATUSES = new Set([
  'pending',
  'returned',
  'returned_empty',
  'not_applicable',
  'unavailable',
  'not_returned',
  'failed',
  'contract_invalid',
  'stale_previous',
]);
const FULFILLMENT_COLUMNS = Object.freeze({
  FBO: 'commission_percent_fbo',
  FBS: 'commission_percent_fbs',
  RFBS: 'commission_percent_rfbs',
  FBP: 'commission_percent_fbp',
});
const LEGACY_COMMISSION_KEYS = Object.freeze({
  FBO: 'sales_percent_fbo',
  FBS: 'sales_percent_fbs',
  RFBS: 'sales_percent_rfbs',
  FBP: 'sales_percent_fbp',
});

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toMinor(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.round(number * 100);
}

function percentToRatePpm(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 && number <= 100
    ? Math.round(number * 10_000)
    : null;
}

function toIntegerUnit(value, multiplier) {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : Math.round(number * multiplier);
}

function normalizeFacetStatus(value, fallback = 'pending') {
  const status = normalizeText(value).toLowerCase();
  return FACET_STATUSES.has(status) ? status : fallback;
}

function commissionModeStatus(rawValue, ratePpm, aggregateStatus) {
  if (ratePpm !== null) {
    return aggregateStatus === 'stale_previous' ? 'stale_previous' : 'returned';
  }
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return aggregateStatus === 'contract_invalid' ? 'contract_invalid' : 'not_returned';
  }
  const numeric = finiteNumber(rawValue);
  if (numeric === null || numeric < 0) return 'contract_invalid';
  if (numeric === 0) return 'unavailable';
  return normalizeFacetStatus(aggregateStatus, 'not_returned');
}

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))];
}

function facetProvenance(row, facet, fallback = {}) {
  const observations = parseJson(row.facet_observations_json, {});
  const observation = observations?.[facet] && typeof observations[facet] === 'object'
    ? observations[facet]
    : {};
  return {
    status: normalizeFacetStatus(observation.status, fallback.status || 'pending'),
    operationId: normalizeText(observation.operationId ?? observation.operation_id ?? fallback.operationId) || null,
    endpointKey: normalizeText(observation.endpointKey ?? observation.endpoint_key ?? fallback.endpointKey) || null,
    contractVersion: normalizeText(observation.contractVersion ?? observation.contract_version ?? fallback.contractVersion) || null,
    mapperVersion: normalizeText(observation.mapperVersion ?? observation.mapper_version ?? fallback.mapperVersion) || 'product-canonical-projector-v1',
    responseHash: normalizeText(observation.responseHash ?? observation.response_hash ?? fallback.responseHash) || null,
    runId: normalizeText(observation.runId ?? observation.run_id ?? fallback.runId) || null,
    snapshotId: normalizeText(observation.snapshotId ?? observation.snapshot_id ?? fallback.snapshotId) || null,
    expectedAt: normalizeText(observation.expectedAt ?? observation.expected_at ?? fallback.expectedAt) || null,
    observedAt: normalizeText(observation.observedAt ?? observation.observed_at ?? fallback.observedAt ?? row.updated_at) || row.updated_at,
    sourceReason: normalizeText(observation.sourceReason ?? observation.source_reason ?? fallback.sourceReason) || null,
  };
}

export function createProductCanonicalFactRepository(db) {
  if (!db) throw new Error('createProductCanonicalFactRepository requires db.');

  const upsertIdentity = db.prepare(`
    INSERT INTO product_identities (
      product_identity_id, shop_id, product_id, offer_id, sku, source,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, source_updated_at, row_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'ozon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id) DO UPDATE SET
      product_id = COALESCE(excluded.product_id, product_identities.product_id),
      offer_id = COALESCE(excluded.offer_id, product_identities.offer_id),
      sku = COALESCE(excluded.sku, product_identities.sku),
      operation_id = COALESCE(excluded.operation_id, product_identities.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_identities.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_identities.response_hash),
      run_id = COALESCE(excluded.run_id, product_identities.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_identities.snapshot_id),
      observed_at = excluded.observed_at,
      source_updated_at = COALESCE(excluded.source_updated_at, product_identities.source_updated_at),
      row_hash = excluded.row_hash,
      updated_at = excluded.updated_at
  `);
  const upsertStatus = db.prepare(`
    INSERT INTO product_status_facts (
      product_identity_id, shop_id, visibility, status_label, is_stale,
      snapshot_visibilities_json, operation_id, contract_version, mapper_version,
      response_hash, run_id, snapshot_id, observed_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id) DO UPDATE SET
      visibility = excluded.visibility, status_label = excluded.status_label,
      is_stale = excluded.is_stale,
      snapshot_visibilities_json = excluded.snapshot_visibilities_json,
      operation_id = COALESCE(excluded.operation_id, product_status_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_status_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_status_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_status_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_status_facts.snapshot_id),
      observed_at = excluded.observed_at, row_hash = excluded.row_hash,
      updated_at = excluded.updated_at
  `);
  const upsertDetail = db.prepare(`
    INSERT INTO product_detail_facts (
      product_identity_id, shop_id, name, category_id, category_name, type_id,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id) DO UPDATE SET
      name = CASE WHEN excluded.name IS NOT NULL AND excluded.name <> '' THEN excluded.name ELSE product_detail_facts.name END,
      category_id = COALESCE(excluded.category_id, product_detail_facts.category_id),
      category_name = COALESCE(excluded.category_name, product_detail_facts.category_name),
      type_id = COALESCE(excluded.type_id, product_detail_facts.type_id),
      operation_id = COALESCE(excluded.operation_id, product_detail_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_detail_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_detail_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_detail_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_detail_facts.snapshot_id),
      observed_at = excluded.observed_at, row_hash = excluded.row_hash,
      updated_at = excluded.updated_at
  `);
  const upsertDimension = db.prepare(`
    INSERT INTO product_dimension_facts (
      product_identity_id, shop_id, source_type, source_priority,
      weight_g, length_mm, width_mm, height_mm,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, row_hash, updated_at
    ) VALUES (?, ?, 'ozon', 10, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id, source_type) DO UPDATE SET
      weight_g = COALESCE(excluded.weight_g, product_dimension_facts.weight_g),
      length_mm = COALESCE(excluded.length_mm, product_dimension_facts.length_mm),
      width_mm = COALESCE(excluded.width_mm, product_dimension_facts.width_mm),
      height_mm = COALESCE(excluded.height_mm, product_dimension_facts.height_mm),
      operation_id = COALESCE(excluded.operation_id, product_dimension_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_dimension_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_dimension_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_dimension_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_dimension_facts.snapshot_id),
      observed_at = excluded.observed_at, row_hash = excluded.row_hash,
      updated_at = excluded.updated_at
  `);
  const upsertPrice = db.prepare(`
    INSERT INTO product_price_facts (
      product_identity_id, shop_id, price_type, amount_minor, currency_code,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, row_hash, updated_at
    ) VALUES (?, ?, 'seller', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id) DO UPDATE SET
      amount_minor = COALESCE(excluded.amount_minor, product_price_facts.amount_minor),
      currency_code = COALESCE(excluded.currency_code, product_price_facts.currency_code),
      operation_id = COALESCE(excluded.operation_id, product_price_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_price_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_price_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_price_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_price_facts.snapshot_id),
      observed_at = excluded.observed_at, row_hash = excluded.row_hash,
      updated_at = excluded.updated_at
  `);
  const upsertCommission = db.prepare(`
    INSERT INTO product_commission_facts (
      product_identity_id, shop_id, fulfillment_type, rate_ppm, status,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, source_reason, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id, fulfillment_type) DO UPDATE SET
      rate_ppm = COALESCE(excluded.rate_ppm, product_commission_facts.rate_ppm),
      status = CASE
        WHEN excluded.rate_ppm IS NULL AND product_commission_facts.rate_ppm IS NOT NULL
          THEN 'stale_previous'
        ELSE excluded.status
      END,
      operation_id = COALESCE(excluded.operation_id, product_commission_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_commission_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_commission_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_commission_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_commission_facts.snapshot_id),
      observed_at = excluded.observed_at,
      source_reason = excluded.source_reason,
      row_hash = excluded.row_hash, updated_at = excluded.updated_at
  `);
  const upsertAcquiring = db.prepare(`
    INSERT INTO product_acquiring_facts (
      product_identity_id, shop_id, fee_minor, currency_code, rate_ppm, status,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, source_reason, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id) DO UPDATE SET
      fee_minor = COALESCE(excluded.fee_minor, product_acquiring_facts.fee_minor),
      currency_code = COALESCE(excluded.currency_code, product_acquiring_facts.currency_code),
      rate_ppm = COALESCE(excluded.rate_ppm, product_acquiring_facts.rate_ppm),
      status = CASE
        WHEN excluded.fee_minor IS NULL AND excluded.rate_ppm IS NULL
             AND (product_acquiring_facts.fee_minor IS NOT NULL OR product_acquiring_facts.rate_ppm IS NOT NULL)
          THEN 'stale_previous'
        ELSE excluded.status
      END,
      operation_id = COALESCE(excluded.operation_id, product_acquiring_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_acquiring_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_acquiring_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_acquiring_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_acquiring_facts.snapshot_id),
      observed_at = excluded.observed_at, source_reason = excluded.source_reason,
      row_hash = excluded.row_hash, updated_at = excluded.updated_at
  `);
  const upsertStock = db.prepare(`
    INSERT INTO product_stock_facts (
      product_identity_id, shop_id, present_quantity, status,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, source_reason, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id) DO UPDATE SET
      present_quantity = CASE
        WHEN excluded.status = 'returned' THEN excluded.present_quantity
        ELSE COALESCE(product_stock_facts.present_quantity, excluded.present_quantity)
      END,
      status = CASE
        WHEN excluded.status <> 'returned' AND product_stock_facts.present_quantity IS NOT NULL
          THEN 'stale_previous'
        ELSE excluded.status
      END,
      operation_id = COALESCE(excluded.operation_id, product_stock_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_stock_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_stock_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_stock_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_stock_facts.snapshot_id),
      observed_at = excluded.observed_at, source_reason = excluded.source_reason,
      row_hash = excluded.row_hash, updated_at = excluded.updated_at
  `);
  const upsertWarehouseStock = db.prepare(`
    INSERT INTO product_warehouse_stock_facts (
      product_identity_id, shop_id, warehouse_key, warehouse_id, fulfillment_type,
      warehouse_name, sku, present_quantity, reserved_quantity, free_quantity,
      operation_id, contract_version,
      mapper_version, response_hash, run_id, snapshot_id, observed_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id, warehouse_key) DO UPDATE SET
      warehouse_id = excluded.warehouse_id,
      fulfillment_type = excluded.fulfillment_type,
      warehouse_name = excluded.warehouse_name,
      sku = excluded.sku,
      present_quantity = excluded.present_quantity,
      reserved_quantity = excluded.reserved_quantity,
      free_quantity = excluded.free_quantity,
      operation_id = COALESCE(excluded.operation_id, product_warehouse_stock_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_warehouse_stock_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_warehouse_stock_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_warehouse_stock_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_warehouse_stock_facts.snapshot_id),
      observed_at = excluded.observed_at, row_hash = excluded.row_hash, updated_at = excluded.updated_at
  `);
  const upsertImage = db.prepare(`
    INSERT INTO product_image_facts (
      product_identity_id, shop_id, image_index, image_url, is_primary,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id, image_index) DO UPDATE SET
      image_url = excluded.image_url, is_primary = excluded.is_primary,
      operation_id = COALESCE(excluded.operation_id, product_image_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_image_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_image_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_image_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_image_facts.snapshot_id),
      observed_at = excluded.observed_at, row_hash = excluded.row_hash, updated_at = excluded.updated_at
  `);
  const upsertAttributes = db.prepare(`
    INSERT INTO product_attribute_facts (
      product_identity_id, shop_id, attributes_json, operation_id,
      contract_version, mapper_version, response_hash, run_id, snapshot_id,
      observed_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id) DO UPDATE SET
      attributes_json = excluded.attributes_json,
      operation_id = COALESCE(excluded.operation_id, product_attribute_facts.operation_id),
      contract_version = COALESCE(excluded.contract_version, product_attribute_facts.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_attribute_facts.response_hash),
      run_id = COALESCE(excluded.run_id, product_attribute_facts.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_attribute_facts.snapshot_id),
      observed_at = excluded.observed_at, row_hash = excluded.row_hash, updated_at = excluded.updated_at
  `);
  const upsertFacet = db.prepare(`
    INSERT INTO product_facet_observations (
      product_identity_id, shop_id, facet, status, operation_id, endpoint_key,
      contract_version, mapper_version, response_hash, run_id, snapshot_id,
      expected_at, observed_at, source_reason, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_identity_id, facet) DO UPDATE SET
      status = excluded.status,
      operation_id = COALESCE(excluded.operation_id, product_facet_observations.operation_id),
      endpoint_key = COALESCE(excluded.endpoint_key, product_facet_observations.endpoint_key),
      contract_version = COALESCE(excluded.contract_version, product_facet_observations.contract_version),
      mapper_version = excluded.mapper_version,
      response_hash = COALESCE(excluded.response_hash, product_facet_observations.response_hash),
      run_id = COALESCE(excluded.run_id, product_facet_observations.run_id),
      snapshot_id = COALESCE(excluded.snapshot_id, product_facet_observations.snapshot_id),
      expected_at = COALESCE(excluded.expected_at, product_facet_observations.expected_at),
      observed_at = excluded.observed_at, source_reason = excluded.source_reason,
      row_hash = excluded.row_hash, updated_at = excluded.updated_at
  `);
  const selectIdentityByProductId = db.prepare(`
    SELECT * FROM product_identities
     WHERE shop_id = ? AND product_id = ?
     LIMIT 1
  `);
  const selectIdentityByOfferId = db.prepare(`
    SELECT * FROM product_identities
     WHERE shop_id = ? AND offer_id = ?
     LIMIT 1
  `);
  const selectIdentityBySku = db.prepare(`
    SELECT * FROM product_identities
     WHERE shop_id = ? AND sku = ?
     LIMIT 1
  `);
  const selectWarehouseStocksByIdentity = db.prepare(`
    SELECT warehouse_key, warehouse_id, fulfillment_type, warehouse_name, sku,
           present_quantity, reserved_quantity, free_quantity
      FROM product_warehouse_stock_facts
     WHERE product_identity_id = ?
     ORDER BY warehouse_key
  `);
  const deleteWarehouseStocksByIdentity = db.prepare(`
    DELETE FROM product_warehouse_stock_facts
     WHERE product_identity_id = ?
  `);
  const deleteLegacyAggregateWarehouseStocksByIdentity = db.prepare(`
    DELETE FROM product_warehouse_stock_facts
     WHERE product_identity_id = ?
       AND (
         contract_version IS NULL
         OR lower(contract_version) NOT LIKE '%stocks-by-warehouse%'
       )
  `);
  const selectFacetObservationByIdentity = db.prepare(`
    SELECT * FROM product_facet_observations
     WHERE product_identity_id = ? AND facet = ?
     LIMIT 1
  `);

  function writeFacet(row, facet, provenance) {
    const hashPayload = { facet, ...provenance };
    const identityId = row.id ?? row.product_identity_id;
    const shopId = row.shop_id ?? row.shopId;
    const updatedAt = row.updated_at ?? row.updatedAt ?? provenance.observedAt;
    upsertFacet.run(
      identityId,
      shopId,
      facet,
      provenance.status,
      provenance.operationId,
      provenance.endpointKey,
      provenance.contractVersion,
      provenance.mapperVersion,
      provenance.responseHash,
      provenance.runId,
      provenance.snapshotId,
      provenance.expectedAt,
      provenance.observedAt,
      provenance.sourceReason,
      createStableHash(hashPayload),
      updatedAt,
    );
  }

  function resolveProductIdentity(shopId, set = {}) {
    const normalizedShopId = normalizeText(shopId);
    const productId = normalizeText(set.productId ?? set.product_id);
    const offerId = normalizeText(set.offerId ?? set.offer_id);
    const sku = normalizeText(set.sku ?? set.sku_id);
    if (productId) {
      const identity = selectIdentityByProductId.get(normalizedShopId, productId);
      if (identity) return identity;
    }
    if (offerId) {
      const identity = selectIdentityByOfferId.get(normalizedShopId, offerId);
      if (identity) return identity;
    }
    if (sku) return selectIdentityBySku.get(normalizedShopId, sku) || null;
    return null;
  }

  function comparableWarehouseRows(rows = []) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        warehouseKey: normalizeText(row.warehouseKey ?? row.warehouse_key),
        warehouseId: normalizeText(row.warehouseId ?? row.warehouse_id) || null,
        fulfillmentType:
          normalizeText(row.fulfillmentType ?? row.fulfillment_type).toUpperCase() || null,
        warehouseName:
          normalizeText(row.warehouseName ?? row.warehouse_name) || null,
        sku: normalizeText(row.sku) || null,
        presentQuantity: Math.max(0, Math.round(Number(row.presentQuantity ?? row.present_quantity))),
        reservedQuantity:
          row.reservedQuantity === null || row.reservedQuantity === undefined
            ? row.reserved_quantity === null || row.reserved_quantity === undefined
              ? null
              : Math.max(0, Math.round(Number(row.reserved_quantity)))
            : Math.max(0, Math.round(Number(row.reservedQuantity))),
        freeQuantity:
          row.freeQuantity === null || row.freeQuantity === undefined
            ? row.free_quantity === null || row.free_quantity === undefined
              ? null
              : Math.max(0, Math.round(Number(row.free_quantity)))
            : Math.max(0, Math.round(Number(row.freeQuantity))),
      }))
      .sort((left, right) => left.warehouseKey.localeCompare(right.warehouseKey));
  }

  /**
   * Replace the complete FBS/rFBS warehouse set returned for each product.
   *
   * The comprehensive products.stocks projection owns product_stock_facts;
   * this method owns only exact product+warehouse rows. Keeping those sources
   * independent prevents an aggregate FBS/FBO row from being counted again as
   * a warehouse and prevents a warehouse-detail response from overwriting the
   * comprehensive product total.
   */
  function replaceWarehouseStockSets({ shopId, sets = [], provenance = {} } = {}) {
    const normalizedShopId = normalizeText(shopId);
    if (!normalizedShopId) throw new Error('PRODUCT_CANONICAL_SHOP_ID_REQUIRED');
    const grouped = new Map();
    let missing = 0;
    let contractInvalid = 0;

    for (const sourceSet of Array.isArray(sets) ? sets : []) {
      const identity = resolveProductIdentity(normalizedShopId, sourceSet);
      if (!identity) {
        missing += 1;
        continue;
      }
      let target = grouped.get(identity.product_identity_id);
      if (!target) {
        target = {
          identity,
          stocks: new Map(),
          invalid: false,
          explicitEmpty: false,
        };
        grouped.set(identity.product_identity_id, target);
      }
      target.explicitEmpty ||= sourceSet.explicitEmpty === true;
      for (const sourceStock of Array.isArray(sourceSet.stocks) ? sourceSet.stocks : []) {
        const warehouseId = normalizeText(
          sourceStock.warehouseId ?? sourceStock.warehouse_id,
        );
        const presentQuantity = finiteNumber(
          sourceStock.presentQuantity ?? sourceStock.present_quantity,
        );
        const reservedValue = finiteNumber(
          sourceStock.reservedQuantity ?? sourceStock.reserved_quantity,
        );
        const freeValue = finiteNumber(
          sourceStock.freeQuantity ?? sourceStock.free_quantity ?? sourceStock.free_stock,
        );
        if (
          !warehouseId ||
          presentQuantity === null ||
          presentQuantity < 0 ||
          (reservedValue !== null && reservedValue < 0) ||
          (freeValue !== null && freeValue < 0)
        ) {
          target.invalid = true;
          continue;
        }
        const stock = {
          warehouseKey: warehouseId,
          warehouseId,
          fulfillmentType:
            normalizeText(
              sourceStock.fulfillmentType ?? sourceStock.fulfillment_type,
            ).toUpperCase() || 'SELLER',
          warehouseName:
            normalizeText(sourceStock.warehouseName ?? sourceStock.warehouse_name) || null,
          sku: normalizeText(sourceStock.sku ?? sourceSet.sku) || null,
          presentQuantity: Math.round(presentQuantity),
          reservedQuantity:
            reservedValue === null ? null : Math.max(0, Math.round(reservedValue)),
          freeQuantity:
            freeValue === null ? null : Math.max(0, Math.round(freeValue)),
        };
        const previous = target.stocks.get(warehouseId);
        if (previous && createStableHash(previous) !== createStableHash(stock)) {
          target.invalid = true;
          continue;
        }
        target.stocks.set(warehouseId, stock);
      }
    }

    const invalidTargets = [...grouped.values()].filter(
      (target) => target.invalid || (!target.explicitEmpty && target.stocks.size === 0),
    );
    if (invalidTargets.length > 0) {
      const error = new Error(
        `PRODUCT_WAREHOUSE_STOCK_CONTRACT_INVALID:${invalidTargets.length}`,
      );
      error.code = 'PRODUCT_WAREHOUSE_STOCK_CONTRACT_INVALID';
      error.contractInvalid = invalidTargets.length;
      throw error;
    }

    let changed = 0;
    let unchanged = 0;
    const productIdentityIds = [];
    const observedAt = normalizeText(provenance.observedAt) || new Date().toISOString();
    const mapperVersion =
      normalizeText(provenance.mapperVersion) || 'product-warehouse-stock-projector-v1';
    // The exact warehouse facts must always remain distinguishable from the
    // legacy aggregate rows once another primary product projection runs.
    const contractVersion =
      normalizeText(provenance.contractVersion) ||
      'ozon-products-stocks-by-warehouse-fbs-v2';
    for (const target of grouped.values()) {
      const identityId = target.identity.product_identity_id;
      const existing = comparableWarehouseRows(
        selectWarehouseStocksByIdentity.all(identityId),
      );
      const next = comparableWarehouseRows([...target.stocks.values()]);
      const setChanged = createStableHash(existing) !== createStableHash(next);
      deleteWarehouseStocksByIdentity.run(identityId);
      for (const warehouse of next) {
        const warehousePayload = {
          ...warehouse,
          responseHash: normalizeText(provenance.responseHash) || null,
        };
        upsertWarehouseStock.run(
          identityId,
          normalizedShopId,
          warehouse.warehouseKey,
          warehouse.warehouseId,
          warehouse.fulfillmentType,
          warehouse.warehouseName,
          warehouse.sku,
          warehouse.presentQuantity,
          warehouse.reservedQuantity,
          warehouse.freeQuantity,
          normalizeText(provenance.operationId) || null,
          contractVersion,
          mapperVersion,
          normalizeText(provenance.responseHash) || null,
          normalizeText(provenance.runId) || null,
          normalizeText(provenance.snapshotId) || null,
          observedAt,
          createStableHash(warehousePayload),
          observedAt,
        );
      }
      writeFacet(target.identity, 'warehouse_stocks', {
        status: next.length > 0 ? 'returned' : 'returned_empty',
        operationId: normalizeText(provenance.operationId) || null,
        endpointKey: 'products.stocksByWarehouseFbs',
        contractVersion,
        mapperVersion,
        responseHash: normalizeText(provenance.responseHash) || null,
        runId: normalizeText(provenance.runId) || null,
        snapshotId: normalizeText(provenance.snapshotId) || null,
        expectedAt: normalizeText(provenance.expectedAt) || null,
        observedAt,
        sourceReason:
          next.length > 0
            ? 'ozon-warehouse-stock-complete-set-returned'
            : 'ozon-warehouse-stock-explicit-empty-set',
      });
      productIdentityIds.push(identityId);
      if (setChanged) changed += 1;
      else unchanged += 1;
    }

    return {
      changed,
      unchanged,
      missing,
      contractInvalid,
      productIdentityIds,
    };
  }

  function recordWarehouseStockObservations({
    shopId,
    targets = [],
    status = 'not_returned',
    provenance = {},
    sourceReason,
  } = {}) {
    const normalizedShopId = normalizeText(shopId);
    if (!normalizedShopId) throw new Error('PRODUCT_CANONICAL_SHOP_ID_REQUIRED');
    const normalizedStatus = normalizeText(status).toLowerCase();
    if (![
      'pending', 'returned', 'returned_empty', 'not_applicable', 'unavailable',
      'not_returned', 'failed', 'contract_invalid', 'stale_previous',
    ].includes(normalizedStatus)) {
      throw new Error('PRODUCT_WAREHOUSE_STOCK_OBSERVATION_STATUS_INVALID');
    }
    const gapStatuses = new Set([
      'pending', 'unavailable', 'not_returned', 'failed', 'contract_invalid',
    ]);
    const observedAt = normalizeText(provenance.observedAt) || new Date().toISOString();
    const seen = new Set();
    let recorded = 0;
    let missing = 0;
    let retainedPrevious = 0;
    for (const target of Array.isArray(targets) ? targets : []) {
      const identity = resolveProductIdentity(normalizedShopId, target);
      const identityId = identity?.product_identity_id;
      if (!identityId || seen.has(identityId)) {
        if (!identityId) missing += 1;
        continue;
      }
      seen.add(identityId);
      const previous = selectFacetObservationByIdentity.get(
        identityId,
        'warehouse_stocks',
      );
      const hasPrevious =
        ['returned', 'returned_empty', 'stale_previous'].includes(previous?.status) ||
        selectWarehouseStocksByIdentity.all(identityId).length > 0;
      const resolvedStatus =
        hasPrevious && gapStatuses.has(normalizedStatus)
          ? 'stale_previous'
          : normalizedStatus;
      if (resolvedStatus === 'stale_previous') retainedPrevious += 1;
      writeFacet(identity, 'warehouse_stocks', {
        status: resolvedStatus,
        operationId: normalizeText(provenance.operationId) || null,
        endpointKey: 'products.stocksByWarehouseFbs',
        contractVersion:
          normalizeText(provenance.contractVersion) ||
          'ozon-products-stocks-by-warehouse-fbs-v2',
        mapperVersion:
          normalizeText(provenance.mapperVersion) ||
          'product-warehouse-stock-mapper-v1',
        responseHash: normalizeText(provenance.responseHash) || null,
        runId: normalizeText(provenance.runId) || null,
        snapshotId: normalizeText(provenance.snapshotId) || null,
        expectedAt: normalizeText(provenance.expectedAt) || null,
        observedAt,
        sourceReason: normalizeText(sourceReason) ||
          (resolvedStatus === 'stale_previous'
            ? `retained-previous:${normalizedStatus}`
            : `ozon-warehouse-stock:${normalizedStatus}`),
      });
      recorded += 1;
    }
    return { recorded, missing, retainedPrevious };
  }

  function projectRow(row) {
    const identityProvenance = facetProvenance(row, 'detail', {
      status: 'returned',
      endpointKey: row.source_endpoint_key || 'products.list',
      mapperVersion: 'product-identity-projector-v1',
      responseHash: row.remote_hash,
      observedAt: row.last_seen_at,
    });
    const identityHash = createStableHash({
      shopId: row.shop_id,
      productId: row.product_id,
      offerId: row.offer_id,
      sku: row.sku,
    });
    upsertIdentity.run(
      row.id, row.shop_id, row.product_id || null, row.offer_id || null, row.sku || null,
      identityProvenance.operationId, identityProvenance.contractVersion,
      identityProvenance.mapperVersion, identityProvenance.responseHash || row.remote_hash,
      identityProvenance.runId, identityProvenance.snapshotId,
      identityProvenance.observedAt, row.last_seen_at || null, identityHash,
      row.created_at, row.updated_at,
    );
    upsertStatus.run(
      row.id, row.shop_id, row.visibility, row.status_label || null, Number(row.is_stale) ? 1 : 0,
      JSON.stringify(parseJson(row.snapshot_visibilities_json, [])),
      identityProvenance.operationId, identityProvenance.contractVersion,
      'product-status-projector-v1', row.remote_hash,
      identityProvenance.runId, identityProvenance.snapshotId,
      identityProvenance.observedAt,
      createStableHash({ visibility: row.visibility, status: row.status_label, stale: row.is_stale }),
      row.updated_at,
    );
    writeFacet(row, 'identity', { ...identityProvenance, status: 'returned' });
    writeFacet(row, 'status', { ...identityProvenance, status: 'returned' });

    const detail = facetProvenance(row, 'detail', {
      status: row.detail_hash ? 'returned' : 'pending',
      endpointKey: 'products.infoList',
      mapperVersion: 'product-detail-projector-v1',
      responseHash: row.detail_hash,
      observedAt: row.detail_synced_at || row.updated_at,
    });
    upsertDetail.run(
      row.id, row.shop_id, row.name || null, row.category_id || null,
      row.category_name || null, row.type_id || null,
      detail.operationId, detail.contractVersion, detail.mapperVersion,
      detail.responseHash, detail.runId, detail.snapshotId, detail.observedAt,
      createStableHash({ name: row.name, categoryId: row.category_id, categoryName: row.category_name, typeId: row.type_id }),
      row.updated_at,
    );
    writeFacet(row, 'detail', detail);

    const dimensions = {
      weightG: toIntegerUnit(row.weight_kg, 1000),
      lengthMm: toIntegerUnit(row.depth_cm, 10),
      widthMm: toIntegerUnit(row.width_cm, 10),
      heightMm: toIntegerUnit(row.height_cm, 10),
    };
    if (Object.values(dimensions).some((value) => value !== null)) {
      const dimensionProvenance = facetProvenance(row, row.attributes_hash ? 'attributes' : 'detail', {
        status: 'returned', mapperVersion: 'product-dimension-projector-v1',
        responseHash: row.attributes_hash || row.detail_hash,
      });
      upsertDimension.run(
        row.id, row.shop_id, dimensions.weightG, dimensions.lengthMm,
        dimensions.widthMm, dimensions.heightMm,
        dimensionProvenance.operationId, dimensionProvenance.contractVersion,
        'product-dimension-projector-v1', dimensionProvenance.responseHash,
        dimensionProvenance.runId, dimensionProvenance.snapshotId,
        dimensionProvenance.observedAt, createStableHash(dimensions), row.updated_at,
      );
      writeFacet(row, 'dimensions', dimensionProvenance);
    }

    const priceHasEndpointProof = Boolean(
      normalizeText(row.prices_hash) || normalizeText(row.prices_synced_at),
    );
    const price = facetProvenance(row, 'prices', {
      // product.info can carry a convenient display price in the compatibility
      // row, but it must not complete the independent products.prices facet.
      // Only endpoint proof (or an explicit facet observation) may do that.
      status: priceHasEndpointProof && row.price_value !== null
        ? 'returned'
        : 'pending',
      endpointKey: 'products.prices', mapperVersion: 'product-price-projector-v1',
      responseHash: row.prices_hash, observedAt: row.prices_synced_at || row.updated_at,
    });
    upsertPrice.run(
      row.id, row.shop_id, toMinor(row.price_value), row.currency_code || null,
      price.operationId, price.contractVersion, price.mapperVersion,
      price.responseHash, price.runId, price.snapshotId, price.observedAt,
      createStableHash({ amountMinor: toMinor(row.price_value), currencyCode: row.currency_code }),
      row.updated_at,
    );
    writeFacet(row, 'prices', price);

    const commissionProvenance = parseJson(row.commission_provenance_json, {});
    const priceProjection = parseJson(row.price_json, {});
    const persistedCommissionModes = priceProjection?.commissions
      && typeof priceProjection.commissions === 'object'
      ? priceProjection.commissions
      : {};
    const commissionStatus = normalizeFacetStatus(row.commission_status, 'unavailable');
    for (const [fulfillmentType, column] of Object.entries(FULFILLMENT_COLUMNS)) {
      const ratePpm = percentToRatePpm(row[column]);
      const rawModeKey = fulfillmentType.toLowerCase();
      const rawModeValue = commissionProvenance.rawFulfillmentPercents?.[rawModeKey]
        ?? persistedCommissionModes[LEGACY_COMMISSION_KEYS[fulfillmentType]]
        ?? row[column];
      const effectiveStatus = commissionModeStatus(rawModeValue, ratePpm, commissionStatus);
      const observedAt = normalizeText(commissionProvenance.observedAt) || price.observedAt;
      const payload = { fulfillmentType, ratePpm, status: effectiveStatus };
      const sourceReason = rawModeValue === undefined || rawModeValue === null || rawModeValue === ''
        ? 'ozon-contract-field-not-returned'
        : normalizeText(commissionProvenance.sourceReason) || null;
      upsertCommission.run(
        row.id, row.shop_id, fulfillmentType, ratePpm, effectiveStatus,
        normalizeText(commissionProvenance.operationId) || price.operationId,
        normalizeText(commissionProvenance.contractVersion) || price.contractVersion,
        normalizeText(commissionProvenance.mapperVersion) || 'product-commission-projector-v1',
        normalizeText(commissionProvenance.responseHash) || price.responseHash,
        normalizeText(commissionProvenance.runId) || price.runId,
        normalizeText(commissionProvenance.snapshotId) || price.snapshotId,
        observedAt,
        sourceReason,
        createStableHash(payload), row.updated_at,
      );
    }
    writeFacet(row, 'commissions', {
      ...price,
      status: commissionStatus,
      mapperVersion: normalizeText(commissionProvenance.mapperVersion) || 'product-commission-projector-v1',
      responseHash: normalizeText(commissionProvenance.responseHash) || price.responseHash,
      sourceReason: normalizeText(commissionProvenance.sourceReason) || null,
    });

    const acquiringProvenance = parseJson(row.acquiring_provenance_json, {});
    const acquiringStatus = normalizeFacetStatus(row.acquiring_status, 'unavailable');
    const acquiringPayload = {
      feeMinor: toMinor(row.acquiring_fee_value),
      ratePpm: percentToRatePpm(row.acquiring_percent),
      status: acquiringStatus,
    };
    upsertAcquiring.run(
      row.id, row.shop_id, acquiringPayload.feeMinor, row.currency_code || null,
      acquiringPayload.ratePpm, acquiringStatus,
      normalizeText(acquiringProvenance.operationId) || price.operationId,
      normalizeText(acquiringProvenance.contractVersion) || price.contractVersion,
      normalizeText(acquiringProvenance.mapperVersion) || 'product-acquiring-projector-v1',
      normalizeText(acquiringProvenance.responseHash) || price.responseHash,
      normalizeText(acquiringProvenance.runId) || price.runId,
      normalizeText(acquiringProvenance.snapshotId) || price.snapshotId,
      normalizeText(acquiringProvenance.observedAt) || price.observedAt,
      normalizeText(acquiringProvenance.sourceReason) || null,
      createStableHash(acquiringPayload), row.updated_at,
    );
    writeFacet(row, 'acquiring', {
      ...price,
      status: acquiringStatus,
      mapperVersion: normalizeText(acquiringProvenance.mapperVersion) || 'product-acquiring-projector-v1',
      responseHash: normalizeText(acquiringProvenance.responseHash) || price.responseHash,
      sourceReason: normalizeText(acquiringProvenance.sourceReason) || null,
    });

    const stockProjection = parseJson(row.stock_json, {});
    const stockPresent = finiteNumber(row.stock_value);
    const hasStockEndpointProof = Boolean(
      normalizeText(row.stocks_hash) || normalizeText(row.stocks_synced_at),
    );
    const isExplicitEmptyStockProjection = hasStockEndpointProof
      && Array.isArray(stockProjection?.stocks)
      && stockProjection.stocks.length === 0;
    const inferredStockStatus = stockPresent !== null
      ? 'returned'
      : isExplicitEmptyStockProjection
        ? 'returned_empty'
        : 'pending';
    const stock = facetProvenance(row, 'stocks', {
      // Absence is not zero and is not an Ozon "unavailable" response.  Keep
      // the facet pending until the stocks endpoint supplies evidence.  An
      // endpoint-proven empty stocks array is valid empty, still never zero.
      status: inferredStockStatus,
      endpointKey: 'products.stocks', mapperVersion: 'product-stock-projector-v1',
      responseHash: row.stocks_hash, observedAt: row.stocks_synced_at || row.updated_at,
      sourceReason: stockPresent === 0
        ? 'ozon-explicit-zero-stock'
        : isExplicitEmptyStockProjection
          ? 'ozon-explicit-empty-stocks'
          : null,
    });
    if (stock.status === 'returned' && stockPresent === null && isExplicitEmptyStockProjection) {
      stock.status = 'returned_empty';
      stock.sourceReason = 'ozon-explicit-empty-stocks';
    }
    upsertStock.run(
      row.id, row.shop_id,
      stockPresent === null ? null : Math.max(0, Math.round(stockPresent)),
      stock.status, stock.operationId, stock.contractVersion, stock.mapperVersion,
      stock.responseHash, stock.runId, stock.snapshotId, stock.observedAt,
      stock.sourceReason,
      createStableHash({ present: row.stock_value, status: stock.status }), row.updated_at,
    );
    // `products.stocks` is a comprehensive aggregate source. It may contain
    // fulfillment buckets, but those buckets are not guaranteed to be exact
    // seller warehouses. Never rebuild warehouse facts from it. Remove only
    // old aggregate-derived compatibility rows; exact warehouse rows written
    // by products.stocksByWarehouseFbs survive regardless of task ordering.
    deleteLegacyAggregateWarehouseStocksByIdentity.run(row.id);
    writeFacet(row, 'stocks', stock);

    const pictures = facetProvenance(row, 'pictures', {
      status: 'pending', endpointKey: 'products.pictures',
      mapperVersion: 'product-picture-projector-v1', responseHash: row.pictures_hash,
      observedAt: row.pictures_synced_at || row.updated_at,
    });
    if (pictures.status === 'returned' || pictures.status === 'returned_empty') {
      const images = unique(parseJson(row.images_json, [])).filter((url) => /^https?:\/\//iu.test(url));
      db.prepare('DELETE FROM product_image_facts WHERE product_identity_id = ?').run(row.id);
      images.forEach((url, index) => {
        upsertImage.run(
          row.id, row.shop_id, index, url, index === 0 ? 1 : 0,
          pictures.operationId, pictures.contractVersion, pictures.mapperVersion,
          pictures.responseHash, pictures.runId, pictures.snapshotId,
          pictures.observedAt, createStableHash({ index, url }), row.updated_at,
        );
      });
    }
    writeFacet(row, 'pictures', pictures);

    const attributes = facetProvenance(row, 'attributes', {
      status: 'pending', endpointKey: 'products.attributes',
      mapperVersion: 'product-attribute-projector-v1', responseHash: row.attributes_hash,
      observedAt: row.attributes_synced_at || row.updated_at,
    });
    if (attributes.status === 'returned' || attributes.status === 'returned_empty') {
      const values = parseJson(row.attributes_json, []);
      const normalizedValues = Array.isArray(values) ? values : [];
      upsertAttributes.run(
        row.id, row.shop_id, JSON.stringify(normalizedValues),
        attributes.operationId, attributes.contractVersion, attributes.mapperVersion,
        attributes.responseHash, attributes.runId, attributes.snapshotId,
        attributes.observedAt, createStableHash(normalizedValues), row.updated_at,
      );
    }
    writeFacet(row, 'attributes', attributes);
    return row.id;
  }

  function projectRows({ shopId, productKeys = [], productIds = [], offerIds = [] } = {}) {
    const normalizedShopId = normalizeText(shopId);
    if (!normalizedShopId) throw new Error('PRODUCT_CANONICAL_SHOP_ID_REQUIRED');
    const conditions = [];
    const params = [normalizedShopId];
    const append = (column, values) => {
      const list = unique(values);
      if (!list.length) return;
      conditions.push(`${column} IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    };
    append('product_key', productKeys);
    append('product_id', productIds);
    append('offer_id', offerIds);
    if (!conditions.length) return { projected: 0, productIdentityIds: [] };
    const sql = `SELECT * FROM ozon_products WHERE shop_id = ?${conditions.length ? ` AND (${conditions.join(' OR ')})` : ''}`;
    const rows = db.prepare(sql).all(...params);
    for (const row of rows) projectRow(row);
    return { projected: rows.length, productIdentityIds: rows.map((row) => row.id) };
  }

  function getEffectiveDimensions({ shopId, productKey, productId, offerId } = {}) {
    const where = ['identity.shop_id = ?'];
    const params = [normalizeText(shopId)];
    if (normalizeText(productKey)) {
      where.push('legacy.product_key = ?');
      params.push(normalizeText(productKey));
    } else if (normalizeText(productId)) {
      where.push('identity.product_id = ?');
      params.push(normalizeText(productId));
    } else if (normalizeText(offerId)) {
      where.push('identity.offer_id = ?');
      params.push(normalizeText(offerId));
    } else {
      throw new Error('PRODUCT_CANONICAL_IDENTITY_REQUIRED');
    }
    const manual = db.prepare(`
      SELECT profile.source, profile.source_rank,
             CAST(ROUND(profile.weight_kg * 1000.0) AS INTEGER) AS weight_g,
             CAST(ROUND(profile.depth_cm * 10.0) AS INTEGER) AS length_mm,
             CAST(ROUND(profile.width_cm * 10.0) AS INTEGER) AS width_mm,
             CAST(ROUND(profile.height_cm * 10.0) AS INTEGER) AS height_mm
        FROM product_identities AS identity
        JOIN ozon_products AS legacy ON legacy.id = identity.product_identity_id
        JOIN product_material_profiles AS profile
          ON profile.shop_id = identity.shop_id AND profile.product_key = legacy.product_key
       WHERE ${where.join(' AND ')}
         AND profile.apply_to_product = 1
         AND (profile.is_confirmed = 1 OR profile.source_rank > 10)
       ORDER BY profile.source_rank DESC, profile.updated_at DESC LIMIT 1
    `).get(...params);
    if (manual) return { ...manual, sourceType: manual.source || 'user' };
    const ozon = db.prepare(`
      SELECT dimensions.source_type AS source, dimensions.source_priority AS source_rank,
             dimensions.weight_g, dimensions.length_mm, dimensions.width_mm, dimensions.height_mm
        FROM product_identities AS identity
        JOIN ozon_products AS legacy ON legacy.id = identity.product_identity_id
        JOIN product_dimension_facts AS dimensions
          ON dimensions.product_identity_id = identity.product_identity_id
       WHERE ${where.join(' AND ')}
       ORDER BY dimensions.source_priority DESC, dimensions.updated_at DESC LIMIT 1
    `).get(...params);
    return ozon ? { ...ozon, sourceType: ozon.source } : null;
  }

  return Object.freeze({
    projectRows,
    replaceWarehouseStockSets,
    recordWarehouseStockObservations,
    getEffectiveDimensions,
  });
}

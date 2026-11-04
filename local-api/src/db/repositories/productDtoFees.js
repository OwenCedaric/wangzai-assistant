import { createStableHash } from "../../utils/stableHash.js";
import { normalizeId, normalizeText, safeJsonParse, toFiniteNumber } from "./productDtoValues.js";

export function splitIds(value) {
  if (Array.isArray(value)) return value.map(normalizeId).filter(Boolean);
  return normalizeText(value).split(",").map(normalizeId).filter(Boolean);
}

export function createPatchHash(patch = {}) {
  return createStableHash(patch, { length: 32 });
}

export function findDeepNumericByKeys(value, keys = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null;
  const keySet = new Set(
    keys.map((item) => normalizeText(item).toLowerCase()).filter(Boolean),
  );
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeText(key).toLowerCase();
    if (
      keySet.has(normalizedKey) ||
      [...keySet].some((target) => normalizedKey.includes(target))
    ) {
      if (child && typeof child === "object") {
        const nested = firstFiniteFromValues(
          child.value,
          child.amount,
          child.price,
          child.fee,
          child.sum,
          child.total,
        );
        if (nested !== null) return nested;
      }
      const number = toFiniteNumber(child);
      if (number !== null) return number;
    }
    if (child && typeof child === "object") {
      const nested = findDeepNumericByKeys(child, keys, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

export function firstFiniteFromValues(...values) {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

export function extractAcquiringFee(row = {}) {
  return firstFiniteFromValues(
    row.acquiring,
    row.acquiring_amount,
    row.acquiringFee,
    row.acquiring_fee,
    row.price?.acquiring,
    row.price?.acquiring_amount,
    row.financial_data?.acquiring,
    row.financial_data?.acquiring_amount,
    row.financialData?.acquiring,
    row.financialData?.acquiringAmount,
    findDeepNumericByKeys(row, [
      "acquiring",
      "acquiring_amount",
      "acquiringFee",
    ]),
  );
}

export function extractAcquiringPercent(row = {}) {
  return firstFiniteFromValues(
    row.acquiring_percent,
    row.acquiringPercent,
    row.price?.acquiring_percent,
    row.financial_data?.acquiring_percent,
    row.financialData?.acquiringPercent,
    findDeepNumericByKeys(row, ["acquiring_percent", "acquiringPercent"]),
  );
}

export function compactFee(
  row = {},
  commission = extractCommissionObservation(row),
  acquiring = extractAcquiringObservation(row),
) {
  // Fee payload stays separate from price and finance deductions.
  // Commission modes remain independent from acquiring evidence.
  // Financial deductions are never inferred from this estimate payload.
  return buildCompactFeePayload(row, commission, acquiring);
}

export function firstPositiveFiniteNumber(...values) {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number !== null && number > 0) return number;
  }
  return null;
}

export function normalizePositivePercent(value) {
  const number = toFiniteNumber(value);
  return number !== null && number > 0 && number <= 100 ? number : null;
}

export function extractCommissionObservation(row = {}) {
  const commissions =
    row.commissions && typeof row.commissions === "object" ? row.commissions : {};
  const rawPercents = {
    fbo: commissions.sales_percent_fbo,
    fbs: commissions.sales_percent_fbs,
    rfbs:
      commissions.sales_percent_rfbs ??
      row.commission_percent ??
      row.commissionPercent,
    fbp: commissions.sales_percent_fbp,
  };
  const percents = Object.fromEntries(
    Object.entries(rawPercents).map(([mode, value]) => [
      mode,
      normalizePositivePercent(value),
    ]),
  );
  const selectedPercent =
    percents.rfbs ?? percents.fbs ?? percents.fbo ?? percents.fbp ?? null;
  const presentValues = Object.values(rawPercents).filter(
    (value) => value !== undefined && value !== null && value !== "",
  );
  const numericValues = presentValues
    .map(toFiniteNumber)
    .filter((value) => value !== null);
  if (selectedPercent !== null) {
    return {
      status: "returned",
      sourceReason: "ozon-direct-positive-commission",
      selectedPercent,
      percents,
      rawPercents,
    };
  }
  if (presentValues.length > 0 && numericValues.length !== presentValues.length) {
    return {
      status: "contract_invalid",
      sourceReason: "ozon-invalid-commission-value",
      selectedPercent: null,
      percents,
      rawPercents,
    };
  }
  if (numericValues.length > 0 && numericValues.every((value) => value <= 0)) {
    return {
      status: "unavailable",
      sourceReason: "ozon-zero-commission-sentinel",
      selectedPercent: null,
      percents,
      rawPercents,
    };
  }
  return {
    status: "not_returned",
    sourceReason: "ozon-commission-field-not-returned",
    selectedPercent: null,
    percents,
    rawPercents,
  };
}

export function extractAcquiringObservation(row = {}) {
  const rawFeeValue = extractAcquiringFee(row);
  const rawPercent = extractAcquiringPercent(row);
  const feeValue =
    rawFeeValue !== null && rawFeeValue > 0 ? rawFeeValue : null;
  const percent =
    rawPercent !== null && rawPercent > 0 ? rawPercent : null;
  if (feeValue !== null || percent !== null) {
    return {
      status: "returned",
      sourceReason: "ozon-direct-positive-acquiring",
      feeValue,
      percent,
      rawFeeValue,
      rawPercent,
    };
  }
  if (rawFeeValue === 0 || rawPercent === 0) {
    return {
      status: "unavailable",
      sourceReason: "ozon-zero-acquiring-sentinel",
      feeValue: null,
      percent: null,
      rawFeeValue,
      rawPercent,
    };
  }
  if (
    (rawFeeValue !== null && rawFeeValue < 0) ||
    (rawPercent !== null && rawPercent < 0)
  ) {
    return {
      status: "contract_invalid",
      sourceReason: "ozon-invalid-acquiring-value",
      feeValue: null,
      percent: null,
      rawFeeValue,
      rawPercent,
    };
  }
  return {
    status: "not_returned",
    sourceReason: "ozon-acquiring-field-not-returned",
    feeValue: null,
    percent: null,
    rawFeeValue,
    rawPercent,
  };
}

export function buildCompactFeePayload(row, commission, acquiring) {
  return {
    product_id: row.product_id ?? row.productId ?? row.id ?? null,
    offer_id: row.offer_id ?? row.offerId ?? null,
    acquiring_fee_value: acquiring.feeValue,
    acquiring_percent: acquiring.percent,
    acquiring_status: acquiring.status,
    commission_percent: commission.selectedPercent,
    commission_status: commission.status,
    commissions: {
      sales_percent_fbo: commission.percents.fbo,
      sales_percent_fbs: commission.percents.fbs,
      sales_percent_rfbs: commission.percents.rfbs,
      sales_percent_fbp: commission.percents.fbp,
    },
  };
}

export function toPublicProductFeeEvidence(row = {}) {
  const toPublicPercent = (value) =>
    value === null || value === undefined ? null : Number(value);
  return {
    commissionPercents: {
      fbo: toPublicPercent(row.commission_percent_fbo),
      fbs: toPublicPercent(row.commission_percent_fbs),
      rfbs: toPublicPercent(row.commission_percent_rfbs),
      fbp: toPublicPercent(row.commission_percent_fbp),
    },
    commissionStatuses: {
      fbo: row.commission_status_fbo || row.commission_status || "pending",
      fbs: row.commission_status_fbs || row.commission_status || "pending",
      rfbs: row.commission_status_rfbs || row.commission_status || "pending",
      fbp: row.commission_status_fbp || row.commission_status || "pending",
    },
    commissionStatus: row.commission_status || "pending",
    commissionProvenance: safeJsonParse(
      row.commission_provenance_json,
      null,
    ),
    acquiringStatus: row.acquiring_status || "pending",
    acquiringProvenance: safeJsonParse(
      row.acquiring_provenance_json,
      null,
    ),
    facetObservations: safeJsonParse(row.facet_observations_json, {}),
  };
}

export function canonicalRatePpmToPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number / 10_000 : null;
}

export function aggregateCanonicalCommissionStatus(modes = {}) {
  const statuses = Object.values(modes)
    .map((item) => normalizeText(item?.status).toLowerCase())
    .filter(Boolean);
  if (!statuses.length) return "pending";
  if (statuses.includes("returned")) return "returned";
  if (statuses.includes("stale_previous")) return "stale_previous";
  for (const status of [
    "failed",
    "contract_invalid",
    "unavailable",
    "not_returned",
    "returned_empty",
    "not_applicable",
    "pending",
  ]) {
    if (statuses.includes(status)) return status;
  }
  return "pending";
}

export function mergeCanonicalFactReadRow(row = {}) {
  if (!row.canonical_identity_id) return row;
  const next = { ...row, canonical_fact_source: "normalized-product-facts-v1" };
  if (row.canonical_visibility !== null && row.canonical_visibility !== undefined) {
    next.visibility = row.canonical_visibility;
    next.status_label = row.canonical_status_label;
    next.is_stale = row.canonical_is_stale;
    next.snapshot_visibilities_json = row.canonical_snapshot_visibilities_json || "[]";
  }
  if (row.canonical_detail_present) {
    next.name = row.canonical_name ?? next.name;
    next.category_id = row.canonical_category_id ?? next.category_id;
    next.category_name = row.canonical_category_name ?? next.category_name;
    next.type_id = row.canonical_type_id ?? next.type_id;
  }
  if (row.canonical_dimensions_present) {
    next.weight_kg = row.canonical_weight_g == null ? null : Number(row.canonical_weight_g) / 1000;
    next.depth_cm = row.canonical_length_mm == null ? null : Number(row.canonical_length_mm) / 10;
    next.width_cm = row.canonical_width_mm == null ? null : Number(row.canonical_width_mm) / 10;
    next.height_cm = row.canonical_height_mm == null ? null : Number(row.canonical_height_mm) / 10;
  }
  if (row.canonical_price_present) {
    next.price_value = row.canonical_price_minor == null ? null : Number(row.canonical_price_minor) / 100;
    next.currency_code = row.canonical_price_currency ?? next.currency_code;
  }
  const commissionModes = safeJsonParse(row.canonical_commissions_json, {});
  if (commissionModes && Object.keys(commissionModes).length) {
    for (const mode of ["fbo", "fbs", "rfbs", "fbp"]) {
      const evidence = commissionModes[mode];
      if (!evidence) continue;
      next[`commission_percent_${mode}`] = canonicalRatePpmToPercent(evidence.ratePpm);
      next[`commission_status_${mode}`] = normalizeText(evidence.status) || "pending";
    }
    next.commission_percent = ["rfbs", "fbs", "fbo", "fbp"]
      .map((mode) => next[`commission_percent_${mode}`])
      .find((value) => value !== null && value !== undefined) ?? null;
    next.commission_status = aggregateCanonicalCommissionStatus(commissionModes);
    const compatibilityCommissionProvenance = safeJsonParse(
      next.commission_provenance_json,
      {},
    );
    next.commission_provenance_json = JSON.stringify({
      ...compatibilityCommissionProvenance,
      source: "normalized-product-commission-facts",
      status: next.commission_status,
      fulfillmentModes: commissionModes,
    });
  }
  if (row.canonical_acquiring_present) {
    next.acquiring_fee_value = row.canonical_acquiring_fee_minor == null
      ? null
      : Number(row.canonical_acquiring_fee_minor) / 100;
    next.acquiring_percent = canonicalRatePpmToPercent(row.canonical_acquiring_rate_ppm);
    next.acquiring_status = row.canonical_acquiring_status || "pending";
    const compatibilityAcquiringProvenance = safeJsonParse(
      next.acquiring_provenance_json,
      {},
    );
    next.acquiring_provenance_json = JSON.stringify({
      ...compatibilityAcquiringProvenance,
      source: "normalized-product-acquiring-facts",
      status: next.acquiring_status,
      operationId: row.canonical_acquiring_operation_id || null,
      contractVersion: row.canonical_acquiring_contract_version || null,
      mapperVersion: row.canonical_acquiring_mapper_version || null,
      responseHash: row.canonical_acquiring_response_hash || null,
      runId: row.canonical_acquiring_run_id || null,
      snapshotId: row.canonical_acquiring_snapshot_id || null,
      observedAt: row.canonical_acquiring_observed_at || null,
      sourceReason: row.canonical_acquiring_source_reason || null,
    });
  }
  if (row.canonical_stock_present) {
    next.stock_value = row.canonical_stock_quantity == null
      ? null
      : Number(row.canonical_stock_quantity);
  }
  if (row.canonical_attributes_present) {
    next.attributes_json = row.canonical_attributes_json || "[]";
  }
  const facetObservations = safeJsonParse(row.canonical_facet_observations_json, {});
  if (facetObservations && Object.keys(facetObservations).length) {
    const compatibilityObservations = safeJsonParse(
      next.facet_observations_json,
      {},
    );
    next.facet_observations_json = JSON.stringify({
      ...(compatibilityObservations && typeof compatibilityObservations === "object"
        ? compatibilityObservations
        : {}),
      ...facetObservations,
    });
  }
  next.warehouse_stocks_json = row.canonical_warehouse_stocks_json || "[]";
  const imageCount = Number(row.canonical_image_count) || 0;
  if (imageCount > 0 || facetObservations?.pictures?.status === "returned_empty") {
    next.images_json = row.canonical_images_json || "[]";
    const images = safeJsonParse(next.images_json, []);
    next.primary_image_url = Array.isArray(images) ? images[0] || null : null;
  }
  return next;
}

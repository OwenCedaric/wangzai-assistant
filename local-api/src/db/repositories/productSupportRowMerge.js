import { normalizeText } from "./productCanonicalDto.js";
import {
  getMaterialSourceRank,
  normalizeLegacySourceSlot,
  normalizeSourceEntry,
  normalizeSupportIdentity,
} from "./productSupportModel.js";

export function createOzonMaterialCandidate(row = {}) {
  const weightKg = row.weightKg ?? row.weight_kg;
  const widthCm = row.widthCm ?? row.width_cm;
  const heightCm = row.heightCm ?? row.height_cm;
  const depthCm = row.depthCm ?? row.depth_cm;
  if (
    [weightKg, widthCm, heightCm, depthCm].every(
      (value) => value === null || value === undefined || value === "",
    )
  ) {
    return null;
  }
  return {
    source: "ozon-initial-read",
    sourceRank: getMaterialSourceRank("ozon-initial-read"),
    label: "Ozon 返回",
    weightKg:
      weightKg === null || weightKg === undefined ? null : Number(weightKg),
    widthCm:
      widthCm === null || widthCm === undefined ? null : Number(widthCm),
    heightCm:
      heightCm === null || heightCm === undefined ? null : Number(heightCm),
    depthCm:
      depthCm === null || depthCm === undefined ? null : Number(depthCm),
    weight:
      weightKg === null || weightKg === undefined
        ? ""
        : String(Number(weightKg)),
    width:
      widthCm === null || widthCm === undefined
        ? ""
        : String(Number(widthCm)),
    height:
      heightCm === null || heightCm === undefined
        ? ""
        : String(Number(heightCm)),
    length:
      depthCm === null || depthCm === undefined
        ? ""
        : String(Number(depthCm)),
    isConfirmed: false,
    applyToProduct: true,
    updatedAt: row.updatedAt || row.updated_at || "",
  };
}

export function dedupeMaterialCandidates(candidates = []) {
  const seen = new Set();
  return candidates
    .filter(Boolean)
    .sort(
      (left, right) =>
        (Number(right.sourceRank) || 0) - (Number(left.sourceRank) || 0),
    )
    .filter((item) => {
      const key = item.source || "missing";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function minorToCny(value) {
  if (value === null || value === undefined || value === "") return null;
  const minor = Number(value);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor / 100 : null;
}

export function toPublicManualCostProfile(row = {}) {
  return {
    id: row.id || "",
    shopId: row.shop_id || "",
    productKey: row.product_key || "",
    productId: row.product_id || "",
    offerId: row.offer_id || "",
    sku: row.sku || "",
    sourceType: row.source_type || "historical_import",
    purchaseCostCny: minorToCny(row.purchase_cost_minor),
    crossBorderCostCny: minorToCny(row.cross_border_cost_minor),
    domesticFreightCny: minorToCny(row.domestic_freight_minor),
    packagingCostCny: minorToCny(row.packaging_cost_minor),
    otherCostCny: minorToCny(row.other_cost_minor),
    currencyCode: row.currency_code || "CNY",
    sourcePlatform: row.source_platform || "",
    sourceUrl: row.source_url || "",
    purchaseOrderNumber: row.purchase_order_number || "",
    trackingNumber: row.tracking_number || "",
    note: row.note || "",
    originImportId: row.origin_import_id || "",
    observedAt: row.observed_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

export function hasExplicitCost(value) {
  if (value === null || value === undefined || value === "") return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0;
}

export function firstExplicitCost(...values) {
  const value = values.find(hasExplicitCost);
  return value === undefined ? null : Number(value);
}

export function firstFilledText(...values) {
  const value = values.find((item) => normalizeText(item));
  return value === undefined ? "" : normalizeText(value);
}

export function mergeManualCostProfiles(profiles = []) {
  const manual = profiles.find((item) => item.sourceType === "manual") || null;
  const historical =
    profiles.find((item) => item.sourceType === "historical_import") || null;
  if (!manual && !historical) return null;
  const ordered = [manual, historical].filter(Boolean);
  const moneyFields = [
    "purchaseCostCny",
    "crossBorderCostCny",
    "domesticFreightCny",
    "packagingCostCny",
    "otherCostCny",
  ];
  const textFields = [
    "currencyCode",
    "sourcePlatform",
    "sourceUrl",
    "purchaseOrderNumber",
    "trackingNumber",
    "note",
  ];
  const fieldSources = {};
  const effective = {
    shopId: manual?.shopId || historical?.shopId || "",
    productKey: manual?.productKey || historical?.productKey || "",
    productId: manual?.productId || historical?.productId || "",
    offerId: manual?.offerId || historical?.offerId || "",
    sku: manual?.sku || historical?.sku || "",
    sourceType: manual ? "manual" : "historical_import",
    sourceTypes: ordered.map((item) => item.sourceType),
    isComposite: Boolean(manual && historical),
    originImportId: manual?.originImportId || historical?.originImportId || "",
    observedAt: firstFilledText(manual?.observedAt, historical?.observedAt),
    updatedAt: firstFilledText(manual?.updatedAt, historical?.updatedAt),
  };
  for (const field of moneyFields) {
    const source = ordered.find((item) => hasExplicitCost(item[field]));
    effective[field] = source ? Number(source[field]) : null;
    if (source) fieldSources[field] = source.sourceType;
  }
  for (const field of textFields) {
    const source = ordered.find((item) => normalizeText(item[field]));
    effective[field] = source ? normalizeText(source[field]) : field === "currencyCode" ? "CNY" : "";
    if (source) fieldSources[field] = source.sourceType;
  }
  effective.fieldSources = fieldSources;
  return effective;
}

export function prepareLegacyProductSourceLinkGroup(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("PRODUCT_SOURCE_LEGACY_RECORD_INVALID");
  }
  const identity = normalizeSupportIdentity(input);
  if (!identity.shopId) throw new Error("PRODUCT_SOURCE_SHOP_ID_REQUIRED");
  if (!identity.productKey) {
    throw new Error("PRODUCT_SOURCE_PRODUCT_KEY_REQUIRED");
  }
  const record =
    input.record && typeof input.record === "object" && !Array.isArray(input.record)
      ? input.record
      : input;
  const rawLinks = Array.isArray(input.links)
    ? input.links
    : Array.isArray(record.links)
      ? record.links
      : null;
  if (!rawLinks?.length) throw new Error("PRODUCT_SOURCE_LEGACY_LINKS_REQUIRED");

  const slots = new Set();
  const explicitPrimarySlots = [];
  const slotsByPosition = rawLinks.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("PRODUCT_SOURCE_LEGACY_LINK_INVALID");
    }
    const entryShopId = normalizeText(entry.shopId ?? entry.shop_id);
    const entryProductKey = normalizeText(entry.productKey ?? entry.product_key);
    if (entryShopId && entryShopId !== identity.shopId) {
      throw new Error("PRODUCT_SOURCE_LEGACY_SCOPE_MISMATCH");
    }
    if (entryProductKey && entryProductKey !== identity.productKey) {
      throw new Error("PRODUCT_SOURCE_LEGACY_SCOPE_MISMATCH");
    }
    const slotIndex = normalizeLegacySourceSlot(
      entry.slotIndex ?? entry.slot_index,
      index,
    );
    if (slots.has(slotIndex)) throw new Error("PRODUCT_SOURCE_LEGACY_SLOT_DUPLICATE");
    slots.add(slotIndex);
    if (entry.isPrimary === true || entry.is_primary === true) {
      explicitPrimarySlots.push(slotIndex);
    }
    return slotIndex;
  });
  if (explicitPrimarySlots.length > 1) {
    throw new Error("PRODUCT_SOURCE_LEGACY_PRIMARY_DUPLICATE");
  }
  const requestedPrimaryIndex = Number(
    record.primaryIndex ?? record.primary_index ?? input.primaryIndex ?? input.primary_index ?? 0,
  );
  if (!Number.isSafeInteger(requestedPrimaryIndex) || requestedPrimaryIndex < 0) {
    throw new Error("PRODUCT_SOURCE_LEGACY_PRIMARY_INVALID");
  }
  const primarySlot = explicitPrimarySlots[0] ?? slotsByPosition[requestedPrimaryIndex];
  if (primarySlot === undefined) {
    throw new Error("PRODUCT_SOURCE_LEGACY_PRIMARY_INVALID");
  }
  const links = rawLinks.map((entry, index) => {
    const slotIndex = slotsByPosition[index];
    const normalized = normalizeSourceEntry(entry, slotIndex, primarySlot);
    if (!normalized.url && !normalized.sourceProductId) {
      throw new Error("PRODUCT_SOURCE_LEGACY_LINK_CONTENT_REQUIRED");
    }
    return normalized;
  });
  return { identity, links, primarySlot };
}

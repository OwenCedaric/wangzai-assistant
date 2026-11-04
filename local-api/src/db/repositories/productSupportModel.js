import { createStableHash } from "../../utils/stableHash.js";
import * as canonicalDto from "./productCanonicalDto.js";

const {
  compactJson,
  createProductKey,
  firstFilled,
  normalizeDimension,
  normalizeId,
  normalizeProductCurrencyCode,
  normalizeText,
  normalizeWeight,
  nowIso,
  repairStoredStockPatch,
  safeJsonParse,
  toFiniteNumber,
} = canonicalDto;

export const PRODUCT_MATERIAL_SOURCE_RANK = Object.freeze({
  "cross-border-bus": 400,
  cross_border_bus: 400,
  crossBorderBus: 400,
  "manual-confirmed": 320,
  manual_confirmed: 320,
  "supplier-confirmed": 300,
  supplier_confirmed: 300,
  supplier: 300,
  "ozon-product-save-readback": 220,
  "ozon-product-list-read": 210,
  "ozon-readback": 200,
  "ozon-initial-read": 180,
  missing: 0,
});

export function normalizeMaterialSource(value = "") {
  const text = normalizeText(value) || "missing";
  if (text === "cross_border_bus" || text === "crossBorderBus")
    return "cross-border-bus";
  if (text === "manual_confirmed") return "manual-confirmed";
  if (text === "supplier_confirmed" || text === "supplier")
    return "supplier-confirmed";
  return text;
}

export function getMaterialSourceRank(source = "") {
  const normalized = normalizeMaterialSource(source);
  return PRODUCT_MATERIAL_SOURCE_RANK[normalized] ?? 0;
}

export function toSqlBool(value, fallback = true) {
  if (value === undefined || value === null || value === "")
    return fallback ? 1 : 0;
  return value === false ||
    value === 0 ||
    normalizeText(value).toLowerCase() === "false"
    ? 0
    : 1;
}

export function createSupportProductKey(input = {}) {
  const productKey = normalizeText(input.productKey || input.product_key);
  if (productKey) return productKey;
  const productId = normalizeId(input.productId ?? input.product_id);
  const offerId = normalizeId(input.offerId ?? input.offer_id);
  const sku = normalizeId(
    input.ozonSku ?? input.sku ?? input.sku_id ?? input.skuId,
  );
  return createProductKey({ productId, offerId, sku, raw: input });
}

export function createSupportRowId(type, shopId, productKey, extra = "") {
  return `${type}:${shopId}:${createStableHash(`${productKey}:${extra}`, { length: 24 })}`;
}

export function normalizeSupportIdentity(input = {}) {
  const shopId = normalizeText(input.shopId ?? input.shop_id);
  const rawProductKey = createSupportProductKey(input);
  return {
    shopId,
    productKey:
      shopId && rawProductKey.startsWith(`${shopId}:`)
        ? rawProductKey.slice(shopId.length + 1)
        : rawProductKey,
    productId: normalizeId(input.productId ?? input.product_id),
    offerId: normalizeId(input.offerId ?? input.offer_id),
    sku: normalizeId(input.ozonSku ?? input.sku ?? input.sku_id ?? input.skuId),
  };
}

export function repairLegacyScopedProductSourceLinkKeys(db) {
  const rows = db
    .prepare(
      `SELECT id, shop_id, product_key, slot_index, updated_at
       FROM product_source_links
       WHERE shop_id <> '' AND product_key LIKE shop_id || ':%'`,
    )
    .all();
  if (!rows.length) return;
  const selectCurrent = db.prepare(
    "SELECT id, updated_at FROM product_source_links WHERE shop_id = ? AND product_key = ? AND slot_index = ? LIMIT 1",
  );
  const deleteById = db.prepare("DELETE FROM product_source_links WHERE id = ?");
  const updateKey = db.prepare("UPDATE product_source_links SET product_key = ? WHERE id = ?");
  db.exec("BEGIN;");
  try {
    rows.forEach((row) => {
      const productKey = row.product_key.slice(`${row.shop_id}:`.length);
      if (!productKey) return;
      const current = selectCurrent.get(row.shop_id, productKey, row.slot_index);
      if (!current) {
        updateKey.run(productKey, row.id);
        return;
      }
      const legacyTime = Date.parse(row.updated_at || "") || 0;
      const currentTime = Date.parse(current.updated_at || "") || 0;
      if (legacyTime > currentTime) {
        deleteById.run(current.id);
        updateKey.run(productKey, row.id);
      } else {
        deleteById.run(row.id);
      }
    });
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

export function getSourceLinkMedia(input = {}) {
  const nested = input.raw && typeof input.raw === "object" ? input.raw : {};
  const originalImageUrl = normalizeText(
    firstFilled(
      input.originalImageUrl,
      input.original_image_url,
      input.originalImage,
      input.original_image,
      input.fullImageUrl,
      input.full_image_url,
      input.largeImageUrl,
      input.large_image_url,
      input.highResImageUrl,
      input.high_res_image_url,
      Array.isArray(input.originalImages) ? input.originalImages[0] : "",
      nested.originalImageUrl,
      nested.original_image_url,
      nested.originalImage,
      nested.fullImageUrl,
    ),
  );
  return {
    originalImageUrl,
    previewImageUrl: normalizeText(
      firstFilled(
        input.previewImageUrl,
        input.preview_image_url,
        input.previewImage,
        input.preview_image,
        input.largePreviewImageUrl,
        input.large_preview_image_url,
        nested.previewImageUrl,
        nested.preview_image_url,
        nested.previewImage,
      ),
    ),
  };
}

export function repairProductSourceLinkMedia(db) {
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('product_source_links')")
    .all()
    .map((column) => column.name);
  if (!columns.includes("preview_image_url") || !columns.includes("original_image_url"))
    return;
  const rows = db
    .prepare(
      "SELECT id, raw_json, preview_image_url, original_image_url FROM product_source_links WHERE raw_json IS NOT NULL",
    )
    .all();
  if (!rows.length) return;
  const update = db.prepare(
    `UPDATE product_source_links
     SET preview_image_url = COALESCE(NULLIF(?, ''), preview_image_url),
         original_image_url = COALESCE(NULLIF(?, ''), original_image_url),
         raw_json = NULL
     WHERE id = ?`,
  );
  db.exec("BEGIN;");
  try {
    rows.forEach((row) => {
      const raw = safeJsonParse(row.raw_json, {});
      const media = getSourceLinkMedia(raw);
      update.run(
        media.previewImageUrl || null,
        media.originalImageUrl || null,
        row.id,
      );
    });
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

export function normalizeMaterialProfileInput(input = {}) {
  const identity = normalizeSupportIdentity(input);
  const source = normalizeMaterialSource(
    input.source || input.materialSource || input.sourceType,
  );
  const weightKg = normalizeWeight(
    input.weightKg ?? input.weight_kg ?? input.weight,
    input.weightUnit ?? input.weight_unit ?? "kg",
  );
  const widthCm = normalizeDimension(
    input.widthCm ?? input.width_cm ?? input.width,
    input.dimensionUnit ?? input.dimension_unit ?? "cm",
  );
  const heightCm = normalizeDimension(
    input.heightCm ?? input.height_cm ?? input.height,
    input.dimensionUnit ?? input.dimension_unit ?? "cm",
  );
  const depthCm = normalizeDimension(
    input.depthCm ?? input.depth_cm ?? input.depth ?? input.length,
    input.dimensionUnit ?? input.dimension_unit ?? "cm",
  );
  return {
    ...identity,
    source,
    sourceRank:
      Number(input.sourceRank ?? input.source_rank) ||
      getMaterialSourceRank(source),
    weightKg,
    widthCm,
    heightCm,
    depthCm,
    applyToProduct: toSqlBool(
      input.applyToProduct ?? input.apply_to_product,
      true,
    ),
    isConfirmed: toSqlBool(
      input.isConfirmed ??
        input.is_confirmed ??
        getMaterialSourceRank(source) >= 300,
      false,
    ),
    ozonSyncedAt: normalizeText(input.ozonSyncedAt ?? input.ozon_synced_at),
    ozonSyncStatus: normalizeText(
      input.ozonSyncStatus ?? input.ozon_sync_status,
    ),
    sourceOrderId: normalizeText(input.sourceOrderId ?? input.source_order_id),
    sourceOrderNumber: normalizeText(
      input.sourceOrderNumber ?? input.source_order_number,
    ),
    sourcePurchaseOrderNumber: normalizeText(
      input.sourcePurchaseOrderNumber ?? input.source_purchase_order_number,
    ),
    raw: input.raw || input,
  };
}

export const LEGACY_PRODUCT_MATERIAL_FIELDS = new Set([
  "key",
  "shopId",
  "shop_id",
  "productKey",
  "product_key",
  "productId",
  "product_id",
  "offerId",
  "offer_id",
  "ozonSku",
  "sku",
  "sku_id",
  "skuId",
  "source",
  "materialSource",
  "sourceType",
  "sourceRank",
  "source_rank",
  "weight",
  "weightKg",
  "weight_kg",
  "weightUnit",
  "weight_unit",
  "width",
  "widthCm",
  "width_cm",
  "height",
  "heightCm",
  "height_cm",
  "depth",
  "depthCm",
  "depth_cm",
  "length",
  "dimensionUnit",
  "dimension_unit",
  "applyToProduct",
  "apply_to_product",
  "isConfirmed",
  "is_confirmed",
  "ozonSyncedAt",
  "ozon_synced_at",
  "ozonSyncStatus",
  "ozon_sync_status",
  "ozonSyncTaskId",
  "ozon_sync_task_id",
  "sourceOrderId",
  "source_order_id",
  "sourceOrderNumber",
  "source_order_number",
  "sourcePurchaseOrderNumber",
  "source_purchase_order_number",
  "updatedAt",
  "updated_at",
  "savedAt",
]);

export function prepareLegacyMaterialProfile(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("PRODUCT_MATERIAL_LEGACY_RECORD_INVALID");
  }
  Object.keys(input).forEach((field) => {
    if (!LEGACY_PRODUCT_MATERIAL_FIELDS.has(field)) {
      throw new Error("PRODUCT_MATERIAL_LEGACY_FIELD_NOT_ALLOWED");
    }
  });
  const normalized = normalizeMaterialProfileInput(input);
  if (!normalized.shopId) throw new Error("PRODUCT_MATERIAL_SHOP_ID_REQUIRED");
  if (!normalized.productKey) throw new Error("PRODUCT_MATERIAL_PRODUCT_KEY_REQUIRED");
  const suppliedKey = normalizeText(input.key);
  const legacyProductKey = normalizeId(
    input.offerId ?? input.offer_id ?? input.productId ?? input.product_id ?? input.ozonSku ?? input.sku,
  );
  const acceptedKeys = new Set([
    normalized.productKey,
    `${normalized.shopId}:${normalized.productKey}`,
    legacyProductKey,
    legacyProductKey ? `${normalized.shopId}:${legacyProductKey}` : "",
  ]);
  if (suppliedKey && !acceptedKeys.has(suppliedKey)) {
    throw new Error("PRODUCT_MATERIAL_LEGACY_KEY_SCOPE_INVALID");
  }
  return normalized;
}

export function encodeProductMaterialCursor(row = {}) {
  return Buffer.from(
    JSON.stringify({
      shopId: normalizeText(row.shop_id),
      productKey: normalizeText(row.product_key),
      source: normalizeText(row.source),
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeProductMaterialCursor(value) {
  const text = normalizeLegacyCursorText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    const shopId = normalizeText(parsed?.shopId);
    const productKey = normalizeText(parsed?.productKey);
    const source = normalizeText(parsed?.source);
    return shopId && productKey && source ? { shopId, productKey, source } : null;
  } catch {
    return null;
  }
}

export function toPublicMaterialProfile(row = {}) {
  if (!row) return null;
  const raw = safeJsonParse(row.raw_json, {});
  return {
    key: row.product_key || "",
    shopId: row.shop_id || "",
    productKey: row.product_key || "",
    productId: row.product_id || "",
    offerId: row.offer_id || "",
    ozonSku: row.sku || "",
    sku: row.sku || "",
    source: row.source || "missing",
    sourceRank: Number(row.source_rank) || 0,
    weightKg:
      row.weight_kg === null || row.weight_kg === undefined
        ? null
        : Number(row.weight_kg),
    widthCm:
      row.width_cm === null || row.width_cm === undefined
        ? null
        : Number(row.width_cm),
    heightCm:
      row.height_cm === null || row.height_cm === undefined
        ? null
        : Number(row.height_cm),
    depthCm:
      row.depth_cm === null || row.depth_cm === undefined
        ? null
        : Number(row.depth_cm),
    weight:
      row.weight_kg === null || row.weight_kg === undefined
        ? ""
        : String(Number(row.weight_kg)),
    width:
      row.width_cm === null || row.width_cm === undefined
        ? ""
        : String(Number(row.width_cm)),
    height:
      row.height_cm === null || row.height_cm === undefined
        ? ""
        : String(Number(row.height_cm)),
    length:
      row.depth_cm === null || row.depth_cm === undefined
        ? ""
        : String(Number(row.depth_cm)),
    applyToProduct: Boolean(row.apply_to_product),
    isConfirmed: Boolean(row.is_confirmed),
    ozonSyncedAt: row.ozon_synced_at || "",
    ozonSyncStatus: row.ozon_sync_status || "",
    ozonSyncTaskId: normalizeText(raw.ozonSyncTaskId ?? raw.ozon_sync_task_id),
    sourceOrderId: row.source_order_id || "",
    sourceOrderNumber: row.source_order_number || "",
    sourcePurchaseOrderNumber: row.source_purchase_order_number || "",
    updatedAt: row.updated_at || "",
  };
}

export function normalizeSourceEntry(input = {}, slotIndex = 0, primaryIndex = 0) {
  const url = normalizeText(input.url ?? input.link ?? input.href);
  const media = getSourceLinkMedia(input);
  return {
    slotIndex,
    isPrimary: slotIndex === primaryIndex ? 1 : 0,
    platform: normalizeText(input.platform),
    url,
    sourceProductId: normalizeText(
      input.sourceProductId ?? input.productId ?? input.product_id,
    ),
    title: normalizeText(input.title),
    imageUrl: normalizeText(input.imageUrl ?? input.image_url),
    previewImageUrl: media.previewImageUrl,
    originalImageUrl: media.originalImageUrl,
    priceValue: toFiniteNumber(
      input.priceValue ?? input.price_value ?? input.price,
    ),
    currencyCode: normalizeProductCurrencyCode(
      input.currencyCode ?? input.currency_code ?? "CNY",
    ),
    qty: normalizeText(input.qty ?? input.quantity),
  };
}

export function toPublicSourceLink(row = {}) {
  return {
    shopId: row.shop_id || "",
    shop_id: row.shop_id || "",
    productKey: row.product_key || "",
    product_key: row.product_key || "",
    ozonProductId: row.product_id || "",
    ozon_product_id: row.product_id || "",
    offerId: row.offer_id || "",
    offer_id: row.offer_id || "",
    sku: row.sku || "",
    slotIndex: Number(row.slot_index) || 0,
    isPrimary: Boolean(row.is_primary),
    platform: row.platform || "",
    link: row.url || "",
    url: row.url || "",
    productId: row.source_product_id || "",
    sourceProductId: row.source_product_id || "",
    title: row.title || "",
    imageUrl: row.image_url || "",
    previewImageUrl: row.preview_image_url || "",
    preview_image_url: row.preview_image_url || "",
    originalImageUrl: row.original_image_url || "",
    original_image_url: row.original_image_url || "",
    priceValue:
      row.price_value === null || row.price_value === undefined
        ? null
        : Number(row.price_value),
    currencyCode: normalizeProductCurrencyCode(row.currency_code || "CNY"),
    qty: row.qty || "",
    savedAt: row.updated_at || "",
    updatedAt: row.updated_at || "",
    updated_at: row.updated_at || "",
    createdAt: row.created_at || "",
    created_at: row.created_at || "",
  };
}

export function normalizeLegacyCursorText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function encodeProductSourceLinkCursor(row = {}) {
  return Buffer.from(
    JSON.stringify({
      shopId: normalizeText(row.shop_id),
      productKey: normalizeText(row.product_key),
      slotIndex: Number(row.slot_index) || 0,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeProductSourceLinkCursor(value) {
  const text = normalizeLegacyCursorText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    const shopId = normalizeText(parsed?.shopId);
    const productKey = normalizeText(parsed?.productKey);
    const slotIndex = Number(parsed?.slotIndex);
    return shopId && productKey && Number.isSafeInteger(slotIndex) && slotIndex >= 0
      ? { shopId, productKey, slotIndex }
      : null;
  } catch {
    return null;
  }
}

export function normalizeLegacySourceSlot(value, fallback) {
  const slotIndex = Number(value ?? fallback);
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0) {
    throw new Error("PRODUCT_SOURCE_LEGACY_SLOT_INVALID");
  }
  return slotIndex;
}

export function toPublicImageHealth(row = {}) {
  return {
    imageUrl: row.image_url || "",
    status: row.status || "unknown",
    httpStatus:
      row.http_status === null || row.http_status === undefined
        ? null
        : Number(row.http_status),
    source: row.source || "",
    checkedAt: row.checked_at || "",
    updatedAt: row.updated_at || "",
  };
}

export function repairProductStockValuesFromStockJson(db) {
  try {
    const rows = db
      .prepare(
        `
        SELECT id, stock_value, stock_json
        FROM ozon_products
        WHERE stocks_synced_at IS NOT NULL
          AND stock_json IS NOT NULL
      `,
      )
      .all();
    const update = db.prepare(
      "UPDATE ozon_products SET stock_value = ?, stock_json = ?, updated_at = ? WHERE id = ?",
    );
    const timestamp = nowIso();
    for (const row of rows) {
      const repair = repairStoredStockPatch(row);
      if (!repair) continue;
      update.run(
        repair.stockValue ?? row.stock_value,
        compactJson(repair.stockJson),
        timestamp,
        row.id,
      );
    }
  } catch {
    // Older test databases may not have product cache tables yet.
  }
}

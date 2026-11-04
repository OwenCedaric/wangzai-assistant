import { createStableHash } from "../../utils/stableHash.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== "0" && text !== "未返回" ? text : "";
}

function compactJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function pickPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

const CROSS_BORDER_OVERRIDE_FIELDS = [
  "crossBorderOrderFound",
  "crossBorderStatus",
  "crossBorderOrderCount",
  "packageOrderId",
  "crossBorderOrderId",
  "crossBorderOrderNumber",
  "packageOrderIds",
  "readStatus",
  "packageWeight",
  "packageSize",
  "volumeItems",
  "warehouse",
  "logistics",
  "deliveryMethod",
  "deliveryMethodId",
  "sheetOrderSn",
  "sheetUrl",
  "freightCostValue",
  "freightCost",
  "guooFreight",
  "crossBorderUpdatedAt",
];

const PURCHASE_OVERRIDE_CLEARABLE_FIELDS = new Set([
  "purchasePlatform",
  "purchaseOrderNumber",
  "purchaseOrderUrl",
  "sourceCostCny",
  "manualStatus",
]);

const PURCHASE_DOMESTIC_LOGISTICS_FIELDS = Object.freeze([
  "carrierName",
  "expressCompany",
  "domesticCourierCompany",
  "trackingNumber",
  "logisticsOrder",
  "domesticTrackingNumber",
  "purchaseTrackingNumber",
  "domesticLogisticsStatus",
  "purchaseLogisticsStatus",
  "domesticLogisticsSyncStatus",
  "domesticLogisticsSyncedAt",
  "domesticLogisticsSource",
]);

const PURCHASE_OVERRIDE_RAW_FIELD_ALIASES = Object.freeze({
  purchasePlatform: [
    "purchasePlatform", "purchase_platform", "platform", "manualBuyerPlatform",
    "buyerPlatform", "supplier",
  ],
  purchaseOrderNumber: [
    "purchaseOrderNumber", "purchase_order_number", "purchaseOrderNo",
    "purchase_order_no", "orderNo", "order_no", "manualPurchaseOrderNo",
  ],
  purchaseOrderUrl: [
    "purchaseOrderUrl", "purchase_order_url", "orderUrl", "order_url",
    "purchaseOrderLink", "purchase_order_link",
  ],
  sourceCostCny: [
    "sourceCostCny", "source_cost_cny", "purchaseCostCny", "purchase_cost_cny",
    "cost", "manualPurchasePriceValue", "manualPurchasePrice",
  ],
  manualStatus: [
    "manualStatus", "manual_status", "purchaseOrderStatus", "purchase_order_status",
    "manualPurchaseOrderStatus", "status",
  ],
});

function normalizePurchaseOverrideClearFields(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map(normalizeText)
        .filter((field) => PURCHASE_OVERRIDE_CLEARABLE_FIELDS.has(field)),
    ),
  ];
}

function buildPurchaseOverrideRaw(input = {}, clearFields = []) {
  const source = input.raw && typeof input.raw === "object" && !Array.isArray(input.raw)
    ? input.raw
    : input;
  const raw = { ...source };
  delete raw.clearFields;
  clearFields.forEach((field) => {
    (PURCHASE_OVERRIDE_RAW_FIELD_ALIASES[field] || []).forEach((alias) => delete raw[alias]);
  });
  if (clearFields.length) raw.clearFields = clearFields;
  return raw;
}

function hasPublicFieldValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== "";
}

function extractRawCrossBorderFields(raw = {}) {
  const next = {};
  [pickPlainObject(raw.patch), pickPlainObject(raw.order)].forEach((source) => {
    CROSS_BORDER_OVERRIDE_FIELDS.forEach((field) => {
      if (hasPublicFieldValue(next[field])) return;
      if (hasPublicFieldValue(source[field])) next[field] = source[field];
    });
  });
  return next;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFilled(...values) {
  for (const value of values) {
    if (normalizeText(value)) return value;
  }
  return "";
}

function resolveOrderKey(input = {}) {
  return normalizeId(
    firstFilled(
      input.orderKey,
      input.order_key,
      input.recordKey,
      input.record_key,
      input.posting_number,
      input.postingNumber,
      input.ozonOrderId,
      input.ozon_order_id,
    ),
  );
}

function normalizeOverride(input = {}) {
  const shopId = normalizeText(input.shopId ?? input.shop_id);
  const orderKey = resolveOrderKey(input);
  if (!orderKey)
    throw new Error(
      "orderKey/postingNumber is required for purchase order override.",
    );
  const sourceCost = toNumberOrNull(
    input.sourceCostCny ??
      input.source_cost_cny ??
      input.purchaseCostCny ??
      input.purchase_cost_cny ??
      input.cost ??
      input.manualPurchasePriceValue ??
      input.manualPurchasePrice,
  );
  const clearFields = normalizePurchaseOverrideClearFields(input.clearFields);
  const clearFieldSet = new Set(clearFields);
  return {
    id: `purchase_override_${createStableHash({ shopId, orderKey }, { length: 32 })}`,
    shopId,
    orderKey,
    postingNumber: normalizeId(
      firstFilled(input.posting_number, input.postingNumber, orderKey),
    ),
    ozonOrderId: normalizeId(
      firstFilled(
        input.ozonOrderId,
        input.ozon_order_id,
        input.orderId,
        input.order_id,
      ),
    ),
    offerId: normalizeId(firstFilled(input.offerId, input.offer_id)),
    sku: normalizeId(input.sku),
    purchasePlatform: clearFieldSet.has("purchasePlatform") ? "" : normalizeText(
      firstFilled(
        input.purchasePlatform,
        input.purchase_platform,
        input.platform,
        input.manualBuyerPlatform,
        input.buyerPlatform,
        input.supplier,
      ),
    ),
    purchaseOrderNumber: clearFieldSet.has("purchaseOrderNumber") ? "" : normalizeText(
      firstFilled(
        input.purchaseOrderNumber,
        input.purchase_order_number,
        input.purchaseOrderNo,
        input.purchase_order_no,
        input.orderNo,
        input.order_no,
        input.manualPurchaseOrderNo,
      ),
    ),
    purchaseOrderUrl: clearFieldSet.has("purchaseOrderUrl") ? "" : normalizeText(
      firstFilled(
        input.purchaseOrderUrl,
        input.purchase_order_url,
        input.orderUrl,
        input.order_url,
        input.purchaseOrderLink,
        input.purchase_order_link,
        input.url,
        input.link,
      ),
    ),
    sourceCostCny: clearFieldSet.has("sourceCostCny") ? null : sourceCost,
    manualStatus: clearFieldSet.has("manualStatus") ? "" : normalizeText(
      firstFilled(
        input.manualStatus,
        input.manual_status,
        input.purchaseOrderStatus,
        input.purchase_order_status,
        input.manualPurchaseOrderStatus,
        input.status,
      ),
    ),
    materialSource: input.materialSource ?? input.material_source ?? null,
    note: normalizeText(input.note ?? input.remark ?? input.memo),
    clearFields: clearFieldSet,
    updatedAt: normalizeLegacyUpdatedAt(input.updatedAt ?? input.updated_at),
    raw: buildPurchaseOverrideRaw(input, clearFields),
  };
}

function toPublicOverride(row = {}) {
  const raw = parseJson(row.raw_json, {});
  const rawCrossBorderFields = extractRawCrossBorderFields(raw);
  const clearFields = normalizePurchaseOverrideClearFields(raw.clearFields);
  return {
    ...rawCrossBorderFields,
    ...raw,
    clearFields,
    id: row.id,
    shopId: row.shop_id || "",
    orderKey: row.order_key,
    postingNumber: row.posting_number || "",
    posting_number: row.posting_number || "",
    ozonOrderId: row.ozon_order_id || "",
    offerId: row.offer_id || "",
    sku: row.sku || "",
    purchasePlatform: row.purchase_platform || "",
    purchase_platform: row.purchase_platform || "",
    platform: row.purchase_platform || "",
    purchaseOrderNumber: row.purchase_order_number || "",
    purchase_order_number: row.purchase_order_number || "",
    purchaseOrderUrl: row.purchase_order_url || "",
    purchase_order_url: row.purchase_order_url || "",
    orderUrl: row.purchase_order_url || "",
    sourceCostCny: row.source_cost_cny,
    source_cost_cny: row.source_cost_cny,
    cost: row.source_cost_cny,
    manualStatus: row.manual_status || "",
    manual_status: row.manual_status || "",
    materialSource: parseJson(row.material_source_json, null),
    note: row.note || "",
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function normalizePageSize(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

function normalizeLegacyCursorText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function encodePurchaseOverrideCursor(row = {}) {
  return Buffer.from(
    JSON.stringify({
      shopId: normalizeText(row.shop_id),
      orderKey: normalizeText(row.order_key),
    }),
    "utf8",
  ).toString("base64url");
}

function decodePurchaseOverrideCursor(value) {
  const text = normalizeLegacyCursorText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    const orderKey = normalizeId(parsed?.orderKey);
    const shopId = normalizeText(parsed?.shopId);
    return orderKey ? { shopId, orderKey } : null;
  } catch {
    return null;
  }
}

function normalizeLegacyUpdatedAt(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new Error("PURCHASE_OVERRIDE_LEGACY_UPDATED_AT_INVALID");
  }
  return new Date(timestamp).toISOString();
}

function isScopedShopId(value) {
  const shopId = normalizeId(value);
  return shopId && !["all", "default", "*"].includes(shopId.toLowerCase())
    ? shopId
    : "";
}

export function createPurchaseOrderOverrideRepository(db) {
  function repairRefundedOverrideRawResidue() {
    const rows = db.prepare(`
      SELECT id, raw_json
      FROM purchase_order_overrides
      WHERE purchase_platform IS NULL
        AND purchase_order_number IS NULL
        AND purchase_order_url IS NULL
        AND source_cost_cny IS NULL
        AND raw_json IS NOT NULL
    `).all();
    const update = db.prepare(
      "UPDATE purchase_order_overrides SET raw_json = ? WHERE id = ?",
    );
    rows.forEach((row) => {
      const raw = parseJson(row.raw_json, null);
      if (!raw?.purchaseRefundConfirmed) return;
      const clearFields = normalizePurchaseOverrideClearFields(raw.clearFields);
      if (!clearFields.length) return;
      const platform = normalizeText(raw.voidedPurchasePlatform);
      const orderNumber = normalizeText(raw.voidedPurchaseOrderNo);
      if (platform === "1688" && /^\d{8,}$/u.test(orderNumber) && raw.refundEvidence) {
        raw.refundEvidence = {
          ...pickPlainObject(raw.refundEvidence),
          pageUrl: `https://trade.1688.com/order/new_step_order_detail.htm?orderId=${orderNumber}`,
        };
      }
      const repaired = buildPurchaseOverrideRaw({ raw }, clearFields);
      const json = compactJson(repaired);
      if (json && json !== row.raw_json) update.run(json, row.id);
    });
  }

  repairRefundedOverrideRawResidue();

  function prepareLegacyOverride(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("PURCHASE_OVERRIDE_LEGACY_RECORD_INVALID");
    }
    const shopId = isScopedShopId(input.shopId ?? input.shop_id);
    if (!shopId) throw new Error("PURCHASE_OVERRIDE_LEGACY_SHOP_SCOPE_REQUIRED");
    const raw = pickPlainObject(input.raw);
    const override = normalizeOverride({ ...input, shopId, raw });
    if (!override.orderKey) throw new Error("PURCHASE_OVERRIDE_LEGACY_ORDER_KEY_REQUIRED");
    return {
      ...override,
      updatedAt: normalizeLegacyUpdatedAt(input.updatedAt ?? input.updated_at),
    };
  }

  function importLegacyOverrides(inputs = []) {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new Error("PURCHASE_OVERRIDE_LEGACY_IMPORT_REQUIRED");
    }
    const identities = new Set();
    const prepared = inputs.map((input) => {
      const override = prepareLegacyOverride(input);
      const identity = `${override.shopId}\u001f${override.orderKey}`;
      if (identities.has(identity)) {
        throw new Error("PURCHASE_OVERRIDE_LEGACY_RECORD_DUPLICATE");
      }
      identities.add(identity);
      return override;
    });
    const timestamp = nowIso();
    const upsert = db.prepare(
      `
      INSERT INTO purchase_order_overrides (
        id, shop_id, order_key, posting_number, ozon_order_id, offer_id, sku,
        purchase_platform, purchase_order_number, purchase_order_url, source_cost_cny, manual_status,
        material_source_json, note, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, order_key) DO UPDATE SET
        posting_number = COALESCE(excluded.posting_number, purchase_order_overrides.posting_number),
        ozon_order_id = COALESCE(excluded.ozon_order_id, purchase_order_overrides.ozon_order_id),
        offer_id = COALESCE(excluded.offer_id, purchase_order_overrides.offer_id),
        sku = COALESCE(excluded.sku, purchase_order_overrides.sku),
        purchase_platform = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.purchase_platform, purchase_order_overrides.purchase_platform) END,
        purchase_order_number = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.purchase_order_number, purchase_order_overrides.purchase_order_number) END,
        purchase_order_url = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.purchase_order_url, purchase_order_overrides.purchase_order_url) END,
        source_cost_cny = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.source_cost_cny, purchase_order_overrides.source_cost_cny) END,
        manual_status = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.manual_status, purchase_order_overrides.manual_status) END,
        material_source_json = COALESCE(excluded.material_source_json, purchase_order_overrides.material_source_json),
        note = COALESCE(excluded.note, purchase_order_overrides.note),
        raw_json = COALESCE(excluded.raw_json, purchase_order_overrides.raw_json),
        updated_at = excluded.updated_at
    `,
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      prepared.forEach((row) => {
        const rowTimestamp = row.updatedAt || timestamp;
        upsert.run(
          row.id,
          row.shopId,
          row.orderKey,
          row.postingNumber || null,
          row.ozonOrderId || null,
          row.offerId || null,
          row.sku || null,
          row.purchasePlatform || null,
          row.purchaseOrderNumber || null,
          row.purchaseOrderUrl || null,
          row.sourceCostCny,
          row.manualStatus || null,
          compactJson(row.materialSource),
          row.note || null,
          compactJson(row.raw),
          rowTimestamp,
          rowTimestamp,
          row.clearFields.has("purchasePlatform") ? 1 : 0,
          row.clearFields.has("purchaseOrderNumber") ? 1 : 0,
          row.clearFields.has("purchaseOrderUrl") ? 1 : 0,
          row.clearFields.has("sourceCostCny") ? 1 : 0,
          row.clearFields.has("manualStatus") ? 1 : 0,
        );
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      ok: true,
      importedCount: prepared.length,
      scopeCount: new Set(prepared.map((row) => row.shopId)).size,
      digest: createStableHash(
        prepared.map((row) => ({
          shopId: row.shopId,
          orderKey: row.orderKey,
          updatedAt: row.updatedAt || "",
        })),
      ),
    };
  }

  function upsertOverride(input = {}) {
    const row = normalizeOverride(input);
    if (!isScopedShopId(row.shopId)) {
      throw new Error("PURCHASE_OVERRIDE_SHOP_SCOPE_REQUIRED");
    }
    const existingRawRow = db.prepare(
      "SELECT raw_json FROM purchase_order_overrides WHERE shop_id = ? AND order_key = ?",
    ).get(row.shopId, row.orderKey);
    const existingRaw = parseJson(existingRawRow?.raw_json, {});
    PURCHASE_DOMESTIC_LOGISTICS_FIELDS.forEach((field) => {
      if (!hasPublicFieldValue(row.raw[field]) && hasPublicFieldValue(existingRaw[field])) {
        row.raw[field] = existingRaw[field];
      }
    });
    const timestamp = row.updatedAt || nowIso();
    db.prepare(
      `
      INSERT INTO purchase_order_overrides (
        id, shop_id, order_key, posting_number, ozon_order_id, offer_id, sku,
        purchase_platform, purchase_order_number, purchase_order_url, source_cost_cny, manual_status,
        material_source_json, note, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, order_key) DO UPDATE SET
        posting_number = COALESCE(excluded.posting_number, purchase_order_overrides.posting_number),
        ozon_order_id = COALESCE(excluded.ozon_order_id, purchase_order_overrides.ozon_order_id),
        offer_id = COALESCE(excluded.offer_id, purchase_order_overrides.offer_id),
        sku = COALESCE(excluded.sku, purchase_order_overrides.sku),
        purchase_platform = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.purchase_platform, purchase_order_overrides.purchase_platform) END,
        purchase_order_number = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.purchase_order_number, purchase_order_overrides.purchase_order_number) END,
        purchase_order_url = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.purchase_order_url, purchase_order_overrides.purchase_order_url) END,
        source_cost_cny = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.source_cost_cny, purchase_order_overrides.source_cost_cny) END,
        manual_status = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(excluded.manual_status, purchase_order_overrides.manual_status) END,
        material_source_json = COALESCE(excluded.material_source_json, purchase_order_overrides.material_source_json),
        note = COALESCE(excluded.note, purchase_order_overrides.note),
        raw_json = COALESCE(excluded.raw_json, purchase_order_overrides.raw_json),
        updated_at = excluded.updated_at
    `,
    ).run(
      row.id,
      row.shopId || "",
      row.orderKey,
      row.postingNumber || null,
      row.ozonOrderId || null,
      row.offerId || null,
      row.sku || null,
      row.purchasePlatform || null,
      row.purchaseOrderNumber || null,
      row.purchaseOrderUrl || null,
      row.sourceCostCny,
      row.manualStatus || null,
      compactJson(row.materialSource),
      row.note || null,
      compactJson(row.raw),
      timestamp,
      timestamp,
      row.clearFields.has("purchasePlatform") ? 1 : 0,
      row.clearFields.has("purchaseOrderNumber") ? 1 : 0,
      row.clearFields.has("purchaseOrderUrl") ? 1 : 0,
      row.clearFields.has("sourceCostCny") ? 1 : 0,
      row.clearFields.has("manualStatus") ? 1 : 0,
    );
    return {
      ok: true,
      override: getOverride({ shopId: row.shopId, orderKey: row.orderKey }),
    };
  }

  function getOverride(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const orderKey = resolveOrderKey(query);
    if (!orderKey) return null;
    const row = db
      .prepare(
        `
      SELECT * FROM purchase_order_overrides
      WHERE COALESCE(shop_id, '') = COALESCE(?, '') AND order_key = ?
    `,
      )
      .get(shopId || "", orderKey);
    return row ? toPublicOverride(row) : null;
  }

  function listOverrides(query = {}) {
    const cursorMode = normalizeText(query.cursorMode) === "legacy-migration";
    const cursor = cursorMode ? decodePurchaseOverrideCursor(query.cursor) : null;
    if (cursorMode && normalizeLegacyCursorText(query.cursor) && !cursor) {
      throw new Error("PURCHASE_OVERRIDE_CURSOR_INVALID");
    }
    const pageSize = normalizePageSize(query.pageSize ?? query.limit, 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const keyword = normalizeText(query.keyword ?? query.q);
    const where = ["1 = 1"];
    const params = [];
    if (shopId && !["all", "*"].includes(shopId.toLowerCase())) {
      where.push("shop_id = ?");
      params.push(shopId);
    }
    if (keyword) {
      where.push(
        "(order_key LIKE ? OR posting_number LIKE ? OR ozon_order_id LIKE ? OR purchase_order_number LIKE ? OR purchase_order_url LIKE ? OR sku LIKE ?)",
      );
      const like = `%${keyword}%`;
      params.push(like, like, like, like, like, like);
    }
    const baseClause = `WHERE ${where.join(" AND ")}`;
    const total = db
      .prepare(
        `SELECT COUNT(*) AS total FROM purchase_order_overrides ${baseClause}`,
      )
      .get(...params).total;
    if (cursor) {
      where.push(
        "(COALESCE(shop_id, '') > ? OR (COALESCE(shop_id, '') = ? AND order_key > ?))",
      );
      params.push(cursor.shopId, cursor.shopId, cursor.orderKey);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    if (cursorMode) {
      const candidates = db
        .prepare(
          `
          SELECT * FROM purchase_order_overrides
          ${clause}
          ORDER BY COALESCE(shop_id, '') ASC, order_key ASC
          LIMIT ?
        `,
        )
        .all(...params, pageSize + 1);
      const hasMore = candidates.length > pageSize;
      const rows = candidates.slice(0, pageSize);
      const tail = rows.at(-1);
      return {
        ok: true,
        rows: rows.map(toPublicOverride),
        total: Number(total) || 0,
        hasMore,
        nextCursor: hasMore && tail ? encodePurchaseOverrideCursor(tail) : "",
      };
    }
    const rows = db
      .prepare(
        `
      SELECT * FROM purchase_order_overrides
      ${clause}
      ORDER BY updated_at DESC, order_key ASC
      LIMIT ? OFFSET ?
    `,
      )
      .all(...params, pageSize, offset);
    return {
      ok: true,
      rows: rows.map(toPublicOverride),
      page,
      pageSize,
      offset,
      total: Number(total) || 0,
    };
  }

  function deleteOverride(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const orderKey = resolveOrderKey(query);
    if (!orderKey)
      throw new Error(
        "orderKey/postingNumber is required for deleting purchase order override.",
      );
    const result = db
      .prepare(
        `
      DELETE FROM purchase_order_overrides
      WHERE COALESCE(shop_id, '') = COALESCE(?, '') AND order_key = ?
    `,
      )
      .run(shopId || "", orderKey);
    return { ok: true, deleted: result.changes || 0, orderKey };
  }

  return {
    upsertOverride,
    importLegacyOverrides,
    getOverride,
    listOverrides,
    deleteOverride,
  };
}

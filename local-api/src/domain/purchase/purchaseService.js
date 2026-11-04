import { createPurchaseOrderOverrideRepository } from "../../db/repositories/purchaseOrderOverrideRepository.js";
import { createPurchaseSourceLinkRepository } from "../../db/repositories/purchaseSourceLinkRepository.js";
import { createCrossBorderOrderRepository } from "../../db/repositories/crossBorderOrderRepository.js";

const EMPTY_PURCHASE_VALUE = new Set([
  "",
  "-",
  "--",
  "未返回",
  "待确认",
  "待补录",
  "待拍单",
  "null",
  "undefined",
  "0",
]);

function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function normalizeLookupKey(value) {
  const text = normalizeText(value);
  return text &&
    !EMPTY_PURCHASE_VALUE.has(text) &&
    !EMPTY_PURCHASE_VALUE.has(text.toLowerCase())
    ? text
    : "";
}

function firstUsable(...values) {
  for (const value of values) {
    const text = normalizeLookupKey(value);
    if (text) return text;
  }
  return "";
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const matched = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!matched) return null;
  const number = Number(matched[0]);
  return Number.isFinite(number) ? number : null;
}

function pickPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stripScopedLookupKey(value = "") {
  const text = normalizeLookupKey(value);
  if (!text || !text.includes(":")) return text;
  return normalizeLookupKey(text.split(":").pop());
}

function uniqueValues(values = []) {
  const seen = new Set();
  return values.map(normalizeLookupKey).filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function normalizeVolumeItem(item = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const length = toFiniteNumber(
    item.length ?? item.long ?? item.lengthCm ?? item.length_cm,
  );
  const width = toFiniteNumber(item.width ?? item.widthCm ?? item.width_cm);
  const height = toFiniteNumber(item.height ?? item.heightCm ?? item.height_cm);
  const grossWeight = toFiniteNumber(
    item.grossWeight ??
      item.gross_weight ??
      item.weight ??
      item.weightKg ??
      item.weight_kg ??
      item.packageWeight,
  );
  const sizeText = firstUsable(item.sizeText, item.packageSize, item.size);
  const weightText = firstUsable(
    item.weightText,
    item.packageWeight,
    item.weight,
  );
  if (!length && !width && !height && !grossWeight && !sizeText && !weightText)
    return null;
  return {
    ...item,
    ...(length ? { length } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(grossWeight ? { grossWeight } : {}),
    ...(sizeText
      ? { sizeText }
      : length && width && height
        ? { sizeText: `${length} x ${width} x ${height} cm` }
        : {}),
    ...(weightText
      ? { weightText }
      : grossWeight
        ? { weightText: `${grossWeight} kg` }
        : {}),
  };
}

function getVolumeItemsFromSource(source, seen = new Set()) {
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    seen.has(source)
  )
    return [];
  seen.add(source);
  const directItems = [
    ...(Array.isArray(source.volumeItems) ? source.volumeItems : []),
    ...(Array.isArray(source.volume_items) ? source.volume_items : []),
    ...(Array.isArray(source.volume) ? source.volume : []),
    ...(Array.isArray(source.packages) ? source.packages : []),
    ...(Array.isArray(source.package_list) ? source.package_list : []),
  ];
  const nestedItems = [
    "outPayload",
    "out_payload",
    "outInfo",
    "out_info",
    "payload",
    "data",
    "result",
  ].flatMap((field) => getVolumeItemsFromSource(source[field], seen));
  return [
    ...directItems.map(normalizeVolumeItem).filter(Boolean),
    ...nestedItems,
  ];
}

function getVolumeItems(...sources) {
  const seenKeys = new Set();
  return sources
    .flatMap((source) => getVolumeItemsFromSource(source))
    .filter((item) => {
      const key = JSON.stringify([
        item.sizeText,
        item.weightText,
        item.length,
        item.width,
        item.height,
        item.grossWeight,
      ]);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
}

function getVolumeSizeText(item = {}) {
  const directText = firstUsable(item.sizeText, item.packageSize, item.size);
  if (directText) return directText;
  const dimensions = [item.length, item.width, item.height]
    .map(toFiniteNumber)
    .filter((value) => value > 0);
  return dimensions.length === 3
    ? `${dimensions[0]} x ${dimensions[1]} x ${dimensions[2]} cm`
    : "";
}

function getVolumeWeightText(item = {}) {
  const directText = firstUsable(
    item.weightText,
    item.packageWeight,
    item.weight,
  );
  if (directText) return directText;
  const weight = toFiniteNumber(
    item.grossWeight ??
      item.gross_weight ??
      item.weight ??
      item.packageWeightKg,
  );
  return weight > 0 ? `${weight} kg` : "";
}

function getOverrideLookupKeys(row = {}) {
  const raw = pickPlainObject(row.raw);
  const nestedSources = [
    row,
    pickPlainObject(row.patch),
    pickPlainObject(row.order),
    raw,
    pickPlainObject(raw.patch),
    pickPlainObject(raw.order),
  ];
  return uniqueValues(
    nestedSources.flatMap((source) => [
      source.packageOrderId,
      source.crossBorderOrderId,
      source.crossBorderOrderNumber,
      source.orderId,
      source.order_id,
      source.recordKey,
      source.record_key,
      source.orderKey,
      source.order_key,
      stripScopedLookupKey(source.orderKey),
      stripScopedLookupKey(source.order_key),
      source.postingNumber,
      source.posting_number,
      stripScopedLookupKey(source.postingNumber),
      stripScopedLookupKey(source.posting_number),
      source.orderNumber,
      source.order_number,
      source.platformOrder,
      source.platform_order,
      source.sheetOrderNumber,
      source.sheet_order_sn,
      source.purchaseOrderNumber,
      source.purchase_order_number,
      source.fromOrder,
      source.from_order,
      source.offerId,
      source.offer_id,
      source.sku,
    ]),
  );
}

function getCrossBorderInfo(source = {}) {
  const raw = pickPlainObject(source.raw);
  const directVolumeItems = getVolumeItems(
    source,
    raw,
    source.outPayload,
    source.out_info,
    source.outInfo,
  );
  const length = toFiniteNumber(
    source.lengthCm ?? source.length_cm ?? source.length,
  );
  const width = toFiniteNumber(
    source.widthCm ?? source.width_cm ?? source.width,
  );
  const height = toFiniteNumber(
    source.heightCm ?? source.height_cm ?? source.height,
  );
  const weight = toFiniteNumber(
    source.packageWeightKg ?? source.package_weight_kg ?? source.packageWeight,
  );
  const volumeItems = directVolumeItems.length
    ? directVolumeItems
    : length && width && height
      ? [
          {
            length,
            width,
            height,
            ...(weight ? { grossWeight: weight } : {}),
            sizeText: `${length} x ${width} x ${height} cm`,
            ...(weight ? { weightText: `${weight} kg` } : {}),
          },
        ]
      : [];
  const primaryVolume = volumeItems[0] ?? {};
  const packageWeight = firstUsable(
    source.packageWeight,
    source.package_weight,
    source.packageWeightKg ? `${source.packageWeightKg} kg` : "",
    source.package_weight_kg ? `${source.package_weight_kg} kg` : "",
    getVolumeWeightText(primaryVolume),
  );
  const packageSize = firstUsable(
    getVolumeSizeText(primaryVolume),
    source.packageSize,
    source.package_size,
    source.lengthCm && source.widthCm && source.heightCm
      ? `${source.lengthCm} x ${source.widthCm} x ${source.heightCm} cm`
      : "",
  );
  return {
    orderId: firstUsable(
      source.orderId,
      source.order_id,
      source.id,
      source.recordKey,
    ),
    readStatus: firstUsable(
      source.readStatus,
      source.read_status,
      source.status,
    ),
    packageWeight,
    packageSize,
    volumeItems,
  };
}

function getCrossBorderRecordScore(record = {}) {
  const info = getCrossBorderInfo(record);
  return (
    (info.volumeItems.length ? 100 : 0) +
    (normalizeLookupKey(info.packageSize) ? 30 : 0) +
    (normalizeLookupKey(info.packageWeight) ? 20 : 0) +
    (normalizeLookupKey(info.readStatus) ? 5 : 0)
  );
}

function buildCrossBorderRecordIndex(records = []) {
  const byKey = new Map();
  (Array.isArray(records) ? records : []).forEach((record) => {
    const score = getCrossBorderRecordScore(record);
    getOverrideLookupKeys(record).forEach((key) => {
      const current = byKey.get(key);
      if (!current || score > current.score) byKey.set(key, { record, score });
    });
  });
  return byKey;
}

function enrichOverridesWithCrossBorderRows(rows = [], crossBorderRows = []) {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    !Array.isArray(crossBorderRows) ||
    !crossBorderRows.length
  )
    return rows;
  const crossBorderIndex = buildCrossBorderRecordIndex(crossBorderRows);
  return rows.map((row) => {
    const matched = getOverrideLookupKeys(row)
      .map((key) => crossBorderIndex.get(key)?.record)
      .find(Boolean);
    if (!matched) return row;
    const rowInfo = getCrossBorderInfo(row);
    const matchedInfo = getCrossBorderInfo(matched);
    const volumeItems = rowInfo.volumeItems.length
      ? rowInfo.volumeItems
      : matchedInfo.volumeItems;
    return {
      ...row,
      crossBorderOrderFound: row.crossBorderOrderFound ?? true,
      packageOrderId: firstUsable(
        row.packageOrderId,
        row.crossBorderOrderId,
        matchedInfo.orderId,
      ),
      crossBorderOrderId: firstUsable(
        row.crossBorderOrderId,
        row.packageOrderId,
        matchedInfo.orderId,
      ),
      readStatus: firstUsable(
        row.readStatus,
        row.crossBorderStatus,
        matchedInfo.readStatus,
      ),
      packageWeight: firstUsable(row.packageWeight, matchedInfo.packageWeight),
      packageSize: firstUsable(row.packageSize, matchedInfo.packageSize),
      volumeItems,
    };
  });
}

function hasTable(db, tableName) {
  try {
    return Boolean(
      db
        ?.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(tableName),
    );
  } catch {
    return false;
  }
}

export function createPurchaseService({ db } = {}) {
  const repository =
    db && hasTable(db, "purchase_order_overrides")
      ? createPurchaseOrderOverrideRepository(db)
      : null;
  const sourceLinkRepository =
    db && hasTable(db, "purchase_source_links")
      ? createPurchaseSourceLinkRepository(db)
      : null;
  const crossBorderRepository =
    db && hasTable(db, "cross_border_order_records")
      ? createCrossBorderOrderRepository(db)
      : null;

  function ensureRepository() {
    if (!repository) {
      const error = new Error(
        "purchase order override SQLite table is not connected.",
      );
      error.code = "PURCHASE_OVERRIDES_NOT_CONNECTED";
      throw error;
    }
    return repository;
  }

  function ensureSourceLinkRepository() {
    if (!sourceLinkRepository) {
      const error = new Error(
        "purchase source links SQLite table is not connected.",
      );
      error.code = "PURCHASE_SOURCE_LINKS_NOT_CONNECTED";
      throw error;
    }
    return sourceLinkRepository;
  }

  function listOrderOverrides(query = {}) {
    const page = ensureRepository().listOverrides(query);
    if (
      !crossBorderRepository ||
      !Array.isArray(page.rows) ||
      !page.rows.length
    )
      return page;
    const lookupKeys = [...new Set(page.rows.flatMap(getOverrideLookupKeys))];
    if (!lookupKeys.length) return page;
    const crossBorderRows = crossBorderRepository.listRecordsByLookupKeys(
      lookupKeys,
      {
        shopId: query.shopId ?? query.shop_id ?? "all",
      },
    );
    return {
      ...page,
      rows: enrichOverridesWithCrossBorderRows(page.rows, crossBorderRows),
    };
  }

  function saveOrderOverride(payload = {}) {
    return ensureRepository().upsertOverride(payload);
  }

  function importLegacyOrderOverrides(payload = {}) {
    const overrides = Array.isArray(payload?.overrides) ? payload.overrides : [];
    return ensureRepository().importLegacyOverrides(overrides);
  }

  function deleteOrderOverride(payload = {}) {
    return ensureRepository().deleteOverride(payload);
  }

  function listSourceLinks(query = {}) {
    return ensureSourceLinkRepository().listLinks(query);
  }

  function saveSourceLinks(payload = {}) {
    return ensureSourceLinkRepository().saveLinks(payload);
  }

  function importLegacySourceLinks(payload = {}) {
    const records = Array.isArray(payload?.records) ? payload.records : [];
    return ensureSourceLinkRepository().importLegacyLinks(records);
  }

  function deleteSourceLinks(payload = {}) {
    return ensureSourceLinkRepository().deleteLinks(payload);
  }

  return {
    domain: "purchase",
    listOrderOverrides,
    saveOrderOverride,
    importLegacyOrderOverrides,
    deleteOrderOverride,
    listSourceLinks,
    saveSourceLinks,
    importLegacySourceLinks,
    deleteSourceLinks,
  };
}

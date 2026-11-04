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
  return text && !["0", "未返回", "????", "undefined", "null"].includes(text)
    ? text
    : "";
}

function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return "";
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(number) ? number : null;
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

function pickArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function pickObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
  }
  return null;
}

function resolveRecordKey(input = {}) {
  return normalizeId(
    firstFilled(
      input.recordKey,
      input.record_key,
      input.orderId,
      input.order_id,
      input.id,
      input.platformOrder,
      input.platform_order,
      input.orderNumber,
      input.order_number,
      input.purchaseOrderNumber,
      input.fromOrder,
      input.from_order,
      input.trackingNumber,
      input.tracking_number,
      input.logisticsOrder,
      input.logistics_order,
      input.sheetOrderNumber,
      input.sheet_order_sn,
    ),
  );
}

function normalizeVolume(input = {}) {
  const directVolumeItems = pickArray(
    input.volumeItems,
    input.volume_items,
    input.packages,
    input.package_list,
    input.outPayload?.volumeItems,
  );
  const outPayloadVolumeItems = pickArray(
    input.outPayload?.volume,
    input.outPayload?.volume_items,
    input.outPayload?.packages,
    input.outPayload?.package_list,
  );
  const volumeItems = directVolumeItems.length
    ? directVolumeItems
    : outPayloadVolumeItems;
  const firstVolume = pickObject(
    volumeItems[0],
    input.package,
    input.parcel,
    input.out_info,
    input.outInfo,
    input.outPayload,
  );
  return {
    volumeItems,
    packageWeightKg: toNumberOrNull(
      firstFilled(
        input.packageWeightKg,
        input.package_weight_kg,
        input.packageWeight,
        input.package_weight,
        input.outPayload?.weight,
        input.outPayload?.package_weight,
        input.outPayload?.packageWeight,
        firstVolume?.weight,
        firstVolume?.grossWeight,
        firstVolume?.gross_weight,
        firstVolume?.weightKg,
        firstVolume?.weight_kg,
        firstVolume?.package_weight,
        input.outPayload?.grossweight,
        input.outPayload?.grossWeight,
        input.outPayload?.chargeweight,
      ),
    ),
    lengthCm: toNumberOrNull(
      firstFilled(
        input.lengthCm,
        input.length_cm,
        input.length,
        input.long,
        firstVolume?.length,
        firstVolume?.long,
        firstVolume?.length_cm,
      ),
    ),
    widthCm: toNumberOrNull(
      firstFilled(
        input.widthCm,
        input.width_cm,
        input.width,
        firstVolume?.width,
        firstVolume?.width_cm,
      ),
    ),
    heightCm: toNumberOrNull(
      firstFilled(
        input.heightCm,
        input.height_cm,
        input.height,
        firstVolume?.height,
        firstVolume?.height_cm,
      ),
    ),
  };
}

function normalizeRecord(input = {}) {
  const shopId = normalizeText(
    firstFilled(
      input.shopId,
      input.shop_id,
      input.shop_id_local,
      input.shopClientId,
      input.clientId,
    ),
  );
  const recordKey = resolveRecordKey(input);
  if (!recordKey)
    throw new Error(
      "recordKey/orderId/platformOrder is required for cross-border order record.",
    );
  const statusPayload = pickObject(
    input.statusPayload,
    input.status_payload,
    input.status_json,
  );
  const outPayload = pickObject(
    input.outPayload,
    input.out_payload,
    input.outInfo,
    input.out_info,
    input.out_info_json,
  );
  const sheetInfo = pickObject(input.sheet_info, input.sheetInfo);
  const packageItems = pickArray(
    input.package_list,
    input.packageList,
    input.packages,
  );
  const firstPackage = pickObject(packageItems[0]);
  const volume = normalizeVolume({ ...input, outPayload });
  const raw = input.raw && typeof input.raw === "object" ? input.raw : input;
  const hashPayload = {
    orderId: firstFilled(input.orderId, input.order_id, input.id),
    platformOrder: firstFilled(
      input.platformOrder,
      input.platform_order,
      input.orderNumber,
      input.order_number,
    ),
    purchaseOrderNumber: firstFilled(
      input.purchaseOrderNumber,
      input.fromOrder,
      input.from_order,
      firstPackage?.from_order,
      firstPackage?.fromOrder,
    ),
    collectionNumber: firstFilled(
      input.collectionNumber,
      input.collection_number,
    ),
    trackingNumber: firstFilled(
      input.trackingNumber,
      input.tracking_number,
      firstPackage?.tracking_number,
      firstPackage?.trackingNumber,
    ),
    logisticsOrder: firstFilled(
      input.logisticsOrder,
      input.logistics_order,
      firstPackage?.logistics_order,
      firstPackage?.logisticsOrder,
    ),
    sheetOrderNumber: firstFilled(
      input.sheetOrderNumber,
      input.sheet_order_sn,
      sheetInfo?.sheet_order_sn,
      sheetInfo?.section_order,
      sheetInfo?.sectionOrder,
    ),
    status: firstFilled(
      input.status,
      input.readStatus,
      input.read_status,
      statusPayload?.status,
    ),
    readStatus: firstFilled(
      input.readStatus,
      input.read_status,
      statusPayload?.read_status,
    ),
    warehouse: firstFilled(
      input.warehouse,
      input.storehouse,
      input.storehouse_name,
      input.storehouseName,
    ),
    routeName: firstFilled(
      input.routeName,
      input.route_name,
      input.logistics,
      input.deliveryMethod,
      input.introduce,
    ),
    actualCrossBorderBusFeeCny: toNumberOrNull(
      input.actualCrossBorderBusFeeCny ?? input.actual_cross_border_bus_fee_cny,
    ),
    actualCrossBorderBusFeeSource: firstFilled(
      input.actualCrossBorderBusFeeSource,
      input.actual_cross_border_bus_fee_source,
    ),
    crossBorderChargeEvidence: pickObject(
      input.crossBorderChargeEvidence,
      input.cross_border_charge_evidence,
    ),
    volume,
    statusPayload,
    outPayload,
  };
  return {
    id: `cross_border_${createStableHash({ shopId, recordKey }, { length: 32 })}`,
    shopId,
    recordKey,
    orderId: normalizeId(hashPayload.orderId),
    platformOrder: normalizeId(hashPayload.platformOrder),
    purchaseOrderNumber: normalizeId(hashPayload.purchaseOrderNumber),
    collectionNumber: normalizeId(hashPayload.collectionNumber),
    trackingNumber: normalizeId(hashPayload.trackingNumber),
    logisticsOrder: normalizeId(hashPayload.logisticsOrder),
    sheetOrderNumber: normalizeId(hashPayload.sheetOrderNumber),
    offerId: normalizeId(firstFilled(input.offerId, input.offer_id)),
    sku: normalizeId(input.sku),
    status: normalizeText(hashPayload.status),
    readStatus: normalizeText(hashPayload.readStatus),
    warehouse: normalizeText(hashPayload.warehouse),
    routeName: normalizeText(hashPayload.routeName),
    ...volume,
    statusPayload,
    outPayload,
    raw,
    remoteHash: createStableHash(hashPayload, { length: 40 }),
  };
}

function toPublicRecord(row = {}) {
  const raw = parseJson(row.raw_json, {});
  const statusPayload = parseJson(row.status_json, null);
  const outPayload = parseJson(row.out_info_json, null);
  const persistedVolumeItems = parseJson(row.volume_items_json, []);
  const derivedVolume = normalizeVolume({
    volumeItems: persistedVolumeItems,
    outPayload,
    packageWeightKg: row.package_weight_kg,
    lengthCm: row.length_cm,
    widthCm: row.width_cm,
    heightCm: row.height_cm,
  });
  const volumeItems = persistedVolumeItems.length
    ? persistedVolumeItems
    : derivedVolume.volumeItems;
  const packageWeightKg =
    row.package_weight_kg ?? derivedVolume.packageWeightKg;
  const lengthCm = row.length_cm ?? derivedVolume.lengthCm;
  const widthCm = row.width_cm ?? derivedVolume.widthCm;
  const heightCm = row.height_cm ?? derivedVolume.heightCm;
  return {
    ...raw,
    id: row.order_id || row.id,
    recordId: row.id,
    remoteHash: row.remote_hash || "",
    shopId: row.shop_id || "",
    recordKey: row.record_key,
    order_id: row.order_id || "",
    orderId: row.order_id || "",
    order_number: row.platform_order || "",
    orderNumber: row.platform_order || "",
    platform_order: row.platform_order || "",
    platformOrder: row.platform_order || "",
    from_order: row.purchase_order_number || "",
    fromOrder: row.purchase_order_number || "",
    purchaseOrderNumber: row.purchase_order_number || "",
    collection_number: row.collection_number || "",
    collectionNumber: row.collection_number || "",
    tracking_number: row.tracking_number || "",
    trackingNumber: row.tracking_number || "",
    logistics_order: row.logistics_order || "",
    logisticsOrder: row.logistics_order || "",
    sheet_order_sn: row.sheet_order_sn || "",
    sheetOrderNumber: row.sheet_order_sn || "",
    offerId: row.offer_id || "",
    offer_id: row.offer_id || "",
    sku: row.sku || "",
    status: row.status || "",
    readStatus: row.read_status || "",
    read_status: row.read_status || "",
    warehouse: row.warehouse || "",
    routeName: row.route_name || "",
    route_name: row.route_name || "",
    packageWeightKg,
    package_weight_kg: packageWeightKg,
    lengthCm,
    length_cm: lengthCm,
    widthCm,
    width_cm: widthCm,
    heightCm,
    height_cm: heightCm,
    volumeItems,
    volume_items: volumeItems,
    statusPayload,
    outPayload,
    isStale: Boolean(row.is_stale),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    source: "cross-border-bus",
  };
}

function normalizePageSize(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

export function createCrossBorderOrderRepository(db) {
  function getRecord(query = {}) {
    const shopId = normalizeText(
      query.shopId ?? query.shop_id ?? query.shopClientId,
    );
    const recordKey = resolveRecordKey(query);
    if (!recordKey) return null;
    const row = db
      .prepare(
        `
      SELECT * FROM cross_border_order_records
      WHERE shop_id = COALESCE(?, '') AND record_key = ?
    `,
      )
      .get(shopId || "", recordKey);
    return row ? toPublicRecord(row) : null;
  }

  function upsertRecord(input = {}) {
    const row = normalizeRecord(input);
    const existing = getRecord({
      shopId: row.shopId,
      recordKey: row.recordKey,
    });
    const timestamp = nowIso();
    if (existing?.recordId && existing.remoteHash === row.remoteHash) {
      db.prepare(
        `
        UPDATE cross_border_order_records
        SET last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(timestamp, timestamp, existing.recordId);
      return {
        ok: true,
        record: getRecord({ shopId: row.shopId, recordKey: row.recordKey }),
        unchanged: true,
      };
    }

    db.prepare(
      `
      INSERT INTO cross_border_order_records (
        id, shop_id, record_key, order_id, platform_order, purchase_order_number,
        collection_number, tracking_number, logistics_order, sheet_order_sn, offer_id, sku,
        status, read_status, warehouse, route_name, package_weight_kg, length_cm, width_cm, height_cm,
        volume_items_json, status_json, out_info_json, raw_json, remote_hash, is_stale,
        last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(shop_id, record_key) DO UPDATE SET
        order_id = COALESCE(excluded.order_id, cross_border_order_records.order_id),
        platform_order = COALESCE(excluded.platform_order, cross_border_order_records.platform_order),
        purchase_order_number = COALESCE(excluded.purchase_order_number, cross_border_order_records.purchase_order_number),
        collection_number = COALESCE(excluded.collection_number, cross_border_order_records.collection_number),
        tracking_number = COALESCE(excluded.tracking_number, cross_border_order_records.tracking_number),
        logistics_order = COALESCE(excluded.logistics_order, cross_border_order_records.logistics_order),
        sheet_order_sn = COALESCE(excluded.sheet_order_sn, cross_border_order_records.sheet_order_sn),
        offer_id = COALESCE(excluded.offer_id, cross_border_order_records.offer_id),
        sku = COALESCE(excluded.sku, cross_border_order_records.sku),
        status = COALESCE(excluded.status, cross_border_order_records.status),
        read_status = COALESCE(excluded.read_status, cross_border_order_records.read_status),
        warehouse = COALESCE(excluded.warehouse, cross_border_order_records.warehouse),
        route_name = COALESCE(excluded.route_name, cross_border_order_records.route_name),
        package_weight_kg = COALESCE(excluded.package_weight_kg, cross_border_order_records.package_weight_kg),
        length_cm = COALESCE(excluded.length_cm, cross_border_order_records.length_cm),
        width_cm = COALESCE(excluded.width_cm, cross_border_order_records.width_cm),
        height_cm = COALESCE(excluded.height_cm, cross_border_order_records.height_cm),
        volume_items_json = COALESCE(excluded.volume_items_json, cross_border_order_records.volume_items_json),
        status_json = COALESCE(excluded.status_json, cross_border_order_records.status_json),
        out_info_json = COALESCE(excluded.out_info_json, cross_border_order_records.out_info_json),
        raw_json = COALESCE(excluded.raw_json, cross_border_order_records.raw_json),
        remote_hash = COALESCE(excluded.remote_hash, cross_border_order_records.remote_hash),
        is_stale = 0,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `,
    ).run(
      row.id,
      row.shopId || "",
      row.recordKey,
      row.orderId || null,
      row.platformOrder || null,
      row.purchaseOrderNumber || null,
      row.collectionNumber || null,
      row.trackingNumber || null,
      row.logisticsOrder || null,
      row.sheetOrderNumber || null,
      row.offerId || null,
      row.sku || null,
      row.status || null,
      row.readStatus || null,
      row.warehouse || null,
      row.routeName || null,
      row.packageWeightKg,
      row.lengthCm,
      row.widthCm,
      row.heightCm,
      row.volumeItems.length ? compactJson(row.volumeItems) : null,
      compactJson(row.statusPayload),
      compactJson(row.outPayload),
      compactJson(row.raw),
      row.remoteHash,
      timestamp,
      timestamp,
      timestamp,
    );
    return {
      ok: true,
      record: getRecord({ shopId: row.shopId, recordKey: row.recordKey }),
      unchanged: false,
    };
  }

  function upsertRecords(input = {}) {
    const records = Array.isArray(input)
      ? input
      : Array.isArray(input.records)
        ? input.records
        : Array.isArray(input.items)
          ? input.items
          : [];
    const context = Array.isArray(input) ? {} : input;
    const saved = records
      .map((record) =>
        upsertRecord({
          ...record,
          shopId:
            record.shopId ??
            record.shop_id ??
            context.shopId ??
            context.shop_id,
        }),
      )
      .map((result) => result.record);
    return { ok: true, rows: saved, total: saved.length };
  }

  function listRecords(query = {}) {
    const pageSize = normalizePageSize(query.pageSize ?? query.limit, 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const shopId = normalizeText(
      query.shopId ?? query.shop_id ?? query.shopClientId,
    );
    const keyword = normalizeText(query.keyword ?? query.q ?? query.search);
    const exactOrderId = normalizeText(query.orderId ?? query.order_id);
    const exactPlatformOrder = normalizeText(
      query.platformOrder ??
        query.platform_order ??
        query.orderNumber ??
        query.order_number,
    );
    const where = ["is_stale = 0"];
    const params = [];
    if (shopId && !["all", "*"].includes(shopId.toLowerCase())) {
      where.push("shop_id = ?");
      params.push(shopId);
    }
    if (exactOrderId) {
      where.push("(order_id = ? OR record_key = ?)");
      params.push(exactOrderId, exactOrderId);
    }
    if (exactPlatformOrder) {
      where.push("(platform_order = ? OR record_key = ?)");
      params.push(exactPlatformOrder, exactPlatformOrder);
    }
    if (keyword) {
      where.push(`(
        record_key LIKE ? OR order_id LIKE ? OR platform_order LIKE ? OR purchase_order_number LIKE ?
        OR collection_number LIKE ? OR tracking_number LIKE ? OR logistics_order LIKE ? OR sheet_order_sn LIKE ? OR offer_id LIKE ? OR sku LIKE ?
      )`);
      const like = `%${keyword}%`;
      params.push(like, like, like, like, like, like, like, like, like, like);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = db
      .prepare(
        `SELECT COUNT(*) AS total FROM cross_border_order_records ${clause}`,
      )
      .get(...params).total;
    const rows = db
      .prepare(
        `
      SELECT * FROM cross_border_order_records
      ${clause}
      ORDER BY updated_at DESC, record_key ASC
      LIMIT ? OFFSET ?
    `,
      )
      .all(...params, pageSize, offset);
    return {
      ok: true,
      rows: rows.map(toPublicRecord),
      page,
      pageSize,
      offset,
      total: Number(total) || 0,
    };
  }

  function listRecordsByLookupKeys(keys = [], query = {}) {
    const lookupKeys = [
      ...new Set(
        (Array.isArray(keys) ? keys : [])
          .flatMap((value) => {
            const key = normalizeId(value);
            return key && key.includes(":")
              ? [key, key.split(":").pop()]
              : [key];
          })
          .map(normalizeId)
          .filter(Boolean),
      ),
    ].slice(0, 500);
    if (!lookupKeys.length) return [];

    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const lookupColumns = [
      "record_key",
      "order_id",
      "platform_order",
      "purchase_order_number",
      "collection_number",
      "tracking_number",
      "logistics_order",
      "sheet_order_sn",
      "offer_id",
      "sku",
    ];
    const placeholders = lookupKeys.map(() => "?").join(", ");
    const where = [
      "is_stale = 0",
      `(${lookupColumns.map((column) => `${column} IN (${placeholders})`).join(" OR ")})`,
    ];
    const params = lookupColumns.flatMap(() => lookupKeys);
    if (shopId && !["all", "*"].includes(shopId.toLowerCase())) {
      where.unshift("shop_id = ?");
      params.unshift(shopId);
    }

    return db
      .prepare(
        `
      SELECT * FROM cross_border_order_records
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, record_key ASC
      LIMIT 1000
    `,
      )
      .all(...params)
      .map(toPublicRecord);
  }

  function deleteRecord(query = {}) {
    const shopId = normalizeText(
      query.shopId ?? query.shop_id ?? query.shopClientId,
    );
    const recordKey = resolveRecordKey(query);
    if (!recordKey)
      throw new Error(
        "recordKey/orderId/platformOrder is required for deleting cross-border order record.",
      );
    const result = db
      .prepare(
        `
      DELETE FROM cross_border_order_records
      WHERE shop_id = COALESCE(?, '') AND record_key = ?
    `,
      )
      .run(shopId || "", recordKey);
    return { ok: true, deleted: result.changes || 0, recordKey };
  }

  return {
    upsertRecord,
    upsertRecords,
    getRecord,
    listRecords,
    listRecordsByLookupKeys,
    deleteRecord,
  };
}

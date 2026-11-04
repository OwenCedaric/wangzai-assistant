import { createSupportRowId } from "../db/repositories/productSupportModel.js";
import { createStableHash, stableStringify } from "../utils/stableHash.js";
import {
  assertRequiredSchema,
  CROSS_BORDER_COLUMNS,
  CROSS_BORDER_FILL_MISSING_COLUMNS,
  DEFAULT_REBOUND_SHOP_RECOVERY_EXPECTED_COUNTS,
  fail,
  isEmptyValue,
  normalizeText,
  PRODUCT_SOURCE_LINK_COLUMNS,
  PURCHASE_OVERRIDE_COLUMNS,
  PURCHASE_OVERRIDE_RICHNESS_COLUMNS,
  PURCHASE_SOURCE_LINK_COLUMNS,
  RECOVERY_VERSION,
  requiredText,
} from "./reboundShopRecoveryRules.js";

export function canonicalizeOrderKey(value, clientId) {
  const normalized = normalizeText(value);
  const prefix = `${clientId}:`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

export function scopeOrderKey(value, clientId) {
  const canonical = canonicalizeOrderKey(value, clientId);
  return canonical ? `${clientId}:${canonical}` : '';
}

export function getCurrentOrderIdentity(row = {}) {
  return normalizeText(row.id)
    || stableStringify([row.order_key, row.posting_number, row.order_id]);
}

export function buildCurrentOrderIndex(rows, clientId) {
  const byCanonicalKey = new Map();
  for (const row of rows) {
    const identity = getCurrentOrderIdentity(row);
    for (const value of [row.order_key, row.posting_number, row.order_id]) {
      const canonical = canonicalizeOrderKey(value, clientId);
      if (!canonical) continue;
      if (!byCanonicalKey.has(canonical)) byCanonicalKey.set(canonical, new Map());
      byCanonicalKey.get(canonical).set(identity, row);
    }
  }
  return byCanonicalKey;
}

export function resolveCurrentOrderCandidates(values, currentOrderIndex, clientId) {
  const matches = new Map();
  for (const value of values) {
    const canonical = canonicalizeOrderKey(value, clientId);
    if (!canonical) continue;
    for (const [identity, row] of currentOrderIndex.get(canonical) || []) {
      matches.set(identity, row);
    }
  }
  return [...matches.values()];
}

export function getPreferredCurrentOrderKey(row = {}, clientId) {
  return canonicalizeOrderKey(
    row.posting_number || row.order_key || row.order_id,
    clientId,
  );
}

export function countJsonLeaves(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countJsonLeaves(item), 0);
  if (!value || typeof value !== 'object') return isEmptyValue(value) ? 0 : 1;
  return Object.values(value).reduce((total, item) => total + countJsonLeaves(item), 0);
}

export function parseJson(value) {
  if (isEmptyValue(value)) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function collectOrderReferences(objects, fields) {
  return [...new Set(objects.flatMap((object) => fields.map((field) => {
    const value = asPlainObject(object)[field];
    return value !== null && value !== undefined && typeof value !== 'object'
      ? normalizeText(value)
      : '';
  })).filter(Boolean))];
}

export function getCrossBorderRawOrderCandidateGroups(jsonValue) {
  const raw = asPlainObject(parseJson(jsonValue));
  const payload = asPlainObject(raw.payload);
  const data = asPlainObject(raw.data);
  const result = asPlainObject(raw.result);
  const sheetInfoObjects = [
    raw.sheet_info,
    raw.sheetInfo,
    payload.sheet_info,
    payload.sheetInfo,
    data.sheet_info,
    data.sheetInfo,
    result.sheet_info,
    result.sheetInfo,
  ];
  // `body.section_code` belongs to the order.outInfo request payload. It records
  // what was queried, not which Ozon order the returned bus record belongs to.
  const directObjects = [raw, payload, data, result];
  return [
    collectOrderReferences(sheetInfoObjects, [
      'sheet_order_sn',
      'sheetOrderSn',
      'sheetOrderNumber',
      'section_order',
      'sectionOrder',
    ]),
    collectOrderReferences(directObjects, [
      'sheet_order_sn',
      'sheetOrderSn',
      'sheetOrderNumber',
      'section_order',
      'sectionOrder',
    ]),
  ].filter((group) => group.length);
}

export function purchaseOverrideRichness(row) {
  const direct = PURCHASE_OVERRIDE_RICHNESS_COLUMNS
    .reduce((total, column) => total + (isEmptyValue(row[column]) ? 0 : 1), 0);
  return {
    direct,
    rawLeaves: countJsonLeaves(parseJson(row.raw_json)),
    rawLength: normalizeText(row.raw_json).length,
    updatedAt: Date.parse(row.updated_at || '') || 0,
  };
}

export function compareRichness(left, right) {
  for (const field of ['direct', 'rawLeaves', 'rawLength', 'updatedAt']) {
    if (left[field] !== right[field]) return right[field] - left[field];
  }
  return 0;
}

export function stableRowEquals(left, right, columns) {
  if (!left || !right) return false;
  return columns.every((column) => stableStringify(left[column] ?? null) === stableStringify(right[column] ?? null));
}

export function rowDigest(row, columns) {
  return createStableHash(Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
}

export function minTimestamp(rows, column, fallback) {
  const values = rows.map((row) => normalizeText(row[column])).filter(Boolean).sort();
  return values[0] || fallback;
}

export function maxTimestamp(rows, column, fallback) {
  const values = rows.map((row) => normalizeText(row[column])).filter(Boolean).sort();
  return values.at(-1) || fallback;
}

export function mergePurchaseOverrideGroup(rows, { newShopId, clientId }) {
  const ranked = rows
    .map((row) => ({ row, richness: purchaseOverrideRichness(row) }))
    .sort((left, right) => compareRichness(left.richness, right.richness));
  const winner = { ...ranked[0].row };
  for (const { row } of ranked.slice(1)) {
    for (const column of PURCHASE_OVERRIDE_COLUMNS) {
      if (['id', 'shop_id', 'order_key', 'posting_number', 'raw_json', 'created_at', 'updated_at'].includes(column)) {
        continue;
      }
      if (isEmptyValue(winner[column]) && !isEmptyValue(row[column])) winner[column] = row[column];
    }
  }
  const orderKey = scopeOrderKey(winner.order_key, clientId);
  const timestamp = new Date(0).toISOString();
  winner.id = `purchase_override_${createStableHash({ shopId: newShopId, orderKey }, { length: 32 })}`;
  winner.shop_id = newShopId;
  winner.order_key = orderKey;
  winner.posting_number = orderKey;
  winner.created_at = minTimestamp(rows, 'created_at', timestamp);
  winner.updated_at = maxTimestamp(rows, 'updated_at', winner.created_at);
  return winner;
}

export function validatePurchaseOverrideDuplicateGroup(rows, issues) {
  if (rows.length <= 1) return;
  const directCounts = rows.map((row) => PURCHASE_OVERRIDE_RICHNESS_COLUMNS
    .reduce((count, column) => count + (isEmptyValue(row[column]) ? 0 : 1), 0));
  const placeholderCount = directCounts.filter((count) => count === 0).length;
  if (rows.length !== 2 || placeholderCount !== 1 || directCounts.every((count) => count === 0)) {
    issues.push('PURCHASE_OVERRIDE_DUPLICATE_SHAPE_UNSAFE');
  }
  for (const column of PURCHASE_OVERRIDE_RICHNESS_COLUMNS) {
    const values = rows
      .map((row) => row[column])
      .filter((value) => !isEmptyValue(value))
      .map((value) => stableStringify(value));
    if (new Set(values).size > 1) {
      issues.push('PURCHASE_OVERRIDE_DUPLICATE_NONEMPTY_CONFLICT');
      break;
    }
  }
}

export function groupBy(rows, keyBuilder) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyBuilder(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

export function indexUnique(rows, keyBuilder) {
  const result = new Map();
  for (const row of rows) {
    const key = keyBuilder(row);
    if (!key) continue;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

export function classifyExpectedRows({ expectedRows, targetRows, columns, keyBuilder }) {
  const targetByKey = indexUnique(targetRows, keyBuilder);
  const inserts = [];
  const unchanged = [];
  const conflicts = [];
  for (const expected of expectedRows) {
    const key = keyBuilder(expected);
    const matches = targetByKey.get(key) || [];
    if (!matches.length) {
      inserts.push(expected);
      continue;
    }
    if (matches.length === 1 && stableRowEquals(matches[0], expected, columns)) {
      unchanged.push(expected);
      continue;
    }
    conflicts.push(expected);
  }
  return { inserts, unchanged, conflicts };
}

export function isUnscopedOrderKey(value, clientId) {
  const normalized = normalizeText(value);
  return Boolean(normalized && normalized === canonicalizeOrderKey(normalized, clientId));
}

export function isEquivalentLegacyUnscopedPurchaseOverride(current, expected, clientId) {
  if (!current || !expected) return false;
  if (normalizeText(current.shop_id) !== normalizeText(expected.shop_id)) return false;
  if (!isUnscopedOrderKey(current.order_key, clientId)) return false;
  const expectedCanonical = canonicalizeOrderKey(expected.order_key, clientId);
  if (canonicalizeOrderKey(current.order_key, clientId) !== expectedCanonical) return false;
  if (canonicalizeOrderKey(current.posting_number || current.order_key, clientId) !== expectedCanonical) {
    return false;
  }
  return PURCHASE_OVERRIDE_COLUMNS
    .filter((column) => !['id', 'order_key', 'posting_number'].includes(column))
    .every((column) => (
      stableStringify(current[column] ?? null) === stableStringify(expected[column] ?? null)
    ));
}

export function classifyPurchaseOverrideRows({ expectedRows, targetRows, clientId, issues }) {
  const targetByCanonical = groupBy(
    targetRows,
    (row) => canonicalizeOrderKey(row.order_key, clientId),
  );
  const expectedCanonicalKeys = new Set(
    expectedRows.map((row) => canonicalizeOrderKey(row.order_key, clientId)),
  );
  if (targetRows.some((row) => !canonicalizeOrderKey(row.order_key, clientId))) {
    issues.push('PURCHASE_OVERRIDE_TARGET_ORDER_KEY_EMPTY');
  }
  if ([...targetByCanonical.entries()].some(([key, rows]) => key && rows.length > 1)) {
    issues.push('PURCHASE_OVERRIDE_TARGET_LOGICAL_DUPLICATE');
  }
  if ([...targetByCanonical.keys()].some((key) => key && !expectedCanonicalKeys.has(key))) {
    issues.push('PURCHASE_OVERRIDE_TARGET_EXTRA_ROWS');
  }

  const inserts = [];
  const unchanged = [];
  const rekeys = [];
  const conflicts = [];
  for (const expected of expectedRows) {
    const canonical = canonicalizeOrderKey(expected.order_key, clientId);
    const matches = targetByCanonical.get(canonical) || [];
    if (!matches.length) {
      inserts.push(expected);
      continue;
    }
    if (matches.length !== 1) {
      conflicts.push(expected);
      continue;
    }
    const current = matches[0];
    if (stableRowEquals(current, expected, PURCHASE_OVERRIDE_COLUMNS)) {
      unchanged.push(expected);
      continue;
    }
    if (isEquivalentLegacyUnscopedPurchaseOverride(current, expected, clientId)) {
      rekeys.push({ current, expected });
      continue;
    }
    conflicts.push(expected);
  }
  return { inserts, unchanged, rekeys, conflicts };
}

export function buildIdentityPlan(sourceDb, targetDb, context, issues) {
  const sourceShop = sourceDb
    .prepare('SELECT id, client_id, status FROM shops WHERE id = ? LIMIT 1')
    .get(context.oldShopId);
  const targetShop = targetDb
    .prepare(`
      SELECT id, client_id, profile_id, external_identity_hash,
             shop_incarnation, credential_revision, status
      FROM shops WHERE id = ? LIMIT 1
    `)
    .get(context.newShopId);
  const oldTargetShop = targetDb.prepare('SELECT 1 AS present FROM shops WHERE id = ? LIMIT 1')
    .get(context.oldShopId);
  // A rebind may move the active shop from the legacy `default` profile id to
  // the durable desktop profile UUID. The external identity hash, not the
  // mutable profile label, is the cross-incarnation proof.
  const tombstoneCandidates = targetDb.prepare(`
    SELECT former_shop_id, external_identity_hash, former_shop_incarnation,
           final_credential_revision
    FROM shop_identity_tombstones
    WHERE former_shop_id = ?
    ORDER BY deleted_at DESC
  `).all(context.oldShopId);
  const matchingTombstones = targetShop
    ? tombstoneCandidates.filter((candidate) => (
        normalizeText(candidate.external_identity_hash)
        && candidate.external_identity_hash === targetShop.external_identity_hash
      ))
    : [];
  const tombstone = matchingTombstones.length === 1 ? matchingTombstones[0] : null;

  if (!sourceShop) issues.push('SOURCE_OLD_SHOP_MISSING');
  if (!targetShop) issues.push('TARGET_NEW_SHOP_MISSING');
  if (oldTargetShop) issues.push('TARGET_OLD_SHOP_STILL_PRESENT');
  if (normalizeText(sourceShop?.client_id) !== context.clientId) issues.push('SOURCE_CLIENT_ID_MISMATCH');
  if (normalizeText(targetShop?.client_id) !== context.clientId) issues.push('TARGET_CLIENT_ID_MISMATCH');
  if (!tombstone) {
    issues.push(matchingTombstones.length > 1
      ? 'TARGET_TOMBSTONE_AMBIGUOUS'
      : 'TARGET_TOMBSTONE_MISSING');
  }
  if (
    tombstone
    && targetShop
    && (
      !normalizeText(tombstone.external_identity_hash)
      || tombstone.external_identity_hash !== targetShop.external_identity_hash
    )
  ) {
    issues.push('TARGET_EXTERNAL_IDENTITY_MISMATCH');
  }
  if (
    tombstone
    && targetShop
    && normalizeText(tombstone.former_shop_incarnation) === normalizeText(targetShop.shop_incarnation)
  ) {
    issues.push('TARGET_INCARNATION_NOT_CHANGED');
  }

  return {
    verified: !issues.some((issue) => (
      issue.startsWith('SOURCE_') || issue.startsWith('TARGET_')
    )),
    targetShopFingerprint: targetShop ? createStableHash(targetShop) : '',
  };
}

export function buildPurchaseOverridePlan(sourceDb, targetDb, context, issues) {
  const sourceRows = sourceDb.prepare(
    `SELECT ${PURCHASE_OVERRIDE_COLUMNS.join(', ')}
     FROM purchase_order_overrides WHERE shop_id = ? ORDER BY order_key ASC`,
  ).all(context.oldShopId);
  const groups = groupBy(sourceRows, (row) => canonicalizeOrderKey(row.order_key, context.clientId));
  if (sourceRows.some((row) => {
    const orderKey = canonicalizeOrderKey(row.order_key, context.clientId);
    const postingNumber = canonicalizeOrderKey(row.posting_number, context.clientId);
    return Boolean(orderKey && postingNumber && orderKey !== postingNumber);
  })) {
    issues.push('PURCHASE_OVERRIDE_SOURCE_POSTING_KEY_CONFLICT');
  }
  if (sourceRows.length !== context.expectedCounts.purchaseOverridePhysical) {
    issues.push('PURCHASE_OVERRIDE_SOURCE_COUNT_MISMATCH');
  }
  if (groups.size !== context.expectedCounts.purchaseOverrideCanonical) {
    issues.push('PURCHASE_OVERRIDE_CANONICAL_COUNT_MISMATCH');
  }
  if ([...groups.keys()].some((key) => !key)) issues.push('PURCHASE_OVERRIDE_EMPTY_ORDER_KEY');
  for (const rows of groups.values()) validatePurchaseOverrideDuplicateGroup(rows, issues);

  const expectedRows = [...groups.values()]
    .map((rows) => mergePurchaseOverrideGroup(rows, context))
    .sort((left, right) => left.order_key.localeCompare(right.order_key));
  const targetRows = targetDb.prepare(
    `SELECT ${PURCHASE_OVERRIDE_COLUMNS.join(', ')}
     FROM purchase_order_overrides WHERE shop_id = ? ORDER BY order_key`,
  ).all(context.newShopId);
  const classification = classifyPurchaseOverrideRows({
    expectedRows,
    targetRows,
    clientId: context.clientId,
    issues,
  });
  if (classification.conflicts.length) issues.push('PURCHASE_OVERRIDE_TARGET_CONFLICT');

  const currentOrders = targetDb.prepare(
    'SELECT id, order_key, posting_number, order_id FROM ozon_orders WHERE shop_id = ?',
  ).all(context.newShopId);
  const currentOrderIndex = buildCurrentOrderIndex(currentOrders, context.clientId);
  let currentOrderMatches = 0;
  for (const expected of expectedRows) {
    const matches = resolveCurrentOrderCandidates(
      [expected.order_key],
      currentOrderIndex,
      context.clientId,
    );
    if (matches.length === 1) currentOrderMatches += 1;
    else if (matches.length > 1) {
      issues.push('PURCHASE_OVERRIDE_CURRENT_ORDER_MAPPING_AMBIGUOUS');
    }
  }
  const enrichedCount = expectedRows.filter((row) => (
    !isEmptyValue(row.purchase_platform)
    || !isEmptyValue(row.purchase_order_number)
    || !isEmptyValue(row.source_cost_cny)
  )).length;

  return {
    sourceRows,
    expectedRows,
    targetRows,
    ...classification,
    duplicateRowsMerged: sourceRows.length - groups.size,
    currentOrderMatches,
    enrichedCount,
  };
}

export function resolveProductByOffer(targetProductsByOffer, offerId) {
  const matches = targetProductsByOffer.get(normalizeText(offerId)) || [];
  return matches.length === 1 ? matches[0] : null;
}

export function buildProductSourceLinkPlan(sourceDb, targetDb, context, issues) {
  const sourceRows = sourceDb.prepare(
    `SELECT ${PRODUCT_SOURCE_LINK_COLUMNS.join(', ')}
     FROM product_source_links WHERE shop_id = ? ORDER BY product_key, slot_index`,
  ).all(context.oldShopId);
  if (sourceRows.length !== context.expectedCounts.productSourceLinks) {
    issues.push('PRODUCT_SOURCE_SOURCE_COUNT_MISMATCH');
  }
  const targetProducts = targetDb.prepare(
    'SELECT product_key, product_id, offer_id, sku FROM ozon_products WHERE shop_id = ?',
  ).all(context.newShopId);
  const targetProductsByOffer = indexUnique(targetProducts, (row) => normalizeText(row.offer_id));
  const expectedRows = [];
  for (const source of sourceRows) {
    const product = resolveProductByOffer(targetProductsByOffer, source.offer_id);
    if (!product) {
      issues.push('PRODUCT_SOURCE_PRODUCT_MAPPING_FAILED');
      continue;
    }
    expectedRows.push({
      ...source,
      id: createSupportRowId('source', context.newShopId, product.product_key, source.slot_index),
      shop_id: context.newShopId,
      product_key: product.product_key,
      product_id: product.product_id || null,
      offer_id: product.offer_id || null,
      sku: product.sku || null,
    });
  }
  const naturalKeys = expectedRows.map((row) => `${row.product_key}\u001f${row.slot_index}`);
  if (new Set(naturalKeys).size !== naturalKeys.length) issues.push('PRODUCT_SOURCE_TARGET_KEY_DUPLICATE');
  const targetRows = targetDb.prepare(
    `SELECT ${PRODUCT_SOURCE_LINK_COLUMNS.join(', ')}
     FROM product_source_links WHERE shop_id = ?`,
  ).all(context.newShopId);
  const classification = classifyExpectedRows({
    expectedRows,
    targetRows,
    columns: PRODUCT_SOURCE_LINK_COLUMNS,
    keyBuilder: (row) => `${row.product_key}\u001f${row.slot_index}`,
  });
  if (classification.conflicts.length) issues.push('PRODUCT_SOURCE_TARGET_CONFLICT');
  return {
    sourceRows,
    expectedRows,
    targetRows,
    mappedProductCount: new Set(expectedRows.map((row) => row.product_key)).size,
    ...classification,
  };
}

export function buildTargetOrderIndex(targetDb, context) {
  const rows = targetDb.prepare(
    'SELECT id, order_key, posting_number, order_id, products_json FROM ozon_orders WHERE shop_id = ?',
  ).all(context.newShopId);
  const index = new Map();
  for (const row of rows) {
    for (const value of [row.order_key, row.posting_number, row.order_id]) {
      const key = canonicalizeOrderKey(value, context.clientId);
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Map());
      index.get(key).set(row.id, row);
    }
  }
  return index;
}

export function orderContainsProduct(order, product) {
  const orderProducts = parseJson(order?.products_json);
  if (!Array.isArray(orderProducts) || !orderProducts.length) return false;
  const identities = [
    { productField: 'offer_id', aliases: ['offer_id', 'offerId'] },
    { productField: 'sku', aliases: ['sku', 'sku_id', 'skuId'] },
    { productField: 'product_id', aliases: ['product_id', 'productId'] },
    { productField: 'product_key', aliases: ['product_key', 'productKey'] },
  ];
  return orderProducts.some((orderProduct) => {
    if (!orderProduct || typeof orderProduct !== 'object') return false;
    return identities.some(({ productField, aliases }) => {
      const expected = normalizeText(product[productField]);
      if (!expected) return false;
      return aliases.some((alias) => normalizeText(orderProduct[alias]) === expected);
    });
  });
}

export function resolvePurchaseSourceProduct(source, targetProducts, order) {
  const prioritizedFields = ['offer_id', 'sku', 'product_key'];
  for (const field of prioritizedFields) {
    const value = normalizeText(source[field]);
    if (!value) continue;
    const matches = targetProducts.filter((product) => normalizeText(product[field]) === value);
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      return orderContainsProduct(order, matches[0]) ? matches[0] : null;
    }
  }
  // Legacy purchase links written before the canonical product model stored
  // the same Ozon offer identifier in both product_key and sku. Accept that
  // one documented bridge only when both independent legacy fields agree,
  // the current offer is unique, and the order payload proves membership.
  const legacyOfferId = normalizeText(source.sku);
  if (
    !normalizeText(source.offer_id)
    && legacyOfferId
    && normalizeText(source.product_key) === legacyOfferId
  ) {
    const matches = targetProducts.filter((product) => normalizeText(product.offer_id) === legacyOfferId);
    if (matches.length === 1 && orderContainsProduct(order, matches[0])) return matches[0];
  }
  return null;
}

export function buildPurchaseSourceLinkPlan(sourceDb, targetDb, context, issues) {
  const sourceRows = sourceDb.prepare(
    `SELECT ${PURCHASE_SOURCE_LINK_COLUMNS.join(', ')}
     FROM purchase_source_links WHERE shop_id = ? ORDER BY order_key, slot_index`,
  ).all(context.oldShopId);
  if (sourceRows.length !== context.expectedCounts.purchaseSourceLinks) {
    issues.push('PURCHASE_SOURCE_SOURCE_COUNT_MISMATCH');
  }
  const orderIndex = buildTargetOrderIndex(targetDb, context);
  const targetProducts = targetDb.prepare(
    'SELECT product_key, product_id, offer_id, sku FROM ozon_products WHERE shop_id = ?',
  ).all(context.newShopId);
  const expectedRows = [];
  for (const source of sourceRows) {
    const orderKey = canonicalizeOrderKey(source.order_key, context.clientId);
    const orders = orderIndex.get(orderKey);
    if (!orders || orders.size !== 1) {
      issues.push('PURCHASE_SOURCE_ORDER_MAPPING_FAILED');
      continue;
    }
    const order = [...orders.values()][0];
    const product = resolvePurchaseSourceProduct(source, targetProducts, order);
    if (!product) {
      issues.push('PURCHASE_SOURCE_PRODUCT_MAPPING_FAILED');
      continue;
    }
    expectedRows.push({
      ...source,
      id: `purchase_source_${createStableHash({
        shopId: context.newShopId,
        orderKey,
        slotIndex: Number(source.slot_index) || 0,
      }, { length: 32 })}`,
      shop_id: context.newShopId,
      order_key: orderKey,
      product_key: product.product_key,
      offer_id: product.offer_id || null,
      sku: product.sku || null,
    });
  }
  const targetRows = targetDb.prepare(
    `SELECT ${PURCHASE_SOURCE_LINK_COLUMNS.join(', ')}
     FROM purchase_source_links WHERE shop_id = ?`,
  ).all(context.newShopId);
  const classification = classifyExpectedRows({
    expectedRows,
    targetRows,
    columns: PURCHASE_SOURCE_LINK_COLUMNS,
    keyBuilder: (row) => `${row.order_key}\u001f${row.slot_index}`,
  });
  if (classification.conflicts.length) issues.push('PURCHASE_SOURCE_TARGET_CONFLICT');
  return { sourceRows, expectedRows, targetRows, ...classification };
}

export function enrichCrossBorderStructuredOrderFields({
  expected,
  base,
  source,
  context,
  currentOrderIndex,
  issues,
}) {
  const mappedRawGroups = [];
  for (const jsonValue of [base.raw_json, source.raw_json]) {
    for (const candidates of getCrossBorderRawOrderCandidateGroups(jsonValue)) {
      const matches = resolveCurrentOrderCandidates(
        candidates,
        currentOrderIndex,
        context.clientId,
      );
      if (matches.length > 1) {
        issues.push('CROSS_BORDER_RAW_ORDER_MAPPING_AMBIGUOUS');
        return expected;
      }
      if (matches.length === 1) {
        mappedRawGroups.push(matches[0]);
      }
    }
  }
  const rawMatchIdentities = new Set(mappedRawGroups.map(getCurrentOrderIdentity));
  if (rawMatchIdentities.size > 1) {
    issues.push('CROSS_BORDER_RAW_ORDER_MAPPING_CONFLICT');
    return expected;
  }
  // Candidate groups are returned in descending priority, and current/base raw
  // precedes the older source snapshot. Validate every provable mapping first,
  // then use the highest-priority agreeing match. Unmapped strings are ignored
  // as noise and cannot displace a verified order reference.
  const [rawMatch] = mappedRawGroups;
  if (!rawMatch) return expected;

  const structuredValues = [expected.sheet_order_sn, expected.platform_order].filter((value) => (
    !isEmptyValue(value)
  ));
  const structuredMatches = resolveCurrentOrderCandidates(
    structuredValues,
    currentOrderIndex,
    context.clientId,
  );
  if (structuredMatches.length > 1) {
    issues.push('CROSS_BORDER_STRUCTURED_ORDER_MAPPING_AMBIGUOUS');
    return expected;
  }
  if (
    structuredMatches.length === 1
    && getCurrentOrderIdentity(structuredMatches[0]) !== getCurrentOrderIdentity(rawMatch)
  ) {
    issues.push('CROSS_BORDER_STRUCTURED_ORDER_MAPPING_CONFLICT');
    return expected;
  }

  const matchedOrderKey = getPreferredCurrentOrderKey(rawMatch, context.clientId);
  if (!matchedOrderKey) return expected;
  if (isEmptyValue(expected.sheet_order_sn)) expected.sheet_order_sn = matchedOrderKey;
  if (isEmptyValue(expected.platform_order)) expected.platform_order = matchedOrderKey;
  return expected;
}

export function mergeCrossBorderRecord(base, source, context, currentOrderIndex, issues) {
  const expected = { ...base };
  expected.id = `cross_border_${createStableHash({
    shopId: context.newShopId,
    recordKey: base.record_key,
  }, { length: 32 })}`;
  expected.shop_id = context.newShopId;
  expected.record_key = base.record_key;
  for (const column of CROSS_BORDER_FILL_MISSING_COLUMNS) {
    if (isEmptyValue(base[column]) && !isEmptyValue(source[column])) expected[column] = source[column];
  }
  // Remote-current truth always wins for these fields, including an explicit
  // empty value. Older snapshots are evidence, not authority for status/raw.
  expected.status = base.status;
  expected.raw_json = base.raw_json;
  expected.remote_hash = base.remote_hash;
  expected.is_stale = base.is_stale;
  expected.last_seen_at = base.last_seen_at;
  expected.created_at = base.created_at;
  expected.updated_at = base.updated_at;
  return enrichCrossBorderStructuredOrderFields({
    expected,
    base,
    source,
    context,
    currentOrderIndex,
    issues,
  });
}

export function buildCrossBorderPlan(sourceDb, targetDb, context, issues) {
  const sourceRows = sourceDb.prepare(
    `SELECT ${CROSS_BORDER_COLUMNS.join(', ')}
     FROM cross_border_order_records WHERE shop_id = ? ORDER BY record_key`,
  ).all(context.oldShopId);
  if (sourceRows.length !== context.expectedCounts.crossBorderRecords) {
    issues.push('CROSS_BORDER_SOURCE_COUNT_MISMATCH');
  }
  const clientRows = targetDb.prepare(
    `SELECT ${CROSS_BORDER_COLUMNS.join(', ')}
     FROM cross_border_order_records WHERE shop_id = ? ORDER BY record_key`,
  ).all(context.clientId);
  const newShopRows = targetDb.prepare(
    `SELECT ${CROSS_BORDER_COLUMNS.join(', ')}
     FROM cross_border_order_records WHERE shop_id = ? ORDER BY record_key`,
  ).all(context.newShopId);
  if (clientRows.length && newShopRows.length) issues.push('CROSS_BORDER_PARTIAL_SCOPE_CONFLICT');
  const scope = newShopRows.length ? 'new-shop' : 'client-id';
  const baseRows = newShopRows.length ? newShopRows : clientRows;
  if (baseRows.length !== context.expectedCounts.crossBorderRecords) {
    issues.push('CROSS_BORDER_CURRENT_COUNT_MISMATCH');
  }
  const sourceByKey = indexUnique(sourceRows, (row) => normalizeText(row.record_key));
  const baseByKey = indexUnique(baseRows, (row) => normalizeText(row.record_key));
  if (sourceRows.some((row) => !normalizeText(row.record_key))) {
    issues.push('CROSS_BORDER_SOURCE_RECORD_KEY_EMPTY');
  }
  if (baseRows.some((row) => !normalizeText(row.record_key))) {
    issues.push('CROSS_BORDER_CURRENT_RECORD_KEY_EMPTY');
  }
  if ([...sourceByKey.values()].some((rows) => rows.length !== 1)) {
    issues.push('CROSS_BORDER_SOURCE_RECORD_KEY_DUPLICATE');
  }
  if ([...baseByKey.values()].some((rows) => rows.length !== 1)) {
    issues.push('CROSS_BORDER_CURRENT_RECORD_KEY_DUPLICATE');
  }
  if (
    sourceByKey.size !== baseByKey.size
    || [...sourceByKey.keys()].some((key) => (
      (sourceByKey.get(key) || []).length !== 1 || (baseByKey.get(key) || []).length !== 1
    ))
  ) {
    issues.push('CROSS_BORDER_RECORD_KEY_MISMATCH');
  }

  const currentOrders = targetDb.prepare(
    'SELECT id, order_key, posting_number, order_id FROM ozon_orders WHERE shop_id = ?',
  ).all(context.newShopId);
  const currentOrderIndex = buildCurrentOrderIndex(currentOrders, context.clientId);

  const expectedRows = [];
  let filledFieldCount = 0;
  for (const source of sourceRows) {
    const matches = baseByKey.get(normalizeText(source.record_key)) || [];
    if (matches.length !== 1) continue;
    const base = matches[0];
    const expected = mergeCrossBorderRecord(
      base,
      source,
      context,
      currentOrderIndex,
      issues,
    );
    filledFieldCount += CROSS_BORDER_FILL_MISSING_COLUMNS.filter((column) => (
      isEmptyValue(base[column]) && !isEmptyValue(expected[column])
    )).length;
    if (scope === 'new-shop' && base.id !== expected.id) {
      issues.push('CROSS_BORDER_NEW_SCOPE_ID_CONFLICT');
    }
    expectedRows.push(expected);
  }
  if (expectedRows.length !== context.expectedCounts.crossBorderRecords) {
    issues.push('CROSS_BORDER_EXPECTED_ROW_COUNT_MISMATCH');
  }
  const inserts = scope === 'client-id' ? expectedRows : [];
  const updates = scope === 'new-shop'
    ? expectedRows.filter((expected) => {
        const base = baseByKey.get(expected.record_key)?.[0];
        return !stableRowEquals(base, expected, CROSS_BORDER_COLUMNS);
      })
    : [];
  const unchanged = expectedRows.length - inserts.length - updates.length;
  return {
    sourceRows,
    clientRows,
    newShopRows,
    baseRows,
    expectedRows,
    scope,
    inserts,
    updates,
    unchanged,
    deleteClientRows: scope === 'client-id' ? clientRows.length : 0,
    filledFieldCount,
  };
}

export function buildRecoveryPlan(sourceDb, targetDb, options) {
  assertRequiredSchema(sourceDb, 'SOURCE');
  assertRequiredSchema(targetDb, 'TARGET');
  const context = {
    oldShopId: requiredText(options.oldShopId, 'REBOUND_RECOVERY_OLD_SHOP_ID_REQUIRED'),
    newShopId: requiredText(options.newShopId, 'REBOUND_RECOVERY_NEW_SHOP_ID_REQUIRED'),
    clientId: requiredText(options.clientId, 'REBOUND_RECOVERY_CLIENT_ID_REQUIRED'),
    expectedCounts: {
      ...DEFAULT_REBOUND_SHOP_RECOVERY_EXPECTED_COUNTS,
      ...(options.expectedCounts || {}),
    },
  };
  if (context.oldShopId === context.newShopId || context.clientId === context.newShopId) {
    fail('REBOUND_RECOVERY_SCOPE_IDS_INVALID');
  }
  const issues = [];
  const identity = buildIdentityPlan(sourceDb, targetDb, context, issues);
  const purchaseOverrides = buildPurchaseOverridePlan(sourceDb, targetDb, context, issues);
  const productSourceLinks = buildProductSourceLinkPlan(sourceDb, targetDb, context, issues);
  const purchaseSourceLinks = buildPurchaseSourceLinkPlan(sourceDb, targetDb, context, issues);
  const crossBorder = buildCrossBorderPlan(sourceDb, targetDb, context, issues);
  const uniqueIssues = [...new Set(issues)].sort();
  const plannedWriteCount = (
    purchaseOverrides.inserts.length
    + purchaseOverrides.rekeys.length
    + productSourceLinks.inserts.length
    + purchaseSourceLinks.inserts.length
    + crossBorder.inserts.length
    + crossBorder.updates.length
    + crossBorder.deleteClientRows
  );
  const fingerprint = createStableHash({
    version: RECOVERY_VERSION,
    identity: createStableHash([context.oldShopId, context.newShopId, context.clientId]),
    issues: uniqueIssues,
    purchaseOverrides: purchaseOverrides.expectedRows.map((row) => rowDigest(row, PURCHASE_OVERRIDE_COLUMNS)),
    productSourceLinks: productSourceLinks.expectedRows.map((row) => rowDigest(row, PRODUCT_SOURCE_LINK_COLUMNS)),
    purchaseSourceLinks: purchaseSourceLinks.expectedRows.map((row) => rowDigest(row, PURCHASE_SOURCE_LINK_COLUMNS)),
    crossBorder: crossBorder.expectedRows.map((row) => rowDigest(row, CROSS_BORDER_COLUMNS)),
    targetState: {
      purchaseOverrides: purchaseOverrides.targetRows.map((row) => rowDigest(row, PURCHASE_OVERRIDE_COLUMNS)),
      productSourceLinks: productSourceLinks.targetRows.map((row) => rowDigest(row, PRODUCT_SOURCE_LINK_COLUMNS)),
      purchaseSourceLinks: purchaseSourceLinks.targetRows.map((row) => rowDigest(row, PURCHASE_SOURCE_LINK_COLUMNS)),
      crossClient: crossBorder.clientRows.map((row) => rowDigest(row, CROSS_BORDER_COLUMNS)),
      crossNew: crossBorder.newShopRows.map((row) => rowDigest(row, CROSS_BORDER_COLUMNS)),
    },
  });
  return {
    context,
    issues: uniqueIssues,
    safeToApply: uniqueIssues.length === 0,
    plannedWriteCount,
    fingerprint,
    identity,
    purchaseOverrides,
    productSourceLinks,
    purchaseSourceLinks,
    crossBorder,
  };
}

export function toPublicPreview(plan, { profileLockPresent, sourceQuickCheck, targetQuickCheck }) {
  return Object.freeze({
    ok: true,
    mode: 'preview',
    version: RECOVERY_VERSION,
    safeToApply: plan.safeToApply,
    profileLockPresent: Boolean(profileLockPresent),
    applyBlockedByProfileLock: Boolean(profileLockPresent),
    identityVerified: plan.identity.verified,
    quickCheck: {
      source: sourceQuickCheck,
      target: targetQuickCheck,
    },
    counts: {
      purchaseOverrides: {
        sourcePhysical: plan.purchaseOverrides.sourceRows.length,
        canonical: plan.purchaseOverrides.expectedRows.length,
        duplicateRowsMerged: plan.purchaseOverrides.duplicateRowsMerged,
        mappedToCurrentOrders: plan.purchaseOverrides.currentOrderMatches,
        enriched: plan.purchaseOverrides.enrichedCount,
        insert: plan.purchaseOverrides.inserts.length,
        rekey: plan.purchaseOverrides.rekeys.length,
        deleteLegacyUnscoped: plan.purchaseOverrides.rekeys.length,
        unchanged: plan.purchaseOverrides.unchanged.length,
        conflicts: plan.purchaseOverrides.conflicts.length,
      },
      productSourceLinks: {
        source: plan.productSourceLinks.sourceRows.length,
        mappedProducts: plan.productSourceLinks.mappedProductCount,
        insert: plan.productSourceLinks.inserts.length,
        unchanged: plan.productSourceLinks.unchanged.length,
        conflicts: plan.productSourceLinks.conflicts.length,
      },
      purchaseSourceLinks: {
        source: plan.purchaseSourceLinks.sourceRows.length,
        insert: plan.purchaseSourceLinks.inserts.length,
        unchanged: plan.purchaseSourceLinks.unchanged.length,
        conflicts: plan.purchaseSourceLinks.conflicts.length,
      },
      crossBorder: {
        source: plan.crossBorder.sourceRows.length,
        current: plan.crossBorder.baseRows.length,
        scope: plan.crossBorder.scope,
        insert: plan.crossBorder.inserts.length,
        update: plan.crossBorder.updates.length,
        unchanged: plan.crossBorder.unchanged,
        deleteClientScope: plan.crossBorder.deleteClientRows,
        filledFields: plan.crossBorder.filledFieldCount,
      },
      plannedWrites: plan.plannedWriteCount,
    },
    issues: plan.issues,
    previewFingerprint: plan.fingerprint,
  });
}

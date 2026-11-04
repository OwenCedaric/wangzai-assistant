import { createStableHash } from '../../utils/stableHash.js';
import {
  createCrossBorderChargePhysicalIdentity,
  inferCrossBorderChargeDirection,
} from '../../domain/logistics/crossBorderChargeAccounting.js';

const DEFAULT_TENANT_ID = 'tenant_local_default';
const DEFAULT_USER_ID = 'user_local_default';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, maximum = 500) {
  const text = value == null ? '' : String(value).trim();
  return text.slice(0, maximum);
}

function normalizeMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[^0-9.+-]/gu, ''));
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function compactJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeScope(context = {}, profileId = 'default') {
  return {
    tenantId: normalizeText(context.tenantId, 128) || DEFAULT_TENANT_ID,
    userId: normalizeText(context.userId, 128) || DEFAULT_USER_ID,
    profileId: normalizeText(context.profileId ?? profileId, 128) || 'default',
  };
}

function normalizeMatchStatus(value) {
  const text = normalizeText(value, 40).toLowerCase();
  return ['exact', 'unmatched', 'ambiguous'].includes(text) ? text : 'unmatched';
}

function normalizeChargeRecord(input = {}, scope = {}, profileId = 'default') {
  const scoped = normalizeScope(scope, profileId);
  const browserAccountRef = normalizeText(input.browserAccountRef ?? input.browser_account_ref, 180);
  const collectionNumber = normalizeText(input.collectionNumber ?? input.collection_number ?? input.oid, 180);
  const direction = inferCrossBorderChargeDirection(input);
  const rawAmountCny = normalizeMoney(input.amountCny ?? input.amount_cny ?? input.money);
  const amountCny = rawAmountCny === null ? null : Math.abs(rawAmountCny);
  if (!browserAccountRef) throw new Error('CROSS_BORDER_BROWSER_ACCOUNT_REQUIRED');
  if (!collectionNumber) throw new Error('CROSS_BORDER_COLLECTION_NUMBER_REQUIRED');
  if (amountCny === null || amountCny < 0) throw new Error('CROSS_BORDER_CHARGE_AMOUNT_INVALID');
  const canonical = {
    collectionNumber,
    direction,
    amountCny,
    balanceAfterCny: normalizeMoney(input.balanceAfterCny ?? input.balance_after_cny ?? input.afterMoney ?? input.after_money),
    reason: normalizeText(input.reason, 300),
    occurredAt: normalizeText(input.occurredAt ?? input.occurred_at ?? input.time, 80),
    warehouse: normalizeText(input.warehouse ?? input.storehoursName ?? input.storehours_name, 240),
    serviceCompany: normalizeText(input.serviceCompany ?? input.service_company ?? input.brandName ?? input.brand_name, 300),
  };
  const physicalIdentity = createCrossBorderChargePhysicalIdentity(canonical);
  const sourceRecordHash = createStableHash(physicalIdentity, { length: 40 });
  return {
    ...scoped,
    browserAccountRef,
    crossBorderAccountId: normalizeText(input.crossBorderAccountId ?? input.cross_border_account_id, 180),
    externalAccountRef: normalizeText(input.externalAccountRef ?? input.external_account_ref, 180),
    shopId: normalizeText(input.shopId ?? input.shop_id, 180),
    postingNumber: normalizeText(input.postingNumber ?? input.posting_number, 180),
    purchaseOrderNumber: normalizeText(input.purchaseOrderNumber ?? input.purchase_order_number, 180),
    sourceRecordHash,
    raw: input.raw && typeof input.raw === 'object' ? input.raw : canonical,
    ...canonical,
    id: `cross_border_charge_${createStableHash({
      ...scoped,
      browserAccountRef,
      sourceRecordHash,
    }, { length: 32 })}`,
  };
}

function normalizeChargeLink(input = {}, scope = {}, profileId = 'default') {
  const scoped = normalizeScope(scope, profileId);
  const browserAccountRef = normalizeText(input.browserAccountRef ?? input.browser_account_ref, 180);
  const collectionNumber = normalizeText(input.collectionNumber ?? input.collection_number, 180);
  const actualFeeCny = normalizeMoney(input.actualFeeCny ?? input.actual_fee_cny);
  const ledgerNetCny = normalizeMoney(input.ledgerNetCny ?? input.ledger_net_cny);
  if (!browserAccountRef) throw new Error('CROSS_BORDER_BROWSER_ACCOUNT_REQUIRED');
  if (!collectionNumber) throw new Error('CROSS_BORDER_COLLECTION_NUMBER_REQUIRED');
  if (actualFeeCny === null || actualFeeCny < 0 || ledgerNetCny === null) {
    throw new Error('CROSS_BORDER_ACTUAL_FEE_INVALID');
  }
  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : {};
  const canonical = {
    collectionNumber,
    postingNumber: normalizeText(input.postingNumber ?? input.posting_number, 180),
    shopId: normalizeText(input.shopId ?? input.shop_id, 180),
    actualFeeCny,
    ledgerNetCny,
    matchStatus: normalizeMatchStatus(input.matchStatus ?? input.match_status),
    sourceHash: normalizeText(input.sourceHash ?? input.source_hash, 80),
  };
  canonical.sourceHash ||= createStableHash({ ...canonical, evidence }, { length: 40 });
  return {
    ...scoped,
    browserAccountRef,
    crossBorderAccountId: normalizeText(input.crossBorderAccountId ?? input.cross_border_account_id, 180),
    externalAccountRef: normalizeText(input.externalAccountRef ?? input.external_account_ref, 180),
    shopId: canonical.shopId,
    collectionNumber,
    postingNumber: canonical.postingNumber,
    ozonOrderKey: normalizeText(input.ozonOrderKey ?? input.ozon_order_key, 180),
    purchaseOrderNumber: normalizeText(input.purchaseOrderNumber ?? input.purchase_order_number, 180),
    serviceName: normalizeText(input.serviceName ?? input.service_name, 300),
    warehouse: normalizeText(input.warehouse, 240),
    actualFeeCny,
    ledgerNetCny,
    currency: normalizeText(input.currency, 12).toUpperCase() || 'CNY',
    matchStatus: canonical.matchStatus,
    confidence: Math.min(Math.max(Math.round(Number(input.confidence) || 0), 0), 100),
    evidence,
    sourceHash: canonical.sourceHash,
    lastSeenAt: normalizeText(input.lastSeenAt ?? input.last_seen_at, 80) || nowIso(),
    id: `cross_border_link_${createStableHash({
      ...scoped,
      browserAccountRef,
      collectionNumber,
    }, { length: 32 })}`,
  };
}

function toPublicCharge(row = {}) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    profileId: row.profile_id,
    browserAccountRef: row.browser_account_ref,
    crossBorderAccountId: row.cross_border_account_id || '',
    externalAccountRef: row.external_account_ref || '',
    shopId: row.shop_id || '',
    collectionNumber: row.collection_number,
    postingNumber: row.posting_number || '',
    purchaseOrderNumber: row.purchase_order_number || '',
    direction: row.direction,
    amountCny: row.amount_cny,
    balanceAfterCny: row.balance_after_cny,
    reason: row.reason || '',
    occurredAt: row.occurred_at || '',
    warehouse: row.warehouse || '',
    serviceCompany: row.service_company || '',
    sourceRecordHash: row.source_record_hash,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function toPublicLink(row = {}) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    profileId: row.profile_id,
    browserAccountRef: row.browser_account_ref,
    crossBorderAccountId: row.cross_border_account_id || '',
    externalAccountRef: row.external_account_ref || '',
    shopId: row.shop_id || '',
    collectionNumber: row.collection_number,
    postingNumber: row.posting_number || '',
    ozonOrderKey: row.ozon_order_key || '',
    purchaseOrderNumber: row.purchase_order_number || '',
    serviceName: row.service_name || '',
    warehouse: row.warehouse || '',
    actualFeeCny: row.actual_fee_cny,
    ledgerNetCny: row.ledger_net_cny,
    currency: row.currency || 'CNY',
    matchStatus: row.match_status,
    confidence: Number(row.confidence) || 0,
    evidence: parseJson(row.evidence_json, {}),
    sourceHash: row.source_hash,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export function createCrossBorderChargeRepository(db, { profileId = 'default' } = {}) {
  const stalePhysicalRecordDelete = db.prepare(`
    DELETE FROM cross_border_charge_records
    WHERE tenant_id = ?
      AND user_id = ?
      AND profile_id = ?
      AND browser_account_ref = ?
      AND collection_number = ?
      AND occurred_at = ?
      AND amount_cny = ?
      AND ((balance_after_cny IS NULL AND ? IS NULL) OR balance_after_cny = ?)
      AND reason = ?
      AND warehouse = ?
      AND service_company = ?
      AND source_record_hash <> ?
  `);
  const chargeUpsert = db.prepare(`
    INSERT INTO cross_border_charge_records (
      id, tenant_id, user_id, profile_id, browser_account_ref, external_account_ref,
      cross_border_account_id,
      shop_id, collection_number, posting_number, purchase_order_number,
      direction, amount_cny, balance_after_cny, reason, occurred_at,
      warehouse, service_company, source_record_hash, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, profile_id, browser_account_ref, source_record_hash)
    DO UPDATE SET
      external_account_ref = excluded.external_account_ref,
      cross_border_account_id = CASE WHEN excluded.cross_border_account_id <> '' THEN excluded.cross_border_account_id ELSE cross_border_charge_records.cross_border_account_id END,
      shop_id = CASE WHEN excluded.shop_id <> '' THEN excluded.shop_id ELSE cross_border_charge_records.shop_id END,
      posting_number = CASE WHEN excluded.posting_number <> '' THEN excluded.posting_number ELSE cross_border_charge_records.posting_number END,
      purchase_order_number = CASE WHEN excluded.purchase_order_number <> '' THEN excluded.purchase_order_number ELSE cross_border_charge_records.purchase_order_number END,
      direction = excluded.direction,
      amount_cny = excluded.amount_cny,
      balance_after_cny = COALESCE(excluded.balance_after_cny, cross_border_charge_records.balance_after_cny),
      reason = excluded.reason,
      occurred_at = excluded.occurred_at,
      warehouse = excluded.warehouse,
      service_company = excluded.service_company,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  const linkUpsert = db.prepare(`
    INSERT INTO cross_border_charge_links (
      id, tenant_id, user_id, profile_id, browser_account_ref, external_account_ref,
      cross_border_account_id,
      shop_id, collection_number, posting_number, ozon_order_key, purchase_order_number,
      service_name, warehouse, actual_fee_cny, ledger_net_cny, currency,
      match_status, confidence, evidence_json, source_hash, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, profile_id, browser_account_ref, collection_number)
    DO UPDATE SET
      external_account_ref = excluded.external_account_ref,
      cross_border_account_id = CASE WHEN excluded.cross_border_account_id <> '' THEN excluded.cross_border_account_id ELSE cross_border_charge_links.cross_border_account_id END,
      shop_id = excluded.shop_id,
      posting_number = excluded.posting_number,
      ozon_order_key = excluded.ozon_order_key,
      purchase_order_number = excluded.purchase_order_number,
      service_name = excluded.service_name,
      warehouse = excluded.warehouse,
      actual_fee_cny = excluded.actual_fee_cny,
      ledger_net_cny = excluded.ledger_net_cny,
      currency = excluded.currency,
      match_status = excluded.match_status,
      confidence = excluded.confidence,
      evidence_json = excluded.evidence_json,
      source_hash = excluded.source_hash,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `);

  function upsertChargeRecords(records = [], context = {}) {
    const timestamp = nowIso();
    const rows = (Array.isArray(records) ? records : []).map((record) => normalizeChargeRecord(record, context, profileId));
    rows.forEach((row) => {
      stalePhysicalRecordDelete.run(
        row.tenantId, row.userId, row.profileId, row.browserAccountRef,
        row.collectionNumber, row.occurredAt, row.amountCny,
        row.balanceAfterCny, row.balanceAfterCny,
        row.reason, row.warehouse, row.serviceCompany, row.sourceRecordHash,
      );
      chargeUpsert.run(
        row.id, row.tenantId, row.userId, row.profileId, row.browserAccountRef, row.externalAccountRef,
        row.crossBorderAccountId,
        row.shopId, row.collectionNumber, row.postingNumber, row.purchaseOrderNumber,
        row.direction, row.amountCny, row.balanceAfterCny, row.reason, row.occurredAt,
        row.warehouse, row.serviceCompany, row.sourceRecordHash, compactJson(row.raw), timestamp, timestamp,
      );
    });
    return { ok: true, saved: rows.length, rows };
  }

  function upsertChargeLinks(links = [], context = {}) {
    const timestamp = nowIso();
    const rows = (Array.isArray(links) ? links : []).map((link) => normalizeChargeLink(link, context, profileId));
    rows.forEach((row) => {
      linkUpsert.run(
        row.id, row.tenantId, row.userId, row.profileId, row.browserAccountRef, row.externalAccountRef,
        row.crossBorderAccountId,
        row.shopId, row.collectionNumber, row.postingNumber, row.ozonOrderKey, row.purchaseOrderNumber,
        row.serviceName, row.warehouse, row.actualFeeCny, row.ledgerNetCny, row.currency,
        row.matchStatus, row.confidence, compactJson(row.evidence), row.sourceHash,
        row.lastSeenAt, timestamp, timestamp,
      );
    });
    return { ok: true, saved: rows.length, rows };
  }

  function listChargeLinks(query = {}, context = {}) {
    const scope = normalizeScope(context, profileId);
    const where = ['tenant_id = ?', 'user_id = ?', 'profile_id = ?'];
    const params = [scope.tenantId, scope.userId, scope.profileId];
    const shopId = normalizeText(query.shopId ?? query.shop_id, 180);
    const browserAccountRef = normalizeText(query.browserAccountRef ?? query.browser_account_ref, 180);
    const crossBorderAccountId = normalizeText(query.crossBorderAccountId ?? query.cross_border_account_id, 180);
    const postingNumbers = [...new Set((Array.isArray(query.postingNumbers) ? query.postingNumbers : [query.postingNumber ?? query.posting_number])
      .map((value) => normalizeText(value, 180)).filter(Boolean))].slice(0, 500);
    if (shopId && !['all', '*'].includes(shopId.toLowerCase())) {
      where.push('shop_id = ?');
      params.push(shopId);
    }
    if (browserAccountRef) {
      where.push('browser_account_ref = ?');
      params.push(browserAccountRef);
    }
    if (crossBorderAccountId) {
      where.push('cross_border_account_id = ?');
      params.push(crossBorderAccountId);
    }
    if (postingNumbers.length) {
      where.push(`posting_number IN (${postingNumbers.map(() => '?').join(', ')})`);
      params.push(...postingNumbers);
    }
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 100000);
    const rows = db.prepare(`
      SELECT * FROM cross_border_charge_links
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, collection_number ASC
      LIMIT ?
    `).all(...params, limit);
    return { ok: true, rows: rows.map(toPublicLink), total: rows.length };
  }

  function listChargeRecords(query = {}, context = {}) {
    const scope = normalizeScope(context, profileId);
    const where = ['tenant_id = ?', 'user_id = ?', 'profile_id = ?'];
    const params = [scope.tenantId, scope.userId, scope.profileId];
    const browserAccountRef = normalizeText(query.browserAccountRef ?? query.browser_account_ref, 180);
    const crossBorderAccountId = normalizeText(query.crossBorderAccountId ?? query.cross_border_account_id, 180);
    const collectionNumber = normalizeText(query.collectionNumber ?? query.collection_number, 180);
    if (browserAccountRef) {
      where.push('browser_account_ref = ?');
      params.push(browserAccountRef);
    }
    if (crossBorderAccountId) {
      where.push('cross_border_account_id = ?');
      params.push(crossBorderAccountId);
    }
    if (collectionNumber) {
      where.push('collection_number = ?');
      params.push(collectionNumber);
    }
    const limit = Math.min(Math.max(Number(query.limit) || 500, 1), 100000);
    const rows = db.prepare(`
      SELECT * FROM cross_border_charge_records
      WHERE ${where.join(' AND ')}
      ORDER BY occurred_at DESC, id ASC
      LIMIT ?
    `).all(...params, limit);
    return { ok: true, rows: rows.map(toPublicCharge), total: rows.length };
  }

  return {
    normalizeScope: (context = {}) => normalizeScope(context, profileId),
    upsertChargeRecords,
    upsertChargeLinks,
    listChargeLinks,
    listChargeRecords,
  };
}

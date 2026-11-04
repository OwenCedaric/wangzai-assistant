import { createStableHash } from '../../utils/stableHash.js';

import { getOzonFinanceOperationLabel } from '../../ozon/ozonChineseLabels.js';
import { appendShopQueryFilter } from '../shopQueryScope.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(',', '.').replace(/[^0-9.\-]/gu, '').trim();
  const match = text.match(/-?\d+(?:\.\d+)?/u);
  if (!match) return null;
  const number = Number(match[0]);
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

function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return value;
  }
  return '';
}

function firstNumber(...values) {
  for (const value of values) {
    const number = toNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function extractPostingNumber(operation = {}) {
  return normalizeId(firstFilled(
    operation.posting_number,
    operation.postingNumber,
    operation.posting?.posting_number,
    operation.posting?.postingNumber,
    operation.posting?.posting_number_with_subposting,
    operation.items?.[0]?.posting_number,
  ));
}

function extractOrderId(operation = {}) {
  return normalizeId(firstFilled(
    operation.order_id,
    operation.orderId,
    operation.posting?.order_id,
    operation.posting?.orderId,
    operation.items?.[0]?.order_id,
  ));
}

function extractServices(operation = {}) {
  const services = Array.isArray(operation.services) ? operation.services : [];
  return services
    .map((service) => ({
      name: normalizeText(service.name ?? service.service_name ?? service.type),
      price: firstNumber(service.price, service.amount, service.value),
    }))
    .filter((service) => service.name || service.price !== null);
}

function sumServices(services = [], needles = []) {
  const loweredNeedles = needles.map((item) => item.toLowerCase());
  let sum = 0;
  let found = false;
  for (const service of services) {
    const name = normalizeText(service.name).toLowerCase();
    if (!loweredNeedles.some((needle) => name.includes(needle))) continue;
    const price = toNumber(service.price);
    if (price === null) continue;
    sum += price;
    found = true;
  }
  return found ? sum : null;
}

function normalizeOperation(operation = {}, { shopId } = {}) {
  const operationId = normalizeId(firstFilled(operation.operation_id, operation.operationId, operation.id));
  const postingNumber = extractPostingNumber(operation);
  const orderId = extractOrderId(operation);
  const operationType = normalizeText(firstFilled(operation.operation_type, operation.operationType, operation.type));
  const operationTypeName = getOzonFinanceOperationLabel(
    operationType,
    firstFilled(operation.operation_type_name, operation.operationTypeName, operation.name)
  );
  const transactionType = normalizeText(firstFilled(operation.transaction_type, operation.transactionType));
  const operationDate = normalizeText(firstFilled(
    operation.operation_date,
    operation.operationDate,
    operation.date,
    operation.created_at,
  ));
  const services = extractServices(operation);
  const amountTotal = firstNumber(
    operation.amount,
    operation.amount_total,
    operation.operation_sum,
    operation.accruals_for_sale,
    operation.sale_commission,
    operation.total,
  );
  const typeText = `${operationType} ${operationTypeName}`.toLowerCase();
  const acquiringFromService = sumServices(services, ['acquiring', 'эквайринг', '收单']);
  const commissionFromService = sumServices(services, ['commission', 'directflowtrans', 'sales_percent', 'комис', '佣金']);
  const deliveryFromService = sumServices(services, ['delivery', 'logistic', 'shipping', 'lastmile', '配送', '物流']);
  const acquiringFee = firstNumber(
    operation.acquiring,
    operation.acquiring_fee,
    operation.acquiring_amount,
    operation.acquiring_fee_cny,
    typeText.includes('acquiring') ? amountTotal : null,
    acquiringFromService,
  );
  const saleCommission = firstNumber(operation.sale_commission, operation.commission, operation.commission_amount, commissionFromService);
  const deliveryFee = firstNumber(operation.delivery_fee, operation.logistics_fee, deliveryFromService);
  const currencyCode = normalizeText(firstFilled(
    operation.currency_code,
    operation.currencyCode,
    operation.currency,
    operation.amount?.currency_code,
  ));
  const operationKey = operationId || createStableHash({ shopId, postingNumber, orderId, operationType, operationTypeName, transactionType, operationDate, amountTotal, services }, { length: 40 });
  const remoteHash = createStableHash({ operation, normalized: { operationKey, postingNumber, operationType, operationDate, amountTotal, acquiringFee, saleCommission, deliveryFee } }, { length: 40 });

  return {
    id: `finance_${createStableHash({ shopId, operationKey }, { length: 32 })}`,
    shopId,
    operationKey,
    operationId,
    postingNumber,
    orderId,
    operationType,
    operationTypeName,
    transactionType,
    operationDate,
    amountTotal,
    acquiringFee,
    saleCommission,
    deliveryFee,
    currencyCode,
    services,
    raw: operation,
    remoteHash,
  };
}

function toPublicOperation(row = {}) {
  const raw = parseJson(row.raw_json, {});
  const services = parseJson(row.services_json, []);
  const operationType = row.operation_type || raw.operation_type || null;
  const operationTypeName = getOzonFinanceOperationLabel(
    operationType,
    row.operation_type_name || raw.operation_type_name || null
  );
  return {
    ...raw,
    id: row.id,
    shopId: row.shop_id,
    operationKey: row.operation_key,
    operationId: row.operation_id || raw.operation_id || null,
    operation_id: row.operation_id || raw.operation_id || null,
    postingNumber: row.posting_number || raw.posting_number || raw.posting?.posting_number || null,
    posting_number: row.posting_number || raw.posting_number || raw.posting?.posting_number || null,
    orderId: row.order_id || raw.order_id || raw.posting?.order_id || null,
    order_id: row.order_id || raw.order_id || raw.posting?.order_id || null,
    operationType,
    operation_type: operationType,
    operationTypeName: operationTypeName || null,
    operation_type_name: operationTypeName || null,
    transactionType: row.transaction_type || raw.transaction_type || null,
    transaction_type: row.transaction_type || raw.transaction_type || null,
    operationDate: row.operation_date || raw.operation_date || null,
    operation_date: row.operation_date || raw.operation_date || null,
    amountTotal: row.amount_total,
    amount: raw.amount ?? row.amount_total,
    acquiringFeeCny: row.acquiring_fee_cny,
    saleCommissionCny: row.sale_commission_cny,
    deliveryFeeCny: row.delivery_fee_cny,
    currencyCode: row.currency_code || raw.currency_code || null,
    currency_code: row.currency_code || raw.currency_code || null,
    services,
    raw,
    isStale: Boolean(row.is_stale),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

function normalizePageSize(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

function splitIds(value) {
  if (Array.isArray(value)) return value.map(normalizeId).filter(Boolean);
  return normalizeText(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createFinanceRepository(db) {
  function upsertOperations({ shopId, rows = [] } = {}) {
    const normalizedShopId = normalizeId(shopId);
    if (!normalizedShopId) throw new Error('shopId is required for finance operation merge.');
    const timestamp = nowIso();
    const selectExisting = db.prepare('SELECT remote_hash FROM ozon_finance_transactions WHERE shop_id = ? AND operation_key = ?');
    const insertOrUpdate = db.prepare(`
      INSERT INTO ozon_finance_transactions (
        id, shop_id, operation_key, operation_id, posting_number, order_id,
        operation_type, operation_type_name, transaction_type, operation_date,
        amount_total, acquiring_fee_cny, sale_commission_cny, delivery_fee_cny,
        currency_code, services_json, raw_json, remote_hash, is_stale,
        last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(shop_id, operation_key) DO UPDATE SET
        operation_id = COALESCE(excluded.operation_id, ozon_finance_transactions.operation_id),
        posting_number = COALESCE(excluded.posting_number, ozon_finance_transactions.posting_number),
        order_id = COALESCE(excluded.order_id, ozon_finance_transactions.order_id),
        operation_type = COALESCE(excluded.operation_type, ozon_finance_transactions.operation_type),
        operation_type_name = COALESCE(excluded.operation_type_name, ozon_finance_transactions.operation_type_name),
        transaction_type = COALESCE(excluded.transaction_type, ozon_finance_transactions.transaction_type),
        operation_date = COALESCE(excluded.operation_date, ozon_finance_transactions.operation_date),
        amount_total = COALESCE(excluded.amount_total, ozon_finance_transactions.amount_total),
        acquiring_fee_cny = COALESCE(excluded.acquiring_fee_cny, ozon_finance_transactions.acquiring_fee_cny),
        sale_commission_cny = COALESCE(excluded.sale_commission_cny, ozon_finance_transactions.sale_commission_cny),
        delivery_fee_cny = COALESCE(excluded.delivery_fee_cny, ozon_finance_transactions.delivery_fee_cny),
        currency_code = COALESCE(excluded.currency_code, ozon_finance_transactions.currency_code),
        services_json = COALESCE(excluded.services_json, ozon_finance_transactions.services_json),
        raw_json = COALESCE(excluded.raw_json, ozon_finance_transactions.raw_json),
        remote_hash = excluded.remote_hash,
        is_stale = 0,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);
    const touchUnchanged = db.prepare(`
      UPDATE ozon_finance_transactions
      SET last_seen_at = ?, is_stale = 0, updated_at = ?
      WHERE shop_id = ? AND operation_key = ?
    `);
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let missing = 0;
    for (const source of rows) {
      const row = normalizeOperation(source, { shopId: normalizedShopId });
      if (!row.operationKey) {
        missing += 1;
        continue;
      }
      const existing = selectExisting.get(normalizedShopId, row.operationKey);
      if (existing?.remote_hash === row.remoteHash) {
        touchUnchanged.run(timestamp, timestamp, normalizedShopId, row.operationKey);
        unchanged += 1;
        continue;
      }
      insertOrUpdate.run(
        row.id,
        normalizedShopId,
        row.operationKey,
        row.operationId || null,
        row.postingNumber || null,
        row.orderId || null,
        row.operationType || null,
        row.operationTypeName || null,
        row.transactionType || null,
        row.operationDate || null,
        row.amountTotal,
        row.acquiringFee,
        row.saleCommission,
        row.deliveryFee,
        row.currencyCode || null,
        compactJson(row.services),
        compactJson(row.raw),
        row.remoteHash,
        timestamp,
        timestamp,
        timestamp,
      );
      if (existing) updated += 1;
      else inserted += 1;
    }
    return { ok: true, inserted, updated, unchanged, missing, changed: inserted + updated, rows: rows.length, updatedAt: timestamp };
  }

  function listOperations(query = {}) {
    const pageSize = normalizePageSize(query.pageSize ?? query.limit, 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const postingNumbers = splitIds(query.postingNumbers ?? query.posting_number ?? query.postingNumber);
    const operationTypes = splitIds(query.operationTypes ?? query.operation_type ?? query.operationType);
    const keyword = normalizeText(query.keyword ?? query.q);
    const dateFrom = normalizeText(query.dateFrom ?? query.from ?? query.since);
    const dateTo = normalizeText(query.dateTo ?? query.to);
    const where = ['is_stale = 0'];
    const params = [];
    appendShopQueryFilter(query, where, params);
    if (postingNumbers.length) {
      where.push(`posting_number IN (${postingNumbers.map(() => '?').join(',')})`);
      params.push(...postingNumbers);
    }
    if (operationTypes.length) {
      where.push(`operation_type IN (${operationTypes.map(() => '?').join(',')})`);
      params.push(...operationTypes);
    }
    if (dateFrom) {
      where.push('(operation_date IS NULL OR operation_date >= ?)');
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push('(operation_date IS NULL OR operation_date <= ?)');
      params.push(dateTo);
    }
    if (keyword) {
      where.push('(posting_number LIKE ? OR operation_id LIKE ? OR operation_type LIKE ? OR operation_type_name LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like, like, like);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM ozon_finance_transactions ${clause}`).get(...params);
    const rows = db.prepare(`
      SELECT * FROM ozon_finance_transactions
      ${clause}
      ORDER BY operation_date DESC, operation_id ASC, posting_number ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    return {
      ok: true,
      domain: 'finance',
      source: 'sqlite',
      rows: rows.map(toPublicOperation),
      page,
      pageSize,
      offset,
      total: Number(totalRow?.total) || 0,
      durationMs: 0,
    };
  }

  return {
    upsertOperations,
    listOperations,
  };
}

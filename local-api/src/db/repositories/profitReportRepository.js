import { createStableHash } from '../../utils/stableHash.js';

const REPORT_AMOUNT_FIELDS = Object.freeze([
  'beginBalanceAmount',
  'endBalanceAmount',
  'invoiceTransfer',
  'payment',
  'ordersAmount',
  'returnsAmount',
  'commissionAmount',
  'deliveryServiceFee',
  'agencyServiceFee',
  'promotionFee',
  'fboServiceFee',
  'otherServiceFee',
  'otherAccrualsFee',
  'compensationAndRestitutionFee',
  'loan',
  'itemDeliveryAndReturnAmount',
  'totalServices',
  'totalOthers',
]);

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return toNumber(value.amount ?? value.value ?? value.total);
  const normalized = String(value).trim().replace(/\s+/gu, '').replace(',', '.').replace(/[^\d.+-]/gu, '');
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = toNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return '';
}

function asItems(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Object.keys(value).length) return [value];
  return [];
}

function compactJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return null;
  }
}

function itemName(item = {}) {
  return firstText(item.name, item.title, item.type, item.service_name, item.serviceName).toLowerCase();
}

function itemPrice(item = {}) {
  return firstNumber(item.price, item.amount, item.value, item.accrued);
}

function classifyItem(item = {}) {
  const name = itemName(item);
  if (/commission|sales[_\s-]*percent|комисс|佣金/iu.test(name)) return 'commissionAmount';
  if (/partial[_\s-]*compensation|compensation|restitution|возмещ|компенса|赔偿|补偿/iu.test(name)) return 'compensationAndRestitutionFee';
  if (/loans?[_\s-]*and[_\s-]*factoring|loan|factoring|кредит|借贷|托收/iu.test(name)) return 'loan';
  if (/incoming[_\s-]*payments|offset[_\s-]*of[_\s-]*claims|defect[_\s-]*fine|fine[_\s-]*errors|зач[её]т|штраф|其他应计/iu.test(name)) return 'otherAccrualsFee';
  if (/agency|aggregator|3pl|agency[_\s-]*fee|агент/iu.test(name)) return 'agencyServiceFee';
  if (/promotion|advert|marketing|pay[_\s-]*per[_\s-]*click|star[_\s-]*products|продвиж|реклам|推广|广告/iu.test(name)) return 'promotionFee';
  if (/\bfbo\b|placement|storage|warehouse|размещ|хранен|склад/iu.test(name)) return 'fboServiceFee';
  if (/international[_\s-]*delivery|delivery|logistic|shipment|last[_\s-]*mile|достав|логист|配送|物流/iu.test(name)) return 'deliveryServiceFee';
  return 'otherServiceFee';
}

function sumItems(items = []) {
  let sum = 0;
  let found = false;
  items.forEach((item) => {
    const amount = itemPrice(item);
    if (amount === null) return;
    sum += amount;
    found = true;
  });
  return found ? sum : null;
}

function collectDetailItems(detail = {}) {
  const deliveryItems = asItems(detail.delivery?.delivery_services?.items ?? detail.delivery?.deliveryServices?.items);
  const returnItems = asItems(detail.return?.return_services?.items ?? detail.return?.returnServices?.items);
  const serviceItems = asItems(detail.services?.items);
  const otherItems = asItems(detail.others?.items);
  return { deliveryItems, returnItems, serviceItems, otherItems, all: [...deliveryItems, ...returnItems, ...serviceItems, ...otherItems] };
}

function classifiedItemTotals(items = []) {
  const totals = {};
  const counts = {};
  items.forEach((item) => {
    const amount = itemPrice(item);
    if (amount === null) return;
    const key = classifyItem(item);
    totals[key] = (totals[key] || 0) + amount;
    counts[key] = (counts[key] || 0) + 1;
  });
  return { totals, counts };
}

function addAvailable(availability, key, value, source) {
  if (value !== null) availability[key] = source;
  return value;
}

export function normalizeFinanceStatementDetail(detail = {}, { shopId } = {}) {
  const period = detail.period || {};
  const items = collectDetailItems(detail);
  const classified = classifiedItemTotals(items.all);
  const classifiedServices = classifiedItemTotals(items.serviceItems);
  const classifiedDeliveryReturns = classifiedItemTotals([...items.deliveryItems, ...items.returnItems]);
  const availability = {};
  const deliveryTotal = firstNumber(detail.delivery?.total);
  const returnTotal = firstNumber(detail.return?.total);
  const servicesTotal = firstNumber(detail.services?.total, sumItems(items.serviceItems));
  const othersTotal = firstNumber(detail.others?.total, sumItems(items.otherItems));
  const rfbsCompensation = [
    detail.rfbs?.compensation_delivery_return,
    detail.rfbs?.partial_compensation,
    detail.rfbs?.partial_compensation_return,
  ].map(toNumber).filter((value) => value !== null);
  const rfbsCompensationTotal = rfbsCompensation.length
    ? rfbsCompensation.reduce((sum, value) => sum + value, 0)
    : null;
  const periodBegin = firstText(period.begin, detail.gmtBegin, detail.begin);
  const periodEnd = firstText(period.end, detail.gmtEnd, detail.end);
  const periodId = firstText(period.id, detail.id) || createStableHash({ shopId, periodBegin, periodEnd, detail }, { length: 24 });
  const currencyCode = firstText(
    detail.payments?.currency_code,
    detail.payments?.currencyCode,
    detail.currency_code,
    detail.currency,
  ).toUpperCase();
  const itemDeliveryAndReturnAmount = deliveryTotal !== null || returnTotal !== null
    ? (deliveryTotal || 0) + (returnTotal || 0)
    : null;

  const normalized = {
    shopId: text(shopId),
    periodId,
    periodBegin,
    periodEnd,
    currencyCode,
    beginBalanceAmount: addAvailable(availability, 'beginBalanceAmount', firstNumber(detail.begin_balance_amount, detail.beginBalanceAmount), 'details.begin_balance_amount'),
    endBalanceAmount: addAvailable(availability, 'endBalanceAmount', firstNumber(detail.end_balance_amount, detail.endBalanceAmount), 'details.end_balance_amount'),
    invoiceTransfer: addAvailable(availability, 'invoiceTransfer', firstNumber(detail.invoice_transfer, detail.invoiceTransfer), 'details.invoice_transfer'),
    payment: addAvailable(availability, 'payment', firstNumber(detail.payments?.payment, detail.payment), 'details.payments.payment'),
    ordersAmount: addAvailable(availability, 'ordersAmount', firstNumber(detail.delivery?.amount, detail.orders_amount, detail.ordersAmount), 'details.delivery.amount'),
    returnsAmount: addAvailable(availability, 'returnsAmount', firstNumber(detail.return?.amount, detail.returns_amount, detail.returnsAmount), 'details.return.amount'),
    commissionAmount: addAvailable(availability, 'commissionAmount', firstNumber(detail.commission_amount, detail.commissionAmount, classified.totals.commissionAmount), classified.counts.commissionAmount ? 'details.items:commission' : 'details.commission_amount'),
    deliveryServiceFee: addAvailable(availability, 'deliveryServiceFee', firstNumber(
      detail.delivery_service_fee,
      detail.deliveryServiceFee,
      classifiedDeliveryReturns.totals.deliveryServiceFee,
      classified.totals.deliveryServiceFee,
      items.deliveryItems.length || items.returnItems.length ? null : detail.delivery?.delivery_services?.total,
      items.deliveryItems.length || items.returnItems.length ? null : detail.delivery?.deliveryServices?.total,
    ), 'details.delivery/return.items:delivery'),
    agencyServiceFee: addAvailable(availability, 'agencyServiceFee', firstNumber(detail.agency_service_fee, detail.agencyServiceFee, classified.totals.agencyServiceFee), 'details.items:agency'),
    promotionFee: addAvailable(availability, 'promotionFee', firstNumber(detail.promotion_fee, detail.promotionFee, classified.totals.promotionFee), 'details.items:promotion'),
    fboServiceFee: addAvailable(availability, 'fboServiceFee', firstNumber(detail.fbo_service_fee, detail.fboServiceFee, classified.totals.fboServiceFee), 'details.items:fbo'),
    otherServiceFee: addAvailable(availability, 'otherServiceFee', firstNumber(
      detail.other_service_fee,
      detail.otherServiceFee,
      classifiedServices.totals.otherServiceFee,
      items.serviceItems.length ? null : servicesTotal,
    ), classifiedServices.counts.otherServiceFee ? 'details.services.items:other-service' : 'details.services.total'),
    otherAccrualsFee: addAvailable(availability, 'otherAccrualsFee', firstNumber(detail.other_accruals_fee, detail.otherAccrualsFee, classified.totals.otherAccrualsFee, othersTotal), 'details.items/others:other-accruals'),
    compensationAndRestitutionFee: addAvailable(availability, 'compensationAndRestitutionFee', firstNumber(detail.compensation_and_restitution_fee, detail.compensationAndRestitutionFee, classified.totals.compensationAndRestitutionFee, rfbsCompensationTotal), 'details.rfbs/items:compensation'),
    loan: addAvailable(availability, 'loan', firstNumber(detail.loan, classified.totals.loan), 'details.loan/items:loan'),
    itemDeliveryAndReturnAmount: addAvailable(availability, 'itemDeliveryAndReturnAmount', firstNumber(detail.item_delivery_and_return_amount, detail.itemDeliveryAndReturnAmount, itemDeliveryAndReturnAmount), 'details.delivery.total+return.total'),
    totalServices: addAvailable(availability, 'totalServices', servicesTotal, 'details.services.total'),
    totalOthers: addAvailable(availability, 'totalOthers', othersTotal, 'details.others.total'),
    availability,
    details: {
      deliveryItems: items.deliveryItems,
      returnItems: items.returnItems,
      serviceItems: items.serviceItems,
      otherItems: items.otherItems,
      rfbs: detail.rfbs || null,
    },
    raw: detail,
  };
  normalized.remoteHash = createStableHash(normalized, { length: 40 });
  return normalized;
}

export function normalizeFinanceBalance(payload = {}, { shopId } = {}) {
  const result = payload?.result ?? payload?.data ?? payload;
  const total = result?.total ?? {};
  const closingBalance = total?.closing_balance ?? total?.closingBalance;
  const balanceAmount = firstNumber(
    closingBalance?.value,
    closingBalance?.amount,
    result?.balance,
    result?.current_balance,
    result?.currentBalance,
    result?.balance_amount,
    result?.balanceAmount,
    result?.amount,
  );
  const currencyCode = firstText(
    closingBalance?.currency_code,
    closingBalance?.currencyCode,
    closingBalance?.currency,
    total?.opening_balance?.currency_code,
    total?.accrued?.currency_code,
    result?.currency_code,
    result?.currencyCode,
    result?.currency,
    result?.balance?.currency,
  ).toUpperCase();
  const recordedAt = nowIso();
  const normalized = {
    shopId: text(shopId),
    balanceAmount,
    currencyCode,
    availability: balanceAmount === null ? {} : { balanceAmount: 'finance.balance' },
    raw: payload,
    recordedAt,
  };
  normalized.remoteHash = createStableHash({
    shopId: normalized.shopId,
    balanceAmount: normalized.balanceAmount,
    currencyCode: normalized.currencyCode,
    availability: normalized.availability,
    raw: normalized.raw,
  }, { length: 40 });
  return normalized;
}

export function normalizeFinanceBalanceReportDetail(payload = {}, { shopId, from = '', to = '' } = {}) {
  const result = payload?.result ?? payload?.data ?? payload;
  const total = result?.total ?? {};
  const cashflows = result?.cashflows ?? {};
  const services = asItems(cashflows.services).map((item) => ({
    name: firstText(item.name, item.type),
    price: firstNumber(item.amount?.value, item.amount, item.value),
  }));
  const paymentRows = asItems(total.payments);
  const payment = paymentRows.map((item) => firstNumber(item.value, item.amount)).filter((value) => value !== null);
  const salesFee = firstNumber(cashflows.sales?.fee?.value, cashflows.sales?.fee);
  const returnsFee = firstNumber(cashflows.returns?.fee?.value, cashflows.returns?.fee);
  const commissionAmount = salesFee !== null || returnsFee !== null ? (salesFee || 0) + (returnsFee || 0) : null;
  const currencyCode = firstText(
    total.closing_balance?.currency_code,
    total.opening_balance?.currency_code,
    total.accrued?.currency_code,
    paymentRows[0]?.currency_code,
    cashflows.sales?.amount?.currency_code,
  ).toUpperCase();
  return {
    period: {
      id: `balance:${text(from).slice(0, 10)}:${text(to).slice(0, 10)}`,
      begin: text(from).slice(0, 10),
      end: text(to).slice(0, 10),
    },
    currency_code: currencyCode,
    begin_balance_amount: firstNumber(total.opening_balance?.value, total.openingBalance?.value),
    end_balance_amount: firstNumber(total.closing_balance?.value, total.closingBalance?.value),
    invoice_transfer: firstNumber(total.accrued?.value, total.accrued),
    payment: payment.length ? payment.reduce((sum, value) => sum + value, 0) : null,
    orders_amount: firstNumber(cashflows.sales?.amount?.value, cashflows.sales?.amount),
    returns_amount: firstNumber(cashflows.returns?.amount?.value, cashflows.returns?.amount),
    commission_amount: commissionAmount,
    services: { total: sumItems(services), items: services },
    raw_balance_report: result,
    shop_id: text(shopId),
  };
}

function splitIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(text).filter(Boolean))];
  return [...new Set(text(value).split(',').map((item) => item.trim()).filter(Boolean))];
}

function placeholders(values = []) {
  return values.map(() => '?').join(',');
}

function publicStatement(row = {}) {
  const result = {
    id: row.id,
    shopId: row.shop_id,
    shopName: row.shop_alias || row.shop_name || row.shop_id,
    periodId: row.period_id,
    periodBegin: row.period_begin,
    periodEnd: row.period_end,
    currencyCode: row.currency_code || 'RUB',
    availability: JSON.parse(row.availability_json || '{}'),
    details: JSON.parse(row.details_json || '{}'),
    updatedAt: row.updated_at,
  };
  const map = {
    beginBalanceAmount: 'begin_balance_amount', endBalanceAmount: 'end_balance_amount', invoiceTransfer: 'invoice_transfer',
    payment: 'payment', ordersAmount: 'orders_amount', returnsAmount: 'returns_amount', commissionAmount: 'commission_amount',
    deliveryServiceFee: 'delivery_service_fee', agencyServiceFee: 'agency_service_fee', promotionFee: 'promotion_fee',
    fboServiceFee: 'fbo_service_fee', otherServiceFee: 'other_service_fee', otherAccrualsFee: 'other_accruals_fee',
    compensationAndRestitutionFee: 'compensation_and_restitution_fee', loan: 'loan',
    itemDeliveryAndReturnAmount: 'item_delivery_and_return_amount', totalServices: 'total_services', totalOthers: 'total_others',
  };
  Object.entries(map).forEach(([key, column]) => { result[key] = row[column] ?? null; });
  return result;
}

export function createProfitReportRepository(db, { readDb = db } = {}) {
  const upsertStatementSql = db.prepare(`
    INSERT INTO ozon_finance_statement_reports (
      id, shop_id, period_id, period_begin, period_end, currency_code,
      begin_balance_amount, end_balance_amount, invoice_transfer, payment,
      orders_amount, returns_amount, commission_amount, delivery_service_fee, agency_service_fee,
      promotion_fee, fbo_service_fee, other_service_fee, other_accruals_fee,
      compensation_and_restitution_fee, loan, item_delivery_and_return_amount, total_services, total_others,
      availability_json, details_json, raw_json, remote_hash, last_seen_at, created_at, updated_at
    ) VALUES (${Array.from({ length: 31 }, () => '?').join(', ')})
    ON CONFLICT(shop_id, period_id) DO UPDATE SET
      period_begin=excluded.period_begin, period_end=excluded.period_end, currency_code=excluded.currency_code,
      begin_balance_amount=excluded.begin_balance_amount, end_balance_amount=excluded.end_balance_amount,
      invoice_transfer=excluded.invoice_transfer, payment=excluded.payment, orders_amount=excluded.orders_amount,
      returns_amount=excluded.returns_amount, commission_amount=excluded.commission_amount,
      delivery_service_fee=excluded.delivery_service_fee, agency_service_fee=excluded.agency_service_fee,
      promotion_fee=excluded.promotion_fee, fbo_service_fee=excluded.fbo_service_fee,
      other_service_fee=excluded.other_service_fee, other_accruals_fee=excluded.other_accruals_fee,
      compensation_and_restitution_fee=excluded.compensation_and_restitution_fee, loan=excluded.loan,
      item_delivery_and_return_amount=excluded.item_delivery_and_return_amount,
      total_services=excluded.total_services, total_others=excluded.total_others,
      availability_json=excluded.availability_json, details_json=excluded.details_json, raw_json=excluded.raw_json,
      remote_hash=excluded.remote_hash, last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at
  `);

  function upsertStatements({ shopId, rows = [] } = {}) {
    const timestamp = nowIso();
    let changed = 0;
    db.exec('BEGIN;');
    try {
      rows.forEach((detail) => {
        const row = normalizeFinanceStatementDetail(detail, { shopId });
        const existing = db.prepare('SELECT remote_hash FROM ozon_finance_statement_reports WHERE shop_id = ? AND period_id = ?').get(shopId, row.periodId);
        upsertStatementSql.run(
          `finance_statement_${createStableHash({ shopId, periodId: row.periodId }, { length: 28 })}`,
          shopId, row.periodId, row.periodBegin || null, row.periodEnd || null, row.currencyCode || null,
          ...REPORT_AMOUNT_FIELDS.map((field) => row[field]),
          compactJson(row.availability), compactJson(row.details), compactJson(row.raw), row.remoteHash,
          timestamp, existing ? timestamp : timestamp, timestamp,
        );
        if (!existing || existing.remote_hash !== row.remoteHash) changed += 1;
      });
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    return { ok: true, rows: rows.length, changed, unchanged: rows.length - changed };
  }

  function upsertBalance({ shopId, payload, from = '', to = '' } = {}) {
    const row = normalizeFinanceBalance(payload, { shopId });
    const dateFrom = text(from).slice(0, 10);
    const dateTo = text(to).slice(0, 10);
    const existing = db.prepare(`
      SELECT id, recorded_at FROM ozon_finance_balance_snapshots
      WHERE shop_id = ? AND COALESCE(date_from, '') = ? AND COALESCE(date_to, '') = ? AND remote_hash = ?
      ORDER BY recorded_at DESC LIMIT 1
    `).get(shopId, dateFrom, dateTo, row.remoteHash);
    if (existing) return { ok: true, changed: 0, unchanged: 1, row: { ...row, recordedAt: existing.recorded_at } };
    const id = `finance_balance_${createStableHash({ shopId, dateFrom, dateTo, recordedAt: row.recordedAt }, { length: 28 })}`;
    db.prepare(`
      INSERT INTO ozon_finance_balance_snapshots (
        id, shop_id, balance_amount, currency_code, availability_json, raw_json,
        remote_hash, recorded_at, created_at, updated_at, date_from, date_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, shopId, row.balanceAmount, row.currencyCode || null, compactJson(row.availability), compactJson(row.raw), row.remoteHash, row.recordedAt, row.recordedAt, row.recordedAt, dateFrom || null, dateTo || null);
    return { ok: true, changed: 1, row };
  }

  function repairCachedBalanceReports() {
    const cacheRows = db.prepare(`
      SELECT shop_id, cache_key, payload_json, updated_at
      FROM ozon_response_cache
      WHERE domain = 'profit-report'
        AND endpoint_key = 'profitReport.balance'
        AND status IN ('confirmed', 'partial')
        AND COALESCE(payload_json, '') <> ''
      ORDER BY updated_at DESC
    `).all();
    const repairedScopes = new Set();
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;
    for (const cacheRow of cacheRows) {
      const match = text(cacheRow.cache_key).match(/:([0-9]{4}-[0-9]{2}-[0-9]{2}):([0-9]{4}-[0-9]{2}-[0-9]{2})$/u);
      const shopId = text(cacheRow.shop_id);
      if (!shopId || !match) { skipped += 1; continue; }
      const from = match[1];
      const to = match[2];
      const scopeKey = `${shopId}:${from}:${to}`;
      if (repairedScopes.has(scopeKey)) continue;
      repairedScopes.add(scopeKey);
      let payload;
      try { payload = JSON.parse(cacheRow.payload_json); } catch { skipped += 1; continue; }
      const balanceMerge = upsertBalance({ shopId, payload, from, to });
      const detail = normalizeFinanceBalanceReportDetail(payload, { shopId, from, to });
      const statementMerge = upsertStatements({ shopId, rows: [detail] });
      changed += Number(balanceMerge.changed || 0) + Number(statementMerge.changed || 0);
      unchanged += Number(balanceMerge.unchanged || 0) + Number(statementMerge.unchanged || 0);
    }
    return { ok: true, scopes: repairedScopes.size, changed, unchanged, skipped };
  }

  function readReport(query = {}) {
    const db = readDb;
    const shopIds = splitIds(query.shopIds ?? query.shop_ids ?? query.shopId ?? query.shop_id);
    const params = [];
    const where = [];
    if (shopIds.length) {
      where.push(`r.shop_id IN (${placeholders(shopIds)})`);
      params.push(...shopIds);
    }
    const from = text(query.from ?? query.since ?? query.gmtBegin);
    const to = text(query.to ?? query.gmtEnd);
    if (from) { where.push('(r.period_end IS NULL OR r.period_end >= ?)'); params.push(from); }
    if (to) { where.push('(r.period_begin IS NULL OR r.period_begin <= ?)'); params.push(to); }
    const limit = Math.min(Math.max(Number(query.pageSize ?? query.page_size) || 200, 1), 1000);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT r.*, s.name AS shop_name, s.alias AS shop_alias
      FROM ozon_finance_statement_reports r
      LEFT JOIN shops s ON s.id = r.shop_id
      ${clause}
      ORDER BY r.period_begin DESC, r.shop_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset).map(publicStatement);
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM ozon_finance_statement_reports r ${clause}`).get(...params)?.count || 0);
    const balanceFilters = [];
    const balanceParams = [];
    if (shopIds.length) { balanceFilters.push(`b.shop_id IN (${placeholders(shopIds)})`); balanceParams.push(...shopIds); }
    if (from) { balanceFilters.push('b.date_from = ?'); balanceParams.push(from.slice(0, 10)); }
    if (to) { balanceFilters.push('b.date_to = ?'); balanceParams.push(to.slice(0, 10)); }
    balanceFilters.push(`b.recorded_at = (
      SELECT MAX(candidate.recorded_at)
      FROM ozon_finance_balance_snapshots candidate
      WHERE candidate.shop_id = b.shop_id
        AND COALESCE(candidate.date_from, '') = COALESCE(b.date_from, '')
        AND COALESCE(candidate.date_to, '') = COALESCE(b.date_to, '')
    )`);
    const balanceWhere = balanceFilters.length ? `WHERE ${balanceFilters.join(' AND ')}` : '';
    const balances = db.prepare(`
      SELECT b.*, s.name AS shop_name, s.alias AS shop_alias
      FROM ozon_finance_balance_snapshots b
      LEFT JOIN shops s ON s.id = b.shop_id
      ${balanceWhere}
      ORDER BY COALESCE(s.alias, s.name, b.shop_id)
    `).all(...balanceParams).map((row) => ({
      id: row.id,
      shopId: row.shop_id,
      shopName: row.shop_alias || row.shop_name || row.shop_id,
      balanceAmount: row.balance_amount ?? null,
      currencyCode: row.currency_code || 'RUB',
      availability: JSON.parse(row.availability_json || '{}'),
      recordedAt: row.recorded_at,
      dateFrom: row.date_from || '',
      dateTo: row.date_to || '',
    }));
    const totalsByCurrency = {};
    rows.forEach((row) => {
      const currency = row.currencyCode || 'UNKNOWN';
      const target = totalsByCurrency[currency] || { currencyCode: currency, rowCount: 0 };
      target.rowCount += 1;
      REPORT_AMOUNT_FIELDS.forEach((field) => {
        if (row[field] === null || row[field] === undefined) return;
        target[field] = (target[field] || 0) + Number(row[field]);
        target[`${field}ReturnedRows`] = (target[`${field}ReturnedRows`] || 0) + 1;
      });
      totalsByCurrency[currency] = target;
    });
    const updatedAt = [...rows.map((row) => row.updatedAt), ...balances.map((row) => row.recordedAt)].filter(Boolean).sort().at(-1) || '';
    return { ok: true, domain: 'profit-report', rows, balances, total, totalsByCurrency, updatedAt };
  }

  return { upsertStatements, upsertBalance, repairCachedBalanceReports, readReport };
}

export { REPORT_AMOUNT_FIELDS };

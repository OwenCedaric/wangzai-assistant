const SALES_ORDER_STATUS_SCOPES = new Set([
  '等待备货',
  '等待发货',
  '即将超时',
  '发货超时',
  '已经发货',
  '售后订单',
  '成功订单',
  '关闭订单',
  '未知状态',
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeSqlTableAlias(value) {
  const alias = normalizeText(value);
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(alias) ? alias : '';
}

function sqlColumn(name, tableAlias = '') {
  const alias = normalizeSqlTableAlias(tableAlias);
  return alias ? `${alias}.${name}` : name;
}

function sqlStatusExpression(tableAlias = '') {
  return `LOWER(COALESCE(${sqlColumn('status', tableAlias)}, ''))`;
}

function sqlDeadlineExpression(tableAlias = '') {
  return `datetime(COALESCE(${sqlColumn('cutoff_at', tableAlias)}, ${sqlColumn('shipment_date', tableAlias)}, ${sqlColumn('delivering_date', tableAlias)}, ''))`;
}

function sqlAwaitingPackagingPredicate(statusExpression) {
  return `(${statusExpression} LIKE '%awaiting_packaging%' OR ${statusExpression} LIKE '%awaiting_registration%')`;
}

function sqlAwaitingDeliveryPredicate(statusExpression) {
  return `(${statusExpression} LIKE '%awaiting_deliver%' OR ${statusExpression} LIKE '%awaiting_delivery%')`;
}

function sqlDeliveredPredicate(statusExpression) {
  return `${statusExpression} LIKE '%delivered%'`;
}

function sqlClosedPredicate(statusExpression) {
  return `(${statusExpression} LIKE '%cancel%' OR ${statusExpression} LIKE '%not_accepted%')`;
}

function sqlAfterSalesPredicate(statusExpression) {
  return `${statusExpression} LIKE '%return%'`;
}

function sqlShippingPredicate(statusExpression) {
  return `(${statusExpression} LIKE '%delivering%' OR ${statusExpression} LIKE '%driver_pickup%' OR ${statusExpression} LIKE '%arbitration%' OR ${statusExpression} LIKE '%client_arbitration%')`;
}

export function normalizeSalesOrderStatusScope(value) {
  const scope = normalizeText(value);
  return SALES_ORDER_STATUS_SCOPES.has(scope) ? scope : '';
}

/** Builds the canonical SQLite predicate for the sales-order status tabs. */
export function buildSalesOrderStatusScopeClause(value, options = {}) {
  const scope = normalizeSalesOrderStatusScope(value);
  if (!scope) return '';

  const statusExpression = sqlStatusExpression(options.tableAlias);
  const deadlineExpression = sqlDeadlineExpression(options.tableAlias);
  const awaitingPackaging = sqlAwaitingPackagingPredicate(statusExpression);
  const awaitingDelivery = sqlAwaitingDeliveryPredicate(statusExpression);
  const awaiting = `(${awaitingPackaging} OR ${awaitingDelivery})`;
  const delivered = sqlDeliveredPredicate(statusExpression);
  const closed = sqlClosedPredicate(statusExpression);
  const afterSales = sqlAfterSalesPredicate(statusExpression);
  const shipping = sqlShippingPredicate(statusExpression);

  switch (scope) {
    case '等待备货': return awaitingPackaging;
    case '等待发货': return awaitingDelivery;
    case '即将超时': return `(${awaiting} AND ${deadlineExpression} > datetime('now') AND ${deadlineExpression} <= datetime('now', '+6 hours'))`;
    case '发货超时': return `(${awaiting} AND ${deadlineExpression} IS NOT NULL AND ${deadlineExpression} < datetime('now'))`;
    case '已经发货': return shipping;
    case '售后订单': return afterSales;
    case '成功订单': return delivered;
    case '关闭订单': return closed;
    case '未知状态': return `(NOT (${awaitingPackaging} OR ${awaitingDelivery} OR ${shipping} OR ${delivered} OR ${closed} OR ${afterSales}))`;
    default: return '';
  }
}

export function getSalesOrderStatusTagsFromCacheRow(row = {}, nowMs = Date.now()) {
  const status = normalizeText(row.status).toLowerCase();
  const baseStatus = status.includes('awaiting_packaging') || status.includes('awaiting_registration')
    ? '等待备货'
    : status.includes('awaiting_deliver') || status.includes('awaiting_delivery')
      ? '等待发货'
      : status.includes('delivering') || status.includes('driver_pickup') || status.includes('arbitration') || status.includes('client_arbitration')
        ? '已经发货'
        : status.includes('delivered')
          ? '成功订单'
          : status.includes('cancel') || status.includes('not_accepted')
            ? '关闭订单'
            : status.includes('return')
              ? '售后订单'
              : '未知状态';
  const deadlineRaw = row.cutoffAt ?? row.cutoff_at ?? row.shipmentDate ?? row.shipment_date ?? row.deliveringDate ?? row.delivering_date;
  const deadlineMs = Date.parse(String(deadlineRaw || ''));
  const isAwaiting = baseStatus === '等待备货' || baseStatus === '等待发货';
  const riskStatus = isAwaiting && Number.isFinite(deadlineMs)
    ? deadlineMs < nowMs
      ? '发货超时'
      : deadlineMs - nowMs <= 6 * 60 * 60 * 1000
        ? '即将超时'
        : ''
    : '';
  return [baseStatus, riskStatus].filter(Boolean);
}

export function createSalesOrderStatusCounts(rows = [], nowMs = Date.now()) {
  const counts = { all: 0 };
  for (const row of rows) {
    counts.all += 1;
    for (const tag of getSalesOrderStatusTagsFromCacheRow(row, nowMs)) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }
  return counts;
}

/** SQL aggregate counterpart of getSalesOrderStatusTagsFromCacheRow for hot list summaries. */
export function buildSalesOrderStatusSummaryColumns() {
  const statusExpression = sqlStatusExpression();
  const deadlineExpression = sqlDeadlineExpression();
  const awaitingPackaging = sqlAwaitingPackagingPredicate(statusExpression);
  const awaitingDelivery = sqlAwaitingDeliveryPredicate(statusExpression);
  const awaiting = `(${awaitingPackaging} OR ${awaitingDelivery})`;
  const delivered = sqlDeliveredPredicate(statusExpression);
  const closed = sqlClosedPredicate(statusExpression);
  const afterSales = sqlAfterSalesPredicate(statusExpression);
  const shipping = sqlShippingPredicate(statusExpression);
  const known = `(${awaitingPackaging} OR ${awaitingDelivery} OR ${shipping} OR ${delivered} OR ${closed} OR ${afterSales})`;
  return `
    SUM(CASE WHEN ${awaitingPackaging} THEN 1 ELSE 0 END) AS awaiting_packaging_count,
    SUM(CASE WHEN ${awaitingDelivery} THEN 1 ELSE 0 END) AS awaiting_delivery_count,
    SUM(CASE WHEN ${awaiting} AND ${deadlineExpression} > datetime('now') AND ${deadlineExpression} <= datetime('now', '+6 hours') THEN 1 ELSE 0 END) AS due_soon_count,
    SUM(CASE WHEN ${awaiting} AND ${deadlineExpression} IS NOT NULL AND ${deadlineExpression} < datetime('now') THEN 1 ELSE 0 END) AS overdue_count,
    SUM(CASE WHEN ${shipping} THEN 1 ELSE 0 END) AS shipping_count,
    SUM(CASE WHEN ${afterSales} THEN 1 ELSE 0 END) AS after_sales_count,
    SUM(CASE WHEN ${delivered} THEN 1 ELSE 0 END) AS delivered_count,
    SUM(CASE WHEN ${closed} THEN 1 ELSE 0 END) AS closed_count,
    SUM(CASE WHEN NOT ${known} THEN 1 ELSE 0 END) AS unknown_count
  `;
}

export function createSalesOrderStatusCountsFromSummaryRow(row = {}) {
  const number = (key) => Number(row[key]) || 0;
  return Object.fromEntries(Object.entries({
    all: number('total'),
    '等待备货': number('awaiting_packaging_count'),
    '等待发货': number('awaiting_delivery_count'),
    '即将超时': number('due_soon_count'),
    '发货超时': number('overdue_count'),
    '已经发货': number('shipping_count'),
    '售后订单': number('after_sales_count'),
    '成功订单': number('delivered_count'),
    '关闭订单': number('closed_count'),
    '未知状态': number('unknown_count'),
  }).filter(([key, value]) => key === 'all' || value > 0));
}

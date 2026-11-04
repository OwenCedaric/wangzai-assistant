import { buildSalesOrderStatusScopeClause } from '../orders/ordersQueryRules.js';

const MAX_SCOPED_SHOPS = 100;
const PURCHASE_STAGE_STATUSES = [
  '待拍单',
  '已拍单-待预报',
  '已拍单-待发货',
  '已拍单-已发货',
  '已拍单-未操作',
  '已拍单-售后单',
  '完结单',
  '关闭单',
];

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeShopIds(value) {
  const rawValues = Array.isArray(value) ? value : normalizeText(value).split(',');
  return [...new Set(rawValues.map(normalizeText).filter(Boolean))];
}

function normalizeIsoDate(value) {
  const text = normalizeText(value);
  if (!text || !Number.isFinite(Date.parse(text))) return '';
  return text;
}

function createCounts(row = {}) {
  return {
    salesOrderCount: Math.max(0, Number(row.sales_order_count) || 0),
    pendingPurchaseCount: Math.max(0, Number(row.pending_purchase_count) || 0),
    afterSalesTodoCount: Math.max(0, Number(row.after_sales_todo_count) || 0),
    stockWarningCount: Math.max(0, Number(row.stock_warning_count) || 0),
  };
}

function createEmptyPayload(shopIds = []) {
  return {
    ok: true,
    domain: 'dashboard-business-share',
    source: 'sqlite',
    scope: { shopIds },
    counts: createCounts(),
    byShop: shopIds.map((shopId) => ({ shopId, ...createCounts() })),
  };
}

function parseByShop(value, shopIds = []) {
  let rows = [];
  try {
    rows = JSON.parse(normalizeText(value) || '[]');
  } catch {
    rows = [];
  }
  const byId = new Map(
    (Array.isArray(rows) ? rows : []).map((row) => [normalizeText(row?.shopId), createCounts(row)])
  );
  return shopIds.map((shopId) => ({ shopId, ...(byId.get(shopId) || createCounts()) }));
}

function createReadError(error, code = 'DASHBOARD_BUSINESS_SHARE_READ_FAILED', shopIds = []) {
  return {
    ok: false,
    domain: 'dashboard-business-share',
    source: 'sqlite',
    scope: { shopIds },
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function safeJsonExtract(alias, path) {
  return `(CASE WHEN json_valid(${alias}.raw_json) THEN json_extract(${alias}.raw_json, '${path}') END)`;
}

function firstTextSql(...expressions) {
  return `COALESCE(${expressions.map((expression) => `NULLIF(TRIM(CAST(${expression} AS TEXT)), '')`).join(', ')}, '')`;
}

function buildPurchaseProjection() {
  const platform = firstTextSql(
    'po.purchase_platform',
    safeJsonExtract('po', '$.manualBuyerPlatform'),
    safeJsonExtract('po', '$.buyerPlatform'),
    safeJsonExtract('po', '$.supplier')
  );
  const orderNumber = firstTextSql(
    'po.purchase_order_number',
    safeJsonExtract('po', '$.manualPurchaseOrderNo'),
    safeJsonExtract('po', '$.purchaseOrderNo'),
    safeJsonExtract('po', '$.purchaseOrderNumber')
  );
  const price = `COALESCE(
    po.source_cost_cny,
    CAST(${safeJsonExtract('po', '$.manualPurchasePriceValue')} AS REAL),
    CAST(${safeJsonExtract('po', '$.manualPurchasePrice')} AS REAL),
    CAST(${safeJsonExtract('po', '$.purchasePriceValue')} AS REAL),
    CAST(${safeJsonExtract('po', '$.purchasePrice')} AS REAL),
    0
  )`;
  const purchaseStatus = firstTextSql(
    'po.manual_status',
    safeJsonExtract('po', '$.manualPurchaseOrderStatus'),
    safeJsonExtract('po', '$.purchaseOrderStatus'),
    safeJsonExtract('po', '$.purchaseStatus')
  );
  const rawForceStatus = firstTextSql(safeJsonExtract('po', '$.forcePurchaseStatus'));
  const forceStatusValues = PURCHASE_STAGE_STATUSES.map((value) => `'${value}'`).join(', ');
  const forceStatus = `(CASE
    WHEN ${rawForceStatus} IN (${forceStatusValues}) THEN ${rawForceStatus}
    WHEN TRIM(COALESCE(po.manual_status, '')) IN (${forceStatusValues}) THEN TRIM(po.manual_status)
    ELSE ''
  END)`;
  const recordStatus = `LOWER(${firstTextSql(safeJsonExtract('po', '$.purchaseRecordStatus'))})`;
  const conflict = `(CASE WHEN
    ${recordStatus} IN ('conflict', 'duplicate', 'voided', 'refunded')
    OR COALESCE(CAST(${safeJsonExtract('po', '$.purchaseException')} AS INTEGER), 0) <> 0
    OR COALESCE(CAST(${safeJsonExtract('po', '$.crossBorderStatusConflict')} AS INTEGER), 0) <> 0
    OR COALESCE(CAST(${safeJsonExtract('po', '$.crossBorderOrderCount')} AS INTEGER), 0) > 1
    OR (json_valid(${safeJsonExtract('po', '$.packageOrderIds')}) AND json_array_length(${safeJsonExtract('po', '$.packageOrderIds')}) > 1)
    THEN 1 ELSE 0 END)`;

  return { platform, orderNumber, price, purchaseStatus, forceStatus, conflict };
}

function buildConfirmedPurchasePredicate(alias = 'ops') {
  const platform = `LOWER(TRIM(COALESCE(${alias}.purchase_platform, '')))`;
  const orderNumber = `LOWER(TRIM(COALESCE(${alias}.purchase_order_number, '')))`;
  const status = `LOWER(TRIM(COALESCE(${alias}.purchase_status, '')))`;
  const emptyValues = "('', '-', '--', '未返回', '待确认', '待补录', '待拍单', 'null', 'undefined', '0')";
  const confirmedStatus = `(
    ${status} LIKE '%已付款%' OR ${status} LIKE '%支付成功%' OR
    ${status} LIKE '%待发货%' OR ${status} LIKE '%等待卖家发货%' OR
    ${status} LIKE '%买家已付款%' OR ${status} LIKE '%已发货%' OR
    ${status} LIKE '%待收货%' OR ${status} LIKE '%已完成%'
  )`;
  const rejectedStatus = `(
    ${status} LIKE '%待付款%' OR ${status} LIKE '%退款%' OR
    ${status} LIKE '%关闭%' OR ${status} LIKE '%取消%' OR
    ${status} LIKE '%未识别%' OR ${status} LIKE '%未返回%'
  )`;
  return `(
    ${alias}.has_purchase_conflict = 0
    AND ${platform} NOT IN ${emptyValues}
    AND ${orderNumber} NOT IN ${emptyValues}
    AND COALESCE(${alias}.purchase_price, 0) > 0
    AND ${confirmedStatus}
    AND NOT ${rejectedStatus}
  )`;
}

function buildAfterSalesVisiblePredicate(alias = 'r') {
  const excluded = firstTextSql(
    safeJsonExtract(alias, '$.excludeFromAfterSales'),
    safeJsonExtract(alias, '$.classification.excludeFromAfterSales'),
    safeJsonExtract(alias, '$.display.excludeFromAfterSales')
  );
  return `LOWER(${excluded}) NOT IN ('1', 'true', 'yes')`;
}

function buildAfterSalesReturnIdentity(alias = 'r') {
  return firstTextSql(
    `${alias}.return_id`,
    safeJsonExtract(alias, '$.return_id'),
    safeJsonExtract(alias, '$.returnId'),
    safeJsonExtract(alias, '$.afterSalesId'),
    safeJsonExtract(alias, '$.after_sales_id'),
    safeJsonExtract(alias, '$.request_id'),
    safeJsonExtract(alias, '$.requestId')
  );
}

function buildAfterSalesPosting(alias = 'r') {
  return firstTextSql(
    `${alias}.posting_number`,
    safeJsonExtract(alias, '$.posting_number'),
    safeJsonExtract(alias, '$.postingNumber'),
    safeJsonExtract(alias, '$.order_number'),
    safeJsonExtract(alias, '$.orderNumber'),
    `${alias}.order_id`,
    safeJsonExtract(alias, '$.order_id'),
    safeJsonExtract(alias, '$.orderId')
  );
}

function buildAfterSalesSource(alias = 'r') {
  return `LOWER(${firstTextSql(`${alias}.source`, safeJsonExtract(alias, '$.source'))})`;
}

function buildNumericBasePostingPredicate(expression) {
  const firstDash = `instr(${expression}, '-')`;
  const prefix = `substr(${expression}, 1, ${firstDash} - 1)`;
  const suffix = `substr(${expression}, ${firstDash} + 1)`;
  return `(
    ${firstDash} >= 7
    AND length(${suffix}) >= 3
    AND instr(${suffix}, '-') = 0
    AND ${prefix} NOT GLOB '*[^0-9]*'
    AND ${suffix} NOT GLOB '*[^0-9]*'
  )`;
}

/** One SQLite-only aggregate for the Dashboard donut; it never materializes rows in the renderer. */
export function createDashboardBusinessShareReadModel({ db } = {}) {
  function read(query = {}) {
    const shopIds = normalizeShopIds(query.shopIds ?? query.shop_ids);
    if (!shopIds.length) return createEmptyPayload();
    if (shopIds.length > MAX_SCOPED_SHOPS) {
      return createReadError(
        new Error(`Dashboard 店铺范围超过 ${MAX_SCOPED_SHOPS} 个，已拒绝不完整统计。`),
        'DASHBOARD_BUSINESS_SHARE_SCOPE_TOO_LARGE',
        shopIds
      );
    }
    if (!db?.prepare) {
      return createReadError(new Error('Dashboard SQLite read model is not connected.'), undefined, shopIds);
    }

    const salesSince = normalizeIsoDate(query.salesSince ?? query.sales_since);
    const salesTo = normalizeIsoDate(query.salesTo ?? query.sales_to);
    const afterSalesSince = normalizeIsoDate(query.afterSalesSince ?? query.after_sales_since);
    const afterSalesTo = normalizeIsoDate(query.afterSalesTo ?? query.after_sales_to);
    const params = [...shopIds];
    const salesDateClauses = [];
    const afterSalesDateClauses = [];
    const salesDateExpression = 'COALESCE(o.payment_at, o.in_process_at)';
    const afterSalesDateExpression = 'COALESCE(r.updated_at_remote, r.created_at_remote, r.updated_at, r.created_at)';

    if (salesSince) {
      salesDateClauses.push(`(${salesDateExpression} IS NULL OR ${salesDateExpression} >= ?)`);
      params.push(salesSince);
    }
    if (salesTo) {
      salesDateClauses.push(`(${salesDateExpression} IS NULL OR ${salesDateExpression} <= ?)`);
      params.push(salesTo);
    }
    if (afterSalesSince) {
      afterSalesDateClauses.push(`(${afterSalesDateExpression} IS NULL OR ${afterSalesDateExpression} >= ?)`);
      params.push(afterSalesSince);
    }
    if (afterSalesTo) {
      afterSalesDateClauses.push(`(${afterSalesDateExpression} IS NULL OR ${afterSalesDateExpression} <= ?)`);
      params.push(afterSalesTo);
    }

    const scopedShopValues = shopIds.map(() => '(?)').join(', ');
    const salesDateWhere = salesDateClauses.length ? ` AND ${salesDateClauses.join(' AND ')}` : '';
    const afterSalesDateWhere = afterSalesDateClauses.length ? ` AND ${afterSalesDateClauses.join(' AND ')}` : '';
    const purchase = buildPurchaseProjection();
    const awaitingPackaging = buildSalesOrderStatusScopeClause('等待备货', { tableAlias: 'ops' });
    const confirmedPurchase = buildConfirmedPurchasePredicate('ops');
    const visibleAfterSales = buildAfterSalesVisiblePredicate('r');
    const returnIdentity = buildAfterSalesReturnIdentity('r');
    const returnPosting = buildAfterSalesPosting('r');
    const returnSource = buildAfterSalesSource('r');

    try {
      const row = db
        .prepare(
          `
            WITH scoped_shops(shop_id) AS (VALUES ${scopedShopValues}),
            scoped_orders AS (
              SELECT o.*
              FROM ozon_orders o
              WHERE o.is_stale = 0
                AND o.shop_id IN (SELECT shop_id FROM scoped_shops)
                ${salesDateWhere}
            ),
            order_purchase_state AS (
              SELECT
                o.id,
                o.shop_id,
                o.status,
                MAX(${purchase.platform}) AS purchase_platform,
                MAX(${purchase.orderNumber}) AS purchase_order_number,
                MAX(${purchase.price}) AS purchase_price,
                MAX(${purchase.purchaseStatus}) AS purchase_status,
                MAX(${purchase.forceStatus}) AS force_purchase_status,
                MAX(${purchase.conflict}) AS has_purchase_conflict
              FROM scoped_orders o
              LEFT JOIN purchase_order_overrides po
                ON po.shop_id = o.shop_id
               AND (
                 po.order_key = o.order_key OR
                 (o.posting_number IS NOT NULL AND po.posting_number = o.posting_number) OR
                 (o.order_id IS NOT NULL AND po.ozon_order_id = o.order_id)
               )
              GROUP BY o.id, o.shop_id, o.status
            ),
            sales_by_shop AS (
              SELECT
                ops.shop_id,
                COUNT(*) AS sales_order_count,
                COALESCE(SUM(CASE WHEN
                  ops.has_purchase_conflict = 0
                  AND NOT ${confirmedPurchase}
                  AND (${awaitingPackaging} OR ops.force_purchase_status = '待拍单')
                  AND ops.force_purchase_status IN ('', '待拍单')
                  THEN 1 ELSE 0 END), 0) AS pending_purchase_count
              FROM order_purchase_state ops
              GROUP BY ops.shop_id
            ),
            scoped_after_sales AS (
              SELECT
                r.*,
                ${returnIdentity} AS dashboard_return_identity,
                ${returnPosting} AS dashboard_exact_posting,
                ${returnSource} AS dashboard_source
              FROM ozon_returns r
              WHERE r.is_stale = 0
                AND r.shop_id IN (SELECT shop_id FROM scoped_shops)
                AND ${visibleAfterSales}
                ${afterSalesDateWhere}
            ),
            visible_after_sales AS (
              SELECT r.*
              FROM scoped_after_sales r
              WHERE NOT (
                r.dashboard_source = 'order-cancelled'
                AND r.dashboard_return_identity = ''
                AND r.dashboard_exact_posting <> ''
                AND EXISTS (
                  SELECT 1
                  FROM scoped_after_sales concrete
                  WHERE concrete.shop_id = r.shop_id
                    AND concrete.dashboard_return_identity <> ''
                    AND (
                      concrete.dashboard_exact_posting = r.dashboard_exact_posting
                      OR (
                        ${buildNumericBasePostingPredicate('r.dashboard_exact_posting')}
                        AND concrete.dashboard_exact_posting LIKE r.dashboard_exact_posting || '-%'
                        AND substr(
                          concrete.dashboard_exact_posting,
                          length(r.dashboard_exact_posting) + 2
                        ) <> ''
                        AND substr(
                          concrete.dashboard_exact_posting,
                          length(r.dashboard_exact_posting) + 2
                        ) NOT GLOB '*[^0-9]*'
                      )
                    )
                )
              )
            ),
            after_sales_by_shop AS (
              SELECT
                r.shop_id,
                COUNT(DISTINCT COALESCE(
                  NULLIF(r.dashboard_return_identity, ''),
                  CASE WHEN NULLIF(r.posting_number, '') IS NOT NULL THEN 'posting:' || r.posting_number END,
                  CASE WHEN NULLIF(r.order_id, '') IS NOT NULL THEN 'order:' || r.order_id END,
                  'key:' || r.return_key
                )) AS after_sales_todo_count
              FROM visible_after_sales r
              GROUP BY r.shop_id
            ),
            stock_warning_by_shop AS (
              SELECT p.shop_id, COUNT(*) AS stock_warning_count
              FROM ozon_products p
              WHERE p.is_stale = 0
                AND p.shop_id IN (SELECT shop_id FROM scoped_shops)
                AND p.stock_value IS NOT NULL
                AND CAST(p.stock_value AS REAL) = 0
              GROUP BY p.shop_id
            )
            SELECT
              COALESCE((SELECT SUM(sales_order_count) FROM sales_by_shop), 0) AS sales_order_count,
              COALESCE((SELECT SUM(pending_purchase_count) FROM sales_by_shop), 0) AS pending_purchase_count,
              COALESCE((SELECT SUM(after_sales_todo_count) FROM after_sales_by_shop), 0) AS after_sales_todo_count,
              COALESCE((SELECT SUM(stock_warning_count) FROM stock_warning_by_shop), 0) AS stock_warning_count,
              COALESCE((
                SELECT json_group_array(json_object(
                  'shopId', scoped_shops.shop_id,
                  'sales_order_count', COALESCE((SELECT sales_order_count FROM sales_by_shop WHERE sales_by_shop.shop_id = scoped_shops.shop_id), 0),
                  'pending_purchase_count', COALESCE((SELECT pending_purchase_count FROM sales_by_shop WHERE sales_by_shop.shop_id = scoped_shops.shop_id), 0),
                  'after_sales_todo_count', COALESCE((SELECT after_sales_todo_count FROM after_sales_by_shop WHERE after_sales_by_shop.shop_id = scoped_shops.shop_id), 0),
                  'stock_warning_count', COALESCE((SELECT stock_warning_count FROM stock_warning_by_shop WHERE stock_warning_by_shop.shop_id = scoped_shops.shop_id), 0)
                ))
                FROM scoped_shops
              ), '[]') AS by_shop_json
          `
        )
        .get(...params);
      return {
        ...createEmptyPayload(shopIds),
        counts: createCounts(row),
        byShop: parseByShop(row?.by_shop_json, shopIds),
      };
    } catch (error) {
      return createReadError(error, undefined, shopIds);
    }
  }

  return { read };
}

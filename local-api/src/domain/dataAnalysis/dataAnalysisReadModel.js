import { calculateAfterSalesAnalysis } from './calculators/afterSalesAnalysisCalculator.js';
import { calculateFinanceAnalysis } from './calculators/financeAnalysisCalculator.js';
import { readPublishedProfitSnapshots } from '../../db/repositories/profitLedgerSnapshotRepository.js';
import { calculateMarketingAnalysis } from './calculators/marketingAnalysisCalculator.js';
import { calculateProductAnalysis } from './calculators/productAnalysisCalculator.js';
import { calculateSalesAnalysis } from './calculators/salesAnalysisCalculator.js';
import { calculateTrafficAnalysis } from './calculators/trafficAnalysisCalculator.js';
import { buildDataAnalysisDiagnostics } from './lib/dataAnalysisDiagnostics.js';
import { getOzonSoftwareCategoryByIds } from '../../cache/catalog/softwareCategoryNameService.js';
import {
  createPreviousRange,
  filterRowsByDate,
  latestTimestamp,
  normalizeDateRange,
  normalizeText,
  parseJson,
  roundNumber,
  toDateKey,
} from './lib/dataAnalysisUtils.js';

const TABLE_SELECTS = Object.freeze({
  orders: {
    table: 'ozon_orders',
    columns:
      'id, shop_id, order_key, posting_number, order_id, source, status, substatus, fulfillment, in_process_at, shipment_date, products_json, analytics_json, financial_json, is_stale, last_seen_at, created_at, updated_at',
  },
  products: {
    table: 'ozon_products',
    columns:
      'id, shop_id, product_id, offer_id, sku, name, visibility, status_label, snapshot_visibilities_json, category_id, category_name, type_id, price_value, currency_code, stock_value, raw_json, price_json, stock_json, fee_json, is_stale, last_seen_at, updated_at, detail_synced_at, prices_synced_at, stocks_synced_at, hydrated_at',
  },
  finance: {
    table: 'ozon_finance_transactions',
    columns:
      'id, shop_id, operation_key, operation_id, posting_number, order_id, operation_type, operation_type_name, transaction_type, operation_date, amount_total, acquiring_fee_cny, sale_commission_cny, delivery_fee_cny, currency_code, services_json, is_stale, last_seen_at, created_at, updated_at',
  },
  analytics: {
    table: 'ozon_analytics_daily',
    columns:
      'id, shop_id, report_date, revenue_rub, ordered_units, product_views, cart_adds, visitor_sessions, metric_signature, raw_metrics_json, is_stale, last_seen_at, created_at, updated_at',
  },
  returns: {
    table: 'ozon_returns',
    columns:
      'id, shop_id, return_key, return_id, posting_number, order_id, source, status, substatus, return_reason, decision, created_at_remote, updated_at_remote, product_json, finance_json, raw_json, is_stale, last_seen_at, created_at, updated_at, refund_status, refund_time, refund_json',
  },
  marketing: {
    table: 'ozon_marketing_activities',
    columns:
      'id, shop_id, activity_id, source_type, source_label, source_tone, title, original_title, joined_count, available_count, has_available_count, estimate, date_start, date_end, raw_json, remote_hash, first_seen_at, last_seen_at, updated_at',
  },
  marketingProducts: {
    table: 'ozon_marketing_activity_products',
    columns:
      'id, shop_id, activity_id, source_type, product_id, offer_id, sku, ozon_sku, row_status, source_activity_price, activity_price, price, stock, raw_json, last_seen_at, updated_at, name, is_stale',
  },
  purchaseOverrides: {
    table: 'purchase_order_overrides',
    columns:
      'id, shop_id, order_key, posting_number, ozon_order_id, offer_id, sku, purchase_platform, purchase_order_number, source_cost_cny, manual_status, created_at, updated_at',
    includeLegacyBlankShop: true,
  },
  crossBorderOrders: {
    table: 'cross_border_order_records',
    columns:
      'id, shop_id, record_key, order_id, platform_order, purchase_order_number, offer_id, sku, status, read_status, package_weight_kg, length_cm, width_cm, height_cm, last_seen_at, updated_at',
    includeLegacyBlankShop: true,
  },
});

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName)?.found
  );
}

function splitShopScopeIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) => String(item ?? '').split(',')).map(normalizeText).filter(Boolean))];
}

function getShopScopeIds(db, shopId = '', shopIds = []) {
  const requested = splitShopScopeIds([shopId, ...splitShopScopeIds(shopIds)]);
  if (!tableExists(db, 'shops')) return requested;
  if (!requested.length) {
    return [...new Set(db.prepare("SELECT id, client_id FROM shops WHERE status = 'active' ORDER BY id").all()
      .flatMap((row) => [normalizeText(row.id), normalizeText(row.client_id)])
      .filter(Boolean))];
  }
  const placeholders = requested.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id, client_id FROM shops WHERE id IN (${placeholders}) OR client_id IN (${placeholders})`).all(...requested, ...requested);
  return [...new Set([...requested, ...rows.flatMap((row) => [normalizeText(row.id), normalizeText(row.client_id)])].filter(Boolean))];
}

function readScopedShops(db, shopScopeIds = []) {
  if (!tableExists(db, 'shops')) return [];
  const ids = [...new Set((Array.isArray(shopScopeIds) ? shopScopeIds : []).map(normalizeText).filter(Boolean))];
  if (!ids.length) return db.prepare("SELECT id, client_id, name, alias, status FROM shops WHERE status = 'active' ORDER BY id").all();
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`SELECT id, client_id, name, alias, status FROM shops WHERE id IN (${placeholders}) OR client_id IN (${placeholders}) ORDER BY id`).all(...ids, ...ids);
}

function attachShopContext(rows = [], shops = []) {
  const shopByScope = new Map();
  shops.forEach((shop) => {
    const label = normalizeText(shop.alias || shop.name, normalizeText(shop.id, '未命名店铺'));
    const context = { shopId: normalizeText(shop.id), shopName: label };
    [shop.id, shop.client_id].map(normalizeText).filter(Boolean).forEach((id) => shopByScope.set(id, context));
  });
  return rows.map((row) => {
    const sourceShopId = normalizeText(row.shop_id);
    const context = shopByScope.get(sourceShopId);
    return {
      ...row,
      shop_id: context?.shopId || sourceShopId,
      shop_source_id: sourceShopId,
      shop_name: context?.shopName || sourceShopId || '店铺未识别',
    };
  });
}

function readRows(db, select, shopScopeIds = []) {
  if (!tableExists(db, select.table)) return [];
  const ids = Array.isArray(shopScopeIds) ? shopScopeIds.filter(Boolean) : [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT ${select.columns} FROM ${select.table} WHERE shop_id IN (${placeholders})${select.includeLegacyBlankShop ? " OR shop_id = ''" : ''}`
      )
      .all(...ids);
  }
  return db.prepare(`SELECT ${select.columns} FROM ${select.table}`).all();
}

function isSyntheticSplitFixture(row = {}) {
  return [row.posting_number, row.order_key, row.order_id, row.return_id, row.activity_id]
    .map((value) => normalizeText(value))
    .some((value) => value.startsWith('TEST-SPLIT-'));
}

function excludeSyntheticFixtures(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !isSyntheticSplitFixture(row));
}

function excludeStaleRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => Number(row?.is_stale) !== 1);
}

function enrichProductCategoryRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const resolved = getOzonSoftwareCategoryByIds({
      descriptionCategoryId: row.category_id,
      typeId: row.type_id,
    });
    return {
      ...row,
      resolved_category_name: resolved?.pathText || normalizeText(row.category_name),
      resolved_category_source: resolved?.source || (normalizeText(row.category_name) ? 'ozon-cache' : ''),
    };
  });
}

function filterLegacyRowsByOrderIdentity(rows = [], orderRows = [], extraValues = []) {
  const expandIdentity = (value) => {
    const text = normalizeText(value);
    if (!text) return [];
    const suffix = text.includes(':') ? normalizeText(text.split(':').at(-1)) : '';
    return [...new Set([text, suffix].filter(Boolean))];
  };
  const identities = new Set(
    orderRows
      .flatMap((row) => [row.posting_number, row.order_id, row.order_key])
      .concat(extraValues)
      .flatMap(expandIdentity)
  );
  return rows.filter((row) => {
    if (normalizeText(row.shop_id)) return true;
    return [row.posting_number, row.ozon_order_id, row.order_key, row.platform_order, row.order_id]
      .flatMap(expandIdentity)
      .some((value) => identities.has(value));
  });
}

function readPerformanceSource(db, shopScopeIds = []) {
  if (!tableExists(db, 'performance_accounts')) {
    return { count: 0, activeCount: 0, unboundCount: 0, lastTestAt: null, lastTestMessage: '', shopIds: [] };
  }
  const scopedIds = (Array.isArray(shopScopeIds) ? shopScopeIds : [])
    .map(normalizeText)
    .filter(Boolean);
  const scopeSql = scopedIds.length
    ? `shop_id IN (${scopedIds.map(() => '?').join(', ')})`
    : "trim(COALESCE(shop_id, '')) <> ''";
  const row = db
    .prepare(
      `
        SELECT
          COUNT(*) AS count,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
          MAX(last_test_at) AS last_test_at
        FROM performance_accounts
        WHERE ${scopeSql}
      `
    )
    .get(...scopedIds);
  const last = db
    .prepare(`SELECT last_test_message FROM performance_accounts WHERE ${scopeSql} ORDER BY last_test_at DESC, updated_at DESC LIMIT 1`)
    .get(...scopedIds);
  const accountRows = db.prepare(`
    SELECT DISTINCT shop_id
    FROM performance_accounts
    WHERE ${scopeSql} AND status = 'active' AND trim(COALESCE(shop_id, '')) <> ''
    ORDER BY shop_id
  `).all(...scopedIds);
  const unbound = db
    .prepare("SELECT COUNT(*) AS count FROM performance_accounts WHERE trim(COALESCE(shop_id, '')) = ''")
    .get();
  return {
    count: Number(row?.count) || 0,
    activeCount: Number(row?.active_count) || 0,
    unboundCount: Number(unbound?.count) || 0,
    lastTestAt: row?.last_test_at || null,
    lastTestMessage: normalizeText(last?.last_test_message),
    shopIds: accountRows.map((item) => normalizeText(item.shop_id)).filter(Boolean),
  };
}

function getProfitLedgerRowShopIds(row = {}) {
  const snapshot = row?.orderSnapshot && typeof row.orderSnapshot === 'object' ? row.orderSnapshot : {};
  return [...new Set([
    normalizeText(row.shopId),
    normalizeText(row.shopClientId),
    normalizeText(snapshot.shopId),
    normalizeText(snapshot.shopClientId),
  ].filter(Boolean))];
}

function getProfitLedgerRowDate(row = {}) {
  const snapshot = row?.orderSnapshot && typeof row.orderSnapshot === 'object' ? row.orderSnapshot : {};
  return snapshot.paymentDate || snapshot.paymentTime || row.paymentDate || row.paymentTime || null;
}

function readProfitLedgerRows(db, shopScopeIds = [], range = {}, shops = []) {
  if (!tableExists(db, 'profit_ledger_snapshots')) {
    return { connected: false, rows: [], snapshotCount: 0, availableRowCount: 0, syncedAt: null };
  }
  const snapshots = readPublishedProfitSnapshots(db);
  const requestedShopIds = new Set((Array.isArray(shopScopeIds) ? shopScopeIds : []).map(normalizeText).filter(Boolean));
  const canonicalShopIds = new Map();
  shops.forEach((shop) => {
    const canonical = normalizeText(shop.id);
    [shop.id, shop.client_id].map(normalizeText).filter(Boolean).forEach((id) => canonicalShopIds.set(id, canonical));
  });
  const rowsByKey = new Map();
  snapshots.forEach((record) => {
    const snapshot = record.snapshot;
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    rows.forEach((row, index) => {
      const matchesShop = !requestedShopIds.size || getProfitLedgerRowShopIds(row).some((id) => requestedShopIds.has(id));
      if (!matchesShop) return;
      const rowShopIds = getProfitLedgerRowShopIds(row);
      const canonicalShopId = rowShopIds.map((id) => canonicalShopIds.get(id)).find(Boolean) || rowShopIds[0] || 'unknown-shop';
      const recordKey = normalizeText(row.ledgerKey || row.orderKey) || `${record.snapshot_key}:${index}`;
      const key = `${canonicalShopId}|${recordKey}`;
      if (rowsByKey.has(key)) return;
      rowsByKey.set(key, {
        ...row,
        shopId: canonicalShopId,
        __snapshotUpdatedAt: record.updated_at || snapshot.updatedAt || snapshot.fetchedAt || record.fetched_at || null,
      });
    });
  });
  const availableRows = [...rowsByKey.values()];
  const rows = filterRowsByDate(availableRows, range, getProfitLedgerRowDate);
  return {
    connected: true,
    rows,
    snapshotCount: snapshots.length,
    availableRowCount: availableRows.length,
    syncedAt: latestTimestamp(rows.length ? rows : availableRows, ['__snapshotUpdatedAt']),
  };
}

function createSource({
  id,
  label,
  type,
  rows = [],
  endpoints = [],
  latestFields = ['updated_at', 'last_seen_at'],
  status,
  note = '',
  rowCount,
  syncedAt,
} = {}) {
  const resolvedCount = Number.isFinite(Number(rowCount)) ? Number(rowCount) : rows.length;
  return {
    id,
    label,
    type,
    status: status || (resolvedCount > 0 ? 'ready' : 'empty'),
    rowCount: resolvedCount,
    syncedAt: syncedAt || latestTimestamp(rows, latestFields),
    endpoints,
    note,
  };
}

function createSourceCatalog({
  orders,
  products,
  finance,
  returns,
  marketing,
  marketingProducts,
  purchaseOverrides,
  crossBorderOrders,
  performance,
  analytics = [],
  profitLedger = {},
} = {}) {
  return [
    createSource({
      id: 'orders',
      label: 'Ozon订单',
      type: 'official-cache',
      rows: orders,
      endpoints: ['/v3/posting/fbs/list', '/v2/posting/fbo/list'],
      note: '订单、商品明细、状态、履约和成交金额。',
    }),
    createSource({
      id: 'products',
      label: 'Ozon商品与库存',
      type: 'official-cache',
      rows: products,
      endpoints: ['/v3/product/list', '/v5/product/info/prices', '/v4/product/info/stocks'],
      latestFields: ['stocks_synced_at', 'prices_synced_at', 'updated_at'],
      note: '商品状态、价格、库存和费用字段。',
    }),
    createSource({
      id: 'finance',
      label: 'Ozon财务流水',
      type: 'official-cache',
      rows: finance,
      endpoints: ['/v3/finance/transaction/list', '/v1/finance/accrual/by-day'],
      note: '平台收入、扣减、佣金、服务和物流相关流水。',
    }),
    createSource({
      id: 'returns',
      label: 'Ozon售后退货',
      type: 'official-cache',
      rows: returns,
      endpoints: ['/v1/returns/list', '/v3/returns/company/fbs'],
      note: '退货状态、商品、原因ID和售后金额。',
    }),
    createSource({
      id: 'marketing',
      label: 'Ozon营销活动',
      type: 'official-cache',
      rows: marketing,
      endpoints: ['/v1/actions', '/v1/seller-actions/list'],
      note: `活动 ${marketing.length} 条，活动商品 ${marketingProducts.length} 条。`,
    }),
    createSource({
      id: 'marketing-products',
      label: 'Ozon活动商品',
      type: 'official-cache',
      rows: marketingProducts,
      endpoints: ['/v1/actions/products', '/v1/seller-actions/products/list'],
      note: '活动商品、活动价和库存。',
    }),
    createSource({
      id: 'purchase',
      label: '人工确认采购成本',
      type: 'manual-confirmed',
      rows: purchaseOverrides,
      endpoints: ['/api/purchase/orders/overrides'],
      note: '用户在拍单管理保存的采购平台、采购单号和确认成本。',
    }),
    createSource({
      id: 'cross-border',
      label: '跨境物流回查',
      type: 'external-confirmed-cache',
      rows: crossBorderOrders,
      endpoints: ['/api/logistics/cross-border/read'],
      note: '跨境物流订单、状态和实测材积；不自动假设费用。',
    }),
    createSource({
      id: 'performance',
      label: 'Ozon Performance API',
      type: 'official-live',
      rowCount: performance.count,
      syncedAt: performance.lastTestAt,
      status: performance.activeCount ? 'live_ready' : 'authorization_required',
      endpoints: ['/api/client/campaign', '/api/client/statistics/json'],
      note: performance.lastTestMessage || '广告统计通过独立授权实时读取，不使用业务缓存。',
    }),
    createSource({
      id: 'analytics',
      label: '平台官方流量分析',
      type: 'official-endpoint',
      rows: analytics,
      latestFields: ['updated_at', 'last_seen_at'],
      status: analytics.length ? 'ready' : 'not_synced',
      endpoints: ['/v1/analytics/data'],
      note: analytics.length
        ? '访问、浏览、加购、下单件数和官方成交额来自日粒度官方快照。'
        : '端点已登记，点击刷新后会读取并写入真实日粒度快照。',
    }),
    createSource({
      id: 'profit-ledger',
      label: '完整利润账本',
      type: 'derived-confirmed',
      rowCount: profitLedger.rows?.length || 0,
      syncedAt: profitLedger.syncedAt || null,
      status: profitLedger.connected ? (profitLedger.rows?.length ? 'ready' : 'empty') : 'not_in_sqlite',
      endpoints: ['/api/profit/ledger-snapshot'],
      note: profitLedger.connected
        ? profitLedger.rows?.length
          ? `已按当前店铺和日期读取 ${profitLedger.rows.length} 条利润账本。`
          : `SQLite 中已有 ${profitLedger.availableRowCount || 0} 条利润账本，但当前店铺和日期范围没有匹配记录。`
        : '本机尚未建立利润账本数据表；不会伪造完整净利润。',
    }),
    createSource({
      id: 'market-insights',
      label: '平台市场与竞品数据',
      type: 'official-source-required',
      rowCount: 0,
      syncedAt: null,
      status: 'source_required',
      endpoints: [],
      note: '当前未接入可追溯的全站市场、竞品销量或关键词搜索数据；不会使用店内订单和流量推算。',
    }),
  ];
}

function createModuleStatus({ id, title, status, sourceIds, note, rowCount = 0 }) {
  return { id, title, status, sourceIds, note, rowCount };
}

function createModuleStatuses({ sales, products, finance, traffic, afterSales, marketing, sources }) {
  const performance = sources.find((source) => source.id === 'performance');
  const analytics = sources.find((source) => source.id === 'analytics');
  const profitLedger = sources.find((source) => source.id === 'profit-ledger');
  return [
    createModuleStatus({
      id: 'overview',
      title: '经营总览',
      status: sales.rowCount || products.rowCount ? 'ready' : 'empty',
      sourceIds: ['orders', 'products', 'finance', 'returns', 'analytics'],
      note: '只汇总有真实来源的指标。',
      rowCount: sales.rowCount + products.rowCount + finance.rowCount + afterSales.rowCount + (traffic?.rowCount || 0),
    }),
    createModuleStatus({
      id: 'sales',
      title: '销售分析',
      status: sales.rowCount ? 'ready' : 'empty',
      sourceIds: ['orders'],
      note: '订单、销售件数、成交金额、状态和商品排行。',
      rowCount: sales.rowCount,
    }),
    createModuleStatus({
      id: 'products',
      title: '商品分析',
      status: products.rowCount ? 'ready' : 'empty',
      sourceIds: ['products', 'orders'],
      note: '商品状态、价格覆盖、库存和销售排行。',
      rowCount: products.rowCount,
    }),
    createModuleStatus({
      id: 'traffic',
      title: '流量转化',
      status: analytics?.status || 'not_synced',
      sourceIds: ['analytics'],
      note: '访问、浏览、加购和下单转化来自官方日粒度流量快照。',
      rowCount: traffic?.rowCount || analytics?.rowCount || 0,
    }),
    createModuleStatus({
      id: 'advertising',
      title: '广告分析',
      status: performance?.status || 'authorization_required',
      sourceIds: ['performance'],
      note: '进入模块后从Performance API实时读取。',
      rowCount: performance?.rowCount || 0,
    }),
    createModuleStatus({
      id: 'profit',
      title: '利润与费用',
      status: profitLedger?.rowCount ? (finance.profitLedger?.coveragePercent === 100 ? 'ready' : 'partial') : finance.rowCount ? 'partial' : 'empty',
      sourceIds: ['finance', 'purchase', 'cross-border', 'profit-ledger'],
      note: profitLedger?.rowCount
        ? `已读取利润账本；实际净利润覆盖率 ${finance.profitLedger?.coveragePercent ?? 0}%。`
        : '财务和采购成本可分析；完整净利润缺来源时保持不可用。',
      rowCount: finance.rowCount + (profitLedger?.rowCount || 0),
    }),
    createModuleStatus({
      id: 'inventory',
      title: '库存分析',
      status: products.rowCount ? 'ready' : 'empty',
      sourceIds: ['products', 'orders'],
      note: '当前库存是真实快照；补货天数需足够销量样本。',
      rowCount: products.rowCount,
    }),
    createModuleStatus({
      id: 'after-sales',
      title: '售后分析',
      status: afterSales.rowCount ? 'ready' : 'empty',
      sourceIds: ['returns', 'orders'],
      note: '售后状态、原因ID、商品金额和期间售后单/订单。',
      rowCount: afterSales.rowCount,
    }),
    createModuleStatus({
      id: 'marketing',
      title: '促销分析',
      status: marketing.rowCount ? 'partial' : 'empty',
      sourceIds: ['marketing', 'marketing-products'],
      note: '活动和活动商品已接入；归因销售额需官方活动效果报告。',
      rowCount: marketing.rowCount,
    }),
    createModuleStatus({
      id: 'market',
      title: '市场机会',
      status: 'source_required',
      sourceIds: ['market-insights'],
      note: '全站榜单、竞品真实销量和关键词搜索量不是当前标准Seller API缓存数据。',
      rowCount: 0,
    }),
  ];
}

function selectOverviewMetrics({ sales, products, finance, traffic, afterSales }) {
  const ids = new Set([
    'trafficSessionCount',
    'trafficOrderCount',
    'trafficOrderConversionRate',
    'salesAmount',
    'financeNetAmount',
    'actualNetProfit',
    'outOfStockCount',
  ]);
  return [traffic, sales, products, finance, afterSales]
    .flatMap((section) => section.metrics || [])
    .filter((metric) => ids.has(metric.id));
}

function getAvailableRange(rows = [], fields = []) {
  const dates = rows
    .flatMap((row) => fields.map((field) => toDateKey(row[field])))
    .filter(Boolean)
    .sort();
  return {
    startDate: dates[0] || null,
    endDate: dates.at(-1) || null,
  };
}

function countDuplicateBusinessKeys(rows = [], keyOf = () => '') {
  const seen = new Set();
  let duplicates = 0;
  rows.forEach((row, index) => {
    const key = normalizeText(keyOf(row)) || `missing:${index}`;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  });
  return duplicates;
}

function buildDataQualitySummary({ shops = [], allSources = {}, periodSources = {}, sales = {}, performance = {} } = {}) {
  const expectedShopIds = shops.map((shop) => normalizeText(shop.id)).filter(Boolean);
  const expectedShopIdSet = new Set(expectedShopIds);
  const sourceDefinitions = [
    ['orders', '订单', allSources.orders || []],
    ['products', '商品', allSources.products || []],
    ['finance', '财务', allSources.finance || []],
    ['analytics', '流量', allSources.analytics || []],
    ['returns', '售后', allSources.returns || []],
    ['marketing', '营销', allSources.marketing || []],
  ];
  const sourceCoverage = sourceDefinitions.map(([id, label, rows]) => {
    const counts = new Map();
    rows.forEach((row) => {
      const shopId = normalizeText(row.shop_id);
      if (shopId) counts.set(shopId, (counts.get(shopId) || 0) + 1);
    });
    const coveredShopIds = expectedShopIds.filter((shopId) => (counts.get(shopId) || 0) > 0);
    return {
      id,
      label,
      rowCount: rows.length,
      coveredShopCount: coveredShopIds.length,
      expectedShopCount: expectedShopIds.length,
      coveragePercent: expectedShopIds.length ? roundNumber((coveredShopIds.length / expectedShopIds.length) * 100, 2) : null,
      missingShopIds: expectedShopIds.filter((shopId) => !coveredShopIds.includes(shopId)),
    };
  });
  const periodCounts = (rows = []) => rows.reduce((map, row) => {
    const shopId = normalizeText(row.shop_id);
    if (shopId) map.set(shopId, (map.get(shopId) || 0) + 1);
    return map;
  }, new Map());
  const periodOrders = periodCounts(periodSources.orders || []);
  const periodFinance = periodCounts(periodSources.finance || []);
  const periodAnalytics = periodCounts(periodSources.analytics || []);
  const periodReturns = periodCounts(periodSources.returns || []);
  const allOrdersByShop = periodCounts(allSources.orders || []);
  const allProductsByShop = periodCounts(allSources.products || []);
  const shopRows = shops.map((shop) => {
    const shopId = normalizeText(shop.id);
    return {
      shopId,
      shopName: normalizeText(shop.alias || shop.name, shopId),
      historicalOrderRows: allOrdersByShop.get(shopId) || 0,
      productRows: allProductsByShop.get(shopId) || 0,
      orderRows: periodOrders.get(shopId) || 0,
      financeRows: periodFinance.get(shopId) || 0,
      analyticsRows: periodAnalytics.get(shopId) || 0,
      returnRows: periodReturns.get(shopId) || 0,
      performanceReady: (performance.shopIds || []).includes(shopId),
    };
  });
  const duplicates = {
    orders: countDuplicateBusinessKeys(allSources.orders, (row) => `${row.shop_id}|${row.order_key || row.posting_number || row.id}`),
    products: countDuplicateBusinessKeys(allSources.products, (row) => `${row.shop_id}|${row.sku || row.offer_id || row.product_id || row.id}`),
    finance: countDuplicateBusinessKeys(allSources.finance, (row) => `${row.shop_id}|${row.operation_key || row.operation_id || row.id}`),
    returns: countDuplicateBusinessKeys(allSources.returns, (row) => `${row.shop_id}|${row.return_key || row.return_id || row.id}`),
    analytics: countDuplicateBusinessKeys(allSources.analytics, (row) => `${row.shop_id}|${row.report_date || row.id}`),
  };
  const duplicateRowCount = Object.values(duplicates).reduce((sum, value) => sum + value, 0);
  const orphanRowCount = sourceDefinitions.reduce((total, [, , rows]) => total + rows.filter((row) => {
    const shopId = normalizeText(row.shop_id);
    return shopId && !expectedShopIdSet.has(shopId);
  }).length, 0);
  const effectiveOrderCount = Number(sales?.quality?.effectiveOrderCount) || 0;
  const rankedEffectiveOrderCount = (sales?.shopRanking || []).reduce((sum, row) => sum + (Number(row.orderCount) || 0), 0);
  const reconciliation = {
    effectiveOrderCount,
    rankedEffectiveOrderCount,
    difference: rankedEffectiveOrderCount - effectiveOrderCount,
    status: rankedEffectiveOrderCount === effectiveOrderCount ? 'matched' : 'mismatch',
  };
  const missingCoreSourceShopCount = sourceCoverage
    .filter((source) => ['orders', 'products', 'finance', 'analytics'].includes(source.id))
    .reduce((sum, source) => sum + source.missingShopIds.length, 0);
  return {
    expectedShopCount: shops.length,
    expectedShopIds,
    shopRows,
    sourceCoverage,
    duplicates,
    duplicateRowCount,
    orphanRowCount,
    missingCoreSourceShopCount,
    periodEmptyOrderShopCount: shopRows.filter((row) => row.orderRows === 0).length,
    performanceCoverage: {
      coveredShopCount: shopRows.filter((row) => row.performanceReady).length,
      expectedShopCount: shopRows.length,
      missingShopIds: shopRows.filter((row) => !row.performanceReady).map((row) => row.shopId),
    },
    reconciliation,
    status: duplicateRowCount || orphanRowCount || missingCoreSourceShopCount || reconciliation.status !== 'matched'
      ? 'warning'
      : 'confirmed',
  };
}

export function createDataAnalysisReadModel(db) {
  if (!db) throw new Error('createDataAnalysisReadModel requires a DatabaseSync instance.');

  return {
    build(query = {}) {
      const shopId = normalizeText(query.shopId || query.shop_id);
      const shopScopeIds = getShopScopeIds(db, shopId, query.shopIds || query.shop_ids);
      const scopedShops = readScopedShops(db, shopScopeIds);
      const range = normalizeDateRange(query);
      const comparisonRange = createPreviousRange(range);

      const allOrders = attachShopContext(
        excludeSyntheticFixtures(excludeStaleRows(readRows(db, TABLE_SELECTS.orders, shopScopeIds))),
        scopedShops,
      );
      const allProducts = enrichProductCategoryRows(
        attachShopContext(excludeStaleRows(readRows(db, TABLE_SELECTS.products, shopScopeIds)), scopedShops)
      );
      const allFinance = attachShopContext(excludeSyntheticFixtures(excludeStaleRows(readRows(db, TABLE_SELECTS.finance, shopScopeIds))), scopedShops);
      const allAnalytics = attachShopContext(excludeStaleRows(readRows(db, TABLE_SELECTS.analytics, shopScopeIds)), scopedShops);
      const allReturns = attachShopContext(excludeSyntheticFixtures(excludeStaleRows(readRows(db, TABLE_SELECTS.returns, shopScopeIds))), scopedShops);
      const activities = attachShopContext(readRows(db, TABLE_SELECTS.marketing, shopScopeIds), scopedShops);
      const activityProducts = attachShopContext(excludeStaleRows(readRows(db, TABLE_SELECTS.marketingProducts, shopScopeIds)), scopedShops);
      const purchaseOverrides = filterLegacyRowsByOrderIdentity(
        readRows(db, TABLE_SELECTS.purchaseOverrides, shopScopeIds),
        allOrders
      );
      const crossBorderOrders = filterLegacyRowsByOrderIdentity(
        readRows(db, TABLE_SELECTS.crossBorderOrders, shopScopeIds),
        allOrders,
        purchaseOverrides.map((row) => row.purchase_order_number)
      );
      const performance = readPerformanceSource(db, shopScopeIds);
      const profitLedger = readProfitLedgerRows(db, shopScopeIds, range, scopedShops);

      const orders = filterRowsByDate(allOrders, range, (row) => row.in_process_at || row.created_at);
      const comparisonOrders = filterRowsByDate(
        allOrders,
        comparisonRange,
        (row) => row.in_process_at || row.created_at
      );
      const financeRows = filterRowsByDate(allFinance, range, (row) => row.operation_date || row.created_at);
      const comparisonFinanceRows = filterRowsByDate(
        allFinance,
        comparisonRange,
        (row) => row.operation_date || row.created_at
      );
      const analyticsRows = filterRowsByDate(allAnalytics, range, (row) => row.report_date);
      const comparisonAnalyticsRows = filterRowsByDate(allAnalytics, comparisonRange, (row) => row.report_date);
      const returnRows = filterRowsByDate(allReturns, range, (row) => row.created_at_remote || row.created_at);
      const comparisonReturnRows = filterRowsByDate(
        allReturns,
        comparisonRange,
        (row) => row.created_at_remote || row.created_at
      );

      const sales = calculateSalesAnalysis({
        rows: orders,
        comparisonRows: comparisonOrders,
        range,
        comparisonRange,
      });
      const products = calculateProductAnalysis({
        rows: allProducts,
        salesProductRanking: sales.productRanking,
      });
      const finance = calculateFinanceAnalysis({
        rows: financeRows,
        comparisonRows: comparisonFinanceRows,
        allOrderRows: allOrders,
        currentOrderRows: orders,
        purchaseOverrides,
        profitLedgerRows: profitLedger.rows,
        profitLedgerSourceSyncedAt: profitLedger.syncedAt,
      });
      const traffic = calculateTrafficAnalysis({
        rows: analyticsRows,
        comparisonRows: comparisonAnalyticsRows,
        orderRows: orders,
        comparisonOrderRows: comparisonOrders,
      });
      const afterSales = calculateAfterSalesAnalysis({
        rows: returnRows,
        comparisonRows: comparisonReturnRows,
        allRows: allReturns,
        orderRows: orders,
      });
      const marketing = calculateMarketingAnalysis({
        activities,
        products: activityProducts,
        catalogProducts: allProducts,
        range,
      });
      const dataQuality = buildDataQualitySummary({
        shops: scopedShops,
        allSources: {
          orders: allOrders,
          products: allProducts,
          finance: allFinance,
          analytics: allAnalytics,
          returns: allReturns,
          marketing: activities,
        },
        periodSources: {
          orders,
          finance: financeRows,
          analytics: analyticsRows,
          returns: returnRows,
        },
        sales,
        performance,
      });
      const latestAnalyticsDate = analyticsRows.map((row) => toDateKey(row.report_date)).filter(Boolean).sort().at(-1) || null;
      const expectedEndDate = range.endDate || null;
      const analyticsLagDays = latestAnalyticsDate && expectedEndDate
        ? Math.max(0, Math.round((Date.parse(`${expectedEndDate}T00:00:00Z`) - Date.parse(`${latestAnalyticsDate}T00:00:00Z`)) / 86_400_000))
        : null;
      dataQuality.scopeStatus = dataQuality.status;
      dataQuality.metricCoverage = {
        categoryIdCoveragePercent: products.quality?.total
          ? roundNumber((Number(products.quality.categoryIdKnownCount || 0) / Number(products.quality.total)) * 100, 2)
          : null,
        categoryNameCoveragePercent: products.quality?.categoryCoveragePercent ?? null,
        financeOfficialCurrencyRows: Number(finance.currencyCoverage?.officialCurrencyRows) || 0,
        financeInferredCurrencyRows: Number(finance.currencyCoverage?.inferredCurrencyRows) || 0,
        financeCurrencyCoveragePercent: finance.currencyCoverage?.percent ?? null,
        purchaseCostCoveragePercent: finance.purchaseCost?.coveragePercent ?? null,
        expectedAnalyticsEndDate: expectedEndDate,
        latestAnalyticsDate,
        analyticsLagDays,
      };
      const metricCoverageWarnings = [
        Number(dataQuality.metricCoverage.categoryNameCoveragePercent) < 100,
        dataQuality.metricCoverage.financeInferredCurrencyRows > 0,
        analyticsLagDays !== null && analyticsLagDays > 1,
        dataQuality.metricCoverage.purchaseCostCoveragePercent !== null
          && Number(dataQuality.metricCoverage.purchaseCostCoveragePercent) < 100,
      ].filter(Boolean).length;
      dataQuality.metricCoverageWarningCount = metricCoverageWarnings;
      dataQuality.status = dataQuality.scopeStatus === 'warning' || metricCoverageWarnings ? 'warning' : 'confirmed';
      const sources = createSourceCatalog({
        orders: allOrders,
        products: allProducts,
        finance: allFinance,
        returns: allReturns,
        marketing: activities,
        marketingProducts: activityProducts,
        purchaseOverrides,
        crossBorderOrders,
        performance,
        analytics: allAnalytics,
        profitLedger,
      });
      const diagnostics = buildDataAnalysisDiagnostics({
        sales,
        products,
        finance,
        traffic,
        afterSales,
        marketing,
        sources,
        dataQuality,
      });

      const generatedAt = new Date().toISOString();
      const sourceUpdatedAt = latestTimestamp(
        sources.map((source) => ({ syncedAt: source.syncedAt })),
        ['syncedAt']
      );

      return {
        generatedAt,
        sourceUpdatedAt,
        shopId,
        range,
        comparisonRange,
        availableRange: {
          orders: getAvailableRange(allOrders, ['in_process_at']),
          finance: getAvailableRange(allFinance, ['operation_date']),
          analytics: getAvailableRange(allAnalytics, ['report_date']),
          returns: getAvailableRange(allReturns, ['created_at_remote']),
        },
        overview: {
          metrics: selectOverviewMetrics({ sales, products, finance, traffic, afterSales }),
          trend: sales.trend,
        },
        sales,
        products,
        finance,
        traffic,
        afterSales,
        marketing,
        dataQuality,
        sources,
        diagnostics,
        modules: createModuleStatuses({ sales, products, finance, traffic, afterSales, marketing, sources }),
        dataPolicy: {
          localFirst: true,
          fakeDataAllowed: false,
          missingValuePolicy: 'null-with-source-status',
          currencyPolicy: 'do-not-merge-unconfirmed-or-mixed-currency',
          privacyPolicy: 'analysis-response-excludes-order-raw-json-and-buyer-pii',
        },
      };
    },
  };
}

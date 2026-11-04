import { calculateAfterSalesAnalysis } from '../dataAnalysis/calculators/afterSalesAnalysisCalculator.js';
import { calculateFinanceAnalysis } from '../dataAnalysis/calculators/financeAnalysisCalculator.js';
import { readPublishedProfitSnapshots } from '../../db/repositories/profitLedgerSnapshotRepository.js';
import { calculateProductAnalysis } from '../dataAnalysis/calculators/productAnalysisCalculator.js';
import { calculateSalesAnalysis } from '../dataAnalysis/calculators/salesAnalysisCalculator.js';
import {
  createPreviousRange,
  filterRowsByDate,
  latestTimestamp,
  normalizeDateRange,
  normalizeText,
  parseJson,
  roundNumber,
  toDateKey,
  toFiniteNumber,
} from '../dataAnalysis/lib/dataAnalysisUtils.js';
import { createDashboardBusinessShareReadModel } from './dashboardBusinessShareReadModel.js';

const MAX_SCOPED_SHOPS = 100;
const shanghaiHourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23',
});
const STATUS_LABELS = Object.freeze({
  awaiting_packaging: '等待备货',
  awaiting_deliver: '等待发货',
  delivering: '配送中',
  delivered: '已送达',
  cancelled: '已取消',
});
const CURRENT_AFTER_SALES_STATUSES = new Set(['Utilizing', 'UtilizingByOzon']);

const TABLE_SELECTS = Object.freeze({
  orders: {
    table: 'ozon_orders',
    columns:
      'id, shop_id, order_key, posting_number, order_id, source, status, substatus, fulfillment, payment_at, in_process_at, shipment_date, products_json, analytics_json, financial_json, amount_value, is_stale, last_seen_at, created_at, updated_at',
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
  returns: {
    table: 'ozon_returns',
    columns:
      'id, shop_id, return_key, return_id, posting_number, order_id, source, status, substatus, return_reason, decision, created_at_remote, updated_at_remote, product_json, finance_json, raw_json, is_stale, last_seen_at, created_at, updated_at, refund_status, refund_time, refund_json',
  },
  purchaseOverrides: {
    table: 'purchase_order_overrides',
    columns:
      'id, shop_id, order_key, posting_number, ozon_order_id, offer_id, sku, purchase_platform, purchase_order_number, source_cost_cny, manual_status, raw_json, created_at, updated_at',
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

function normalizeShopIds(value) {
  const raw = Array.isArray(value) ? value : normalizeText(value).split(',');
  return [...new Set(raw.map((value) => normalizeText(value)).filter(Boolean))];
}

function readScopedShops(db, requestedIds = []) {
  if (!tableExists(db, 'shops')) {
    return requestedIds.map((id) => ({ id, client_id: '', name: id, alias: id, status: 'active' }));
  }
  if (!requestedIds.length) {
    return db
      .prepare("SELECT id, client_id, name, alias, status, updated_at FROM shops WHERE status = 'active' ORDER BY created_at, id")
      .all();
  }
  const placeholders = requestedIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, client_id, name, alias, status, updated_at FROM shops WHERE id IN (${placeholders}) ORDER BY created_at, id`
    )
    .all(...requestedIds);
}

function readRows(db, select, shopIds = []) {
  if (!tableExists(db, select.table) || !shopIds.length) return [];
  const placeholders = shopIds.map(() => '?').join(', ');
  const legacyClause = select.includeLegacyBlankShop ? " OR trim(COALESCE(shop_id, '')) = ''" : '';
  return db
    .prepare(`SELECT ${select.columns} FROM ${select.table} WHERE shop_id IN (${placeholders})${legacyClause}`)
    .all(...shopIds);
}

function excludeStaleAndSynthetic(rows = []) {
  return rows.filter((row) => {
    if (Number(row?.is_stale) === 1) return false;
    return ![row?.posting_number, row?.order_key, row?.order_id, row?.return_id]
      .map((value) => normalizeText(value))
      .some((value) => value.startsWith('TEST-SPLIT-'));
  });
}

function metricById(section = {}, id = '') {
  return (Array.isArray(section?.metrics) ? section.metrics : []).find((metric) => metric.id === id) || null;
}

function moneyFromProducts(row = {}) {
  const products = parseJson(row.products_json, []);
  const items = Array.isArray(products) ? products : [];
  const currencies = new Set();
  let value = 0;
  let known = 0;
  items.forEach((product) => {
    const price = toFiniteNumber(product?.price);
    const quantity = toFiniteNumber(product?.quantity ?? product?.qty ?? product?.count);
    const currency = normalizeText(product?.currency_code || product?.currencyCode, 'UNKNOWN').toUpperCase();
    if (price === null || quantity === null) return;
    known += 1;
    value += price * quantity;
    currencies.add(currency);
  });
  const direct = toFiniteNumber(row.amount_value);
  if (!known && direct !== null) return { value: direct, currency: '', status: 'currency_unconfirmed' };
  if (!known) return { value: null, currency: '', status: 'not_returned' };
  if (currencies.has('UNKNOWN')) return { value: roundNumber(value, 2), currency: 'UNKNOWN', status: 'currency_unconfirmed' };
  if (currencies.size > 1) return { value: null, currency: 'MIXED', status: 'mixed_currency' };
  return { value: roundNumber(value, 2), currency: [...currencies][0] || '', status: 'confirmed' };
}

function getOrderDate(row = {}) {
  return row.payment_at || row.in_process_at || row.created_at || row.updated_at || null;
}

function getOrderProducts(row = {}) {
  const products = parseJson(row.products_json, []);
  return Array.isArray(products) ? products : [];
}

function getShopLabel(shop = {}) {
  return normalizeText(shop.alias || shop.name || shop.client_id || shop.id, '当前店铺');
}

function compactLatestOrders(rows = [], shopById = new Map()) {
  return [...rows]
    .sort((left, right) => normalizeText(getOrderDate(right)).localeCompare(normalizeText(getOrderDate(left))))
    .slice(0, 6)
    .map((row) => {
      const products = getOrderProducts(row);
      const firstProduct = products[0] || {};
      const money = moneyFromProducts(row);
      return {
        id: normalizeText(row.posting_number || row.order_id || row.order_key || row.id),
        shopId: normalizeText(row.shop_id),
        shopName: getShopLabel(shopById.get(normalizeText(row.shop_id))),
        productName: normalizeText(firstProduct.name || firstProduct.offer_id || firstProduct.sku, '商品名未返回'),
        itemCount: products.reduce(
          (total, product) => total + Math.max(0, toFiniteNumber(product?.quantity ?? product?.qty ?? product?.count) || 0),
          0
        ),
        amountValue: money.value,
        currency: money.currency,
        amountStatus: money.status,
        status: normalizeText(row.status),
        statusLabel: STATUS_LABELS[normalizeText(row.status)] || normalizeText(row.status, '状态未返回'),
        occurredAt: getOrderDate(row),
      };
    });
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
  return snapshot.paymentTime || snapshot.paymentDate || row.paymentTime || row.paymentDate || null;
}

function readProfitLedgerRows(db, shopScopeValues = [], range = {}) {
  if (!tableExists(db, 'profit_ledger_snapshots')) {
    return { connected: false, rows: [], availableRows: [], syncedAt: null };
  }
  const requested = new Set(shopScopeValues.map((value) => normalizeText(value)).filter(Boolean));
  const rowsByKey = new Map();
  const snapshots = readPublishedProfitSnapshots(db);
  snapshots.forEach((record) => {
    const snapshot = record.snapshot;
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    rows.forEach((row, index) => {
      if (requested.size && !getProfitLedgerRowShopIds(row).some((id) => requested.has(id))) return;
      const owner = normalizeText(row.shopId || row.orderSnapshot?.shopId || row.shopClientId || row.orderSnapshot?.shopClientId);
      const key = `${owner}|${normalizeText(row.ledgerKey || row.orderKey) || `${record.snapshot_key}:${index}`}`;
      if (rowsByKey.has(key)) return;
      rowsByKey.set(key, {
        ...row,
        __snapshotUpdatedAt: record.updated_at || snapshot.updatedAt || snapshot.fetchedAt || record.fetched_at || null,
      });
    });
  });
  const availableRows = [...rowsByKey.values()];
  const rows = filterRowsByDate(availableRows, range, getProfitLedgerRowDate);
  return {
    connected: true,
    rows,
    availableRows,
    syncedAt: latestTimestamp(rows.length ? rows : availableRows, ['__snapshotUpdatedAt']),
  };
}

function getShanghaiHour(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return null;
  const part = shanghaiHourFormatter
    .formatToParts(date)
    .find((item) => item.type === 'hour');
  const hour = Number(part?.value);
  return Number.isFinite(hour) ? hour : null;
}

function getActualProfitValue(row = {}) {
  const result = row?.results?.actualProfitCny;
  if (normalizeText(result?.status).toLowerCase() !== 'ready') return null;
  return toFiniteNumber(result?.value);
}

function buildTrend({ orders = [], profitRows = [], range = {}, salesTrend = [] } = {}) {
  const singleDay = range.startDate === range.endDate;
  const bucketKeys = singleDay
    ? Array.from({ length: 12 }, (_item, index) => `${String(index * 2).padStart(2, '0')}:00`)
    : salesTrend.map((row) => row.date);
  const buckets = new Map(
    bucketKeys.map((key) => [key, {
      key,
      orderCount: 0,
      salesValue: 0,
      salesKnown: false,
      salesCurrency: '',
      profitValue: 0,
      profitKnown: false,
    }])
  );

  orders.forEach((row) => {
    if (normalizeText(row.status).toLowerCase() === 'cancelled') return;
    const key = singleDay
      ? (() => {
          const hour = getShanghaiHour(getOrderDate(row));
          return hour === null ? '' : `${String(Math.floor(hour / 2) * 2).padStart(2, '0')}:00`;
        })()
      : toDateKey(getOrderDate(row));
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.orderCount += 1;
    const money = moneyFromProducts(row);
    if (money.value === null || money.status !== 'confirmed') return;
    if (bucket.salesCurrency && bucket.salesCurrency !== money.currency) {
      bucket.salesKnown = false;
      bucket.salesCurrency = 'MIXED';
      return;
    }
    bucket.salesKnown = true;
    bucket.salesCurrency = money.currency;
    bucket.salesValue += money.value;
  });

  profitRows.forEach((row) => {
    const value = getActualProfitValue(row);
    if (value === null) return;
    const key = singleDay
      ? (() => {
          const hour = getShanghaiHour(getProfitLedgerRowDate(row));
          return hour === null ? '' : `${String(Math.floor(hour / 2) * 2).padStart(2, '0')}:00`;
        })()
      : toDateKey(getProfitLedgerRowDate(row));
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.profitKnown = true;
    bucket.profitValue += value;
  });

  return [...buckets.values()].map((bucket) => ({
    label: bucket.key,
    orderCount: bucket.orderCount,
    salesValue: bucket.salesKnown ? roundNumber(bucket.salesValue, 2) : 0,
    salesCurrency: bucket.salesCurrency,
    salesStatus: bucket.salesKnown ? 'confirmed' : 'empty',
    profitValue: bucket.profitKnown ? roundNumber(bucket.profitValue, 2) : null,
    profitCurrency: 'CNY',
    profitStatus: bucket.profitKnown ? 'confirmed' : 'not_returned',
  }));
}

function createShopPerformance(
  shops = [],
  shopRanking = [],
  profitRows = [],
  { orders = [], products = [], returns = [], purchaseCountByShopId = new Map() } = {}
) {
  const rankingById = new Map(shopRanking.map((row) => [normalizeText(row.shopId), row]));
  const profitByShopId = new Map();
  profitRows.forEach((row) => {
    const value = getActualProfitValue(row);
    if (value === null) return;
    const rowIds = new Set(getProfitLedgerRowShopIds(row));
    const shop = shops.find((candidate) =>
      [normalizeText(candidate.id), normalizeText(candidate.client_id)].some((id) => id && rowIds.has(id))
    );
    const shopId = normalizeText(shop?.id);
    if (!shopId) return;
    profitByShopId.set(shopId, (profitByShopId.get(shopId) || 0) + value);
  });
  const salesTotal = shopRanking.reduce((total, row) => total + (toFiniteNumber(row?.sales?.value) || 0), 0);
  const orderTotal = shopRanking.reduce((total, row) => total + (Number(row?.orderCount) || 0), 0);
  return shops.map((shop) => {
    const shopId = normalizeText(shop.id);
    const ranking = rankingById.get(shopId) || {};
    const salesValue = toFiniteNumber(ranking?.sales?.value);
    const shareBase = salesTotal > 0 ? salesTotal : orderTotal;
    const shareValue = salesTotal > 0 ? salesValue || 0 : Number(ranking?.orderCount) || 0;
    const shopProducts = products.filter((row) => normalizeText(row.shop_id) === shopId);
    const shopProductAnalysis = calculateProductAnalysis({ rows: shopProducts, salesProductRanking: [] });
    const shopStockWarningCount =
      (Number(metricById(shopProductAnalysis, 'outOfStockCount')?.value) || 0) +
      (Number(metricById(shopProductAnalysis, 'lowStockCount')?.value) || 0);
    const waitingDeliveryCount = orders.filter(
      (row) =>
        normalizeText(row.shop_id) === shopId &&
        ['awaiting_packaging', 'awaiting_deliver'].includes(normalizeText(row.status).toLowerCase())
    ).length;
    const afterSalesTodoCount = returns.filter(
      (row) => normalizeText(row.shop_id) === shopId && CURRENT_AFTER_SALES_STATUSES.has(normalizeText(row.status))
    ).length;
    const pendingPurchaseCount = Number(purchaseCountByShopId.get(shopId)) || 0;
    return {
      shopId,
      name: getShopLabel(shop),
      orderCount: Number(ranking?.orderCount) || 0,
      itemCount: Number(ranking?.itemCount) || 0,
      salesValue,
      salesCurrency: normalizeText(ranking?.sales?.currency),
      salesStatus: normalizeText(ranking?.sales?.status, ranking?.orderCount ? 'not_returned' : 'empty'),
      sharePercent: shareBase > 0 ? roundNumber((shareValue / shareBase) * 100, 2) : 0,
      netProfitValue: profitByShopId.has(normalizeText(shop.id))
        ? roundNumber(profitByShopId.get(normalizeText(shop.id)), 2)
        : null,
      netProfitStatus: profitByShopId.has(normalizeText(shop.id)) ? 'confirmed' : 'not_returned',
      currentTasks: {
        pendingPurchaseCount,
        waitingDeliveryCount,
        afterSalesTodoCount,
        stockWarningCount: shopStockWarningCount,
        total:
          pendingPurchaseCount + waitingDeliveryCount + afterSalesTodoCount + shopStockWarningCount,
      },
    };
  });
}

function createReadError(error, scope = {}) {
  return {
    ok: false,
    domain: 'dashboard-overview',
    source: 'sqlite',
    scope,
    error: {
      code: normalizeText(error?.code, 'DASHBOARD_OVERVIEW_READ_FAILED'),
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * One compact, source-backed payload for the home dashboard.
 * It reuses the frozen data-analysis calculators but never returns raw order,
 * product, return, buyer or finance rows to the renderer.
 */
export function createDashboardOverviewReadModel({ db } = {}) {
  const businessShare = createDashboardBusinessShareReadModel({ db });

  function read(query = {}) {
    const requestedShopIds = normalizeShopIds(query.shopIds ?? query.shop_ids ?? query.shopId ?? query.shop_id);
    if (requestedShopIds.length > MAX_SCOPED_SHOPS) {
      return createReadError(
        Object.assign(new Error(`Dashboard 店铺范围超过 ${MAX_SCOPED_SHOPS} 个。`), {
          code: 'DASHBOARD_OVERVIEW_SCOPE_TOO_LARGE',
        }),
        { shopIds: requestedShopIds }
      );
    }
    if (!db?.prepare) return createReadError(new Error('Dashboard SQLite read model is not connected.'));

    try {
      const shops = readScopedShops(db, requestedShopIds);
      const shopIds = shops.map((shop) => normalizeText(shop.id)).filter(Boolean);
      if (!shopIds.length) {
        return {
          ok: true,
          domain: 'dashboard-overview',
          source: 'sqlite',
          scope: { shopIds: [], shops: [], range: normalizeDateRange(query), timezone: 'Asia/Shanghai' },
          metrics: {},
          currentTasks: {},
          trend: [],
          latestOrders: [],
          hotProducts: [],
          shopPerformance: [],
          freshness: { sourceUpdatedAt: null, sources: [] },
        };
      }

      const range = normalizeDateRange(query);
      const comparisonRange = createPreviousRange(range);
      const shopScopeValues = [
        ...shopIds,
        ...shops.map((shop) => normalizeText(shop.client_id)).filter(Boolean),
      ];
      const allOrders = excludeStaleAndSynthetic(readRows(db, TABLE_SELECTS.orders, shopIds));
      const allProducts = excludeStaleAndSynthetic(readRows(db, TABLE_SELECTS.products, shopIds));
      const allFinance = excludeStaleAndSynthetic(readRows(db, TABLE_SELECTS.finance, shopIds));
      const allReturns = excludeStaleAndSynthetic(readRows(db, TABLE_SELECTS.returns, shopIds));
      const purchaseOverrides = readRows(db, TABLE_SELECTS.purchaseOverrides, shopIds);
      const periodOrders = filterRowsByDate(allOrders, range, getOrderDate);
      const comparisonOrders = filterRowsByDate(allOrders, comparisonRange, getOrderDate);
      const periodFinance = filterRowsByDate(allFinance, range, (row) => row.operation_date || row.created_at);
      const comparisonFinance = filterRowsByDate(
        allFinance,
        comparisonRange,
        (row) => row.operation_date || row.created_at
      );
      const periodReturns = filterRowsByDate(
        allReturns,
        range,
        (row) => row.created_at_remote || row.created_at
      );
      const comparisonReturns = filterRowsByDate(
        allReturns,
        comparisonRange,
        (row) => row.created_at_remote || row.created_at
      );
      const profitLedger = readProfitLedgerRows(db, shopScopeValues, range);
      const sales = calculateSalesAnalysis({
        rows: periodOrders,
        comparisonRows: comparisonOrders,
        range,
        comparisonRange,
      });
      const products = calculateProductAnalysis({ rows: allProducts, salesProductRanking: sales.productRanking });
      const afterSales = calculateAfterSalesAnalysis({
        rows: periodReturns,
        comparisonRows: comparisonReturns,
        allRows: allReturns,
        orderRows: periodOrders,
      });
      const finance = calculateFinanceAnalysis({
        rows: periodFinance,
        comparisonRows: comparisonFinance,
        currentOrderRows: periodOrders,
        purchaseOverrides,
        profitLedgerRows: profitLedger.rows,
        profitLedgerSourceSyncedAt: profitLedger.syncedAt,
      });
      const purchaseCounts = businessShare.read({ shopIds });
      const purchaseCountByShopId = new Map(
        (purchaseCounts?.byShop || []).map((row) => [
          normalizeText(row.shopId),
          Number(row.pendingPurchaseCount) || 0,
        ])
      );
      const orderCount = metricById(sales, 'orderCount');
      const effectiveOrderCount = metricById(sales, 'effectiveOrderCount');
      const salesAmount = metricById(sales, 'salesAmount');
      const averageOrderValue = metricById(sales, 'averageOrderValue');
      const cancelledCount = metricById(sales, 'cancelledCount');
      const outOfStockCount = metricById(products, 'outOfStockCount');
      const lowStockCount = metricById(products, 'lowStockCount');
      const productErrorCount = metricById(products, 'productErrorCount');
      const actualNetProfit = metricById(finance, 'actualNetProfit');
      const actualNetProfitCoverage = metricById(finance, 'actualNetProfitCoverage');
      const currentWaitingDeliveryCount = allOrders.filter((row) =>
        ['awaiting_packaging', 'awaiting_deliver'].includes(normalizeText(row.status).toLowerCase())
      ).length;
      const currentAfterSalesCount = allReturns.filter((row) =>
        CURRENT_AFTER_SALES_STATUSES.has(normalizeText(row.status))
      ).length;
      const stockWarningCount = (Number(outOfStockCount?.value) || 0) + (Number(lowStockCount?.value) || 0);
      const shopById = new Map(shops.map((shop) => [normalizeText(shop.id), shop]));
      const sources = [
        { id: 'orders', label: 'Ozon订单', rows: allOrders, fields: ['updated_at', 'last_seen_at'] },
        { id: 'products', label: 'Ozon商品与库存', rows: allProducts, fields: ['stocks_synced_at', 'updated_at'] },
        { id: 'finance', label: 'Ozon财务流水', rows: allFinance, fields: ['updated_at', 'last_seen_at'] },
        { id: 'returns', label: 'Ozon售后', rows: allReturns, fields: ['updated_at', 'last_seen_at'] },
        {
          id: 'profit-ledger',
          label: '利润账本',
          rows: profitLedger.availableRows,
          fields: ['__snapshotUpdatedAt'],
        },
      ].map((source) => ({
        id: source.id,
        label: source.label,
        rowCount: source.rows.length,
        updatedAt: latestTimestamp(source.rows, source.fields),
      }));
      const sourceUpdatedAt = latestTimestamp(sources, ['updatedAt']);

      return {
        ok: true,
        domain: 'dashboard-overview',
        source: 'sqlite',
        generatedAt: new Date().toISOString(),
        scope: {
          shopIds,
          shops: shops.map((shop) => ({ id: shop.id, name: shop.name, alias: shop.alias, label: getShopLabel(shop) })),
          range,
          comparisonRange,
          timezone: 'Asia/Shanghai',
        },
        metrics: {
          orderCount,
          effectiveOrderCount,
          salesAmount,
          averageOrderValue,
          cancelledCount,
          actualNetProfit,
          actualNetProfitCoverage,
          profitLedgerRowCount: finance.profitLedger?.rowCount || 0,
          profitLedgerReadyCount: finance.profitLedger?.readyCount || 0,
          productErrorCount,
          outOfStockCount,
          lowStockCount,
          inSaleProductCount: metricById(products, 'inSaleProductCount'),
        },
        currentTasks: {
          pendingPurchaseCount: Number(purchaseCounts?.counts?.pendingPurchaseCount) || 0,
          waitingDeliveryCount: currentWaitingDeliveryCount,
          afterSalesTodoCount: currentAfterSalesCount,
          stockWarningCount,
          productIssueCount: Number(productErrorCount?.value) || 0,
        },
        trend: buildTrend({
          orders: periodOrders,
          profitRows: profitLedger.rows,
          range,
          salesTrend: sales.trend,
        }),
        latestOrders: compactLatestOrders(allOrders, shopById),
        hotProducts: sales.productRanking.slice(0, 5).map((row) => ({
          rank: row.rank,
          name: row.name,
          sku: row.offerId || row.sku || row.key,
          sales: row.quantity,
          orderCount: row.orderCount,
          amountValue: row.sales?.value,
          currency: row.sales?.currency,
          amountStatus: row.sales?.status,
        })),
        shopPerformance: createShopPerformance(shops, sales.shopRanking, profitLedger.rows, {
          orders: allOrders,
          products: allProducts,
          returns: allReturns,
          purchaseCountByShopId,
        }),
        freshness: { sourceUpdatedAt, sources },
        dataPolicy: {
          localFirst: true,
          fakeDataAllowed: false,
          salesExcludesCancelled: true,
          stockWarningsExcludeArchivedAndValidationFailed: true,
          profitUsesReadyActualLedgerOnly: true,
        },
      };
    } catch (error) {
      return createReadError(error, { shopIds: requestedShopIds });
    }
  }

  return { read };
}

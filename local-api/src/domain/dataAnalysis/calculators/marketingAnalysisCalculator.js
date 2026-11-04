import {
  addMoney,
  countBy,
  createMetric,
  createMoneyAccumulator,
  latestTimestamp,
  normalizeText,
  parseJson,
  toFiniteNumber,
  toMoneyBreakdown,
} from '../lib/dataAnalysisUtils.js';

function isStale(row = {}) {
  const value = normalizeText(row.is_stale).toUpperCase();
  return row.is_stale === true || row.is_stale === 1 || value === '1' || value === 'TRUE';
}

function toActivityBusinessDate(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getActivityRange(row = {}) {
  const raw = parseJson(row.raw_json, {});
  return {
    startDate: toActivityBusinessDate(
      row.date_start || row.start_date || raw.date_start || raw.dateStart || raw.start_at || raw.startAt,
    ),
    endDate: toActivityBusinessDate(
      row.date_end || row.end_date || raw.date_end || raw.dateEnd || raw.end_at || raw.endAt,
    ),
  };
}

function getRangeBoundary(range = {}, key) {
  const value = key === 'startDate' ? range.startDate ?? range.from : range.endDate ?? range.to;
  return normalizeText(value).slice(0, 10);
}

function isActivityRelatedToRange(row = {}, range = {}) {
  const selectedStart = getRangeBoundary(range, 'startDate');
  const selectedEnd = getRangeBoundary(range, 'endDate');
  if (!selectedStart && !selectedEnd) return true;
  const activityRange = getActivityRange(row);
  return (
    (!selectedStart || !activityRange.endDate || activityRange.endDate >= selectedStart) &&
    (!selectedEnd || !activityRange.startDate || activityRange.startDate <= selectedEnd)
  );
}

function isActivityActive(row = {}, cutoffDate = new Date().toISOString().slice(0, 10)) {
  const range = getActivityRange(row);
  return (!range.startDate || range.startDate <= cutoffDate) && (!range.endDate || range.endDate >= cutoffDate);
}

function isTrueFlag(value) {
  if (value === true || value === 1) return true;
  return ['1', 'TRUE', 'YES'].includes(normalizeText(value).toUpperCase());
}

function hasAvailableCount(row = {}) {
  return isTrueFlag(row.has_available_count ?? row.hasAvailableCount);
}

function getActivityId(row = {}) {
  return normalizeText(row.activity_id || row.activityId);
}

function getActivityIdentity(row = {}) {
  const activityId = getActivityId(row);
  if (!activityId) return '';
  return `${normalizeText(row.source_type || row.sourceType, 'official')}\u001f${activityId}`;
}

function getProductIdentity(row = {}) {
  const productId = normalizeText(row.product_id || row.productId || parseJson(row.raw_json, {}).id);
  if (productId) return `product:${productId}`;
  const offerId = normalizeText(row.offer_id || row.offerId);
  if (offerId) return `offer:${offerId}`;
  const sku = normalizeText(row.ozon_sku || row.ozonSku || row.sku);
  return sku ? `sku:${sku}` : '';
}

function getProductIdentityKeys(row = {}) {
  const raw = parseJson(row.raw_json, {});
  return [
    ['product', row.product_id ?? row.productId ?? raw.id],
    ['offer', row.offer_id ?? row.offerId],
    ['sku', row.ozon_sku ?? row.ozonSku ?? row.sku],
  ]
    .map(([prefix, value]) => {
      const normalized = normalizeText(value);
      return normalized ? `${prefix}:${normalized}` : '';
    })
    .filter(Boolean);
}

function getCatalogStock(row = {}) {
  const stock = parseJson(row.stock_json, {});
  const present = toFiniteNumber(stock?.present);
  if (present !== null) return Math.max(0, present);
  if (Array.isArray(stock?.stocks) && stock.stocks.length) {
    const values = stock.stocks.map((item) => toFiniteNumber(item?.present)).filter((value) => value !== null);
    if (values.length) return values.reduce((total, value) => total + Math.max(0, value), 0);
  }
  const direct = toFiniteNumber(row.stock_value ?? row.currentStock);
  if (direct !== null && direct > 0) return direct;
  if (direct === 0 && !normalizeText(row.stock_json)) return 0;
  return null;
}

function isMeaningfulProductName(name, productId = '') {
  const normalized = normalizeText(name);
  if (!normalized || normalized === '商品名未返回') return false;
  return !productId || normalized !== productId;
}

function buildCatalogIndex(catalogProducts = []) {
  const index = new Map();
  (Array.isArray(catalogProducts) ? catalogProducts : [])
    .filter((row) => !isStale(row))
    .forEach((row) => getProductIdentityKeys(row).forEach((key) => index.set(key, row)));
  return index;
}

function findCatalogProduct(row = {}, catalogIndex = new Map()) {
  return getProductIdentityKeys(row)
    .map((key) => catalogIndex.get(key))
    .find(Boolean);
}

function dedupeRelations(rows = []) {
  const deduped = new Map();
  rows.forEach((row, index) => {
    const activityId = getActivityIdentity(row);
    const identity = getProductIdentity(row);
    const key = `${activityId}|${identity || `row:${normalizeText(row.id) || index}`}`;
    const current = deduped.get(key);
    const timestamp = normalizeText(row.last_seen_at || row.updated_at);
    const currentTimestamp = normalizeText(current?.last_seen_at || current?.updated_at);
    if (!current || timestamp >= currentTimestamp) deduped.set(key, row);
  });
  return [...deduped.values()];
}

function buildActivityRows(rows = [], productRows = [], cutoffDate) {
  const productCountByActivity = new Map();
  productRows.forEach((row) => {
    const activityId = getActivityIdentity(row);
    productCountByActivity.set(activityId, (productCountByActivity.get(activityId) || 0) + 1);
  });
  return rows
    .map((row) => {
      const raw = parseJson(row.raw_json, {});
      const range = getActivityRange(row);
      const availableCountKnown = hasAvailableCount(row);
      const joinedCount = toFiniteNumber(row.joined_count);
      return {
        activityId: getActivityId(row),
        title: normalizeText(row.title || row.original_title, '活动名称未返回'),
        sourceType: normalizeText(row.source_type, 'Ozon'),
        startDate: range.startDate || null,
        endDate: range.endDate || null,
        active: isActivityActive(row, cutoffDate),
        joinedCount,
        joinedCountKnown: joinedCount !== null,
        availableCount: availableCountKnown ? toFiniteNumber(row.available_count) : null,
        availableCountKnown,
        cachedProductCount: productCountByActivity.get(getActivityIdentity(row)) || 0,
        actionType: normalizeText(raw.action_type),
        discountType: normalizeText(raw.discount_type),
        discountValue: toFiniteNumber(raw.discount_value),
        sourceId: 'marketing',
        updatedAt: row.updated_at || null,
      };
    })
    .sort((left, right) => Number(right.active) - Number(left.active) || left.title.localeCompare(right.title, 'zh-CN'));
}

function buildActivityProductRows(rows = [], catalogProducts = [], activeActivityIds = new Set()) {
  const catalogIndex = buildCatalogIndex(catalogProducts);
  return rows
    .map((row) => {
      const raw = parseJson(row.raw_json, {});
      const productId = normalizeText(row.product_id || raw.id);
      const catalogProduct = findCatalogProduct(row, catalogIndex);
      const catalogName = normalizeText(catalogProduct?.name);
      const relationName = normalizeText(row.name);
      const activityStock = toFiniteNumber(row.stock ?? raw.stock);
      const currentStock = catalogProduct ? getCatalogStock(catalogProduct) : null;
      const price = toFiniteNumber(row.price ?? raw.price);
      const activityPrice = toFiniteNumber(row.activity_price ?? raw.action_price);
      const catalogPrice = parseJson(catalogProduct?.price_json, {});
      const currency = normalizeText(
        row.currency_code || raw.currency_code || catalogProduct?.currency_code || catalogPrice.currency_code,
        'UNKNOWN'
      ).toUpperCase();
      const stockMismatch =
        activityStock !== null && currentStock !== null ? activityStock !== currentStock : null;
      return {
        activityId: getActivityId(row),
        sourceType: normalizeText(row.source_type || row.sourceType, 'official'),
        productId,
        offerId: normalizeText(row.offer_id || catalogProduct?.offer_id || catalogProduct?.offerId),
        sku: normalizeText(row.ozon_sku || row.ozonSku || row.sku || catalogProduct?.sku),
        name: isMeaningfulProductName(relationName, productId)
          ? relationName
          : normalizeText(catalogName, relationName || productId || '商品名未返回'),
        catalogName: catalogName || null,
        catalogMatched: Boolean(catalogProduct),
        rowStatus: normalizeText(row.row_status, '未返回'),
        activeAtCutoff: activeActivityIds.has(getActivityIdentity(row)),
        price,
        activityPrice,
        currency,
        discountAmount: price !== null && activityPrice !== null ? Math.max(0, price - activityPrice) : null,
        stock: activityStock,
        activityStock,
        currentStock,
        stockMismatch,
        stockDifference:
          activityStock !== null && currentStock !== null ? currentStock - activityStock : null,
        sourceId: 'marketing-products',
        updatedAt: row.updated_at || null,
      };
    })
    .sort(
      (left, right) =>
        Number(right.activeAtCutoff) - Number(left.activeAtCutoff) ||
        (right.discountAmount || 0) - (left.discountAmount || 0)
    );
}

export function calculateMarketingAnalysis({
  activities = [],
  products = [],
  catalogProducts = [],
  range = {},
} = {}) {
  const historyActivities = (Array.isArray(activities) ? activities : []).filter((row) => !isStale(row));
  const allProductRelations = dedupeRelations(
    (Array.isArray(products) ? products : []).filter((row) => !isStale(row))
  );
  const selectedActivities = historyActivities.filter((row) => isActivityRelatedToRange(row, range));
  const selectedActivityIds = new Set(selectedActivities.map(getActivityIdentity));
  const cutoffDate = getRangeBoundary(range, 'endDate') || new Date().toISOString().slice(0, 10);
  const activeActivities = selectedActivities.filter((row) => isActivityActive(row, cutoffDate));
  const activeActivityIds = new Set(activeActivities.map(getActivityIdentity));
  const selectedProductRelations = allProductRelations.filter((row) => selectedActivityIds.has(getActivityIdentity(row)));
  const activeProductRelations = selectedProductRelations.filter((row) => activeActivityIds.has(getActivityIdentity(row)));
  const distinctActiveProducts = new Set(activeProductRelations.map(getProductIdentity).filter(Boolean));
  const sourceSyncedAt = latestTimestamp([...historyActivities, ...allProductRelations], [
    'updated_at',
    'last_seen_at',
  ]);
  const activityRows = buildActivityRows(selectedActivities, selectedProductRelations, cutoffDate);
  const enrichedProductRows = buildActivityProductRows(
    selectedProductRelations,
    catalogProducts,
    activeActivityIds
  );
  const productRows = enrichedProductRows.slice(0, 50);
  const availableKnownActivities = activeActivities.filter(hasAvailableCount);
  const availableCount = availableKnownActivities.reduce(
    (total, row) => total + (toFiniteNumber(row.available_count) ?? 0),
    0
  );
  const availabilityStatus =
    !activeActivities.length || !availableKnownActivities.length
      ? 'not_returned'
      : availableKnownActivities.length === activeActivities.length
        ? 'confirmed'
        : 'partial';
  const priceAccumulator = createMoneyAccumulator();
  enrichedProductRows
    .filter((row) => row.activeAtCutoff)
    .forEach((row) => addMoney(priceAccumulator, row.activityPrice, row.currency));
  const activityPriceAmount = toMoneyBreakdown(priceAccumulator);

  return {
    sourceSyncedAt,
    metrics: [
      createMetric({
        id: 'activityCount',
        label: '期间相关活动',
        value: selectedActivities.length,
        unit: 'count',
        sourceId: 'marketing',
        sourceLabel: 'Ozon活动SQLite缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: '活动起止日期与所选日期范围存在交集。',
      }),
      createMetric({
        id: 'historyActivityCount',
        label: '历史活动缓存',
        value: historyActivities.length,
        unit: 'count',
        sourceId: 'marketing',
        sourceLabel: 'Ozon活动SQLite缓存',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '当前店铺未过期的全部活动缓存实体数。',
      }),
      createMetric({
        id: 'activeActivityCount',
        label: '截止日有效活动',
        value: activeActivities.length,
        unit: 'count',
        sourceId: 'marketing',
        sourceLabel: 'Ozon活动起止日期',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: `按所选截止日 ${cutoffDate} 判断活动是否有效。`,
      }),
      createMetric({
        id: 'joinedActivityProductCount',
        label: '当前参与商品',
        value: distinctActiveProducts.size,
        unit: 'count',
        sourceId: 'marketing-products',
        sourceLabel: 'Ozon活动商品SQLite缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: '仅统计截止日有效活动中的未过期商品关系，并按商品去重。',
      }),
      createMetric({
        id: 'activeActivityRelationCount',
        label: '当前活动商品关系',
        value: activeProductRelations.length,
        unit: 'count',
        sourceId: 'marketing-products',
        sourceLabel: 'Ozon活动商品SQLite缓存',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '截止日有效活动中的activity_id+product_id关系数；同一商品可参与多个活动。',
      }),
      createMetric({
        id: 'cachedActivityProductCount',
        label: '历史活动商品缓存',
        value: allProductRelations.length,
        unit: 'count',
        sourceId: 'marketing-products',
        sourceLabel: 'Ozon活动商品SQLite缓存',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '过滤过期行并按activity_id+商品去重后的历史缓存关系数。',
      }),
      createMetric({
        id: 'availableActivityProductCount',
        label: '可加入活动商品',
        value: availabilityStatus === 'not_returned' ? null : availableCount,
        unit: 'count',
        status: availabilityStatus,
        sourceId: 'marketing',
        sourceLabel: 'Ozon活动available_count',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: `截止日有效活动中，官方明确返回可加入数量的活动 ${availableKnownActivities.length}/${activeActivities.length} 个；缺失值不按0计算。`,
      }),
      createMetric({
        id: 'activitySalesImpact',
        label: '活动带来销售额',
        value: null,
        unit: 'money',
        currency: '',
        status: 'not_returned',
        sourceId: 'marketing-report',
        sourceLabel: 'Ozon活动效果报告',
        sourceType: 'official-report-required',
        syncedAt: null,
        detail: '当前活动接口没有返回归因销售额；未接活动效果报告前不使用订单金额冒充。',
      }),
    ],
    activityRows,
    productRows,
    activityTypeBreakdown: countBy(activityRows, (row) => row.actionType || row.sourceType),
    activityPriceAmount,
    quality: {
      historyActivityCount: historyActivities.length,
      selectedActivityCount: selectedActivities.length,
      activeActivityCount: activeActivities.length,
      cachedRelationCount: allProductRelations.length,
      activeRelationCount: activeProductRelations.length,
      distinctActiveProductCount: distinctActiveProducts.size,
      availabilityKnownActivityCount: availableKnownActivities.length,
      availabilityExpectedActivityCount: activeActivities.length,
    },
    rowCount: selectedActivities.length,
    historyRowCount: historyActivities.length,
  };
}

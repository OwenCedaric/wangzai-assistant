import {
  addMoney,
  countBy,
  createMetric,
  createMoneyAccumulator,
  latestTimestamp,
  normalizeText,
  parseJson,
  roundNumber,
  toFiniteNumber,
  toMoneyBreakdown,
} from '../lib/dataAnalysisUtils.js';

const PRODUCT_STATE = Object.freeze({
  IN_SALE: 'IN_SALE',
  TO_SUPPLY: 'TO_SUPPLY',
  ARCHIVED: 'ARCHIVED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CANDIDATE: 'CANDIDATE',
  UNKNOWN: 'UNKNOWN',
});

function isStale(row = {}) {
  const value = normalizeText(row.is_stale).toUpperCase();
  return row.is_stale === true || row.is_stale === 1 || value === '1' || value === 'TRUE';
}

function getSnapshotVisibilities(row = {}) {
  const parsed = parseJson(row.snapshot_visibilities_json ?? row.snapshotVisibilities, []);
  const values = Array.isArray(parsed) ? parsed : [];
  const fallback = normalizeText(row.visibility).toUpperCase();
  return new Set([...values, fallback].map((value) => normalizeText(value).toUpperCase()).filter(Boolean));
}

function resolveProductState(row = {}) {
  const visibilities = getSnapshotVisibilities(row);
  const directVisibility = normalizeText(row.visibility).toUpperCase();
  const statusLabel = normalizeText(row.status_label).toUpperCase();
  const allSignals = [...visibilities, directVisibility, statusLabel].filter(Boolean);

  // A historical snapshot can contain ALL together with a concrete state. Concrete
  // terminal states take precedence so archived/failed goods never leak into stock KPIs.
  if (visibilities.has('ARCHIVED') || directVisibility === 'ARCHIVED') return PRODUCT_STATE.ARCHIVED;
  if (allSignals.some((value) => value.includes('FAIL') || value.includes('ERROR'))) {
    return PRODUCT_STATE.VALIDATION_ERROR;
  }
  if (visibilities.has('IN_SALE') || directVisibility === 'IN_SALE') return PRODUCT_STATE.IN_SALE;
  if (visibilities.has('TO_SUPPLY') || directVisibility === 'TO_SUPPLY') return PRODUCT_STATE.TO_SUPPLY;

  // Old caches only stored ALL. Keep them usable, while newer caches use the
  // snapshot_visibilities_json states above.
  if (visibilities.has('ALL') || directVisibility === 'ALL') {
    if (normalizeText(row.status_label).includes('出售中')) return PRODUCT_STATE.IN_SALE;
    if (normalizeText(row.status_label).includes('待销售')) return PRODUCT_STATE.TO_SUPPLY;
    return PRODUCT_STATE.CANDIDATE;
  }
  return PRODUCT_STATE.UNKNOWN;
}

function isArchived(row = {}) {
  return resolveProductState(row) === PRODUCT_STATE.ARCHIVED;
}

function isValidationError(row = {}) {
  return resolveProductState(row) === PRODUCT_STATE.VALIDATION_ERROR;
}

function isInventoryCandidate(row = {}) {
  return [PRODUCT_STATE.IN_SALE, PRODUCT_STATE.TO_SUPPLY, PRODUCT_STATE.CANDIDATE].includes(
    resolveProductState(row)
  );
}

function getStockQuantityEvidence(row = {}) {
  const stockJsonText = normalizeText(row.stock_json);
  const stock = parseJson(row.stock_json, {});
  const present = toFiniteNumber(stock?.present);
  if (present !== null) return Math.max(0, present);

  if (Array.isArray(stock?.stocks) && stock.stocks.length) {
    const values = stock.stocks.map((item) => toFiniteNumber(item?.present)).filter((value) => value !== null);
    if (values.length) return values.reduce((total, value) => total + Math.max(0, value), 0);
  }

  const direct = toFiniteNumber(row.stock_value);
  if (direct !== null && direct > 0) return direct;

  // In the current cache stock_value=0 is also the storage sentinel used when
  // the official payload returned present=null and stocks=[]. Do not turn that
  // sentinel into a confirmed stock zero. Direct-only legacy rows remain valid.
  if (direct === 0 && !stockJsonText) return 0;
  return null;
}

function getStockValue(row = {}) {
  const quantity = getStockQuantityEvidence(row);
  if (quantity !== null) return quantity;

  const raw = parseJson(row.raw_json, {});
  const hasExplicitNoStockFlags =
    raw?.has_fbo_stocks === false &&
    raw?.has_fbs_stocks === false &&
    Array.isArray(raw?.quants) &&
    raw.quants.length === 0;
  return hasExplicitNoStockFlags ? 0 : null;
}

function getPriceValue(row = {}) {
  const direct = toFiniteNumber(row.price_value);
  if (direct !== null && direct > 0) return direct;

  const price = parseJson(row.price_json, {});
  const fallbackCandidates = [price?.price, price?.marketing_price, price?.marketing_seller_price];
  for (const candidate of fallbackCandidates) {
    const value = toFiniteNumber(candidate);
    if (value !== null && value > 0) return value;
  }

  if (direct !== null) return direct;
  for (const candidate of fallbackCandidates) {
    const value = toFiniteNumber(candidate);
    if (value !== null) return value;
  }
  return null;
}

function getProductCurrency(row = {}) {
  return normalizeText(row.currency_code || parseJson(row.price_json, {}).currency_code, 'UNKNOWN').toUpperCase();
}

function getCategoryIdentity(row = {}) {
  return normalizeText(row.category_id || row.type_id || row.categoryId || row.typeId);
}

function getCategoryName(row = {}) {
  return normalizeText(
    row.resolved_category_name || row.resolvedCategoryName || row.category_name || row.categoryName
  );
}

function hasCategory(row = {}) {
  return Boolean(getCategoryName(row));
}

function getProductIdentityKeys(row = {}) {
  return [
    ['product', row.product_id ?? row.productId],
    ['offer', row.offer_id ?? row.offerId],
    ['sku', row.sku],
    ['key', row.key],
  ]
    .map(([prefix, value]) => {
      const normalized = normalizeText(value);
      return normalized ? `${prefix}:${normalized}` : '';
    })
    .filter(Boolean);
}

function buildStockRiskRows(rows = []) {
  return rows
    .filter((row) => isInventoryCandidate(row) && !isArchived(row) && !isValidationError(row))
    .map((row) => ({
      productId: normalizeText(row.product_id),
      offerId: normalizeText(row.offer_id),
      sku: normalizeText(row.sku),
      name: normalizeText(row.name, row.offer_id || row.sku || '商品名未返回'),
      visibility: resolveProductState(row),
      stock: getStockValue(row),
      updatedAt: row.stocks_synced_at || row.updated_at || null,
      sourceId: 'products',
    }))
    .filter((row) => row.stock !== null && row.stock <= 5)
    .sort((left, right) => left.stock - right.stock || left.name.localeCompare(right.name, 'zh-CN'))
    .slice(0, 50);
}

function buildReplenishmentRanking(candidateRows = [], salesProductRanking = []) {
  const candidateByIdentity = new Map();
  candidateRows.forEach((row) => {
    const stock = getStockValue(row);
    if (stock === null || stock > 5) return;
    getProductIdentityKeys(row).forEach((key) => candidateByIdentity.set(key, row));
  });

  return (Array.isArray(salesProductRanking) ? salesProductRanking : [])
    .map((salesRow) => {
      const product = getProductIdentityKeys(salesRow)
        .map((key) => candidateByIdentity.get(key))
        .find(Boolean);
      if (!product) return null;
      return {
        ...salesRow,
        productId: normalizeText(product.product_id || salesRow.productId),
        offerId: normalizeText(product.offer_id || salesRow.offerId),
        sku: normalizeText(product.sku || salesRow.sku),
        name: normalizeText(product.name || salesRow.name, product.offer_id || product.sku || '商品名未返回'),
        stock: getStockValue(product),
        visibility: resolveProductState(product),
        inventorySourceId: 'products',
      };
    })
    .filter(Boolean)
    .slice(0, 30)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function buildCategoryRows(rows = []) {
  const groups = countBy(rows, (row) => {
    const name = getCategoryName(row);
    if (name) return name;
    const identity = getCategoryIdentity(row);
    return identity ? `类目名称未返回（编号 ${identity}）` : '类目未返回';
  });
  return groups.slice(0, 20).map((row) => ({
    category: row.key,
    count: row.count,
    status:
      row.key === '类目未返回'
        ? 'not_returned'
        : row.key.startsWith('类目名称未返回（编号 ')
          ? 'id_only'
          : 'confirmed',
    sourceId: 'products',
  }));
}

function buildPriceBands(rows = []) {
  const bands = [
    { id: '0-20', label: '0–20', min: 0, max: 20, count: 0, currencies: new Set() },
    { id: '20-50', label: '20–50', min: 20, max: 50, count: 0, currencies: new Set() },
    { id: '50-100', label: '50–100', min: 50, max: 100, count: 0, currencies: new Set() },
    { id: '100-300', label: '100–300', min: 100, max: 300, count: 0, currencies: new Set() },
    { id: '300+', label: '300以上', min: 300, max: Number.POSITIVE_INFINITY, count: 0, currencies: new Set() },
  ];
  rows.forEach((row) => {
    const price = getPriceValue(row);
    if (price === null || price <= 0) return;
    const band = bands.find((item) => price >= item.min && price < item.max);
    if (band) {
      band.count += 1;
      const currency = getProductCurrency(row);
      if (currency) band.currencies.add(currency);
    }
  });
  return bands.map(({ max, currencies, ...row }) => ({
    ...row,
    max: Number.isFinite(max) ? max : null,
    openEnded: !Number.isFinite(max),
    currency: currencies.size === 1 ? [...currencies][0] : currencies.size ? 'MIXED' : '',
    sourceId: 'products',
  }));
}

function buildQuality(rows = [], { candidateTotal = 0, scopeLabel = '全部商品缓存' } = {}) {
  const total = rows.length;
  const syncAttemptedRows = rows.filter((row) =>
    [row.hydrated_at, row.detail_synced_at, row.prices_synced_at, row.stocks_synced_at].some((value) =>
      normalizeText(value)
    )
  );
  const hydratedRows = rows.filter((row) => normalizeText(row.hydrated_at));
  const priceSyncRows = rows.filter((row) => normalizeText(row.prices_synced_at));
  const directPriceUsableRows = rows.filter((row) => (toFiniteNumber(row.price_value) ?? 0) > 0);
  const priceKnownRows = rows.filter((row) => getPriceValue(row) !== null);
  const priceUsableRows = rows.filter((row) => (getPriceValue(row) ?? 0) > 0);
  const stockKnownRows = rows.filter((row) => getStockQuantityEvidence(row) !== null);
  const stockResultKnownRows = rows.filter((row) => getStockValue(row) !== null);
  const inStockRows = stockKnownRows.filter((row) => getStockValue(row) > 0);
  const categoryIdKnownRows = rows.filter((row) => getCategoryIdentity(row));
  const categoryNameReturnedRows = rows.filter((row) =>
    normalizeText(row.category_name || row.categoryName)
  );
  const categoryKnownRows = rows.filter(hasCategory);
  const completeRows = rows.filter(
    (row) => (getPriceValue(row) ?? 0) > 0 && getStockValue(row) !== null && hasCategory(row)
  );
  const coverage = (count) => (total ? roundNumber((count / total) * 100, 2) : null);

  return {
    scopeLabel,
    total,
    candidateTotal,
    syncAttemptedCount: syncAttemptedRows.length,
    hydratedCount: hydratedRows.length,
    priceSyncCount: priceSyncRows.length,
    directPriceUsableCount: directPriceUsableRows.length,
    priceFallbackCount: Math.max(0, priceUsableRows.length - directPriceUsableRows.length),
    priceKnownCount: priceKnownRows.length,
    priceUsableCount: priceUsableRows.length,
    stockKnownCount: stockKnownRows.length,
    stockResultKnownCount: stockResultKnownRows.length,
    inStockCount: inStockRows.length,
    categoryIdKnownCount: categoryIdKnownRows.length,
    categoryNameReturnedCount: categoryNameReturnedRows.length,
    categoryKnownCount: categoryKnownRows.length,
    completeCount: completeRows.length,
    priceCoveragePercent: coverage(priceUsableRows.length),
    stockCoveragePercent: coverage(stockKnownRows.length),
    categoryCoveragePercent: coverage(categoryKnownRows.length),
    completeCoveragePercent: coverage(completeRows.length),
  };
}

export function calculateProductAnalysis({ rows = [], salesProductRanking = [] } = {}) {
  const cacheRows = (Array.isArray(rows) ? rows : []).filter((row) => !isStale(row));
  const sourceSyncedAt = latestTimestamp(cacheRows, [
    'stocks_synced_at',
    'prices_synced_at',
    'detail_synced_at',
    'updated_at',
  ]);
  const candidateRows = cacheRows.filter(isInventoryCandidate);
  const inSaleRows = cacheRows.filter((row) => resolveProductState(row) === PRODUCT_STATE.IN_SALE);
  const toSupplyRows = cacheRows.filter((row) => resolveProductState(row) === PRODUCT_STATE.TO_SUPPLY);
  const archivedRows = cacheRows.filter(isArchived);
  const errorRows = cacheRows.filter(isValidationError);
  const candidateStockKnownRows = candidateRows.filter((row) => getStockValue(row) !== null);
  const candidateStockQuantityKnownRows = candidateRows.filter(
    (row) => getStockQuantityEvidence(row) !== null
  );
  const archivedStockKnownRows = archivedRows.filter((row) => getStockValue(row) !== null);
  const coverageStatus = (knownCount, expectedCount) => {
    if (!expectedCount) return 'empty';
    if (!knownCount) return 'not_returned';
    return knownCount === expectedCount ? 'confirmed' : 'partial';
  };
  const candidateStockStatus = coverageStatus(candidateStockKnownRows.length, candidateRows.length);
  const archivedStockStatus = coverageStatus(archivedStockKnownRows.length, archivedRows.length);
  const inSaleStockKnownCount = inSaleRows.filter((row) => getStockValue(row) !== null).length;
  const inSaleStockStatus = coverageStatus(inSaleStockKnownCount, inSaleRows.length);
  const outOfStockRows = candidateStockKnownRows.filter((row) => getStockValue(row) === 0);
  const inSaleOutOfStockRows = inSaleRows.filter((row) => getStockValue(row) === 0);
  const lowStockRows = candidateStockKnownRows.filter((row) => {
    const stock = getStockValue(row);
    return stock !== null && stock > 0 && stock <= 5;
  });
  const stockUnits = candidateStockKnownRows.reduce((total, row) => total + (getStockValue(row) || 0), 0);
  const archivedStockUnits = archivedStockKnownRows.reduce(
    (total, row) => total + (getStockValue(row) || 0),
    0
  );
  const candidatePriceRows = candidateRows.filter((row) => (getPriceValue(row) ?? 0) > 0);
  const priceAccumulator = createMoneyAccumulator();
  candidatePriceRows.forEach((row) => addMoney(priceAccumulator, getPriceValue(row), getProductCurrency(row)));
  const totalPrice = toMoneyBreakdown(priceAccumulator);
  const averagePrice =
    totalPrice.value !== null && candidatePriceRows.length
      ? roundNumber(totalPrice.value / candidatePriceRows.length, 2)
      : null;
  const quality = buildQuality(cacheRows, {
    candidateTotal: candidateRows.length,
    scopeLabel: '全部商品缓存',
  });
  const inventoryQuality = buildQuality(candidateRows, {
    candidateTotal: candidateRows.length,
    scopeLabel: '可经营候选商品',
  });

  return {
    sourceSyncedAt,
    metrics: [
      createMetric({
        id: 'productCount',
        label: '商品缓存总数',
        value: cacheRows.length,
        unit: 'count',
        sourceId: 'products',
        sourceLabel: 'Ozon商品SQLite缓存',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '当前店铺未过期的商品缓存实体数，包含归档商品。',
      }),
      createMetric({
        id: 'activeProductCount',
        label: '可经营候选',
        value: candidateRows.length,
        unit: 'count',
        sourceId: 'products',
        sourceLabel: 'Ozon商品状态快照',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: '状态快照属于IN_SALE、TO_SUPPLY或兼容旧缓存ALL，且不含归档和校验失败。',
      }),
      createMetric({
        id: 'inSaleProductCount',
        label: '出售中',
        value: inSaleRows.length,
        unit: 'count',
        sourceId: 'products',
        sourceLabel: 'Ozon商品状态快照',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: 'snapshot_visibilities包含IN_SALE。',
      }),
      createMetric({
        id: 'toSupplyProductCount',
        label: '待销售',
        value: toSupplyRows.length,
        unit: 'count',
        sourceId: 'products',
        sourceLabel: 'Ozon商品状态快照',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: 'snapshot_visibilities包含TO_SUPPLY。',
      }),
      createMetric({
        id: 'archivedProductCount',
        label: '已归档',
        value: archivedRows.length,
        unit: 'count',
        sourceId: 'products',
        sourceLabel: 'Ozon商品状态快照',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '状态快照或visibility包含ARCHIVED。',
      }),
      createMetric({
        id: 'productErrorCount',
        label: '校验异常',
        value: errorRows.length,
        unit: 'count',
        sourceId: 'products',
        sourceLabel: 'Ozon商品状态快照',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '状态信号包含FAIL或ERROR。',
      }),
      createMetric({
        id: 'stockUnits',
        label: '候选商品库存',
        value: stockUnits,
        unit: 'count',
        status: candidateStockStatus,
        sourceId: 'products',
        sourceLabel: 'Ozon库存接口缓存',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: `仅汇总可经营候选商品；库存结果可判定 ${candidateStockKnownRows.length}/${candidateRows.length} 个，其中数量字段返回 ${candidateStockQuantityKnownRows.length}/${candidateRows.length} 个。`,
      }),
      createMetric({
        id: 'archivedStockUnits',
        label: '归档商品库存',
        value: archivedStockUnits,
        unit: 'count',
        status: archivedStockStatus,
        sourceId: 'products',
        sourceLabel: 'Ozon库存接口缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: '单独核对归档商品缓存库存，不计入候选库存和库存风险。',
      }),
      createMetric({
        id: 'outOfStockCount',
        label: '待补货候选',
        value: outOfStockRows.length,
        unit: 'count',
        status: candidateStockStatus,
        sourceId: 'products',
        sourceLabel: 'Ozon库存接口缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: '可经营候选中官方库存明确为0的商品；排除归档、校验失败及库存未返回商品。',
      }),
      createMetric({
        id: 'inSaleOutOfStockCount',
        label: '出售中缺货',
        value: inSaleOutOfStockRows.length,
        unit: 'count',
        status: inSaleStockStatus,
        sourceId: 'products',
        sourceLabel: 'Ozon商品与库存缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: 'IN_SALE商品中官方库存明确为0的商品数。',
      }),
      createMetric({
        id: 'lowStockCount',
        label: '低库存候选',
        value: lowStockRows.length,
        unit: 'count',
        status: candidateStockStatus,
        sourceId: 'products',
        sourceLabel: 'Ozon库存接口缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: '可经营候选中库存1–5件的商品数。',
      }),
      createMetric({
        id: 'averageProductPrice',
        label: '候选商品平均价',
        value: averagePrice,
        unit: 'money',
        currency: totalPrice.currency,
        status: averagePrice === null ? 'not_returned' : totalPrice.status,
        sourceId: 'products',
        sourceLabel: 'Ozon商品价格缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: `仅计算价格大于0的可经营候选商品 ${candidatePriceRows.length}/${candidateRows.length} 个。`,
        breakdown: totalPrice.breakdown,
      }),
    ],
    visibilityBreakdown: countBy(cacheRows, resolveProductState),
    categoryBreakdown: buildCategoryRows(cacheRows),
    priceBands: buildPriceBands(candidatePriceRows),
    stockRiskRows: buildStockRiskRows(candidateRows),
    replenishmentRanking: buildReplenishmentRanking(candidateRows, salesProductRanking),
    quality,
    inventoryQuality,
    rowCount: cacheRows.length,
  };
}

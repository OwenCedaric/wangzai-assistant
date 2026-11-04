const NUMBER_RE = /-?\d+(?:[.,]\d+)?/u;

function text(value) {
  return String(value ?? '').trim();
}

function pick(source = {}, raw = {}, keys = []) {
  for (const key of keys) {
    const direct = source?.[key];
    if (direct !== undefined && direct !== null && direct !== '') return direct;
    const nested = raw?.[key];
    if (nested !== undefined && nested !== null && nested !== '') return nested;
  }
  return null;
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/\s/gu, '').replace(',', '.'));
  if (Number.isFinite(parsed)) return parsed;
  const match = String(value).match(NUMBER_RE);
  if (!match) return null;
  const fallback = Number(match[0].replace(',', '.'));
  return Number.isFinite(fallback) ? fallback : null;
}

function moneyValue(value) {
  const direct = number(value);
  if (direct !== null) return direct;
  if (!value || typeof value !== 'object') return null;
  const units = number(value.units);
  const nanos = number(value.nanos);
  if (units === null && nanos === null) return null;
  return (units || 0) + (nanos || 0) / 1_000_000_000;
}

function rawObject(record = {}) {
  return record?.raw && typeof record.raw === 'object' ? record.raw : {};
}

function labelValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    const labels = value.map(labelValue).filter(Boolean);
    return labels.length ? labels.join('、') : null;
  }
  if (typeof value === 'object') {
    return labelValue(pick(value, value, ['title', 'name', 'label', 'text', 'value', 'code']));
  }
  return text(value) || null;
}

function attributeNumber(source = {}, keys = []) {
  const attributes = [source.attributes, source.characteristics]
    .find((value) => Array.isArray(value)) || [];
  for (const attribute of attributes) {
    const key = text(attribute?.key ?? attribute?.id ?? attribute?.attributeId);
    if (!keys.includes(key)) continue;
    const value = number(attribute?.value ?? attribute?.values?.[0]?.value ?? attribute?.values?.[0]);
    if (value !== null) return value;
  }
  return null;
}

function packageDimensionsValue(source = {}) {
  const direct = labelValue(pick(source, source, ['packageDimensions', 'package_dimensions', 'custom_volume']));
  if (direct) return direct;
  const depth = number(pick(source, source, ['depth', 'length', 'packageDepth', 'package_depth']))
    ?? attributeNumber(source, ['9454']);
  const width = number(pick(source, source, ['width', 'packageWidth', 'package_width']))
    ?? attributeNumber(source, ['9455']);
  const height = number(pick(source, source, ['height', 'packageHeight', 'package_height']))
    ?? attributeNumber(source, ['9456']);
  return [depth, width, height].every((value) => value !== null && value > 0)
    ? `${depth} × ${width} × ${height} mm`
    : null;
}

function packageWeightValue(source = {}) {
  const direct = labelValue(pick(source, source, ['packageWeight', 'package_weight', 'custom_weight']));
  if (direct) return direct;
  const weight = number(pick(source, source, ['weight', 'weightGrams', 'weight_grams']))
    ?? attributeNumber(source, ['4497']);
  return weight !== null && weight > 0 ? `${weight} g` : null;
}

function listingDaysValue(listedAt, capturedAt = '') {
  if (!listedAt) return null;
  const start = new Date(listedAt);
  const end = capturedAt ? new Date(capturedAt) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000));
}

function complementPercent(value) {
  const parsed = number(value);
  return parsed !== null && parsed >= 0 && parsed <= 100 ? Math.max(0, 100 - parsed) : null;
}

function rateSummary(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'object') return labelValue(value);
  const values = Object.values(value)
    .map(number)
    .filter((item) => item !== null);
  return values.length ? values.map((item) => `${item}%`).join(' / ') : null;
}

export function resolveMarketDatasetId(dataset = '', endpoint = '', record = {}) {
  const id = text(dataset);
  const path = text(endpoint);
  const raw = rawObject(record);
  if (/\/Stats\/queries\/groups(?:[/?#]|$)/iu.test(path)) return 'keyword-groups';
  if (/\/charts\/v3\/(?:table\/by_sku|recommendation)(?:[/?#]|$)/iu.test(path)) return 'products';
  if (id === 'comparison' && (/price_segmentation/iu.test(path) || (
    pick(record, raw, ['from']) !== null && pick(record, raw, ['to']) !== null
  ))) return 'price-segments';
  return id;
}

export function normalizeMarketRecord(record = {}, dataset = '', sequence = 0, capturedAt = '', endpoint = '') {
  const raw = rawObject(record);
  const id = resolveMarketDatasetId(dataset, endpoint, record);
  const metrics = raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {};
  const date = text(pick(record, raw, ['date', 'day', 'period'])) || null;
  const averageDailyRevenue = moneyValue(
    pick(record, raw, ['averageDailyRevenue', 'avgGmvOnAccDays', 'adsDays'])
      ?? pick(metrics, metrics, ['averageDailyRevenue', 'avgGmvOnAccDays', 'adsDays']),
  );
  const averageDailyUnits = number(
    pick(record, raw, ['averageDailyUnits', 'avgOrdersOnAccDays', 'adqDays'])
      ?? pick(metrics, metrics, ['averageDailyUnits', 'avgOrdersOnAccDays', 'adqDays']),
  );
  const productCardViews = number(pick(record, raw, ['productCardViews', 'product_card_views', 'qtyViewPdp']));
  const productCardToCartRate = number(pick(record, raw, ['productCardToCartRate', 'product_card_to_cart_rate', 'convToCartPdp']));
  const searchCatalogViews = number(pick(record, raw, ['searchCatalogViews', 'search_catalog_views', 'sessionCountSearch']));
  const searchCatalogToCartRate = number(pick(record, raw, ['searchCatalogToCartRate', 'search_catalog_to_cart_rate', 'convToCartSearch']));
  const impressionToOrderRate = number(pick(record, raw, ['impressionToOrderRate', 'impression_to_order_rate', 'convViewToOrder']));
  const adSpendShare = number(pick(record, raw, ['adSpendShare', 'ad_spend_share', 'drr']));
  const promoDays = number(pick(record, raw, ['promoDays', 'promo_days', 'daysInPromo']));
  const promoRevenueShare = number(pick(record, raw, ['promoRevenueShare', 'promo_revenue_share']));
  const paidPromotionDays = number(pick(record, raw, ['paidPromotionDays', 'paid_promotion_days', 'daysWithTrafarets']));
  const listedAt = text(pick(record, raw, ['listedAt', 'listed_at', 'nullableCreateDate', 'createDate', 'createdAt'])) || null;
  const views = number(pick(record, raw, ['views', 'viewCount', 'view_count', 'itemsViews', 'traffic']));
  const clickThroughRate = number(pick(record, raw, ['clickThroughRate', 'click_through_rate', 'custom_click_rate']))
    ?? (views !== null && views > 0 && productCardViews !== null ? (productCardViews / views) * 100 : null);
  const fulfillmentModel = labelValue(pick(record, raw, ['fulfillmentModel', 'fulfillment_model', 'salesSchema']));
  const redemptionRate = number(pick(record, raw, ['redemptionRate', 'redemption_rate', 'nullableRedemptionRate']));
  const returnCancelRate = number(pick(record, raw, ['returnCancelRate', 'return_cancel_rate'])) ?? complementPercent(redemptionRate);
  const dimensions = packageDimensionsValue({ ...raw, ...record });
  const packageWeight = packageWeightValue({ ...raw, ...record });
  const followSellers = pick(record, raw, ['followSellers', 'follow_info', 'sellers']);
  const followSellerCount = number(pick(record, raw, ['followSellerCount', 'follow_seller_count', 'followCount']))
    ?? (Array.isArray(followSellers) ? followSellers.length : number(followSellers?.count));
  const followMinPrice = moneyValue(pick(record, raw, ['followMinPrice', 'follow_min_price']));
  const followMaxPrice = moneyValue(pick(record, raw, ['followMaxPrice', 'follow_max_price']));
  const rfbsRate = rateSummary(pick(record, raw, ['rfbsRate', 'rfbs_rate']));
  const fbpRate = rateSummary(pick(record, raw, ['fbpRate', 'fbp_rate']));
  const categoryCommission = pick(record, raw, ['categoryCommission', 'category_commission']);
  const categoryIds = pick(record, raw, ['categoryIds', 'category_ids']);
  const from = moneyValue(pick(record, raw, ['from', 'priceFrom', 'price_from']));
  const to = moneyValue(pick(record, raw, ['to', 'priceTo', 'price_to']));
  const isKeywords = id === 'keywords';
  const isMissing = id === 'missing-items';
  const isMarketProduct = id === 'market-products' || id === 'products';
  const isTrend = id === 'trends';
  const isPriceSegment = id === 'price-segments';
  const revenue = moneyValue(pick(record, raw, ['revenue', 'gmv', 'gmvSum', 'salesAmount', 'sales_amount', 'amount', 'orderedAmount', 'soldSum']))
    ?? (isTrend ? moneyValue(pick(metrics, metrics, ['revenue', 'revenueV2'])) : null);
  const title = text(pick(record, raw, ['title', 'name', 'productName', 'product_name', 'itemName', 'keyword', 'query']))
    || (isPriceSegment && (from !== null || to !== null) ? `${from ?? 0}–${to ?? '∞'} ₽` : '')
    || (isTrend ? date || '趋势记录' : '')
    || null;
  const productCount = number(pick(
    record,
    raw,
    isMissing ? ['productCount', 'itemsCount'] : ['productCount', 'totalItems', 'itemsCount'],
  ));
  const sales = isMissing
    ? number(pick(record, raw, ['sales', 'salesCount', 'sales_count', 'orderedUnits', 'ordered_units', 'totalItems']))
    : isKeywords
      ? number(pick(record, raw, ['sales', 'salesCount', 'orders', 'ord']))
      : isMarketProduct
        ? number(pick(record, raw, ['sales', 'soldCount', 'salesCount', 'orderedUnits', 'ordered_units']))
        : number(pick(record, raw, ['sales', 'salesCount', 'orderedUnits', 'ordered_units', 'orders']));
  const orders = number(pick(record, raw, ['orders', 'ord', 'orderCount']));
  const averagePrice = moneyValue(pick(record, raw, ['averagePrice', 'avgPrice', 'avg_price', 'currentPrice', 'price']));
  const averageRevenue = moneyValue(pick(record, raw, ['averageRevenue', 'avgCaRub']));
  const conversion = number(pick(record, raw, ['conversion', 'conversionRate', 'conversion_rate', 'searchUsersToOrdUsers']));
  const growth = number(pick(record, raw, ['growth', 'gmvGrowth', 'salesDynamics']));
  const searchPosition = number(
    pick(record, raw, ['searchPosition', 'search_position', 'searchResultPosition', 'search_result_position', 'positionInSearch', 'position_in_search', 'position'])
    ?? pick(metrics, metrics, ['searchPosition', 'searchResultPosition', 'positionInSearch', 'position']),
  );
  const orderAmount = moneyValue(
    pick(record, raw, ['orderAmount', 'order_amount', 'ordersAmount', 'orders_amount', 'orderedAmount', 'ordered_amount', 'orderedSum', 'ordered_sum', 'salesAmount', 'sales_amount', 'revenue', 'gmv', 'amount', 'soldSum'])
    ?? pick(metrics, metrics, ['orderAmount', 'ordersAmount', 'orderedAmount', 'orderedSum', 'salesAmount', 'revenue', 'revenueV2', 'gmv', 'amount']),
  );
  const dynamics = number(
    pick(record, raw, ['dynamics', 'dynamic', 'salesDynamics', 'sales_dynamics', 'revenueGrowth', 'revenue_growth', 'growth'])
    ?? pick(metrics, metrics, ['dynamics', 'dynamic', 'salesDynamics', 'revenueGrowth', 'growth']),
  );
  const orderedProducts = number(
    pick(record, raw, ['orderedProducts', 'ordered_products', 'orderedProductCount', 'ordered_product_count', 'orderedUnits', 'ordered_units', 'itemsOrdered', 'items_ordered', 'soldCount', 'salesCount', 'sales'])
    ?? pick(metrics, metrics, ['orderedProducts', 'orderedProductCount', 'orderedUnits', 'itemsOrdered', 'soldCount', 'salesCount', 'sales']),
  );
  const averagePurchasePrice = moneyValue(
    pick(record, raw, ['averagePurchasePrice', 'average_purchase_price', 'averagePurchaseCost', 'average_purchase_cost', 'avgPurchasePrice', 'avg_purchase_price', 'averagePrice', 'average_price', 'avgPrice'])
    ?? pick(metrics, metrics, ['averagePurchasePrice', 'averagePurchaseCost', 'avgPurchasePrice', 'averagePrice', 'avgPrice']),
  );
  const periodDays = number(
    pick(record, raw, ['periodDays', 'period_days', 'days', 'periodLength', 'period_length'])
    ?? pick(metrics, metrics, ['periodDays', 'days', 'periodLength']),
  );
  const stock = number(pick(record, raw, ['stock', 'stocks', 'availableStock', 'available_stock', 'quantity', 'lastStockFboMoscow']));
  const searches = number(pick(record, raw, ['searches', 'searchCount', 'count']));
  const uniqueSellers = number(pick(record, raw, ['uniqueSellers', 'uniqSellers']));
  const noInteractionCount = number(pick(record, raw, ['noInteractionCount', 'usersWithoutInterectionCount']));
  const noInteractionShare = number(pick(record, raw, ['noInteractionShare', 'usersWithoutInterectionShare']));
  const zeroResultCount = number(pick(record, raw, ['zeroResultCount', 'zrCount']));
  const zeroResultShare = number(pick(record, raw, ['zeroResultShare', 'zrShare']));
  const category1 = labelValue(pick(record, raw, ['category1', 'category1Name', 'category_1', 'category_1_name']));
  const category2 = labelValue(pick(record, raw, ['category2', 'category2Name', 'category_2', 'category_2_name']));
  const category3 = labelValue(pick(record, raw, ['category3', 'category3Name', 'category_3', 'category_3_name']));
  const normalized = {
    dataset: id,
    sequence: Number(sequence) || 0,
    capturedAt: text(capturedAt),
    id: text(pick(record, raw, ['id', 'sku', 'skuId', 'sku_id', 'productId', 'product_id', 'itemId', 'item_id', 'offerId', 'offer_id'])) || (isTrend ? date : null),
    title,
    date,
    category: labelValue(pick(record, raw, ['category', 'categoryName', 'category_name', 'category3Name', 'category2Name', 'category1Name', 'categoryId', 'category_id'])),
    category1,
    category2,
    category3,
    brand: pick(record, raw, ['brand', 'brandName', 'brand_name']),
    seller: pick(record, raw, ['seller', 'sellerName', 'seller_name']),
    article: pick(record, raw, ['article', 'vendorCode', 'vendor_code']),
    imageUrl: pick(record, raw, ['imageUrl', 'photo', 'photoUrl', 'picture']),
    link: pick(record, raw, ['link', 'url', 'productUrl']),
    recommendation: pick(record, raw, ['recommendation', 'action', 'suggestion']),
    feature: labelValue(
      pick(record, raw, ['feature', 'features', 'productFeature', 'productFeatures', 'product_feature', 'characteristic', 'characteristics', 'badge', 'badges', 'tag', 'tags', 'label', 'labels'])
      ?? pick(metrics, metrics, ['feature', 'features', 'productFeature', 'characteristic', 'badge', 'badges', 'tag', 'tags', 'label', 'labels']),
    ),
    searchPosition,
    orderAmount,
    dynamics,
    orderedProducts,
    averagePurchasePrice,
    periodDays,
    adSpendShare,
    promoDays,
    promoDiscount: number(pick(record, raw, ['promoDiscount', 'promo_discount', 'discount'])),
    promoRevenueShare,
    paidPromotionDays,
    productCardViews,
    productCardToCartRate,
    searchCatalogViews,
    searchCatalogToCartRate,
    impressionToOrderRate,
    clickThroughRate,
    fulfillmentModel,
    redemptionRate,
    returnCancelRate,
    packageDimensions: dimensions,
    packageWeight,
    listedAt,
    listingDays: number(pick(record, raw, ['listingDays', 'listing_days', 'createDays']))
      ?? listingDaysValue(listedAt, capturedAt),
    followSellerCount,
    followMinPrice,
    followMaxPrice,
    rfbsRate,
    fbpRate,
    categoryCommission: categoryCommission && typeof categoryCommission === 'object' ? categoryCommission : undefined,
    categoryIds: Array.isArray(categoryIds) ? categoryIds.map(text).filter(Boolean) : undefined,
    currency: text(pick(record, raw, ['currency', 'currencyCode'])) || 'RUB',
    price: averagePrice,
    averagePrice,
    averageRevenue,
    priceFrom: from,
    priceTo: to,
    sales,
    orders,
    productCount,
    revenue,
    stock,
    views,
    searches,
    conversion,
    growth,
    averageDailyRevenue,
    averageDailyUnits,
    uniqueSellers,
    noInteractionCount,
    noInteractionShare,
    zeroResultCount,
    zeroResultShare,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

export function marketRecordKey(record = {}) {
  return text(record.id) || text(record.title) || JSON.stringify(record);
}

export function mergeMarketRecords(left = {}, right = {}) {
  const leftSequence = Number(left.sequence) || 0;
  const rightSequence = Number(right.sequence) || 0;
  const latest = rightSequence >= leftSequence ? right : left;
  const fallback = latest === right ? left : right;
  return Object.fromEntries(Object.entries({ ...fallback, ...latest }).filter(([, value]) => (
    value !== null && value !== undefined && value !== ''
  )));
}

export function marketRecordCompleteness(record = {}) {
  const keys = [
    'title',
    'category',
    'brand',
    'seller',
    'article',
    'price',
    'sales',
    'orders',
    'revenue',
    'stock',
    'views',
    'conversion',
    'recommendation',
    'feature',
    'searchPosition',
    'orderAmount',
    'dynamics',
    'orderedProducts',
    'averagePurchasePrice',
    'adSpendShare',
    'promoDays',
    'promoRevenueShare',
    'productCardViews',
    'productCardToCartRate',
    'searchCatalogViews',
    'searchCatalogToCartRate',
    'impressionToOrderRate',
    'fulfillmentModel',
    'packageDimensions',
    'packageWeight',
    'listedAt',
    'followSellerCount',
  ];
  return keys.filter((key) => record[key] !== null && record[key] !== undefined && record[key] !== '').length;
}

export function isMeaningfulMarketRecord(record = {}) {
  const dataset = text(record.dataset);
  if (dataset === 'trends') return Boolean(text(record.date));
  if (dataset === 'price-segments') return number(record.priceFrom) !== null || number(record.priceTo) !== null;
  if (dataset === 'keywords') {
    // A keyword row without metrics is still a confirmed Ozon search term;
    // keep the term visible and leave unavailable measures as dashes.
    return Boolean(text(record.title));
  }
  if (['market-products', 'products', 'product-performance', 'missing-items'].includes(dataset)) return Boolean(text(record.id) || text(record.title));
  return Boolean(text(record.id) || text(record.title) || text(record.category) || text(record.brand) || marketRecordCompleteness(record) > 0);
}

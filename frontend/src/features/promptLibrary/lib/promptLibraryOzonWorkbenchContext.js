const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const SUPPORTED_CURRENCIES = new Set(['RUB', 'CNY', 'USD', 'KZT', 'AMD', 'BYN', 'EUR']);
const CURRENCY_FORMATTERS = new Map([['RUB', RUB_FORMATTER]]);

function text(value) {
  return String(value ?? '').trim();
}

function metric(value) {
  return parseOzonProductMetric(value);
}

function money(value, currency = 'RUB') {
  const parsed = metric(value);
  if (parsed === null) return '暂无';
  const normalized = SUPPORTED_CURRENCIES.has(text(currency).toUpperCase())
    ? text(currency).toUpperCase()
    : 'RUB';
  if (!CURRENCY_FORMATTERS.has(normalized)) {
    CURRENCY_FORMATTERS.set(normalized, new Intl.NumberFormat(normalized === 'CNY' ? 'zh-CN' : 'ru-RU', {
      style: 'currency',
      currency: normalized,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }));
  }
  return CURRENCY_FORMATTERS.get(normalized).format(parsed);
}

function number(value, suffix = '') {
  const parsed = metric(value);
  return parsed === null ? '暂无' : `${NUMBER_FORMATTER.format(parsed)}${suffix}`;
}

function percent(value) {
  return number(value, '%');
}

function categoryPath(record = {}) {
  const direct = text(record.category || record.categoryPath);
  if (direct) return direct.replace(/\s*>\s*/gu, ' / ');
  return [...new Set([
    record.category1,
    record.category2,
    record.category3,
  ].map(text).filter(Boolean))].join(' / ') || '暂无';
}

function firstImage(record = {}) {
  if (record.imageUrl || record.image || record.picture) {
    return text(record.imageUrl || record.image || record.picture);
  }
  return Array.isArray(record.imageUrls) ? text(record.imageUrls[0]) : '';
}

function availableProductAnalysisFields(record = {}) {
  if (text(record.sfSource) !== 'seerfar-open-api') return null;
  const fields = [
    metric(record.price) !== null ? 'price' : '',
    metric(record.cardPrice) !== null ? 'cardPrice' : '',
    metric(record.sales ?? record.orderedProducts) !== null ? 'sales' : '',
    metric(record.orders) !== null ? 'orders' : '',
    metric(record.revenue ?? record.orderAmount) !== null ? 'revenue' : '',
    metric(record.stock) !== null ? 'stock' : '',
    text(record.brand || record.brandName) ? 'brand' : '',
    text(record.seller || record.sellerName) ? 'seller' : '',
    categoryPath(record) !== '暂无' ? 'category' : '',
    metric(record.averageDailyRevenue) !== null ? 'averageDailyRevenue' : '',
    metric(record.averageDailyUnits) !== null ? 'averageDailyUnits' : '',
    metric(record.rating ?? record.reviewRating) !== null
      || metric(record.reviews ?? record.reviewCount) !== null ? 'ratingReviews' : '',
    metric(record.adSpendShare ?? record.drr) !== null ? 'adSpendShare' : '',
    metric(record.productCardViews ?? record.sessionCount) !== null ? 'productCardViews' : '',
    metric(record.productCardToCartRate ?? record.convToCartPdp) !== null ? 'productCardToCartRate' : '',
    metric(record.searchCatalogViews ?? record.sessionCountSearch) !== null ? 'searchCatalogViews' : '',
    metric(record.searchCatalogToCartRate ?? record.convToCartSearch) !== null ? 'searchCatalogToCartRate' : '',
    metric(record.impressionToOrderRate ?? record.convViewToOrder ?? record.orderConversionRate) !== null
      ? 'impressionToOrderRate'
      : '',
    text(record.fulfillmentModel)
      || (Array.isArray(record.fulfillment) ? record.fulfillment.some((item) => text(item)) : text(record.fulfillment))
      ? 'fulfillmentModel'
      : '',
    metric(record.redemptionRate) !== null ? 'redemptionRate' : '',
    metric(record.returnCancelRate ?? record.returnCancellationRate) !== null ? 'returnCancelRate' : '',
    metric(record.packageWeight ?? record.weight) !== null ? 'packageWeight' : '',
    text(record.packageDimensions || record.dimension || record.dimensions) ? 'packageDimensions' : '',
    metric(record.listingDays ?? record.upDays) !== null ? 'listingDays' : '',
    metric(record.followSellerCount ?? record.sellers) !== null ? 'followSellerCount' : '',
    metric(record.followMinPrice) !== null || metric(record.followMaxPrice) !== null ? 'followPriceRange' : '',
  ].filter(Boolean);
  return fields;
}

export function buildPromptLibraryOzonWorkbenchContext(record = {}) {
  const sku = text(record.id || record.sku || record.skuId || record.productId);
  const title = text(record.title || record.name) || '暂无商品标题';
  const imageUrl = firstImage(record);
  const productUrl = text(record.link || record.productUrl || record.productPageUrl);
  const visibleFields = availableProductAnalysisFields(record);
  return {
    order: {
      productName: title,
      offerId: sku,
    },
    product: {
      ...record,
      title,
      name: title,
      sku,
      skuId: sku,
      productId: sku,
      offerId: sku,
      imageUrl,
      productUrl,
      link: productUrl,
    },
    sidebarKind: 'product-analysis',
    productAnalysis: {
      ...(visibleFields ? { visibleFields } : {}),
      brand: text(record.brand || record.brandName) || '暂无',
      seller: text(record.seller || record.sellerName) || '暂无',
      category: categoryPath(record),
      price: money(record.price),
      cardPrice: money(record.cardPrice, record.cardPriceCurrency),
      sales: number(record.sales ?? record.orderedProducts, ' 件'),
      orders: number(record.orders),
      revenue: money(record.revenue ?? record.orderAmount),
      stock: number(record.stock, ' 件'),
      averageDailyRevenue: money(record.averageDailyRevenue),
      averageDailyUnits: number(record.averageDailyUnits, ' 件'),
      rating: number(record.rating ?? record.reviewRating, ' 分'),
      reviews: number(record.reviews ?? record.reviewCount, ' 条'),
      adSpendShare: percent(record.adSpendShare ?? record.drr),
      productCardViews: number(record.productCardViews ?? record.sessionCount),
      productCardToCartRate: percent(record.productCardToCartRate ?? record.convToCartPdp),
      searchCatalogViews: number(record.searchCatalogViews ?? record.sessionCountSearch),
      searchCatalogToCartRate: percent(record.searchCatalogToCartRate ?? record.convToCartSearch),
      impressionToOrderRate: percent(
        record.impressionToOrderRate ?? record.convViewToOrder ?? record.orderConversionRate
      ),
      fulfillmentModel: text(record.fulfillmentModel)
        || (Array.isArray(record.fulfillment) ? record.fulfillment.map(text).filter(Boolean).join(' / ') : text(record.fulfillment))
        || '暂无',
      redemptionRate: percent(record.redemptionRate),
      returnCancelRate: percent(record.returnCancelRate ?? record.returnCancellationRate),
      packageDimensions: text(record.packageDimensions || record.dimension || record.dimensions) || '暂无',
      packageWeight: number(record.packageWeight ?? record.weight, ' g'),
      listingDays: number(record.listingDays ?? record.upDays, ' 天'),
      followSellerCount: number(record.followSellerCount ?? record.sellers),
      followPriceRange: metric(record.followMinPrice) !== null || metric(record.followMaxPrice) !== null
        ? `${money(record.followMinPrice)}–${money(record.followMaxPrice)}`
        : '暂无',
    },
    title: 'Ozon 商品分析操作台',
    subtitle: '左侧固定当前商品数据，右侧查看对应 Ozon 商品页面',
  };
}
import { parseOzonProductMetric } from './smartToolOzonProductAnalysis.js';

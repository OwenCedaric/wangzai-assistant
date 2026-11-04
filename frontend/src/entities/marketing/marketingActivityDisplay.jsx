import { getMarketingActivityIdentityKey, isSameMarketingActivity } from "./marketingActivityCache.jsx";
import { filterMarketingProductsByScope } from "./marketingCacheRules.jsx";
import { firstMarketingValue } from "./marketingValueRules.jsx";
import { formatOzonPrice } from "../product/productPriceRules.jsx";

export function formatMarketingStatValue(value) {
  return value === null || value === undefined ? '...' : String(value);
}

export function getMarketingStatResolvedValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export function getMarketingProductPoolCacheKey(shop, activity, scope) {
  return `${shop?.id || shop?.clientId || 'shop'}::${getMarketingActivityIdentityKey(activity)}::${scope || 'joined'}`;
}

export function buildMarketingProductPoolCacheResult(products = [], activity = {}) {
  const dedupedProducts = Array.from(
    new Map(products.filter((product) => product?.id).map((product) => [product.id, product])).values()
  );
  const joinedTotal = dedupedProducts.filter((product) => product.status === '已添加').length;
  const availableTotal = dedupedProducts.filter((product) => product.status === '可添加').length;
  return {
    products: dedupedProducts,
    joinedTotal,
    availableTotal,
  };
}

export function getMarketingProductPoolSnapshotResult(snapshot, activity, scope = 'joined') {
  if (!snapshot || !activity?.id || !Array.isArray(snapshot.productPool)) return null;
  if (!snapshot.selectedSourceType) return null;
  const snapshotActivity = {
    id: snapshot.selectedActivityId,
    sourceType: snapshot.selectedSourceType,
  };
  if (!isSameMarketingActivity(snapshotActivity, activity)) return null;
  const cachedScope = ['joined', 'available', 'all'].includes(snapshot.productScope) ? snapshot.productScope : 'joined';
  if (cachedScope !== scope && cachedScope !== 'all') return null;
  return buildMarketingProductPoolCacheResult(filterMarketingProductsByScope(snapshot.productPool, scope), activity);
}

export const fixedMarketingActivityTitleById = {
  1977747: '弹性提升',
  3876484: '超能提升',
  3779044: '最大提升',
  3832538: '大幅折扣',
  3866038: '学校活动',
};

export const formatMarketingActivityPrice = (price, percent) => {
  const amount = Number.parseFloat(String(price).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(amount)) return price;
  return `¥${(amount * (percent / 100)).toFixed(2)}`;
};

export const normalizeMarketingPercent = (value) => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(99, Math.max(1, parsed));
};

export function parseMarketingNumber(value) {
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMarketingEstimate(item = {}) {
  const value = firstMarketingValue(
    item.estimate,
    item.estimated_turnover,
    item.estimatedTurnover,
    item.expected_turnover,
    item.expectedTurnover,
    item.predicted_sales,
    item.raw?.estimate,
    item.raw?.estimated_turnover,
    item.raw?.expected_turnover
  );
  if (!value) return '-';
  const currencyCode = firstMarketingValue(
    item.currency_code,
    item.currency,
    item.raw?.currency_code,
    item.raw?.currency
  );
  return parseMarketingNumber(value) === null ? value : formatOzonPrice(value, currencyCode || '');
}

export function formatMarketingProductActionPrice(item = {}) {
  const value = firstMarketingValue(
    item.action_price,
    item.actionPrice,
    item.activity_price,
    item.activityPrice,
    item.discounted_price,
    item.discountedPrice,
    item.price?.action_price,
    item.price?.activity_price,
    item.price?.discounted_price
  );
  if (!value) return '-';
  const currencyCode = firstMarketingValue(
    item.currency_code,
    item.currency,
    item.price?.currency_code,
    item.price?.currency
  );
  return parseMarketingNumber(value) === null ? value : formatOzonPrice(value, currencyCode || '');
}

export function isMarketingMissingPrice(product = {}) {
  return parseMarketingNumber(product.price) === null && parseMarketingNumber(product.sourceActivityPrice) === null;
}

export function isMarketingOutOfStock(product = {}) {
  const stock = parseMarketingNumber(product.stock);
  return stock !== null && stock <= 0;
}

export function getMarketingProductIssue(product = {}) {
  if (isMarketingMissingPrice(product)) return '缺售价';
  if (isMarketingOutOfStock(product)) return '库存不足';
  return '';
}

export function getMarketingProgressValue(value, total) {
  if (!total) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

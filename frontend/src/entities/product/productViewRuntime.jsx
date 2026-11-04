import { firstUsableOzonId } from '../order/orderShopScope.jsx';
import { firstFiniteNumber } from './productAttributes.jsx';
import { productStatusTabs } from './productStatusRules.jsx';

export function getProductOfferLookupId(product = {}) {
  return firstUsableOzonId(
    product.offerId,
    product.sku,
    product.raw?.entity?.offerId,
    product.raw?.entity?.offer_id,
    product.raw?.entity?.productNo,
    product.raw?.listItem?.offer_id
  );
}

export function canResolveProductOzonOperation(product = {}) {
  return Boolean(product?.productId || getProductOfferLookupId(product));
}

export function getProductSortValue(product = {}, key = '') {
  if (key === 'price') return firstFiniteNumber(product.priceValue, product.price);
  if (key === 'stock') return firstFiniteNumber(product.stock);
  if (key === 'fee') return firstFiniteNumber(product.feeTotalValue, product.feeTotal);
  if (key === 'profit') return firstFiniteNumber(product.estimatedProfitValue, product.estimatedProfit);
  if (key === 'weight') return firstFiniteNumber(product.weight);
  if (key === 'status') {
    const statusIndex = productStatusTabs.findIndex((tab) => tab.label === product.status);
    return statusIndex === -1 ? productStatusTabs.length : statusIndex;
  }
  return null;
}

export function compareProductSortValue(leftProduct = {}, rightProduct = {}, key = '', direction = 'desc') {
  const multiplier = direction === 'asc' ? 1 : -1;
  const left = getProductSortValue(leftProduct, key);
  const right = getProductSortValue(rightProduct, key);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left > right ? multiplier : -multiplier;
  }
  return String(left).localeCompare(String(right), 'zh-CN') * multiplier;
}

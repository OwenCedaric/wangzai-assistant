import { firstUsableOzonId } from './orderIdentityRules.jsx';

export function getAfterSalesProductLookupKeys(product = {}) {
  const raw = product.raw ?? {};
  return [
    product.offerId,
    product.sku,
    product.skuId,
    product.productId,
    raw.offer_id,
    raw.offerId,
    raw.sku,
    raw.sku_id,
    raw.skuId,
    raw.product_id,
    raw.productId,
  ]
    .map((value) => firstUsableOzonId(value))
    .filter(Boolean);
}

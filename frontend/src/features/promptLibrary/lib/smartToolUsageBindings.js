import { normalizeOzonShopOption } from '../../../shared/ozon/ozonShopOption.js';

const SHOP_CONTEXT_INPUT_PATTERN = /店铺.*(?:市场|语言)|(?:store|shop).*(?:market|language)/iu;
const PRODUCT_CONTEXT_INPUT_PATTERN = /商品.*(?:spu|skc).*sku|(?:product).*(?:spu|skc).*sku/iu;

function text(value) {
  return String(value ?? '').trim();
}

export function isSmartToolBoundShopInput(label = '') {
  return SHOP_CONTEXT_INPUT_PATTERN.test(text(label));
}

export function isSmartToolBoundProductInput(label = '') {
  return PRODUCT_CONTEXT_INPUT_PATTERN.test(text(label));
}

export function hasSmartToolBoundProductInput(tool = {}) {
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const usageInputs = Array.isArray(profile.usageInputs)
    ? profile.usageInputs
    : Array.isArray(tool.variables)
      ? tool.variables
      : [];
  return usageInputs.some(isSmartToolBoundProductInput);
}

export function createSmartToolBoundShopValue(shop = {}) {
  const option = normalizeOzonShopOption(shop);
  if (!option.shopId) return '';
  const market = text(shop.market || shop.marketName || shop.country || shop.region || '俄罗斯站');
  const language = text(shop.language || shop.locale || '俄语');
  return [option.displayName, market, language].filter(Boolean).join(' / ');
}

export function createSmartToolBoundProductValue(product = {}, sku = null) {
  const productTitle = text(product.title || product.name);
  const offerId = text(product.offerId || product.offer_id);
  const productId = text(product.productId || product.product_id || product.id);
  const skuCode = text(sku?.sku || sku?.id);
  const skuFacts = text(sku?.facts || sku?.label);
  return [
    productTitle ? `商品：${productTitle}` : '',
    offerId ? `货号：${offerId}` : '',
    productId && productId !== offerId ? `商品 ID：${productId}` : '',
    skuCode ? `SKU：${skuCode}` : '',
    skuFacts && skuFacts !== skuCode ? `规格：${skuFacts}` : '',
  ]
    .filter(Boolean)
    .join('；');
}

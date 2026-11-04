import {
  IMAGE_ARRAY_FIELDS,
  IMAGE_FIELDS,
  firstEffective,
  firstFilled,
  isPlainObject,
  normalizeArray,
  normalizeText,
  uniqueImageUrls,
  uniqueValues,
} from './ozonLocalDataLayerShared.js';
import {
  getAfterSalesCanonicalEntityKey,
  getAfterSalesCanonicalEntityKeyCandidates,
  getAfterSalesExactPostingNumber,
  getAfterSalesPostingBaseKey as getSharedAfterSalesPostingBaseKey,
  getAfterSalesReturnIdentity,
  getAfterSalesStableIdentityKey as getSharedAfterSalesStableIdentityKey,
} from '../shared/lib/afterSalesIdentity.js';

export function getShopKey(row = {}) {
  return firstFilled(row.shopClientId, row.shopId, row.sellerId, row.shop, row.shopName, 'unknown-shop');
}

export function getClientId(row = {}, options = {}) {
  const raw = isPlainObject(row.raw) ? row.raw : {};
  return firstFilled(
    row.clientId,
    row.client_id,
    row.shopClientId,
    row.sellerId,
    raw.clientId,
    raw.client_id,
    options.clientId,
    options.shopClientId
  );
}

export function getShopId(row = {}, options = {}) {
  const raw = isPlainObject(row.raw) ? row.raw : {};
  return firstFilled(row.shopId, row.shop_id, row.sellerId, raw.shopId, raw.shop_id, options.shopId, options.shopKey);
}

export function getStoreName(row = {}, options = {}) {
  const raw = isPlainObject(row.raw) ? row.raw : {};
  return firstFilled(row.storeName, row.shopName, row.shop, raw.storeName, raw.shopName, raw.shop, options.storeName);
}

export function getAfterSalesPostingBaseKey(value) {
  return getSharedAfterSalesPostingBaseKey(value);
}

export function getAfterSalesStableIdentityKey(row = {}, options = {}) {
  return getSharedAfterSalesStableIdentityKey(row, options);
}

export function getAfterSalesReturnId(row = {}) {
  return getAfterSalesReturnIdentity(row);
}

export function getAfterSalesPostingNumber(row = {}) {
  return getAfterSalesExactPostingNumber(row);
}

export function getAfterSalesCanonicalOrderKey(row = {}, options = {}, { includeIdentity = true } = {}) {
  return getAfterSalesCanonicalEntityKey(row, options, { includeIdentity });
}

export function scopedProductKey(shopKey, productKey) {
  const normalizedShopKey = normalizeText(shopKey) || 'unknown-shop';
  const normalizedProductKey = normalizeText(productKey);
  if (!normalizedProductKey) return '';
  return normalizedProductKey.startsWith(`${normalizedShopKey}:`)
    ? normalizedProductKey
    : `${normalizedShopKey}:${normalizedProductKey}`;
}

export function getLegacyOrderKey(row = {}) {
  const orderKey = firstFilled(
    row.recordKey,
    row.id,
    row.posting,
    row.postingNumber,
    row.posting_number,
    row.salesOrder,
    row.ozonOrderId,
    row.orderId,
    row.raw?.posting_number,
    row.raw?.postingNumber,
    row.raw?.posting,
    row.raw?.order_id,
    row.raw?.orderId
  );
  if (!orderKey) return '';
  return orderKey.includes(':') ? orderKey : `${getShopKey(row)}:${orderKey}`;
}

export function getAfterSalesOrderKeyCandidates(row = {}, options = {}) {
  const canonicalCandidates = getAfterSalesCanonicalEntityKeyCandidates(row, options);
  const returnId = getAfterSalesReturnId(row);
  const exactPosting = getAfterSalesPostingNumber(row);
  // 旧键仅用于没有完整发货单号的数据兼容；不能让母单键重新合并不同子单。
  const legacyKey = returnId || !exactPosting ? getLegacyOrderKey(row) : '';
  return [
    ...canonicalCandidates,
    legacyKey,
  ]
    .map(normalizeText)
    .filter((key, index, values) => key && values.indexOf(key) === index);
}

export function getOrderKey(row = {}, options = {}) {
  if (isAfterSalesSnapshot(options)) {
    const canonicalKey = getAfterSalesOrderKeyCandidates(row, options)[0];
    if (canonicalKey) return canonicalKey;
  }
  return getLegacyOrderKey(row);
}

export function getProductIdentityCandidates(product = {}, row = {}, index = 0, options = {}) {
  const raw = isPlainObject(product.raw) ? product.raw : {};
  const financialRaw = isPlainObject(product.financialRaw) ? product.financialRaw : {};
  const fields = isPlainObject(product.fields) ? product.fields : {};
  const candidates = uniqueValues([
    product.productKey,
    product.key,
    product.offerId,
    product.offer_id,
    product.offer,
    product.sku,
    product.skuId,
    product.sku_id,
    product.ozonSku,
    product.productId,
    product.product_id,
    product.id,
    product.productNo,
    fields.productKey,
    fields.offerId,
    fields.offer_id,
    fields.sku,
    fields.skuId,
    fields.sku_id,
    fields.ozonSku,
    fields.productId,
    fields.product_id,
    fields.id,
    raw.offer_id,
    raw.offerId,
    raw.sku,
    raw.sku_id,
    raw.skuId,
    raw.product_id,
    raw.productId,
    raw.id,
    financialRaw.offer_id,
    financialRaw.offerId,
    financialRaw.sku,
    financialRaw.sku_id,
    financialRaw.skuId,
    financialRaw.product_id,
    financialRaw.productId,
    financialRaw.id,
    row.productNo,
    row.offerId,
    row.offer_id,
    row.sku,
    row.skuId,
    row.sku_id,
    row.productId,
    row.product_id,
    row.id,
  ]);
  if (candidates.length || options.includeFallback === false) return candidates;
  return [`product-${index}`];
}

export function getProductIdentity(product = {}, row = {}, index = 0) {
  const productKey = getProductIdentityCandidates(product, row, index)[0];
  return scopedProductKey(getShopKey(row), productKey);
}

export function isAfterSalesSnapshot(optionsOrKey = {}) {
  if (Array.isArray(optionsOrKey)) return optionsOrKey.some((item) => isAfterSalesSnapshot(item));
  const snapshotKey =
    typeof optionsOrKey === 'string'
      ? optionsOrKey
      : normalizeText(optionsOrKey.snapshotKey || optionsOrKey.localDataSnapshotKey);
  return snapshotKey.startsWith('ozon-after-sales:');
}

export function getProductSourceCurrencyCode(product = {}) {
  const raw = isPlainObject(product.raw) ? product.raw : {};
  const fields = isPlainObject(product.fields) ? product.fields : {};
  return normalizeText(
    product.sourceCurrencyCode ||
      fields.sourceCurrencyCode ||
      raw.currency_code ||
      raw.currency ||
      product.currencyCode ||
      fields.currencyCode
  ).toUpperCase();
}

export function getProductQualityScore(product = {}) {
  const currencyCode = getProductSourceCurrencyCode(product);
  const priceValue = firstEffective(
    product.priceValue,
    product.price,
    product.fields?.priceValue,
    product.fields?.price
  );
  const hasImage = collectProductImages(product).length ? 1 : 0;
  const hasPrice = priceValue ? 1 : 0;
  const sourceScore =
    currencyCode === 'CNY' || currencyCode === 'RMB' ? 100 : currencyCode === 'RUB' || currencyCode === 'RUR' ? 10 : 40;
  return sourceScore + hasPrice * 5 + hasImage;
}

export function dedupeAfterSalesProductsForOrder(row = {}, products = []) {
  const deduped = [];
  const indexByProductKey = new Map();

  products.forEach((product, index) => {
    const productKey = getProductIdentity(product, row, index);
    if (!productKey) {
      deduped.push(product);
      return;
    }

    const currentIndex = indexByProductKey.get(productKey);
    if (currentIndex === undefined) {
      indexByProductKey.set(productKey, deduped.length);
      deduped.push(product);
      return;
    }

    const current = deduped[currentIndex];
    if (getProductQualityScore(product) > getProductQualityScore(current)) {
      deduped[currentIndex] = product;
    }
  });

  return deduped;
}

export function getProductShopKeyCandidates(product = {}, row = {}, options = {}) {
  const fields = isPlainObject(product.fields) ? product.fields : {};
  return uniqueValues([
    ...normalizeArray(options.shopKeys),
    options.shopKey,
    options.shopClientId,
    options.shopId,
    product.shopKey,
    product.shopClientId,
    product.shopId,
    product.sellerId,
    product.shop,
    product.shopName,
    fields.shopKey,
    fields.shopClientId,
    fields.shopId,
    fields.sellerId,
    fields.shop,
    fields.shopName,
    row.shopClientId,
    row.shopId,
    row.sellerId,
    row.shop,
    row.shopName,
  ]);
}

export function collectProductImages(product = {}) {
  const singleImages = IMAGE_FIELDS.map((field) => product[field]);
  const arrayImages = IMAGE_ARRAY_FIELDS.flatMap((field) => normalizeArray(product[field]));
  const raw = isPlainObject(product.raw) ? product.raw : {};
  const rawImages = [
    raw.image,
    raw.image_url,
    raw.imageUrl,
    raw.picture,
    raw.picture_url,
    raw.pictureUrl,
    raw.primary_image,
    raw.primaryImage,
    raw.main_image,
    raw.mainImage,
    raw.sku_image,
    raw.skuImage,
    ...normalizeArray(raw.images),
    ...normalizeArray(raw.pictures),
  ];
  return uniqueImageUrls([...singleImages, ...arrayImages, ...rawImages]);
}

export function collectProductSkuImages(product = {}) {
  const raw = isPlainObject(product.raw) ? product.raw : {};
  return uniqueImageUrls([
    product.skuImage,
    product.sku_image,
    ...normalizeArray(product.skuImages),
    raw.sku_image,
    raw.skuImage,
    raw.sku_picture,
    raw.skuPicture,
  ]);
}

export function collectProductMainImages(product = {}) {
  const raw = isPlainObject(product.raw) ? product.raw : {};
  return uniqueImageUrls([
    product.mainImage,
    product.productMainImage,
    product.primaryImage,
    product.primary_image,
    ...normalizeArray(product.mainImages),
    ...normalizeArray(product.productMainImages),
    product.image,
    ...normalizeArray(product.images),
    raw.primary_image,
    raw.primaryImage,
    raw.main_image,
    raw.mainImage,
    raw.productMainImage,
    raw.product_main_image,
    raw.image,
    raw.image_url,
    raw.imageUrl,
    ...normalizeArray(raw.images),
    ...normalizeArray(raw.pictures),
  ]);
}

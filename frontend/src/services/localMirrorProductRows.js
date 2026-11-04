import { getOzonCategoryPathByIds } from '../data/ozonCategoryIndex';
import { firstFilled, firstUsableOzonId, getOzonShopLabel } from '../entities/order/orderShopScope.jsx';
import { formatOzonPrice } from '../entities/product/productOzonApi.jsx';
import { firstFiniteNumber, getOzonMileageFeeCny } from '../entities/product/productAttributes.jsx';
import { normalizeImageList } from '../entities/product/productWriteHelpers.jsx';
import { normalizeProductStatusLabel, productStatusToneMap } from '../entities/product/productStatusRules.jsx';

export function roundLocalMirrorMoney(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Number(numericValue.toFixed(2)) : null;
}

export function isPlaceholderProductCategory(value) {
  const text = String(value ?? '').trim();
  return !text || ['未分类', '待确认', '未返回', '-'].includes(text);
}

export function getLocalMirrorProductCategoryName(entity = {}) {
  const descriptionCategoryId = firstFilled(entity.descriptionCategoryId, entity.description_category_id);
  const typeId = firstFilled(entity.typeId, entity.type_id);
  const indexedCategoryPath = getOzonCategoryPathByIds({ typeId, descriptionCategoryId });
  const cachedCategory = firstFilled(entity.categoryPath, entity.categoryName, entity.category);

  if (indexedCategoryPath && isPlaceholderProductCategory(cachedCategory)) return indexedCategoryPath;
  if (!isPlaceholderProductCategory(cachedCategory)) return cachedCategory;
  return indexedCategoryPath || cachedCategory || '待确认';
}

export function normalizeLocalMirrorProductRow(entity = {}, shop = {}) {
  const images = normalizeImageList([
    entity.image,
    ...(Array.isArray(entity.images) ? entity.images : []),
    entity.skuImage,
    ...(Array.isArray(entity.skuImages) ? entity.skuImages : []),
    entity.mainImage,
    ...(Array.isArray(entity.mainImages) ? entity.mainImages : []),
    entity.productMainImage,
    ...(Array.isArray(entity.productMainImages) ? entity.productMainImages : []),
  ]);
  const offerId = firstUsableOzonId(entity.offerId, entity.offer_id, entity.productNo, entity.sku);
  const productId = firstUsableOzonId(entity.productId, entity.product_id, entity.ozonProductId, entity.id);
  const ozonSku = firstUsableOzonId(entity.ozonSku, entity.skuId, entity.sku_id, entity.sku, productId);
  const identity = firstFilled(entity.localProductKey, offerId, productId, ozonSku, entity.name);
  const materialProfile =
    entity.materialProfile && typeof entity.materialProfile === 'object' ? entity.materialProfile : {};
  const weight = firstFilled(entity.weight, materialProfile.weight);
  const length = firstFilled(entity.length, materialProfile.length);
  const width = firstFilled(entity.width, materialProfile.width);
  const height = firstFilled(entity.height, materialProfile.height);
  const shopLabel = firstFilled(entity.shop, entity.shopName, entity.sellerName, getOzonShopLabel(shop));
  const localShopKey = firstFilled(
    entity.localShopKey,
    entity.shopClientId,
    entity.shopId,
    shop?.clientId,
    shop?.id,
    shopLabel
  );
  const descriptionCategoryId = firstFilled(entity.descriptionCategoryId, entity.description_category_id);
  const typeId = firstFilled(entity.typeId, entity.type_id);
  const currencyCode = firstFilled(entity.currencyCode, entity.currency, 'CNY');
  let priceValue = firstFiniteNumber(entity.priceValue, entity.price);
  const oldPriceValue = firstFiniteNumber(entity.oldPriceValue, entity.oldPrice);
  const commissionPercent = firstFiniteNumber(entity.commissionPercent);
  let commissionAmountValue = firstFiniteNumber(entity.commissionAmountValue, entity.commissionAmount);
  const acquiringFeeValue = firstFiniteNumber(entity.acquiringFeeValue, entity.acquiringFee);
  const mileageFeeValue = firstFiniteNumber(entity.mileageFeeValue, entity.mileageFee, getOzonMileageFeeCny());
  const feeTotalValue = firstFiniteNumber(entity.feeTotalValue, entity.feeTotal);
  const derivedCommissionAmountValue =
    feeTotalValue !== null && acquiringFeeValue !== null && mileageFeeValue !== null
      ? roundLocalMirrorMoney(feeTotalValue - acquiringFeeValue - mileageFeeValue)
      : null;
  const shouldUseDerivedCommission =
    derivedCommissionAmountValue !== null &&
    derivedCommissionAmountValue > 0 &&
    commissionPercent !== null &&
    commissionPercent > 0 &&
    (commissionAmountValue === null || Math.abs(commissionAmountValue) < 0.005);
  if (shouldUseDerivedCommission) {
    commissionAmountValue = derivedCommissionAmountValue;
  }
  const derivedPriceValue =
    commissionAmountValue !== null && commissionPercent !== null && commissionPercent > 0
      ? roundLocalMirrorMoney((commissionAmountValue * 100) / commissionPercent)
      : null;
  const commissionFromCurrentPrice =
    priceValue !== null && commissionPercent !== null && commissionPercent > 0
      ? roundLocalMirrorMoney((priceValue * commissionPercent) / 100)
      : null;
  const shouldUseDerivedPrice =
    derivedPriceValue !== null &&
    derivedPriceValue > 0 &&
    (priceValue === null ||
      shouldUseDerivedCommission ||
      (commissionFromCurrentPrice !== null && Math.abs(commissionFromCurrentPrice - commissionAmountValue) > 0.01));
  if (shouldUseDerivedPrice) {
    priceValue = derivedPriceValue;
  }
  const status = normalizeProductStatusLabel(firstFilled(entity.status, '待确认'));

  return {
    id: `local-mirror:${localShopKey}:${identity || Date.now()}`,
    productId,
    offerId,
    sku: offerId || ozonSku || productId || '未返回',
    ozonSku,
    name: firstFilled(entity.name, entity.title, entity.product, offerId, productId) || '本地镜像商品',
    category: getLocalMirrorProductCategoryName(entity),
    descriptionCategoryId: descriptionCategoryId || '',
    typeId: typeId || '',
    shop: shopLabel,
    shopName: shopLabel,
    shopId: firstFilled(entity.shopId, shop?.id, localShopKey),
    shopClientId: firstFilled(entity.shopClientId, shop?.clientId, localShopKey),
    price: shouldUseDerivedPrice
      ? formatOzonPrice(priceValue, currencyCode)
      : firstFilled(entity.price, priceValue === null ? '' : formatOzonPrice(priceValue, currencyCode), '待确认'),
    priceValue,
    oldPriceValue,
    currencyCode,
    stock: firstFilled(entity.stock, '待确认'),
    warehouseId: firstFilled(entity.warehouseId, ''),
    commissionPercent,
    commissionText: firstFilled(
      entity.commissionText,
      commissionPercent === null ? '' : `${commissionPercent}%`,
      '待确认'
    ),
    commissionRateMode: entity.commissionRateMode || '',
    commissionRateDate: entity.commissionRateDate || '',
    commissionRateReadAt: entity.commissionRateReadAt || '',
    commissionRateSource: entity.commissionRateSource || '',
    commissionPercentDailyRates: entity.commissionPercentDailyRates || {},
    commissionAmountValue,
    commissionAmount: shouldUseDerivedCommission
      ? formatOzonPrice(commissionAmountValue, currencyCode)
      : firstFilled(
          entity.commissionAmount,
          commissionAmountValue === null ? '' : formatOzonPrice(commissionAmountValue, currencyCode),
          '待确认'
        ),
    acquiringFeeValue,
    acquiringFee: firstFilled(
      entity.acquiringFee,
      acquiringFeeValue === null ? '' : formatOzonPrice(acquiringFeeValue, currencyCode),
      '待确认'
    ),
    mileageFeeValue,
    mileageFee: firstFilled(
      entity.mileageFee,
      mileageFeeValue === null ? '' : formatOzonPrice(mileageFeeValue, 'CNY'),
      '待确认'
    ),
    feeTotalValue,
    feeTotal: firstFilled(
      entity.feeTotal,
      feeTotalValue === null ? '' : formatOzonPrice(feeTotalValue, 'CNY'),
      '待确认'
    ),
    estimatedProfit: firstFilled(entity.estimatedProfit, '待确认'),
    weight,
    length,
    width,
    height,
    weightUnit: 'kg',
    dimensionUnit: 'cm',
    status,
    tone: productStatusToneMap[status] || entity.tone || 'default',
    image: images[0] || '',
    images,
    attributes: Array.isArray(entity.attributes) ? entity.attributes : [],
    materialProfile,
    localMirror: true,
    localSearchResult: true,
    liveHydrated: false,
    localProductKey: entity.localProductKey || '',
    localShopKey,
    localUpdatedAt: entity.localUpdatedAt || '',
    localLastSeenAt: entity.localLastSeenAt || '',
    raw: { localMirror: true, entity },
  };
}

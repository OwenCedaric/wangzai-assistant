import { firstFilled, firstUsableOzonId, normalizeOzonId } from '../entities/order/orderIdentityRules.jsx';
import { normalizeImageList, safeImageUrl } from '../entities/product/productImageRules.jsx';

export function getPurchaseOrderDisplayOrderId(order = {}) {
  return normalizeOzonId(firstFilled(order.packageOrderId, order.crossBorderOrderId, order.crossBorderInfo?.orderId));
}

export function getPurchaseOrderSkuImageUrl(product = {}) {
  const raw = product.raw ?? {};
  return (
    normalizeImageList([
      product.skuImage,
      product.sku_image,
      ...(Array.isArray(product.skuImages) ? product.skuImages : []),
      raw.sku_image,
      raw.skuImage,
      raw.sku_picture,
      raw.skuPicture,
    ])
      .map(safeImageUrl)
      .find(Boolean) || ''
  );
}

export function getPurchaseOrderOzonMainImageUrl(product = {}) {
  const raw = product.raw ?? {};
  return (
    normalizeImageList([
      product.mainImage,
      product.productMainImage,
      product.primaryImage,
      product.primary_image,
      ...(Array.isArray(product.mainImages) ? product.mainImages : []),
      ...(Array.isArray(product.productMainImages) ? product.productMainImages : []),
      product.image,
      ...(Array.isArray(product.images) ? product.images : []),
      raw.primary_image,
      raw.primaryImage,
      raw.main_image,
      raw.mainImage,
      raw.productMainImage,
      raw.product_main_image,
      raw.image,
      raw.image_url,
      raw.imageUrl,
      raw.picture,
      raw.picture_url,
      raw.pictureUrl,
      ...(Array.isArray(raw.images) ? raw.images : []),
      ...(Array.isArray(raw.pictures) ? raw.pictures : []),
    ])
      .map(safeImageUrl)
      .find(Boolean) || ''
  );
}

export function getPurchaseCrossBorderStrictOrderId(item = {}) {
  const safeItem = item && typeof item === 'object' ? item : {};
  return normalizeOzonId(
    firstFilled(safeItem.id, safeItem.order_id, safeItem.orderId, safeItem.package_order_id, safeItem.packageOrderId)
  );
}

export function getCrossBorderSheetInfo(item = {}) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const sheetInfo = safeItem.sheet_info || safeItem.sheetInfo || {};
  return {
    sheetOrderSn: firstUsableOzonId(
      sheetInfo.sheet_order_sn,
      sheetInfo.sheetOrderSn,
      sheetInfo.sheet_order_number,
      sheetInfo.sheetOrderNumber,
      safeItem.sheet_order_sn,
      safeItem.sheetOrderSn
    ),
    sheetUrl: firstUsableOzonId(
      sheetInfo.sheet,
      sheetInfo.sheet_url,
      sheetInfo.sheetUrl,
      safeItem.sheet,
      safeItem.sheet_url,
      safeItem.sheetUrl
    ),
  };
}

export function getOzonPostingDetailPayload(data = {}) {
  return data?.result?.posting ?? data?.result ?? data?.posting ?? data?.data?.posting ?? data?.data ?? data;
}

export function getOzonDeliveryMethodIdFromPosting(source = {}) {
  const payload = getOzonPostingDetailPayload(source);
  const deliveryMethod = payload?.delivery_method ?? payload?.deliveryMethod ?? payload?.delivery ?? {};
  const analytics = payload?.analytics_data ?? payload?.analyticsData ?? {};
  return normalizeOzonId(
    firstFilled(
      deliveryMethod.delivery_method_id,
      deliveryMethod.deliveryMethodId,
      deliveryMethod.method_id,
      deliveryMethod.id,
      payload.delivery_method_id,
      payload.deliveryMethodId,
      payload.method_id,
      analytics.delivery_method_id,
      analytics.deliveryMethodId
    )
  ).trim();
}

export function appendUniqueText(target, value) {
  const text = String(value || '').trim();
  if (!text || text === '???') return;
  if (target.some((item) => item.toLowerCase() === text.toLowerCase())) return;
  target.push(text);
}

export function getNormalizedDeliveryRouteLine(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

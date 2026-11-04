import { normalizeImageList, safeImageUrl } from '../product/productWriteHelpers.jsx';
import { normalizeOzonImageUrlsForPreload, preloadOzonImageUrls } from '../../services/ozonOrderExperience';
import React from 'react';

export function getSalesOrderPreviewImages(order = {}) {
  const product = order?.products?.[0] ?? {};
  const raw = product.raw ?? {};
  const skuImages = normalizeImageList([
    product.skuImage,
    product.sku_image,
    ...(Array.isArray(product.skuImages) ? product.skuImages : []),
    raw.sku_image,
    raw.skuImage,
    raw.sku_picture,
    raw.skuPicture,
  ]);
  const mainImages = normalizeImageList([
    product.mainImage,
    product.productMainImage,
    product.primaryImage,
    product.primary_image,
    ...(Array.isArray(product.mainImages) ? product.mainImages : []),
    ...(Array.isArray(product.productMainImages) ? product.productMainImages : []),
    raw.primary_image,
    raw.primaryImage,
    raw.main_image,
    raw.mainImage,
  ]);
  const skuImage = skuImages.map(safeImageUrl).find(Boolean) || '';
  const productMainImage = mainImages.map(safeImageUrl).find(Boolean) || '';
  const firstImage = skuImage || productMainImage;

  return [
    {
      image: firstImage,
      label: skuImage ? 'SKU图' : productMainImage ? '主图' : '未返回',
      alt: skuImage ? product.name || order.product || '订单 SKU 图' : product.name || order.product || 'Ozon 产品主图',
    },
    {
      image: productMainImage,
      label: productMainImage ? '主图' : '未返回',
      alt: product.name || order.product || 'Ozon 产品主图',
    },
  ];
}

export function getOrderPreviewImageUrls(rows = [], getPreviewImages = () => [], limit = 80) {
  return normalizeOzonImageUrlsForPreload(
    rows.flatMap((row) => getPreviewImages(row).map((preview) => preview.image)),
    { limit }
  );
}

export function useOzonOrderImagePreload(imageUrls = [], limit = 80) {
  const imageUrlKey = imageUrls.join('|');
  React.useEffect(() => {
    if (!imageUrlKey) return undefined;
    preloadOzonImageUrls(imageUrls, { limit, concurrency: 8 }).catch(() => undefined);
    return undefined;
  }, [imageUrlKey, imageUrls, limit]);
}

import { getOzonProductPictureLookupId } from '../../services/ozonOrderExperience';
import { safeImageUrl } from '../product/productImageRules.jsx';
import { firstFilled } from './orderIdentityRules.jsx';

export function getSalesOrderProductPictureId(product = {}) {
  return getOzonProductPictureLookupId(product);
}

export function hasSalesOrderProductImage(product = {}) {
  const raw = product.raw ?? {};
  return Boolean(
    safeImageUrl(
      firstFilled(
        product.skuImage,
        product.sku_image,
        Array.isArray(product.skuImages) ? product.skuImages[0] : '',
        product.mainImage,
        product.productMainImage,
        product.primaryImage,
        product.primary_image,
        Array.isArray(product.mainImages) ? product.mainImages[0] : '',
        Array.isArray(product.productMainImages) ? product.productMainImages[0] : '',
        product.image,
        Array.isArray(product.images) ? product.images[0] : '',
        raw.sku_image,
        raw.skuImage,
        raw.primary_image,
        raw.primaryImage,
        raw.main_image,
        raw.mainImage,
        raw.image,
        raw.picture
      )
    )
  );
}

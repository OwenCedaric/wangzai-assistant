import { safeImageUrl } from '../../../entities/product/productWriteHelpers.jsx';
import { saveProductImageHealthToLocalApi } from '../../../services/productModuleClient';
import { LazyHoverImagePreview } from '../../../shared/ui/ImagePreview.jsx';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import React from 'react';

export function ProductListImageThumb({ product }) {
  const imageUrl = safeImageUrl(product?.image);
  const handleImageError = React.useCallback(() => {
    if (!imageUrl || !product?.shopId) return;
    saveProductImageHealthToLocalApi(
      {
        shopId: product.shopId,
        productId: product.productId,
        offerId: product.offerId,
        sku: product.ozonSku || product.sku,
        imageUrl,
        status: 'broken',
        source: 'product-list-thumb',
      },
      { timeoutMs: 2000 }
    ).catch(() => undefined);
  }, [imageUrl, product?.offerId, product?.ozonSku, product?.productId, product?.shopId, product?.sku]);

  return (
    <LazyHoverImagePreview
      className="product-list-image-hover"
      previewClassName="product-list-image-preview"
      imageUrl={imageUrl}
      alt={product?.name || '商品图片'}
    >
      <div className="product-list-thumb">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={product?.name || '商品图片'}
            loading="lazy"
            onError={handleImageError}
          />
        ) : (
          <Inventory2Rounded />
        )}
      </div>
    </LazyHoverImagePreview>
  );
}

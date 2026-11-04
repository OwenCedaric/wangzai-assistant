import { safeImageUrl } from '../../../entities/product/productWriteHelpers.jsx';
import { LazyHoverImagePreview } from '../../../shared/ui/ImagePreview.jsx';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export function WarehouseProductIdentity({ product, compact = false }) {
  const imageUrl = safeImageUrl(product?.image || product?.images?.[0]);
  const offerId = product?.offerId || '未返回';
  const productId = product?.productId || '未返回';
  const ozonSku = product?.ozonSku || '未返回';

  return (
    <Box className={`warehouse-product-identity${compact ? ' is-compact' : ''}`}>
      <LazyHoverImagePreview
        className="warehouse-product-image-hover"
        previewClassName="warehouse-product-image-preview"
        imageUrl={imageUrl}
        alt={`商品 ${offerId}`}
      >
        <Box className={`warehouse-product-thumb${imageUrl ? '' : ' is-empty'}`}>
          {imageUrl ? (
            <Box component="img" src={imageUrl} alt={`商品 ${offerId}`} loading="lazy" />
          ) : (
            <Inventory2Rounded />
          )}
        </Box>
      </LazyHoverImagePreview>
      <Box className="warehouse-product-id-lines">
        <Typography variant="subtitle2" noWrap title={offerId}>
          货号：{offerId}
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" noWrap title={productId}>
          Ozon 商品编号：{productId}
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" noWrap title={ozonSku}>
          库存编码：{ozonSku}
        </Typography>
      </Box>
    </Box>
  );
}

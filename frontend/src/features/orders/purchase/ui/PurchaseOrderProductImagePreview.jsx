import { LazyHoverImagePreview } from '../../../../shared/ui/ImagePreview.jsx';
import { getPurchaseOrderPreviewImages } from '../lib/purchaseImageRules.jsx';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export function PurchaseOrderProductImagePreview({ order }) {
  const previews = getPurchaseOrderPreviewImages(order);

  return (
    <Box className="purchase-order-image-pair">
      {previews.map((preview, index) => (
        <LazyHoverImagePreview
          key={`${preview.label}-${index}`}
          className="purchase-order-image-hover"
          previewClassName="purchase-order-image-preview"
          imageUrl={preview.image}
          alt={preview.alt}
        >
          <Box className={`purchase-order-image-thumb${preview.image ? '' : ' empty'}`}>
            {preview.image ? (
              <Box
                component="img"
                src={preview.image}
                alt={preview.alt}
                loading="eager"
                decoding="async"
                fetchPriority="high"
              />
            ) : (
              <Inventory2Rounded fontSize="small" />
            )}
          </Box>
          <Typography variant="caption" className="purchase-order-image-label">
            {preview.label}
          </Typography>
        </LazyHoverImagePreview>
      ))}
    </Box>
  );
}

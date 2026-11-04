import { LazyHoverImagePreview } from '../../../../shared/ui/ImagePreview.jsx';
import { getSalesOrderPreviewImages } from '../../../../entities/order/orderImagePreviewRules.jsx';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export function SalesOrderProductImagePreview({ order }) {
  const previews = getSalesOrderPreviewImages(order);

  return (
    <Box className="sales-order-image-pair">
      {previews.map((preview, index) => (
        <LazyHoverImagePreview
          key={`${preview.label}-${index}`}
          className="sales-order-image-hover"
          previewClassName="sales-order-image-preview"
          imageUrl={preview.image}
          alt={preview.alt}
        >
          <Box className={`sales-order-image-thumb${preview.image ? '' : ' empty'}`}>
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
          <Typography variant="caption" className="sales-order-image-label">
            {preview.label}
          </Typography>
        </LazyHoverImagePreview>
      ))}
    </Box>
  );
}

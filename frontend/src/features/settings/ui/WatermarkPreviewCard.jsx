import { WATERMARK_SAMPLE_IMAGE_SRC } from '../../../shared/config/appConfigCore.jsx';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function WatermarkPreviewCard({
  activeTemplate,
  previewFrameRef,
  textPreviewRef,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
}) {
  return (
    <Box className="watermark-preview-card">
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1.5}>
        <Box>
          <Typography variant="h6">实时预览</Typography>
          <Typography variant="body2" color="text.secondary">
            {activeTemplate.name}
          </Typography>
        </Box>
        <Chip size="small" color="primary" label="3:4" variant="outlined" />
      </Stack>
      <Box className="watermark-preview-frame" ref={previewFrameRef}>
        <Box
          component="img"
          className="watermark-preview-sample-image"
          src={WATERMARK_SAMPLE_IMAGE_SRC}
          alt="水印示例商品图"
        />
        {activeTemplate.imageDataUrl ? (
          <Box
            component="img"
            className="watermark-preview-image"
            src={activeTemplate.imageDataUrl}
            alt={activeTemplate.imageName || '水印图'}
            draggable={false}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
            onMouseDown={onPointerDown}
            onDragStart={(event) => event.preventDefault()}
            sx={{
              width: `${activeTemplate.imageSize}%`,
              left: `${activeTemplate.imageX}%`,
              top: `${activeTemplate.imageY}%`,
              opacity: activeTemplate.opacity / 100,
            }}
          />
        ) : (
          <Box
            className="watermark-preview-mark"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
            onMouseDown={onPointerDown}
            sx={{
              width: `${activeTemplate.imageSize}%`,
              left: `${activeTemplate.imageX}%`,
              top: `${activeTemplate.imageY}%`,
              opacity: activeTemplate.opacity / 100,
            }}
          >
            WZ
          </Box>
        )}
        {activeTemplate.text ? (
          <Box
            ref={textPreviewRef}
            className="watermark-preview-text"
            onPointerDown={(event) => onPointerDown(event, 'text')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
            onMouseDown={(event) => onPointerDown(event, 'text')}
            sx={{
              width: activeTemplate.wrapText ? `${activeTemplate.textWidth}%` : 'max-content',
              left: `${activeTemplate.textX}%`,
              top: `${activeTemplate.textY}%`,
              fontSize: `${activeTemplate.textSize}px`,
              color: activeTemplate.textColor,
              opacity: activeTemplate.opacity / 100,
              transform: 'translate(-50%, -50%)',
              whiteSpace: activeTemplate.wrapText ? 'pre-wrap' : 'pre',
              overflowWrap: activeTemplate.wrapText ? 'break-word' : 'normal',
            }}
          >
            {activeTemplate.text}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

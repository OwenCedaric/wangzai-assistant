import CloseRounded from '@mui/icons-material/CloseRounded';
import ImageNotSupportedRounded from '@mui/icons-material/ImageNotSupportedRounded';
import ZoomInRounded from '@mui/icons-material/ZoomInRounded';
import ZoomOutRounded from '@mui/icons-material/ZoomOutRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { createCustomerChatImageUrl } from '../lib/customerChatImageUrl.js';
import { CustomerMessageRichText } from './CustomerMessageRichText.jsx';

function attachmentKey(attachment = {}, index = 0) {
  return `${attachment.url || 'attachment'}:${index}`;
}

function readImageMetrics(event) {
  const width = Number(event?.currentTarget?.naturalWidth) || 0;
  const height = Number(event?.currentTarget?.naturalHeight) || 0;
  const lowResolution = width > 0 && height > 0 && width * height < 240_000;
  return {
    width,
    height,
    lowResolution,
    recommendedZoom: lowResolution ? Math.min(6, Math.max(2, Math.floor(960 / width))) : 1,
  };
}

export function CustomerMessageAttachments({ attachments = [], shopId = '' }) {
  const [failed, setFailed] = React.useState({});
  const [retries, setRetries] = React.useState({});
  const [imageMetrics, setImageMetrics] = React.useState({});
  const [preview, setPreview] = React.useState(null);
  const [previewMode, setPreviewMode] = React.useState('fit');
  const [previewZoom, setPreviewZoom] = React.useState(1);
  const [previewMetrics, setPreviewMetrics] = React.useState(null);
  const rows = Array.isArray(attachments) ? attachments : [];

  if (!rows.length) return null;

  const imageRows = [];
  const fileRows = [];
  rows.forEach((attachment, index) => {
    const key = attachmentKey(attachment, index);
    const src = createCustomerChatImageUrl({ shopId, url: attachment?.url, retry: retries[key] });
    if (attachment?.type === 'image' && src) imageRows.push({ attachment, index, key, src });
    else fileRows.push({ attachment, index });
  });

  const retryImage = (key) => {
    setFailed((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setRetries((current) => ({ ...current, [key]: Number(current[key] || 0) + 1 }));
  };

  const openPreview = (attachment, key) => {
    setPreview({ attachment, key });
    setPreviewMode('fit');
    setPreviewZoom(1);
    setPreviewMetrics(null);
  };

  const closePreview = () => setPreview(null);

  const handlePreviewLoad = (event) => {
    const metrics = readImageMetrics(event);
    setPreviewMetrics(metrics);
    if (metrics.lowResolution) {
      setPreviewMode('zoom');
      setPreviewZoom(metrics.recommendedZoom);
    } else {
      setPreviewMode('fit');
      setPreviewZoom(1);
    }
  };

  const changePreviewZoom = (change) => {
    setPreviewMode('zoom');
    setPreviewZoom((current) => Math.min(8, Math.max(1, Number(current || 1) + change)));
  };

  return (
    <>
      <Stack spacing={0.75} className="customer-chat-attachments">
        {imageRows.length ? (
          <Box className="customer-chat-image-grid">
            {imageRows.map(({ attachment, index, key, src }) => {
              const metrics = imageMetrics[key];
              return failed[key] ? (
                <Box key={key} className="customer-chat-image-failed" role="status">
                  <ImageNotSupportedRounded fontSize="small" />
                  <Typography variant="caption">图片读取失败</Typography>
                  <Button size="small" onClick={() => retryImage(key)}>
                    重新加载
                  </Button>
                </Box>
              ) : (
                <Box
                  component="button"
                  type="button"
                  key={key}
                  className="customer-chat-image-button"
                  aria-label={`查看图片 ${index + 1}`}
                  onClick={() => openPreview(attachment, key)}
                >
                  <Box
                    component="img"
                    src={src}
                    alt={attachment.name || `买家图片 ${index + 1}`}
                    className={metrics?.lowResolution ? 'customer-chat-image-low-resolution' : undefined}
                    style={
                      metrics?.lowResolution
                        ? { width: `${metrics.width}px`, height: `${metrics.height}px` }
                        : undefined
                    }
                    loading="lazy"
                    onLoad={(event) => {
                      const nextMetrics = readImageMetrics(event);
                      setImageMetrics((current) => ({ ...current, [key]: nextMetrics }));
                    }}
                    onError={() => setFailed((current) => ({ ...current, [key]: true }))}
                  />
                </Box>
              );
            })}
          </Box>
        ) : null}
        {fileRows.map(({ attachment, index }) => (
          <CustomerMessageRichText
            key={`${attachment?.url}-${index}`}
            variant="caption"
            text={`[${attachment?.name || '查看附件'}](${attachment?.url || ''})`}
          />
        ))}
      </Stack>

      <Dialog
        open={Boolean(preview)}
        onClose={closePreview}
        maxWidth={false}
        fullWidth
        scroll="paper"
        className="customer-chat-image-dialog"
        aria-labelledby="customer-chat-image-dialog-title"
      >
        <DialogTitle id="customer-chat-image-dialog-title">
          <Box className="customer-chat-image-dialog-heading">
            <Typography component="span">{preview?.attachment?.name || '买家图片'}</Typography>
            {previewMetrics?.width ? (
              <Typography component="span" variant="caption">
                Ozon 源图 {previewMetrics.width} × {previewMetrics.height}
                {previewMetrics.lowResolution ? ' · 低分辨率，已启用清晰放大' : ''}
              </Typography>
            ) : null}
          </Box>
          <Box className="customer-chat-image-dialog-actions">
            <Button
              size="small"
              variant={previewMode === 'fit' ? 'contained' : 'outlined'}
              onClick={() => setPreviewMode('fit')}
            >
              适应窗口
            </Button>
            <IconButton
              aria-label="缩小图片"
              disabled={previewMode === 'zoom' && previewZoom <= 1}
              onClick={() => changePreviewZoom(-1)}
            >
              <ZoomOutRounded />
            </IconButton>
            <Typography className="customer-chat-image-zoom-label" variant="caption">
              {previewMode === 'fit' ? '适应' : `${previewZoom * 100}%`}
            </Typography>
            <IconButton aria-label="放大图片" onClick={() => changePreviewZoom(1)}>
              <ZoomInRounded />
            </IconButton>
            <IconButton aria-label="关闭图片预览" onClick={closePreview}>
              <CloseRounded />
            </IconButton>
          </Box>
        </DialogTitle>
        <DialogContent>
          {preview ? (
            <Box className={`customer-chat-image-preview-stage ${previewMode === 'zoom' ? 'zoomed' : 'fit'}`}>
              <Box
                component="img"
                src={createCustomerChatImageUrl({
                  shopId,
                  url: preview.attachment.url,
                  retry: retries[preview.key],
                })}
                alt={preview.attachment.name || '买家图片大图'}
                className={previewMetrics?.lowResolution ? 'customer-chat-image-low-resolution' : undefined}
                style={
                  previewMode === 'zoom' && previewMetrics?.width
                    ? {
                        width: `${previewMetrics.width * previewZoom}px`,
                        height: `${previewMetrics.height * previewZoom}px`,
                      }
                    : undefined
                }
                onLoad={handlePreviewLoad}
              />
            </Box>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

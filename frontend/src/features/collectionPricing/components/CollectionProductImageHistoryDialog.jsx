import HistoryRounded from '@mui/icons-material/HistoryRounded';
import ImageOutlined from '@mui/icons-material/ImageOutlined';
import ReplayRounded from '@mui/icons-material/ReplayRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

import { LazyHoverImagePreview } from '../../../shared/ui/ImagePreview.jsx';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import { readProductImageAssetPreviews } from '../../products/services/productImageAssetService.js';
import {
  countCollectionProductImageHistoryImages,
  resolveCollectionProductImageHistoryUrl,
} from '../lib/collectionProductImageHistory.js';
import { CollectionProductDeferredImage } from './CollectionProductDeferredImage.jsx';

const PREVIEW_BATCH_SIZE = 50;

function HistoryImageTile({ item, shopId, label, assetPreview = {}, eager = false }) {
  const sources = React.useMemo(() => [...new Set([
    assetPreview.thumbnailUrl,
    assetPreview.previewUrl,
    item.assetId ? '' : resolveCollectionProductImageHistoryUrl(item, shopId),
    item.thumbnailUrl,
    item.previewUrl,
    item.imageUrl,
  ].filter(Boolean))], [assetPreview, item, shopId]);
  const [sourceIndex, setSourceIndex] = React.useState(0);
  React.useEffect(() => setSourceIndex(0), [sources]);
  const source = sources[sourceIndex] || '';
  const fullPreviewUrl = String(assetPreview.previewUrl || item.previewUrl || item.imageUrl || source).trim();
  const stored = Boolean(item.assetId && item.persistenceStatus !== 'error');
  return (
    <LazyHoverImagePreview
      imageUrl={fullPreviewUrl}
      alt={label}
      delay={120}
      className="collection-image-history-hover"
      previewClassName="prompt-library-image-hover-preview"
    >
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 0.75, overflow: 'hidden', bgcolor: '#fff' }}>
        <Box sx={{ position: 'relative', aspectRatio: '3 / 4', display: 'grid', placeItems: 'center', bgcolor: '#f7f8fa' }}>
          {source ? (
            <CollectionProductDeferredImage
              src={source}
              alt={label}
              priority={eager}
              onError={() => setSourceIndex((current) => current + 1)}
            />
          ) : <ImageOutlined sx={{ color: '#98a2b3' }} />}
          <Chip
            size="small"
            label={stored ? '已保存' : item.persistenceStatus === 'error' ? '保存失败' : '保存中'}
            color={stored ? 'success' : item.persistenceStatus === 'error' ? 'error' : 'default'}
            sx={{ position: 'absolute', top: 6, right: 6, height: 22, fontSize: 10 }}
          />
        </Box>
        <Typography variant="caption" noWrap sx={{ display: 'block', px: 0.75, py: 0.55 }} title={label}>{label}</Typography>
      </Box>
    </LazyHoverImagePreview>
  );
}

function historyItemPreviewUrl(item = {}, assetPreviews = {}) {
  const assetId = String(item.assetId || '').trim();
  if (assetId) return String(assetPreviews[assetId]?.previewUrl || '').trim();
  return String(item.previewUrl || item.imageUrl || '').trim();
}

export function CollectionProductImageHistoryDialog({ open, onClose, onRestore, history = {} }) {
  const entries = React.useMemo(
    () => Array.isArray(history.entries) ? history.entries : [],
    [history.entries],
  );
  const imageCount = countCollectionProductImageHistoryImages(entries);
  const shopId = String(history.shopId || '').trim();
  const assetIds = React.useMemo(() => [...new Set(entries.flatMap((entry) => (
    entry.items.map((item) => String(item.assetId || '').trim()).filter(Boolean)
  )))], [entries]);
  const [assetPreviews, setAssetPreviews] = React.useState({});
  const [previewsLoading, setPreviewsLoading] = React.useState(false);
  const [restoringEntryId, setRestoringEntryId] = React.useState('');

  React.useEffect(() => {
    if (!open || !shopId || !assetIds.length) {
      setPreviewsLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setPreviewsLoading(true);
    const batches = Array.from({ length: Math.ceil(assetIds.length / PREVIEW_BATCH_SIZE) }, (_item, index) => (
      assetIds.slice(index * PREVIEW_BATCH_SIZE, (index + 1) * PREVIEW_BATCH_SIZE)
    ));
    Promise.all(batches.map((batch) => readProductImageAssetPreviews(batch, {
      shopId,
      signal: controller.signal,
    })))
      .then((assetsByBatch) => {
        const next = Object.fromEntries(assetsByBatch.flat().map((asset) => [String(asset.id || '').trim(), asset]));
        setAssetPreviews(next);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') setAssetPreviews({});
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewsLoading(false);
      });
    return () => controller.abort();
  }, [open, shopId, assetIds]);

  const restoreEntry = async (entry) => {
    const restoredItems = entry.items.map((item) => {
      const previewUrl = historyItemPreviewUrl(item, assetPreviews);
      return previewUrl ? { ...item, status: 'success', imageUrl: previewUrl, previewUrl } : null;
    }).filter(Boolean);
    if (!restoredItems.length || typeof onRestore !== 'function') return;
    setRestoringEntryId(entry.id);
    try {
      const result = await onRestore({ ...entry, items: restoredItems });
      if (result?.ok !== false) onClose?.();
    } finally {
      setRestoringEntryId('');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      className="collection-product-image-history-dialog"
      PaperProps={{ 'aria-label': '生成历史' }}
      minimizeTaskTitle="生成历史"
      minimizeTaskSubtitle={history.productTitle || history.sourceProductId || ''}
    >
      <DialogTitle id="collection-product-image-history-title" component="div" sx={{ py: 1.25 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5}>
          <Box minWidth={0}>
            <Typography variant="h6" fontWeight={850}>生成历史</Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }} title={history.sourceUrl || ''}>
              {history.sourceUrl || history.productTitle || '当前采集商品'}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.75}>
            <Chip size="small" color="primary" variant="outlined" label={`共 ${imageCount} 张`} />
            <Chip size="small" variant="outlined" label={`${entries.length} 批`} />
          </Stack>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 330 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.25 }}>
          仅显示当前采集链接和当前 Ozon 店铺的记录；规则与 Ozon 商品图一致，成功图片保留 3 天。
        </Typography>
        {entries.length ? (
          <Stack spacing={1.25}>
            {entries.map((entry, entryIndex) => {
              const restorableCount = entry.items.filter((item) => historyItemPreviewUrl(item, assetPreviews)).length;
              const entryHasPendingPreview = previewsLoading && entry.items.some((item) => item.assetId && !assetPreviews[item.assetId]);
              return (
              <Box key={entry.id} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 0.75, p: 1 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 0.8 }}>
                  <Box minWidth={0}>
                    <Typography variant="subtitle2" fontWeight={800}>{entry.groupLabel} · {entry.items.length} 张</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                      {[entry.plannerModel ? `分析 ${entry.plannerModel}` : '', entry.model ? `生图 ${entry.model}` : '', new Date(entry.createdAt).toLocaleString()].filter(Boolean).join(' · ')}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={0.75} alignItems="center" flex="0 0 auto">
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<ReplayRounded />}
                      disabled={typeof onRestore !== 'function' || entryHasPendingPreview || !restorableCount || Boolean(restoringEntryId)}
                      onClick={() => restoreEntry(entry)}
                      sx={{ borderRadius: 0.6, whiteSpace: 'nowrap' }}
                    >{restoringEntryId === entry.id ? '正在应用…' : '重新应用本批'}</Button>
                    <Chip size="small" variant="outlined" label={entry.sourceProductId ? `来源 ${entry.sourceProductId}` : '当前链接'} />
                  </Stack>
                </Stack>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 0.75 }}>
                  {entry.items.map((item, index) => (
                    <HistoryImageTile
                      key={`${entry.id}-${item.sourceIndex}-${item.assetId || item.taskId || index}`}
                      item={item}
                      shopId={entry.shopId || history.shopId}
                      label={`${entry.groupLabel}历史图 ${index + 1}`}
                      assetPreview={assetPreviews[item.assetId] || {}}
                      eager={entryIndex === 0}
                    />
                  ))}
                </Box>
              </Box>
              );
            })}
          </Stack>
        ) : (
          <Box sx={{ minHeight: 250, display: 'grid', placeContent: 'center', justifyItems: 'center', color: 'text.secondary', textAlign: 'center' }}>
            <HistoryRounded sx={{ fontSize: 42, color: '#8295c9', mb: 0.75 }} />
            <Typography variant="subtitle1" fontWeight={800}>这个链接还没有生成记录</Typography>
            <Typography variant="body2">生成成功后会立即显示图片数量和历史结果。</Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}

import AddPhotoAlternateRounded from '@mui/icons-material/AddPhotoAlternateRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import BoltRounded from '@mui/icons-material/BoltRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import ImageOutlined from '@mui/icons-material/ImageOutlined';
import RuleRounded from '@mui/icons-material/RuleRounded';
import StarRounded from '@mui/icons-material/StarRounded';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

import { LazyHoverImagePreview } from '../../../shared/ui/ImagePreview.jsx';
import { isCollectionProductOriginalImageSelected } from '../lib/collectionProductGeneratedImageApplication.js';
import { isCollectionProductGeneratedImageSelected } from '../lib/collectionProductImageHistory.js';
import { getCollectionProductImageUrls } from '../lib/collectionProductImageUrl.js';
import { CollectionProductImageHistoryDialog } from './CollectionProductImageHistoryDialog.jsx';
import { CollectionProductDeferredImage } from './CollectionProductDeferredImage.jsx';
import { CollectionProductImageSkillRulesPanel } from './CollectionProductImageSkillRulesPanel.jsx';
import {
  SMART_TOOL_IMAGE_GENERATION_MODE_FAST,
  SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD,
} from '../../promptLibrary/services/smartToolImageGenerationMode.js';

const GROUPS = Object.freeze([
  { id: 'main', label: '主图' },
  { id: 'sku', label: 'SKU 图' },
  { id: 'detail', label: '详情图' },
]);
const DEFAULT_GENERATION_SELECTION_COUNT = 5;
const MIN_GENERATION_SLOT_COUNT = 10;
const GENERATED_IMAGE_PREVIEW_HEIGHT = 112;
const SOURCE_IMAGE_VISIBLE_COLUMN_COUNT = 7;
const PENDING_GENERATION_VISIBLE_COLUMN_COUNT = 5;
const PENDING_GENERATION_ROW_HEIGHT = 150;

function paginateImageGrid(items = [], visibleColumns, visibleRows = 2) {
  const pageSize = Math.max(1, visibleColumns * visibleRows);
  return Array.from({ length: Math.max(1, Math.ceil(items.length / pageSize)) }, (_item, pageIndex) => (
    items.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
      .map((value, offset) => ({ value, index: pageIndex * pageSize + offset }))
  ));
}

function EditableImageTile({
  row,
  group,
  index,
  selected,
  originalSelected,
  onToggle,
  onToggleOriginal,
  onRemove,
  onPromote,
}) {
  const sources = React.useMemo(() => getCollectionProductImageUrls(row.imageUrl), [row.imageUrl]);
  const [sourceIndex, setSourceIndex] = React.useState(0);
  React.useEffect(() => setSourceIndex(0), [row.imageUrl]);
  const source = sources[sourceIndex] || '';
  return (
    <LazyHoverImagePreview
      className="collection-product-image-hover"
      previewClassName="prompt-library-image-hover-preview"
      imageUrl={source}
      alt={row.label}
      delay={120}
    >
      <Box
        sx={{
          height: 166,
          border: '1px solid',
          borderColor: selected ? '#8da2c0' : '#dde2e9',
          borderRadius: 0.75,
          overflow: 'hidden',
          bgcolor: '#fff',
          minWidth: 0,
          boxShadow: selected ? 'inset 0 0 0 1px rgba(92, 112, 142, 0.14)' : 'none',
        }}
      >
        <Box sx={{ position: 'relative', height: 132, display: 'grid', placeItems: 'center', bgcolor: '#f7f8fa' }}>
          {source ? (
            <CollectionProductDeferredImage
              src={source} alt={row.label}
              priority={index < 4}
              onError={() => setSourceIndex((current) => current + 1)}
            />
          ) : <ImageOutlined sx={{ color: '#98a2b3' }} />}
          <Chip
            size="small"
            label={group === 'main' && index === 0 ? '主图' : `${index + 1}`}
            color={group === 'main' && index === 0 ? 'primary' : 'default'}
            sx={{ position: 'absolute', top: 5, left: 5, height: 21, fontSize: 11 }}
          />
          <Checkbox
            size="small"
            checked={Boolean(selected)}
            onChange={(event) => onToggle(index, event.target.checked)}
            inputProps={{ 'aria-label': `选择待生成图片：${row.label}` }}
            sx={{
              position: 'absolute', top: 4, right: 4, width: 24, height: 24, p: 0.25,
              border: '1px solid #d5dae3', borderRadius: 0.6, bgcolor: 'rgba(255,255,255,.94)',
              '& .MuiSvgIcon-root': { fontSize: 18 },
            }}
          />
        </Box>
        <Stack direction="row" alignItems="center" spacing={0.25} sx={{ height: 34, px: 0.55 }}>
          <Checkbox
            size="small"
            checked={Boolean(originalSelected)}
            onChange={(event) => onToggleOriginal?.({
              group,
              sourceIndex: index,
              sourceImageUrl: row.imageUrl,
              sourceSkuId: row.skuId,
              selected: event.target.checked,
            })}
            inputProps={{ 'aria-label': `上传原图：${row.label}` }}
            sx={{
              width: 22, height: 22, p: 0.15, flex: '0 0 22px',
              '& .MuiSvgIcon-root': { fontSize: 17 },
            }}
          />
          <Typography variant="caption" color={originalSelected ? 'primary.main' : 'text.secondary'} noWrap title={row.label} sx={{ minWidth: 0, flex: 1 }}>
            {originalSelected ? '已选' : '上传'}
          </Typography>
          {group === 'main' && index > 0 ? (
            <IconButton size="small" aria-label={`设为主图：${row.label}`} onClick={() => onPromote(index)}>
              <StarRounded sx={{ fontSize: 17 }} />
            </IconButton>
          ) : null}
          <IconButton size="small" aria-label={`删除图片：${row.label}`} onClick={() => onRemove(index)}>
            <DeleteOutlineRounded sx={{ fontSize: 17 }} />
          </IconButton>
        </Stack>
      </Box>
    </LazyHoverImagePreview>
  );
}

function PendingGenerationStrip({
  rows = [],
  selectedIndexes = [],
  generatedItems = [],
  generatedImageSelections = {},
  group = 'main',
  generationBusy = false,
  onToggleUpload,
  onRegenerate,
  onRemove,
}) {
  const generatedSourceIndexes = (Array.isArray(generatedItems) ? generatedItems : [])
    .map((item) => Number(item?.sourceIndex))
    .filter((sourceIndex) => Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < rows.length);
  // Source-image selection only controls the next generation request. Existing
  // generated images are an independent upload selection and must remain
  // visible until their own delete action is used.
  const visibleSourceIndexes = [...new Set([...selectedIndexes, ...generatedSourceIndexes])]
    .sort((left, right) => left - right);
  const selectedRows = visibleSourceIndexes
    .map((sourceIndex) => ({ sourceIndex, row: rows[sourceIndex] }))
    .filter((item) => item.row);
  const slots = Array.from({ length: Math.max(MIN_GENERATION_SLOT_COUNT, selectedRows.length) }, (_, index) => selectedRows[index] || null);
  const generatedBySourceIndex = React.useMemo(
    () => new Map((Array.isArray(generatedItems) ? generatedItems : [])
      .map((item) => [Number(item?.sourceIndex), item])),
    [generatedItems],
  );
  const pages = paginateImageGrid(slots, PENDING_GENERATION_VISIBLE_COLUMN_COUNT);
  return (
    <Box
      data-testid="pending-generation-grid"
      data-layout-rows="2"
      data-visible-columns={PENDING_GENERATION_VISIBLE_COLUMN_COUNT}
      data-column-count={PENDING_GENERATION_VISIBLE_COLUMN_COUNT}
      data-page-count={pages.length}
      data-row-height={PENDING_GENERATION_ROW_HEIGHT}
      sx={{
        display: 'grid',
        gridAutoFlow: 'column',
        gridAutoColumns: '100%',
        gap: 1,
        minWidth: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        pb: 0.65,
        scrollbarWidth: 'thin',
        scrollbarColor: '#c9cfd8 transparent',
        scrollSnapType: 'x proximity',
      }}
    >
      {pages.map((page, pageIndex) => (
        <Box
          key={`pending-page-${pageIndex}`}
          data-testid={`pending-generation-page-${pageIndex + 1}`}
          sx={{
            display: 'grid',
            gridTemplateRows: `repeat(2, ${PENDING_GENERATION_ROW_HEIGHT}px)`,
            gridTemplateColumns: `repeat(${PENDING_GENERATION_VISIBLE_COLUMN_COUNT}, minmax(0, 1fr))`,
            gap: 1,
            minWidth: 0,
            scrollSnapAlign: 'start',
          }}
        >
      {page.map(({ value: slot, index }) => {
        const row = slot?.row;
        const sourceIndex = slot?.sourceIndex;
        const generated = Number.isInteger(sourceIndex) ? generatedBySourceIndex.get(sourceIndex) : null;
        const generatedThumbnailUrl = generated?.thumbnailUrl || generated?.previewUrl || generated?.imageUrl || '';
        const generatedFullUrl = generated?.previewUrl || generated?.imageUrl || generatedThumbnailUrl;
        const uploadSelected = Boolean(generated && isCollectionProductGeneratedImageSelected(
          generatedImageSelections,
          { group, sourceIndex, ...generated },
        ));
        return (
        <Box
          key={row ? `${row.imageUrl}-${sourceIndex}` : `pending-${index}`}
          sx={{
            height: PENDING_GENERATION_ROW_HEIGHT,
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            display: 'grid',
            gridTemplateRows: `${GENERATED_IMAGE_PREVIEW_HEIGHT}px 36px`,
            border: '1px solid',
            borderColor: uploadSelected ? '#5b86ff' : '#cfd5de',
            borderRadius: 0.75,
            bgcolor: row ? '#fafbfc' : '#fff',
            color: '#7b8798',
            boxShadow: uploadSelected ? 'inset 0 0 0 1px rgba(91, 134, 255, .16)' : 'none',
          }}
        >
          {generated?.status === 'success' && generatedFullUrl ? (
            <Box
              data-testid={`generated-image-viewport-${group}-${sourceIndex}`}
              data-preview-height={GENERATED_IMAGE_PREVIEW_HEIGHT}
              sx={{
                position: 'relative',
                width: '100%',
                height: GENERATED_IMAGE_PREVIEW_HEIGHT,
                minWidth: 0,
                minHeight: 0,
                overflow: 'hidden',
                display: 'grid',
                placeItems: 'center',
                '& > .collection-product-generated-image-hover': {
                  width: '100%',
                  height: '100%',
                  minWidth: 0,
                  minHeight: 0,
                  overflow: 'hidden',
                },
              }}
            >
              <LazyHoverImagePreview
                className="collection-product-generated-image-hover"
                previewClassName="prompt-library-image-hover-preview collection-product-generated-image-preview"
                imageUrl={generatedFullUrl}
                alt={`生成图 ${index + 1}`}
                delay={120}
              >
                <CollectionProductDeferredImage
                  src={generatedThumbnailUrl}
                  alt={`生成图 ${index + 1}`}
                  priority={index < DEFAULT_GENERATION_SELECTION_COUNT}
                  onError={(event) => {
                    if (generatedThumbnailUrl === generatedFullUrl || event.currentTarget.dataset.fallback === 'full') return;
                    event.currentTarget.dataset.fallback = 'full';
                    event.currentTarget.src = generatedFullUrl;
                  }}
                  sx={{ height: GENERATED_IMAGE_PREVIEW_HEIGHT }}
                />
              </LazyHoverImagePreview>
            </Box>
          ) : (
            <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 0 }}>
              <ImageOutlined sx={{ fontSize: 24, color: '#98a2b3' }} />
            </Box>
          )}
          {generated?.status === 'success' ? (
            <Stack direction="row" alignItems="center" spacing={0.25} sx={{ height: 36, px: 0.45, minWidth: 0 }}>
              <Checkbox
                size="small"
                checked={uploadSelected}
                onChange={(event) => onToggleUpload?.({
                  group,
                  sourceIndex,
                  ...generated,
                  selected: event.target.checked,
                })}
                inputProps={{ 'aria-label': `上传生成图：${row?.label || `第 ${index + 1} 个位置`}` }}
                sx={{ width: 23, height: 23, p: 0.15, flex: '0 0 23px', '& .MuiSvgIcon-root': { fontSize: 18 } }}
              />
              <Typography
                variant="caption"
                color={uploadSelected ? 'primary.main' : 'text.secondary'}
                noWrap
                sx={{ minWidth: 0, flex: 1, fontWeight: uploadSelected ? 750 : 500 }}
              >{uploadSelected ? '确认上传' : '选择上传'}</Typography>
              <Button
                size="small"
                disabled={generationBusy}
                aria-label={`重新生成图片：${row?.label || `第 ${index + 1} 个位置`}`}
                title="重新生成此图"
                onClick={() => onRegenerate?.(sourceIndex)}
                sx={{ minWidth: 58, height: 27, px: 0.35, fontSize: 11.5 }}
              >
                重新生成
              </Button>
              <IconButton
                size="small"
                color="error"
                aria-label={`删除生成图片：${row?.label || `第 ${index + 1} 个位置`}`}
                title="删除生成图（保留历史，可重新应用）"
                onClick={() => onRemove?.({ group, sourceIndex, ...generated })}
                sx={{ width: 26, height: 26 }}
              >
                <DeleteOutlineRounded sx={{ fontSize: 17 }} />
              </IconButton>
            </Stack>
          ) : (
            <Stack direction="row" alignItems="center" spacing={0.25} sx={{ height: 36, px: 0.45, minWidth: 0 }}>
              <Typography
                variant="caption"
                color={generated?.status === 'error' ? 'error.main' : 'text.secondary'}
                textAlign="center"
                noWrap
                sx={{ minWidth: 0, flex: 1 }}
              >
                {generated?.status === 'error'
                  ? `生成失败 ${index + 1}`
                  : generated?.status === 'planning'
                    ? `方案分析 ${index + 1}`
                    : generated?.status === 'loading'
                      ? `生图中 ${index + 1}`
                      : row ? `待生成 ${index + 1}` : `待选择 ${index + 1}`}
              </Typography>
              {row ? (
                <Button
                  size="small"
                  disabled={generationBusy || generated?.status === 'planning' || generated?.status === 'loading'}
                  aria-label={`重新生成图片：${row.label || `第 ${index + 1} 个位置`}`}
                  title="重新生成此图"
                  onClick={() => onRegenerate?.(sourceIndex)}
                  sx={{ minWidth: 58, height: 27, px: 0.35, fontSize: 11.5 }}
                >
                  重新生成
                </Button>
              ) : null}
            </Stack>
          )}
        </Box>
        );
      })}
        </Box>
      ))}
    </Box>
  );
}

export function CollectionProductImageWorkspace({
  draft,
  onChangeImages,
  generationState,
  onGenerate,
  onRestoreHistory,
  imageSkillState,
  imageHistory,
  originalImageSelections = {},
  generatedImageSelections = {},
  onToggleOriginalImage,
  onToggleGeneratedImage,
  onRemoveGeneratedImage,
}) {
  const [group, setGroup] = React.useState('main');
  const [newImageUrl, setNewImageUrl] = React.useState('');
  const [selectedByGroup, setSelectedByGroup] = React.useState({});
  const [rulesOpen, setRulesOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const rows = React.useMemo(() => {
    if (group === 'sku') {
      return draft.skuImages.map((item, index) => ({
        imageUrl: item.imageUrl,
        skuId: item.skuId,
        label: item.skuName || item.skuId || `SKU 图 ${index + 1}`,
      }));
    }
    const values = group === 'detail' ? draft.detailImages : draft.mainImages;
    return values.map((imageUrl, index) => ({ imageUrl, skuId: '', label: `${group === 'detail' ? '详情图' : '主图'} ${index + 1}` }));
  }, [draft.detailImages, draft.mainImages, draft.skuImages, group]);
  const selectedIndexes = selectedByGroup[group] || [];
  const generatedItems = generationState?.itemsByGroup?.[group] || [];
  const generatedUploadCount = generatedItems.filter((item) => (
    item?.status === 'success'
    && isCollectionProductGeneratedImageSelected(generatedImageSelections, { group, ...item })
  )).length;
  const originalUploadCount = rows.filter((row, index) => isCollectionProductOriginalImageSelected(
    originalImageSelections,
    { group, sourceIndex: index, sourceImageUrl: row.imageUrl, sourceSkuId: row.skuId },
  )).length;
  const uploadSelectionCount = generatedUploadCount + originalUploadCount;
  const sourcePages = React.useMemo(
    () => paginateImageGrid(rows, SOURCE_IMAGE_VISIBLE_COLUMN_COUNT),
    [rows],
  );

  React.useEffect(() => {
    setSelectedByGroup((current) => {
      if (Object.prototype.hasOwnProperty.call(current, group)) {
        const valid = current[group].filter((index) => index >= 0 && index < rows.length);
        return valid.length === current[group].length ? current : { ...current, [group]: valid };
      }
      return {
        ...current,
        [group]: Array.from({ length: Math.min(rows.length, DEFAULT_GENERATION_SELECTION_COUNT) }, (_item, index) => index),
      };
    });
  }, [group, rows.length]);

  React.useEffect(() => {
    const restoredSelections = Object.fromEntries(Object.entries(generationState?.itemsByGroup || {}).flatMap(([targetGroup, items]) => {
      const indexes = [...new Set((Array.isArray(items) ? items : [])
        .map((item) => Number(item?.sourceIndex))
        .filter((index) => Number.isInteger(index) && index >= 0))];
      return indexes.length ? [[targetGroup, indexes]] : [];
    }));
    if (!Object.keys(restoredSelections).length) return;
    setSelectedByGroup((current) => ({ ...current, ...restoredSelections }));
  }, [generationState?.itemsByGroup]);

  const toggleGenerationImage = (index, checked) => {
    setSelectedByGroup((current) => {
      const selected = current[group] || [];
      const next = checked
        ? selected.includes(index) ? selected : [...selected, index]
        : selected.filter((item) => item !== index);
      return next === selected ? current : { ...current, [group]: next };
    });
  };

  const selectAllGenerationImages = () => {
    setSelectedByGroup((current) => ({
      ...current,
      [group]: Array.from({ length: rows.length }, (_item, index) => index),
    }));
  };

  const clearGenerationImages = () => {
    setSelectedByGroup((current) => ({ ...current, [group]: [] }));
  };

  const restoreHistoryEntry = async (entry = {}) => {
    const targetGroup = ['main', 'sku', 'detail'].includes(entry.group) ? entry.group : 'main';
    const targetRowCount = targetGroup === 'sku'
      ? draft.skuImages.length
      : targetGroup === 'detail' ? draft.detailImages.length : draft.mainImages.length;
    const items = (Array.isArray(entry.items) ? entry.items : [])
      .filter((item) => Number.isInteger(item.sourceIndex) && item.sourceIndex >= 0 && item.sourceIndex < targetRowCount)
      .sort((left, right) => left.sourceIndex - right.sourceIndex);
    if (!items.length) return { ok: false, error: '历史图片与当前来源图片位置不匹配。' };
    const result = await onRestoreHistory?.({ ...entry, group: targetGroup, items });
    if (result?.ok === false) return result;
    setSelectedByGroup((current) => ({ ...current, [targetGroup]: items.map((item) => item.sourceIndex) }));
    setGroup(targetGroup);
    return { ok: true, group: targetGroup, count: items.length };
  };

  const remove = (index) => {
    if (group === 'sku') {
      const removed = draft.skuImages[index];
      const nextRows = draft.skuImages.filter((_, rowIndex) => rowIndex !== index);
      const nextSkus = draft.skus.map((sku) => sku.id === removed?.skuId ? { ...sku, imageUrl: '' } : sku);
      onChangeImages({ skuImages: nextRows, skus: nextSkus });
      return;
    }
    const field = group === 'detail' ? 'detailImages' : 'mainImages';
    onChangeImages({ [field]: draft[field].filter((_, rowIndex) => rowIndex !== index) });
  };

  const add = () => {
    const url = newImageUrl.trim();
    if (!/^https?:\/\//iu.test(url)) return;
    const field = group === 'detail' ? 'detailImages' : 'mainImages';
    if (group === 'sku') return;
    onChangeImages({ [field]: [...new Set([...draft[field], url])] });
    setNewImageUrl('');
  };

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Box sx={{ px: 1.75, pt: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5}>
          <Box>
            <Typography variant="subtitle1" fontWeight={850}>图片工作区</Typography>
            <Typography variant="caption" color="text.secondary">主图、SKU 图和详情图分组显示，不使用拖拽。</Typography>
          </Box>
          {group !== 'sku' ? (
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ width: 430, maxWidth: '46%' }}>
              <TextField
                size="small" fullWidth placeholder="粘贴新的 HTTPS 图片地址"
                value={newImageUrl} onChange={(event) => setNewImageUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') add(); }}
                sx={{ '& .MuiInputBase-root': { height: 36, borderRadius: 0.75 } }}
              />
              <IconButton
                aria-label="添加图片"
                title="添加图片"
                onClick={add}
                disabled={!/^https?:\/\//iu.test(newImageUrl.trim())}
                sx={{ width: 36, height: 36, flex: '0 0 36px', border: '1px solid', borderColor: 'divider', borderRadius: 0.75 }}
              >
                <AddPhotoAlternateRounded sx={{ fontSize: 19 }} />
              </IconButton>
            </Stack>
          ) : null}
        </Stack>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Tabs value={group} onChange={(_event, value) => setGroup(value)} sx={{ minHeight: 38, mt: 0.5 }}>
            {GROUPS.map((item) => (
              <Tab
                key={item.id} value={item.id} sx={{ minHeight: 38, py: 0.5 }}
                label={`${item.label} ${item.id === 'main' ? draft.mainImages.length : item.id === 'sku' ? draft.skuImages.length : draft.detailImages.length}`}
              />
            ))}
          </Tabs>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<HistoryRounded />}
              aria-label={`生成历史，共 ${Number(imageHistory?.imageCount || 0)} 张`}
              onClick={() => setHistoryOpen(true)}
              sx={{ borderRadius: 0.65, minWidth: 118, flex: '0 0 auto' }}
            >生成历史 {Number(imageHistory?.imageCount || 0)}</Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<RuleRounded />}
              onClick={() => setRulesOpen(true)}
              sx={{ borderRadius: 0.65, flex: '0 0 auto' }}
            >Skill 规则</Button>
          </Stack>
        </Stack>
      </Box>
      <Box sx={{ p: 1.5, minHeight: 0, overflowY: 'auto', flex: 1 }}>
        {rows.length ? (
          <Stack spacing={1.5}>
            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.75 }}>
                <Typography variant="subtitle2" fontWeight={750}>来源图片</Typography>
                <Stack direction="row" spacing={0.25} alignItems="center">
                  <Button
                    size="small" variant="text" disabled={!rows.length || selectedIndexes.length === rows.length}
                    onClick={selectAllGenerationImages}
                    sx={{ minWidth: 0, px: 0.7, py: 0.25, borderRadius: 0.5, fontSize: 12 }}
                  >全选</Button>
                  <Button
                    size="small" variant="text" color="inherit" disabled={!selectedIndexes.length}
                    onClick={clearGenerationImages}
                    sx={{ minWidth: 0, px: 0.7, py: 0.25, borderRadius: 0.5, fontSize: 12, color: 'text.secondary' }}
                  >取消全选</Button>
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                    生图参考 {selectedIndexes.length} / {rows.length}
                  </Typography>
                </Stack>
              </Stack>
              <Box
                data-testid="source-image-grid"
                data-layout-rows="2"
                data-visible-columns={SOURCE_IMAGE_VISIBLE_COLUMN_COUNT}
                data-column-count={SOURCE_IMAGE_VISIBLE_COLUMN_COUNT}
                data-page-count={sourcePages.length}
                sx={{
                  display: 'grid', gridAutoFlow: 'column', gridAutoColumns: '100%', gap: 1,
                  minWidth: 0, overflowX: 'auto', overflowY: 'hidden', pb: 0.65,
                  scrollbarWidth: 'thin', scrollbarColor: '#c9cfd8 transparent',
                  scrollSnapType: 'x proximity',
                }}
              >
                {sourcePages.map((page, pageIndex) => (
                  <Box
                    key={`source-page-${pageIndex}`}
                    data-testid={`source-image-page-${pageIndex + 1}`}
                    sx={{
                      display: 'grid',
                      gridTemplateRows: 'repeat(2, 166px)',
                      gridTemplateColumns: `repeat(${SOURCE_IMAGE_VISIBLE_COLUMN_COUNT}, minmax(0, 1fr))`,
                      gap: 1,
                      minWidth: 0,
                      scrollSnapAlign: 'start',
                    }}
                  >
                    {page.map(({ value: row, index }) => (
                      <EditableImageTile
                        key={`${row.imageUrl}-${index}`} row={row} group={group} index={index}
                        selected={selectedIndexes.includes(index)}
                        originalSelected={isCollectionProductOriginalImageSelected(originalImageSelections, {
                          group, sourceIndex: index, sourceImageUrl: row.imageUrl, sourceSkuId: row.skuId,
                        })}
                        onToggle={toggleGenerationImage}
                        onToggleOriginal={onToggleOriginalImage}
                        onRemove={remove}
                        onPromote={(selectedIndex) => {
                          const imageUrl = draft.mainImages[selectedIndex];
                          onChangeImages({ mainImages: [imageUrl, ...draft.mainImages.filter((_, rowIndex) => rowIndex !== selectedIndex)] });
                        }}
                      />
                    ))}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.75 }}>
                <Box>
                  <Typography variant="subtitle2" fontWeight={750}>生成结果与上传</Typography>
                  {generationState?.message ? (
                    <Typography variant="caption" color="text.secondary">{generationState.message}</Typography>
                  ) : null}
                </Box>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Typography
                    variant="caption"
                    color={uploadSelectionCount ? 'primary.main' : 'text.secondary'}
                    fontWeight={uploadSelectionCount ? 750 : 500}
                    aria-label={`当前分组已选择上传 ${uploadSelectionCount} 张`}
                  >上传清单已选 {uploadSelectionCount} 张</Typography>
                  <Button
                    size="small" variant="contained" startIcon={<AutoAwesomeRounded />}
                    disabled={!selectedIndexes.length || generationState?.status === 'running'}
                    onClick={() => onGenerate?.({
                      group,
                      rows,
                      selectedIndexes,
                      generationMode: SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD,
                    })}
                    sx={{ borderRadius: 0.6 }}
                  >{generationState?.status === 'running' ? '生成中…' : `生成 ${selectedIndexes.length} 张`}</Button>
                  <Button
                    size="small" variant="outlined" startIcon={<BoltRounded />}
                    disabled={!selectedIndexes.length || generationState?.status === 'running'}
                    onClick={() => onGenerate?.({
                      group,
                      rows,
                      selectedIndexes,
                      generationMode: SMART_TOOL_IMAGE_GENERATION_MODE_FAST,
                    })}
                    sx={{ borderRadius: 0.6 }}
                  >{generationState?.status === 'running' ? '生成中…' : `极速生成 ${selectedIndexes.length} 张`}</Button>
                </Stack>
              </Stack>
              {generationState?.error ? <Alert severity={generationState.status === 'partial' ? 'warning' : 'error'} sx={{ mb: 1 }}>{generationState.error}</Alert> : null}
              <PendingGenerationStrip
                rows={rows}
                selectedIndexes={selectedIndexes}
                generatedItems={generatedItems}
                generatedImageSelections={generatedImageSelections}
                group={group}
                generationBusy={generationState?.status === 'running'}
                onToggleUpload={onToggleGeneratedImage}
                onRegenerate={(sourceIndex) => onGenerate?.({
                  group,
                  rows,
                  selectedIndexes: [sourceIndex],
                  generationMode: SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD,
                })}
                onRemove={onRemoveGeneratedImage}
              />
            </Box>
          </Stack>
        ) : (
          <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', color: 'text.secondary' }}>
            <Stack alignItems="center" spacing={0.5}><ImageOutlined /><Typography variant="body2">当前分组没有图片</Typography></Stack>
          </Box>
        )}
      </Box>
      <CollectionProductImageSkillRulesPanel
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        skill={imageSkillState?.skill}
        status={imageSkillState?.status}
        error={imageSkillState?.error}
        onSaveSkill={imageSkillState?.save}
      />
      <CollectionProductImageHistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestore={restoreHistoryEntry}
        history={imageHistory}
      />
    </Stack>
  );
}

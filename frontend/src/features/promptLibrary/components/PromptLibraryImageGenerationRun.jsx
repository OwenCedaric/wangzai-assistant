import AutoFixHighRounded from '@mui/icons-material/AutoFixHighRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import DescriptionRounded from '@mui/icons-material/DescriptionRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import ImageOutlined from '@mui/icons-material/ImageOutlined';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import BoltRounded from '@mui/icons-material/BoltRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { LazyHoverImagePreview } from '../../../shared/ui/ImagePreview.jsx';
import {
  readStoredProductImagePreview,
  SMART_TOOL_DEFAULT_IMAGE_QUALITY,
  SMART_TOOL_DEFAULT_IMAGE_SIZE,
  SMART_TOOL_IMAGE_QUALITY_OPTIONS,
  SMART_TOOL_IMAGE_SIZE_OPTIONS,
} from '../services/smartToolImageGenerationService.js';
import {
  SMART_TOOL_IMAGE_GENERATION_MODE_FAST,
  SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD,
} from '../services/smartToolImageGenerationMode.js';
import { copySmartToolImage, downloadSmartToolImage } from '../../../services/smartToolImageAssetActions.js';
import { filterSmartToolImageHistory } from '../services/smartToolImageHistoryService.js';
import { resolveSmartToolModelSelection } from '../services/smartToolModelService.js';
import {
  readSmartToolProductDescriptionContext,
  resolveConfiguredTextModel,
} from '../services/smartToolProductDescriptionService.js';
import { getSmartToolUsageInputPlaceholder, getSmartToolUsageInputSpec } from '../lib/smartToolUsage.js';
import { normalizeOzonShopOption } from '../../../shared/ozon/ozonShopOption.js';
import {
  createSmartToolImageExecutionContext,
  createSmartToolImageSlotDefinitions,
  isSmartToolProductImageWorkbench,
  SMART_TOOL_WORKBENCH_KIND,
  SMART_TOOL_WORKBENCH_MODULE,
} from '../lib/smartToolWorkbenchRegistry.js';
import { isUserInstalledSmartTool } from '../lib/smartToolInstalledSkill.js';

const PRODUCT_REFERENCE_LABEL = '商品图片或商品 SKU';
const SKU_FACTS_LABEL = 'SKU 信息';
const TARGET_SCENE_LABEL = '目标场景（可选）';
const EMPTY_IMAGE_SLOT_COUNT = 5;
const NATIVE_IMAGE_SLOT_COUNT = 8;

function buildImageGenerationOptions(discoveredOptions, fallbackOptions) {
  const discovered = Array.isArray(discoveredOptions) ? discoveredOptions : [];
  if (!discovered.length) return fallbackOptions;
  const fallbackLabels = new Map(fallbackOptions.map((item) => [item.id, item.label]));
  return discovered
    .map((item) => {
      const id = String(typeof item === 'string' ? item : item?.id || item?.value || '').trim();
      if (!id) return null;
      return {
        id,
        label: fallbackLabels.get(id) || String(typeof item === 'string' ? item : item?.label || id).trim() || id,
      };
    })
    .filter(Boolean);
}

function ProductSearchResult({ product, selected, onSelect }) {
  return (
    <Button
      type="button"
      variant="text"
      className={`prompt-library-image-product-option${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(product)}
    >
      <Box className="prompt-library-image-product-thumb">
        {product.image ? <img src={product.image} alt="" loading="lazy" decoding="async" /> : <Inventory2Rounded />}
      </Box>
      <Box className="prompt-library-image-product-copy">
        <Typography variant="subtitle2" noWrap>
          {product.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {product.offerId
            ? `货号 ${product.offerId}`
            : product.productId
              ? `商品 ID ${product.productId}`
              : '本地商品'}
          {product.skuOptions?.[0]?.sku ? ` · SKU ${product.skuOptions[0].sku}` : ''}
        </Typography>
      </Box>
      {selected ? <CheckCircleRounded className="prompt-library-image-product-check" /> : null}
    </Button>
  );
}

function isRenderableImageUrl(value) {
  const normalized = String(value || '').trim();
  return Boolean(normalized && /^(?:https?:|data:image\/|\/)/iu.test(normalized));
}

function uniqueRenderableImages(...groups) {
  return [...new Set(groups.flatMap((group) => (Array.isArray(group) ? group : [group])).filter(isRenderableImageUrl))];
}

function HoverImageTile({ imageUrl, label, emptyLabel = '暂无图片', generated = false, selected, onToggle }) {
  const [displayUrl, setDisplayUrl] = React.useState(imageUrl);
  const [menuPosition, setMenuPosition] = React.useState(null);

  React.useEffect(() => {
    setDisplayUrl(imageUrl);
  }, [imageUrl]);

  const handleImageError = React.useCallback(async () => {
    if (!displayUrl || displayUrl.startsWith('data:')) {
      setDisplayUrl('');
      return;
    }
    const fallback = await readStoredProductImagePreview(displayUrl);
    setDisplayUrl(fallback || '');
  }, [displayUrl]);

  const handleContextMenu = (event) => {
    event.preventDefault();
    setMenuPosition({ top: event.clientY, left: event.clientX });
  };

  const closeContextMenu = () => setMenuPosition(null);

  const runAssetAction = async (action) => {
    closeContextMenu();
    try {
      await action(displayUrl);
    } catch {
      // The context menu is intentionally best-effort for remote images. A
      // failed copy/download must not break the preview workspace.
    }
  };

  if (!isRenderableImageUrl(displayUrl)) {
    return (
      <Box className="prompt-library-image-comparison-tile is-empty">
        <ImageOutlined />
        <Typography variant="caption">{emptyLabel}</Typography>
      </Box>
    );
  }
  return (
    <LazyHoverImagePreview
      className="prompt-library-image-thumb-hover"
      previewClassName="prompt-library-image-hover-preview"
      imageUrl={displayUrl}
      alt={label}
      delay={120}
    >
      <Box
        className={`prompt-library-image-comparison-tile${generated ? ' is-generated' : ' is-source'}${selected ? ' is-selected' : ''}`}
        onContextMenu={handleContextMenu}
      >
        {typeof onToggle === 'function' ? (
          <Checkbox
            className="prompt-library-image-source-checkbox"
            size="small"
            checked={Boolean(selected)}
            onChange={(event) => onToggle(event.target.checked)}
            inputProps={{ 'aria-label': `${selected ? '取消选择' : '选择'}${label}` }}
          />
        ) : null}
        <img src={displayUrl} alt={label} loading="lazy" referrerPolicy="no-referrer" onError={handleImageError} />
        <Typography variant="caption">{label}</Typography>
      </Box>
      <Menu
        open={Boolean(menuPosition)}
        onClose={closeContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={menuPosition || { top: 0, left: 0 }}
      >
        <MenuItem onClick={() => runAssetAction(copySmartToolImage)}>
          <ContentCopyRounded fontSize="small" sx={{ mr: 1 }} />
          复制图片
        </MenuItem>
        <MenuItem onClick={() => runAssetAction((value) => downloadSmartToolImage(value, `${label}.png`))}>
          <DownloadRounded fontSize="small" sx={{ mr: 1 }} />
          下载图片
        </MenuItem>
      </Menu>
    </LazyHoverImagePreview>
  );
}

const IMAGE_PROGRESS_STAGE = {
  planning: 18,
  preparing: 36,
  loading: 48,
};

function useEstimatedImageProgress(status) {
  const [progress, setProgress] = React.useState(() => IMAGE_PROGRESS_STAGE[status] || 0);

  React.useEffect(() => {
    const stageProgress = IMAGE_PROGRESS_STAGE[status] || 0;
    if (!stageProgress) {
      setProgress(0);
      return undefined;
    }
    setProgress((current) => (status === 'planning' ? stageProgress : Math.max(current, stageProgress)));
    if (status !== 'loading') return undefined;
    const timer = window.setInterval(() => {
      setProgress((current) => Math.min(92, current + (current < 72 ? 2 : 1)));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [status]);

  return progress;
}

/**
 * Normalize an optional retry target without treating an explicit target as
 * "use all selected images". Retry callers may pass either one source index
 * or an array of indexes; the normal generate button passes no target.
 */
function normalizeRetrySourceIndexes(value) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map((item) => (typeof item === 'number' ? item : Number(item)))
          .filter((item) => Number.isInteger(item) && item >= 0)
      ),
    ];
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return [value];
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return [Number(value)];
  return null;
}

function GeneratedImageTile({ item, index, onRetry, groupLabel, slotLabel, selected, onToggle }) {
  const imageUrl = item?.imageUrl || item?.result?.imageUrl || '';
  const progress = useEstimatedImageProgress(item?.status);
  if (item?.status === 'success' && isRenderableImageUrl(imageUrl)) {
    return (
      <HoverImageTile
        imageUrl={imageUrl}
        label={slotLabel || `${groupLabel}生成图 ${index + 1}`}
        generated
        selected={selected}
        onToggle={onToggle}
      />
    );
  }
  if (item?.status === 'planning' || item?.status === 'preparing' || item?.status === 'loading') {
    const statusLabel =
      item.status === 'planning'
        ? '规划中（预计）'
        : item.status === 'preparing'
          ? '准备生图（预计）'
          : '生图中（预计）';
    return (
      <Box className="prompt-library-image-comparison-tile is-loading">
        <Box className="prompt-library-image-tile-progress">
          <CircularProgress variant="determinate" value={progress} size={36} thickness={4} />
          <Typography component="span">{progress}%</Typography>
        </Box>
        <Typography variant="caption">{statusLabel}</Typography>
      </Box>
    );
  }
  if (item?.status === 'error') {
    return (
      <Box className="prompt-library-image-comparison-tile is-error">
        <ImageOutlined />
        <Typography variant="caption">生成失败</Typography>
        {Number.isInteger(item?.sourceIndex) ? (
          <Button size="small" onClick={() => onRetry?.(item.sourceIndex)}>
            重试此张
          </Button>
        ) : null}
      </Box>
    );
  }
  return (
    <Box className="prompt-library-image-comparison-tile is-empty">
      <ImageOutlined />
      <Typography variant="caption">{selected ? `待生成 ${index + 1}` : '未选择'}</Typography>
    </Box>
  );
}

function SlotIntentStrip({ slots = [], selectedIndexes = [], onToggle }) {
  const selectedSet = new Set(selectedIndexes);
  return (
    <Box className="prompt-library-image-slot-intent-strip">
      {slots.map((slot) => {
        const selected = selectedSet.has(slot.sourceIndex);
        return (
          <ButtonBase
            key={slot.id}
            className={`prompt-library-image-slot-intent${selected ? ' is-selected' : ''}`}
            onClick={() => onToggle(slot.sourceIndex, !selected)}
            title={slot.instruction}
          >
            <Typography component="span" className="prompt-library-image-slot-position">
              {slot.sourceIndex + 1}
            </Typography>
            <Box minWidth={0}>
              <Typography variant="caption" fontWeight={700} noWrap>
                {slot.title}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {slot.instruction}
              </Typography>
            </Box>
          </ButtonBase>
        );
      })}
    </Box>
  );
}

function SourceImageStrip({
  images = [],
  groupLabel,
  slotDefinitions = [],
  selectedIndexes = [],
  onToggle,
  emptySlotCount = EMPTY_IMAGE_SLOT_COUNT,
}) {
  const normalizedImages = uniqueRenderableImages(images);
  const selectedSet = new Set(selectedIndexes);
  const slots = Array.from(
    { length: Math.max(emptySlotCount, normalizedImages.length) },
    (_, index) => normalizedImages[index] || ''
  );
  return (
    <Box className="prompt-library-image-comparison-strip">
      {slots.map((imageUrl, index) => (
        <HoverImageTile
          key={imageUrl || `${groupLabel}-empty-${index}`}
          imageUrl={imageUrl}
          label={slotDefinitions[index]?.title || `${groupLabel}原图 ${index + 1}`}
          emptyLabel={`${groupLabel}原图空位 ${index + 1}`}
          selected={selectedSet.has(index)}
          onToggle={imageUrl ? (checked) => onToggle(index, checked) : undefined}
        />
      ))}
    </Box>
  );
}

function GeneratedImageStrip({
  imageGeneration,
  planState,
  groupLabel,
  onRetry,
  sourceImageCount,
  pendingSourceIndexes = [],
  slotDefinitions = [],
  selectedIndexes = [],
  onToggle,
  emptySlotCount = EMPTY_IMAGE_SLOT_COUNT,
}) {
  const sourceItems = Array.isArray(imageGeneration?.result?.items) ? imageGeneration.result.items : [];
  const selectedSet = new Set(selectedIndexes);
  const pendingSet = new Set(pendingSourceIndexes);
  const slotCount = Math.max(emptySlotCount, sourceImageCount);
  const items = Array.from({ length: slotCount }, (_, sourceIndex) => {
    const settledItem = sourceItems.find((item) => item.sourceIndex === sourceIndex);
    if (!pendingSet.has(sourceIndex) || !planState) {
      return settledItem || { sourceIndex, status: 'empty' };
    }
    if (planState.status === 'planning') return { sourceIndex, status: 'planning' };
    if (planState.status === 'ready') return { sourceIndex, status: 'preparing' };
    if (planState.status === 'error') {
      return { sourceIndex, status: 'error', message: planState.message };
    }
    if (planState.status === 'generating') {
      return settledItem || { sourceIndex, status: 'loading' };
    }
    return settledItem || { sourceIndex, status: 'empty' };
  });
  return (
    <Box className="prompt-library-image-comparison-strip">
      {items.map((item, index) => (
        <GeneratedImageTile
          key={item.sourceIndex ?? index}
          item={item}
          index={index}
          groupLabel={groupLabel}
          slotLabel={slotDefinitions[item.sourceIndex]?.title}
          onRetry={(sourceIndex) => onRetry?.(sourceIndex)}
          selected={selectedSet.has(item.sourceIndex)}
          onToggle={item.status === 'success' ? (checked) => onToggle(item.sourceIndex, checked) : undefined}
        />
      ))}
    </Box>
  );
}

function ImageGroupModule({
  group,
  images,
  selectedIndexes,
  selectedGeneratedIndexes,
  slotDefinitions,
  onToggleImage,
  onToggleGenerated,
  onSetAll,
  imageGeneration,
  planState,
  canGenerateImage,
  onGenerateImage,
  onReplaceImages,
  onCancelPlan,
  emptySlotCount = EMPTY_IMAGE_SLOT_COUNT,
  showSlotIntentStrip = true,
}) {
  const isDetail = group === 'detail';
  const groupLabel = isDetail ? '详情图' : '主图';
  const successCount = imageGeneration?.result?.successCount || 0;
  const isLoading = imageGeneration?.status === 'loading';
  const isPlanning = planState?.status === 'planning';
  const isGeneratingFromPlan = planState?.status === 'generating';
  const isStartingFromPlan = planState?.status === 'ready';
  const isBusy = isLoading || isPlanning || isGeneratingFromPlan || isStartingFromPlan;
  const selectedCount = selectedIndexes.length;
  const selectedGeneratedCount = selectedGeneratedIndexes.length;
  // A retry plan contains only the failed source positions. Do not use the
  // full selected list while that plan is running, otherwise untouched
  // positions are rendered as if they were being regenerated too.
  const pendingSourceIndexes = Array.isArray(planState?.input?.sourceImageIndexes)
    ? planState.input.sourceImageIndexes
    : // An active plan without an input scope is unsafe to expand to all
      // selected images. Keep the frame stable and wait for its explicit scope.
      planState
      ? []
      : selectedIndexes;
  const generationSummary = imageGeneration && !isLoading ? ` · 已生成 ${successCount} 张` : '';
  const hasVisibleSlotIntents = showSlotIntentStrip && slotDefinitions.length > 0;

  return (
    <Box
      className={`prompt-library-image-group-module is-${group}${
        hasVisibleSlotIntents ? ' has-slot-intents' : ' has-no-slot-intents'
      }${images.length ? '' : ' is-source-empty'}`}
    >
      <Box className="prompt-library-image-group-head">
        <Box minWidth={0} className="prompt-library-workbench-copy">
          <Typography variant="subtitle1">{groupLabel}模块</Typography>
          <Typography variant="caption" color="text.secondary">
            已读取 {images.length} 张原图 · 已选择 {selectedCount} 张{generationSummary}
          </Typography>
        </Box>
        <Box className="prompt-library-image-group-head-actions prompt-library-workbench-actions">
          <Button
            size="small"
            variant="text"
            className="prompt-library-image-select-all-button"
            disabled={!images.length || selectedCount === images.length}
            onClick={() => onSetAll(true)}
          >
            全选
          </Button>
          <Button
            size="small"
            variant="text"
            className="prompt-library-image-clear-all-button"
            disabled={!selectedCount}
            onClick={() => onSetAll(false)}
          >
            取消全选
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<AutoFixHighRounded />}
            disabled={!canGenerateImage || !selectedCount || isBusy}
            onClick={() => onGenerateImage(null, SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD)}
          >
            {selectedCount ? `生成 ${selectedCount} 张${groupLabel}` : `请选择${groupLabel}`}
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<BoltRounded />}
            disabled={!canGenerateImage || !selectedCount || isBusy}
            onClick={() => onGenerateImage(null, SMART_TOOL_IMAGE_GENERATION_MODE_FAST)}
          >
            {selectedCount ? `极速生成 ${selectedCount} 张` : '极速生图'}
          </Button>
          <Button
            size="small"
            variant="outlined"
            color={isDetail ? 'success' : 'primary'}
            className="prompt-library-image-replace-button"
            disabled={!selectedGeneratedCount || isLoading}
            onClick={onReplaceImages}
          >
            替换选中图片{selectedGeneratedCount ? ` (${selectedGeneratedCount})` : ''}
          </Button>
        </Box>
      </Box>

      {hasVisibleSlotIntents ? (
        <Box className="prompt-library-image-comparison-row is-slot-intent-row">
          <Typography variant="overline">Skill 目标</Typography>
          <SlotIntentStrip slots={slotDefinitions} selectedIndexes={selectedIndexes} onToggle={onToggleImage} />
        </Box>
      ) : null}
      <Box className="prompt-library-image-comparison-row is-source-row">
        <Typography variant="overline">链接原图</Typography>
        <SourceImageStrip
          images={images}
          groupLabel={groupLabel}
          slotDefinitions={slotDefinitions}
          selectedIndexes={selectedIndexes}
          onToggle={onToggleImage}
          emptySlotCount={emptySlotCount}
        />
      </Box>
      <Box className="prompt-library-image-comparison-row is-generated-row">
        <Typography variant="overline">生成图片</Typography>
        <GeneratedImageStrip
          imageGeneration={imageGeneration}
          planState={planState}
          groupLabel={groupLabel}
          onRetry={(sourceIndex) => onGenerateImage(sourceIndex, SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD)}
          sourceImageCount={images.length}
          pendingSourceIndexes={pendingSourceIndexes}
          slotDefinitions={slotDefinitions}
          selectedIndexes={selectedGeneratedIndexes}
          onToggle={onToggleGenerated}
          emptySlotCount={emptySlotCount}
        />
      </Box>

      {planState?.status === 'error' ? (
        <Alert
          severity="error"
          className="prompt-library-image-plan-alert"
          action={
            <Button size="small" onClick={onCancelPlan}>
              关闭
            </Button>
          }
        >
          {groupLabel}分析失败：{planState.message}
        </Alert>
      ) : null}

      {imageGeneration?.status === 'error' || imageGeneration?.status === 'partial' ? (
        <Alert
          severity={imageGeneration.status === 'partial' ? 'warning' : 'error'}
          className="prompt-library-image-generation-alert"
        >
          {imageGeneration.message}
        </Alert>
      ) : null}
    </Box>
  );
}

function ImageGenerationHistoryDialog({ open, onClose, history = [], productKey = '', productTitle = '', sku = '' }) {
  const visibleHistory = history.filter((entry) => {
    if (!productKey && !sku) return true;
    const sameProduct = !productKey
      ? true
      : entry.productKey
        ? entry.productKey === productKey
        : !entry.productTitle || entry.productTitle === productTitle;
    const sameSku = !sku || !entry.sku || entry.sku === sku;
    return sameProduct && sameSku;
  });
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth className="prompt-library-image-history-dialog">
      <DialogTitle>生图历史</DialogTitle>
      <DialogContent dividers>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.25 }}>
          仅显示当前账号、店铺、商品和 SKU 的记录，成功图片保留 3 天。
        </Typography>
        {visibleHistory.length ? (
          <Box className="prompt-library-image-history-list">
            {visibleHistory.map((entry) => (
              <Box key={entry.id} className="prompt-library-image-history-entry">
                <Box className="prompt-library-image-history-entry-head">
                  <Box minWidth={0}>
                    <Typography variant="subtitle2">
                      {entry.groupLabel} · {entry.items.length} 张
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {[
                        entry.productTitle,
                        entry.offerId ? `货号 ${entry.offerId}` : '',
                        entry.sku ? `SKU ${entry.sku}` : '',
                        entry.plannerModel ? `分析 ${entry.plannerModel}` : '',
                        entry.model ? `生图 ${entry.model}` : '',
                        new Date(entry.createdAt).toLocaleString(),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                  </Box>
                  <Chip size="small" variant="outlined" label="本地预览" />
                </Box>
                <Box className="prompt-library-image-history-grid">
                  {entry.items.map((item, index) => (
                    <HoverImageTile
                      key={`${entry.id}-${item.sourceIndex ?? index}`}
                      imageUrl={item.imageUrl || item.previewUrl}
                      label={`${entry.groupLabel}历史图 ${index + 1}`}
                      generated
                    />
                  ))}
                </Box>
              </Box>
            ))}
          </Box>
        ) : (
          <Box className="prompt-library-image-history-empty">
            <HistoryRounded />
            <Typography variant="subtitle1">还没有生成记录</Typography>
            <Typography variant="body2" color="text.secondary">
              当前商品生成成功的图片会立即出现在这里。
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ImageGenerationReplaceDialog({
  open,
  onClose,
  groupLabel,
  items = [],
  sourceImages = [],
  busy = false,
  error = '',
  onConfirm,
}) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>确认替换{groupLabel}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          将生成图按原图位置写入 Ozon。提交后还会等待 Ozon 回读，回读成功前不会显示完成。
        </Typography>
        <Box sx={{ display: 'grid', gap: 0.75 }}>
          {items.map((item) => (
            <Box
              key={`${item.sourceIndex}-${item.index}`}
              sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, fontSize: 12 }}
            >
              <Typography variant="caption">位置 {item.sourceIndex + 1}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {sourceImages[item.sourceIndex] ? '原图' : '空位'} → 生成图
              </Typography>
            </Box>
          ))}
        </Box>
        {error ? (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={busy || !items.length}>
          {busy ? '正在提交并等待回读…' : '确认替换'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ProductDescriptionModule({
  product,
  sku,
  skuFacts = '',
  attributeRules = {},
  globalSkillPrompt = '',
  textModelOptions = [],
  textModelSelection = null,
  generation,
  onGenerate,
  onReplace,
}) {
  const modelSelection = textModelSelection || resolveConfiguredTextModel(textModelOptions);
  const [editorContext, setEditorContext] = React.useState(null);
  const [contextLoading, setContextLoading] = React.useState(false);
  const [contextError, setContextError] = React.useState('');
  const [generatedValues, setGeneratedValues] = React.useState({});
  const [selectedGeneratedFieldIds, setSelectedGeneratedFieldIds] = React.useState([]);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [replaceBusy, setReplaceBusy] = React.useState(false);
  const [replaceError, setReplaceError] = React.useState('');
  const [replaceSuccess, setReplaceSuccess] = React.useState('');
  const isLoading = generation?.status === 'loading';
  const attributeRows = React.useMemo(
    () => (Array.isArray(editorContext?.attributeRows) ? editorContext.attributeRows : []),
    [editorContext?.attributeRows]
  );
  const filledAttributeRows = attributeRows.filter((item) => item.filled && String(item.value || '').trim());
  const selectedGeneratedSet = new Set(selectedGeneratedFieldIds);
  const generatedCount = Object.values(generatedValues).filter((value) => String(value || '').trim()).length;
  const selectableFieldIds = attributeRows.map((item) => String(item.attributeId || item.id));
  const generatedFieldIds = attributeRows
    .map((item) => String(item.attributeId || item.id))
    .filter((id) => String(generatedValues[id] || '').trim());
  const selectedReplaceFieldIds = generatedFieldIds.filter((id) => selectedGeneratedSet.has(id));
  const allFieldsSelected = Boolean(
    selectableFieldIds.length && selectableFieldIds.every((id) => selectedGeneratedSet.has(id))
  );

  React.useEffect(() => {
    setEditorContext(null);
    setContextError('');
    if (!product) {
      setContextLoading(false);
      return undefined;
    }
    const productShopId = String(
      product.shopId || product.shop_id || product.raw?.shopId || product.raw?.shop_id || ''
    ).trim();
    if (!productShopId) {
      setContextLoading(false);
      setContextError('商品缺少所属店铺，无法读取商品编辑数据。');
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setContextLoading(true);
    readSmartToolProductDescriptionContext(product, { signal: controller.signal, timeoutMs: 15000 })
      .then((context) => {
        if (active) setEditorContext(context);
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setContextError(error instanceof Error ? error.message : String(error || '商品编辑数据读取失败'));
      })
      .finally(() => {
        if (active) setContextLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [product]);

  React.useEffect(() => {
    if (generation?.status !== 'success') {
      setGeneratedValues({});
      return;
    }
    const values = Object.fromEntries(
      (Array.isArray(generation.fields) ? generation.fields : [])
        .map((item) => [String(item.id || '').trim(), String(item.value || '').trim()])
        .filter(([id, value]) => id && value)
    );
    setGeneratedValues(values);
    setSelectedGeneratedFieldIds(
      attributeRows
        .filter((item) => {
          const id = String(item.attributeId || item.id);
          return values[id] && values[id] !== String(item.value || '').trim();
        })
        .map((item) => String(item.attributeId || item.id))
    );
  }, [attributeRows, generation]);

  React.useEffect(() => {
    setGeneratedValues({});
    setSelectedGeneratedFieldIds([]);
    setConfirmOpen(false);
    setReplaceError('');
    setReplaceSuccess('');
  }, [product?.id, sku?.id]);

  const handleGenerate = () => {
    if (!product || !modelSelection || !editorContext || !selectedGeneratedFieldIds.length) return;
    setReplaceError('');
    setReplaceSuccess('');
    onGenerate({
      product,
      sku,
      skuFacts,
      modelSelection,
      editorContext,
      selectedFieldIds: selectedGeneratedFieldIds,
      attributeRules,
      globalSkillPrompt,
    });
  };

  const handleGeneratedValueChange = (id, value) => {
    setGeneratedValues((current) => ({ ...current, [id]: value }));
    setSelectedGeneratedFieldIds((current) => {
      if (!String(value || '').trim()) return current.filter((item) => item !== id);
      return current.includes(id) ? current : [...current, id];
    });
  };

  const handleToggleGeneratedField = (id, checked) => {
    setSelectedGeneratedFieldIds((current) =>
      checked ? [...new Set([...current, id])] : current.filter((item) => item !== id)
    );
  };

  const handleConfirmReplace = async () => {
    setReplaceBusy(true);
    setReplaceError('');
    try {
      const fieldValues = Object.fromEntries(
        selectedReplaceFieldIds.map((id) => [id, generatedValues[id]]).filter(([, value]) => String(value || '').trim())
      );
      await onReplace({ product, sku, fieldValues, attributes: editorContext?.attributes || [] });
      setConfirmOpen(false);
      setReplaceSuccess('选中的商品资料已由 Ozon 回读确认。');
    } catch (error) {
      setReplaceError(error instanceof Error ? error.message : String(error || '商品描述替换失败'));
    } finally {
      setReplaceBusy(false);
    }
  };

  return (
    <Box className="prompt-library-product-description-module">
      <Box className="prompt-library-product-description-head">
        <Box minWidth={0} className="prompt-library-workbench-copy">
          <Typography variant="subtitle1">商品资料智能填写</Typography>
          <Typography variant="caption" color="text.secondary">
            按商品编辑页同一套 Ozon 数据项目生成，使用当前选择的文本模型。
          </Typography>
        </Box>
        <Box className="prompt-library-product-description-actions prompt-library-workbench-actions">
          <Button
            size="small"
            variant="text"
            disabled={!selectableFieldIds.length || allFieldsSelected || isLoading}
            onClick={() => setSelectedGeneratedFieldIds(selectableFieldIds)}
          >
            全选
          </Button>
          <Button
            size="small"
            variant="text"
            disabled={!selectedGeneratedFieldIds.length || isLoading}
            onClick={() => setSelectedGeneratedFieldIds([])}
          >
            取消全选
          </Button>
          <Button
            size="small"
            variant="contained"
            className="prompt-library-product-description-generate-button"
            startIcon={isLoading ? <CircularProgress size={14} color="inherit" /> : <DescriptionRounded />}
            disabled={
              !product ||
              !modelSelection ||
              !editorContext ||
              !filledAttributeRows.length ||
              !selectedGeneratedFieldIds.length ||
              contextLoading ||
              isLoading
            }
            onClick={handleGenerate}
          >
            {isLoading
              ? '正在生成…'
              : selectedGeneratedFieldIds.length
                ? `${generatedCount ? '重新生成' : '生成'} ${selectedGeneratedFieldIds.length} 项资料`
                : '请选择资料字段'}
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={!product || !selectedReplaceFieldIds.length || isLoading}
            onClick={() => {
              setReplaceError('');
              setConfirmOpen(true);
            }}
          >
            替换选中字段{selectedReplaceFieldIds.length ? ` (${selectedReplaceFieldIds.length})` : ''}
          </Button>
        </Box>
      </Box>

      {!modelSelection ? (
        <Alert severity="warning">接口配置中没有可用的文本模型，请先在模型接口中配置并保存。</Alert>
      ) : null}
      {contextLoading ? <Alert severity="info">正在读取商品编辑页的 Ozon 属性数据…</Alert> : null}
      {contextError ? <Alert severity="error">商品编辑数据读取失败：{contextError}</Alert> : null}
      {!contextLoading && editorContext && !filledAttributeRows.length ? (
        <Alert severity="warning">商品编辑页没有读取到可用于生成描述的已填写属性。</Alert>
      ) : null}
      {generation?.status === 'error' ? <Alert severity="error">{generation.message}</Alert> : null}
      {replaceSuccess ? <Alert severity="success">{replaceSuccess}</Alert> : null}

      <Box className="prompt-library-product-field-section-head">
        <Box>
          <Typography variant="subtitle2">商品编辑数据项目</Typography>
          <Typography variant="caption" color="text.secondary">
            每项独立显示当前值和模型生成值
          </Typography>
        </Box>
        <Chip size="small" variant="outlined" label={`${attributeRows.length} 项 · 已生成 ${generatedCount} 项`} />
      </Box>

      <Box className="prompt-library-product-field-grid">
        {attributeRows.length ? (
          attributeRows.map((item) => {
            const id = String(item.attributeId || item.id);
            const generatedValue = String(generatedValues[id] || '');
            return (
              <Box
                key={item.id}
                className={`prompt-library-product-field-card${item.filled ? '' : ' is-empty'}${selectedGeneratedSet.has(id) ? ' is-selected' : ''}`}
              >
                <Box className="prompt-library-product-field-card-head">
                  <Box minWidth={0}>
                    <Typography variant="subtitle2" title={item.label} noWrap>
                      {item.label}
                    </Typography>
                  </Box>
                  <Box className="prompt-library-product-field-card-flags">
                    {item.required ? <Chip size="small" color="warning" variant="outlined" label="必填" /> : null}
                    <Checkbox
                      size="small"
                      checked={selectedGeneratedSet.has(id)}
                      disabled={contextLoading || isLoading}
                      onChange={(event) => handleToggleGeneratedField(id, event.target.checked)}
                      inputProps={{
                        'aria-label': `${selectedGeneratedSet.has(id) ? '取消选择' : '选择'}资料字段${item.label}`,
                      }}
                    />
                  </Box>
                </Box>
                <Box className="prompt-library-product-field-current">
                  <Typography variant="caption">当前值</Typography>
                  <Typography variant="body2">{String(item.value || '').trim() || '未填写'}</Typography>
                </Box>
                <TextField
                  size="small"
                  label="模型生成值"
                  value={generatedValue}
                  placeholder={isLoading ? '生成中…' : '暂未生成'}
                  onChange={(event) => handleGeneratedValueChange(id, event.target.value)}
                  multiline
                  minRows={1}
                  maxRows={2}
                  fullWidth
                />
              </Box>
            );
          })
        ) : (
          <Box className="prompt-library-product-description-facts-empty">
            {contextLoading ? (
              <CircularProgress size={22} />
            ) : (
              <Typography variant="body2">请选择商品并读取编辑数据</Typography>
            )}
          </Box>
        )}
      </Box>

      <Dialog
        open={confirmOpen}
        onClose={replaceBusy ? undefined : () => setConfirmOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>确认替换商品资料</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary">
            只写入下面勾选的字段。提交后必须等待 Ozon 回读确认。
          </Typography>
          <Box className="prompt-library-product-field-confirm-list">
            {attributeRows
              .filter((item) => selectedReplaceFieldIds.includes(String(item.attributeId || item.id)))
              .map((item) => {
                const id = String(item.attributeId || item.id);
                return (
                  <Box key={id} className="prompt-library-product-field-confirm-item">
                    <Typography variant="subtitle2">{item.label}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      当前：{String(item.value || '').trim() || '未填写'}
                    </Typography>
                    <Typography variant="body2">替换为：{generatedValues[id]}</Typography>
                  </Box>
                );
              })}
          </Box>
          {replaceError ? (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {replaceError}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={replaceBusy}>
            取消
          </Button>
          <Button
            variant="contained"
            onClick={handleConfirmReplace}
            disabled={replaceBusy || !selectedReplaceFieldIds.length}
          >
            {replaceBusy ? '正在提交并等待回读…' : '确认替换'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function ImageGenerationPreview({
  mainImages,
  detailImages,
  selectedImageIndexes,
  selectedGeneratedImageIndexes,
  onToggleImage,
  onToggleGeneratedImage,
  onSetAll,
  imageGeneration,
  imagePromptPlan,
  canGenerateImage,
  onGenerateImage,
  onCancelImagePlan,
  onReplaceImages,
  mainSlotDefinitions = [],
  detailSlotDefinitions = [],
  emptySlotCount = EMPTY_IMAGE_SLOT_COUNT,
  showSlotIntentStrip = true,
}) {
  return (
    <Box
      className={`prompt-library-image-preview is-fixed-layout${detailImages.length ? '' : ' has-empty-detail-source'}`}
    >
      <ImageGroupModule
        group="main"
        images={mainImages}
        selectedIndexes={selectedImageIndexes.main}
        onToggleImage={(index, checked) => onToggleImage('main', index, checked)}
        onSetAll={(checked) => onSetAll('main', checked)}
        imageGeneration={imageGeneration?.main}
        planState={imagePromptPlan?.main}
        selectedGeneratedIndexes={selectedGeneratedImageIndexes.main}
        slotDefinitions={mainSlotDefinitions}
        onToggleGenerated={(index, checked) => onToggleGeneratedImage('main', index, checked)}
        canGenerateImage={canGenerateImage}
        onGenerateImage={(sourceIndexes, generationMode) => onGenerateImage('main', sourceIndexes, generationMode)}
        onReplaceImages={() => onReplaceImages('main')}
        onCancelPlan={() => onCancelImagePlan('main')}
        emptySlotCount={emptySlotCount}
        showSlotIntentStrip={showSlotIntentStrip}
      />
      <ImageGroupModule
        group="detail"
        images={detailImages}
        selectedIndexes={selectedImageIndexes.detail}
        onToggleImage={(index, checked) => onToggleImage('detail', index, checked)}
        onSetAll={(checked) => onSetAll('detail', checked)}
        imageGeneration={imageGeneration?.detail}
        planState={imagePromptPlan?.detail}
        selectedGeneratedIndexes={selectedGeneratedImageIndexes.detail}
        slotDefinitions={detailSlotDefinitions}
        onToggleGenerated={(index, checked) => onToggleGeneratedImage('detail', index, checked)}
        canGenerateImage={canGenerateImage}
        onGenerateImage={(sourceIndexes, generationMode) => onGenerateImage('detail', sourceIndexes, generationMode)}
        onReplaceImages={() => onReplaceImages('detail')}
        onCancelPlan={() => onCancelImagePlan('detail')}
        emptySlotCount={emptySlotCount}
        showSlotIntentStrip={showSlotIntentStrip}
      />
    </Box>
  );
}

export function PromptLibraryImageGenerationRun({
  selectedPrompt = {},
  values = {},
  modelOptions = [],
  textModelOptions = [],
  shops = [],
  selectedShop = null,
  availableShops = [],
  onSelectedShopChange = () => {},
  productSelection = {},
  draft,
  imageGeneration,
  imagePromptPlan,
  productDescription,
  imageGenerationHistory = [],
  workspaceMode = 'image',
  historyOpen = false,
  onChangeValue = () => {},
  onClearDraft = () => {},
  onGenerateImage = () => {},
  onCancelImagePlan = () => {},
  onGenerateDescription = () => {},
  onCloseHistory = () => {},
  onHistoryCountChange = () => {},
  onReplaceImages = async () => {
    throw new Error('图片替换服务尚未准备好。');
  },
  onReplaceDescription = async () => {
    throw new Error('商品描述替换服务尚未准备好。');
  },
  workbench = {},
}) {
  const defaultModelId =
    selectedPrompt.promptConfig?.imageModelId || selectedPrompt.promptConfig?.defaultModelId || 'auto';
  const defaultPlannerModelId = selectedPrompt.promptConfig?.plannerModelId || 'auto';
  const [selectedModelId, setSelectedModelId] = React.useState(defaultModelId);
  const [selectedPlannerModelId, setSelectedPlannerModelId] = React.useState(defaultPlannerModelId);
  const [selectedImageSize, setSelectedImageSize] = React.useState(SMART_TOOL_DEFAULT_IMAGE_SIZE);
  const [selectedImageQuality, setSelectedImageQuality] = React.useState(SMART_TOOL_DEFAULT_IMAGE_QUALITY);
  const [selectedImageIndexes, setSelectedImageIndexes] = React.useState({ main: [], detail: [] });
  const [selectedGeneratedImageIndexes, setSelectedGeneratedImageIndexes] = React.useState({ main: [], detail: [] });
  const [replaceDialog, setReplaceDialog] = React.useState(null);
  const [replaceBusy, setReplaceBusy] = React.useState(false);
  const [replaceError, setReplaceError] = React.useState('');
  const productListRef = React.useRef(null);
  const selectedProduct = productSelection.selectedProduct;
  const selectedSku = productSelection.selectedSku;
  const shopOptions = React.useMemo(() => {
    const source = availableShops.length ? availableShops : shops;
    const seen = new Set();
    return source
      .map((shop) => ({ ...normalizeOzonShopOption(shop), sourceShop: shop }))
      .filter((shop) => shop.shopId && !seen.has(shop.shopId) && seen.add(shop.shopId));
  }, [availableShops, shops]);
  const selectedShopOption = normalizeOzonShopOption(selectedShop || shops[0] || {});
  const productShopId = String(
    selectedProduct?.shopId ||
      selectedProduct?.shop_id ||
      selectedProduct?.raw?.shopId ||
      selectedProduct?.raw?.shop_id ||
      ''
  ).trim();
  const selectedShopId = String(shops[0]?.id || shops[0]?.shopId || '').trim();
  const currentShopId = productShopId || selectedShopId;
  const currentShop = shops.find((shop) => String(shop?.id || shop?.shopId || '').trim() === currentShopId) || null;
  const currentAccountId =
    String(
      currentShop?.profileId ||
        currentShop?.profile_id ||
        selectedProduct?.accountId ||
        selectedProduct?.profileId ||
        selectedProduct?.raw?.profileId ||
        selectedProduct?.raw?.profile_id ||
        'default'
    ).trim() || 'default';
  const currentProductKey = String(
    selectedProduct?.offerId || selectedProduct?.productId || selectedProduct?.id || ''
  ).trim();
  const currentSku = String(selectedSku?.sku || selectedSku?.id || '').trim();
  const scopedImageGenerationHistory = React.useMemo(
    () =>
      filterSmartToolImageHistory(imageGenerationHistory, {
        accountId: currentAccountId,
        shopId: currentShopId,
        productKey: currentProductKey,
        sku: currentSku,
      }),
    [currentAccountId, currentProductKey, currentShopId, currentSku, imageGenerationHistory]
  );

  React.useEffect(() => {
    onHistoryCountChange(scopedImageGenerationHistory.length);
  }, [onHistoryCountChange, scopedImageGenerationHistory.length]);
  const resolvedModel = resolveSmartToolModelSelection(selectedModelId, modelOptions);
  const resolvedPlannerModel = resolveSmartToolModelSelection(selectedPlannerModelId, textModelOptions);
  const imageSizeOptions = React.useMemo(
    () => buildImageGenerationOptions(resolvedModel.options?.size, SMART_TOOL_IMAGE_SIZE_OPTIONS),
    [resolvedModel.options?.size]
  );
  const imageQualityOptions = React.useMemo(
    () => buildImageGenerationOptions(resolvedModel.options?.quality, SMART_TOOL_IMAGE_QUALITY_OPTIONS),
    [resolvedModel.options?.quality]
  );
  const manualImageUrl = isRenderableImageUrl(values[PRODUCT_REFERENCE_LABEL]) ? values[PRODUCT_REFERENCE_LABEL] : '';
  const selectedMainImages = selectedSku?.mainImages?.length ? selectedSku.mainImages : selectedProduct?.mainImages;
  const selectedDetailImages = selectedSku?.detailImages?.length
    ? selectedSku.detailImages
    : selectedProduct?.detailImages;
  const fallbackProductImages = selectedSku?.images?.length ? selectedSku.images : selectedProduct?.images;
  const hasExplicitImageGroups = Boolean(selectedMainImages?.length || selectedDetailImages?.length);
  const mainImages = uniqueRenderableImages(
    selectedMainImages,
    selectedSku?.image,
    hasExplicitImageGroups ? [] : fallbackProductImages,
    manualImageUrl
  );
  const detailImages = uniqueRenderableImages(selectedDetailImages);
  const usesInstalledWorkbench =
    isUserInstalledSmartTool(selectedPrompt) && workbench?.kind === SMART_TOOL_WORKBENCH_KIND.PRODUCT_CONTENT;
  const isNativeImageGeneration = selectedPrompt?.id === 'ozon-product-image-generation';
  const usesProductImageWorkspace =
    isNativeImageGeneration ||
    (isUserInstalledSmartTool(selectedPrompt) && isSmartToolProductImageWorkbench(workbench));
  const runtimeImageExecutionContext = React.useMemo(
    () =>
      isNativeImageGeneration
        ? createSmartToolImageExecutionContext(selectedPrompt)
        : workbench.imageExecutionContext || null,
    [isNativeImageGeneration, selectedPrompt, workbench.imageExecutionContext]
  );
  const emptySlotCount = usesProductImageWorkspace ? NATIVE_IMAGE_SLOT_COUNT : EMPTY_IMAGE_SLOT_COUNT;
  const workspaceProductCount = usesProductImageWorkspace
    ? (productSelection.filteredProducts || productSelection.visibleProducts || []).length
    : 0;
  const mainSlotDefinitions = React.useMemo(
    () =>
      usesInstalledWorkbench
        ? createSmartToolImageSlotDefinitions(workbench, 'main', mainImages.length, selectedSku)
        : [],
    [mainImages.length, selectedSku, usesInstalledWorkbench, workbench]
  );
  const detailSlotDefinitions = React.useMemo(
    () =>
      usesInstalledWorkbench
        ? createSmartToolImageSlotDefinitions(workbench, 'detail', detailImages.length, selectedSku)
        : [],
    [detailImages.length, selectedSku, usesInstalledWorkbench, workbench]
  );
  const autoBoundProductContext = Boolean(
    selectedProduct && workbench?.modules?.includes(SMART_TOOL_WORKBENCH_MODULE.PRODUCT_SELECTOR)
  );
  const modeInputLabel = String(workbench?.modeInputLabel || '').trim();
  const modeInputSpec = modeInputLabel ? getSmartToolUsageInputSpec(selectedPrompt, modeInputLabel) : null;
  const selectedMode = String(values[modeInputLabel] || modeInputSpec?.defaultValue || '').trim();
  const imageExecutionAllowed =
    !selectedMode ||
    !/(?:step3|seo|post-launch|复盘|文案)/iu.test(selectedMode) ||
    /(?:step4|image|图片|生图|full)/iu.test(selectedMode);
  const canGenerateImage = Boolean(
    imageExecutionAllowed &&
    resolvedModel.ready &&
    resolvedModel.accountId &&
    resolvedModel.model &&
    resolvedPlannerModel.ready &&
    resolvedPlannerModel.accountId &&
    resolvedPlannerModel.model &&
    (selectedProduct?.title || values[PRODUCT_REFERENCE_LABEL]?.trim()) &&
    values[SKU_FACTS_LABEL]?.trim()
  );

  React.useEffect(() => {
    setSelectedModelId(defaultModelId);
    setSelectedPlannerModelId(defaultPlannerModelId);
    setSelectedImageSize(SMART_TOOL_DEFAULT_IMAGE_SIZE);
    setSelectedImageQuality(SMART_TOOL_DEFAULT_IMAGE_QUALITY);
  }, [defaultModelId, defaultPlannerModelId, selectedPrompt.id]);

  React.useLayoutEffect(() => {
    if (!usesProductImageWorkspace || !productListRef.current) return;
    productListRef.current.scrollTop = 0;
  }, [productSelection.query, selectedShopOption.shopId, usesProductImageWorkspace, workspaceProductCount]);

  React.useEffect(() => {
    const sizeIds = new Set(imageSizeOptions.map((item) => item.id));
    const qualityIds = new Set(imageQualityOptions.map((item) => item.id));
    setSelectedImageSize((current) =>
      sizeIds.has(current)
        ? current
        : sizeIds.has(SMART_TOOL_DEFAULT_IMAGE_SIZE)
          ? SMART_TOOL_DEFAULT_IMAGE_SIZE
          : imageSizeOptions[0]?.id || SMART_TOOL_DEFAULT_IMAGE_SIZE
    );
    setSelectedImageQuality((current) =>
      qualityIds.has(current)
        ? current
        : qualityIds.has(SMART_TOOL_DEFAULT_IMAGE_QUALITY)
          ? SMART_TOOL_DEFAULT_IMAGE_QUALITY
          : imageQualityOptions[0]?.id || SMART_TOOL_DEFAULT_IMAGE_QUALITY
    );
  }, [imageQualityOptions, imageSizeOptions]);

  const imageSelectionKey = [
    selectedProduct?.id || values[PRODUCT_REFERENCE_LABEL] || '',
    selectedSku?.id || '',
    mainImages.join('|'),
    detailImages.join('|'),
  ].join('::');
  const mainImageCount = mainImages.length;
  const detailImageCount = detailImages.length;

  React.useEffect(() => {
    setSelectedImageIndexes({
      main: workbench.requiresExplicitImageSelection ? [] : Array.from({ length: mainImageCount }, (_, index) => index),
      detail: workbench.requiresExplicitImageSelection
        ? []
        : Array.from({ length: detailImageCount }, (_, index) => index),
    });
  }, [detailImageCount, imageSelectionKey, mainImageCount, workbench.requiresExplicitImageSelection]);

  React.useEffect(() => {
    const next = { main: [], detail: [] };
    ['main', 'detail'].forEach((group) => {
      const items = Array.isArray(imageGeneration?.[group]?.result?.items) ? imageGeneration[group].result.items : [];
      next[group] = items
        .filter((item) => item.status === 'success' && Number.isInteger(item.sourceIndex))
        .map((item) => item.sourceIndex);
    });
    setSelectedGeneratedImageIndexes(next);
  }, [imageGeneration]);

  const handleToggleImage = (group, index, checked) => {
    setSelectedImageIndexes((current) => {
      const nextIndexes = new Set(current[group] || []);
      if (checked) nextIndexes.add(index);
      else nextIndexes.delete(index);
      return {
        ...current,
        [group]: [...nextIndexes].sort((left, right) => left - right),
      };
    });
  };

  const handleSetAllImages = (group, checked) => {
    const groupImages = group === 'detail' ? detailImages : mainImages;
    setSelectedImageIndexes((current) => ({
      ...current,
      [group]: checked ? groupImages.map((_, index) => index) : [],
    }));
  };

  const handleToggleGeneratedImage = (group, index, checked) => {
    setSelectedGeneratedImageIndexes((current) => {
      const nextIndexes = new Set(current[group] || []);
      if (checked) nextIndexes.add(index);
      else nextIndexes.delete(index);
      return { ...current, [group]: [...nextIndexes].sort((left, right) => left - right) };
    });
  };

  const handleSelectProduct = (product) => {
    onClearDraft();
    productSelection.onSelectProduct?.(product);
    const sku = product?.skuOptions?.[0];
    onChangeValue(
      PRODUCT_REFERENCE_LABEL,
      [product.title, product.offerId || product.productId].filter(Boolean).join(' · ')
    );
    onChangeValue(SKU_FACTS_LABEL, sku?.facts || sku?.sku || '');
  };

  const handleSelectSku = (event) => {
    const sku = selectedProduct?.skuOptions?.find((item) => item.id === event.target.value);
    onClearDraft();
    productSelection.onSelectSku?.(event.target.value);
    onChangeValue(SKU_FACTS_LABEL, sku?.facts || sku?.sku || '');
  };

  const handleGenerateImage = (
    group,
    retrySourceIndexes = null,
    generationMode = SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD
  ) => {
    const groupImages = group === 'detail' ? detailImages : mainImages;
    const normalizedRetryIndexes = normalizeRetrySourceIndexes(retrySourceIndexes);
    const requestedIndexes =
      normalizedRetryIndexes === null ? selectedImageIndexes[group] || [] : normalizedRetryIndexes;
    const sourceImageIndexes = requestedIndexes.filter((index) => groupImages[index]);
    const sourceImages = sourceImageIndexes.map((index) => groupImages[index]);
    const slotDefinitions = group === 'detail' ? detailSlotDefinitions : mainSlotDefinitions;
    const executionSlots =
      group === 'detail' ? runtimeImageExecutionContext?.detailImageSlots : runtimeImageExecutionContext?.imageSlots;
    const imageSlotInstructions = sourceImageIndexes.map((sourceIndex) => {
      const visibleSlot = slotDefinitions[sourceIndex];
      const executionSlot = (Array.isArray(executionSlots) ? executionSlots : []).find(
        (item) => Number(item?.sourceIndex) === sourceIndex
      );
      return {
        sourceIndex,
        title:
          visibleSlot?.title ||
          executionSlot?.title ||
          `${group === 'detail' ? '详情图' : '主图'}位置 ${sourceIndex + 1}`,
        instruction: visibleSlot?.instruction || executionSlot?.instruction || '',
      };
    });
    if (!sourceImages.length) return;
    onGenerateImage({
      accountId: currentAccountId,
      shopId: currentShopId,
      productTitle: selectedProduct?.title || values[PRODUCT_REFERENCE_LABEL],
      productKey: currentProductKey,
      offerId: selectedProduct?.offerId,
      productId: selectedProduct?.productId,
      sku: selectedSku?.sku || selectedSku?.id,
      productImageUrl: sourceImages[0] || '',
      productImageUrls: sourceImages,
      sourceImageIndexes,
      imageSlotInstructions,
      skillExecutionContext: runtimeImageExecutionContext,
      skuFacts: values[SKU_FACTS_LABEL],
      targetScene: values[TARGET_SCENE_LABEL],
      draft,
      plannerModelSelection: resolvedPlannerModel,
      modelSelection: resolvedModel,
      group,
      imageGroup: group,
      count: sourceImages.length,
      imageSize: selectedImageSize,
      imageQuality: selectedImageQuality,
      generationMode,
    });
  };

  const openReplaceDialog = (group) => {
    const generation = imageGeneration?.[group];
    const selected = new Set(selectedGeneratedImageIndexes[group] || []);
    const items = (generation?.result?.items || []).filter(
      (item) => item.status === 'success' && selected.has(item.sourceIndex)
    );
    setReplaceError('');
    setReplaceDialog({ group, items });
  };

  const confirmReplaceImages = async () => {
    if (!replaceDialog) return;
    setReplaceBusy(true);
    setReplaceError('');
    try {
      await onReplaceImages({
        group: replaceDialog.group,
        generatedItems: replaceDialog.items,
        product: selectedProduct,
        sku: selectedSku,
      });
      setReplaceDialog(null);
    } catch (error) {
      setReplaceError(error instanceof Error ? error.message : String(error || '图片替换失败'));
    } finally {
      setReplaceBusy(false);
    }
  };

  return (
    <Box className="prompt-library-image-run-shell">
      <Box component="aside" className="prompt-library-image-fixed-sidebar">
        <Box className="prompt-library-image-sidebar-title">
          <Typography variant="subtitle1">生成前设置</Typography>
          <Typography variant="body2" color="text.secondary">
            选择模型、商品和 SKU，然后在右侧生成预览。
          </Typography>
        </Box>

        {modeInputLabel && Array.isArray(modeInputSpec?.options) && modeInputSpec.options.length ? (
          <Box className="prompt-library-image-fixed-section prompt-library-skill-scope-section">
            <Typography variant="subtitle2">本次处理范围</Typography>
            <TextField
              size="small"
              select
              fullWidth
              label={modeInputLabel}
              value={selectedMode}
              onChange={(event) => onChangeValue(modeInputLabel, event.target.value)}
            >
              {modeInputSpec.options.map((item) => (
                <MenuItem key={item.value} value={item.value}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
          </Box>
        ) : null}

        {shopOptions.length ? (
          <Box className="prompt-library-image-fixed-section prompt-library-skill-shop-section">
            <Typography variant="subtitle2">店铺</Typography>
            <TextField
              size="small"
              select
              fullWidth
              label="选择店铺"
              value={selectedShopOption.shopId || shopOptions[0]?.shopId || ''}
              onChange={(event) => {
                const nextShop = shopOptions.find((item) => item.shopId === event.target.value)?.sourceShop;
                if (nextShop) onSelectedShopChange(nextShop);
              }}
            >
              {shopOptions.map((item) => (
                <MenuItem key={item.shopId} value={item.shopId}>
                  {item.displayName}
                </MenuItem>
              ))}
            </TextField>
          </Box>
        ) : null}

        <Box className="prompt-library-image-fixed-section prompt-library-image-model-section">
          <Typography variant="subtitle2">模型</Typography>
          <TextField
            size="small"
            select
            fullWidth
            label="分析 / 文案模型"
            value={selectedPlannerModelId}
            onChange={(event) => setSelectedPlannerModelId(event.target.value)}
          >
            {textModelOptions.length ? (
              textModelOptions.map((item) => (
                <MenuItem key={item.id} value={item.id} disabled={!item.ready}>
                  {item.label} · {item.statusLabel}
                </MenuItem>
              ))
            ) : (
              <MenuItem value="auto">未读取到文本模型</MenuItem>
            )}
          </TextField>
          <TextField
            size="small"
            select
            fullWidth
            label="图片生成模型"
            value={selectedModelId}
            onChange={(event) => setSelectedModelId(event.target.value)}
          >
            {modelOptions.length ? (
              modelOptions.map((item) => (
                <MenuItem key={item.id} value={item.id} disabled={!item.ready}>
                  {item.label} · {item.statusLabel}
                </MenuItem>
              ))
            ) : (
              <MenuItem value="auto">未读取到图片模型</MenuItem>
            )}
          </TextField>
          <Box className="prompt-library-image-output-options">
            <TextField
              size="small"
              select
              fullWidth
              label="输出尺寸"
              value={selectedImageSize}
              onChange={(event) => setSelectedImageSize(event.target.value)}
            >
              {imageSizeOptions.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              select
              fullWidth
              label="生成质量"
              value={selectedImageQuality}
              onChange={(event) => setSelectedImageQuality(event.target.value)}
            >
              {imageQualityOptions.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
          </Box>
          {!resolvedPlannerModel.ready ? (
            <Typography className="prompt-library-image-sidebar-hint">请先配置分析/文案模型。</Typography>
          ) : null}
          {!resolvedModel.ready ? (
            <Typography className="prompt-library-image-sidebar-hint">请先配置图片生成模型。</Typography>
          ) : null}
        </Box>

        <Box className="prompt-library-image-fixed-section prompt-library-image-product-section">
          <Box className="prompt-library-image-fixed-section-head">
            <Box>
              <Typography variant="subtitle2">选择商品</Typography>
            </Box>
            <Button
              size="small"
              variant="text"
              startIcon={<RefreshRounded />}
              onClick={productSelection.onRefresh}
              disabled={productSelection.loading}
            >
              读取
            </Button>
          </Box>
          <TextField
            size="small"
            fullWidth
            value={productSelection.query || ''}
            onChange={(event) => productSelection.onQueryChange?.(event.target.value)}
            placeholder="搜索名称、货号或 SKU"
            InputProps={{ startAdornment: <SearchRounded className="prompt-library-image-search-icon" /> }}
          />
          {productSelection.loading ? (
            <Box className="prompt-library-image-search-state">
              <CircularProgress size={16} /> 正在读取商品信息…
            </Box>
          ) : (usesProductImageWorkspace
              ? productSelection.filteredProducts || productSelection.visibleProducts
              : productSelection.visibleProducts
            )?.length ? (
            <Box
              ref={usesProductImageWorkspace ? productListRef : undefined}
              className="prompt-library-image-product-list"
            >
              {(usesProductImageWorkspace
                ? productSelection.filteredProducts || productSelection.visibleProducts
                : productSelection.visibleProducts.slice(0, 2)
              ).map((product) => (
                <ProductSearchResult
                  key={product.id}
                  product={product}
                  selected={selectedProduct?.id === product.id}
                  onSelect={handleSelectProduct}
                />
              ))}
            </Box>
          ) : (
            <Box className="prompt-library-image-search-state">
              {productSelection.error ||
                (productSelection.hasLocalProducts
                  ? '没有匹配的商品。'
                  : '暂时没有商品信息，请先配置店铺或到商品列表同步。')}
            </Box>
          )}
        </Box>

        <Box className="prompt-library-image-fixed-section prompt-library-current-product-section">
          <Typography variant="subtitle2">当前商品信息</Typography>
          {autoBoundProductContext ? (
            <Box className="prompt-library-image-bound-product-summary">
              <Box className="prompt-library-image-bound-product-thumb">
                {selectedProduct.image ? <img src={selectedProduct.image} alt="" /> : <Inventory2Rounded />}
              </Box>
              <Box minWidth={0}>
                <Typography variant="body2" fontWeight={700} noWrap title={selectedProduct.title}>
                  {selectedProduct.title}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {[
                    selectedProduct.offerId ? `货号 ${selectedProduct.offerId}` : '',
                    selectedSku?.sku ? `SKU ${selectedSku.sku}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Typography>
              </Box>
            </Box>
          ) : (
            <TextField
              size="small"
              label={PRODUCT_REFERENCE_LABEL}
              value={values[PRODUCT_REFERENCE_LABEL] || ''}
              placeholder={getSmartToolUsageInputPlaceholder(PRODUCT_REFERENCE_LABEL)}
              onChange={(event) => onChangeValue(PRODUCT_REFERENCE_LABEL, event.target.value)}
              fullWidth
            />
          )}
          {selectedProduct?.skuOptions?.length > 1 ? (
            <TextField
              size="small"
              select
              label="选择当前 SKU"
              value={selectedSku?.id || ''}
              onChange={handleSelectSku}
              fullWidth
            >
              {selectedProduct.skuOptions.map((sku) => (
                <MenuItem key={sku.id} value={sku.id}>
                  {sku.label}
                  {sku.facts ? ` · ${sku.facts}` : ''}
                </MenuItem>
              ))}
            </TextField>
          ) : null}
          {!autoBoundProductContext ? (
            <TextField
              size="small"
              label={SKU_FACTS_LABEL}
              value={values[SKU_FACTS_LABEL] || ''}
              placeholder="例如：黑色 · 500ml · 1 个"
              onChange={(event) => onChangeValue(SKU_FACTS_LABEL, event.target.value)}
              fullWidth
            />
          ) : null}
          <TextField
            size="small"
            label={TARGET_SCENE_LABEL}
            value={values[TARGET_SCENE_LABEL] || ''}
            placeholder="例如：厨房台面、户外露营（可不填）"
            onChange={(event) => onChangeValue(TARGET_SCENE_LABEL, event.target.value)}
            fullWidth
          />
        </Box>

        <Box className="prompt-library-image-fixed-rules">
          <Typography variant="subtitle2">生成数量</Typography>
          <Box className="prompt-library-image-group-summary">
            <strong>
              {selectedImageIndexes.main.length} + {selectedImageIndexes.detail.length}
            </strong>
            <span>按勾选数量生成</span>
          </Box>
          <Typography variant="caption">选几张生成几张；生成结果与原图位置对应。</Typography>
          {!imageExecutionAllowed ? (
            <Typography variant="caption">当前范围只处理文案或复盘，请切换到右上角“编辑文案与属性”。</Typography>
          ) : null}
          {workbench.requiresExplicitImageSelection ? (
            <Typography variant="caption">安装的 Skill 不会默认扣费生图，请在右侧明确勾选要处理的位置。</Typography>
          ) : null}
        </Box>
      </Box>

      <Box
        component="section"
        className={`prompt-library-image-preview-column${workspaceMode === 'image' ? ' is-image-mode' : ' is-attributes-mode'}`}
      >
        <Box
          className={`prompt-library-image-mode-panel${workspaceMode === 'image' ? ' is-active' : ''}`}
          hidden={workspaceMode !== 'image'}
          aria-hidden={workspaceMode !== 'image'}
        >
          <ImageGenerationPreview
            mainImages={mainImages}
            detailImages={detailImages}
            selectedImageIndexes={selectedImageIndexes}
            selectedGeneratedImageIndexes={selectedGeneratedImageIndexes}
            onToggleImage={handleToggleImage}
            onToggleGeneratedImage={handleToggleGeneratedImage}
            onSetAll={handleSetAllImages}
            imageGeneration={imageGeneration}
            imagePromptPlan={imagePromptPlan}
            onGenerateImage={handleGenerateImage}
            onCancelImagePlan={onCancelImagePlan}
            canGenerateImage={canGenerateImage}
            onReplaceImages={openReplaceDialog}
            mainSlotDefinitions={mainSlotDefinitions}
            detailSlotDefinitions={detailSlotDefinitions}
            emptySlotCount={emptySlotCount}
            showSlotIntentStrip={!usesInstalledWorkbench}
          />
        </Box>
        <Box
          className={`prompt-library-image-mode-panel${workspaceMode === 'attributes' ? ' is-active' : ''}`}
          hidden={workspaceMode !== 'attributes'}
          aria-hidden={workspaceMode !== 'attributes'}
        >
          <ProductDescriptionModule
            product={selectedProduct}
            sku={selectedSku}
            skuFacts={values[SKU_FACTS_LABEL]}
            attributeRules={selectedPrompt.promptConfig?.attributeRules}
            globalSkillPrompt={selectedPrompt.promptConfig?.systemPrompt}
            textModelOptions={textModelOptions}
            textModelSelection={resolvedPlannerModel}
            generation={productDescription}
            onGenerate={onGenerateDescription}
            onReplace={onReplaceDescription}
          />
        </Box>
        <ImageGenerationHistoryDialog
          open={historyOpen}
          onClose={onCloseHistory}
          history={scopedImageGenerationHistory}
          productKey={currentProductKey}
          productTitle={selectedProduct?.title || values[PRODUCT_REFERENCE_LABEL] || ''}
          sku={currentSku}
        />
        <ImageGenerationReplaceDialog
          open={Boolean(replaceDialog)}
          onClose={() => setReplaceDialog(null)}
          groupLabel={replaceDialog?.group === 'detail' ? '详情图' : '主图'}
          items={replaceDialog?.items || []}
          sourceImages={replaceDialog?.group === 'detail' ? detailImages : mainImages}
          busy={replaceBusy}
          error={replaceError}
          onConfirm={confirmReplaceImages}
        />
      </Box>
    </Box>
  );
}

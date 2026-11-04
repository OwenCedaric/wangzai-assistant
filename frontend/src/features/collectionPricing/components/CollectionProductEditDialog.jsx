import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';
import CategoryRounded from '@mui/icons-material/CategoryRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import FactCheckRounded from '@mui/icons-material/FactCheckRounded';
import GridViewRounded from '@mui/icons-material/GridViewRounded';
import ImageRounded from '@mui/icons-material/ImageRounded';
import PublishRounded from '@mui/icons-material/PublishRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import React from 'react';

import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import {
  SMART_TOOL_DEFAULT_IMAGE_QUALITY,
  SMART_TOOL_DEFAULT_IMAGE_SIZE,
  SMART_TOOL_IMAGE_QUALITY_OPTIONS,
  SMART_TOOL_IMAGE_SIZE_OPTIONS,
} from '../../promptLibrary/services/smartToolImageGenerationService.js';
import { useCollectionProductEditorModels } from '../model/useCollectionProductEditorModels.js';
import { useCollectionProductImageSkill } from '../model/useCollectionProductImageSkill.js';
import { useCollectionProductBatchStock } from '../model/useCollectionProductBatchStock.js';
import { useCollectionProductListingWorkflow } from '../model/useCollectionProductListingWorkflow.js';
import { useCollectionProductPricing } from '../model/useCollectionProductPricing.js';
import { CollectionProductEditorSidebar } from './CollectionProductEditorSidebar.jsx';
import { CollectionProductImageWorkspace } from './CollectionProductImageWorkspace.jsx';
import { CollectionProductSkuWorkspace } from './CollectionProductSkuWorkspace.jsx';
import {
  CollectionProductListingPreviewStep,
  CollectionProductListingReadbackStep,
  CollectionProductSetupStep,
  CollectionProductSkuPriceStep,
} from './CollectionProductListingSteps.jsx';

const SCALAR_FIELDS = Object.freeze([
  'title', 'category', 'description', 'purchasePrice', 'purchasePriceMin', 'purchasePriceMax',
  'weightG', 'weightMinG', 'weightMaxG',
  'sourceCategoryId', 'sourceCategoryName', 'sourceCategoryPath',
  'shippingStatus', 'shippingFeeMin', 'shippingFeeMax', 'shippingCurrency', 'shippingRuleText',
  'minimumOrderQuantity', 'minimumOrderUnit', 'mixedBatchStatus',
  'perSkuMinimumQuantity', 'purchaseMultiple', 'deliveryLeadTimeHours', 'deliveryText',
  'packageLengthCm', 'packageWidthCm', 'packageHeightCm',
]);

const STEP_ICONS = Object.freeze({
  setup: <CategoryRounded fontSize="small" />,
  images: <ImageRounded fontSize="small" />,
  skus: <GridViewRounded fontSize="small" />,
  preview: <FactCheckRounded fontSize="small" />,
  readback: <PublishRounded fontSize="small" />,
});

function text(value) {
  return String(value ?? '');
}

function createDraft(product) {
  return {
    ...Object.fromEntries(SCALAR_FIELDS.map((field) => [field, text(product?.[field])])),
    attributes: (Array.isArray(product?.attributes) ? product.attributes : []).map((item) => ({ name: text(item?.name), value: text(item?.value) })),
    skus: (Array.isArray(product?.skus) ? product.skus : []).map((item) => ({
      ...item,
      id: text(item.id), name: text(item.name), price: text(item.price), imageUrl: text(item.imageUrl),
      weightG: text(item.weightG), packageLengthCm: text(item.packageLengthCm),
      packageWidthCm: text(item.packageWidthCm), packageHeightCm: text(item.packageHeightCm),
      attributes: Array.isArray(item.attributes) ? [...item.attributes] : [],
      enabled: item.enabled !== false,
    })),
    mainImages: [...(Array.isArray(product?.mainImages) ? product.mainImages : [])],
    skuImages: (Array.isArray(product?.skuImages) ? product.skuImages : []).map((item) => ({ ...item })),
    detailImages: [...(Array.isArray(product?.detailImages) ? product.detailImages : [])],
    editorSettings: {
      textModelId: text(product?.editorSettings?.textModelId || 'auto'),
      imageModelId: text(product?.editorSettings?.imageModelId || 'auto'),
      imageSize: text(product?.editorSettings?.imageSize || SMART_TOOL_DEFAULT_IMAGE_SIZE),
      imageQuality: text(product?.editorSettings?.imageQuality || SMART_TOOL_DEFAULT_IMAGE_QUALITY),
    },
  };
}

function syncSkuImages(skus, existingRows) {
  const existingById = new Map((Array.isArray(existingRows) ? existingRows : []).map((item) => [String(item.skuId || ''), item]));
  return skus
    .filter((sku) => text(sku.imageUrl).trim())
    .map((sku) => ({
      ...(existingById.get(text(sku.id)) || {}),
      skuId: text(sku.id).trim(),
      skuName: text(sku.name).trim(),
      imageUrl: text(sku.imageUrl).trim(),
    }));
}

function sourceChanges(draft, listingPersistence = {}) {
  const skuImages = syncSkuImages(draft.skus, draft.skuImages);
  return {
    ...Object.fromEntries(SCALAR_FIELDS.map((field) => [field, draft[field].trim()])),
    attributes: draft.attributes.map((item) => ({ name: item.name.trim(), value: item.value.trim() })).filter((item) => item.name && item.value),
    skus: draft.skus.map((sku) => ({ ...sku, id: sku.id.trim(), name: sku.name.trim(), imageUrl: sku.imageUrl.trim() })),
    mainImages: draft.mainImages,
    skuImages,
    detailImages: draft.detailImages,
    images: [...new Set([...draft.mainImages, ...skuImages.map((item) => item.imageUrl), ...draft.detailImages])],
    editorSettings: { ...draft.editorSettings },
    ozonListingDraft: listingPersistence.ozonListingDraft,
    ozonListingDrafts: listingPersistence.ozonListingDrafts,
  };
}

export function CollectionProductEditDialog({
  product,
  shops = [],
  activeShopId = '',
  onClose,
  onSaveDraft,
  onDelete,
}) {
  const [draft, setDraft] = React.useState(() => createDraft(product));
  const [saveState, setSaveState] = React.useState({ status: 'idle', error: '' });
  const saveResetTimerRef = React.useRef(null);
  const autoPreviewStartedRef = React.useRef('');
  const productRef = React.useRef(product);
  productRef.current = product;
  const { textModelOptions, imageModelOptions } = useCollectionProductEditorModels(Boolean(product));
  const imageSkillState = useCollectionProductImageSkill(Boolean(product));
  const listing = useCollectionProductListingWorkflow({
    product,
    shops,
    activeShopId,
    textModelOptions,
    textModelId: draft.editorSettings?.textModelId || 'auto',
    imageModelOptions,
    imageSkill: imageSkillState.skill,
    onPersist: onSaveDraft,
  });
  const {
    getPersistenceSnapshot,
    prepareGeneratedImagesForSave,
    requestPreview,
  } = listing;
  const pricing = useCollectionProductPricing({
    product,
    listingDraft: listing.draft,
    onChangeListingDraft: listing.update,
  });
  const batchStock = useCollectionProductBatchStock({
    shopId: listing.draft.shopId,
    shopIds: listing.draft.uploadShopIds || [listing.draft.shopId].filter(Boolean),
    skus: listing.draft.skus,
    onChangeSku: listing.updateSku,
  });
  const canSave = Boolean(
    draft.title.trim().length >= 4 &&
    Number(draft.purchasePriceMin || draft.purchasePrice) > 0 &&
    draft.mainImages.length &&
    draft.skus.length &&
    draft.skus.some((sku) => ((sku.id.trim() || sku.name.trim()) && Number(sku.price || draft.purchasePriceMin || draft.purchasePrice) > 0))
  );
  const stepIndex = listing.steps.findIndex((item) => item.id === listing.step);

  React.useEffect(() => {
    setDraft(createDraft(productRef.current));
    setSaveState({ status: 'idle', error: '' });
  }, [product?.id]);

  React.useEffect(() => () => {
    if (saveResetTimerRef.current) window.clearTimeout(saveResetTimerRef.current);
  }, []);

  const change = React.useCallback((field, value) => {
    if (field.startsWith('editorSettings.')) {
      const setting = field.slice('editorSettings.'.length);
      setDraft((current) => ({ ...current, editorSettings: { ...current.editorSettings, [setting]: value } }));
      return;
    }
    setDraft((current) => ({ ...current, [field]: value }));
  }, []);

  const saveSource = React.useCallback(async ({ prepareImages = false, feedback = false } = {}) => {
    if (!product?.id || !canSave) return false;
    if (feedback) setSaveState({ status: 'saving', error: '' });
    try {
      if (prepareImages) await prepareGeneratedImagesForSave({ ...product, ...draft });
      const changes = sourceChanges(draft, getPersistenceSnapshot());
      const saved = await onSaveDraft?.(product.id, changes);
      if (saved === false) throw new Error('采集商品保存失败，请重试。');
      if (feedback) {
        setSaveState({ status: 'success', error: '' });
        if (saveResetTimerRef.current) window.clearTimeout(saveResetTimerRef.current);
        saveResetTimerRef.current = window.setTimeout(() => {
          setSaveState({ status: 'idle', error: '' });
        }, 1_600);
      }
      return true;
    } catch (error) {
      if (feedback) setSaveState({
        status: 'error',
        error: error instanceof Error ? error.message : '采集商品保存失败，请重试。',
      });
      return false;
    }
  }, [canSave, draft, getPersistenceSnapshot, onSaveDraft, prepareGeneratedImagesForSave, product]);

  const createListingPreview = React.useCallback(() => requestPreview({
    beforePreview: () => saveSource({ prepareImages: true }),
  }), [requestPreview, saveSource]);

  React.useEffect(() => {
    if (listing.step !== 'preview') {
      autoPreviewStartedRef.current = '';
      return;
    }
    if (listing.preview || listing.listingState.status !== 'idle') return;
    const previewEntryKey = [
      product?.id || '',
      ...(listing.draft.uploadShopIds || [listing.draft.shopId].filter(Boolean)),
    ].map(String).join('::');
    if (!previewEntryKey || autoPreviewStartedRef.current === previewEntryKey) return;
    autoPreviewStartedRef.current = previewEntryKey;
    void createListingPreview();
  }, [
    createListingPreview,
    listing.draft.shopId,
    listing.draft.uploadShopIds,
    listing.listingState.status,
    listing.preview,
    listing.step,
    product?.id,
  ]);

  const title = listing.steps.find((item) => item.id === listing.step)?.label || '';
  return (
    <Dialog
      open={Boolean(product)} onClose={onClose} maxWidth={false} fullWidth
      className="collection-product-editor-dialog"
      PaperProps={{
        sx: {
          width: 'calc(100vw - 28px)',
          maxWidth: 1960,
          height: 'calc(100vh - 28px)',
          maxHeight: 1020,
          m: 1,
          overflow: 'hidden',
          borderRadius: 2.25,
          bgcolor: '#f6f8fc',
          boxShadow: '0 24px 70px rgba(15, 23, 42, 0.22)',
        },
      }}
      aria-labelledby="collection-product-editor-heading"
      minimizeTaskTitle="编辑采集商品"
      minimizeTaskSubtitle={product?.title || product?.sourceProductId || ''}
    >
      <DialogTitle
        component="div"
        sx={{
          minHeight: 72,
          boxSizing: 'border-box',
          py: 0.85,
          pl: 2.25,
          pr: 15,
          bgcolor: '#fff',
          borderBottom: '1px solid #e8ecf3',
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ minHeight: 54 }}>
          <Box
            minWidth={0}
            sx={{
              width: { xs: 220, lg: 270, xl: 310 },
              flex: { xs: '0 0 220px', lg: '0 0 270px', xl: '0 0 310px' },
            }}
          >
            <Typography
              id="collection-product-editor-heading"
              variant="h6"
              fontWeight={850}
              noWrap
              sx={{ fontSize: 18, lineHeight: 1.3, letterSpacing: '-0.01em', color: '#1f2a44' }}
            >编辑采集商品</Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ display: 'block', mt: 0.25, maxWidth: { xs: 210, lg: 260, xl: 300 } }}
            >{product?.title || product?.sourceProductId}</Typography>
          </Box>
          <Tabs
            value={listing.step}
            onChange={(_event, value) => listing.setStep(value)}
            variant="fullWidth"
            sx={{
              minHeight: 54,
              flex: 1,
              '& .MuiTabs-flexContainer': { height: 54 },
              '& .MuiTabs-indicator': { height: 3, borderRadius: '3px 3px 0 0', bgcolor: '#5b82ff' },
              '& .MuiTab-root': {
                minHeight: 54,
                color: '#8792a8',
                textTransform: 'none',
                whiteSpace: 'nowrap',
                lineHeight: 1.2,
                transition: 'color 160ms ease',
              },
              '& .MuiTab-root.Mui-selected': { color: '#4f74e8', fontWeight: 800 },
              '& .MuiTab-iconWrapper': { color: 'inherit' },
            }}
          >
            {listing.steps.map((item, index) => (
              <Tab
                key={item.id}
                value={item.id}
                icon={index < stepIndex ? <CheckCircleRounded color="success" fontSize="small" /> : STEP_ICONS[item.id]}
                iconPosition="start"
                label={item.label}
                aria-label={item.id === 'setup' ? '类目与商品属性' : item.id === 'skus' ? 'SKU 编辑与价格' : item.label}
                sx={{ py: 0.35, px: { xs: 0.35, lg: 0.75 }, minWidth: 0, opacity: index > stepIndex + 1 ? 0.5 : 1, fontSize: { xs: 12.25, lg: 13.5 } }}
              />
            ))}
          </Tabs>
          <Chip
            size="small"
            label={`${draft.skus.length} SKU`}
            variant="outlined"
            sx={{ height: 30, borderRadius: 1, borderColor: '#d9dfeb', bgcolor: '#fff', fontWeight: 800 }}
          />
        </Stack>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 0, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
        <CollectionProductEditorSidebar
          product={product} draft={draft}
          textModelOptions={textModelOptions} imageModelOptions={imageModelOptions}
          imageSizeOptions={SMART_TOOL_IMAGE_SIZE_OPTIONS} imageQualityOptions={SMART_TOOL_IMAGE_QUALITY_OPTIONS}
          onChange={change}
        />
        <Box
          component="section"
          aria-label={title}
          sx={{ minWidth: 0, minHeight: 0, flex: 1, bgcolor: '#f6f8fc', overflow: 'hidden' }}
        >
          {listing.step === 'setup' ? (
            <CollectionProductSetupStep
              draft={listing.draft}
              categoryOptions={listing.categoryOptions} categoryState={listing.categoryState}
              categoryTemplateState={listing.categoryTemplateState}
              definitions={listing.definitions} optionsByAttributeId={listing.attributeOptions} attributeState={listing.attributeState}
              attributeAutofillState={listing.attributeAutofillState}
              onChange={listing.update} onSelectCategory={listing.selectCategory}
              onPreviewCategoryTemplate={listing.previewCategoryTemplate} onChangeAttribute={listing.updateAttribute}
              onSearchAttributeOptions={listing.searchAttributeOptions}
              onReloadAttributes={listing.reloadAttributes}
              onAnalyzeAndFill={listing.analyzeAndFillAttributes}
            />
          ) : null}
          {listing.step === 'images' ? (
            <CollectionProductImageWorkspace
              draft={draft}
              originalImageSelections={listing.draft.originalImageSelections}
              generatedImageSelections={listing.draft.generatedImageSelections}
              generationState={listing.generationState}
              imageHistory={listing.imageHistory}
              imageSkillState={imageSkillState}
              onGenerate={(input) => listing.generateImages({
                ...input,
                sourceProduct: { ...product, ...draft },
                editorSettings: draft.editorSettings,
              })}
              onRestoreHistory={listing.restoreImageHistoryBatch}
              onToggleOriginalImage={(input) => listing.updateOriginalImageSelection({ ...input, sourceProduct: { ...product, ...draft } })}
              onToggleGeneratedImage={(input) => listing.updateGeneratedImageSelection({ ...input, sourceProduct: { ...product, ...draft } })}
              onRemoveGeneratedImage={(input) => listing.removeGeneratedImage({ ...input, sourceProduct: { ...product, ...draft } })}
              onChangeImages={(changes) => {
                const nextDraft = { ...draft, ...changes };
                setDraft(nextDraft);
                listing.refreshImageUploadPayload({ ...product, ...nextDraft });
              }}
            />
          ) : null}
          {listing.step === 'skus' ? (
            shops.length ? (
              <CollectionProductSkuPriceStep
                product={product}
                draft={listing.draft}
                shops={shops}
                selectedShopIds={listing.draft.uploadShopIds || [listing.draft.shopId].filter(Boolean)}
                warehousesByShopId={batchStock.warehousesByShopId}
                warehouseStatesByShopId={batchStock.warehouseStatesByShopId}
                definitions={listing.definitions}
                optionsByAttributeId={listing.attributeOptions}
                onChange={listing.update}
                onChangeSku={listing.updateSku}
                onChangeSkuAttribute={listing.updateSkuAttribute}
                onSearchAttributeOptions={listing.searchAttributeOptions}
                onReloadWarehouses={batchStock.reloadWarehouses}
                onApplyBatchStock={batchStock.applyBatchStock}
                onChangeSelectedShops={listing.updateUploadShopIds}
                pricing={pricing}
              />
            ) : (
              <CollectionProductSkuWorkspace
                skus={draft.skus}
                onChange={(skus) => setDraft((current) => ({ ...current, skus, skuImages: syncSkuImages(skus, current.skuImages) }))}
              />
            )
          ) : null}
          {listing.step === 'preview' ? (
            <CollectionProductListingPreviewStep
              preview={listing.preview} state={listing.listingState}
              selectedShopIds={listing.draft.uploadShopIds || [listing.draft.shopId].filter(Boolean)}
              onCreatePreview={createListingPreview}
              onCancelPreview={listing.cancelPreview}
              onSubmit={listing.submit}
            />
          ) : null}
          {listing.step === 'readback' ? (
            <CollectionProductListingReadbackStep
              state={listing.listingState}
              onBackToPreview={() => listing.setStep('preview')}
              onResumeReadBack={listing.resumeReadBack}
            />
          ) : null}
        </Box>
      </DialogContent>

      <DialogActions
        sx={{
          px: 2,
          py: 0.75,
          minHeight: 58,
          bgcolor: '#fff',
          borderTop: '1px solid #e5eaf2',
          boxShadow: '0 -8px 24px rgba(15, 23, 42, 0.04)',
          '& .MuiButton-root': { borderRadius: 1, minHeight: 36, px: 1.6, fontWeight: 750, boxShadow: 'none' },
        }}
      >
        <Button
          color="error" startIcon={<DeleteOutlineRounded />}
          onClick={() => { if (window.confirm(`确定删除“${product?.title || product?.sourceProductId || '该商品'}”吗？`)) onDelete?.(product?.id); }}
          sx={{ mr: 'auto' }}
        >删除商品</Button>
        {listing.stepError ? <Alert severity="warning" sx={{ py: 0, '& .MuiAlert-message': { py: 0.35 } }}>{listing.stepError}</Alert> : null}
        {saveState.error ? <Alert severity="error" sx={{ py: 0, '& .MuiAlert-message': { py: 0.35 } }}>{saveState.error}</Alert> : null}
        {!canSave ? <Typography variant="caption" color="warning.main">来源商品资料还不完整，暂时不能保存。</Typography> : null}
        <Button color="inherit" onClick={onClose}>取消</Button>
        <Button
          variant="outlined"
          startIcon={<SaveRounded />}
          onClick={() => saveSource({ prepareImages: true, feedback: true })}
          disabled={!canSave || saveState.status === 'saving'}
        >{saveState.status === 'saving' ? '保存中…' : saveState.status === 'success' ? '已保存' : '保存修改'}</Button>
        {stepIndex > 0 && listing.step !== 'readback' ? <Button startIcon={<ArrowBackRounded />} onClick={() => listing.move(-1)}>上一步</Button> : null}
        {stepIndex >= 0 && stepIndex < listing.steps.length - 2 ? (
          <Button
            variant="contained"
            endIcon={<ArrowForwardRounded />}
            onClick={() => {
              const nextStep = listing.steps[stepIndex + 1]?.id;
              if (nextStep !== 'preview') void saveSource();
              listing.move(1);
            }}
          >下一步</Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

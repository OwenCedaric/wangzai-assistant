import CloseRounded from '@mui/icons-material/CloseRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import SwapHorizRounded from '@mui/icons-material/SwapHorizRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { PromptLibraryImageGenerationRun } from './PromptLibraryImageGenerationRun.jsx';
import { PromptLibraryStandardRun } from './PromptLibraryStandardRun.jsx';
import { usesActiveOzonProductQueryProfile } from '../lib/smartToolOzonBrowserDataProfiles.js';
import { PROFIT_ORDER_REVIEW_SKILL_ID } from '../../profitReview/constants/profitOrderReviewContract.js';
import { normalizeOzonShopOption } from '../../../shared/ozon/ozonShopOption.js';
import {
  getSmartToolSkillExecutionState,
  SMART_TOOL_ADAPTER_STATUS,
  SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY,
} from '../lib/smartToolAdapterRegistry.js';
import { getSmartToolExecutionPlan } from '../lib/smartToolExecutionPlan.js';
import { isUserInstalledSmartTool } from '../lib/smartToolInstalledSkill.js';
import {
  isSmartToolProductImageWorkbench,
  resolveSmartToolWorkbench,
  SMART_TOOL_WORKBENCH_KIND,
} from '../lib/smartToolWorkbenchRegistry.js';

const ProfitOrderReviewRun = React.lazy(() =>
  import('../../profitReview/components/ProfitOrderReviewRun.jsx').then((module) => ({
    default: module.ProfitOrderReviewRun,
  }))
);

export function PromptLibraryQuickRunPanel({
  open = false,
  onClose = () => {},
  selectedPrompt,
  selectedShop = null,
  availableShops = [],
  onSelectedShopChange = () => {},
  usageInputs = [],
  values = {},
  draft,
  browserDataEnabled = false,
  externalDataEnabled = false,
  performanceAdEnabled = false,
  operationalWorkflowEnabled = false,
  operationalAnalysisRequired = false,
  genericRuntimeEnabled = false,
  externalInsight = null,
  onChangeValue = () => {},
  onRunDraft = () => {},
  onClearDraft = () => {},
  onGenerateExternalInsight = () => {},
  onOpenOzonProduct = null,
  productSelection = {},
  shops = [],
  imageModelOptions = [],
  textModelOptions = [],
  imageGeneration = null,
  imagePromptPlan = null,
  productDescription = null,
  imageGenerationHistory = [],
  onGenerateImage = () => {},
  onCancelImagePlan = () => {},
  onGenerateDescription = () => {},
  onReplaceImages = async () => {},
  onReplaceDescription = async () => {},
}) {
  const [imageWorkspaceMode, setImageWorkspaceMode] = React.useState('image');
  const [imageHistoryOpen, setImageHistoryOpen] = React.useState(false);
  const [imageHistoryCount, setImageHistoryCount] = React.useState(0);

  const isUserInstalled = isUserInstalledSmartTool(selectedPrompt || {});
  const workbench = React.useMemo(() => resolveSmartToolWorkbench(selectedPrompt || {}), [selectedPrompt]);
  const isInstalledProductContentWorkbench =
    isUserInstalled && workbench.kind === SMART_TOOL_WORKBENCH_KIND.PRODUCT_CONTENT;
  const usesInstalledProductImageWorkspace = isUserInstalled && isSmartToolProductImageWorkbench(workbench);
  const isNativeImageGeneration = selectedPrompt?.id === 'ozon-product-image-generation';
  const usesImageGenerationRun = isNativeImageGeneration || isInstalledProductContentWorkbench;
  const selectedWorkbenchMode = String(values?.[workbench.modeInputLabel] || '')
    .trim()
    .toLowerCase();
  const preferredProductContentMode =
    /(?:step3|seo|post-launch|复盘|文案)/iu.test(selectedWorkbenchMode) &&
    !/(?:step4|image|图片|生图|full)/iu.test(selectedWorkbenchMode)
      ? 'attributes'
      : 'image';

  React.useEffect(() => {
    if (open && usesImageGenerationRun) {
      setImageWorkspaceMode(isInstalledProductContentWorkbench ? preferredProductContentMode : 'image');
      setImageHistoryOpen(false);
      return;
    }
    setImageHistoryOpen(false);
  }, [
    isInstalledProductContentWorkbench,
    open,
    preferredProductContentMode,
    selectedPrompt?.id,
    usesImageGenerationRun,
  ]);

  if (!selectedPrompt) return null;

  const isImageGeneration = selectedPrompt.id === 'ozon-product-image-generation';
  const isProfitOrderReview = selectedPrompt.id === PROFIT_ORDER_REVIEW_SKILL_ID;
  const isOzonProductAnalysis = usesActiveOzonProductQueryProfile(selectedPrompt);
  const draftResult = isImageGeneration ? draft?.result : null;
  const selectedShopOption = normalizeOzonShopOption(selectedShop || {});
  const adapterState = getSmartToolSkillExecutionState(selectedPrompt);
  const executionPlan = getSmartToolExecutionPlan(selectedPrompt);
  const genericRuntimeAvailable =
    isUserInstalled &&
    (genericRuntimeEnabled ||
      (adapterState.adapterKey === SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY && executionPlan.canStart === true));
  const dialogTitlePrefix =
    isUserInstalled &&
    (adapterState.status === SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER ||
      adapterState.status === SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED)
      ? 'Skill 接入状态'
      : isUserInstalled && adapterState.status === SMART_TOOL_ADAPTER_STATUS.PREVIEW_READY
        ? '本地预览'
        : genericRuntimeAvailable
          ? '运行 Skill'
          : '使用功能';

  const handleRunDraft = (runtimeSelection) => {
    onRunDraft(runtimeSelection);
  };

  const handleClearDraft = () => {
    onClearDraft();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      className={`prompt-library-run-dialog${usesImageGenerationRun ? ' is-image-generation' : ' is-standard-skill'}${usesInstalledProductImageWorkspace ? ' is-installed-product-image-workspace' : ''}${isOzonProductAnalysis ? ' is-ozon-product-analysis' : ''}${isProfitOrderReview ? ' is-profit-order-review' : ''}${externalDataEnabled ? ' is-external-data' : ''}${isUserInstalled ? ' is-user-installed-skill' : ''}`}
    >
      <DialogTitle component="div">
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Box minWidth={0}>
            <Typography variant="h6">
              {dialogTitlePrefix}：{selectedPrompt.title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {selectedPrompt.goal}
            </Typography>
            {selectedShopOption.shopId ? (
              <Typography variant="caption" color="primary.main" fontWeight={700}>
                当前店铺：{selectedShopOption.displayName}
              </Typography>
            ) : null}
          </Box>
          {usesImageGenerationRun ? (
            <Stack
              direction="row"
              spacing={0.75}
              alignItems="center"
              className="prompt-library-image-dialog-title-actions"
            >
              <Button
                size="small"
                variant="outlined"
                startIcon={<HistoryRounded />}
                className="prompt-library-image-history-button"
                onClick={() => setImageHistoryOpen(true)}
              >
                生图历史{imageHistoryCount ? ` (${imageHistoryCount})` : ''}
              </Button>
              {isNativeImageGeneration || (isInstalledProductContentWorkbench && workbench.supportsListingFields) ? (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<SwapHorizRounded />}
                  className="prompt-library-image-mode-switch-button"
                  onClick={() => setImageWorkspaceMode((current) => (current === 'image' ? 'attributes' : 'image'))}
                >
                  {imageWorkspaceMode === 'image' ? '编辑文案与属性' : '返回图片工作台'}
                </Button>
              ) : null}
              <IconButton size="small" aria-label="关闭使用功能" onClick={onClose}>
                <CloseRounded />
              </IconButton>
            </Stack>
          ) : (
            <IconButton size="small" aria-label="关闭使用功能" onClick={onClose}>
              <CloseRounded />
            </IconButton>
          )}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {usesImageGenerationRun ? (
          <PromptLibraryImageGenerationRun
            values={values}
            selectedPrompt={selectedPrompt}
            modelOptions={imageModelOptions}
            textModelOptions={textModelOptions}
            shops={shops}
            selectedShop={selectedShop}
            availableShops={availableShops}
            onSelectedShopChange={onSelectedShopChange}
            productSelection={productSelection}
            draft={draft}
            imageGeneration={imageGeneration}
            imagePromptPlan={imagePromptPlan}
            productDescription={productDescription}
            imageGenerationHistory={imageGenerationHistory}
            workspaceMode={imageWorkspaceMode}
            historyOpen={imageHistoryOpen}
            onCloseHistory={() => setImageHistoryOpen(false)}
            onHistoryCountChange={setImageHistoryCount}
            onChangeValue={onChangeValue}
            onRunDraft={handleRunDraft}
            onClearDraft={handleClearDraft}
            onGenerateImage={onGenerateImage}
            onCancelImagePlan={onCancelImagePlan}
            onGenerateDescription={onGenerateDescription}
            onReplaceImages={onReplaceImages}
            onReplaceDescription={onReplaceDescription}
            workbench={isInstalledProductContentWorkbench ? workbench : {}}
          />
        ) : isProfitOrderReview ? (
          <React.Suspense fallback={null}>
            <ProfitOrderReviewRun selectedPrompt={selectedPrompt} shops={shops} modelOptions={textModelOptions} />
          </React.Suspense>
        ) : (
          <PromptLibraryStandardRun
            selectedPrompt={selectedPrompt}
            selectedShop={selectedShop}
            shops={availableShops}
            onSelectedShopChange={onSelectedShopChange}
            productSelection={productSelection}
            usageInputs={usageInputs}
            values={values}
            onChangeValue={onChangeValue}
            draft={draft}
            browserDataEnabled={browserDataEnabled}
            externalDataEnabled={externalDataEnabled}
            performanceAdEnabled={performanceAdEnabled}
            operationalWorkflowEnabled={operationalWorkflowEnabled}
            operationalAnalysisRequired={operationalAnalysisRequired}
            genericRuntimeEnabled={genericRuntimeAvailable}
            externalInsight={externalInsight}
            onRunDraft={handleRunDraft}
            onClearDraft={handleClearDraft}
            onGenerateExternalInsight={onGenerateExternalInsight}
            onOpenOzonProduct={onOpenOzonProduct}
            imageModelOptions={imageModelOptions}
            textModelOptions={textModelOptions}
          />
        )}
      </DialogContent>
      {!isProfitOrderReview ? (
        <DialogActions>
          {draftResult ? (
            <Button size="small" variant="outlined" onClick={handleClearDraft}>
              清空预览
            </Button>
          ) : null}
          <Button size="small" variant="contained" onClick={onClose}>
            关闭
          </Button>
        </DialogActions>
      ) : null}
    </Dialog>
  );
}

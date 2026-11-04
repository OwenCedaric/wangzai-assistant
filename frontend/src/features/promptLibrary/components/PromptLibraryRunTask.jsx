import React from 'react';
import { usePromptLibraryExecution } from '../model/usePromptLibraryExecution.js';
import { useSmartToolProductSelection } from '../model/useSmartToolProductSelection.js';
import { PromptLibraryQuickRunPanel } from './PromptLibraryQuickRunPanel.jsx';
import { hasSmartToolBoundProductInput } from '../lib/smartToolUsageBindings.js';
import { resolveSmartToolWorkbench, SMART_TOOL_WORKBENCH_KIND } from '../lib/smartToolWorkbenchRegistry.js';

function shopIdOf(shop = {}) {
  return String(shop?.id || shop?.shopId || '').trim();
}

export function PromptLibraryRunTask({
  session,
  shops = [],
  imageModelOptions = [],
  modelOptions = [],
  onClose = () => {},
  onOpenOzonProduct = null,
  onReplaceImages = async () => {},
  onReplaceDescription = async () => {},
}) {
  const selectedPrompt = session?.prompt || null;
  const availableShops = React.useMemo(
    () => (shops.length ? shops : session?.shop ? [session.shop] : []),
    [session?.shop, shops]
  );
  const [selectedShopId, setSelectedShopId] = React.useState(() => shopIdOf(session?.shop));
  React.useEffect(() => {
    setSelectedShopId(shopIdOf(session?.shop) || shopIdOf(availableShops[0]));
  }, [availableShops, session?.id, session?.shop]);
  const selectedShop = React.useMemo(
    () => availableShops.find((shop) => shopIdOf(shop) === selectedShopId) || availableShops[0] || null,
    [availableShops, selectedShopId]
  );
  const scopedShops = React.useMemo(() => (selectedShop ? [selectedShop] : []), [selectedShop]);
  const workbench = React.useMemo(() => resolveSmartToolWorkbench(selectedPrompt || {}), [selectedPrompt]);
  const promptExecution = usePromptLibraryExecution(selectedPrompt, {
    shop: selectedShop,
    availableTools: session?.availableTools || [],
  });
  const imageProductSelection = useSmartToolProductSelection({
    enabled:
      selectedPrompt?.id === 'ozon-product-image-generation' ||
      workbench.kind === SMART_TOOL_WORKBENCH_KIND.PRODUCT_CONTENT ||
      hasSmartToolBoundProductInput(selectedPrompt),
    shops: scopedShops,
  });
  if (!selectedPrompt || !session?.id) return null;

  return (
    <PromptLibraryQuickRunPanel
      open
      onClose={() => onClose(session.id)}
      selectedPrompt={selectedPrompt}
      selectedShop={selectedShop}
      availableShops={availableShops}
      onSelectedShopChange={(nextShop) => setSelectedShopId(shopIdOf(nextShop))}
      usageInputs={promptExecution.usageInputs}
      values={promptExecution.values}
      draft={promptExecution.draft}
      browserDataEnabled={promptExecution.browserDataEnabled}
      externalDataEnabled={promptExecution.externalDataEnabled}
      performanceAdEnabled={promptExecution.performanceAdEnabled}
      operationalWorkflowEnabled={promptExecution.operationalWorkflowEnabled}
      operationalAnalysisRequired={promptExecution.operationalAnalysisRequired}
      genericRuntimeEnabled={promptExecution.genericRuntimeEnabled}
      externalInsight={promptExecution.externalInsight}
      onChangeValue={promptExecution.onChangeValue}
      onRunDraft={promptExecution.onRunDraft}
      onClearDraft={promptExecution.onClearDraft}
      onGenerateExternalInsight={promptExecution.onGenerateExternalInsight}
      onOpenOzonProduct={onOpenOzonProduct}
      productSelection={imageProductSelection}
      shops={scopedShops}
      imageModelOptions={imageModelOptions}
      textModelOptions={modelOptions}
      imageGeneration={promptExecution.imageGeneration}
      imagePromptPlan={promptExecution.imagePromptPlan}
      productDescription={promptExecution.productDescription}
      imageGenerationHistory={promptExecution.imageGenerationHistory}
      onGenerateImage={promptExecution.onGenerateImage}
      onCancelImagePlan={promptExecution.onCancelImagePlan}
      onGenerateDescription={promptExecution.onGenerateDescription}
      onReplaceImages={onReplaceImages}
      onReplaceDescription={onReplaceDescription}
    />
  );
}

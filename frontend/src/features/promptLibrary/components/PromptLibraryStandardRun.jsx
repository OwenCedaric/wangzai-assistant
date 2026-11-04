import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  getSmartToolUsageInputHelperText,
  getSmartToolUsageInputPlaceholder,
  getSmartToolUsageInputSpec,
  getSmartToolUsageInputSpecs,
  validateSmartToolUsageInput,
} from '../lib/smartToolUsage.js';
import { PromptLibraryOzonProductResult } from './PromptLibraryOzonProductResult.jsx';
import { PromptLibraryExternalResultSections } from './PromptLibraryExternalResultSections.jsx';
import { PromptLibraryMarketKeywordResult } from './PromptLibraryMarketKeywordResult.jsx';
import { PromptLibraryExternalProductResult } from './PromptLibraryExternalProductResult.jsx';
import { PromptLibraryRepeatableInputList } from './PromptLibraryRepeatableInputList.jsx';
import { PromptLibrarySeerfarCategoryPicker } from './PromptLibrarySeerfarCategoryPicker.jsx';
import { PromptLibraryExternalInsightReport } from './PromptLibraryExternalInsightReport.jsx';
import { PromptLibraryProductManualInputs } from './PromptLibraryProductManualInputs.jsx';
import { PromptLibraryPerformanceAdInputs } from './PromptLibraryPerformanceAdInputs.jsx';
import { PromptLibraryProductSelectionSources } from './PromptLibraryProductSelectionSources.jsx';
import { PromptLibraryOperationalReportDetails } from './PromptLibraryOperationalReportDetails.jsx';
import { PromptLibraryApiCapabilityStatus } from './PromptLibraryApiCapabilityStatus.jsx';
import { normalizeOzonShopOption } from '../../../shared/ozon/ozonShopOption.js';
import {
  createSmartToolBoundProductValue,
  createSmartToolBoundShopValue,
  isSmartToolBoundProductInput,
  isSmartToolBoundShopInput,
} from '../lib/smartToolUsageBindings.js';
import { PRODUCT_SELECTION_SKILL_ID } from '../constants/productSelectionFreezeContract.js';
import { EXTERNAL_PRODUCT_MANUAL_INPUT_GROUP } from '../lib/smartToolExternalProductManualData.js';
import { usesActiveOzonProductQueryProfile } from '../lib/smartToolOzonBrowserDataProfiles.js';
import {
  getSmartToolSkillExecutionState,
  SMART_TOOL_ADAPTER_STATUS,
  SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY,
} from '../lib/smartToolAdapterRegistry.js';
import { isUserInstalledSmartTool } from '../lib/smartToolInstalledSkill.js';
import { getSmartToolExecutionPlan } from '../lib/smartToolExecutionPlan.js';
import {
  formatSmartToolModelDisplayName,
  resolveSmartToolModelSelection,
  SMART_TOOL_AUTO_MODEL_ID,
  SMART_TOOL_BUILTIN_MODEL_ACCOUNT_ID,
  SMART_TOOL_IMAGE_MODEL_CAPABILITY,
} from '../services/smartToolModelService.js';

function formatRunModelOption(item = {}, genericRuntimeAvailable = false) {
  if (!genericRuntimeAvailable) {
    return `${formatSmartToolModelDisplayName(item.model)} · ${item.statusLabel}`;
  }
  if (item.id === SMART_TOOL_AUTO_MODEL_ID) return '自动选择 · 管理端托管 · 按量积分';
  if (item.accountId === SMART_TOOL_BUILTIN_MODEL_ACCOUNT_ID) {
    return `${item.label || '内置积分文本模型'} · 管理端托管`;
  }
  return `${formatSmartToolModelDisplayName(item.model)} · 自有 API · ${item.statusLabel}`;
}

export function PromptLibraryStandardRun({
  selectedPrompt,
  selectedShop = null,
  shops = [],
  onSelectedShopChange = () => {},
  productSelection = {},
  usageInputs = [],
  values = {},
  onChangeValue = () => {},
  draft = null,
  browserDataEnabled = false,
  externalDataEnabled = false,
  performanceAdEnabled = false,
  operationalWorkflowEnabled = false,
  operationalAnalysisRequired = false,
  genericRuntimeEnabled = false,
  externalInsight = null,
  onRunDraft = () => {},
  onClearDraft = () => {},
  onGenerateExternalInsight = () => {},
  onOpenOzonProduct = null,
  imageModelOptions = [],
  textModelOptions = [],
}) {
  const usesImageModel = selectedPrompt?.skillProfile?.modelCapability === SMART_TOOL_IMAGE_MODEL_CAPABILITY;
  const modelOptions = usesImageModel ? imageModelOptions : textModelOptions;
  const configuredModelId = usesImageModel
    ? selectedPrompt?.promptConfig?.imageModelId || selectedPrompt?.promptConfig?.defaultModelId
    : selectedPrompt?.promptConfig?.defaultModelId;
  const [selectedModelId, setSelectedModelId] = React.useState(configuredModelId || SMART_TOOL_AUTO_MODEL_ID);
  const [selectedImageModelId, setSelectedImageModelId] = React.useState(SMART_TOOL_AUTO_MODEL_ID);
  const [runAttempted, setRunAttempted] = React.useState(false);
  const [externalWorkspaceMode, setExternalWorkspaceMode] = React.useState('data');
  const shopOptions = React.useMemo(() => {
    const sourceShops = shops.length ? shops : selectedShop ? [selectedShop] : [];
    const seen = new Set();
    return sourceShops
      .map((shop) => ({ ...normalizeOzonShopOption(shop), sourceShop: shop }))
      .filter((shop) => shop.shopId && !seen.has(shop.shopId) && seen.add(shop.shopId));
  }, [selectedShop, shops]);
  const boundShopInput = usageInputs.find(isSmartToolBoundShopInput) || '';
  const boundProductInput = usageInputs.find(isSmartToolBoundProductInput) || '';
  const selectedShopOption = normalizeOzonShopOption(selectedShop || {});

  React.useEffect(() => {
    if (!boundShopInput || !selectedShopOption.shopId) return;
    const boundValue = createSmartToolBoundShopValue(selectedShop || {});
    if (values[boundShopInput] !== boundValue) onChangeValue(boundShopInput, boundValue);
  }, [boundShopInput, onChangeValue, selectedShop, selectedShopOption.shopId, values]);

  React.useEffect(() => {
    if (!boundProductInput || productSelection.selectedProduct) return;
    if (values[boundProductInput]) onChangeValue(boundProductInput, '');
  }, [boundProductInput, onChangeValue, productSelection.selectedProduct, selectedShopOption.shopId, values]);

  React.useEffect(() => {
    setSelectedModelId(configuredModelId || SMART_TOOL_AUTO_MODEL_ID);
    setSelectedImageModelId(SMART_TOOL_AUTO_MODEL_ID);
    setRunAttempted(false);
    setExternalWorkspaceMode('data');
  }, [configuredModelId, selectedPrompt?.id]);

  const modelSelection = resolveSmartToolModelSelection(selectedModelId, modelOptions);
  const imageModelSelection = resolveSmartToolModelSelection(selectedImageModelId, imageModelOptions);
  const result = draft?.result && typeof draft.result === 'object' ? draft.result : null;
  const loading = result?.status === 'loading';
  const isOzonProductSearch = usesActiveOzonProductQueryProfile(selectedPrompt);
  const productSelectionEnabled = selectedPrompt?.id === PRODUCT_SELECTION_SKILL_ID;
  const adapterState = getSmartToolSkillExecutionState(selectedPrompt);
  const executionPlan = getSmartToolExecutionPlan(selectedPrompt);
  const userInstalledSkill = isUserInstalledSmartTool(selectedPrompt);
  const genericRuntimeAvailable = userInstalledSkill && genericRuntimeEnabled && executionPlan.canStart === true;
  const genericRequiresImage = genericRuntimeAvailable && executionPlan.requiresImageExecution;
  const installedSkillSidebarSx = userInstalledSkill
    ? {
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 1.25,
        overflowX: 'hidden',
        overflowY: 'auto',
        scrollbarGutter: 'stable',
        '& > *': { minWidth: 0, flex: '0 0 auto' },
        '& .prompt-library-standard-input-section': {
          display: 'grid',
          minHeight: 'auto',
          gap: 1.25,
          overflow: 'visible',
        },
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-thumb': { borderRadius: 6, backgroundColor: '#cbd5e1' },
      }
    : undefined;
  const adapterBlocked =
    userInstalledSkill &&
    (adapterState.status === SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER ||
      adapterState.status === SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED ||
      (adapterState.adapterKey === SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY && executionPlan.canStart !== true));
  const localPreviewEnabled = userInstalledSkill && adapterState.status === SMART_TOOL_ADAPTER_STATUS.PREVIEW_READY;
  const hasBuiltInUsageGuide = getSmartToolUsageInputSpecs(selectedPrompt).length > 0;
  const usageValidationErrors = React.useMemo(
    () =>
      Object.fromEntries(
        usageInputs.map((label) => [label, validateSmartToolUsageInput(selectedPrompt, label, values[label])])
      ),
    [selectedPrompt, usageInputs, values]
  );
  const productManualInputSpecs = React.useMemo(
    () =>
      usageInputs
        .map((label) => getSmartToolUsageInputSpec(selectedPrompt, label))
        .filter((item) => item?.group === EXTERNAL_PRODUCT_MANUAL_INPUT_GROUP),
    [selectedPrompt, usageInputs]
  );
  const handleRunDraft = React.useCallback(() => {
    if (adapterBlocked) return;
    if (Object.values(usageValidationErrors).some(Boolean)) {
      setRunAttempted(true);
      return;
    }
    if (
      (performanceAdEnabled || productSelectionEnabled || operationalAnalysisRequired || genericRuntimeAvailable) &&
      !modelSelection.ready
    ) {
      setRunAttempted(true);
      return;
    }
    if (genericRequiresImage && !imageModelSelection.ready) {
      setRunAttempted(true);
      return;
    }
    setRunAttempted(false);
    const runtimeSelection =
      performanceAdEnabled || operationalWorkflowEnabled || productSelectionEnabled || genericRuntimeAvailable
        ? {
            ...modelSelection,
            ...(genericRuntimeAvailable
              ? {
                  runtimeContext: {
                    selectedShop,
                    selectedProduct: productSelection.selectedProduct || null,
                    selectedSku: productSelection.selectedSku || null,
                  },
                  imageModelSelection,
                }
              : {}),
          }
        : undefined;
    onRunDraft(runtimeSelection);
  }, [
    adapterBlocked,
    genericRuntimeAvailable,
    genericRequiresImage,
    imageModelSelection,
    modelSelection,
    onRunDraft,
    operationalAnalysisRequired,
    operationalWorkflowEnabled,
    performanceAdEnabled,
    productSelection.selectedProduct,
    productSelection.selectedSku,
    productSelectionEnabled,
    selectedShop,
    usageValidationErrors,
  ]);
  const handleBoundShopChange = React.useCallback(
    (event) => {
      const nextShop = shopOptions.find((shop) => shop.shopId === event.target.value);
      if (!nextShop) return;
      onClearDraft();
      productSelection.onSelectProduct?.(null);
      if (boundProductInput) onChangeValue(boundProductInput, '');
      onSelectedShopChange(nextShop.sourceShop);
      if (boundShopInput) onChangeValue(boundShopInput, createSmartToolBoundShopValue(nextShop.sourceShop));
    },
    [
      boundProductInput,
      boundShopInput,
      onChangeValue,
      onClearDraft,
      onSelectedShopChange,
      productSelection,
      shopOptions,
    ]
  );
  const handleBoundProductChange = React.useCallback(
    (_event, product) => {
      onClearDraft();
      productSelection.onSelectProduct?.(product);
      const sku = product?.skuOptions?.[0] || null;
      onChangeValue(boundProductInput, product ? createSmartToolBoundProductValue(product, sku) : '');
    },
    [boundProductInput, onChangeValue, onClearDraft, productSelection]
  );
  const handleBoundSkuChange = React.useCallback(
    (event) => {
      const sku = productSelection.selectedProduct?.skuOptions?.find((item) => item.id === event.target.value) || null;
      productSelection.onSelectSku?.(event.target.value);
      onChangeValue(boundProductInput, createSmartToolBoundProductValue(productSelection.selectedProduct, sku));
    },
    [boundProductInput, onChangeValue, productSelection]
  );
  const hasOzonProductAnalysis =
    isOzonProductSearch &&
    Boolean(
      result?.productAnalysis ||
      result?.targetProduct ||
      result?.productLinkStatus ||
      result?.sourceProduct ||
      result?.sourceProductLinkStatus
    );
  const externalAnalysis = result?.keywordAnalysis || result?.externalAnalysis;
  const hasExternalAnalysisData =
    externalDataEnabled && !loading && Array.isArray(externalAnalysis?.records) && externalAnalysis.records.length > 0;
  const externalResultIdentity = externalDataEnabled
    ? `${selectedPrompt?.id || ''}:${draft?.createdAt || ''}:${result?.status || ''}:${externalAnalysis?.records?.length || 0}`
    : '';

  React.useEffect(() => {
    if (!externalDataEnabled) return;
    setExternalWorkspaceMode('data');
  }, [externalDataEnabled, externalResultIdentity]);

  const handleGenerateExternalInsight = React.useCallback(() => {
    if (!hasExternalAnalysisData || !modelSelection.ready) return;
    setExternalWorkspaceMode('analysis');
    onGenerateExternalInsight(modelSelection);
  }, [hasExternalAnalysisData, modelSelection, onGenerateExternalInsight]);
  const targetProduct = isOzonProductSearch && result?.targetProduct ? result.targetProduct : null;
  const severity =
    result?.status === 'browser_data_ready' || result?.status === 'ready'
      ? 'success'
      : result?.status === 'browser_data_error' ||
          result?.status === 'external_data_error' ||
          result?.status === 'performance_data_error' ||
          result?.status === 'partial_ready'
        ? 'warning'
        : 'info';

  if (adapterBlocked) {
    const guardRequired = adapterState.status === SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED;
    const requirementRows = guardRequired
      ? [
          '接入对应业务模块，不能从智能工具页直接写业务数据。',
          '固定执行链：预览 → 用户确认 → 提交 → 平台回读 → 审计记录。',
          '提交失败、取消、重试和回读不一致都要有明确状态。',
        ]
      : [
          '登记专用 adapterKey 和版本。',
          '定义普通输入、结构化输出、权限、超时、取消和重试规则。',
          '在 services 层实现并通过测试后，才会开放运行按钮。',
        ];
    return (
      <Box className="prompt-library-image-run-shell prompt-library-standard-run-shell">
        <Box
          component="aside"
          className="prompt-library-image-fixed-sidebar prompt-library-standard-fixed-sidebar"
          sx={installedSkillSidebarSx}
        >
          <Box className="prompt-library-image-sidebar-title">
            <Typography variant="subtitle1">Skill 接入状态</Typography>
            <Typography variant="body2" color="text.secondary">
              当前 Skill 已安装，但不会伪装成可以运行。
            </Typography>
          </Box>
          <Alert severity="warning">
            <Typography variant="subtitle2">{adapterState.statusLabel}</Typography>
            <Typography variant="body2">{adapterState.reason}</Typography>
          </Alert>
          <Box className="prompt-library-image-fixed-rules prompt-library-standard-skill-summary">
            <Typography variant="subtitle2">当前登记</Typography>
            <Typography variant="body2">适配器：{adapterState.adapterKey || '未登记'}</Typography>
            <Typography variant="body2">适配器版本：{adapterState.adapterVersion}</Typography>
            <Typography variant="body2">运行类型：{adapterState.runType || '未声明'}</Typography>
          </Box>
          {userInstalledSkill ? (
            <PromptLibraryApiCapabilityStatus
              match={selectedPrompt?.toolMeta?.apiCapabilityMatch}
              compact
              showRegistryTotal
            />
          ) : null}
        </Box>

        <Box component="section" className="prompt-library-standard-empty-workspace" aria-label="Skill 接入要求">
          <Stack spacing={2} sx={{ p: 2.25, height: '100%', overflow: 'auto' }}>
            <Box>
              <Typography variant="subtitle1">{guardRequired ? '业务安全接入要求' : '适配器接入要求'}</Typography>
              <Typography variant="body2" color="text.secondary">
                完成下面的接入和回归测试后，运行入口才会自动开放。
              </Typography>
            </Box>
            <Alert severity="info">
              {requirementRows.map((row, index) => (
                <Typography key={`${row}-${index}`} variant="body2">
                  {index + 1}. {row}
                </Typography>
              ))}
            </Alert>
            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                Skill 用途
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {selectedPrompt?.goal || selectedPrompt?.body || '等待补充功能说明'}
              </Typography>
            </Box>
          </Stack>
        </Box>
      </Box>
    );
  }

  return (
    <Box className="prompt-library-image-run-shell prompt-library-standard-run-shell">
      <Box
        component="aside"
        className="prompt-library-image-fixed-sidebar prompt-library-standard-fixed-sidebar"
        sx={installedSkillSidebarSx}
      >
        <Box className="prompt-library-image-sidebar-title">
          <Typography variant="subtitle1">使用前设置</Typography>
          <Typography variant="body2" color="text.secondary">
            {browserDataEnabled
              ? performanceAdEnabled
                ? '选择推广账号、广告计划和统计范围；每次运行都读取 Performance API 真实数据。'
                : externalDataEnabled
                  ? '填写查询条件；每次点击只执行一次真实数据查询。'
                  : productSelectionEnabled
                    ? '输入商品线索；Ozon 数据为基础，可按需增加 Seerfar 复核和 1688 候选货源。'
                    : isOzonProductSearch
                      ? '输入关键词或者链接，任意填写一个即可开始分析。'
                      : hasBuiltInUsageGuide
                        ? '按下方提示填写；需要多个条件时点击＋继续增加。'
                        : '填写筛选条件；运行时只读取插件已经捕获的数据。'
              : localPreviewEnabled
                ? '填写当前 Skill 需要的信息，然后在右侧生成本地结构化预览。'
                : genericRuntimeAvailable
                  ? '店铺、商品和已配置接口会自动绑定；填写剩余信息后直接运行 Skill。'
                  : '填写当前 Skill 需要的信息，然后在右侧生成本地结果。'}
          </Typography>
        </Box>

        {localPreviewEnabled ? (
          <Box className="prompt-library-image-fixed-section prompt-library-image-model-section">
            <Typography variant="subtitle2">运行方式</Typography>
            <Alert severity="info" icon={false}>
              本地流程预览，不调用模型、不访问外部接口，也不会修改 Ozon 数据。
            </Alert>
          </Box>
        ) : (
          <Box className="prompt-library-image-fixed-section prompt-library-image-model-section">
            <Typography variant="subtitle2">
              {genericRuntimeAvailable
                ? 'Skill 执行模型'
                : externalDataEnabled || performanceAdEnabled || operationalWorkflowEnabled || productSelectionEnabled
                  ? '分析模型'
                  : '模型'}
            </Typography>
            <TextField
              size="small"
              select
              fullWidth
              label={
                operationalAnalysisRequired
                  ? '分析模型'
                  : genericRuntimeAvailable
                    ? '执行模型'
                    : operationalWorkflowEnabled
                      ? '分析模型（可选）'
                      : externalDataEnabled || performanceAdEnabled || productSelectionEnabled
                        ? '分析模型'
                        : usesImageModel
                          ? '图片处理模型'
                          : '分析 / 文案模型'
              }
              value={modelSelection.id}
              onChange={(event) => setSelectedModelId(event.target.value)}
            >
              {modelOptions.length ? (
                modelOptions.map((item) => (
                  <MenuItem key={item.id} value={item.id} disabled={!item.ready}>
                    {formatRunModelOption(item, genericRuntimeAvailable)}
                  </MenuItem>
                ))
              ) : (
                <MenuItem value={SMART_TOOL_AUTO_MODEL_ID}>未读取到可用模型</MenuItem>
              )}
            </TextField>
            {genericRuntimeAvailable ? (
              <Typography variant="caption" color="text.secondary">
                自动选择由管理后台托管，后台更换接口地址后下一次运行立即生效；选择“自有 API”时只使用本机配置。
              </Typography>
            ) : null}
            {genericRequiresImage ? (
              <>
                <TextField
                  size="small"
                  select
                  fullWidth
                  label="图片生成模型"
                  value={imageModelSelection.id}
                  onChange={(event) => setSelectedImageModelId(event.target.value)}
                >
                  {imageModelOptions.map((item) => (
                    <MenuItem key={item.id} value={item.id} disabled={!item.ready}>
                      {item.id === SMART_TOOL_AUTO_MODEL_ID
                        ? '自动选择 · 自有优先，积分兜底'
                        : `${formatSmartToolModelDisplayName(item.model)} · ${item.statusLabel}`}
                    </MenuItem>
                  ))}
                </TextField>
                <Typography variant="caption" color="text.secondary">
                  处理模式包含生图时会真实调用该模型；生成结果会逐张保存并展示。
                </Typography>
              </>
            ) : null}
            {(externalDataEnabled || performanceAdEnabled || operationalWorkflowEnabled || productSelectionEnabled) &&
            !modelSelection.ready ? (
              <Typography variant="caption" color="text.secondary">
                {performanceAdEnabled || productSelectionEnabled
                  ? '先在设置里配置文本模型，才能按照 Skill 生成分析报告。'
                  : operationalAnalysisRequired
                    ? '先在设置里配置文本模型，报表读取完成后会直接生成经营分析。'
                    : operationalWorkflowEnabled
                      ? '没有文本模型也能读取商品资料。'
                      : '先在设置里配置文本模型，才能按照 Skill 生成分析报告。'}
              </Typography>
            ) : null}
          </Box>
        )}

        <Box className="prompt-library-image-fixed-section prompt-library-standard-input-section">
          <Typography variant="subtitle2">使用信息</Typography>
          {performanceAdEnabled ? (
            <PromptLibraryPerformanceAdInputs
              selectedPrompt={selectedPrompt}
              selectedShopId={selectedShop?.id || selectedShop?.shopId || ''}
              values={values}
              validationErrors={usageValidationErrors}
              runAttempted={runAttempted}
              onChangeValue={onChangeValue}
            />
          ) : usageInputs.length ? (
            usageInputs.map((label) => {
              const inputSpec = getSmartToolUsageInputSpec(selectedPrompt, label);
              const validationError = usageValidationErrors[label];
              const placeholder = getSmartToolUsageInputPlaceholder(label, selectedPrompt);
              const helperText = getSmartToolUsageInputHelperText(selectedPrompt, label, values[label]);
              if (isSmartToolBoundShopInput(label)) {
                return (
                  <TextField
                    key={label}
                    className="prompt-library-standard-usage-field"
                    size="small"
                    select
                    label={label}
                    value={selectedShopOption.shopId || ''}
                    helperText={
                      shopOptions.length
                        ? '直接读取已配置店铺；市场和语言随店铺自动带出。'
                        : '暂时没有已配置店铺，请先在店铺设置中绑定。'
                    }
                    onChange={handleBoundShopChange}
                    disabled={!shopOptions.length}
                    fullWidth
                  >
                    {shopOptions.map((shop) => (
                      <MenuItem key={shop.shopId} value={shop.shopId}>
                        {shop.displayName}
                      </MenuItem>
                    ))}
                  </TextField>
                );
              }
              if (isSmartToolBoundProductInput(label)) {
                const selectedProduct = productSelection.selectedProduct || null;
                const selectedSku = productSelection.selectedSku || null;
                return (
                  <Box key={label} sx={{ display: 'grid', gap: 1 }}>
                    <Autocomplete
                      size="small"
                      options={productSelection.products || []}
                      value={selectedProduct}
                      loading={productSelection.loading === true}
                      onChange={handleBoundProductChange}
                      isOptionEqualToValue={(option, value) => option.id === value.id}
                      getOptionLabel={(option) =>
                        [option.title, option.offerId || option.productId].filter(Boolean).join(' · ')
                      }
                      renderOption={(props, option) => {
                        const { key, className = '', ...optionProps } = props;
                        const firstSku = option.skuOptions?.[0]?.sku || '';
                        return (
                          <Box
                            key={key}
                            component="li"
                            {...optionProps}
                            className={`${className} prompt-library-image-product-option prompt-library-bound-product-option`}
                            sx={{
                              m: 0.5,
                              width: 'calc(100% - 8px)',
                              minHeight: 62,
                              '& .prompt-library-image-product-thumb': { width: 46, height: 46 },
                              '& .prompt-library-image-product-copy .MuiTypography-subtitle2': {
                                fontSize: 14,
                                fontWeight: 750,
                                lineHeight: 1.35,
                              },
                              '& .prompt-library-image-product-copy .MuiTypography-caption': {
                                fontSize: 12,
                                lineHeight: 1.35,
                              },
                            }}
                          >
                            <Box className="prompt-library-image-product-thumb">
                              {option.image ? <img src={option.image} alt="" /> : <Inventory2Rounded />}
                            </Box>
                            <Box className="prompt-library-image-product-copy">
                              <Typography variant="subtitle2" noWrap title={option.title || ''}>
                                {option.title || '未命名商品'}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" noWrap>
                                {option.offerId
                                  ? `货号 ${option.offerId}`
                                  : option.productId
                                    ? `商品 ID ${option.productId}`
                                    : '本地商品'}
                                {firstSku ? ` · SKU ${firstSku}` : ' · 暂无 SKU'}
                              </Typography>
                            </Box>
                          </Box>
                        );
                      }}
                      loadingText="正在读取当前店铺商品…"
                      noOptionsText={
                        productSelection.error ||
                        (selectedShopOption.shopId ? '当前店铺没有可选商品，请先同步商品列表。' : '请先选择店铺。')
                      }
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          label={label}
                          placeholder="选择或搜索现有商品"
                          helperText="来自当前店铺商品列表，可按名称、货号或 SKU 搜索。"
                        />
                      )}
                    />
                    {selectedProduct?.skuOptions?.length ? (
                      <TextField
                        size="small"
                        select
                        label="选择 SKU"
                        value={selectedSku?.id || selectedProduct.skuOptions[0]?.id || ''}
                        onChange={handleBoundSkuChange}
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
                  </Box>
                );
              }
              if (inputSpec?.group === EXTERNAL_PRODUCT_MANUAL_INPUT_GROUP) {
                if (inputSpec !== productManualInputSpecs[0]) return null;
                return (
                  <PromptLibraryProductManualInputs
                    key={EXTERNAL_PRODUCT_MANUAL_INPUT_GROUP}
                    specs={productManualInputSpecs}
                    values={values}
                    validationErrors={usageValidationErrors}
                    runAttempted={runAttempted}
                    onChangeValue={onChangeValue}
                  />
                );
              }
              if (inputSpec?.control === 'repeatable') {
                return (
                  <PromptLibraryRepeatableInputList
                    key={label}
                    tool={selectedPrompt}
                    label={label}
                    value={values[label] || ''}
                    inputSpec={inputSpec}
                    placeholder={placeholder}
                    helperText={runAttempted && validationError ? validationError : helperText}
                    error={runAttempted && Boolean(validationError)}
                    onChange={(nextValue) => onChangeValue(label, nextValue)}
                  />
                );
              }
              if (inputSpec?.control === 'seerfar-category-picker') {
                return (
                  <PromptLibrarySeerfarCategoryPicker
                    key={label}
                    label={label}
                    value={values[label] || ''}
                    placeholder={placeholder}
                    helperText={helperText}
                    error={runAttempted && Boolean(validationError)}
                    errorText={validationError}
                    onChange={(nextValue) => onChangeValue(label, nextValue)}
                  />
                );
              }
              if (inputSpec?.control === 'select') {
                return (
                  <TextField
                    key={label}
                    className="prompt-library-standard-usage-field"
                    size="small"
                    select
                    label={label}
                    value={values[label] || inputSpec.defaultValue || ''}
                    helperText={runAttempted && validationError ? validationError : helperText}
                    error={runAttempted && Boolean(validationError)}
                    onChange={(event) => onChangeValue(label, event.target.value)}
                    fullWidth
                  >
                    {(inputSpec.options || []).map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                );
              }
              return (
                <TextField
                  key={label}
                  className={`prompt-library-standard-usage-field${inputSpec?.multiple ? ' is-multiple' : ''}`}
                  size="small"
                  label={label}
                  value={values[label] || ''}
                  placeholder={placeholder}
                  helperText={runAttempted && validationError ? validationError : helperText}
                  error={runAttempted && Boolean(validationError)}
                  multiline={inputSpec?.multiple === true}
                  minRows={inputSpec?.multiple ? inputSpec.minRows || 2 : undefined}
                  maxRows={inputSpec?.multiple ? inputSpec.maxRows || 4 : undefined}
                  onChange={(event) => onChangeValue(label, event.target.value)}
                  fullWidth
                />
              );
            })
          ) : (
            <Typography variant="body2" color="text.secondary" className="prompt-library-standard-empty-inputs">
              当前 Skill 暂无需要人工填写的项目。
            </Typography>
          )}
        </Box>

        {userInstalledSkill ? (
          <PromptLibraryApiCapabilityStatus
            match={selectedPrompt?.toolMeta?.apiCapabilityMatch}
            compact
            showRegistryTotal
          />
        ) : null}

        {isOzonProductSearch ? (
          <>
            {targetProduct ? (
              <Box className="prompt-library-standard-product-link-summary" aria-label="链接商品解析摘要">
                <Typography variant="caption">{targetProduct.platform || '商品链接'}</Typography>
                <Typography variant="body2" title={targetProduct.productTitle || ''}>
                  {[
                    targetProduct.capturedPrice == null
                      ? ''
                      : `${targetProduct.currency === 'RUB' ? '₽' : '¥'}${targetProduct.capturedPrice}`,
                    targetProduct.dimensions,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '商品资料已解析'}
                </Typography>
              </Box>
            ) : null}
            <Button
              className="prompt-library-standard-run-button"
              variant="contained"
              disabled={loading || (productSelectionEnabled && !modelSelection.ready)}
              onClick={handleRunDraft}
              startIcon={loading ? <CircularProgress size={14} color="inherit" /> : null}
            >
              {loading ? '正在分析' : productSelectionEnabled ? '开始选品分析' : '搜索并分析'}
            </Button>
          </>
        ) : externalDataEnabled ? null : (
          <Box className="prompt-library-image-fixed-rules prompt-library-standard-skill-summary">
            <Typography variant="subtitle2">当前功能</Typography>
            <Typography variant="body2">
              {selectedPrompt?.goal || selectedPrompt?.body || '等待补充功能说明'}
            </Typography>
          </Box>
        )}
      </Box>

      <Box component="section" className="prompt-library-standard-empty-workspace" aria-label="待配置功能区">
        <Stack spacing={2} sx={{ p: 2.25, height: '100%', overflow: 'auto' }}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Box>
              <Typography variant="subtitle1">
                {performanceAdEnabled
                  ? '广告分析报告'
                  : productSelectionEnabled
                    ? '选品决策报告'
                    : externalDataEnabled && externalWorkspaceMode === 'analysis'
                      ? '数据分析报告'
                      : '运行结果'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {performanceAdEnabled
                  ? 'Ozon Performance API 实时广告诊断结果。'
                  : productSelectionEnabled
                    ? 'Ozon 真实市场数据、固定七维评分、可选外部复核与最终选品建议。'
                    : externalDataEnabled && externalWorkspaceMode === 'analysis'
                      ? '根据本次真实查询结果生成，只展示分析结论与建议。'
                      : browserDataEnabled
                        ? externalDataEnabled
                          ? '真实数据查询结果。'
                          : isOzonProductSearch
                            ? '商品搜索、市场对比与运营分析。'
                            : '填写筛选条件后开始分析。'
                        : localPreviewEnabled
                          ? '根据当前输入生成本地结构化预览，不调用外部接口或脚本。'
                          : genericRuntimeAvailable
                            ? '按本次绑定的真实数据、Skill 流程和所选模型生成结果；接口执行记录会一并展示。'
                            : '根据当前输入生成本地 Skill 结果。'}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              {externalDataEnabled && externalWorkspaceMode === 'analysis' ? (
                <Button size="small" variant="outlined" onClick={() => setExternalWorkspaceMode('data')}>
                  返回数据
                </Button>
              ) : null}
              {externalDataEnabled && externalWorkspaceMode === 'analysis' && externalInsight?.status === 'error' ? (
                <Button
                  size="small"
                  variant="contained"
                  disabled={!modelSelection.ready}
                  onClick={handleGenerateExternalInsight}
                >
                  重新分析
                </Button>
              ) : null}
              {externalDataEnabled && externalWorkspaceMode === 'data' && hasExternalAnalysisData ? (
                <Button
                  size="small"
                  variant="contained"
                  disabled={!modelSelection.ready}
                  onClick={handleGenerateExternalInsight}
                >
                  数据分析
                </Button>
              ) : null}
              {result && externalWorkspaceMode === 'data' ? (
                <Button size="small" variant="outlined" onClick={onClearDraft}>
                  {loading ? '停止读取' : '清空结果'}
                </Button>
              ) : null}
              {!isOzonProductSearch && externalWorkspaceMode === 'data' ? (
                <Button
                  size="small"
                  variant="contained"
                  disabled={
                    loading ||
                    ((performanceAdEnabled ||
                      productSelectionEnabled ||
                      operationalAnalysisRequired ||
                      genericRuntimeAvailable) &&
                      !modelSelection.ready) ||
                    (genericRequiresImage && !imageModelSelection.ready)
                  }
                  onClick={handleRunDraft}
                  startIcon={loading ? <CircularProgress size={14} color="inherit" /> : null}
                >
                  {loading
                    ? operationalAnalysisRequired
                      ? '正在读取并分析'
                      : '正在读取'
                    : performanceAdEnabled
                      ? '读取并分析广告'
                      : operationalAnalysisRequired
                        ? '读取并分析报表'
                        : browserDataEnabled
                          ? hasBuiltInUsageGuide
                            ? '开始查询'
                            : '读取插件数据并运行'
                          : localPreviewEnabled
                            ? '生成本地预览'
                            : genericRuntimeAvailable
                              ? '运行 Skill'
                              : '生成本地结果'}
                </Button>
              ) : null}
            </Stack>
          </Stack>

          <Box
            key={externalDataEnabled ? externalWorkspaceMode : 'data'}
            className={externalDataEnabled ? 'prompt-library-external-flip-face' : undefined}
          >
            {externalDataEnabled && externalWorkspaceMode === 'analysis' ? (
              <PromptLibraryExternalInsightReport
                insight={externalInsight}
                presentation={selectedPrompt?.promptConfig?.externalInsightConfig?.reportPresentation}
              />
            ) : result ? (
              hasOzonProductAnalysis ? (
                <Stack
                  spacing={2}
                  className={productSelectionEnabled ? 'prompt-library-product-selection-result-stack' : undefined}
                >
                  {productSelectionEnabled && result.productSelectionInsight ? (
                    <PromptLibraryExternalInsightReport
                      insight={result.productSelectionInsight}
                      presentation={{
                        eyebrow: '选品决策报告',
                        logo: 'target',
                        accent: 'blue',
                        density: 'compact',
                        showSectionIcons: true,
                        showModel: true,
                        showGeneratedAt: true,
                        showPriority: true,
                        showEvidenceLabels: true,
                        showActionLabels: true,
                        sections: [
                          { id: 'marketAssessment', title: '综合判断', icon: 'assessment', visible: true },
                          { id: 'keyFindings', title: '关键证据', icon: 'finding', visible: true },
                          { id: 'opportunities', title: '可验证机会', icon: 'opportunity', visible: true },
                          { id: 'risks', title: '主要风险', icon: 'risk', visible: true },
                          { id: 'actionPlan', title: '测试顺序', icon: 'action', visible: true },
                        ],
                      }}
                    />
                  ) : null}
                  {productSelectionEnabled && result.sourceSearch ? (
                    <PromptLibraryProductSelectionSources sourceSearch={result.sourceSearch} />
                  ) : null}
                  <PromptLibraryOzonProductResult result={result} onOpenProduct={onOpenOzonProduct} />
                </Stack>
              ) : result.viewType === 'performance-ads' && result.performanceAdInsight ? (
                <PromptLibraryExternalInsightReport
                  insight={result.performanceAdInsight}
                  presentation={{
                    eyebrow: '广告经营分析',
                    logo: 'chart',
                    accent: 'blue',
                    density: 'compact',
                    showSectionIcons: true,
                    showModel: true,
                    showGeneratedAt: true,
                    showPriority: true,
                    showEvidenceLabels: true,
                    showActionLabels: true,
                    sections: [
                      { id: 'marketAssessment', title: '整体判断', icon: 'assessment', visible: true },
                      { id: 'keyFindings', title: '关键发现', icon: 'finding', visible: true },
                      { id: 'opportunities', title: '有效信号', icon: 'opportunity', visible: true },
                      { id: 'risks', title: '需要处理', icon: 'risk', visible: true },
                      { id: 'actionPlan', title: '调整顺序', icon: 'action', visible: true },
                    ],
                  }}
                />
              ) : result.viewType === 'operational-report' && result.operationalReportInsight ? (
                <Stack spacing={2} className="prompt-library-operational-report-workspace">
                  <PromptLibraryExternalInsightReport
                    insight={result.operationalReportInsight}
                    visualStyle="operations-brief"
                    presentation={{
                      eyebrow: '经营数据简报',
                      logo: 'chart',
                      accent: 'charcoal',
                      density: 'compact',
                      showSectionIcons: true,
                      showModel: true,
                      showGeneratedAt: true,
                      showPriority: true,
                      showEvidenceLabels: true,
                      showActionLabels: true,
                      sections: [
                        { id: 'marketAssessment', title: '经营概况', icon: 'assessment', visible: true },
                        { id: 'keyFindings', title: '关键问题', icon: 'finding', visible: true },
                        { id: 'opportunities', title: '增长机会', icon: 'opportunity', visible: true },
                        { id: 'risks', title: '风险提醒', icon: 'risk', visible: true },
                        { id: 'actionPlan', title: '执行清单', icon: 'action', visible: true },
                      ],
                    }}
                  />
                  <PromptLibraryOperationalReportDetails sections={result.sections} />
                </Stack>
              ) : (
                <Stack spacing={2}>
                  <Alert severity={severity}>
                    <Typography variant="subtitle2">{result.statusLabel || 'Skill 已运行'}</Typography>
                    <Typography variant="body2">{result.summary || '运行完成。'}</Typography>
                  </Alert>
                  {result.viewType === 'market-keywords' ? (
                    <PromptLibraryMarketKeywordResult result={result} onOpenProduct={onOpenOzonProduct} />
                  ) : result.viewType === 'external-products' ? (
                    <PromptLibraryExternalProductResult result={result} onOpenProduct={onOpenOzonProduct} />
                  ) : (
                    <PromptLibraryExternalResultSections sections={result.sections} />
                  )}
                  {Array.isArray(result.generatedImages) && result.generatedImages.length ? (
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        本次真实生成图片
                      </Typography>
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                          gap: 1.25,
                        }}
                      >
                        {result.generatedImages.map((item, index) => (
                          <Box
                            key={`${item.taskId || item.assetId || index}`}
                            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, overflow: 'hidden' }}
                          >
                            {item.imageUrl ? (
                              <Box
                                component="img"
                                src={item.imageUrl}
                                alt={item.label || `生成图片 ${index + 1}`}
                                sx={{ display: 'block', width: '100%', aspectRatio: '3 / 4', objectFit: 'cover' }}
                              />
                            ) : (
                              <Box
                                sx={{
                                  aspectRatio: '3 / 4',
                                  display: 'grid',
                                  placeItems: 'center',
                                  bgcolor: 'action.hover',
                                }}
                              >
                                <Typography variant="caption" color="text.secondary">
                                  生成失败
                                </Typography>
                              </Box>
                            )}
                            <Box sx={{ p: 1 }}>
                              <Typography variant="body2" fontWeight={700} noWrap title={item.label}>
                                {item.label || `图片 ${index + 1}`}
                              </Typography>
                              <Typography
                                variant="caption"
                                color={item.status === 'success' ? 'success.main' : 'error.main'}
                              >
                                {item.status === 'success'
                                  ? item.persistenceStatus === 'completed'
                                    ? '已生成并保存'
                                    : '已生成，保存处理中'
                                  : item.message || '生成失败'}
                              </Typography>
                            </Box>
                          </Box>
                        ))}
                      </Box>
                    </Box>
                  ) : null}
                  {Array.isArray(result.nextActions) && result.nextActions.length ? (
                    <Box sx={{ border: '1px dashed', borderColor: 'divider', borderRadius: 1.5, p: 1.5 }}>
                      <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                        下一步
                      </Typography>
                      {result.nextActions.map((item, index) => (
                        <Typography key={`${item}-${index}`} variant="body2" color="text.secondary">
                          {index + 1}. {item}
                        </Typography>
                      ))}
                    </Box>
                  ) : null}
                </Stack>
              )
            ) : (
              <Alert severity="info">
                {browserDataEnabled
                  ? performanceAdEnabled
                    ? '选择左侧条件后，从 Ozon Performance API 实时读取广告计划并生成诊断报告。'
                    : externalDataEnabled
                      ? '按左侧条件填写后开始查询'
                      : isOzonProductSearch
                        ? '输入关键词或者链接任意一个开始进行分析'
                        : hasBuiltInUsageGuide
                          ? '按左侧提示填写后开始查询；多项内容点击＋添加。'
                          : '先在内置浏览器打开对应分析页面并完成一次查询，然后点击“读取插件数据并运行”。'
                  : localPreviewEnabled
                    ? '填写左侧信息后点击“生成本地预览”。'
                    : genericRuntimeAvailable
                      ? '选择或确认左侧信息后点击“运行 Skill”；系统会显示真实接口和模型执行记录。'
                      : '填写左侧信息后点击“生成本地结果”。'}
              </Alert>
            )}
          </Box>
        </Stack>
      </Box>
    </Box>
  );
}

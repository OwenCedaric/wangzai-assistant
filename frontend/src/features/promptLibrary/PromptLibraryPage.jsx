import { safeWarn } from '../../services/safeLog';
import { createSmartToolMeta, hasUsableModelApi, hasUsableOzonShop } from './lib/smartToolRuntime.js';
import { createInstallPreviewFromMarkdown, createInstallPreviewFromSource } from './lib/promptLibraryInstall.js';
import { resolveSmartToolSkillInstallUrl } from './services/smartToolSkillInstallService.js';
import { PromptLibraryCategoryFilter } from './components/PromptLibraryCategoryFilter.jsx';
import { PromptLibraryEditorDialog } from './components/PromptLibraryEditorDialog.jsx';
import { PromptLibrarySimpleEditorDialog } from './components/PromptLibrarySimpleEditorDialog.jsx';
import { PromptLibraryCategoryDialog } from './components/PromptLibraryCategoryDialog.jsx';
import { PromptLibraryDeleteDialogs } from './components/PromptLibraryDeleteDialogs.jsx';
import { PromptLibraryListPanel } from './components/PromptLibraryListPanel.jsx';
import { PromptLibraryHeader } from './components/PromptLibraryHeader.jsx';
import { usePromptLibraryShopScope } from './model/usePromptLibraryShopScope.js';
import {
  createEmptyPromptForm,
  formatPromptLibraryUpdatedAt,
  loadPromptLibraryStore,
} from './lib/promptLibraryStore.jsx';
import {
  createPromptFormFromItem,
  createPromptLibraryCategoryId,
  createPromptLibraryId,
  getPromptLibraryScenes,
  normalizePromptLibraryCategory,
  normalizePromptLibraryItem,
  promptLibraryStatusOptions,
  readPromptLibraryCategories,
  readPromptLibraryItems,
  savePromptLibraryStore,
} from './lib/promptLibraryStore.jsx';
import {
  listSmartToolModelOptions,
  loadSmartToolModelState,
  SMART_TOOL_AUTO_MODEL_ID,
  SMART_TOOL_IMAGE_MODEL_CAPABILITY,
} from './services/smartToolModelService.js';
import { replaceGeneratedProductImages } from './services/smartToolProductImageReplacementService.js';
import { replaceGeneratedProductDescription } from './services/smartToolProductDescriptionReplacementService.js';
import { loadSmartToolIntegrationState } from './services/smartToolIntegrationProfileService.js';
import { enrichSmartToolExternalOzonProduct } from './services/smartToolExternalOzonDataService.js';
import { buildPromptLibraryOzonWorkbenchContext } from './lib/promptLibraryOzonWorkbenchContext.js';
import {
  isExternalOzonInsightToolId,
  normalizeExternalOzonInsightConfig,
} from './lib/smartToolExternalOzonInsightConfig.js';
import { normalizeProfitReviewPresentation } from './lib/smartToolProfitReviewConfig.js';
import { isUserInstalledSmartTool } from './lib/smartToolInstalledSkill.js';
import { isSmartToolProductImageWorkbench, resolveSmartToolWorkbench } from './lib/smartToolWorkbenchRegistry.js';
import { PROFIT_ORDER_REVIEW_SKILL_ID } from '../profitReview/constants/profitOrderReviewContract.js';
import { OzonProductWorkbench } from '../orders/purchase/components/OzonProductWorkbench.jsx';
import { useOzonProductWorkbenchState } from '../orders/purchase/model/useOzonProductWorkbenchState.jsx';
import Box from '@mui/material/Box';
import React from 'react';

const PromptLibraryRunTask = React.lazy(() =>
  import('./components/PromptLibraryRunTask.jsx').then((module) => ({ default: module.PromptLibraryRunTask }))
);

function splitPromptEditorList(value) {
  return String(value ?? '')
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const STORE_REPORT_ANALYSIS_SKILL_ID = 'ozon-skill-1688-channel-shopdata-analyzer';

function PromptLibraryPage({
  shops = [],
  activeShopId = '',
  onActiveShopChange = () => {},
  onOpenDataAnalysis = () => {},
} = {}) {
  const runSessionSequenceRef = React.useRef(0);
  const initialCategoriesRef = React.useRef(null);
  if (!initialCategoriesRef.current) {
    initialCategoriesRef.current = readPromptLibraryCategories();
  }
  const [categories, setCategories] = React.useState(() => initialCategoriesRef.current);
  const [prompts, setPrompts] = React.useState(() => readPromptLibraryItems(initialCategoriesRef.current));
  const [keyword, setKeyword] = React.useState('');
  const [scene, setScene] = React.useState('all');
  const [selectedPromptId, setSelectedPromptId] = React.useState('');
  const [, setCopyMessage] = React.useState('');
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorMode, setEditorMode] = React.useState('create');
  const [editorForm, setEditorForm] = React.useState(() => createEmptyPromptForm(initialCategoriesRef.current));
  const [formError, setFormError] = React.useState('');
  const [installPreview, setInstallPreview] = React.useState(null);
  const [installSourceLabel, setInstallSourceLabel] = React.useState('');
  const [installUrl, setInstallUrl] = React.useState('');
  const [installResolving, setInstallResolving] = React.useState(false);
  const [modelApiReady, setModelApiReady] = React.useState(() => hasUsableModelApi());
  const [integrationState, setIntegrationState] = React.useState(() => ({
    integrationTypes: [],
    hasThirdPartyToolAccount: false,
    hasPerformanceAccount: false,
    performanceAccountCount: 0,
    hasCrossBorderAccount: false,
    crossBorderAccountCount: 0,
    hasPurchaseAccount: false,
    purchaseAccountCount: 0,
  }));
  const [modelOptions, setModelOptions] = React.useState(() => listSmartToolModelOptions());
  const [imageModelOptions, setImageModelOptions] = React.useState(() =>
    listSmartToolModelOptions(undefined, { capability: SMART_TOOL_IMAGE_MODEL_CAPABILITY })
  );
  const [runSessions, setRunSessions] = React.useState([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const [categoryDialogOpen, setCategoryDialogOpen] = React.useState(false);
  const [categoryDraft, setCategoryDraft] = React.useState('');
  const [editingCategoryValue, setEditingCategoryValue] = React.useState('');
  const [categoryError, setCategoryError] = React.useState('');
  const [categoryDeleteTarget, setCategoryDeleteTarget] = React.useState(null);
  const installFileInputRef = React.useRef(null);
  const promptLibrarySaveVersionRef = React.useRef(0);
  const promptLibraryOzonProductWorkbench = useOzonProductWorkbenchState();
  const { shopOptions, selectedShopId, selectedShop, selectShop } = usePromptLibraryShopScope({
    shops,
    activeShopId,
    onActiveShopChange,
  });

  const persistPromptLibrary = React.useCallback((nextCategories, nextPrompts) => {
    const saveVersion = ++promptLibrarySaveVersionRef.current;
    void savePromptLibraryStore({ categories: nextCategories, items: nextPrompts })
      .then((store) => {
        if (saveVersion !== promptLibrarySaveVersionRef.current) return;
        setCategories(store.categories);
        setPrompts(store.items);
      })
      .catch((error) => {
        if (saveVersion !== promptLibrarySaveVersionRef.current) return;
        safeWarn('[智能工具] local-api 保存失败', error);
        setCopyMessage('工具库没有保存成功，请检查本机服务后重试。');
      });
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const refreshModelSettings = async () => {
      try {
        const state = await loadSmartToolModelState();
        if (cancelled) return;
        setModelApiReady(hasUsableModelApi(state));
        setModelOptions(listSmartToolModelOptions(state));
        setImageModelOptions(listSmartToolModelOptions(state, { capability: SMART_TOOL_IMAGE_MODEL_CAPABILITY }));
      } catch (error) {
        safeWarn('[智能工具] 本机模型账号读取失败', error);
        if (cancelled) return;
        setModelApiReady(hasUsableModelApi());
        setModelOptions(listSmartToolModelOptions());
        setImageModelOptions(listSmartToolModelOptions(undefined, { capability: SMART_TOOL_IMAGE_MODEL_CAPABILITY }));
      }
    };
    void refreshModelSettings();
    if (typeof window === 'undefined')
      return () => {
        cancelled = true;
      };
    const onFocus = () => {
      void refreshModelSettings();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('wangzai-settings-closed', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('wangzai-settings-closed', onFocus);
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const refreshIntegrationSettings = async () => {
      try {
        const nextState = await loadSmartToolIntegrationState();
        if (!cancelled) setIntegrationState(nextState);
      } catch (error) {
        safeWarn('[智能工具] 外部接口配置读取失败', error);
      }
    };
    void refreshIntegrationSettings();
    if (typeof window === 'undefined')
      return () => {
        cancelled = true;
      };
    const onFocus = () => {
      void refreshIntegrationSettings();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('wangzai-settings-closed', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('wangzai-settings-closed', onFocus);
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const loadSaveVersion = promptLibrarySaveVersionRef.current;
    loadPromptLibraryStore()
      .then((store) => {
        if (cancelled || loadSaveVersion !== promptLibrarySaveVersionRef.current) return;
        setCategories(store.categories);
        setPrompts(store.items);
      })
      .catch((error) => {
        safeWarn('[智能工具] 本机工具库读取失败', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const promptScenes = React.useMemo(() => getPromptLibraryScenes(categories), [categories]);
  const toolEnvironment = React.useMemo(() => {
    const hasOzonShop = hasUsableOzonShop(shops);
    return {
      hasOzonShop,
      hasModelApi: modelApiReady,
      hasImageModelApi: imageModelOptions.some((item) => item.ready),
      hasThirdPartyToolAccount: integrationState.hasThirdPartyToolAccount,
      hasPerformanceAccount: integrationState.hasPerformanceAccount,
      hasCrossBorderAccount: integrationState.hasCrossBorderAccount,
      hasPurchaseAccount: integrationState.hasPurchaseAccount,
      integrationTypes: integrationState.integrationTypes,
      hasOzonBrowser: true,
      hasLocalBusinessData: true,
      hasProductImageStorage: hasOzonShop,
    };
  }, [imageModelOptions, integrationState, modelApiReady, shops]);
  const smartTools = React.useMemo(
    () =>
      prompts.map((item) => {
        const toolMeta = createSmartToolMeta(item, toolEnvironment);
        return {
          ...item,
          title: toolMeta.displayTitle ?? item.title,
          goal: toolMeta.displayGoal ?? item.goal,
          body: toolMeta.displayBody ?? item.body,
          variables: toolMeta.displayVariables ?? item.variables,
          toolMeta,
        };
      }),
    [prompts, toolEnvironment]
  );

  const sceneCounts = React.useMemo(
    () =>
      promptScenes.map((item) => ({
        ...item,
        count:
          item.value === 'all' ? smartTools.length : smartTools.filter((prompt) => prompt.scene === item.value).length,
      })),
    [promptScenes, smartTools]
  );

  const categoryCounts = React.useMemo(
    () =>
      categories.map((item) => ({
        ...item,
        count: prompts.filter((prompt) => prompt.scene === item.value).length,
      })),
    [categories, prompts]
  );

  const filteredPrompts = React.useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return smartTools.filter((item) => {
      const matchScene = scene === 'all' || item.scene === scene;
      const searchText =
        `${item.title} ${item.goal} ${item.sceneLabel} ${item.owner} ${item.toolMeta.toolType} ${item.toolMeta.dependencies.join(' ')}`.toLowerCase();
      return matchScene && (!query || searchText.includes(query));
    });
  }, [keyword, smartTools, scene]);

  React.useEffect(() => {
    if (scene !== 'all' && !categories.some((item) => item.value === scene)) {
      setScene('all');
    }
  }, [categories, scene]);

  const selectedPrompt = smartTools.find((item) => item.id === selectedPromptId) ?? null;
  const selectedPromptIsImageSkill =
    selectedPrompt?.skillProfile?.modelCapability === SMART_TOOL_IMAGE_MODEL_CAPABILITY;
  const selectedPromptIsExternalDataSkill = isExternalOzonInsightToolId(selectedPrompt?.id);
  const selectedPromptIsProfitReviewSkill = selectedPrompt?.id === PROFIT_ORDER_REVIEW_SKILL_ID;
  const selectedPromptIsUserInstalled = isUserInstalledSmartTool(selectedPrompt || {});
  const selectedPromptWorkbench = resolveSmartToolWorkbench(selectedPrompt || {});
  const selectedPromptUsesInstalledImageEditor =
    selectedPromptIsUserInstalled && isSmartToolProductImageWorkbench(selectedPromptWorkbench);
  const handleReplaceImages = React.useCallback(
    async ({ group, generatedItems, product }) => {
      const shopId = String(
        product?.shopId || product?.shop_id || product?.raw?.shopId || product?.raw?.shop_id || ''
      ).trim();
      const ownerShop = shops.find((shop) => String(shop?.id || shop?.shopId || '').trim() === shopId) || null;
      if (!ownerShop) throw new Error('没有找到商品所属店铺，不能提交 Ozon。');
      const result = await replaceGeneratedProductImages({
        shop: ownerShop,
        product,
        group,
        generatedItems,
      });
      setCopyMessage('图片替换已由 Ozon 回读确认。');
      return result;
    },
    [shops]
  );
  const handleReplaceDescription = React.useCallback(
    async ({ product, fieldValues, attributes }) => {
      const shopId = String(
        product?.shopId || product?.shop_id || product?.raw?.shopId || product?.raw?.shop_id || ''
      ).trim();
      const ownerShop = shops.find((shop) => String(shop?.id || shop?.shopId || '').trim() === shopId) || null;
      if (!ownerShop) throw new Error('没有找到商品所属店铺，不能提交 Ozon。');
      const result = await replaceGeneratedProductDescription({
        shop: ownerShop,
        product,
        fieldValues,
        attributes,
      });
      setCopyMessage('商品资料替换已由 Ozon 回读确认。');
      return result;
    },
    [shops]
  );
  const handleOpenOzonProduct = React.useCallback(
    async (record = {}) => {
      let resolvedRecord = record;
      if (record?.sfEnrich === true || String(record?.sfSource || '') === 'seerfar-open-api') {
        try {
          resolvedRecord = await enrichSmartToolExternalOzonProduct(record);
        } catch (error) {
          safeWarn('[prompt-library] Seerfar product detail enrichment failed', error);
        }
      }
      return promptLibraryOzonProductWorkbench.openOzonProduct(buildPromptLibraryOzonWorkbenchContext(resolvedRecord));
    },
    [promptLibraryOzonProductWorkbench]
  );
  const categoryDeletePromptCount = categoryDeleteTarget
    ? prompts.filter((item) => item.scene === categoryDeleteTarget.value).length
    : 0;
  const categoryDeleteFallbackLabel = categoryDeleteTarget
    ? (categories.find((item) => item.value !== categoryDeleteTarget.value)?.label ?? '')
    : '';

  const updatePromptForm = (field) => (event) => {
    setEditorForm((current) => ({
      ...current,
      [field]: event.target.value,
    }));
    setFormError('');
  };

  const openCreatePrompt = () => {
    setEditorMode('create');
    setEditorForm(createEmptyPromptForm(categories));
    setFormError('');
    setInstallPreview(null);
    setInstallSourceLabel('');
    setInstallUrl('');
    setInstallResolving(false);
    setEditorOpen(true);
  };

  const openRunPrompt = (prompt) => {
    if (!prompt) return;
    if (prompt.id === STORE_REPORT_ANALYSIS_SKILL_ID) {
      onOpenDataAnalysis({
        skillId: prompt.id,
        shopId: selectedShopId,
        shopName: shopOptions.find((shop) => shop.shopId === selectedShopId)?.displayName || '',
        systemPrompt: prompt.promptConfig?.systemPrompt || '',
        userPrompt: prompt.promptConfig?.userPrompt || '',
        outputFormat: prompt.promptConfig?.outputFormat || '',
        workflowSteps: prompt.promptConfig?.workflowSteps || [],
        outputRules: prompt.promptConfig?.outputRules || [],
        safetyRules: prompt.promptConfig?.safetyRules || [],
      });
      return;
    }
    setSelectedPromptId(prompt.id);
    const sessionId = `prompt_run_${++runSessionSequenceRef.current}`;
    setRunSessions((current) => [
      ...current,
      {
        id: sessionId,
        prompt,
        availableTools: smartTools,
        shop: selectedShop,
        shopId: selectedShopId,
      },
    ]);
  };

  const closeRunSession = React.useCallback((sessionId) => {
    setRunSessions((current) => current.filter((item) => item.id !== sessionId));
  }, []);

  const openEditPrompt = (promptOverride = null) => {
    const prompt = promptOverride || selectedPrompt;
    if (!prompt) {
      setCopyMessage('请先选择要编辑的工具');
      return;
    }
    setSelectedPromptId(prompt.id);
    setEditorMode('edit');
    setEditorForm(createPromptFormFromItem(prompt));
    setFormError('');
    setEditorOpen(true);
  };

  const closePromptEditor = () => {
    setEditorOpen(false);
    setFormError('');
    setInstallPreview(null);
    setInstallSourceLabel('');
    setInstallUrl('');
  };

  const handleInstallFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setFormError('');
    setInstallPreview(null);
    setInstallSourceLabel(file.name);

    try {
      const fileName = file.name;
      const lowerName = fileName.toLowerCase();
      if (lowerName.endsWith('.zip')) {
        setInstallPreview(
          createInstallPreviewFromSource(
            {
              title: fileName.replace(/\.[^.]+$/, ''),
              description: '已选择工具包。安装后先放到工具中心，后续再接真正执行。',
              body: '这是上传的工具包。当前只记录到工具中心，不会自动运行，也不会写入 Ozon。',
              variables: ['按工具包说明准备'],
            },
            categories,
            { fileName }
          )
        );
        return;
      }

      const text = await file.text();
      if (lowerName.endsWith('.json')) {
        const parsed = JSON.parse(text);
        const source = Array.isArray(parsed) ? parsed[0] : parsed;
        setInstallPreview(createInstallPreviewFromSource(source, categories, { fileName }));
        return;
      }

      setInstallPreview(createInstallPreviewFromMarkdown(text, fileName, categories));
    } catch {
      setFormError('这个文件没读出来。可以上传 .json、.md、.txt 或 .zip 工具包。');
    }
  };

  const handleInstallFromUrl = async () => {
    const cleanUrl = installUrl.trim();
    if (!cleanUrl) {
      setFormError('请先粘贴工具链接');
      return;
    }
    setFormError('');
    setInstallPreview(null);
    setInstallSourceLabel(cleanUrl);
    setInstallResolving(true);
    try {
      const source = await resolveSmartToolSkillInstallUrl(cleanUrl);
      setInstallSourceLabel(`${source.repository || cleanUrl} · ${source.ref || '默认分支'}`);
      setInstallPreview(createInstallPreviewFromMarkdown(source.markdown, source.fileName, categories, source));
    } catch (error) {
      safeWarn('prompt-library skill link resolve failed', error);
      setFormError(error instanceof Error ? error.message : 'Skill 链接读取失败，请稍后重试。');
    } finally {
      setInstallResolving(false);
    }
  };

  const handleInstallTool = () => {
    if (!installPreview) {
      setFormError('请先上传文件，或者粘贴工具链接生成预览');
      return;
    }

    const savedItem = normalizePromptLibraryItem(
      {
        ...installPreview,
        id: createPromptLibraryId(),
        updatedAt: formatPromptLibraryUpdatedAt(),
      },
      0,
      categories
    );
    const nextPrompts = [savedItem, ...prompts];
    setPrompts(nextPrompts);
    persistPromptLibrary(categories, nextPrompts);
    setSelectedPromptId(savedItem.id);
    setCopyMessage(`已安装并启用《${savedItem.title}》，已加入工具库`);
    closePromptEditor();
  };

  const handleSavePrompt = () => {
    const cleanTitle = editorForm.title.trim();
    const cleanBody = editorForm.body.trim();
    if (!cleanTitle) {
      setFormError('请填写标题');
      return;
    }
    if (!cleanBody) {
      setFormError('请填写说明内容');
      return;
    }
    if (editorMode === 'edit' && !selectedPrompt) {
      setFormError('请先选择要编辑的工具');
      return;
    }

    const inputFields = splitPromptEditorList(editorForm.inputs);
    const usageInputFields = splitPromptEditorList(editorForm.variables);
    const variables = usageInputFields.length ? usageInputFields : inputFields.slice(0, 1);
    const isImageSkill = selectedPrompt?.skillProfile?.modelCapability === SMART_TOOL_IMAGE_MODEL_CAPABILITY;
    const promptConfig = {
      defaultModelId: isImageSkill
        ? editorForm.imageModelId || editorForm.defaultModelId || SMART_TOOL_AUTO_MODEL_ID
        : editorForm.defaultModelId || SMART_TOOL_AUTO_MODEL_ID,
      plannerModelId: editorForm.plannerModelId || SMART_TOOL_AUTO_MODEL_ID,
      imageModelId: editorForm.imageModelId || editorForm.defaultModelId || SMART_TOOL_AUTO_MODEL_ID,
      imagePositionRules: editorForm.imagePositionRules,
      imagePositionRulesVersion: editorForm.imagePositionRulesVersion,
      installedSkillParserVersion: editorForm.installedSkillParserVersion,
      attributeRules: editorForm.attributeRules,
      attributeRulesVersion: editorForm.attributeRulesVersion,
      externalInsightConfig: isExternalOzonInsightToolId(selectedPrompt?.id)
        ? normalizeExternalOzonInsightConfig(editorForm.externalInsightConfig, { toolId: selectedPrompt.id })
        : null,
      profitReviewPresentation:
        selectedPrompt?.id === PROFIT_ORDER_REVIEW_SKILL_ID
          ? normalizeProfitReviewPresentation(editorForm.profitReviewPresentation)
          : null,
      modelPurpose: editorForm.modelPurpose.trim(),
      systemPrompt: editorForm.systemPrompt.trim(),
      userPrompt: editorForm.userPrompt.trim(),
      outputFormat: editorForm.outputFormat.trim(),
      outputRules: splitPromptEditorList(editorForm.outputRules),
      workflowSteps: splitPromptEditorList(editorForm.workflowSteps),
      safetyRules: splitPromptEditorList(editorForm.safetyRules),
      capabilities: splitPromptEditorList(editorForm.capabilities),
      inputs: splitPromptEditorList(editorForm.inputs),
      outputs: splitPromptEditorList(editorForm.outputs),
    };
    const savedItem = normalizePromptLibraryItem(
      {
        ...(editorMode === 'edit' ? selectedPrompt : {}),
        id: editorMode === 'edit' ? selectedPrompt.id : createPromptLibraryId(),
        title: cleanTitle,
        scene: editorForm.scene,
        status: editorForm.status,
        owner: editorForm.owner.trim() || '运营组',
        goal: editorForm.goal.trim() || '待补充用途',
        variables,
        body: cleanBody,
        skillProfile: {
          ...(selectedPrompt?.skillProfile || {}),
          usageInputs: variables,
          dependencyBindings: editorForm.dependencyBindings,
        },
        promptConfig,
        updatedAt: formatPromptLibraryUpdatedAt(),
        used: editorMode === 'edit' ? selectedPrompt.used : 0,
      },
      0,
      categories
    );

    const nextPrompts =
      editorMode === 'edit'
        ? [savedItem, ...prompts.filter((item) => item.id !== selectedPrompt.id)]
        : [savedItem, ...prompts];

    setPrompts(nextPrompts);
    persistPromptLibrary(categories, nextPrompts);
    setSelectedPromptId(savedItem.id);
    setCopyMessage(editorMode === 'edit' ? `已保存《${savedItem.title}》` : `已新增《${savedItem.title}》`);
    closePromptEditor();
  };

  const handleDeletePrompt = () => {
    if (!selectedPrompt || !isUserInstalledSmartTool(selectedPrompt)) {
      setDeleteConfirmOpen(false);
      setCopyMessage('系统内置 Skill 不能从这里删除');
      return;
    }
    const currentIndex = prompts.findIndex((item) => item.id === selectedPrompt.id);
    const nextPrompts = prompts.filter((item) => item.id !== selectedPrompt.id);
    const nextSelectedId =
      nextPrompts[currentIndex]?.id ?? nextPrompts[currentIndex - 1]?.id ?? nextPrompts[0]?.id ?? '';

    setPrompts(nextPrompts);
    persistPromptLibrary(categories, nextPrompts);
    setSelectedPromptId(nextSelectedId);
    setDeleteConfirmOpen(false);
    setEditorOpen(false);
    setCopyMessage(`已删除《${selectedPrompt.title}》`);
  };

  const openDeletePromptConfirm = (promptOverride = null) => {
    const prompt = promptOverride || selectedPrompt;
    if (!prompt || !isUserInstalledSmartTool(prompt)) return;
    setSelectedPromptId(prompt.id);
    setDeleteConfirmOpen(true);
  };

  const openCategoryDialog = () => {
    setCategoryDraft('');
    setEditingCategoryValue('');
    setCategoryError('');
    setCategoryDialogOpen(true);
  };

  const startEditCategory = (category) => {
    setCategoryDraft(category.label);
    setEditingCategoryValue(category.value);
    setCategoryError('');
  };

  const cancelEditCategory = () => {
    setCategoryDraft('');
    setEditingCategoryValue('');
    setCategoryError('');
  };

  const handleSaveCategory = () => {
    const cleanLabel = categoryDraft.trim();
    if (!cleanLabel) {
      setCategoryError('请填写分类名称');
      return;
    }
    if (categories.some((item) => item.label === cleanLabel && item.value !== editingCategoryValue)) {
      setCategoryError('这个分类名称已经存在');
      return;
    }

    if (editingCategoryValue) {
      const nextCategories = categories.map((item) =>
        item.value === editingCategoryValue ? { ...item, label: cleanLabel } : item
      );
      const nextPrompts = prompts.map((item, index) => normalizePromptLibraryItem(item, index, nextCategories));

      setCategories(nextCategories);
      setPrompts(nextPrompts);
      persistPromptLibrary(nextCategories, nextPrompts);
      setCopyMessage(`已保存分类《${cleanLabel}》`);
      cancelEditCategory();
      return;
    }

    const newCategory = normalizePromptLibraryCategory({
      value: createPromptLibraryCategoryId(),
      label: cleanLabel,
    });
    const nextCategories = [...categories, newCategory];

    setCategories(nextCategories);
    persistPromptLibrary(nextCategories, prompts);
    setScene(newCategory.value);
    setCopyMessage(`已新增分类《${newCategory.label}》`);
    setCategoryDraft('');
    setCategoryError('');
  };

  const openDeleteCategoryConfirm = (category) => {
    if (categories.length <= 1) {
      setCategoryError('至少保留一个分类');
      return;
    }
    setCategoryError('');
    setCategoryDeleteTarget(category);
  };

  const handleDeleteCategory = () => {
    if (!categoryDeleteTarget) return;

    const nextCategories = categories.filter((item) => item.value !== categoryDeleteTarget.value);
    const fallbackCategory = nextCategories[0];
    const nextPrompts = prompts.map((item, index) =>
      normalizePromptLibraryItem(
        item.scene === categoryDeleteTarget.value ? { ...item, scene: fallbackCategory.value } : item,
        index,
        nextCategories
      )
    );

    setCategories(nextCategories);
    setPrompts(nextPrompts);
    persistPromptLibrary(nextCategories, nextPrompts);
    setScene((currentScene) => (currentScene === categoryDeleteTarget.value ? 'all' : currentScene));
    setCategoryDeleteTarget(null);
    setCategoryDraft('');
    setEditingCategoryValue('');
    setCopyMessage(`已删除分类《${categoryDeleteTarget.label}》`);
  };

  return (
    <Box className="prompt-library-page">
      <PromptLibraryHeader
        shopOptions={shopOptions}
        selectedShopId={selectedShopId}
        onShopChange={selectShop}
        onShowAll={() => setScene('all')}
        onCreateTool={openCreatePrompt}
      />

      <PromptLibraryCategoryFilter
        sceneCounts={sceneCounts}
        activeScene={scene}
        onSelectScene={setScene}
        onOpenCategoryDialog={openCategoryDialog}
      />

      <PromptLibraryListPanel
        prompts={filteredPrompts}
        keyword={keyword}
        scene={scene}
        scenes={promptScenes}
        modelOptions={modelOptions}
        imageModelOptions={imageModelOptions}
        onKeywordChange={setKeyword}
        onSceneChange={setScene}
        onRunPrompt={openRunPrompt}
        onEditPrompt={openEditPrompt}
        onDeletePrompt={openDeletePromptConfirm}
      />

      <React.Suspense fallback={null}>
        {runSessions.map((session) => (
          <PromptLibraryRunTask
            key={session.id}
            session={session}
            shops={shops}
            imageModelOptions={imageModelOptions}
            modelOptions={modelOptions}
            onClose={closeRunSession}
            onOpenOzonProduct={handleOpenOzonProduct}
            onReplaceImages={handleReplaceImages}
            onReplaceDescription={handleReplaceDescription}
          />
        ))}
      </React.Suspense>

      <OzonProductWorkbench controller={promptLibraryOzonProductWorkbench} />

      <PromptLibraryEditorDialog
        open={editorOpen && (editorMode === 'create' || selectedPromptIsUserInstalled)}
        editorMode={editorMode}
        onClose={closePromptEditor}
        formError={formError}
        installFileInputRef={installFileInputRef}
        onInstallFileChange={handleInstallFileChange}
        installUrl={installUrl}
        onInstallUrlChange={(value) => {
          setInstallUrl(value);
          setFormError('');
        }}
        onInstallFromUrl={handleInstallFromUrl}
        installResolving={installResolving}
        installPreview={installPreview}
        apiCapabilityMatch={
          editorMode === 'create'
            ? installPreview
              ? createSmartToolMeta(installPreview, toolEnvironment).apiCapabilityMatch
              : null
            : selectedPrompt?.toolMeta?.apiCapabilityMatch || null
        }
        installSourceLabel={installSourceLabel}
        skillProfile={
          editorMode === 'create' ? installPreview?.skillProfile || null : selectedPrompt?.skillProfile || null
        }
        installedSkillOptions={smartTools.filter(
          (item) => isUserInstalledSmartTool(item) && item.id !== selectedPrompt?.id
        )}
        editorForm={editorForm}
        categories={categories}
        statusOptions={promptLibraryStatusOptions}
        modelOptions={modelOptions}
        isImageSkill={selectedPromptUsesInstalledImageEditor}
        imageWorkbench={selectedPromptWorkbench}
        onChangeField={updatePromptForm}
        onInstallTool={handleInstallTool}
        onSavePrompt={handleSavePrompt}
        canDelete={editorMode === 'edit' && selectedPromptIsUserInstalled}
        onDeletePrompt={() => openDeletePromptConfirm(selectedPrompt)}
      />

      <PromptLibrarySimpleEditorDialog
        open={editorOpen && editorMode === 'edit' && !selectedPromptIsUserInstalled}
        onClose={closePromptEditor}
        formError={formError}
        editorForm={editorForm}
        isImageSkill={selectedPromptIsImageSkill}
        isExternalDataSkill={selectedPromptIsExternalDataSkill}
        isProfitReviewSkill={selectedPromptIsProfitReviewSkill}
        onChangeField={updatePromptForm}
        onSavePrompt={handleSavePrompt}
      />

      <PromptLibraryCategoryDialog
        open={categoryDialogOpen}
        onClose={() => setCategoryDialogOpen(false)}
        categoryError={categoryError}
        categoryDraft={categoryDraft}
        onCategoryDraftChange={(value) => {
          setCategoryDraft(value);
          setCategoryError('');
        }}
        editingCategoryValue={editingCategoryValue}
        onSaveCategory={handleSaveCategory}
        onCancelEditCategory={cancelEditCategory}
        categoryCounts={categoryCounts}
        onEditCategory={startEditCategory}
        onDeleteCategory={openDeleteCategoryConfirm}
      />

      <PromptLibraryDeleteDialogs
        deletePromptOpen={deleteConfirmOpen}
        onCloseDeletePrompt={() => setDeleteConfirmOpen(false)}
        selectedPrompt={selectedPrompt}
        onDeletePrompt={handleDeletePrompt}
        categoryDeleteTarget={categoryDeleteTarget}
        categoryDeletePromptCount={categoryDeletePromptCount}
        categoryDeleteFallbackLabel={categoryDeleteFallbackLabel}
        onCloseDeleteCategory={() => setCategoryDeleteTarget(null)}
        onDeleteCategory={handleDeleteCategory}
      />
    </Box>
  );
}

export { PromptLibraryPage };
export default PromptLibraryPage;

import {
  createPromptFormFromItem,
  formatPromptLibraryUpdatedAt,
  getDefaultPromptLibraryItems,
  loadPromptLibraryStore,
  normalizePromptLibraryItem,
  savePromptLibraryStore,
} from '../../promptLibrary/lib/promptLibraryStore.jsx';
import {
  createSmartToolImagePipelineInput,
  prepareSmartToolImageGenerationPipeline,
} from '../../promptLibrary/services/smartToolImagePipelineService.js';

export const COLLECTION_PRODUCT_IMAGE_SKILL_ID = 'ozon-product-image-generation';

function text(value, maximum = 2_000) {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function findImageSkill(items = []) {
  return (Array.isArray(items) ? items : []).find((item) => item?.id === COLLECTION_PRODUCT_IMAGE_SKILL_ID) || null;
}

export function getDefaultCollectionProductImageSkill() {
  return findImageSkill(getDefaultPromptLibraryItems());
}

export async function loadCollectionProductImageSkill() {
  const store = await loadPromptLibraryStore();
  return findImageSkill(store?.items) || getDefaultCollectionProductImageSkill();
}

function list(value) {
  if (Array.isArray(value)) return value.map((item) => text(item, 4_000)).filter(Boolean);
  return String(value ?? '')
    .split(/[,，\n]/u)
    .map((item) => text(item, 4_000))
    .filter(Boolean);
}

export function createCollectionProductImageSkillEditorForm(skill = getDefaultCollectionProductImageSkill()) {
  const source = skill || getDefaultCollectionProductImageSkill();
  return createPromptFormFromItem({
    ...source,
    variables: Array.isArray(source?.variables) ? source.variables : [],
  });
}

export async function saveCollectionProductImageSkillEditorForm(editorForm = {}) {
  const store = await loadPromptLibraryStore();
  const current = findImageSkill(store?.items) || getDefaultCollectionProductImageSkill();
  const promptConfig = {
    ...current.promptConfig,
    defaultModelId: text(editorForm.imageModelId || editorForm.defaultModelId || 'auto', 240) || 'auto',
    plannerModelId: text(editorForm.plannerModelId || 'auto', 240) || 'auto',
    imageModelId: text(editorForm.imageModelId || editorForm.defaultModelId || 'auto', 240) || 'auto',
    imagePositionRules: editorForm.imagePositionRules,
    imagePositionRulesVersion: Number(editorForm.imagePositionRulesVersion) || 1,
    attributeRules: editorForm.attributeRules,
    attributeRulesVersion: Number(editorForm.attributeRulesVersion) || 1,
    modelPurpose: text(editorForm.modelPurpose, 2_000),
    systemPrompt: String(editorForm.systemPrompt || '').trim(),
    userPrompt: String(editorForm.userPrompt || '').trim(),
    outputFormat: String(editorForm.outputFormat || '').trim(),
    outputRules: list(editorForm.outputRules),
    workflowSteps: list(editorForm.workflowSteps),
    safetyRules: list(editorForm.safetyRules),
    capabilities: list(editorForm.capabilities),
    inputs: list(editorForm.inputs),
    outputs: list(editorForm.outputs),
  };
  const savedItem = normalizePromptLibraryItem(
    {
      ...current,
      promptConfig,
      updatedAt: formatPromptLibraryUpdatedAt(),
    },
    0,
    store.categories
  );
  const savedStore = await savePromptLibraryStore({
    ...store,
    items: [savedItem, ...store.items.filter((item) => item.id !== COLLECTION_PRODUCT_IMAGE_SKILL_ID)],
  });
  return findImageSkill(savedStore?.items) || savedItem;
}

function sourceAttributeLines(product = {}) {
  return (Array.isArray(product.attributes) ? product.attributes : [])
    .map((item) => {
      const name = text(item?.name ?? item?.title ?? item?.key, 180);
      const value = text(item?.value ?? item?.valueText ?? item?.text, 500);
      return name && value ? `${name}：${value}` : '';
    })
    .filter(Boolean)
    .slice(0, 30);
}

export function buildCollectionProductImageSkillFacts({
  product = {},
  draft = {},
  group = 'main',
  rows = [],
  selectedIndexes = [],
} = {}) {
  const selectedLabels = (Array.isArray(selectedIndexes) ? selectedIndexes : [])
    .map((index) => rows[index]?.label)
    .map((value) => text(value, 160))
    .filter(Boolean);
  const enabledSkus = (Array.isArray(draft.skus) ? draft.skus : []).filter((item) => item?.enabled !== false);
  const skuLabels = enabledSkus
    .map((item) => text(item?.sourceSkuName || item?.name || item?.label, 220))
    .filter(Boolean)
    .slice(0, 30);
  const productLevelImage = group !== 'sku';
  return [
    `来源平台：${text(product.platform || product.sourcePlatform, 120) || '采集商品'}`,
    `来源商品原始标题：${text(product.title || product.name, 800) || '未提供'}`,
    `来源类目：${text(product.sourceCategoryPath || product.sourceCategoryName || draft.sourceCategoryPath, 600) || '未提供'}`,
    `图片分组：${group === 'detail' ? '详情图' : group === 'sku' ? 'SKU 图' : '主图'}`,
    `选中图片：${selectedLabels.join('、') || '未提供标签'}`,
    `可售 SKU 种类数：${enabledSkus.length}（这是规格种类数，不是任何一张图片应显示的商品件数）`,
    skuLabels.length
      ? `可售 SKU 名称：${skuLabels.join('；')}（仅供识别规格范围，不得把名称中的数字合并或套用到其他图片）`
      : '',
    productLevelImage
      ? '当前是商品级共用图片，没有绑定单一 SKU；不得从 Ozon 标题、SKU 列表或包装文案推断画面数量，也不得在画面写包装数量。'
      : '当前是 SKU 图片；只有与当前参考图一一绑定且能从参考图直接确认的规格事实才可进入画面。',
    '商品外形和画面可见数量只以当前绑定参考图为准；文字资料与参考图冲突时，以参考图的真实外形和可见数量为准。',
    ...sourceAttributeLines(product),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runCollectionProductImageSkillBatch(input = {}, options = {}) {
  const skill = input.skill || getDefaultCollectionProductImageSkill();
  const sourceImageIndexes = Array.isArray(input.sourceImageIndexes) ? input.sourceImageIndexes : [];
  const productImageUrls = Array.isArray(input.productImageUrls) ? input.productImageUrls : [];
  const count = sourceImageIndexes.length || productImageUrls.length;
  if (!skill || skill.id !== COLLECTION_PRODUCT_IMAGE_SKILL_ID) {
    throw new Error('没有读取到 Ozon 商品图生成 Skill。');
  }
  if (!text(input.shopId, 160)) throw new Error('请先选择当前商品所属的 Ozon 店铺。');
  if (!count) throw new Error('请先选择要生成的来源图片。');

  const stagedInput = createSmartToolImagePipelineInput({
    ...input,
    skill,
    // Collection images must be durable before the user chooses the eventual
    // Ozon upload shops. The desktop bridge stores the generated bytes in the
    // internal image-asset scope and returns a real local asset id.
    persistGeneratedAsset: true,
    sourceImageIndexes,
    productImageUrls,
    imageGroup: input.imageGroup === 'detail' ? 'detail' : 'main',
  }, skill);
  options.onPhase?.({ phase: 'planning', message: `正在读取并完整编译 ${count} 个 Skill 图片位置…` });
  const prepared = await prepareSmartToolImageGenerationPipeline(stagedInput, count, {
    runPromptPlan: options.runPromptPlan,
    runGenerationBatch: options.runGenerationBatch,
    planStrategy: options.planStrategy || 'compiled',
    planOptions: options.planOptions,
    generationOptions: options.generationOptions,
    onItemSettled: options.onItemSettled,
  });
  const { promptPlan } = prepared;
  options.onPhase?.({
    phase: 'generating',
    promptPlan,
    message:
      prepared.planStrategy === 'compiled'
        ? '完整 Skill 位置规则已直接编译，正在并行生图…'
        : prepared.pipelined
          ? '图片方案已完成，逐图生图已与分析过程并行执行…'
          : '图片方案已完成，正在按逐图规则并行生图…',
  });
  const generation = await prepared.generationPromise;
  options.onPhase?.({ phase: 'complete', promptPlan, generation, message: 'Skill 图片处理已完成。' });
  return {
    ...generation,
    skillId: skill.id,
    skillTitle: skill.title,
    promptPlan,
    plannerFallbackCount: Number(promptPlan?.plannerFallbackCount) || 0,
  };
}

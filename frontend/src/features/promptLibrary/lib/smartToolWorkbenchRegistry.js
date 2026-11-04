import { getSmartToolExecutionPlan } from './smartToolExecutionPlan.js';
import { isUserInstalledSmartTool } from './smartToolInstalledSkill.js';
import { normalizeImagePositionRules } from './smartToolSkillConfiguration.js';

export const SMART_TOOL_WORKBENCH_VERSION = 1;

export const SMART_TOOL_WORKBENCH_KIND = Object.freeze({
  STANDARD: 'standard',
  PRODUCT_CONTENT: 'product-content',
});

export const SMART_TOOL_WORKBENCH_MODULE = Object.freeze({
  PRODUCT_SELECTOR: 'product-selector',
  IMAGE_SLOTS: 'image-slots',
  LISTING_FIELDS: 'listing-fields',
  ATTRIBUTE_GRID: 'attribute-grid',
  EXECUTION_RECORD: 'execution-record',
});

const IMAGE_JOB_LABELS = Object.freeze({
  'primary/ctr image': '首图 / 点击图',
  'structure image': '结构展示图',
  'dimension/specification image': '尺寸规格图',
  'material/detail image': '材质细节图',
  'function/use image': '功能使用图',
  'best remaining decision aid': '补充决策图',
});

function text(value) {
  return String(value ?? '').trim();
}

function mergedTextList(...values) {
  return [
    ...new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .map(text)
        .filter(Boolean)
    ),
  ];
}

function skillSearchText(tool = {}) {
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const referenceText = (Array.isArray(profile.referenceFiles) ? profile.referenceFiles : [])
    .map((item) => `${text(item?.path)}\n${text(item?.content)}`)
    .join('\n');
  return [
    tool?.title,
    tool?.goal,
    tool?.body,
    ...(Array.isArray(profile.capabilities) ? profile.capabilities : []),
    ...(Array.isArray(profile.outputs) ? profile.outputs : []),
    ...(Array.isArray(profile.workflowSteps) ? profile.workflowSteps : []),
    referenceText,
  ]
    .map(text)
    .filter(Boolean)
    .join('\n');
}

function hasProductContentSignals(tool = {}, plan = {}) {
  if (plan.requiresImageExecution) return true;
  const source = skillSearchText(tool);
  return (
    /(?:product|listing|商品|sku|spu|skc)/iu.test(source) &&
    /(?:title|description|attribute|seo|copy|标题|简介|详情|属性|文案)/iu.test(source)
  );
}

function hasTextContentSignals(tool = {}, plan = {}) {
  if (plan.steps?.some((item) => item.id === 'model.text.generate')) return true;
  return /(?:title|description|attribute|seo|copy|标题|简介|详情|属性|文案)/iu.test(skillSearchText(tool));
}

function extractImageJobs(tool = {}) {
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const structuredJobs = (Array.isArray(profile.imageJobs) ? profile.imageJobs : [])
    .map((item, index) => {
      const sourceIndex = Number.isInteger(Number(item?.sourceIndex)) ? Number(item.sourceIndex) : index;
      return {
        id: text(item?.id) || `image-job-${sourceIndex + 1}`,
        position: sourceIndex,
        title: text(item?.purpose || item?.title || item?.sourceTitle) || `主图位置 ${sourceIndex + 1}`,
        sourceTitle: text(item?.sourceTitle || item?.title || item?.purpose),
        instruction: text(item?.instructions || item?.instruction),
      };
    })
    .filter((item) => item.title)
    .sort((left, right) => left.position - right.position)
    .slice(0, 30);
  if (structuredJobs.length) return structuredJobs;
  const source = skillSearchText(tool);
  const matches = [...source.matchAll(/^\s*\d+[.)]\s+\*\*([^*]+)\*\*\s*:\s*([^\n]*)/gimu)];
  const jobs = matches
    .map((match, index) => {
      const rawTitle = text(match[1]).replace(/\.$/u, '');
      const normalizedTitle = rawTitle.toLowerCase();
      return {
        id: `image-job-${index + 1}`,
        position: index,
        title: IMAGE_JOB_LABELS[normalizedTitle] || rawTitle,
        sourceTitle: rawTitle,
        instruction: text(match[2]),
      };
    })
    .filter((item) => /image|图片|图/iu.test(`${item.sourceTitle} ${item.title}`))
    .slice(0, 12);
  return jobs;
}

function formatPositionInstruction(positionRule = {}) {
  return [
    positionRule?.instructions,
    positionRule?.visibleText ? `画面文字：${positionRule.visibleText}` : '',
    positionRule?.mustAvoid ? `禁止内容：${positionRule.mustAvoid}` : '',
  ]
    .map(text)
    .filter(Boolean)
    .join('\n');
}

function createImageExecutionContext(tool = {}, imageJobs = [], positionRules = {}) {
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const promptConfig = tool?.promptConfig && typeof tool.promptConfig === 'object' ? tool.promptConfig : {};
  const normalizedPositionRules = normalizeImagePositionRules(positionRules);
  const referenceFiles = (Array.isArray(profile.referenceFiles) ? profile.referenceFiles : [])
    .map((item) => ({ path: text(item?.path), content: text(item?.content) }))
    .filter((item) => item.path && item.content)
    .filter((item) =>
      /(?:image|visual|photo|picture|asset|prompt|output|图片|图像|视觉|输出)/iu.test(`${item.path}\n${item.content}`)
    )
    .slice(0, 8);
  return {
    policyVersion:
      text(tool?.id) === 'ozon-product-image-generation'
        ? 'ozon-product-image-rules-2.0.7'
        : 'smart-tool-image-rules-1',
    toolId: text(tool?.id),
    title: text(tool?.title),
    goal: text(tool?.goal),
    body: text(tool?.body).slice(0, 12_000),
    systemPrompt: text(promptConfig.systemPrompt).slice(0, 12_000),
    userPrompt: text(promptConfig.userPrompt).slice(0, 8_000),
    outputFormat: text(promptConfig.outputFormat).slice(0, 4_000),
    referenceFiles,
    workflowSteps: mergedTextList(promptConfig.workflowSteps, profile.workflowSteps).slice(0, 40),
    outputs: mergedTextList(promptConfig.outputs, profile.outputs).slice(0, 40),
    outputRules: mergedTextList(promptConfig.outputRules).slice(0, 40),
    safetyRules: mergedTextList(promptConfig.safetyRules, profile.safetyNotes).slice(0, 60),
    skuImageRules: (Array.isArray(profile.skuImageRules) ? profile.skuImageRules : [])
      .map(text)
      .filter(Boolean)
      .slice(0, 40),
    qaRules: (Array.isArray(profile.qaRules) ? profile.qaRules : []).map(text).filter(Boolean).slice(0, 60),
    evidenceRules: (Array.isArray(profile.evidenceRules) ? profile.evidenceRules : [])
      .map(text)
      .filter(Boolean)
      .slice(0, 60),
    stopConditions: (Array.isArray(profile.stopConditions) ? profile.stopConditions : [])
      .map(text)
      .filter(Boolean)
      .slice(0, 40),
    imageSlots: (imageJobs.length
      ? imageJobs
      : normalizedPositionRules.main.map((rule) => ({
          position: rule.sourceIndex,
          title: text(rule.purpose) || `主图位置 ${rule.sourceIndex + 1}`,
          instruction: formatPositionInstruction(rule),
        }))
    ).map((item) => {
      const positionRule = normalizedPositionRules.main.find((rule) => rule.sourceIndex === item.position);
      return {
        sourceIndex: item.position,
        title: text(positionRule?.purpose) || item.title,
        instruction: formatPositionInstruction(positionRule) || item.instruction,
      };
    }),
    detailImageSlots: normalizedPositionRules.detail.map((positionRule) => ({
      sourceIndex: positionRule.sourceIndex,
      title: text(positionRule.purpose) || `详情图位置 ${positionRule.sourceIndex + 1}`,
      instruction: formatPositionInstruction(positionRule),
    })),
  };
}

export function createSmartToolImageExecutionContext(tool = {}) {
  const toolId = text(tool?.id);
  const executionPlan = getSmartToolExecutionPlan(tool);
  const positionRules = normalizeImagePositionRules(tool?.promptConfig?.imagePositionRules, {
    toolId,
    useDefaults: toolId === 'ozon-product-image-generation',
  });
  const imageJobs =
    executionPlan.requiresImageExecution === true || toolId === 'ozon-product-image-generation'
      ? extractImageJobs(tool)
      : [];
  return createImageExecutionContext(tool, imageJobs, positionRules);
}

export function resolveSmartToolWorkbench(tool = {}) {
  const installed = isUserInstalledSmartTool(tool);
  if (!installed) {
    return {
      version: SMART_TOOL_WORKBENCH_VERSION,
      kind: SMART_TOOL_WORKBENCH_KIND.STANDARD,
      modules: [],
      supportsImages: false,
      supportsListingFields: false,
      supportsAttributes: false,
      requiresExplicitImageSelection: false,
      modeInputLabel: '',
      imageJobs: [],
      imagePositionRules: { main: [], detail: [] },
      imageExecutionContext: null,
    };
  }

  const executionPlan = getSmartToolExecutionPlan(tool);
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const usageInputs = Array.isArray(profile.usageInputs)
    ? profile.usageInputs.map(text).filter(Boolean)
    : Array.isArray(tool?.variables)
      ? tool.variables.map(text).filter(Boolean)
      : [];
  const modeInputLabel = usageInputs.find((item) => /(?:模式|范围|mode|scope)/iu.test(item)) || '';
  const productContent = hasProductContentSignals(tool, executionPlan);
  const supportsImages = executionPlan.requiresImageExecution === true;
  const supportsListingFields = productContent && hasTextContentSignals(tool, executionPlan);
  const supportsAttributes = supportsListingFields && /(?:attribute|属性)/iu.test(skillSearchText(tool));
  const imageJobs = supportsImages ? extractImageJobs(tool) : [];
  const imagePositionRules = normalizeImagePositionRules(tool?.promptConfig?.imagePositionRules);

  if (!supportsImages) {
    return {
      version: SMART_TOOL_WORKBENCH_VERSION,
      kind: SMART_TOOL_WORKBENCH_KIND.STANDARD,
      modules: [SMART_TOOL_WORKBENCH_MODULE.EXECUTION_RECORD],
      supportsImages: false,
      supportsListingFields,
      supportsAttributes,
      requiresExplicitImageSelection: false,
      modeInputLabel,
      imageJobs: [],
      imagePositionRules,
      imageExecutionContext: null,
    };
  }

  return {
    version: SMART_TOOL_WORKBENCH_VERSION,
    kind: SMART_TOOL_WORKBENCH_KIND.PRODUCT_CONTENT,
    modules: [
      SMART_TOOL_WORKBENCH_MODULE.PRODUCT_SELECTOR,
      SMART_TOOL_WORKBENCH_MODULE.IMAGE_SLOTS,
      ...(supportsListingFields ? [SMART_TOOL_WORKBENCH_MODULE.LISTING_FIELDS] : []),
      ...(supportsAttributes ? [SMART_TOOL_WORKBENCH_MODULE.ATTRIBUTE_GRID] : []),
      SMART_TOOL_WORKBENCH_MODULE.EXECUTION_RECORD,
    ],
    supportsImages: true,
    supportsListingFields,
    supportsAttributes,
    requiresExplicitImageSelection: true,
    modeInputLabel,
    imageJobs,
    imagePositionRules,
    imageExecutionContext: createImageExecutionContext(tool, imageJobs, imagePositionRules),
  };
}

export function isSmartToolProductImageWorkbench(workbench = {}) {
  const modules = Array.isArray(workbench?.modules) ? workbench.modules : [];
  return Boolean(
    workbench?.kind === SMART_TOOL_WORKBENCH_KIND.PRODUCT_CONTENT &&
    workbench?.supportsImages === true &&
    modules.includes(SMART_TOOL_WORKBENCH_MODULE.PRODUCT_SELECTOR) &&
    modules.includes(SMART_TOOL_WORKBENCH_MODULE.IMAGE_SLOTS)
  );
}

export function createSmartToolImageSlotDefinitions(workbench = {}, group = 'main', count = 0, sku = null) {
  const safeCount = Math.max(0, Number(count) || 0);
  const jobs = Array.isArray(workbench?.imageJobs) ? workbench.imageJobs : [];
  const positionRules = normalizeImagePositionRules(workbench?.imagePositionRules);
  return Array.from({ length: safeCount }, (_, index) => {
    const job = group === 'main' ? jobs[index] : null;
    const positionRule = positionRules[group]?.find((item) => item.sourceIndex === index) || null;
    const skuLabel = text(sku?.label || sku?.sku || sku?.id);
    const positionInstruction = formatPositionInstruction(positionRule);
    return {
      id: `${group}-${index}`,
      group,
      sourceIndex: index,
      title:
        text(positionRule?.purpose) ||
        job?.title ||
        (group === 'detail'
          ? `详情图位置 ${index + 1}`
          : skuLabel && index >= jobs.length
            ? `SKU 图位置 ${index + 1}`
            : `主图位置 ${index + 1}`),
      instruction:
        positionInstruction ||
        job?.instruction ||
        (group === 'detail'
          ? '保持该详情图对应的信息位置，按 Skill 规则生成。'
          : '保持商品身份与当前图片位置，按 Skill 规则生成。'),
    };
  });
}

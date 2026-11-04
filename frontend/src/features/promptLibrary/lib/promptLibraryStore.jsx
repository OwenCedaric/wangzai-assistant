import { getProfileSetting, saveProfileSetting } from '../../../api/localApiClient.js';
import { getSmartToolPromptTemplate, resolveSmartToolSystemPrompt } from './smartToolServerTemplates.js';
import { getSmartToolSkillProfile } from './smartToolSkillCatalog.js';
import { externalOzonSkillItems } from './externalOzonSkillCatalog.js';
import { ozonSkillItems } from './ozonSkillCatalog.js';
import {
  isExternalOzonInsightToolId,
  normalizeExternalOzonInsightConfig,
} from './smartToolExternalOzonInsightConfig.js';
import { normalizeProfitReviewPresentation } from './smartToolProfitReviewConfig.js';
import { PROFIT_ORDER_REVIEW_SKILL_ID } from '../../profitReview/constants/profitOrderReviewContract.js';
import {
  createEmptyAttributeRules,
  createEmptyImagePositionRules,
  mergeImagePositionRuleDefaults,
  normalizeAttributeRules,
  normalizeImagePositionRules,
  SMART_TOOL_ATTRIBUTE_RULES_VERSION,
  SMART_TOOL_IMAGE_POSITION_RULES_VERSION,
} from './smartToolSkillConfiguration.js';
import {
  isUserInstalledSmartTool,
  localizeInstalledSkillInputLabel,
  normalizeInstalledSkillProfile,
  resolveInstalledSkillPresentation,
} from './smartToolInstalledSkill.js';

const OZON_PRODUCT_SEARCH_ID = 'ozon-product-search';
const OZON_PRODUCT_SEARCH_GOAL = '搜索 Ozon 商品并完成市场机会、竞争、转化和风险决策分析';
const OZON_PRODUCT_SEARCH_BODY =
  '输入中文、俄文关键词、SKU 或商品链接后，链接由独立解析浏览器读取，Ozon 市场由后台专用浏览器（轮询）执行只读查询；按 SKU 合并已返回的价格、销量、广告、流量、履约、包裹和跟卖详情，再生成市场机会、费用预估、风险与执行动作。';
const OZON_AD_ANALYZER_ID = 'ozon-ad-analyzer';
const OZON_AD_ANALYZER_GOAL = '读取真实广告数据，判断计划效率、浪费点和调整顺序';
const OZON_AD_ANALYZER_BODY =
  '从已接入的 Ozon Performance API 实时读取所选广告计划、完整统计和每日趋势，区分暂无数据与真实数值 0，统一计算 CTR、CPC、CVR、CPO、ACOS、ROAS，再由所选文本模型严格执行可编辑 Skill 提示词并输出只读广告诊断报告。';
const PROFIT_ORDER_REVIEW_TITLE = '订单利润与商品投入评估';
const PROFIT_ORDER_REVIEW_GOAL = '输入订单号，核算利润并判断对应商品是否值得继续投入';
const PROFIT_ORDER_REVIEW_BODY =
  '输入订单号后，自动读取完整利润账本和同 SKU 历史；Seerfar 可用时继续查询近 30 天销量、销售额、库存、评分和趋势，再由文本模型给出利润优化与投入建议。全程只读，不改订单和金额。';
const COMPLETED_OPERATIONAL_SKILL_IDS = new Set([
  'ozon-skill-1688-product-detail-query',
  'ozon-skill-1688-channel-shopdata-get',
  'ozon-skill-1688-channel-shopdata-analyzer',
]);
const RETIRED_SMART_TOOL_IDS = new Set([
  'ozon-attribute-autofill',
  'product-title-optimization',
  'ozon-skill-1688-pricing-sku-calculator',
  'ozon-skill-1688-channel-profit-estimate',
  'image-scene-prompt',
  'ozon-image-translator',
  'ozon-write-guard',
  'ozon-skill-1688-distribution-ozon-list',
  'ozon-skill-1688-product-keyword-research',
  'ozon-skill-1688-product-image-search',
  'ozon-skill-1688-product-downstream-search',
  'ozon-skill-1688-product-ranking',
  'ozon-skill-1688-supplychain-smart-replenishment',
]);
const SKILL_PROVENANCE_KEYS = new Set([
  'sourceName',
  'sourceUrl',
  'secondarySourceUrl',
  'sourceRef',
  'originalSkillName',
  'installType',
  'provider',
  'providerType',
  'operation',
]);

function stripSkillProvenance(profile = {}) {
  return Object.fromEntries(Object.entries(profile).filter(([key]) => !SKILL_PROVENANCE_KEYS.has(key)));
}

export {
  buildPurchaseCrossBorderCancelBody,
  buildPurchaseCrossBorderPackageBody,
  buildPurchaseCrossBorderSheetBody,
  submitPurchaseOzonAwaitingDelivery,
} from '../../../services/purchaseCrossBorderRuntime.js';

export {
  trendMetricTabs,
  dashboardTrendCategories,
  createDashboardTrendChart,
  formatDashboardCny,
  formatDashboardPercent,
  getDashboardOrderAmountValue,
  getDashboardRefundAmountValue,
  getDashboardProductQuantity,
  sumDashboardValues,
  readDashboardOzonSnapshotRows,
  filterDashboardRowsByDate,
  getDashboardShopScope,
  dashboardRowMatchesShop,
  getDashboardProfitValue,
  buildDashboardProfitRows,
  getDashboardTrendBucketIndex,
  buildDashboardTrendData,
  createDashboardConversionRows,
  createDashboardTodoRows,
  createDashboardHotProductRows,
  createDashboardStorePerformanceRows,
  createDashboardProfitSummaryCards,
} from '../../../services/dashboardMetricsRuntime.jsx';

export const promptLibraryItems = [
  {
    id: OZON_PRODUCT_SEARCH_ID,
    scene: 'ozon',
    sceneLabel: 'Ozon 工具',
    title: 'Ozon 商品搜索',
    goal: OZON_PRODUCT_SEARCH_GOAL,
    status: '可用',
    tone: 'success',
    updatedAt: '07-08 10:20',
    used: 0,
    owner: '运营组',
    body: OZON_PRODUCT_SEARCH_BODY,
    variables: ['关键词或 SKU', '产品链接（可选）'],
  },
  {
    id: 'ozon-product-selection',
    scene: 'selection',
    sceneLabel: '选品分析',
    title: 'Ozon 选品助手',
    goal: '读取 Ozon 真实市场数据，判断商品值不值得测试',
    status: '可用',
    tone: 'success',
    updatedAt: '08-02 01:00',
    used: 0,
    owner: '选品组',
    body: '先用 Ozon 真实商品数据完成固定七维评分，再把同类热销商品转换成中文采购词并核对 1688 候选货源，最后由文本模型解释证据；可选 Seerfar 复核和指定货源精确核对。',
    variables: ['商品关键词、SKU 或 Ozon 链接', 'Seerfar 市场复核', '1688 货源链接（可选）'],
  },
  {
    id: 'ozon-ad-analyzer',
    scene: 'marketing',
    sceneLabel: '营销活动',
    title: 'Ozon 广告分析',
    goal: OZON_AD_ANALYZER_GOAL,
    status: '可用',
    tone: 'success',
    updatedAt: '07-31 16:00',
    used: 0,
    owner: '运营组',
    body: OZON_AD_ANALYZER_BODY,
    variables: ['推广账号（可选）', '广告计划名称或 ID（可选）', '统计范围'],
    dependencies: ['Ozon Performance API 账号'],
  },
  {
    id: 'ozon-product-image-generation',
    scene: 'image',
    sceneLabel: '图片素材',
    title: 'Ozon 商品图生成',
    goal: '按商品图生成规则生成主图和详情图方案',
    status: '可用',
    tone: 'success',
    updatedAt: '07-20 10:00',
    used: 0,
    owner: '设计组',
    body: '根据实际选中的商品图片和 SKU 事实生成逐图 PromptPlan；数量由用户选择，每个商品图片位置可绑定独立规则。生成后可预览，确认后替换 Ozon 图片并等待回读。',
    variables: ['商品图片或商品 SKU', 'SKU 信息', '目标场景（可选）'],
  },
  {
    id: PROFIT_ORDER_REVIEW_SKILL_ID,
    scene: 'profit',
    sceneLabel: '利润核算',
    title: PROFIT_ORDER_REVIEW_TITLE,
    goal: PROFIT_ORDER_REVIEW_GOAL,
    status: '可用',
    tone: 'success',
    updatedAt: '07-31 12:00',
    used: 14,
    owner: '财务组',
    body: PROFIT_ORDER_REVIEW_BODY,
    variables: ['订单号'],
  },
  ...externalOzonSkillItems,
  ...ozonSkillItems,
];

export const promptLibraryScenes = [
  { value: 'all', label: '全部工具' },
  { value: 'ozon', label: 'Ozon 工具' },
  { value: '1688', label: '1688 工具' },
  { value: 'selection', label: '选品分析' },
  { value: 'product', label: '商品优化' },
  { value: 'image', label: '图片素材' },
  { value: 'marketing', label: '营销活动' },
  { value: 'report', label: '数据报表' },
  { value: 'profit', label: '利润核算' },
];

export const PROFILE_PROMPT_LIBRARY_NAMESPACE = 'prompt-library';

export const defaultPromptLibraryCategories = promptLibraryScenes.filter((item) => item.value !== 'all');

export const promptLibraryStatusOptions = ['可用', '部分可用', '待配置', '待接入'];

export const SMART_TOOL_MANIFEST_VERSION = 1;

export const smartToolPageRules = {
  profit: {
    pageId: 'profit',
    pageLabel: '利润核算',
    entryLabels: ['利润核算'],
    sceneValues: ['profit'],
    toolIds: ['profit-risk-review'],
  },
  salesOrders: {
    pageId: 'salesOrders',
    pageLabel: '销售订单',
    entryLabels: ['销售订单'],
    sceneValues: ['profit', 'ozon'],
    toolIds: ['profit-risk-review'],
  },
  paidPromotion: {
    pageId: 'paidPromotion',
    pageLabel: '付费推广',
    entryLabels: ['付费推广', '营销活动'],
    sceneValues: ['marketing'],
    toolIds: ['ozon-ad-analyzer'],
  },
  products: {
    pageId: 'products',
    pageLabel: '商品列表',
    entryLabels: ['商品列表', '商品详情', '商品编辑'],
    sceneValues: ['ozon', 'product', 'image', 'selection'],
    toolIds: ['ozon-product-search', 'ozon-product-selection'],
  },
};

const defaultSmartToolEntryPointsByScene = {
  ozon: ['商品列表', '商品详情', '选品分析'],
  1688: ['商品列表', '商品编辑', '拍单管理'],
  selection: ['选品分析', '商品列表'],
  product: ['商品列表', '商品编辑'],
  image: ['商品编辑', '素材处理'],
  marketing: ['营销活动', '付费推广'],
  report: ['旺崽汇总', '数据报表'],
  profit: ['利润核算', '销售订单'],
  system: ['工具中心', '系统设置'],
};

const defaultSmartToolEntryPointsById = {
  'ozon-product-search': ['商品列表', '商品详情', '选品分析'],
  'ozon-product-selection': ['选品分析', '商品列表'],
  'ozon-ad-analyzer': ['付费推广', '营销活动'],
  'profit-risk-review': ['利润核算', '销售订单'],
};

const promptLibraryLegacyStatusMap = {
  常用: '可用',
  已整理: '部分可用',
  待补充: '待配置',
};

export function getDefaultPromptLibraryCategories() {
  return defaultPromptLibraryCategories.map((item, index) => normalizePromptLibraryCategory(item, index));
}

export function formatPromptLibraryUpdatedAt(date = new Date()) {
  return date
    .toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(/\//g, '-');
}

export function getDefaultPromptLibraryItems(categories = getDefaultPromptLibraryCategories()) {
  return promptLibraryItems.map((item, index) => normalizePromptLibraryItem(item, index, categories));
}

function mergePromptLibraryItemsWithDefaults(items = [], categories = getDefaultPromptLibraryCategories()) {
  const legacyHiddenPrefix = ['new', 'ton'].join('');
  const retiredPaidAnalyticsProvider = /mpstats/iu;
  const normalizedItems = (Array.isArray(items) ? items : [])
    .filter((item) => !String(item?.id || '').startsWith(`${legacyHiddenPrefix}-`))
    .filter((item) => !RETIRED_SMART_TOOL_IDS.has(String(item?.id || '')))
    .filter(
      (item) =>
        ![
          item?.id,
          item?.title,
          item?.sourceName,
          item?.provider,
          item?.providerType,
          item?.skillProfile?.sourceName,
          item?.skillProfile?.originalSkillName,
        ].some((value) => retiredPaidAnalyticsProvider.test(String(value || '')))
    )
    .map((item, index) => normalizePromptLibraryItem(item, index, categories));
  const existingIds = new Set(normalizedItems.map((item) => item.id));
  const defaultItems = getDefaultPromptLibraryItems(categories);
  const missingDefaultItems = defaultItems.filter((item) => !existingIds.has(item.id));
  return [...normalizedItems, ...missingDefaultItems];
}

/** Canonical runtime load: profile-settings is the sole durable source. */
export async function loadPromptLibraryStore() {
  const current = await getProfileSetting(PROFILE_PROMPT_LIBRARY_NAMESPACE, { timeoutMs: 10000 });
  const sourceValue = current?.setting?.value;
  let store = sourceValue ? normalizePromptLibraryStore(current.setting.value) : normalizePromptLibraryStore();
  const containsRetiredItems =
    Array.isArray(sourceValue?.items) &&
    sourceValue.items.some((item) => RETIRED_SMART_TOOL_IDS.has(String(item?.id || '')));
  if (containsRetiredItems) {
    const saved = await saveProfileSetting(PROFILE_PROMPT_LIBRARY_NAMESPACE, store, { timeoutMs: 30000 });
    if (!saved?.setting?.value) throw new Error('智能工具废弃项清理回读失败。');
    store = normalizePromptLibraryStore(saved.setting.value);
  }
  promptLibraryStoreMemory = store;
  return store;
}

export function createEmptyPromptForm(categories = getDefaultPromptLibraryCategories()) {
  return {
    title: '',
    scene: categories[0]?.value ?? 'product',
    status: '部分可用',
    owner: '运营组',
    goal: '',
    variables: '',
    body: '',
    defaultModelId: 'auto',
    plannerModelId: 'auto',
    imageModelId: 'auto',
    imagePositionRules: createEmptyImagePositionRules(),
    imagePositionRulesVersion: SMART_TOOL_IMAGE_POSITION_RULES_VERSION,
    installedSkillParserVersion: 0,
    dependencyBindings: {},
    attributeRules: createEmptyAttributeRules(),
    attributeRulesVersion: SMART_TOOL_ATTRIBUTE_RULES_VERSION,
    externalInsightConfig: null,
    profitReviewPresentation: normalizeProfitReviewPresentation(),
    modelPurpose: '',
    systemPrompt: '',
    userPrompt: '',
    outputFormat: '',
    outputRules: '',
    workflowSteps: '',
    safetyRules: '',
    capabilities: '',
    inputs: '',
    outputs: '',
  };
}

export function createPromptLibraryCategoryId() {
  return `category-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function normalizePromptLibraryCategory(item, index = 0) {
  const label = String(item?.label || `分类 ${index + 1}`).trim();
  const nextLabel = item?.value === 'system' && label === '系统配置' ? '安全设置' : label;
  return {
    value: item?.value || createPromptLibraryCategoryId(),
    label: nextLabel,
  };
}

export function dedupePromptLibraryCategories(categories) {
  const seen = new Set();
  return categories.filter((item) => {
    const label = item.label.trim();
    if (!label || seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

function mergePromptLibraryCategoriesWithDefaults(categories) {
  const normalizedCategories = dedupePromptLibraryCategories(
    (Array.isArray(categories) ? categories : []).map((item, index) => normalizePromptLibraryCategory(item, index))
  );
  const existingValues = new Set(normalizedCategories.map((item) => item.value));
  const missingDefaults = getDefaultPromptLibraryCategories().filter((item) => !existingValues.has(item.value));
  return [...normalizedCategories, ...missingDefaults];
}

function splitSmartToolFieldList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value ?? '')
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinSmartToolPromptList(value, fallback = []) {
  const list = splitSmartToolFieldList(value);
  if (list.length) return list;
  return splitSmartToolFieldList(fallback);
}

function mergeSmartToolPromptList(value, fallback = []) {
  return [...new Set([...splitSmartToolFieldList(value), ...splitSmartToolFieldList(fallback)])];
}

function mergeInstalledSkillPositionRules(savedValue, parsedValue) {
  const saved = normalizeImagePositionRules(savedValue);
  const parsed = normalizeImagePositionRules(parsedValue);
  const mergeGroup = (group) => {
    const savedByIndex = new Map(saved[group].map((item) => [item.sourceIndex, item]));
    const merged = parsed[group].map((fallback) => {
      const current = savedByIndex.get(fallback.sourceIndex) || {};
      savedByIndex.delete(fallback.sourceIndex);
      return {
        ...fallback,
        ...current,
        purpose: String(current.purpose || fallback.purpose || '').trim(),
        instructions: String(current.instructions || fallback.instructions || '').trim(),
        visibleText: String(current.visibleText || fallback.visibleText || '').trim(),
        mustAvoid: String(current.mustAvoid || fallback.mustAvoid || '').trim(),
      };
    });
    return merged.concat([...savedByIndex.values()]);
  };
  return normalizeImagePositionRules({ main: mergeGroup('main'), detail: mergeGroup('detail') });
}

function mergeInstalledSkillAttributeRules(savedValue, parsedValue) {
  const saved = normalizeAttributeRules(savedValue);
  const parsed = normalizeAttributeRules(parsedValue);
  return Object.fromEntries(Object.keys(parsed).map((key) => [key, String(saved[key] || parsed[key] || '').trim()]));
}

function normalizeSmartToolPromptConfig(item = {}, baseTool = {}) {
  const savedConfig =
    item?.promptConfig && typeof item.promptConfig === 'object' && !Array.isArray(item.promptConfig)
      ? item.promptConfig
      : {};
  const template = getSmartToolPromptTemplate(baseTool);
  const defaultModelId = String(savedConfig.defaultModelId || item?.defaultModelId || 'auto').trim() || 'auto';
  const hasSavedPositionRules = Object.prototype.hasOwnProperty.call(savedConfig, 'imagePositionRules');
  const savedPositionRulesVersion = Number(savedConfig.imagePositionRulesVersion || 0);
  const installedParserVersion = Number(baseTool.skillProfile?.parserVersion || 0);
  const savedInstalledParserVersion = Number(savedConfig.installedSkillParserVersion || 0);
  const shouldMigrateInstalledParserRules =
    isUserInstalledSmartTool(baseTool) && installedParserVersion > savedInstalledParserVersion;
  const shouldUpgradeImagePositionRules =
    baseTool.id === 'ozon-product-image-generation' &&
    hasSavedPositionRules &&
    savedPositionRulesVersion < SMART_TOOL_IMAGE_POSITION_RULES_VERSION;
  const imagePositionRules = shouldMigrateInstalledParserRules
    ? mergeInstalledSkillPositionRules(savedConfig.imagePositionRules, baseTool.skillProfile?.imagePositionRules)
    : shouldUpgradeImagePositionRules
      ? mergeImagePositionRuleDefaults(savedConfig.imagePositionRules, baseTool.id)
      : normalizeImagePositionRules(savedConfig.imagePositionRules, {
          toolId: baseTool.id,
          useDefaults: !hasSavedPositionRules,
        });
  const hasSavedAttributeRules = Object.prototype.hasOwnProperty.call(savedConfig, 'attributeRules');
  const attributeRules = shouldMigrateInstalledParserRules
    ? mergeInstalledSkillAttributeRules(savedConfig.attributeRules, baseTool.skillProfile?.attributeRules)
    : normalizeAttributeRules(savedConfig.attributeRules, {
        toolId: baseTool.id,
        useDefaults: !hasSavedAttributeRules,
      });
  const useCanonicalOzonProductSearchRules = baseTool.id === OZON_PRODUCT_SEARCH_ID;
  const mergeCompletedOperationalRules = COMPLETED_OPERATIONAL_SKILL_IDS.has(baseTool.id);
  const promptList = mergeCompletedOperationalRules ? mergeSmartToolPromptList : joinSmartToolPromptList;
  const savedSystemPrompt = useCanonicalOzonProductSearchRules
    ? ''
    : savedConfig.systemPrompt ||
      item?.systemPrompt ||
      (isUserInstalledSmartTool(baseTool) ? baseTool.body : '') ||
      template.systemPrompt;
  const savedUserPrompt = useCanonicalOzonProductSearchRules
    ? template.userPrompt
    : savedConfig.userPrompt || item?.userPrompt || template.userPrompt || '';

  return {
    defaultModelId,
    plannerModelId: String(savedConfig.plannerModelId || 'auto').trim() || 'auto',
    imageModelId: String(savedConfig.imageModelId || defaultModelId).trim() || 'auto',
    imagePositionRules,
    imagePositionRulesVersion: SMART_TOOL_IMAGE_POSITION_RULES_VERSION,
    installedSkillParserVersion: installedParserVersion,
    attributeRules,
    attributeRulesVersion: SMART_TOOL_ATTRIBUTE_RULES_VERSION,
    modelPurpose: String(savedConfig.modelPurpose || item?.modelPurpose || template.modelPurpose || '').trim(),
    systemPrompt: resolveSmartToolSystemPrompt(baseTool, savedSystemPrompt),
    userPrompt: String(savedUserPrompt).trim(),
    outputFormat: String(savedConfig.outputFormat || item?.outputFormat || template.outputFormat || '').trim(),
    outputRules: promptList(savedConfig.outputRules || item?.outputRules, template.outputRules),
    workflowSteps: promptList(
      useCanonicalOzonProductSearchRules ? [] : savedConfig.workflowSteps || item?.workflowSteps,
      baseTool.skillProfile?.workflowSteps || []
    ),
    safetyRules: promptList(
      useCanonicalOzonProductSearchRules ? [] : savedConfig.safetyRules || item?.safetyRules,
      baseTool.skillProfile?.safetyNotes || []
    ),
    capabilities: promptList(
      useCanonicalOzonProductSearchRules ? [] : savedConfig.capabilities || item?.capabilities,
      baseTool.skillProfile?.capabilities || []
    ),
    inputs: promptList(
      useCanonicalOzonProductSearchRules ? [] : savedConfig.inputs || item?.inputs,
      baseTool.skillProfile?.inputs || baseTool.variables
    ),
    outputs: promptList(
      useCanonicalOzonProductSearchRules ? [] : savedConfig.outputs || item?.outputs,
      baseTool.skillProfile?.outputs || []
    ),
    externalInsightConfig: isExternalOzonInsightToolId(baseTool.id)
      ? normalizeExternalOzonInsightConfig(savedConfig.externalInsightConfig, { toolId: baseTool.id })
      : null,
    profitReviewPresentation:
      baseTool.id === PROFIT_ORDER_REVIEW_SKILL_ID
        ? normalizeProfitReviewPresentation(savedConfig.profitReviewPresentation)
        : null,
  };
}

export let promptLibraryStoreMemory = null;
let promptLibraryWriteQueue = Promise.resolve();

export function readPromptLibraryCategories() {
  return promptLibraryStoreMemory?.categories || getDefaultPromptLibraryCategories();
}

export function savePromptLibraryCategories(categories) {
  const nextCategories = dedupePromptLibraryCategories(
    categories.map((item, index) => normalizePromptLibraryCategory(item, index))
  );
  const currentStore = promptLibraryStoreMemory || normalizePromptLibraryStore();
  return savePromptLibraryStore({
    ...currentStore,
    categories: nextCategories.length ? nextCategories : getDefaultPromptLibraryCategories(),
  });
}

export function getPromptLibraryScenes(categories) {
  return [{ value: 'all', label: '全部工具' }, ...categories];
}

export function getPromptLibrarySceneLabel(sceneValue, categories = getDefaultPromptLibraryCategories()) {
  return categories.find((item) => item.value === sceneValue)?.label ?? categories[0]?.label ?? '未分类';
}

export function getPromptLibraryTone(status) {
  if (status === '可用') return 'success';
  if (status === '部分可用') return 'primary';
  if (status === '待配置') return 'warning';
  if (status === '常用') return 'success';
  if (status === '待补充') return 'warning';
  if (status === '待接入') return 'default';
  return 'success';
}

export function createPromptLibraryId() {
  return `prompt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function normalizePromptLibraryItem(item, index = 0, categories = getDefaultPromptLibraryCategories()) {
  const isOzonProductSearch = item?.id === OZON_PRODUCT_SEARCH_ID;
  const isOzonAdAnalyzer = item?.id === OZON_AD_ANALYZER_ID;
  const isProfitOrderReview = item?.id === PROFIT_ORDER_REVIEW_SKILL_ID;
  const isCompletedOperationalSkill = COMPLETED_OPERATIONAL_SKILL_IDS.has(item?.id);
  const canonicalOperationalTool = isCompletedOperationalSkill
    ? ozonSkillItems.find((candidate) => candidate.id === item?.id)
    : null;
  const availableScenes = categories.length ? categories : getDefaultPromptLibraryCategories();
  const sceneValue = availableScenes.some((sceneItem) => sceneItem.value === item?.scene)
    ? item.scene
    : (availableScenes[0]?.value ?? 'product');
  const normalizedStatus = promptLibraryLegacyStatusMap[item?.status] ?? item?.status;
  // The built-in image skill now has the full preview -> submit -> Ozon
  // readback path. Upgrade old persisted "部分可用" records once they are
  // loaded, while leaving custom tools and explicit newer statuses untouched.
  const isCompletedImageSkill =
    item?.id === 'ozon-product-image-generation' && ['部分可用', '待配置', '待接入'].includes(normalizedStatus);
  const status =
    isOzonProductSearch || isOzonAdAnalyzer || isProfitOrderReview || isCompletedOperationalSkill
      ? '可用'
      : isCompletedImageSkill
        ? '可用'
        : promptLibraryStatusOptions.includes(normalizedStatus)
          ? normalizedStatus
          : '部分可用';
  const rawVariables = Array.isArray(item?.variables)
    ? item.variables
    : String(item?.variables ?? '')
        .split(/[，,]/)
        .map((value) => value.trim())
        .filter(Boolean);
  const entryPoints = splitSmartToolFieldList(item?.entryPoints || item?.pages || item?.applicablePages);
  const dependencies = isOzonProductSearch
    ? ['Ozon 内置浏览器插件']
    : isOzonAdAnalyzer
      ? ['Ozon Performance API 账号', '文本模型接口']
      : isCompletedOperationalSkill
        ? splitSmartToolFieldList(canonicalOperationalTool?.dependencies)
        : splitSmartToolFieldList(item?.dependencies || item?.requires || item?.requiredSettings);
  const manifestVersion = Number(item?.manifestVersion || SMART_TOOL_MANIFEST_VERSION);
  const catalogSkillProfile = getSmartToolSkillProfile(item || {});
  const mergedSkillProfile = {
    ...catalogSkillProfile,
    ...(item?.skillProfile && typeof item.skillProfile === 'object' && !Array.isArray(item.skillProfile)
      ? item.skillProfile
      : {}),
  };
  const skillProfile = isOzonProductSearch
    ? {
        ...stripSkillProvenance(mergedSkillProfile),
        ...catalogSkillProfile,
      }
    : isOzonAdAnalyzer || isProfitOrderReview || isCompletedOperationalSkill
      ? {
          ...mergedSkillProfile,
          ...catalogSkillProfile,
        }
      : normalizeInstalledSkillProfile(item || {}, mergedSkillProfile);
  const installedToolIdentity = { ...(item || {}), skillProfile };
  const localizedVariables = rawVariables.map(localizeInstalledSkillInputLabel).filter(Boolean);
  const shouldUseInstalledUsageInputs =
    isUserInstalledSmartTool(installedToolIdentity) &&
    (!localizedVariables.length || (localizedVariables.length === 1 && localizedVariables[0] === '按工具说明准备'));
  const variables = shouldUseInstalledUsageInputs
    ? splitSmartToolFieldList(skillProfile.usageInputs)
    : localizedVariables;
  const rawBody = String(item?.body || '').trim();
  const body = isOzonProductSearch
    ? OZON_PRODUCT_SEARCH_BODY
    : isOzonAdAnalyzer
      ? OZON_AD_ANALYZER_BODY
      : isProfitOrderReview
        ? PROFIT_ORDER_REVIEW_BODY
        : isCompletedOperationalSkill
          ? String(canonicalOperationalTool?.body || rawBody).trim()
          : rawBody;
  const installedPresentation = resolveInstalledSkillPresentation({
    ...(item || {}),
    skillProfile,
    body,
  });

  const baseTool = {
    id: item?.id || createPromptLibraryId(),
    scene: sceneValue,
    sceneLabel: getPromptLibrarySceneLabel(sceneValue, availableScenes),
    title: isProfitOrderReview
      ? PROFIT_ORDER_REVIEW_TITLE
      : String(installedPresentation.title || item?.title || `未命名工具 ${index + 1}`).trim(),
    goal: isOzonProductSearch
      ? OZON_PRODUCT_SEARCH_GOAL
      : isOzonAdAnalyzer
        ? OZON_AD_ANALYZER_GOAL
        : isProfitOrderReview
          ? PROFIT_ORDER_REVIEW_GOAL
          : isCompletedOperationalSkill
            ? String(canonicalOperationalTool?.goal || item?.goal || '待补充用途').trim()
            : String(installedPresentation.goal || item?.goal || '待补充用途').trim(),
    status,
    tone: getPromptLibraryTone(status),
    updatedAt: item?.updatedAt || formatPromptLibraryUpdatedAt(),
    used: Number.isFinite(Number(item?.used)) ? Number(item.used) : 0,
    owner: String(item?.owner || '运营组').trim(),
    body,
    variables,
    entryPoints,
    dependencies,
    skillProfile,
    runMode: String(item?.runMode || item?.actionMode || '').trim(),
    manifestVersion: Number.isFinite(manifestVersion) ? manifestVersion : SMART_TOOL_MANIFEST_VERSION,
  };

  return {
    ...baseTool,
    promptConfig: normalizeSmartToolPromptConfig(item, baseTool),
  };
}

export function getSmartToolEntryPoints(item = {}) {
  const savedEntryPoints = splitSmartToolFieldList(item.entryPoints || item.pages || item.applicablePages);
  if (savedEntryPoints.length) return savedEntryPoints;
  return defaultSmartToolEntryPointsById[item.id] || defaultSmartToolEntryPointsByScene[item.scene] || ['工具中心'];
}

export function getSmartToolDependencies(item = {}) {
  return splitSmartToolFieldList(item.dependencies || item.requires || item.requiredSettings);
}

export function getSmartToolsForPage(pageId, items = [], options = {}) {
  const pageRule = smartToolPageRules[pageId];
  if (!pageRule) return [];
  const includeUnavailable = options.includeUnavailable !== false;
  return (Array.isArray(items) ? items : [])
    .filter((item) => {
      if (!includeUnavailable && item.status === '待接入') return false;
      const entryPoints = getSmartToolEntryPoints(item);
      return (
        pageRule.toolIds.includes(item.id) ||
        pageRule.sceneValues.includes(item.scene) ||
        entryPoints.some((entry) => pageRule.entryLabels.includes(entry))
      );
    })
    .sort((left, right) => {
      const leftPinned = pageRule.toolIds.includes(left.id) ? 0 : 1;
      const rightPinned = pageRule.toolIds.includes(right.id) ? 0 : 1;
      if (leftPinned !== rightPinned) return leftPinned - rightPinned;
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    });
}

function smartToolText(value, fallback = '未返回') {
  const text = String(value ?? '').trim();
  return text && text !== 'undefined' && text !== 'null' ? text : fallback;
}

function createSmartToolLines(title, rows = []) {
  const validRows = rows
    .map(([label, value]) => [label, smartToolText(value)])
    .filter(([, value]) => value && value !== '未返回');
  if (!validRows.length) return [];
  return [`## ${title}`, ...validRows.map(([label, value]) => `- ${label}：${value}`)];
}

function createSmartToolFeeLines(title, rows = []) {
  const feeRows = (Array.isArray(rows) ? rows : [])
    .map((item) => [item?.label, item?.value, item?.hint])
    .filter(([label, value]) => smartToolText(label, '') && smartToolText(value, ''));
  if (!feeRows.length) return [];
  return [
    `## ${title}`,
    ...feeRows.map(([label, value, hint]) => {
      const hintText = smartToolText(hint, '');
      return `- ${label}：${smartToolText(value)}${hintText ? `（${hintText}）` : ''}`;
    }),
  ];
}

export function createProfitSmartToolReviewText(tool = {}, context = {}) {
  const order = context.order || {};
  const orderInfo = context.orderInfo || {};
  const estimateSummary = Array.isArray(context.estimateSummary) ? context.estimateSummary : [];
  const lines = [
    `# ${smartToolText(tool.title, '低利润订单复核')}`,
    '',
    '使用规则：只整理原因，不改利润公式，不改金额，不写 Ozon。',
    '',
    ...createSmartToolLines('当前订单', [
      ['Ozon 订单号', orderInfo.ozonOrderId || order.id || order.posting],
      ['货号', orderInfo.offerId || order.offerId || order.sku],
      ['商品', order.product || order.products?.[0]?.name],
      ['店铺', orderInfo.shop || order.shop],
      ['付款时间', orderInfo.paymentTime || order.paymentTime],
      ['履约方式', order.fulfillment],
    ]),
    '',
    ...createSmartToolLines('利润结果', [
      ['销售收入', order.salesAmount],
      ['预估利润', order.estimatedProfit],
      ['实际利润', context.actualProfitDisplay || order.actualProfit],
      ['当前盈亏', context.statusDisplay],
      ['采购成本', orderInfo.purchaseCost],
      ['采购平台', orderInfo.purchasePlatform],
      ['采购订单号', orderInfo.purchaseOrderNo],
    ]),
    '',
    ...createSmartToolFeeLines('预估扣费', order.estimatedFees),
    '',
    ...(estimateSummary.length
      ? [
          '## 预估汇总',
          ...estimateSummary.map(
            (item) => `- ${item.label}：${smartToolText(item.value)}${item.hint ? `（${item.hint}）` : ''}`
          ),
        ]
      : []),
    '',
    ...createSmartToolFeeLines('实际扣费', context.actualFees),
    '',
    '请输出：',
    '1. 用大白话说明这单利润低或亏损最可能的原因。',
    '2. 分清楚是售价、采购成本、佣金、配送/物流、巴士费用、罚款或收单扣费哪一块影响最大。',
    '3. 只给复核建议，不要改金额，不要改利润公式。',
  ];
  return lines.filter((line, index, values) => line || values[index - 1]).join('\n');
}

export function normalizePromptLibraryStore(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const savedItems = Array.isArray(source.items) ? source.items : [];
  const hasActiveSystemTools = savedItems.some(
    (item) => item?.scene === 'system' && !RETIRED_SMART_TOOL_IDS.has(String(item?.id || ''))
  );
  const savedCategories = Array.isArray(source.categories)
    ? source.categories.filter((item) => item?.value !== 'system' || hasActiveSystemTools)
    : source.categories;
  const categories = Array.isArray(source.categories)
    ? mergePromptLibraryCategoriesWithDefaults(savedCategories)
    : getDefaultPromptLibraryCategories();
  const safeCategories = categories.length ? categories : getDefaultPromptLibraryCategories();
  const items =
    Array.isArray(source.items) && source.items.length
      ? mergePromptLibraryItemsWithDefaults(source.items, safeCategories)
      : getDefaultPromptLibraryItems(safeCategories);
  return {
    version: 1,
    categories: safeCategories,
    items,
    updatedAt: String(source.updatedAt || ''),
  };
}

export function readPromptLibraryItems(categories = readPromptLibraryCategories()) {
  const store = promptLibraryStoreMemory;
  if (store?.items) {
    return store.items.map((item, index) => normalizePromptLibraryItem(item, index, categories));
  }
  return getDefaultPromptLibraryItems(categories);
}

export function enqueuePromptLibraryWrite(writer) {
  const writePromise = promptLibraryWriteQueue.catch(() => undefined).then(writer);
  promptLibraryWriteQueue = writePromise.catch(() => undefined);
  return writePromise;
}

/** Optimistic UI state is memory-only; durable writes always go through local-api SQLite. */
export function savePromptLibraryStore(store) {
  const nextStore = normalizePromptLibraryStore({
    ...store,
    updatedAt: new Date().toISOString(),
  });
  promptLibraryStoreMemory = nextStore;
  return enqueuePromptLibraryWrite(async () => {
    const saved = await saveProfileSetting(PROFILE_PROMPT_LIBRARY_NAMESPACE, nextStore, { timeoutMs: 30000 });
    if (!saved?.setting?.value) throw new Error('local-api 未返回智能工具配置。');
    const readback = await getProfileSetting(PROFILE_PROMPT_LIBRARY_NAMESPACE, { timeoutMs: 10000 });
    if (!readback?.setting?.value) throw new Error('智能工具配置回读失败。');
    const canonicalStore = normalizePromptLibraryStore(readback.setting.value);
    if (promptLibraryStoreMemory === nextStore) promptLibraryStoreMemory = canonicalStore;
    return canonicalStore;
  });
}

export function savePromptLibraryItems(items) {
  const currentStore = promptLibraryStoreMemory || normalizePromptLibraryStore();
  return savePromptLibraryStore({
    ...currentStore,
    items,
  });
}

export function createPromptFormFromItem(item) {
  const promptConfig = item.promptConfig || {};
  return {
    title: item.title,
    scene: item.scene,
    status: item.status,
    owner: item.owner,
    goal: item.goal,
    variables: item.variables.join('\n'),
    body: item.body,
    defaultModelId: promptConfig.defaultModelId || 'auto',
    plannerModelId: promptConfig.plannerModelId || 'auto',
    imageModelId: promptConfig.imageModelId || promptConfig.defaultModelId || 'auto',
    imagePositionRules: normalizeImagePositionRules(promptConfig.imagePositionRules),
    imagePositionRulesVersion: Number(
      promptConfig.imagePositionRulesVersion || SMART_TOOL_IMAGE_POSITION_RULES_VERSION
    ),
    installedSkillParserVersion: Number(promptConfig.installedSkillParserVersion || 0),
    dependencyBindings:
      item?.skillProfile?.dependencyBindings && typeof item.skillProfile.dependencyBindings === 'object'
        ? item.skillProfile.dependencyBindings
        : {},
    attributeRules: normalizeAttributeRules(promptConfig.attributeRules),
    attributeRulesVersion: Number(promptConfig.attributeRulesVersion || SMART_TOOL_ATTRIBUTE_RULES_VERSION),
    externalInsightConfig: isExternalOzonInsightToolId(item.id)
      ? normalizeExternalOzonInsightConfig(promptConfig.externalInsightConfig, { toolId: item.id })
      : null,
    profitReviewPresentation:
      item.id === PROFIT_ORDER_REVIEW_SKILL_ID
        ? normalizeProfitReviewPresentation(promptConfig.profitReviewPresentation)
        : null,
    modelPurpose: promptConfig.modelPurpose || '',
    systemPrompt: promptConfig.systemPrompt || '',
    userPrompt: promptConfig.userPrompt || '',
    outputFormat: promptConfig.outputFormat || '',
    outputRules: (promptConfig.outputRules || []).join('\n'),
    workflowSteps: (promptConfig.workflowSteps || []).join('\n'),
    safetyRules: (promptConfig.safetyRules || []).join('\n'),
    capabilities: (promptConfig.capabilities || []).join('\n'),
    inputs: (promptConfig.inputs || []).join('\n'),
    outputs: (promptConfig.outputs || []).join('\n'),
  };
}

import { externalOzonSkillIds } from './externalOzonSkillCatalog.js';

export const EXTERNAL_OZON_INSIGHT_CONFIG_VERSION = 4;
export const EXTERNAL_OZON_INSIGHT_SAMPLE_RECORDS_DEFAULT = 40;
export const EXTERNAL_OZON_INSIGHT_SAMPLE_CHARS_DEFAULT = 42_000;

export const EXTERNAL_OZON_REPORT_LOGO_OPTIONS = Object.freeze([
  Object.freeze({ value: 'insights', label: '经营分析' }),
  Object.freeze({ value: 'chart', label: '数据图表' }),
  Object.freeze({ value: 'target', label: '目标判断' }),
  Object.freeze({ value: 'store', label: '店铺经营' }),
  Object.freeze({ value: 'none', label: '不显示标志' }),
]);

export const EXTERNAL_OZON_REPORT_ACCENT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'violet', label: '沉稳紫' }),
  Object.freeze({ value: 'blue', label: '商务蓝' }),
  Object.freeze({ value: 'green', label: '经营绿' }),
  Object.freeze({ value: 'amber', label: '暖金色' }),
  Object.freeze({ value: 'charcoal', label: '黑灰色' }),
]);

export const EXTERNAL_OZON_REPORT_DENSITY_OPTIONS = Object.freeze([
  Object.freeze({ value: 'comfortable', label: '舒展易读' }),
  Object.freeze({ value: 'compact', label: '紧凑一些' }),
]);

export const EXTERNAL_OZON_REPORT_SECTION_ICON_OPTIONS = Object.freeze([
  Object.freeze({ value: 'assessment', label: '判断' }),
  Object.freeze({ value: 'finding', label: '发现' }),
  Object.freeze({ value: 'opportunity', label: '机会' }),
  Object.freeze({ value: 'risk', label: '风险' }),
  Object.freeze({ value: 'action', label: '行动' }),
  Object.freeze({ value: 'none', label: '不显示' }),
]);

const DEFAULT_REPORT_PRESENTATION = Object.freeze({
  preset: 'editorial',
  eyebrow: '经营分析',
  logo: 'insights',
  accent: 'violet',
  density: 'comfortable',
  showSectionIcons: true,
  showModel: true,
  showGeneratedAt: true,
  showPriority: true,
  showEvidenceLabels: true,
  showActionLabels: true,
  sections: Object.freeze([
    Object.freeze({ id: 'marketAssessment', title: '市场判断', icon: 'assessment', visible: true }),
    Object.freeze({ id: 'keyFindings', title: '关键发现', icon: 'finding', visible: true }),
    Object.freeze({ id: 'opportunities', title: '市场机会', icon: 'opportunity', visible: true }),
    Object.freeze({ id: 'risks', title: '需要规避', icon: 'risk', visible: true }),
    Object.freeze({ id: 'actionPlan', title: '执行计划', icon: 'action', visible: true }),
  ]),
});

const PRODUCT_DETAIL_TOOL_ID = 'linkfox-seerfar-ozon-product-detail-search';
export const externalOzonInsightToolIds = Object.freeze([...externalOzonSkillIds]);

function list(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/u);
  return source.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function text(value) {
  return String(value ?? '').trim();
}

function booleanValue(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function optionValue(options, value, fallback) {
  const normalized = text(value);
  return options.some((item) => item.value === normalized) ? normalized : fallback;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeExternalOzonReportPresentation(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceSections = Array.isArray(source.sections) ? source.sections : [];
  const byId = new Map(sourceSections.map((item) => [text(item?.id), item]));
  const sections = DEFAULT_REPORT_PRESENTATION.sections.map((fallback) => {
    const item = byId.get(fallback.id) || {};
    return {
      id: fallback.id,
      title: text(item.title) || fallback.title,
      icon: optionValue(EXTERNAL_OZON_REPORT_SECTION_ICON_OPTIONS, item.icon, fallback.icon),
      visible: booleanValue(item.visible, fallback.visible),
    };
  });
  return {
    preset: 'editorial',
    eyebrow: text(source.eyebrow) || DEFAULT_REPORT_PRESENTATION.eyebrow,
    logo: optionValue(EXTERNAL_OZON_REPORT_LOGO_OPTIONS, source.logo, DEFAULT_REPORT_PRESENTATION.logo),
    accent: optionValue(EXTERNAL_OZON_REPORT_ACCENT_OPTIONS, source.accent, DEFAULT_REPORT_PRESENTATION.accent),
    density: optionValue(EXTERNAL_OZON_REPORT_DENSITY_OPTIONS, source.density, DEFAULT_REPORT_PRESENTATION.density),
    showSectionIcons: booleanValue(source.showSectionIcons, DEFAULT_REPORT_PRESENTATION.showSectionIcons),
    showModel: booleanValue(source.showModel, DEFAULT_REPORT_PRESENTATION.showModel),
    showGeneratedAt: booleanValue(source.showGeneratedAt, DEFAULT_REPORT_PRESENTATION.showGeneratedAt),
    showPriority: booleanValue(source.showPriority, DEFAULT_REPORT_PRESENTATION.showPriority),
    showEvidenceLabels: booleanValue(source.showEvidenceLabels, DEFAULT_REPORT_PRESENTATION.showEvidenceLabels),
    showActionLabels: booleanValue(source.showActionLabels, DEFAULT_REPORT_PRESENTATION.showActionLabels),
    sections,
  };
}

function blankModes(toolId) {
  return toolId === PRODUCT_DETAIL_TOOL_ID
    ? {
        competitor: { analysisGoals: [], workflowSteps: [], analysisRules: [] },
        own: { analysisGoals: [], workflowSteps: [], analysisRules: [] },
      }
    : undefined;
}

function baseConfigForTool(toolId = '') {
  const result = {
    version: EXTERNAL_OZON_INSIGHT_CONFIG_VERSION,
    analysisGoals: [],
    workflowSteps: [],
    analysisRules: [],
    reportStyleRules: [],
    reportPresentation: normalizeExternalOzonReportPresentation(),
    systemPrompt: '',
    userPrompt: '',
    outputSections: [],
    outputRules: [],
    sampleMaxRecords: EXTERNAL_OZON_INSIGHT_SAMPLE_RECORDS_DEFAULT,
    sampleMaxChars: EXTERNAL_OZON_INSIGHT_SAMPLE_CHARS_DEFAULT,
  };
  const modes = blankModes(toolId);
  if (modes) result.analysisModes = modes;
  return result;
}

export function isExternalOzonInsightToolId(toolId = '') {
  return externalOzonInsightToolIds.includes(String(toolId || ''));
}

export function getDefaultExternalOzonInsightConfig(toolId = '') {
  return baseConfigForTool(String(toolId || ''));
}

export function normalizeExternalOzonInsightConfig(value = {}, options = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const toolId = String(options.toolId || '');
  const normalized = {
    version: EXTERNAL_OZON_INSIGHT_CONFIG_VERSION,
    analysisGoals: list(source.analysisGoals),
    workflowSteps: list(source.workflowSteps),
    analysisRules: list(source.analysisRules),
    reportStyleRules: list(source.reportStyleRules),
    reportPresentation: normalizeExternalOzonReportPresentation(source.reportPresentation),
    systemPrompt: text(source.systemPrompt),
    userPrompt: text(source.userPrompt),
    outputSections: list(source.outputSections),
    outputRules: list(source.outputRules),
    sampleMaxRecords: clampInteger(source.sampleMaxRecords, EXTERNAL_OZON_INSIGHT_SAMPLE_RECORDS_DEFAULT, 5, 100),
    sampleMaxChars: clampInteger(source.sampleMaxChars, EXTERNAL_OZON_INSIGHT_SAMPLE_CHARS_DEFAULT, 5_000, 120_000),
  };
  if (toolId === PRODUCT_DETAIL_TOOL_ID) {
    normalized.analysisModes = Object.fromEntries(['competitor', 'own'].map((key) => {
      const mode = source.analysisModes?.[key] || {};
      return [key, {
        analysisGoals: list(mode.analysisGoals),
        workflowSteps: list(mode.workflowSteps),
        analysisRules: list(mode.analysisRules),
      }];
    }));
  }
  return normalized;
}

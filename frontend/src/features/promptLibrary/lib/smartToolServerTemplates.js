import { externalOzonPromptTemplates } from './externalOzonSkillCatalog.js';

const DEFAULT_OUTPUT_RULES = Object.freeze([
  '结果只用于预览或分析，不宣称已经改动业务数据。',
  '事实字段必须来自本次结构化输入。',
  '输入不足时返回缺失项。',
]);

const templateMetadataByToolId = Object.freeze({
  'ozon-product-search': {
    templateId: 'product-selection.v1',
    capability: 'text.external-insight',
    modelPurpose: 'Ozon 商品市场与选品决策分析',
    outputFormat: '市场概览 / 机会与风险 / 数据缺口 / 可排序商品明细。',
  },
  'ozon-product-selection': {
    templateId: 'product-selection.v1',
    capability: 'text.external-insight',
    modelPurpose: 'Ozon 选品决策、市场证据与货源核对',
    outputFormat: '综合结论 / 市场判断 / 关键证据 / 风险 / 小批量测试顺序。',
  },
  'ozon-ad-analyzer': {
    templateId: 'performance-ad-insight.v1',
    capability: 'text.external-insight',
    modelPurpose: 'Ozon Performance API 广告计划诊断',
    outputFormat: '分析范围 / 整体表现 / 计划诊断 / 调整建议 / 数据完整性。',
  },
  'ozon-product-image-generation': {
    templateId: 'image-plan.v1',
    capability: 'text.image-plan',
    modelPurpose: 'Ozon 商品图方案规划',
    outputFormat: '商品身份 / 逐图方案 / 负向约束 / 验收项。',
  },
  'profit-risk-review': {
    templateId: 'profit-order-review.v1',
    capability: 'text.product-description',
    modelPurpose: '订单利润与商品投入评估',
    outputFormat: '综合结论 / 利润诊断 / 市场表现 / 投入判断 / 数据缺口。',
  },
  'ozon-skill-1688-product-detail-query': {
    templateId: 'external-ozon-insight.v1',
    capability: 'text.external-insight',
    modelPurpose: '1688 商品资料读取与采购信息整理',
    outputFormat: '商品信息 / 采购与物流资料 / 待补信息。',
  },
  'ozon-skill-1688-channel-shopdata-get': {
    templateId: 'operational-report.v1',
    capability: 'text.external-insight',
    modelPurpose: 'Ozon 店铺经营报表读取与分析',
    outputFormat: '经营结论 / 依据 / 机会 / 风险 / 处理顺序 / 数据缺口。',
  },
  'ozon-skill-1688-channel-shopdata-analyzer': {
    templateId: 'operational-report.v1',
    capability: 'text.external-insight',
    modelPurpose: 'Ozon 店铺经营数据分析',
    outputFormat: '总体结论 / 销售商品 / 库存风险 / 费用利润 / 行动顺序。',
  },
  ...Object.fromEntries(Object.entries(externalOzonPromptTemplates).map(([toolId, metadata]) => [
    toolId,
    {
      ...metadata,
      templateId: 'external-ozon-insight.v1',
      capability: 'text.external-insight',
    },
  ])),
});

function text(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

export function getSmartToolPromptTemplate(tool = {}) {
  const metadata = templateMetadataByToolId[tool.id] || {};
  return {
    toolId: text(tool.id, 'custom-tool'),
    templateId: text(metadata.templateId),
    capability: text(metadata.capability),
    modelPurpose: text(metadata.modelPurpose, '通用文本建议'),
    systemPrompt: '',
    userPrompt: '',
    outputFormat: text(metadata.outputFormat, '结论 / 依据 / 待人工确认的信息。'),
    outputRules: [...DEFAULT_OUTPUT_RULES],
  };
}

export function resolveSmartToolSystemPrompt(_tool = {}, savedSystemPrompt = '') {
  return text(savedSystemPrompt);
}

export function listSmartToolPromptTemplateIds() {
  return Object.keys(templateMetadataByToolId);
}


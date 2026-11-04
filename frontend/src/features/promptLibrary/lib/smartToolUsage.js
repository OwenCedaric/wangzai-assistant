import { parseSmartToolMarketKeywordItems } from './smartToolMarketKeywordQuery.js';
import {
  EXTERNAL_PRODUCT_ANALYSIS_MODE_INPUT_LABEL,
  EXTERNAL_PRODUCT_ANALYSIS_MODE_OPTIONS,
  EXTERNAL_PRODUCT_ANALYSIS_MODES,
} from './smartToolExternalProductAnalysisMode.js';
import {
  EXTERNAL_PRODUCT_MANUAL_INPUT_GROUP,
  EXTERNAL_PRODUCT_MANUAL_INPUT_SPECS,
  validateExternalProductManualInput,
} from './smartToolExternalProductManualData.js';
import {
  getInstalledSkillUsageInputSpecs,
  isUserInstalledSmartTool,
  localizeInstalledSkillInputLabel,
} from './smartToolInstalledSkill.js';

function normalizeUsageInputText(value) {
  return String(value ?? '').trim();
}

const BUILT_IN_USAGE_INPUT_SPECS = Object.freeze({
  'ozon-product-selection': Object.freeze([
    Object.freeze({
      label: '商品关键词、SKU 或 Ozon 链接',
      placeholder: '例如：遥控汽车、175924376 或完整 Ozon 商品链接',
      helperText: '系统先读取 Ozon 真实商品与市场数据，再按固定规则评分。',
      validator: 'required-text',
    }),
    Object.freeze({
      label: 'Seerfar 市场复核',
      control: 'select',
      defaultValue: 'skip',
      helperText: '选择“使用”才会调用一次 Seerfar 付费查询；默认不消耗 Seerfar 积分。',
      options: Object.freeze([
        Object.freeze({ value: 'skip', label: '不使用' }),
        Object.freeze({ value: 'use', label: '使用' }),
      ]),
    }),
    Object.freeze({
      label: '1688 货源链接（可选）',
      placeholder: '粘贴准备采购的 1688 商品链接',
      helperText: '系统会自动用 Ozon 代表商品主图找 1688 货源；填写链接可再精确核对指定货源的价格和规格。',
      validator: '1688-product-link',
      optional: true,
    }),
  ]),
  'ozon-skill-1688-product-detail-query': Object.freeze([
    Object.freeze({
      label: '1688 商品链接或商品 ID',
      placeholder: '粘贴 1688 商品链接，或填写商品 ID',
      helperText: '商品 ID 会自动转换为 1688 商品页，并使用独立的商品读取浏览器。',
      validator: '1688-product-reference',
    }),
  ]),
  'ozon-skill-1688-channel-shopdata-get': Object.freeze([
    Object.freeze({
      label: '报告内容',
      control: 'select',
      defaultValue: 'all',
      helperText: '读取当前店铺已经同步的真实经营数据。',
      options: Object.freeze([
        Object.freeze({ value: 'all', label: '全部经营数据' }),
        Object.freeze({ value: 'sales', label: '销售与商品排行' }),
        Object.freeze({ value: 'products', label: '商品与库存' }),
        Object.freeze({ value: 'finance', label: '费用与结算' }),
        Object.freeze({ value: 'afterSales', label: '售后数据' }),
        Object.freeze({ value: 'marketing', label: '营销活动' }),
      ]),
    }),
    Object.freeze({
      label: '统计范围',
      control: 'select',
      defaultValue: '30',
      helperText: '按莫斯科经营日期读取所选范围。',
      options: Object.freeze([
        Object.freeze({ value: '7', label: '最近 7 天' }),
        Object.freeze({ value: '30', label: '最近 30 天' }),
        Object.freeze({ value: '90', label: '最近 90 天' }),
      ]),
    }),
  ]),
  'ozon-ad-analyzer': Object.freeze([
    Object.freeze({
      label: '推广账号（可选）',
      placeholder: '留空自动使用最近配置的 Performance API 账号',
      helperText: '多账号时可填写账号名称或账号 ID；留空自动选择最近配置且凭证完整的账号。',
      optional: true,
    }),
    Object.freeze({
      label: '广告计划名称或 ID（可选）',
      placeholder: '留空分析全部计划，例如：夏季连衣裙 或 123456',
      helperText: '支持计划 ID 精确匹配或计划名称模糊匹配；留空分析当前账号全部计划。',
      optional: true,
    }),
    Object.freeze({
      label: '统计范围',
      helperText: '每次都从 Ozon Performance API 实时读取完整统计，不使用浏览器快照或业务缓存。',
      control: 'select',
      defaultValue: '7',
      options: Object.freeze([
        Object.freeze({ value: '7', label: '最近 7 天' }),
        Object.freeze({ value: '14', label: '最近 14 天' }),
        Object.freeze({ value: '30', label: '最近 30 天' }),
      ]),
    }),
  ]),
  'linkfox-seerfar-ozon-shop-search': Object.freeze([
    Object.freeze({
      label: '店铺 ID 或链接',
      placeholder: '例如：1275208 或 https://www.ozon.ru/seller/...',
      helperText: '填写一个 Ozon 卖家 ID；粘贴店铺链接也可以。',
      validator: 'shop-reference',
    }),
  ]),
  'linkfox-seerfar-ozon-product-detail-search': Object.freeze([
    Object.freeze({
      label: EXTERNAL_PRODUCT_ANALYSIS_MODE_INPUT_LABEL,
      helperText: '竞对模式判断值不值得跟进；自己商品模式诊断流量、转化、库存和退货问题。',
      control: 'select',
      defaultValue: EXTERNAL_PRODUCT_ANALYSIS_MODES.competitor,
      options: EXTERNAL_PRODUCT_ANALYSIS_MODE_OPTIONS,
    }),
    Object.freeze({
      label: '商品 SKU 或链接',
      placeholder: '例如：175924376 或 Ozon 商品链接',
      helperText: '填写一个 SKU；粘贴 Ozon 商品链接时会识别其中的 SKU。',
      validator: 'product-reference',
    }),
    ...EXTERNAL_PRODUCT_MANUAL_INPUT_SPECS.map((item) =>
      Object.freeze({
        ...item,
        control: 'number',
        optional: true,
        group: EXTERNAL_PRODUCT_MANUAL_INPUT_GROUP,
      })
    ),
  ]),
  'linkfox-seerfar-ozon-category-search': Object.freeze([
    Object.freeze({
      label: 'Seerfar 类目 ID',
      placeholder: '输入中文、俄文或类目 ID',
      helperText: '可以搜索类目名称后选择，也可以直接填写完整 ID。',
      validator: 'category-id',
      control: 'seerfar-category-picker',
    }),
  ]),
  'linkfox-seerfar-ozon-product-report-search': Object.freeze([
    Object.freeze({
      label: '商品关键词、SKU 或链接（可多个）',
      placeholder: '例如：遥控车、175924376 或商品链接',
      helperText: '中文商品词会自动匹配对应类目；SKU 或商品链接一次最多 10 个。',
      validator: 'product-filter-list',
      multiple: true,
      control: 'repeatable',
      maxItems: 20,
      splitWhitespace: false,
      minRows: 2,
      maxRows: 3,
    }),
  ]),
  'linkfox-seerfar-ozon-keyword-mining': Object.freeze([
    Object.freeze({
      label: '种子关键词',
      placeholder: '例如：遥控车 或 наушники беспроводные',
      helperText: '中文或俄语都可以，系统会匹配后扩展相关搜索词。',
      validator: 'required-text',
    }),
  ]),
  'linkfox-seerfar-ozon-market-keyword-search': Object.freeze([
    Object.freeze({
      label: '关键词或筛选条件（可多个）',
      placeholder: '例如：连衣裙、蓝海词、搜索量>=10000',
      helperText: '一行一个；支持关键词、蓝海词、日期、类目、平台、排序及各项数值范围。留空查看全市场。',
      validator: 'market-keyword-filters',
      optional: true,
      multiple: true,
      control: 'repeatable',
      maxItems: 1000,
      splitWhitespace: false,
      minRows: 2,
      maxRows: 3,
    }),
  ]),
  'linkfox-seerfar-ozon-keyword-back-search': Object.freeze([
    Object.freeze({
      label: '商品 SKU 或链接（最多20个）',
      placeholder: '例如：4380710124 或 Ozon 商品链接',
      helperText: '一条填一个 SKU 或商品链接，最多反查 20 个商品。',
      validator: 'product-reference-list',
      multiple: true,
      control: 'repeatable',
      maxItems: 20,
      splitWhitespace: true,
      minRows: 2,
      maxRows: 4,
    }),
  ]),
});

function getToolId(toolOrId = '') {
  return normalizeUsageInputText(typeof toolOrId === 'string' ? toolOrId : toolOrId?.id);
}

export function splitSmartToolUsageInputItems(value, { splitWhitespace = false } = {}) {
  const pattern = splitWhitespace ? /[\s,，;；]+/u : /[\n\r,，;；]+/u;
  return normalizeUsageInputText(value).split(pattern).map(normalizeUsageInputText).filter(Boolean);
}

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function isOzonHostname(hostname = '') {
  const normalized = normalizeUsageInputText(hostname).toLocaleLowerCase();
  return normalized === 'ozon.ru' || normalized.endsWith('.ozon.ru');
}

export function extractSmartToolOzonNumericReference(value, { allowNegative = false } = {}) {
  const normalized = normalizeUsageInputText(value);
  const numericPattern = allowNegative ? /^-?\d+$/u : /^\d+$/u;
  if (numericPattern.test(normalized)) return normalized;
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol) || !isOzonHostname(url.hostname)) return '';
    const pathMatches = [...url.pathname.matchAll(/(?:^|[-/])(\d{5,})(?=\/|$)/gu)];
    const pathId = pathMatches.at(-1)?.[1] || '';
    if (pathId) return pathId;
    return [...url.searchParams.values()].find((item) => /^\d{5,}$/u.test(item)) || '';
  } catch {
    return '';
  }
}

function isNumericIdOrUrl(value, options = {}) {
  return Boolean(extractSmartToolOzonNumericReference(value, options));
}

export function getSmartToolUsageInputSpecs(toolOrId = '') {
  const builtInSpecs = BUILT_IN_USAGE_INPUT_SPECS[getToolId(toolOrId)] || [];
  if (builtInSpecs.length || typeof toolOrId === 'string') return builtInSpecs;
  return getInstalledSkillUsageInputSpecs(toolOrId);
}

export function getSmartToolUsageInputSpec(toolOrId = '', label = '') {
  const normalizedLabel = normalizeUsageInputText(label);
  return getSmartToolUsageInputSpecs(toolOrId).find((item) => item.label === normalizedLabel) || null;
}

export function getSmartToolUsageInputs(tool = {}) {
  const source = tool && typeof tool === 'object' ? tool : {};
  const builtInSpecs = getSmartToolUsageInputSpecs(source);
  if (builtInSpecs.length) return builtInSpecs.map((item) => item.label);
  const profileUsageInputs = Array.isArray(source.skillProfile?.usageInputs) ? source.skillProfile.usageInputs : [];
  const directUsageInputs = Array.isArray(source.usageInputs) ? source.usageInputs : [];
  const configUsageInputs = Array.isArray(source.promptConfig?.usageInputs) ? source.promptConfig.usageInputs : [];
  const fallbackInputs = Array.isArray(source.variables) ? source.variables.slice(0, 1) : [];
  const rows = profileUsageInputs.length
    ? profileUsageInputs
    : directUsageInputs.length
      ? directUsageInputs
      : configUsageInputs.length
        ? configUsageInputs
        : fallbackInputs;

  return rows
    .map((item) =>
      isUserInstalledSmartTool(source) ? localizeInstalledSkillInputLabel(item) : normalizeUsageInputText(item)
    )
    .filter(Boolean);
}

export function getSmartToolUsageInputPlaceholder(label = '', toolOrId = '') {
  const builtInPlaceholder = getSmartToolUsageInputSpec(toolOrId, label)?.placeholder;
  if (builtInPlaceholder) return builtInPlaceholder;
  const text = normalizeUsageInputText(label);
  if (text.includes('链接')) return '粘贴 Ozon、1688、淘宝、天猫或拼多多商品链接';
  if (text.includes('订单号')) return '例如：0123456789-0001';
  if (text.includes('SKU')) return '填写 SKU、商品链接或商品名称';
  if (text.includes('关键词')) return '填写关键词、SKU 或商品链接';
  if (text.includes('活动')) return '填写广告活动名称或活动 ID';
  if (text.includes('图片')) return '填写图片链接、商品 SKU 或图片用途';
  if (text.includes('操作')) return '例如：给某个商品改价 / 修改库存 / 下架商品';
  if (text.includes('商品')) return '填写商品名称、SKU 或当前商品线索';
  return '填写本次要处理的信息';
}

export function getSmartToolUsageInputHelperText(toolOrId = '', label = '', value = '') {
  const spec = getSmartToolUsageInputSpec(toolOrId, label);
  if (!spec) return '';
  if (!spec.multiple) return spec.helperText || '';
  const count = splitSmartToolUsageInputItems(value, spec).length;
  const countText = spec.maxItems ? `已输入 ${count}/${spec.maxItems}` : `已输入 ${count} 项`;
  return `${spec.helperText || ''}${spec.helperText ? ' · ' : ''}${countText}`;
}

export function validateSmartToolUsageInput(toolOrId = '', label = '', value = '') {
  const spec = getSmartToolUsageInputSpec(toolOrId, label);
  if (!spec) return '';
  const normalized = normalizeUsageInputText(value);
  if (!normalized) return spec.optional ? '' : '请先填写这个项目。';

  if (spec.control === 'select' && !spec.options?.some((item) => item.value === normalized)) {
    return label === '统计范围' ? '请选择有效的统计范围。' : '请选择有效的分析对象。';
  }
  if (spec.control === 'number') {
    if (['non-negative-number', 'positive-number', 'percentage'].includes(spec.validator)) {
      const number = Number(normalized.replace(',', '.'));
      if (!Number.isFinite(number)) return '请填写有效数字。';
      if (spec.validator === 'positive-number' && number <= 0) return '请填写大于 0 的数字。';
      if (spec.validator === 'non-negative-number' && number < 0) return '不能填写负数。';
      if (spec.validator === 'percentage' && (number < 0 || number >= 100)) return '百分比需在 0 到 100 之间。';
      return '';
    }
    return validateExternalProductManualInput(label, normalized);
  }

  const items = spec.multiple ? splitSmartToolUsageInputItems(normalized, spec) : [normalized];
  if (spec.maxItems && items.length > spec.maxItems) {
    return `最多填写 ${spec.maxItems} 项，当前是 ${items.length} 项。`;
  }
  if (spec.validator === 'shop-reference' && !isNumericIdOrUrl(normalized, { allowNegative: true })) {
    return '请填写数字店铺 ID，或粘贴完整 Ozon 店铺链接。';
  }
  if (spec.validator === 'product-reference' && !isNumericIdOrUrl(normalized)) {
    return '请填写数字 SKU，或粘贴完整 Ozon 商品链接。';
  }
  if (spec.validator === '1688-product-reference') {
    if (/^\d{5,}$/u.test(normalized)) return '';
    try {
      const url = new URL(normalized);
      const host = url.hostname.toLowerCase();
      if (host === '1688.com' || host.endsWith('.1688.com') || host === 'alibaba.com' || host.endsWith('.alibaba.com'))
        return '';
    } catch {
      // Fall through to the human-readable validation message.
    }
    return '请填写 1688 商品 ID，或粘贴完整 1688 商品链接。';
  }
  if (spec.validator === '1688-product-link') {
    try {
      const url = new URL(normalized);
      const host = url.hostname.toLowerCase();
      if (host === '1688.com' || host.endsWith('.1688.com') || host === 'alibaba.com' || host.endsWith('.alibaba.com'))
        return '';
    } catch {
      // Fall through to the human-readable validation message.
    }
    return '请粘贴完整 1688 商品链接。';
  }
  if (spec.validator === 'category-id' && !/^\d+(?:_\d+)*$/u.test(normalized)) {
    return '类目 ID 只能包含数字和下划线。';
  }
  if (spec.validator === 'product-filter-list') {
    if (items.some((item) => isWebUrl(item) && !isNumericIdOrUrl(item))) {
      return '商品链接中没有识别到 SKU，请换成完整 Ozon 商品链接。';
    }
    const referenceCount = items.filter(isNumericIdOrUrl).length;
    if (referenceCount > 10) return `SKU 或商品链接最多填写 10 个，当前是 ${referenceCount} 个。`;
  }
  if (spec.validator === 'product-reference-list' && items.some((item) => !isNumericIdOrUrl(item))) {
    return '批量反查只能填写数字 SKU 或完整商品链接。';
  }
  if (spec.validator === 'market-keyword-filters') {
    try {
      parseSmartToolMarketKeywordItems(items);
    } catch (error) {
      return error instanceof Error ? error.message : '市场热词筛选条件不正确。';
    }
  }
  return '';
}

export function validateSmartToolUsageInputItem(toolOrId = '', label = '', value = '') {
  const spec = getSmartToolUsageInputSpec(toolOrId, label);
  const normalized = normalizeUsageInputText(value);
  if (!spec || !normalized) return '';
  if (spec.validator === 'product-reference-list' && !isNumericIdOrUrl(normalized)) {
    return '请填写数字 SKU 或完整商品链接。';
  }
  if (spec.validator === 'market-keyword-filters') {
    try {
      parseSmartToolMarketKeywordItems([normalized]);
    } catch (error) {
      return error instanceof Error ? error.message : '市场热词筛选条件不正确。';
    }
  }
  return '';
}

export function createSmartToolUsageInputText(usageInputs = [], values = {}) {
  return (Array.isArray(usageInputs) ? usageInputs : [])
    .map((label) => normalizeUsageInputText(label))
    .filter(Boolean)
    .map((label) => `${label}：${normalizeUsageInputText(values[label])}`)
    .join('\n');
}

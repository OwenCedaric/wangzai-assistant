import {
  buildSmartToolTargetProductComparison,
  getSmartToolProductLinkErrorMessage,
  parseSmartToolProductLink,
} from './smartToolProductLinkService.js';
import { runSmartToolDraftWithOzonBrowserData } from './smartToolOzonBrowserDataService.js';
import { runSmartToolDraftWithExternalOzonData } from './smartToolExternalOzonDataService.js';
import { runProductSelectionInsight } from './smartToolProductSelectionInsightService.js';
import {
  buildProductSelection1688KeywordSearchUrl,
  searchProductSelectionSources,
} from './smartToolProductSelectionSourceService.js';
import { planProductSelectionSources } from './smartToolProductSelectionSourcePlanService.js';
import { PRODUCT_SELECTION_SKILL_ID } from '../constants/productSelectionFreezeContract.js';

export const PRODUCT_SELECTION_INPUT_LABELS = Object.freeze({
  query: '商品关键词、SKU 或 Ozon 链接',
  seerfar: 'Seerfar 市场复核',
  sourceLink: '1688 货源链接（可选）',
});

const SEERFAR_PRODUCT_REPORT_TOOL = Object.freeze({
  id: 'linkfox-seerfar-ozon-product-report-search',
  title: 'Seerfar Ozon 商品报告',
});

function text(value) {
  return String(value ?? '').trim();
}

function selectionDataGaps(productAnalysis = {}, sourceProduct = null, seerfar = {}, sourceSearch = null) {
  const gaps = [];
  const missingDimensions = productAnalysis?.decision?.opportunity?.missingDimensions || [];
  if (missingDimensions.length) {
    gaps.push(`Ozon 暂缺${missingDimensions.map((item) => item.label).filter(Boolean).join('、')}数据`);
  }
  if (!seerfar.requested) gaps.push('未使用 Seerfar 复核更长周期市场数据');
  else if (seerfar.status !== 'ready') gaps.push('Seerfar 市场复核未取得可用结果');
  const sourceCandidates = Array.isArray(sourceSearch?.candidates) ? sourceSearch.candidates : [];
  if (!sourceProduct && !sourceCandidates.length) gaps.push('1688 自动搜款未取得可直接核价的候选商品');
  if (sourceProduct) {
    if (sourceProduct.sourceCostCny == null) gaps.push('1688 候选货源缺少采购价');
    if (!sourceProduct.weightKg) gaps.push('1688 候选货源缺少计费重量');
    if (!sourceProduct.dimensions) gaps.push('1688 候选货源缺少计费尺寸');
  }
  gaps.push('没有完整汇率、平台费用、物流和退货成本，暂不计算净利润');
  return [...new Set(gaps)];
}

function compactSeerfarResult(draft = null, requested = false, failure = '') {
  if (!requested) {
    return {
      requested: false,
      status: 'skipped',
      statusLabel: '未使用，不消耗积分',
      summary: '本次只使用 Ozon 内置浏览器真实数据。',
      recordCount: 0,
      records: [],
    };
  }
  if (!draft?.result || failure) {
    return {
      requested: true,
      status: 'unavailable',
      statusLabel: '复核未完成',
      summary: 'Seerfar 本次没有完成复核，请检查接口配置、余额或查询条件。',
      recordCount: 0,
      records: [],
    };
  }
  const analysis = draft.result.externalAnalysis || draft.result.keywordAnalysis || {};
  const records = Array.isArray(analysis.records)
    ? analysis.records
    : Array.isArray(draft.result.records)
      ? draft.result.records
      : [];
  const ready = draft.result.status === 'ready' && records.length > 0;
  return {
    requested: true,
    status: ready ? 'ready' : 'empty',
    statusLabel: ready ? '已完成一次市场复核' : '没有查到复核数据',
    summary: ready
      ? `Seerfar 返回 ${records.length} 条商品样本，用于交叉核对，不替代 Ozon 本次真实数据。`
      : 'Seerfar 本次没有返回可用商品样本。',
    recordCount: records.length,
    total: Number(draft.result.total) || records.length,
    records,
  };
}

export function canUseSmartToolProductSelection(toolOrId = '') {
  const id = typeof toolOrId === 'string' ? toolOrId : toolOrId?.id;
  return text(id) === PRODUCT_SELECTION_SKILL_ID;
}

export async function runSmartToolProductSelection(tool = {}, values = {}, options = {}) {
  if (!canUseSmartToolProductSelection(tool)) throw new Error('当前不是 Ozon 选品助手。');
  const query = text(values[PRODUCT_SELECTION_INPUT_LABELS.query]);
  if (!query) throw new Error('请先填写商品关键词、SKU 或 Ozon 链接。');
  const sourceLink = text(values[PRODUCT_SELECTION_INPUT_LABELS.sourceLink]);
  const useSeerfar = text(values[PRODUCT_SELECTION_INPUT_LABELS.seerfar]) === 'use';
  const stage = options.onStage || (() => {});

  stage({ statusLabel: '正在读取 Ozon 市场数据', summary: '正在执行本次只读商品查询并计算固定七维评分…' });
  const ozonDraft = await (options.ozonRunner || runSmartToolDraftWithOzonBrowserData)(
    tool,
    { '关键词或 SKU': query },
    {
      shopScope: options.shopScope,
      productSearchOptions: options.productSearchOptions,
      productSearchRunner: options.productSearchRunner,
      productSearchExecutor: options.productSearchExecutor,
      productLinkParser: options.productLinkParser,
    },
  );
  const result = ozonDraft?.result || {};
  const productAnalysis = result.productAnalysis;
  if (!productAnalysis?.recordCount) {
    return {
      ...ozonDraft,
      result: {
        ...result,
        viewType: 'product-selection',
        selectionAnalysis: {
          query,
          productAnalysis: productAnalysis || null,
          seerfar: compactSeerfarResult(null, false),
          sourceProduct: null,
          sourceSearch: null,
          dataGaps: ['Ozon 没有返回可用于选品判断的商品数据'],
        },
      },
    };
  }

  let sourceProduct = null;
  let sourceProductLinkStatus = null;
  if (sourceLink) {
    stage({ statusLabel: '正在核对 1688 候选货源', summary: '正在读取采购价、规格、重量和尺寸…' });
    try {
      const capture = await (options.sourceLinkParser || parseSmartToolProductLink)(sourceLink, {
        ...(options.sourceLinkOptions || {}),
      });
      sourceProduct = buildSmartToolTargetProductComparison(capture, productAnalysis);
      sourceProductLinkStatus = { status: 'ready', message: '1688 候选货源资料已读取。' };
    } catch (error) {
      sourceProductLinkStatus = { status: 'error', message: getSmartToolProductLinkErrorMessage(error) };
    }
  }

  stage({ statusLabel: '正在整理中文搜款词', summary: '正在从 Ozon 同类热销商品中选择代表款，并转换成 1688 中文采购词…' });
  const sourcePlan = await (options.sourcePlanRunner || planProductSelectionSources)(
    productAnalysis,
    query,
    options.modelSelection,
    { signal: options.signal },
  );

  stage({ statusLabel: '正在寻找 1688 候选货源', summary: '正在用代表商品识图，并剔除与中文采购词不一致的结果…' });
  let sourceSearch;
  try {
    sourceSearch = await (options.sourceSearchRunner || searchProductSelectionSources)(
      productAnalysis,
      query,
      { signal: options.signal, sourcePlan },
    );
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const keywordSearchUrl = buildProductSelection1688KeywordSearchUrl(query);
    sourceSearch = {
      status: 'unavailable',
      statusLabel: '本次没有读到 1688 候选商品',
      message: '1688 自动搜款本次没有完成，可直接按关键词继续搜索。',
      query,
      searchUrl: keywordSearchUrl,
      keywordSearchUrl,
      searches: (sourcePlan?.searches || []).map((item) => ({
        query: item.query,
        titleZh: item.titleZh,
        productId: item.productId,
        ozonTitle: item.ozonTitle,
        url: buildProductSelection1688KeywordSearchUrl(item.query),
      })),
      sourcePlan,
      candidates: [],
    };
  }

  let seerfarDraft = null;
  let seerfarFailure = '';
  if (useSeerfar) {
    stage({ statusLabel: '正在使用 Seerfar 复核', summary: '只执行一次受控市场查询，本步骤会消耗 Seerfar 积分…' });
    try {
      seerfarDraft = await (options.seerfarRunner || runSmartToolDraftWithExternalOzonData)(
        SEERFAR_PRODUCT_REPORT_TOOL,
        { '商品关键词、SKU 或链接（可多个）': query },
        {
          signal: options.signal,
          maxPages: 1,
          listProfiles: options.listProfiles,
          readIntegration: options.readIntegration,
          getCategoryTree: options.getCategoryTree,
        },
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      seerfarFailure = text(error?.message || error);
    }
  }
  const seerfar = compactSeerfarResult(seerfarDraft, useSeerfar, seerfarFailure);
  const selectionAnalysis = {
    version: 1,
    query,
    productAnalysis,
    seerfar,
    sourceProduct,
    sourceSearch,
    dataGaps: selectionDataGaps(productAnalysis, sourceProduct, seerfar, sourceSearch),
  };

  let productSelectionInsight = null;
  if (options.modelSelection?.ready) {
    stage({ statusLabel: '正在执行选品 Skill', summary: '固定评分已经完成，正在由所选模型解释证据并生成最终报告…' });
    try {
      productSelectionInsight = await (options.insightRunner || runProductSelectionInsight)(
        tool,
        selectionAnalysis,
        options.modelSelection,
        { signal: options.signal },
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      productSelectionInsight = {
        status: 'error',
        model: text(options.modelSelection?.model),
        message: '市场数据和固定评分已经完成，但本次模型报告生成失败，可以直接查看下方真实数据后重试。',
      };
    }
  }

  const opportunity = productAnalysis.decision?.opportunity || {};
  const summary = productSelectionInsight?.report?.executiveSummary
    || `${opportunity.label || '选品判断完成'}：${opportunity.recommendation || '请查看证据和风险。'}`;
  return {
    ...ozonDraft,
    result: {
      ...result,
      status: 'browser_data_ready',
      statusLabel: '选品分析完成',
      summary,
      viewType: 'product-selection',
      selectionAnalysis,
      productSelectionInsight,
      sourceProduct,
      sourceProductLinkStatus,
      sourceSearch,
      seerfarReview: seerfar,
      nextActions: opportunity.actions || result.nextActions || [],
    },
  };
}

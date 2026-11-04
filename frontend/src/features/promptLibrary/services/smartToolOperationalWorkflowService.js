import { normalizeDataAnalysisCachePayload } from '../../dataAnalysis/lib/dataAnalysisFormatter.js';
import {
  collectDataAnalysisRubDates,
  convertDataAnalysisDashboardToCny,
} from '../../dataAnalysis/lib/dataAnalysisCurrency.js';
import { formatDataAnalysisTime } from '../../dataAnalysis/lib/dataAnalysisFormatter.js';
import { readDataAnalysisCache } from '../../dataAnalysis/services/dataAnalysisCacheClient.js';
import { readRubCnyExchangeRateContext } from '../../../services/exchangeRateClient.js';
import { runSmartToolDraft } from './smartToolDraftService.js';
import {
  getSmartToolProductLinkErrorMessage,
  parseSmartToolProductLink,
} from './smartToolProductLinkService.js';
import { buildOperationalReportSections } from '../lib/smartToolOperationalReportFormatter.js';
import { runSmartToolOperationalReportInsight } from './smartToolOperationalReportInsightService.js';

export const SMART_TOOL_1688_DETAIL_ID = 'ozon-skill-1688-product-detail-query';
export const SMART_TOOL_REPORT_READ_ID = 'ozon-skill-1688-channel-shopdata-get';

const OPERATIONAL_TOOL_IDS = new Set([
  SMART_TOOL_1688_DETAIL_ID,
  SMART_TOOL_REPORT_READ_ID,
]);

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.').replace(/[^\d.-]/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function section(title, rows = []) {
  return { title, rows: rows.map(text).filter(Boolean) };
}

function createdAt() {
  return new Date().toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function baseDraft(tool, values, options) {
  return runSmartToolDraft(tool, values, options?.shopScope?.shopId ? { shopScope: options.shopScope } : {});
}

export function canUseSmartToolOperationalWorkflow(tool = {}) {
  return OPERATIONAL_TOOL_IDS.has(text(tool.id));
}

export function requiresSmartToolOperationalAnalysis(tool = {}) {
  return text(tool.id) === SMART_TOOL_REPORT_READ_ID;
}

export function normalize1688ProductReference(value) {
  const normalized = text(value);
  if (/^\d{5,}$/u.test(normalized)) return `https://detail.1688.com/offer/${normalized}.html`;
  return normalized;
}

function captureDimensions(capture = {}) {
  const values = [capture.lengthCm, capture.widthCm, capture.heightCm];
  if (values.every((value) => finite(value) !== null)) return `${values.join(' × ')} cm`;
  return text(capture.packageDimensions) || '暂无';
}

async function run1688Detail(tool, values, options) {
  const reference = normalize1688ProductReference(values['1688 商品链接或商品 ID']);
  const parser = options.productLinkParser || parseSmartToolProductLink;
  const capture = await parser(reference, options.productLinkOptions || {});
  const missing = [
    !capture.productTitle ? '商品标题' : '',
    capture.price === null || capture.price === undefined ? '采购价格' : '',
    !capture.imageUrl ? '商品图片' : '',
    !capture.variant ? '规格信息' : '',
    !capture.weightKg && !capture.packageWeight ? '重量' : '',
    captureDimensions(capture) === '暂无' ? '长宽高' : '',
  ].filter(Boolean);
  return {
    ...baseDraft(tool, values, options),
    createdAt: createdAt(),
    result: {
      status: missing.length ? 'partial_ready' : 'ready',
      statusLabel: missing.length ? '商品资料已读取，部分字段暂无' : '1688 商品资料读取完成',
      summary: `已从独立商品读取窗口取得 ${capture.productTitle || capture.sourceProductId || '当前商品'} 的真实页面资料。`,
      sections: [
        section('商品信息', [
          `商品：${capture.productTitle || '暂无'}`,
          `商品 ID：${capture.sourceProductId || '暂无'}`,
          `分类：${capture.category || '暂无'}`,
          `品牌：${capture.brand || '暂无'}`,
          `规格：${capture.variant || '暂无'}`,
        ]),
        section('采购与物流资料', [
          `采购价格：${capture.price == null ? '暂无' : `${capture.currency === 'RUB' ? '₽' : '￥'}${capture.price}`}`,
          `长宽高：${captureDimensions(capture)}`,
          `重量：${capture.weightKg ? `${capture.weightKg} kg` : capture.packageWeight || '暂无'}`,
          `图片：${capture.imageUrl || '暂无'}`,
          `商品链接：${capture.sourceUrl || reference}`,
        ]),
        ...(missing.length ? [section('还需人工补充', missing)] : []),
      ],
      nextActions: missing.length ? ['核对页面中未返回的规格、重量或尺寸'] : ['可把读取结果继续用于采购资料核对或采集核价'],
      productCapture: capture,
      source: 'isolated-product-browser',
    },
  };
}

function shiftDate(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function createOperationalReportRange(days = 30, now = new Date()) {
  const endDate = now.toISOString().slice(0, 10);
  const count = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  return { startDate: shiftDate(endDate, -(count - 1)), endDate, days: count };
}

async function runReportRead(tool, values, options) {
  const shopId = text(options.shopScope?.shopId);
  if (!shopId) throw new Error('请先在智能工具顶部选择要读取的 Ozon 店铺。');
  const range = createOperationalReportRange(values['统计范围']);
  const cacheReader = options.cacheReader || readDataAnalysisCache;
  const payload = normalizeDataAnalysisCachePayload(await cacheReader({
    shopId,
    analysisType: 'all',
    sourceType: 'all',
    startDate: range.startDate,
    endDate: range.endDate,
    limit: 50,
  }, { signal: options.signal, timeoutMs: 12000 }));
  if (!payload.dashboard) throw new Error('当前店铺和日期范围没有可读取的经营数据，请先同步店铺数据。');
  const rateReader = options.rateReader || readRubCnyExchangeRateContext;
  const dates = collectDataAnalysisRubDates(payload.dashboard);
  const rateContext = dates.length ? await rateReader(dates, { signal: options.signal, timeoutMs: 9000 }) : {};
  const dashboard = convertDataAnalysisDashboardToCny(payload.dashboard, rateContext);
  const reportType = text(values['报告内容']) || 'all';
  const sections = buildOperationalReportSections(dashboard, reportType);
  const reportTypeLabel = reportType === 'all' ? '全部经营数据' : text(values['报告内容']) || reportType;
  options.onStage?.({
    statusLabel: '报表已读取，正在生成经营分析',
    summary: `已整理 ${sections.reduce((sum, item) => sum + item.rows.length, 0)} 行真实报表，正在调用 ${options.modelSelection?.model || '文本模型'}分析经营问题…`,
  });
  const insightRunner = options.insightRunner || runSmartToolOperationalReportInsight;
  let operationalReportInsight;
  try {
    operationalReportInsight = await insightRunner(tool, {
      shopId,
      shopName: options.shopScope?.shopName || shopId,
      range,
      reportType,
      reportTypeLabel,
      sections,
    }, options.modelSelection, {
      signal: options.signal,
      timeoutMs: options.modelTimeoutMs,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    operationalReportInsight = {
      status: 'error',
      message: text(error?.payload?.error?.message || error?.message) || '经营分析没有完成，请重新运行。',
    };
  }
  const analysisReady = operationalReportInsight?.status === 'ready';
  return {
    ...baseDraft(tool, values, options),
    createdAt: createdAt(),
    result: {
      status: analysisReady ? 'ready' : 'partial_ready',
      statusLabel: analysisReady ? 'Ozon 报表读取与分析完成' : '报表已读取，经营分析待重试',
      summary: analysisReady
        ? operationalReportInsight.report?.executiveSummary || `已读取并分析 ${sections.reduce((sum, item) => sum + item.rows.length, 0)} 行真实经营数据。`
        : `已读取 ${options.shopScope?.shopName || shopId} 的 ${sections.reduce((sum, item) => sum + item.rows.length, 0)} 行真实报表；${operationalReportInsight.message}`,
      viewType: 'operational-report',
      operationalReportInsight,
      sections: [
        section('读取范围', [
          `店铺：${options.shopScope?.shopName || shopId}`,
          `日期：${range.startDate} 至 ${range.endDate}`,
          `内容：${reportTypeLabel}`,
          `数据更新时间：${formatDataAnalysisTime(payload.updatedAt)}`,
          '金额展示：人民币',
        ]),
        ...sections,
      ],
      nextActions: analysisReady
        ? ['先处理分析报告中的高优先级问题，再回到明细核对商品、订单和费用流水']
        : ['保留当前报表，检查文本模型配置后重新运行即可继续分析'],
      reportData: { shopId, range, reportType, dashboard, source: payload.source, updatedAt: payload.updatedAt },
    },
  };
}

export async function runSmartToolOperationalWorkflow(tool = {}, values = {}, options = {}) {
  try {
    if (tool.id === SMART_TOOL_1688_DETAIL_ID) return await run1688Detail(tool, values, options);
    if (tool.id === SMART_TOOL_REPORT_READ_ID) return await runReportRead(tool, values, options);
    throw new Error('当前工具没有配置业务运行器。');
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const isProductLinkError = text(error?.code || error?.message).includes('PRODUCT_LINK')
      || text(error?.code || error?.message).includes('PURCHASE_BROWSER');
    return {
      ...baseDraft(tool, values, options),
      createdAt: createdAt(),
      result: {
        status: 'operational_data_error',
        statusLabel: '读取失败',
        summary: isProductLinkError
          ? getSmartToolProductLinkErrorMessage(error)
          : text(error?.payload?.error?.message || error?.message) || '本次运行没有取得可用数据。',
        sections: [],
        nextActions: ['检查左侧输入和对应账号配置后重试'],
      },
    };
  }
}

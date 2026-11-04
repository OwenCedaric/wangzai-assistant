import { assertTextModel, readCompletionText } from '../productDescriptions/productDescriptionService.js';
import { isVerifiedModelApiAccount } from '../paidCapabilities/paidCapabilityPolicy.js';

export const DATA_ANALYSIS_INSIGHT_MODEL_TIMEOUT_MS = 270_000;
export const DATA_ANALYSIS_INSIGHT_MAX_ATTEMPTS = 2;

function text(value) {
  return String(value ?? '').trim();
}

function compactObject(entries = []) {
  return Object.fromEntries(entries.filter(([, value]) => (
    value !== undefined
    && value !== null
    && value !== ''
    && (!Array.isArray(value) || value.length > 0)
  )));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isModelTimeoutError(error) {
  const name = text(error?.name);
  const message = text(error?.message);
  return name === 'TimeoutError' || /aborted due to timeout|timed?\s*out|超时/iu.test(message);
}

function compactMetric(metric = {}) {
  return compactObject([
    ['id', text(metric.id)],
    ['label', text(metric.label)],
    ['value', metric.value ?? null],
    ['unit', text(metric.unit)],
    ['currency', text(metric.currency)],
    ['status', text(metric.status)],
    ['delta', metric.delta || null],
  ]);
}

function compactMoney(value = {}) {
  if (!value || typeof value !== 'object') return value ?? null;
  return compactObject([
    ['value', value.value ?? null],
    ['currency', text(value.currency)],
  ]);
}

function compactProductRow(row = {}) {
  return compactObject([
    ['rank', numberOrNull(row.rank)],
    ['offerId', text(row.offerId || row.offer_id)],
    ['sku', text(row.sku)],
    ['name', text(row.name) || '商品名称未返回'],
    ['quantity', numberOrNull(row.quantity)],
    ['orderCount', numberOrNull(row.orderCount)],
    ['sales', compactMoney(row.sales)],
    ['stock', numberOrNull(row.stock)],
    ['visibility', text(row.visibility)],
  ]);
}

function compactTrendRow(row = {}) {
  return compactObject([
    ['date', text(row.date)],
    ['orders', numberOrNull(row.orderCount)],
    ['effectiveOrders', numberOrNull(row.effectiveOrderCount)],
    ['cancelledOrders', numberOrNull(row.cancelledOrderCount)],
    ['items', numberOrNull(row.itemCount)],
    ['sales', compactMoney(row.sales)],
  ]);
}

function compactFinanceOperation(row = {}) {
  return compactObject([
    ['name', text(row.label || row.name || row.operationType || row.code)],
    ['code', text(row.code)],
    ['count', numberOrNull(row.count)],
    ['amount', compactMoney(row.amount)],
  ]);
}

function compactDeduction(row = {}) {
  return compactObject([
    ['operationId', text(row.operationId)],
    ['postingNumber', text(row.postingNumber)],
    ['operationType', text(row.operationType)],
    ['operationDate', text(row.operationDate)],
    ['amount', numberOrNull(row.amount)],
    ['currency', text(row.currency)],
  ]);
}

function compactAfterSalesRow(row = {}) {
  return compactObject([
    ['returnId', text(row.returnId)],
    ['postingNumber', text(row.postingNumber)],
    ['status', text(row.statusLabel || row.status)],
    ['createdAt', text(row.createdAt)],
    ['productName', text(row.productName)],
    ['offerId', text(row.offerId)],
    ['sku', text(row.sku)],
    ['amount', numberOrNull(row.amount)],
    ['currency', text(row.currency)],
  ]);
}

function compactActivityRow(row = {}) {
  return compactObject([
    ['activityId', text(row.activityId)],
    ['title', text(row.title)],
    ['startDate', text(row.startDate)],
    ['endDate', text(row.endDate)],
    ['active', row.active === true ? true : row.active === false ? false : null],
    ['joinedCount', numberOrNull(row.joinedCount)],
    ['availableCount', numberOrNull(row.availableCount)],
    ['actionType', text(row.actionType)],
    ['discountType', text(row.discountType)],
    ['discountValue', numberOrNull(row.discountValue)],
  ]);
}

function compactMarketingProductRow(row = {}) {
  return compactObject([
    ['activityId', text(row.activityId)],
    ['offerId', text(row.offerId)],
    ['sku', text(row.sku)],
    ['name', text(row.name || row.catalogName)],
    ['status', text(row.rowStatus)],
    ['price', numberOrNull(row.price)],
    ['activityPrice', numberOrNull(row.activityPrice)],
    ['currency', text(row.currency)],
    ['stock', numberOrNull(row.currentStock ?? row.stock)],
    ['activityStock', numberOrNull(row.activityStock)],
    ['stockMismatch', row.stockMismatch === true ? true : row.stockMismatch === false ? false : null],
  ]);
}

function compactDiagnostic(row = {}) {
  return compactObject([
    ['severity', text(row.severity || row.level)],
    ['title', text(row.title)],
    ['message', text(row.message)],
    ['evidence', row.evidence || null],
    ['action', text(row.action)],
  ]);
}

function compactSource(row = {}) {
  return compactObject([
    ['label', text(row.label)],
    ['status', text(row.status)],
    ['rowCount', numberOrNull(row.rowCount)],
    ['syncedAt', text(row.syncedAt)],
    ['note', text(row.note)],
  ]);
}

function compactDashboard(dashboard = {}) {
  const section = (value = {}) => ({
    rowCount: Number(value.rowCount) || 0,
    metrics: (Array.isArray(value.metrics) ? value.metrics : []).map(compactMetric).slice(0, 24),
  });
  const sales = dashboard.sales || {};
  const products = dashboard.products || {};
  const finance = dashboard.finance || {};
  const afterSales = dashboard.afterSales || {};
  const marketing = dashboard.marketing || {};
  return {
    shopId: text(dashboard.shopId),
    range: dashboard.range || {},
    generatedAt: dashboard.generatedAt || null,
    sourceUpdatedAt: dashboard.sourceUpdatedAt || null,
    overview: section(dashboard.overview),
    sales: {
      ...section(sales),
      trend: Array.isArray(sales.trend) ? sales.trend.slice(-90).map(compactTrendRow) : [],
      statusBreakdown: Array.isArray(sales.statusBreakdown) ? sales.statusBreakdown.slice(0, 20) : [],
      fulfillmentBreakdown: Array.isArray(sales.fulfillmentBreakdown) ? sales.fulfillmentBreakdown.slice(0, 20) : [],
      productRanking: Array.isArray(sales.productRanking) ? sales.productRanking.slice(0, 30).map(compactProductRow) : [],
    },
    products: {
      ...section(products),
      quality: products.quality || {},
      inventoryQuality: products.inventoryQuality || {},
      visibilityBreakdown: Array.isArray(products.visibilityBreakdown) ? products.visibilityBreakdown.slice(0, 20) : [],
      categoryBreakdown: Array.isArray(products.categoryBreakdown) ? products.categoryBreakdown.slice(0, 20) : [],
      stockRiskRows: Array.isArray(products.stockRiskRows) ? products.stockRiskRows.slice(0, 50).map(compactProductRow) : [],
      replenishmentRanking: Array.isArray(products.replenishmentRanking) ? products.replenishmentRanking.slice(0, 30).map(compactProductRow) : [],
    },
    finance: {
      ...section(finance),
      currencyCoverage: finance.currencyCoverage || {},
      operationBreakdown: Array.isArray(finance.operationBreakdown)
        ? finance.operationBreakdown.slice(0, 30).map(compactFinanceOperation)
        : [],
      largestDeductions: Array.isArray(finance.largestDeductions)
        ? finance.largestDeductions.slice(0, 30).map(compactDeduction)
        : [],
    },
    afterSales: {
      ...section(afterSales),
      statusBreakdown: Array.isArray(afterSales.statusBreakdown) ? afterSales.statusBreakdown.slice(0, 20) : [],
      reasonCodeBreakdown: Array.isArray(afterSales.reasonCodeBreakdown) ? afterSales.reasonCodeBreakdown.slice(0, 20) : [],
      dataQuality: afterSales.dataQuality || {},
      recentRows: Array.isArray(afterSales.recentRows)
        ? afterSales.recentRows.slice(0, 30).map(compactAfterSalesRow)
        : [],
    },
    marketing: {
      ...section(marketing),
      activityRows: Array.isArray(marketing.activityRows)
        ? marketing.activityRows.slice(0, 30).map(compactActivityRow)
        : [],
      productRows: Array.isArray(marketing.productRows)
        ? marketing.productRows.slice(0, 30).map(compactMarketingProductRow)
        : [],
    },
    diagnostics: Array.isArray(dashboard.diagnostics)
      ? dashboard.diagnostics.slice(0, 30).map(compactDiagnostic)
      : [],
    sources: Array.isArray(dashboard.sources) ? dashboard.sources.slice(0, 30).map(compactSource) : [],
  };
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是 Ozon 店铺经营报表分析助手。',
  '只能根据提供的本地真实数据分析，不得补造销量、利润、库存、广告或退货数据。',
  '金额、数量和百分比必须沿用数据中的单位与币种；缺失、部分返回或币种不确定时必须明确说明。',
  '请用简洁中文输出：一、总体结论；二、销售与商品；三、库存风险；四、费用与利润；五、售后与营销；六、优先行动清单；七、数据缺口。',
  '不要输出 API、数据库、内部字段名、买家隐私或无法验证的原因。',
].join('\n');

const DATA_ANALYSIS_ADAPTER_RULES = [
  '本软件适配规则：数据已经由软件按店铺和日期范围从 Ozon 本地同步缓存读取，本次不需要用户上传 Excel 或 CSV。',
  '不要要求用户再次上传文件；如果某项数据缺失，直接标记为数据缺口并继续分析其余真实数据。',
].join('\n');

function createUserPrompt(query, dashboard, userPrompt = '') {
  return [
    userPrompt ? `本次 Skill 补充要求：\n${userPrompt}` : '',
    `店铺：${text(query.shopId) || '全部店铺'}`,
    `日期范围：${text(query.startDate) || '未指定'} 至 ${text(query.endDate) || '未指定'}`,
    '以下是按店铺和日期范围整理后的真实数据：',
    JSON.stringify(compactDashboard(dashboard)),
  ].filter(Boolean).join('\n\n');
}

function getProviderErrorCode(payload = {}) {
  return text(payload?.error?.code || payload?.code).slice(0, 80);
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function getRetryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1_000, 5_000);
  return Math.min(750 * attempt, 1_500);
}

function createReadableProviderError(status, payload = {}) {
  const providerMessage = text(payload?.error?.message || payload?.message);
  const providerCode = getProviderErrorCode(payload);
  const combined = `${providerCode} ${providerMessage}`.toLowerCase();
  if (status === 401 || status === 403 || /invalid[_ -]?api[_ -]?key|authentication|unauthor/iu.test(combined)) {
    return new Error('所选文本模型接口验证失败，请在模型接口设置中重新检查密钥。');
  }
  if (status === 404 || /model.+not.+found|unknown.+model/iu.test(combined)) {
    return new Error('所选文本模型当前不可用，请重新检测模型列表后再分析。');
  }
  if (status === 429 || /quota|rate.+limit|too.+many/iu.test(combined)) {
    return new Error('当前文本模型繁忙或可用额度不足，请稍后重新分析。');
  }
  if (/context|token.+limit|too.+long|maximum.+length/iu.test(combined)) {
    return new Error('本次经营数据超过模型单次处理范围，请缩短日期范围后重新分析。');
  }
  if (status >= 500) return new Error('文本模型服务暂时繁忙，本次数据已经保留，请重新分析。');
  return new Error('文本模型没有完成本次经营分析，请重新分析。');
}

async function requestInsightCompletion({ fetchImpl, url, apiKey, model, systemPrompt, userPrompt, timeoutMs }) {
  let lastError = null;
  for (let attempt = 1; attempt <= DATA_ANALYSIS_INSIGHT_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isModelTimeoutError(error)) throw error;
      lastError = new Error('文本模型连接暂时不稳定，本次数据已经保留，请重新分析。');
      console.error('[local-api][data-analysis-insight] request error', JSON.stringify({
        model,
        attempt,
        retrying: attempt < DATA_ANALYSIS_INSIGHT_MAX_ATTEMPTS,
        errorName: text(error?.name).slice(0, 80),
      }));
      if (attempt < DATA_ANALYSIS_INSIGHT_MAX_ATTEMPTS) {
        await wait(getRetryDelayMs(null, attempt));
        continue;
      }
      throw lastError;
    }

    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    lastError = createReadableProviderError(response.status, payload);
    const retrying = attempt < DATA_ANALYSIS_INSIGHT_MAX_ATTEMPTS && isRetryableStatus(response.status);
    console.error('[local-api][data-analysis-insight] provider rejected request', JSON.stringify({
      model,
      status: Number(response.status) || 0,
      providerCode: getProviderErrorCode(payload),
      attempt,
      retrying,
    }));
    if (!retrying) throw lastError;
    await wait(getRetryDelayMs(response, attempt));
  }
  throw lastError || new Error('文本模型没有完成本次经营分析，请重新分析。');
}

export function createDataAnalysisInsightService({
  dataAnalysisService,
  modelApiAccountRepository,
  paidCapabilityAccess,
  fetchImpl = globalThis.fetch,
  modelRequestTimeoutMs = DATA_ANALYSIS_INSIGHT_MODEL_TIMEOUT_MS,
} = {}) {
  return {
    async generate(input = {}, paidContext = {}) {
      const accountId = text(input.accountId || input.account_id);
      const model = text(input.model);
      const systemPrompt = [
        text(input.systemPrompt || input.system_prompt) || DEFAULT_SYSTEM_PROMPT,
        DATA_ANALYSIS_ADAPTER_RULES,
      ].join('\n\n');
      if (systemPrompt.length > 20_000) throw new Error('报表分析提示词过长。');

      const account = modelApiAccountRepository?.getAccountForInternalUse(accountId);
      const byokUsable = Boolean(model && isVerifiedModelApiAccount(account));

      const query = {
        shopId: text(input.shopId || input.shop_id),
        analysisType: 'all',
        sourceType: 'all',
        startDate: text(input.startDate || input.dateFrom || input.start_date),
        endDate: text(input.endDate || input.dateTo || input.end_date),
        limit: 50,
      };
      const cachePayload = dataAnalysisService?.readCache?.(query);
      const dashboard = cachePayload?.dashboard;
      if (!cachePayload?.ok || !dashboard) throw new Error('当前店铺和日期范围没有可分析的数据，请先同步店铺数据。');
      const userPrompt = createUserPrompt(
        query,
        dashboard,
        text(input.userPrompt || input.user_prompt),
      );
      if (!byokUsable) {
        const paid = await paidCapabilityAccess.execute({
          capability: 'text.data-analysis',
          input: { systemPrompt, userPrompt },
          context: paidContext,
        });
        const insight = text(paid.result?.text);
        if (!insight) throw new Error('内置文本模型没有返回店铺报表分析结果。');
        return {
          ok: true,
          insight,
          model: 'builtin-points',
          accountId: '',
          query,
          dashboardMeta: {
            generatedAt: dashboard.generatedAt || null,
            sourceUpdatedAt: dashboard.sourceUpdatedAt || null,
            diagnostics: dashboard.diagnostics || [],
            sources: dashboard.sources || [],
          },
          usage: null,
          billing: { chargedPoints: paid.chargedPoints, source: 'paid-cloud' },
        };
      }
      assertTextModel(account, model);
      const baseUrl = text(account.baseUrl).replace(/\/+$/u, '');

      let payload;
      try {
        payload = await requestInsightCompletion({
          fetchImpl,
          url: `${baseUrl}/chat/completions`,
          apiKey: account.apiKey,
          model,
          systemPrompt,
          userPrompt,
          timeoutMs: Math.max(
            1_000,
            Number(modelRequestTimeoutMs) || DATA_ANALYSIS_INSIGHT_MODEL_TIMEOUT_MS,
          ),
        });
      } catch (error) {
        if (isModelTimeoutError(error)) {
          throw new Error('分析模型响应时间较长，本次店铺数据仍然保留，请点击“重新分析”。');
        }
        throw error;
      }
      const insight = readCompletionText(payload);
      if (!insight) throw new Error('文本模型没有返回店铺报表分析结果。');
      return {
        ok: true,
        insight,
        model,
        accountId,
        query,
        dashboardMeta: {
          generatedAt: dashboard.generatedAt || null,
          sourceUpdatedAt: dashboard.sourceUpdatedAt || null,
          diagnostics: dashboard.diagnostics || [],
          sources: dashboard.sources || [],
        },
        usage: payload.usage || null,
      };
    },
  };
}

export { compactDashboard, createUserPrompt, DEFAULT_SYSTEM_PROMPT };

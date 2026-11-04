import { executeCollectionPricingQuote } from '../../../services/protectedComputeClient.js';
import { ceilCollectionCurrencyCents } from '../lib/collectionPriceBounds.js';
import { buildCollectionPricingQuoteInput, mapVerifiedCollectionPricingQuote } from '../lib/pricingCalculator.js';
import { buildCollectionSkuPricingInputKey } from '../lib/collectionSkuPricingIntegrity.js';

const COLLECTION_QUOTE_RETRY_DELAYS_MS = Object.freeze([220, 650]);
const RETRYABLE_COLLECTION_QUOTE_CODES = new Set([
  'LOCAL_API_TIMEOUT',
  'PROTECTED_COMPUTE_NETWORK_UNAVAILABLE',
  'PROTECTED_COMPUTE_OFFLINE',
  'PROTECTED_COMPUTE_RATE_LIMITED',
  'PROTECTED_COMPUTE_REMOTE_ERROR',
  'PROTECTED_COMPUTE_TIMEOUT',
  'PROTECTED_COMPUTE_TRANSPORT_UNAVAILABLE',
]);

function collectionQuoteErrorCode(error) {
  return String(error?.code || error?.payload?.error?.code || '').trim();
}

function isRetryableCollectionQuoteError(error) {
  if (error?.name === 'AbortError') return false;
  const status = Number(error?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return RETRYABLE_COLLECTION_QUOTE_CODES.has(collectionQuoteErrorCode(error));
}

function waitForCollectionQuoteRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('请求已取消', 'AbortError'));
  if (!Number.isFinite(delayMs) || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('请求已取消', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function executeCollectionPricingQuoteWithRetry(input, options = {}) {
  const requestedAttempts = Number(options.maxAttempts);
  const maxAttempts = Number.isInteger(requestedAttempts)
    ? Math.min(Math.max(requestedAttempts, 1), 3)
    : 3;
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs
    : COLLECTION_QUOTE_RETRY_DELAYS_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await executeCollectionPricingQuote(input, {
        signal: options.signal,
        timeoutMs: options.timeoutMs || 15_000,
      });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableCollectionQuoteError(error)) throw error;
      await waitForCollectionQuoteRetry(retryDelaysMs[attempt - 1] ?? 0, options.signal);
    }
  }
  throw new Error('服务器核价失败。');
}

export async function requestCollectionPricingQuote(pricingDraft, options = {}) {
  const input = buildCollectionPricingQuoteInput(pricingDraft);
  const verified = await executeCollectionPricingQuoteWithRetry(input, options);
  return Object.freeze({
    preview: mapVerifiedCollectionPricingQuote(verified, input),
    source: verified.source,
    verification: Object.freeze({ ...(verified.verification || {}) }),
  });
}

function moneyText(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return String(Number(number.toFixed(2)));
}

function sourcePriceKey(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(2) : '';
}

function nonNegativeMoneyText(value, field) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error(`请先填写${field}。`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field}不是有效人民币金额。`);
  return String(Number(number.toFixed(2)));
}

function resolveSkuPricingInput(sku = {}, pricingDraft = {}) {
  const purchaseCost = sourcePriceKey(sku.sourcePriceCny);
  const name = sku.sourceSkuName || sku.offerId || '未命名 SKU';
  if (!purchaseCost) throw new Error(`${name}缺少人民币采购价。`);
  const skuFreight = sku.firstMileCostCny ?? sku.freightCostCny;
  const firstMileCost = nonNegativeMoneyText(
    skuFreight === null || skuFreight === undefined || String(skuFreight).trim() === ''
      ? pricingDraft.firstMileCost
      : skuFreight,
    `${name}的物流费`,
  );
  const extraCost = nonNegativeMoneyText(
    String(pricingDraft.extraCost ?? '').trim() === '' ? 0 : pricingDraft.extraCost,
    '其它成本',
  );
  if (pricingDraft.ozonFeePercent === null
    || pricingDraft.ozonFeePercent === undefined
    || String(pricingDraft.ozonFeePercent).trim() === '') {
    throw new Error('请先读取或填写类目扣点。');
  }
  const commissionPercent = Number(pricingDraft.ozonFeePercent);
  if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 95) {
    throw new Error('类目扣点必须是 0% 到 95% 之间的有效比例。');
  }
  const resolvedDraft = {
    ...pricingDraft,
    purchaseCost,
    firstMileCost,
    extraCost,
    ozonFeePercent: String(Number(commissionPercent.toFixed(3))),
  };
  return {
    key: [purchaseCost, firstMileCost, extraCost, Number(commissionPercent).toFixed(3)].join('|'),
    purchaseCost,
    firstMileCost,
    extraCost,
    commissionPercent,
    resolvedDraft,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function buildGeneratedPricePolicy(salePriceCny, breakEvenPriceCny) {
  if (!Number.isFinite(salePriceCny) || salePriceCny <= 0 || !Number.isFinite(breakEvenPriceCny) || breakEvenPriceCny <= 0) {
    throw new Error('签名核价没有返回有效的人民币售价或保本价。');
  }
  const oldPriceCny = Number((salePriceCny * 1.3).toFixed(2));
  const minPriceCny = ceilCollectionCurrencyCents(Math.max(
    Number.isFinite(breakEvenPriceCny) ? breakEvenPriceCny : 0,
    salePriceCny * 0.5,
  ));
  return { salePriceCny, oldPriceCny, minPriceCny };
}

async function quoteAtPrice(purchaseCost, currentPrice, pricingDraft, options) {
  return requestCollectionPricingQuote({
    ...pricingDraft,
    purchaseCost,
    // 固定金额利润由签名结果反推，不能把利润金额错误当成百分比传入。
    targetMarginPercent: '0',
    currentPrice: moneyText(currentPrice),
  }, options);
}

function targetMarginPercentForFixedProfit(targetProfitMinor, signedTotalCostCny, safetyMinor = 1) {
  const totalCostMinor = Math.round(Number(signedTotalCostCny) * 100);
  if (!Number.isSafeInteger(totalCostMinor) || totalCostMinor <= 0) {
    throw new Error('签名核价没有返回有效的人民币总成本。');
  }
  const requestedProfitMinor = targetProfitMinor + Math.max(1, Math.round(safetyMinor));
  const targetMarginBasisPoints = Math.ceil((requestedProfitMinor * 10_000) / totalCostMinor);
  return String(targetMarginBasisPoints / 100);
}

function signedMarkupPercentForNetMargin(targetMarginPercent, commissionPercent, safetyBasisPoints = 1) {
  const targetBasisPoints = Math.round(Number(targetMarginPercent) * 100)
    + Math.max(1, Math.round(safetyBasisPoints));
  const commissionBasisPoints = Math.round(Number(commissionPercent) * 100);
  const availableBasisPoints = 10_000 - commissionBasisPoints - targetBasisPoints;
  if (!Number.isSafeInteger(targetBasisPoints) || targetBasisPoints <= 0 || availableBasisPoints <= 0) {
    throw new Error('目标净利润率必须大于 0%，并且与类目扣点合计小于 100%。');
  }
  return String(Math.ceil((targetBasisPoints * 10_000) / availableBasisPoints) / 100);
}

async function quoteAtTargetProfit(
  purchaseCost,
  targetProfitMinor,
  signedTotalCostCny,
  pricingDraft,
  options,
  safetyMinor,
) {
  return requestCollectionPricingQuote({
    ...pricingDraft,
    purchaseCost,
    targetMarginPercent: targetMarginPercentForFixedProfit(
      targetProfitMinor,
      signedTotalCostCny,
      safetyMinor,
    ),
    currentPrice: '',
  }, options);
}

async function solveFixedProfitPrice(purchaseCost, targetProfitCny, pricingDraft, options) {
  const initial = await quoteAtPrice(purchaseCost, '', pricingDraft, options);
  const breakEvenPriceCny = Number(initial.preview.breakEvenPrice || initial.preview.suggestedPrice);
  const signedTotalCostCny = Number(initial.preview.totalCost);
  if (!Number.isFinite(breakEvenPriceCny) || breakEvenPriceCny <= 0) {
    throw new Error('签名核价没有返回有效的人民币保本价。');
  }
  if (!Number.isFinite(signedTotalCostCny) || signedTotalCostCny <= 0) {
    throw new Error('签名核价没有返回有效的人民币总成本。');
  }

  const targetProfitMinor = Math.round(Number(targetProfitCny) * 100);
  let safetyMinor = 1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 直接使用签名核价契约的目标利润率返回候选售价，再用同一
    // 签名服务复核实际利润。这使每组成本通常只需 3 次请求，不再逐分试价。
    const targetQuote = await quoteAtTargetProfit(
      purchaseCost,
      targetProfitMinor,
      signedTotalCostCny,
      pricingDraft,
      options,
      safetyMinor,
    );
    const salePriceCny = Number(targetQuote.preview.suggestedPrice);
    if (!Number.isFinite(salePriceCny) || salePriceCny <= 0) {
      throw new Error('签名核价没有返回有效的人民币售价。');
    }
    const evaluated = await quoteAtPrice(purchaseCost, salePriceCny, pricingDraft, options);
    const actualProfitMinor = Math.round(Number(evaluated.preview.currentProfit) * 100);
    if (!Number.isSafeInteger(actualProfitMinor)) {
      throw new Error('签名核价没有返回实际利润。');
    }
    if (actualProfitMinor >= targetProfitMinor) {
      return {
        policy: buildGeneratedPricePolicy(salePriceCny, breakEvenPriceCny),
        preview: evaluated.preview,
        source: evaluated.source || targetQuote.source || initial.source,
      };
    }
    safetyMinor += targetProfitMinor - actualProfitMinor + 1;
  }
  throw new Error('签名核价没有找到达到预期净利润的最终售价。');
}

async function solveTargetNetMarginPrice(
  purchaseCost,
  targetMarginPercent,
  commissionPercent,
  pricingDraft,
  options,
) {
  const initial = await quoteAtPrice(purchaseCost, '', pricingDraft, options);
  const breakEvenPriceCny = Number(initial.preview.breakEvenPrice || initial.preview.suggestedPrice);
  if (!Number.isFinite(breakEvenPriceCny) || breakEvenPriceCny <= 0) {
    throw new Error('签名核价没有返回有效的人民币保本价。');
  }

  let safetyBasisPoints = 1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const targetQuote = await requestCollectionPricingQuote({
      ...pricingDraft,
      purchaseCost,
      targetMarginPercent: signedMarkupPercentForNetMargin(
        targetMarginPercent,
        commissionPercent,
        safetyBasisPoints,
      ),
      currentPrice: '',
    }, options);
    const salePriceCny = Number(targetQuote.preview.suggestedPrice);
    if (!Number.isFinite(salePriceCny) || salePriceCny <= 0) {
      throw new Error('签名核价没有返回有效的人民币售价。');
    }
    const evaluated = await quoteAtPrice(purchaseCost, salePriceCny, pricingDraft, options);
    const actualMarginPercent = Number(evaluated.preview.currentMargin);
    if (!Number.isFinite(actualMarginPercent)) {
      throw new Error('签名核价没有返回实际净利润率。');
    }
    if (actualMarginPercent >= targetMarginPercent) {
      return {
        policy: buildGeneratedPricePolicy(salePriceCny, breakEvenPriceCny),
        preview: evaluated.preview,
        source: evaluated.source || targetQuote.source || initial.source,
      };
    }
    safetyBasisPoints += Math.max(1, Math.ceil((targetMarginPercent - actualMarginPercent) * 100) + 1);
  }
  throw new Error('签名核价没有找到达到目标净利润率的最终售价。');
}

function resolveProfitTarget(pricingDraft = {}, commissionPercent) {
  const expectedProfitText = String(pricingDraft.expectedProfitCny ?? '').trim();
  if (expectedProfitText) {
    const amount = Number(expectedProfitText);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('每单预期利润必须是大于 0 的人民币金额。');
    }
    return { mode: 'amount', value: amount };
  }
  const targetMarginText = String(pricingDraft.targetMarginPercent ?? '').trim();
  if (targetMarginText) {
    const margin = Number(targetMarginText);
    if (!Number.isFinite(margin) || margin <= 0 || margin + commissionPercent >= 100) {
      throw new Error('目标净利润率必须大于 0%，并且与类目扣点合计小于 100%。');
    }
    return { mode: 'margin', value: margin };
  }
  throw new Error('请先输入每单预期利润或目标净利润率。');
}

export async function requestCollectionSkuPricingQuotes(skus = [], pricingDraft = {}, options = {}) {
  const enabled = (Array.isArray(skus) ? skus : []).filter((item) => item?.enabled !== false);
  if (!enabled.length) throw new Error('至少启用 1 个 SKU 后才能生成销售价。');
  const missing = enabled.filter((item) => !sourcePriceKey(item.sourcePriceCny));
  if (missing.length) {
    const names = missing.slice(0, 3).map((item) => item.sourceSkuName || item.offerId || '未命名 SKU').join('、');
    throw new Error(`${names}${missing.length > 3 ? ` 等 ${missing.length} 个 SKU` : ''}缺少人民币采购价。`);
  }
  const resolvedRows = enabled.map((sku) => ({ sku, input: resolveSkuPricingInput(sku, pricingDraft) }));
  const uniqueInputs = [...new Map(resolvedRows.map((item) => [item.input.key, item.input])).values()];
  const quotes = await mapWithConcurrency(uniqueInputs, options.concurrency || 4, async (input) => {
    const target = resolveProfitTarget(pricingDraft, input.commissionPercent);
    const solved = target.mode === 'margin'
      ? await solveTargetNetMarginPrice(
        input.purchaseCost,
        target.value,
        input.commissionPercent,
        input.resolvedDraft,
        options,
      )
      : await solveFixedProfitPrice(input.purchaseCost, target.value, input.resolvedDraft, options);
    return { key: input.key, input, ...solved };
  });
  const quoteByInput = new Map(quotes.map((item) => [item.key, item]));
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    uniquePriceCount: uniqueInputs.length,
    uniquePricingInputCount: uniqueInputs.length,
    rows: resolvedRows.map(({ sku, input }) => {
      const quote = quoteByInput.get(input.key);
      const fixedCostCny = Number(quote.preview.totalCost);
      const actualProfitCny = Number(quote.preview.currentProfit);
      const allInCostCny = Number((quote.policy.salePriceCny - actualProfitCny).toFixed(2));
      const commissionCostCny = Number((allInCostCny - fixedCostCny).toFixed(2));
      return {
        sourceSkuId: String(sku.sourceSkuId || ''),
        offerId: String(sku.offerId || ''),
        sourcePriceCny: Number(sku.sourcePriceCny),
        priceCny: quote.policy.salePriceCny,
        oldPriceCny: quote.policy.oldPriceCny,
        minPriceCny: quote.policy.minPriceCny,
        pricingSnapshot: {
          inputKey: buildCollectionSkuPricingInputKey(sku, input.resolvedDraft),
          purchaseCostCny: Number(input.purchaseCost),
          firstMileCostCny: Number(input.firstMileCost),
          extraCostCny: Number(input.extraCost),
          commissionPercent: input.commissionPercent,
          commissionCostCny,
          fixedCostCny,
          totalCostCny: allInCostCny,
          allInCostCny,
          expectedProfitCny: actualProfitCny,
          profitMarginPercent: quote.preview.currentMargin,
          breakEvenPriceCny: quote.preview.breakEvenPrice,
          logisticsProviderId: String(sku.logisticsProviderId || ''),
          logisticsRouteId: String(sku.logisticsRouteId || ''),
          logisticsPricingVersion: String(sku.logisticsPricingVersion || ''),
          generatedAt,
          quoteSource: quote.source,
        },
      };
    }),
  };
}

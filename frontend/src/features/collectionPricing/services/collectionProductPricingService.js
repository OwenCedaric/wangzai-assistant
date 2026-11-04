import { calculateLogisticsFreight } from '../../../services/logisticsPricingService.js';
import {
  getLogisticsPricingRoutes,
  LOGISTICS_PRICING_PROVIDERS,
} from '../../../shared/config/logisticsPricingPresets.js';

const COLLECTION_AUTO_SERVICE_PRIORITY = Object.freeze(['standard', 'economy', 'express', 'hk']);

function resolveCollectionServiceLevel(logisticsDraft = {}) {
  const requested = String(logisticsDraft.serviceLevel || 'auto').trim().toLowerCase();
  if (requested !== 'auto' || String(logisticsDraft.routeId || '').trim() || String(logisticsDraft.routeText || '').trim()) {
    return requested;
  }
  const routes = getLogisticsPricingRoutes(logisticsDraft.providerId, logisticsDraft.market || 'RU');
  return COLLECTION_AUTO_SERVICE_PRIORITY.find((level) => routes.some((route) => route.serviceLevel === level)) || requested;
}

function resolveBootstrapRubValue(logisticsDraft = {}, serviceLevel = 'auto') {
  if (!String(logisticsDraft.providerId || '').trim() || String(logisticsDraft.routeId || '').trim()) return null;
  const values = getLogisticsPricingRoutes(logisticsDraft.providerId, logisticsDraft.market || 'RU')
    .filter((route) => serviceLevel === 'auto' || route.serviceLevel === serviceLevel)
    .flatMap((route) => [route.minValueRub, route.maxValueRub])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : null;
}

function resolveDeterministicCollectionCandidate(result, input) {
  if (!result?.ambiguous || !Array.isArray(result.candidates) || !result.candidates.length) return result;
  const candidate = [...result.candidates].sort((left, right) => (
    Number(left.amount) - Number(right.amount)
    || String(left.routeId).localeCompare(String(right.routeId))
  ))[0];
  if (!candidate?.routeId) return result;
  const selected = calculateLogisticsFreight({ ...input, routeId: candidate.routeId });
  return selected.ok
    ? { ...selected, matchedBy: 'collection-deterministic-boundary', confidence: 1 }
    : result;
}

export function listCollectionLogisticsProviders() {
  return LOGISTICS_PRICING_PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    markets: [...provider.markets],
  }));
}

export function listCollectionLogisticsRoutes(providerId = '', market = 'RU', serviceLevel = 'auto') {
  const routes = getLogisticsPricingRoutes(providerId, market);
  return routes
    .filter((route) => !serviceLevel || serviceLevel === 'auto' || route.serviceLevel === serviceLevel)
    .map((route) => ({
    id: route.id,
    providerId: route.providerId,
    label: route.label,
    market: route.market,
    serviceLevel: route.serviceLevel,
  }));
}

export function calculateCollectionProductFreight({
  product = {},
  listingDraft = {},
  pricingDraft = {},
  logisticsDraft = {},
  sku = {},
} = {}) {
  const serviceLevel = resolveCollectionServiceLevel(logisticsDraft);
  // 物流商预设仍可能用卢布货值区间区分线路。采集上架固定使用人民币，
  // 因此这里只用预设区间下界完成首次线路匹配；严禁由人民币售价换算卢布。
  const presetBandFloorRub = resolveBootstrapRubValue(logisticsDraft, serviceLevel);
  const input = {
    weightKg: Number(sku.weightG || listingDraft.weightG || product.weightG) / 1000,
    lengthCm: sku.packageLengthCm || listingDraft.packageLengthCm || product.packageLengthCm,
    widthCm: sku.packageWidthCm || listingDraft.packageWidthCm || product.packageWidthCm,
    heightCm: sku.packageHeightCm || listingDraft.packageHeightCm || product.packageHeightCm,
    productValueCny: sku.sourcePriceCny || pricingDraft.purchaseCost || product.purchasePrice,
    productValueRub: presetBandFloorRub ?? '',
    providerId: logisticsDraft.providerId || 'auto',
    routeId: logisticsDraft.routeId || '',
    routeText: logisticsDraft.routeText || '',
    market: logisticsDraft.market || 'RU',
    serviceLevel,
  };
  const result = resolveDeterministicCollectionCandidate(calculateLogisticsFreight(input), input);
  return presetBandFloorRub === null || !result.ok
    ? result
    : {
        ...result,
        matchedBy: 'collection-pre-price-value-band',
        valueBandProvisional: true,
        productValueRubUsed: presetBandFloorRub,
      };
}

export function calculateCollectionSkuFreights({
  product = {},
  listingDraft = {},
  pricingDraft = {},
  logisticsDraft = {},
} = {}) {
  const sourceSkus = Array.isArray(product.skus) ? product.skus : [];
  return (Array.isArray(listingDraft.skus) ? listingDraft.skus : [])
    .filter((sku) => sku?.enabled !== false)
    .map((sku, index) => {
      const sourceSku = sourceSkus.find(
        (item) => String(item?.id ?? item?.name ?? '') === String(sku.sourceSkuId ?? ''),
      ) || sourceSkus[index] || {};
      const resolvedSku = {
        ...sourceSku,
        ...sku,
        sourcePriceCny: sku.sourcePriceCny || sourceSku.price,
        weightG: sku.weightG || sourceSku.weightG,
        packageLengthCm: sku.packageLengthCm || sourceSku.packageLengthCm,
        packageWidthCm: sku.packageWidthCm || sourceSku.packageWidthCm,
        packageHeightCm: sku.packageHeightCm || sourceSku.packageHeightCm,
      };
      return {
        sourceSkuId: String(sku.sourceSkuId || ''),
        offerId: String(sku.offerId || ''),
        sourcePriceCny: resolvedSku.sourcePriceCny,
        result: calculateCollectionProductFreight({
          product,
          listingDraft,
          pricingDraft,
          logisticsDraft,
          sku: resolvedSku,
        }),
      };
    });
}

export function getCollectionPricingQuoteErrorMessage(error) {
  const code = String(error?.code || error?.payload?.error?.code || '');
  const status = Number(error?.status);
  if (status === 401 || code === 'PROTECTED_COMPUTE_AUTH_UNAVAILABLE') {
    return '授权登录已失效，请重新登录后再使用服务器核价。';
  }
  if (status === 403 || code === 'PROTECTED_COMPUTE_CAPABILITY_FORBIDDEN') {
    return '当前软件套餐未开通采集核价功能，请更新套餐权限后重试。';
  }
  if (status === 429 || code === 'PROTECTED_COMPUTE_RATE_LIMITED') {
    return '服务器核价请求过于频繁，请稍后重试。';
  }
  if (code === 'PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED') {
    return '核价服务暂不可用，本功能不会回退到本地公式，避免产生未经验证的金额。';
  }
  if (code.startsWith('PROTECTED_COMPUTE_') || status >= 500) {
    return '服务器核价暂时失败，请稍后重试。';
  }
  return error instanceof Error ? error.message : '核价失败，请稍后重试。';
}

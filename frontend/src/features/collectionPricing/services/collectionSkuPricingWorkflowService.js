import { calculateCollectionSkuFreights } from './collectionProductPricingService.js';
import { requestCollectionSkuPricingQuotes } from './collectionPricingQuoteService.js';

function skuKey(value = {}) {
  return `${String(value.sourceSkuId || '')}::${String(value.offerId || '')}`;
}

function findListingSku(listingDraft = {}, freightRow = {}) {
  return (listingDraft.skus || []).find((item) => skuKey(item) === skuKey(freightRow));
}

function assertFreightRows(freightRows, listingDraft) {
  const failed = freightRows.find((item) => item.result?.ok !== true);
  if (!failed) return;
  const sku = findListingSku(listingDraft, failed);
  const skuName = sku?.sourceSkuName || sku?.offerId || '未命名 SKU';
  throw new Error(`${skuName}物流费测算失败：${failed.result?.reason || '没有匹配到计费线路'}。`);
}

function attachFreightToSkus(listingDraft = {}, logisticsDraft = {}, freightRows = []) {
  const freightByKey = new Map(freightRows.map((item) => [skuKey(item), item.result]));
  return (listingDraft.skus || []).map((item) => {
    if (item?.enabled === false) return item;
    const freight = freightByKey.get(skuKey(item));
    if (!freight?.ok) return item;
    return {
      ...item,
      firstMileCostCny: String(Number(freight.amount.toFixed(2))),
      logisticsProviderId: freight.providerId || logisticsDraft.providerId || '',
      logisticsRouteId: freight.routeId || logisticsDraft.routeId || '',
      logisticsPricingVersion: freight.pricingVersion || '',
    };
  });
}

export async function generateCollectionSkuPricesWithResolvedFreight({
  product = {},
  listingDraft = {},
  pricingDraft = {},
  logisticsDraft = {},
  signal,
  concurrency = 4,
} = {}) {
  const freightRows = calculateCollectionSkuFreights({
    product,
    listingDraft,
    pricingDraft,
    logisticsDraft,
  });
  assertFreightRows(freightRows, listingDraft);
  if (signal?.aborted) return null;
  const skusWithFreight = attachFreightToSkus(listingDraft, logisticsDraft, freightRows);
  const generated = await requestCollectionSkuPricingQuotes(skusWithFreight, pricingDraft, {
    signal,
    concurrency,
  });
  if (signal?.aborted) return null;
  return {
    generated,
    freightRows,
    skusWithFreight,
    pricingCurrency: 'CNY',
    currencyConversionApplied: false,
  };
}

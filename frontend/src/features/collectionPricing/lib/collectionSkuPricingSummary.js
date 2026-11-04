function finiteNumbers(values = []) {
  return values
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(Number)
    .filter(Number.isFinite);
}

function range(values = []) {
  const rows = finiteNumbers(values);
  if (!rows.length) return null;
  return { minimum: Math.min(...rows), maximum: Math.max(...rows) };
}

export function buildCollectionSkuPricingSummary({
  listingDraft = {},
  logisticsDraft = {},
  pricingDraft = {},
  pricingPreview = {},
  providers = [],
  routes = [],
} = {}) {
  const enabled = (listingDraft.skus || []).filter((item) => item?.enabled !== false);
  const snapshots = enabled
    .filter((item) => isCollectionSkuPricingSnapshotCurrent(item, pricingDraft))
    .map((item) => item.pricingSnapshot || {})
    .filter((item) => Number(item.totalCostCny) > 0);
  const provider = providers.find((item) => item.id === logisticsDraft.providerId);
  const route = routes.find((item) => item.id === logisticsDraft.routeId);
  const previewReady = pricingPreview?.hasCost === true;
  return {
    logisticsLabel: route?.label || provider?.label || (logisticsDraft.providerId ? '待选择线路' : '自动识别'),
    commissionPercent: Number.isFinite(Number(pricingDraft.ozonFeePercent)) && String(pricingDraft.ozonFeePercent) !== ''
      ? Number(pricingDraft.ozonFeePercent)
      : null,
    totalCostRange: snapshots.length
      ? range(snapshots.map((item) => item.allInCostCny ?? item.totalCostCny))
      : previewReady ? range([pricingPreview.allInCost ?? pricingPreview.totalCost]) : null,
    profitRange: snapshots.length
      ? range(snapshots.map((item) => item.expectedProfitCny))
      : previewReady ? range([pricingPreview.currentProfit]) : range([pricingDraft.expectedProfitCny]),
    marginRange: snapshots.length
      ? range(snapshots.map((item) => item.profitMarginPercent))
      : previewReady ? range([pricingPreview.currentMargin]) : null,
    breakEvenRange: snapshots.length
      ? range(snapshots.map((item) => item.breakEvenPriceCny))
      : previewReady ? range([pricingPreview.breakEvenPrice]) : null,
    generatedSkuCount: snapshots.length,
    enabledSkuCount: enabled.length,
  };
}
import { isCollectionSkuPricingSnapshotCurrent } from './collectionSkuPricingIntegrity.js';

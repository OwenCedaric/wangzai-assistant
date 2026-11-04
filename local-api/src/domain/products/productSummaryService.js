import { createProductRepository } from '../../db/repositories/productRepository.js';

function pickCompactSourceLink(item = {}) {
  return {
    slotIndex: item.slotIndex ?? 0,
    isPrimary: Boolean(item.isPrimary),
    platform: item.platform || '',
    link: item.link || item.url || '',
    url: item.url || item.link || '',
    productId: item.productId || item.sourceProductId || '',
    sourceProductId: item.sourceProductId || item.productId || '',
    title: item.title || '',
    imageUrl: item.imageUrl || '',
    priceValue: item.priceValue ?? null,
    currencyCode: item.currencyCode || 'CNY',
    qty: item.qty || '',
    savedAt: item.savedAt || '',
  };
}

function pickCompactMaterialProfile(item = {}) {
  if (!item || typeof item !== 'object') return null;
  return {
    key: item.key || item.productKey || '',
    shopId: item.shopId || '',
    productKey: item.productKey || item.key || '',
    productId: item.productId || '',
    offerId: item.offerId || '',
    sku: item.sku || item.ozonSku || '',
    source: item.source || 'missing',
    sourceRank: Number(item.sourceRank) || 0,
    weightKg: item.weightKg ?? null,
    widthCm: item.widthCm ?? null,
    heightCm: item.heightCm ?? null,
    depthCm: item.depthCm ?? null,
    weight: item.weight ?? '',
    width: item.width ?? '',
    height: item.height ?? '',
    length: item.length ?? '',
    applyToProduct: Boolean(item.applyToProduct),
    isConfirmed: Boolean(item.isConfirmed),
    ozonSyncedAt: item.ozonSyncedAt || '',
    ozonSyncStatus: item.ozonSyncStatus || '',
    sourceOrderId: item.sourceOrderId || '',
    sourceOrderNumber: item.sourceOrderNumber || '',
    sourcePurchaseOrderNumber: item.sourcePurchaseOrderNumber || '',
    updatedAt: item.updatedAt || '',
  };
}

function pickCompactImageHealth(item = {}) {
  return {
    imageUrl: item.imageUrl || '',
    status: item.status || 'unknown',
    httpStatus: item.httpStatus ?? null,
    source: item.source || '',
    checkedAt: item.checkedAt || '',
    updatedAt: item.updatedAt || '',
  };
}

function pickCompactManualCostProfile(item = {}) {
  if (!item || typeof item !== 'object') return null;
  return {
    shopId: item.shopId || '',
    productKey: item.productKey || '',
    productId: item.productId || '',
    offerId: item.offerId || '',
    sku: item.sku || '',
    sourceType: item.sourceType || 'historical_import',
    sourceTypes: Array.isArray(item.sourceTypes) ? item.sourceTypes : undefined,
    isComposite: Boolean(item.isComposite),
    fieldSources: item.fieldSources && typeof item.fieldSources === 'object'
      ? item.fieldSources
      : undefined,
    purchaseCostCny: item.purchaseCostCny ?? null,
    crossBorderCostCny: item.crossBorderCostCny ?? null,
    domesticFreightCny: item.domesticFreightCny ?? null,
    packagingCostCny: item.packagingCostCny ?? null,
    otherCostCny: item.otherCostCny ?? null,
    currencyCode: item.currencyCode || 'CNY',
    sourcePlatform: item.sourcePlatform || '',
    sourceUrl: item.sourceUrl || '',
    purchaseOrderNumber: item.purchaseOrderNumber || '',
    trackingNumber: item.trackingNumber || '',
    note: item.note || '',
    originImportId: item.originImportId || '',
    observedAt: item.observedAt || '',
    updatedAt: item.updatedAt || '',
  };
}

function pickSummaryRow(row = {}) {
  const materialProfile = pickCompactMaterialProfile(row.materialProfile);
  const materialProfiles = Array.isArray(row.materialProfiles)
    ? row.materialProfiles.map(pickCompactMaterialProfile).filter(Boolean)
    : [];
  const materialCandidates = Array.isArray(row.materialCandidates)
    ? row.materialCandidates.map(pickCompactMaterialProfile).filter(Boolean)
    : [];
  const sourceLinks = Array.isArray(row.sourceLinks) ? row.sourceLinks.slice(0, 5).map(pickCompactSourceLink) : [];
  const sourceRecord = sourceLinks.length
    ? {
        links: sourceLinks,
        primaryIndex: Math.max(0, sourceLinks.findIndex((item) => item.isPrimary)),
      }
    : null;
  const imageHealth = Array.isArray(row.imageHealth) ? row.imageHealth.slice(0, 20).map(pickCompactImageHealth) : [];
  const manualCostProfile = pickCompactManualCostProfile(row.manualCostProfile);
  const manualCostProfiles = Array.isArray(row.manualCostProfiles)
    ? row.manualCostProfiles.map(pickCompactManualCostProfile).filter(Boolean)
    : [];

  return {
    shopId: row.shopId,
    productKey: row.productKey,
    productId: row.productId,
    offerId: row.offerId,
    sku: row.sku,
    name: row.name,
    visibility: row.visibility,
    statusLabel: row.statusLabel,
    primaryImageUrl: row.primaryImageUrl,
    images: Array.isArray(row.images) ? row.images.slice(0, 5) : [],
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    typeId: row.typeId,
    softwareCategoryName: row.softwareCategoryName,
    softwareCategoryPath: row.softwareCategoryPath,
    priceValue: row.priceValue,
    currencyCode: row.currencyCode,
    stockValue: row.stockValue,
    commissionPercent: row.commissionPercent,
    commissionPercents:
      row.commissionPercents && typeof row.commissionPercents === 'object'
        ? { ...row.commissionPercents }
        : {},
    acquiringFeeValue: row.acquiringFeeValue,
    weightKg: materialProfile?.weight ? Number(materialProfile.weight) : row.weightKg,
    widthCm: materialProfile?.width ? Number(materialProfile.width) : row.widthCm,
    heightCm: materialProfile?.height ? Number(materialProfile.height) : row.heightCm,
    depthCm: materialProfile?.length ? Number(materialProfile.length) : row.depthCm,
    materialSource: materialProfile?.source || row.materialSource || '',
    materialProfile,
    materialProfiles,
    materialCandidates,
    sourceLinks,
    sourceRecord,
    imageHealth,
    manualCostProfile,
    manualCostProfiles,
    sourcePurchaseCostCny: row.sourcePurchaseCostCny ?? null,
    purchasePriceValue: row.purchasePriceValue ?? null,
    purchaseCostCny: row.purchaseCostCny ?? null,
    crossBorderCostCny: row.crossBorderCostCny ?? null,
    domesticFreightCny: row.domesticFreightCny ?? null,
    packagingCostCny: row.packagingCostCny ?? null,
    otherCostCny: row.otherCostCny ?? null,
    costCurrencyCode: row.costCurrencyCode || '',
    costSourcePlatform: row.costSourcePlatform || '',
    costSourceUrl: row.costSourceUrl || '',
    costPurchaseOrderNumber: row.costPurchaseOrderNumber || '',
    costTrackingNumber: row.costTrackingNumber || '',
    costNote: row.costNote || '',
    hydratedAt: row.hydratedAt,
    updatedAt: row.updatedAt,
  };
}

export function createProductSummaryService(db, options = {}) {
  const repository = options.repository || createProductRepository(db);

  return {
    readSummary(query = {}) {
      const page = repository.listProducts({
        ...query,
        scope: query.scope || 'software_all',
        pageSize: query.pageSize || query.limit || 20,
      });
      return {
        ...page,
        summaryKind: 'read_service',
        rows: page.rows.map(pickSummaryRow),
        note: 'product_summary 是只读服务结果，不复制 attributes_json/images_json/price_json 到第二张大表。',
      };
    },
  };
}

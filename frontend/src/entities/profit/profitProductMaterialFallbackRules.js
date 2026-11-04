import { getOzonLocalOrderProductLookupKey } from '../product/productLocalData.jsx';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0) return value;
    const text = normalizeText(value);
    if (text) return value;
  }
  return '';
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(
    String(value)
      .replace(/[^\d.,-]/g, '')
      .replace(',', '.')
  );
  return Number.isFinite(number) ? number : null;
}

function toMaterialText(value) {
  const number = toFiniteNumber(value);
  return number === null || number <= 0 ? '' : String(number);
}

function getNumbersFromText(value = '') {
  return (
    String(value || '')
      .match(/-?\d+(?:[.,]\d+)?/g)
      ?.map((item) => toFiniteNumber(item))
      .filter((item) => item !== null && item > 0) ?? []
  );
}

function normalizeMaterialProfile(source = {}) {
  if (!source || typeof source !== 'object') return null;
  const weight = toMaterialText(firstFilled(source.weight, source.weightKg, source.weight_kg, source.grossWeight));
  const length = toMaterialText(
    firstFilled(source.length, source.lengthCm, source.depthCm, source.depth, source.long, source.l)
  );
  const width = toMaterialText(firstFilled(source.width, source.widthCm, source.w));
  const height = toMaterialText(firstFilled(source.height, source.heightCm, source.h));
  if (!weight || !length || !width || !height) return null;
  return {
    weight,
    length,
    width,
    height,
  };
}

export function hasCompleteProfitMaterial(source = {}) {
  return Boolean(normalizeMaterialProfile(source));
}

function hasCompleteAppliedProfitMaterial(source = {}) {
  return Boolean(
    normalizeMaterialProfile({
      weight: source?.weight,
      length: source?.length,
      width: source?.width,
      height: source?.height,
    })
  );
}

export function hasProfitOrderProductMaterialGap(order = {}) {
  if (!order || typeof order !== 'object') return false;
  if (hasCompleteProfitCrossBorderMaterial(order)) return false;
  const products = Array.isArray(order.products) ? order.products : [];
  if (!products.length) return false;
  return products.some(
    (product) =>
      !hasCompleteAppliedProfitMaterial(product?.materialProfile) && !hasCompleteAppliedProfitMaterial(product)
  );
}

function normalizeProfitMaterialCandidate(candidate = {}) {
  const material = normalizeMaterialProfile(candidate);
  if (!material) return null;
  return {
    ...candidate,
    ...material,
    source: normalizeText(candidate.source) || 'ozon-initial-read',
    applyToProduct: candidate.applyToProduct !== false,
    profitFallback: true,
  };
}

function getBestProfitProductMaterialCandidate(product = {}) {
  const profile = normalizeProfitMaterialCandidate(product.materialProfile);
  if (profile) return profile;

  const directMaterial = normalizeMaterialProfile({
    weight: product.weight,
    length: product.length,
    width: product.width,
    height: product.height,
  });
  if (directMaterial) {
    return {
      ...directMaterial,
      source: normalizeText(product.materialSource) || 'product-direct-material',
      applyToProduct: true,
      profitFallback: true,
    };
  }

  const materialProfiles = Array.isArray(product.materialProfiles) ? product.materialProfiles : [];
  const profileCandidate = materialProfiles
    .filter((item) => item?.applyToProduct !== false)
    .map(normalizeProfitMaterialCandidate)
    .find(Boolean);
  if (profileCandidate) return profileCandidate;

  const materialCandidates = Array.isArray(product.materialCandidates) ? product.materialCandidates : [];
  const materialCandidate = materialCandidates
    .filter((item) => item?.applyToProduct !== false)
    .map(normalizeProfitMaterialCandidate)
    .find(Boolean);
  if (materialCandidate) return materialCandidate;

  const ozonDirectMaterial = normalizeMaterialProfile({
    weight: product.weightKg,
    length: firstFilled(product.depthCm, product.lengthCm),
    width: product.widthCm,
    height: product.heightCm,
  });
  return ozonDirectMaterial
    ? {
        ...ozonDirectMaterial,
        source: 'ozon-initial-read',
        applyToProduct: true,
        profitFallback: true,
      }
    : null;
}

function normalizeCrossBorderVolumeMaterial(item = {}) {
  return normalizeMaterialProfile({
    weight: firstFilled(item.grossWeight, item.gross_weight, item.weight, item.weightKg, item.weightText),
    length: firstFilled(item.length, item.lengthCm, item.long, item.l),
    width: firstFilled(item.width, item.widthCm, item.w),
    height: firstFilled(item.height, item.heightCm, item.h),
  });
}

export function hasCompleteProfitCrossBorderMaterial(order = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const crossBorderInfo = order.crossBorderInfo ?? {};
  const volumeItems = [
    ...(Array.isArray(crossBorderInfo.volumeItems) ? crossBorderInfo.volumeItems : []),
    ...(Array.isArray(crossBorderInfo.volume) ? crossBorderInfo.volume : []),
    ...(Array.isArray(order.volumeItems) ? order.volumeItems : []),
    ...(Array.isArray(sourceOrder.volumeItems) ? sourceOrder.volumeItems : []),
  ];
  if (volumeItems.some((item) => normalizeCrossBorderVolumeMaterial(item))) return true;

  const packageWeight = firstFilled(crossBorderInfo.packageWeight, order.packageWeight, sourceOrder.packageWeight);
  const packageSize = firstFilled(crossBorderInfo.packageSize, order.packageSize, sourceOrder.packageSize);
  const weight = toMaterialText(packageWeight);
  const dimensions = getNumbersFromText(packageSize);
  return Boolean(weight && dimensions.length >= 3);
}

export function applyProfitProductMaterialFallback(product = {}) {
  if (!product || typeof product !== 'object') return product;
  if (hasCompleteAppliedProfitMaterial(product.materialProfile) || hasCompleteAppliedProfitMaterial(product))
    return product;

  const candidate = getBestProfitProductMaterialCandidate(product);
  if (!candidate) return product;

  const material = {
    weight: candidate.weight,
    length: candidate.length,
    width: candidate.width,
    height: candidate.height,
  };
  return {
    ...product,
    ...material,
    materialProfile: {
      ...(product.materialProfile && typeof product.materialProfile === 'object' ? product.materialProfile : {}),
      ...candidate,
      ...material,
    },
    materialSource: normalizeText(product.materialSource) || candidate.source,
    profitMaterialFallbackSource: candidate.source,
  };
}

export function applyProfitProductMaterialFallbacks(products = []) {
  return (Array.isArray(products) ? products : []).map(applyProfitProductMaterialFallback);
}

export function applyProfitProductMaterialFallbackToOrder(order = {}) {
  if (!order || typeof order !== 'object') return order;
  if (hasCompleteProfitCrossBorderMaterial(order)) return order;
  const products = Array.isArray(order.products) ? order.products : [];
  if (!products.length) return order;
  return {
    ...order,
    products: applyProfitProductMaterialFallbacks(products),
  };
}

function shouldCopyProfitMaterialField(product = {}, field) {
  return !normalizeText(product[field]);
}

function mergeProfitProductSummaryMaterial(product = {}, entity = {}) {
  if (!entity || typeof entity !== 'object') return product;
  const next = { ...product };
  ['weightKg', 'widthCm', 'heightCm', 'depthCm'].forEach((field) => {
    if (shouldCopyProfitMaterialField(next, field) && entity[field] !== undefined && entity[field] !== null) {
      next[field] = entity[field];
    }
  });
  if (
    !(Array.isArray(next.materialProfiles) && next.materialProfiles.length) &&
    Array.isArray(entity.materialProfiles)
  ) {
    next.materialProfiles = entity.materialProfiles;
  }
  if (
    !(Array.isArray(next.materialCandidates) && next.materialCandidates.length) &&
    Array.isArray(entity.materialCandidates)
  ) {
    next.materialCandidates = entity.materialCandidates;
  }
  if (!next.materialProfile && entity.materialProfile && typeof entity.materialProfile === 'object') {
    next.materialProfile = entity.materialProfile;
  }
  return next;
}

export function applyProfitProductSummaryMaterialToRows(rows = [], entityMap = new Map(), getRecordKey = undefined) {
  if (!entityMap?.size) return rows;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const products = Array.isArray(row.products) ? row.products : [];
    if (!products.length) return row;
    const nextProducts = products.map((product, index) => {
      const lookupKey = getOzonLocalOrderProductLookupKey(row, index, getRecordKey);
      const entity = lookupKey ? entityMap.get(lookupKey) : null;
      return entity ? mergeProfitProductSummaryMaterial(product, entity) : product;
    });
    return applyProfitProductMaterialFallbackToOrder({
      ...row,
      products: nextProducts,
    });
  });
}

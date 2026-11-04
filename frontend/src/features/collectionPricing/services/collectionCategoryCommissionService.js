import { getProductSummary } from '../../../api/localApiClient.js';

function identity(value) {
  return String(value ?? '').trim();
}

function positivePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100
    ? Number(number.toFixed(3))
    : null;
}

function commissionRateKey(value) {
  return Number(value).toFixed(3);
}

export function resolveCollectionCategoryCommission(rows = [], scope = {}) {
  const categoryId = identity(scope.descriptionCategoryId ?? scope.categoryId);
  const typeId = identity(scope.typeId);
  const exactRows = (Array.isArray(rows) ? rows : []).filter((row) => (
    identity(row?.categoryId ?? row?.descriptionCategoryId) === categoryId
    && (!typeId || identity(row?.typeId) === typeId)
  ));
  const rates = exactRows
    .map((row) => positivePercent(row?.commissionPercent))
    .filter((value) => value !== null);
  const counts = new Map();
  rates.forEach((rate) => {
    const key = commissionRateKey(rate);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const distinctRates = [...counts.entries()]
    .map(([key, count]) => ({ percent: Number(key), count }))
    .sort((left, right) => right.count - left.count || left.percent - right.percent);
  if (!distinctRates.length) {
    return {
      status: 'unavailable',
      percent: null,
      evidenceCount: 0,
      distinctRates: [],
      source: 'ozon-product-commission-snapshot',
      message: '当前店铺还没有这个类目的真实佣金记录，请手动填写。',
    };
  }
  if (distinctRates.length > 1) {
    return {
      status: 'conflict',
      percent: null,
      evidenceCount: rates.length,
      distinctRates,
      source: 'ozon-product-commission-snapshot',
      message: `同类商品存在 ${distinctRates.length} 个不同佣金比例，请手动确认。`,
    };
  }
  return {
    status: 'ready',
    percent: distinctRates[0].percent,
    evidenceCount: rates.length,
    distinctRates,
    source: 'ozon-product-commission-snapshot',
    message: `已按当前店铺 ${rates.length} 个同类 Ozon 商品读取。`,
  };
}

export async function readCollectionCategoryCommission(scope = {}, options = {}) {
  const shopId = identity(scope.shopId);
  const descriptionCategoryId = identity(scope.descriptionCategoryId ?? scope.categoryId);
  const typeId = identity(scope.typeId);
  if (!shopId || !descriptionCategoryId || !typeId) {
    return {
      status: 'missing-scope', percent: null, evidenceCount: 0, distinctRates: [],
      source: '', message: '',
    };
  }
  const payload = await getProductSummary({
    shopId,
    scope: 'software_all',
    descriptionCategoryId,
    typeId,
    page: 1,
    pageSize: 1000,
    sort: 'stable',
  }, {
    signal: options.signal,
    timeoutMs: options.timeoutMs || 10_000,
  });
  return resolveCollectionCategoryCommission(payload?.rows, { descriptionCategoryId, typeId });
}

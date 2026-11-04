import { POINTS_IMAGE_MODELS } from '../constants/pointsPackageCatalog.js';

export function getPointsImageModel(modelId) {
  return POINTS_IMAGE_MODELS.find((item) => item.id === modelId) || POINTS_IMAGE_MODELS[0];
}

export function getPointsPerLink({ modelId, imageCount, includeRetryReserve = true } = {}) {
  const model = getPointsImageModel(modelId);
  const countKey = String(Number(imageCount) || 16);
  const rateGroup = includeRetryReserve ? model.pointRates.retry : model.pointRates.success;
  return Number(rateGroup[countKey] || rateGroup[16] || 0);
}

export function estimatePackageLinks({ packagePoints, pointsPerLink }) {
  const points = Number(packagePoints) || 0;
  const cost = Number(pointsPerLink) || 0;
  return cost > 0 ? Math.floor(points / cost) : 0;
}

export function formatPoints(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

export function formatMoney(value, digits = 2) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value) || 0);
}

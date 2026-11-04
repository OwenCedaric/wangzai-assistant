import {
  requestOzonProductAttributes,
  requestOzonProductDetails,
  requestOzonProductPrices,
} from '../../../entities/product/productOzonApi.jsx';
import { getRubCnyRealtimeRate } from '../../../api/localApiClient.js';
import { normalizeWarehouseFreightProductProfile } from '../lib/warehouseFreightEstimate.js';

function getProductId(product = {}) {
  const value = Number(product.productId || product.id || product.raw?.listItem?.product_id);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getSettledFirst(result) {
  return result.status === 'fulfilled' && Array.isArray(result.value) ? result.value[0] || null : null;
}

export async function requestWarehouseFreightProductProfile(shop, product = {}, options = {}) {
  const productId = getProductId(product);
  if (!productId) throw new Error('当前商品没有可用的 Ozon 商品编号');

  const results = await Promise.allSettled([
    requestOzonProductDetails(shop, [productId], { signal: options.signal }),
    requestOzonProductAttributes(shop, [productId], { signal: options.signal }),
    requestOzonProductPrices(shop, [productId], { signal: options.signal }),
  ]);
  const detail = getSettledFirst(results[0]);
  const attributes = getSettledFirst(results[1]);
  const priceInfo = getSettledFirst(results[2]);
  const warnings = [
    results[0].status === 'rejected' ? '商品基础信息未返回' : '',
    results[1].status === 'rejected' ? '商品材积属性未返回' : '',
    results[2].status === 'rejected' ? '商品价格未返回' : '',
  ].filter(Boolean);
  if (!detail && !attributes && !priceInfo) {
    throw new Error(warnings.join('；') || 'Ozon 未返回商品测算数据');
  }

  return {
    profile: normalizeWarehouseFreightProductProfile(product, {
      detail,
      attributes,
      priceInfo,
      source: 'ozon-live',
    }),
    warnings,
    detail,
    attributes,
    priceInfo,
  };
}

export async function requestWarehouseFreightRubCnyRate(options = {}) {
  const payload = await getRubCnyRealtimeRate({
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
  });
  const rate = Number(payload?.rubToCnyRate ?? payload?.rate);
  if (payload?.ok !== true || payload?.mode !== 'realtime') {
    throw new Error('当日实时 RUB/CNY 汇率未返回');
  }
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('未读取到有效的 RUB/CNY 汇率');
  return {
    rubToCnyRate: rate,
    source: payload.source || '实时汇率',
    fetchedAt: payload.fetchedAt || '',
  };
}

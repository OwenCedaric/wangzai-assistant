import { parseCaptureNumber } from '../purchaseCaptureNumber.js';

const PAGE_TYPES = new Set(['product', 'order-list', 'order-detail', 'logistics-detail', 'unknown']);

export function cleanCaptureText(value, maximum = 600) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

export function captureNumber(value) {
  return parseCaptureNumber(value);
}

export function captureUrl(value) {
  try {
    const url = new URL(cleanCaptureText(value, 1800));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|credential|session|auth)/iu.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function captureUrls(values, maximum = 30) {
  const rows = Array.isArray(values) ? values : [values];
  return [...new Set(rows.map(captureUrl).filter(Boolean))].slice(0, maximum);
}

function captureSkus(values) {
  const captureSkuAttribute = (value) => {
    if (value && typeof value === 'object') {
      const name = cleanCaptureText(value.name || value.key || value.label || value.property, 180);
      const rawValue = Array.isArray(value.value || value.values)
        ? (value.value || value.values).join(' / ')
        : value.value || value.values || value.valueName || value.text;
      const normalizedValue = cleanCaptureText(rawValue, 300);
      if (name && normalizedValue) return { name, value: normalizedValue };
      if (normalizedValue) return normalizedValue;
      return '';
    }
    return cleanCaptureText(value, 300);
  };
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: cleanCaptureText(item.id || item.skuId || item.offerId || `sku-${index + 1}`, 260),
      name: cleanCaptureText(item.name || item.variant, 500),
      attributes: (Array.isArray(item.attributes) ? item.attributes : [])
        .map(captureSkuAttribute)
        .filter(Boolean)
        .slice(0, 30),
      price: captureNumber(item.price ?? item.purchasePrice),
      imageUrl: captureUrl(item.imageUrl || item.image),
      weightG: captureNumber(item.weightG),
      weightKg: captureNumber(item.weightKg),
      lengthCm: captureNumber(item.lengthCm),
      widthCm: captureNumber(item.widthCm),
      heightCm: captureNumber(item.heightCm),
      option: item.option && typeof item.option === 'object' ? { ...item.option } : null,
    }))
    .slice(0, 800);
}

function captureSkuImages(values, skus = []) {
  const rows = [];
  const add = (item, index = 0) => {
    const source = item && typeof item === 'object' ? item : { imageUrl: item };
    const imageUrl = captureUrl(source.imageUrl || source.image || source.url || source.src);
    if (!imageUrl) return;
    const matchingSku = skus.find((sku) => sku.id === cleanCaptureText(source.skuId || source.id, 260))
      || skus[index]
      || null;
    const row = {
      skuId: cleanCaptureText(source.skuId || source.id || matchingSku?.id, 260),
      skuName: cleanCaptureText(source.skuName || source.name || source.variant || matchingSku?.name, 500),
      imageUrl,
    };
    const key = `${row.skuId}|${row.skuName}|${row.imageUrl}`;
    if (!rows.some((value) => `${value.skuId}|${value.skuName}|${value.imageUrl}` === key)) rows.push(row);
  };
  (Array.isArray(values) ? values : []).forEach(add);
  skus.forEach((sku, index) => {
    if (sku.imageUrl) add({ skuId: sku.id, skuName: sku.name, imageUrl: sku.imageUrl }, index);
  });
  return rows.slice(0, 800);
}

function captureAttributes(values) {
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      name: cleanCaptureText(item.name || item.key || item.label || item.property, 240),
      value: cleanCaptureText(
        Array.isArray(item.value || item.values)
          ? (item.value || item.values).join(' / ')
          : item.value || item.values || item.text,
        1200,
      ),
    }))
    .filter((item) => item.name && item.value)
    .slice(0, 200);
}

export function normalizedConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

export function detectPageType(context = {}) {
  if (PAGE_TYPES.has(context.pageType)) return context.pageType;
  const haystack = `${context.pageUrl || ''} ${context.pageTitle || ''} ${context.pageText || ''}`.toLowerCase();
  if (/(?:物流|运单|快递|logistics|tracking|express|доставк|отслежив)/u.test(haystack)) return 'logistics-detail';
  if (/(?:订单详情|交易详情|order.?detail|trade.?detail|номер заказа|заказ\s*№)/u.test(haystack)) return 'order-detail';
  if (/(?:我的订单|订单列表|order.?list|мои заказы)/u.test(haystack)) return 'order-list';
  if (/(?:商品详情|立即购买|加入购物车|offer|item|\/product\/|в корзину)/u.test(haystack)) return 'product';
  return 'unknown';
}

export function createPurchasePlatformAdapter({ id, label, hosts = [], aliases = [] } = {}) {
  function detect(url, pageTitle = '', pageText = '') {
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase(); } catch { /* use text fallback */ }
    if (hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return 1;
    const text = `${pageTitle} ${pageText}`.toLowerCase();
    return aliases.some((alias) => text.includes(alias.toLowerCase())) ? 0.55 : 0;
  }

  function extractProduct(context = {}) {
    const skus = captureSkus(context.skus);
    const legacyImages = Array.isArray(context.images) ? context.images : [];
    const mainImages = captureUrls([
      ...(Array.isArray(context.mainImages) && context.mainImages.length ? context.mainImages : legacyImages),
      context.imageUrl,
    ], 60);
    const skuImages = captureSkuImages(context.skuImages, skus);
    const detailImages = captureUrls(context.detailImages, 300)
      .filter((url) => !mainImages.includes(url) && !skuImages.some((item) => item.imageUrl === url));
    const images = captureUrls([
      ...mainImages,
      ...skuImages.map((item) => item.imageUrl),
      ...detailImages,
    ], 1200);
    return {
      productTitle: cleanCaptureText(context.productTitle, 600),
      description: cleanCaptureText(context.description, 8000),
      attributes: captureAttributes(context.attributes),
      variant: cleanCaptureText(context.variant, 260),
      quantity: context.quantity ?? null,
      sourceUrl: captureUrl(context.sourceUrl || context.pageUrl),
      sourceProductId: cleanCaptureText(context.sourceProductId, 260),
      imageUrl: mainImages[0] || images[0] || '',
      videoUrl: captureUrl(context.videoUrl),
      mainImages,
      skuImages,
      detailImages,
      images,
      skus,
      brand: cleanCaptureText(context.brand, 180),
      category: cleanCaptureText(context.category, 500),
      sourceCategoryId: cleanCaptureText(context.sourceCategoryId, 260),
      sourceCategoryName: cleanCaptureText(context.sourceCategoryName || context.category, 500),
      sourceCategoryPath: cleanCaptureText(context.sourceCategoryPath || context.sourceCategoryName || context.category, 1200),
      lengthCm: captureNumber(context.lengthCm),
      widthCm: captureNumber(context.widthCm),
      heightCm: captureNumber(context.heightCm),
      weightG: captureNumber(context.weightG),
      weightKg: captureNumber(context.weightKg),
      weightMinG: captureNumber(context.weightMinG),
      weightMaxG: captureNumber(context.weightMaxG),
      shippingStatus: cleanCaptureText(context.shippingStatus, 40),
      shippingFeeMin: captureNumber(context.shippingFeeMin),
      shippingFeeMax: captureNumber(context.shippingFeeMax),
      shippingCurrency: cleanCaptureText(context.shippingCurrency, 12),
      shippingRuleText: cleanCaptureText(context.shippingRuleText, 500),
      minimumOrderQuantity: captureNumber(context.minimumOrderQuantity),
      minimumOrderUnit: cleanCaptureText(context.minimumOrderUnit, 40),
      mixedBatchStatus: cleanCaptureText(context.mixedBatchStatus, 20),
      perSkuMinimumQuantity: captureNumber(context.perSkuMinimumQuantity),
      purchaseMultiple: captureNumber(context.purchaseMultiple),
      deliveryLeadTimeHours: captureNumber(context.deliveryLeadTimeHours),
      deliveryText: cleanCaptureText(context.deliveryText, 300),
      packageDimensions: cleanCaptureText(context.packageDimensions, 180),
      packageWeight: cleanCaptureText(context.packageWeight, 100),
    };
  }

  function extractOrder(context = {}) {
    const defaultCurrency = ['1688', '淘宝', '天猫', '拼多多', '京东'].includes(label)
      ? 'CNY'
      : ['Ozon买家', 'Wildberries'].includes(label) ? 'RUB' : '';
    return {
      purchaseOrderNumber: cleanCaptureText(context.purchaseOrderNumber || context.orderNumber, 260),
      purchaseOrderUrl: captureUrl(context.purchaseOrderUrl || context.orderUrl || context.pageUrl),
      purchasePrice: captureNumber(context.purchasePrice ?? context.amount),
      purchasePriceMin: captureNumber(context.purchasePriceMin ?? context.purchasePrice ?? context.amount),
      purchasePriceMax: captureNumber(context.purchasePriceMax ?? context.purchasePriceMin ?? context.purchasePrice ?? context.amount),
      currency: cleanCaptureText(context.currency, 12) || defaultCurrency,
      purchaseOrderStatus: cleanCaptureText(
        context.purchaseOrderStatus || context.orderStatus || context.statusText || context.purchaseStatus,
        160,
      ),
      paymentConfirmed: context.paymentConfirmed === true,
      refundConfirmed: context.refundConfirmed === true,
    };
  }

  function extractLogistics(context = {}) {
    return {
      trackingNumber: cleanCaptureText(context.trackingNumber, 260),
      carrierName: cleanCaptureText(context.carrierName, 120),
      logisticsStatus: cleanCaptureText(context.logisticsStatus || context.status, 160),
    };
  }

  function normalize(context = {}) {
    const rawConfidence = context.fieldConfidence && typeof context.fieldConfidence === 'object'
      ? context.fieldConfidence
      : {};
    return {
      platform: label,
      pageType: detectPageType(context),
      pageUrl: captureUrl(context.pageUrl || context.sourceUrl),
      pageTitle: cleanCaptureText(context.pageTitle || context.title, 300),
      ...extractProduct(context),
      ...extractOrder(context),
      ...extractLogistics(context),
      sourceConfidence: normalizedConfidence(context.sourceConfidence),
      // Keep the historical aliases used by the native toolbar while the
      // canonical fields above remain the persistence contract.
      amount: cleanCaptureText(context.amount, 80) || (Number.isFinite(captureNumber(context.purchasePrice ?? context.amount))
        ? String(captureNumber(context.purchasePrice ?? context.amount))
        : ''),
      orderNumber: cleanCaptureText(context.orderNumber || context.purchaseOrderNumber, 260),
      status: cleanCaptureText(
        context.purchaseOrderStatus || context.orderStatus || context.statusText || context.status || context.logisticsStatus,
        160,
      ),
      runtimeKind: cleanCaptureText(context.runtimeKind, 40),
      viewport: context.viewport && typeof context.viewport === 'object' ? { ...context.viewport } : null,
      fieldConfidence: {
        platform: normalizedConfidence(rawConfidence.platform) || 1,
        productTitle: normalizedConfidence(rawConfidence.productTitle),
        variant: normalizedConfidence(rawConfidence.variant),
        quantity: normalizedConfidence(rawConfidence.quantity),
        purchaseOrderNumber: normalizedConfidence(rawConfidence.purchaseOrderNumber),
        purchasePrice: normalizedConfidence(rawConfidence.purchasePrice),
        packageDimensions: normalizedConfidence(rawConfidence.packageDimensions),
        packageWeight: normalizedConfidence(rawConfidence.packageWeight),
        trackingNumber: normalizedConfidence(rawConfidence.trackingNumber),
      },
      capturedAt: cleanCaptureText(context.capturedAt || context.inspectedAt, 80) || new Date().toISOString(),
      extensionVersion: cleanCaptureText(context.extensionVersion, 80),
      fixture: context.fixture === true,
      captureStatus: cleanCaptureText(context.captureStatus, 40),
      sourceMethod: cleanCaptureText(context.sourceMethod, 80),
      rejectionReasons: (Array.isArray(context.rejectionReasons) ? context.rejectionReasons : [])
        .map((value) => cleanCaptureText(value, 180))
        .filter(Boolean)
        .slice(0, 20),
    };
  }

  function getConfidence(result = {}) {
    const values = Object.values(result.fieldConfidence || {}).filter((value) => Number(value) > 0);
    return values.length
      ? Number((values.reduce((sum, value) => sum + Number(value), 0) / values.length).toFixed(2))
      : 0;
  }

  return Object.freeze({
    id,
    label,
    detect,
    detectPageType,
    extractLogistics,
    extractOrder,
    extractProduct,
    getConfidence,
    normalize,
  });
}

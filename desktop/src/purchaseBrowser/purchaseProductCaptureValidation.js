const PRODUCT_PLATFORM_LABELS = new Set([
  '1688', '淘宝', '天猫', '拼多多', '京东', 'Wildberries', 'Amazon', 'Temu', 'AliExpress', 'Ozon买家',
]);

const PLATFORM_SOURCE_METHODS = Object.freeze({
  '1688': /^1688-(?:default-structured|structured-state)$/u,
  '淘宝': /^taobao-(?:mtop|structured-state)$/u,
  '天猫': /^taobao-(?:mtop|structured-state)$/u,
  '拼多多': /^pdd-(?:runtime-state|runtime-cache|runtime-wait|react-props|structured-state|sku-api)$/u,
  '京东': /^jd-(?:color-size-pages|product-html)$/u,
  Wildberries: /^wildberries-card-api$/u,
  Amazon: /^amazon-page-structure$/u,
  Temu: /^temu-raw-data$/u,
  AliExpress: /^aliexpress-(?:mtop|json-api)$/u,
  Ozon买家: /^ozon-widget-state$/u,
});

const PLATFORM_SOURCE_ERROR = Object.freeze({
  '1688': '1688-structured-data',
  '淘宝': 'taobao-structured-data',
  '天猫': 'tmall-structured-data',
  '拼多多': 'pdd-structured-data',
  '京东': 'jd-product-data',
  Wildberries: 'wildberries-product-data',
  Amazon: 'amazon-product-data',
  Temu: 'temu-product-data',
  AliExpress: 'aliexpress-product-data',
  Ozon买家: 'ozon-product-data',
});

const TITLE_NOISE_PATTERNS = Object.freeze([
  /^(?:用户评价|累计评价|全部评价|商品评价|评论|买家评价)(?:[·:：\s]*\d+[+万]?)?$/u,
  /^(?:商品详情|商品信息|店铺首页|首页|登录|立即登录|安全验证|访问受限)$/u,
  /^(?:captcha|verify|sign\s*in|log\s*in)$/iu,
]);

function clean(value, maximum = 1200) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function validatePurchaseProductCapture(capture = {}) {
  const missing = [];
  const platform = clean(capture.platform, 80);
  const sourceMethod = clean(capture.sourceMethod, 120);
  const title = clean(capture.productTitle, 1200);
  const skus = Array.isArray(capture.skus) ? capture.skus : [];
  const images = Array.isArray(capture.mainImages) ? capture.mainImages : [];
  if (!PRODUCT_PLATFORM_LABELS.has(platform)) missing.push('platform');
  if (capture.pageType !== 'product') missing.push('product-page');
  if (capture.captureStatus === 'rejected') missing.push('page-validation');
  if (title.length < 4 || TITLE_NOISE_PATTERNS.some((pattern) => pattern.test(title))) missing.push('title');
  if (!clean(capture.sourceProductId, 260)) missing.push('product-id');
  if (!positive(capture.purchasePrice)) missing.push('price');
  if (!images.length) missing.push('main-image');
  if (!skus.length || !skus.some((sku) => clean(sku.id || sku.name, 500) && positive(sku.price || capture.purchasePrice))) {
    missing.push('sku');
  }
  const sourcePattern = PLATFORM_SOURCE_METHODS[platform];
  if (sourcePattern && !sourcePattern.test(sourceMethod)) missing.push(PLATFORM_SOURCE_ERROR[platform]);
  return Object.freeze({ accepted: missing.length === 0, missing: Object.freeze(missing) });
}

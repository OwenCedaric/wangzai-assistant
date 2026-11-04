const SUPPORTED_PRODUCT_PLATFORMS = new Set([
  '1688', 'taobao', 'tmall', 'pdd', 'ozon-buyer',
  'jd', 'wildberries', 'amazon', 'temu', 'aliexpress',
]);

const TITLE_NOISE_PATTERNS = Object.freeze([
  /^(?:用户评价|累计评价|全部评价|商品评价|评论|买家评价)(?:[·:：\s]*\d+[+万]?)?$/u,
  /^(?:商品详情|商品信息|店铺首页|首页|登录|立即登录|安全验证|访问受限)$/u,
  /^(?:captcha|verify|sign\s*in|log\s*in)$/iu,
]);

function clean(value, maximum = 1200) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function sourceIdFromUrl(value, platformCode = '') {
  try {
    const url = new URL(clean(value, 2400));
    if (['taobao', 'tmall'].includes(platformCode)) return clean(url.searchParams.get('id'), 260);
    if (platformCode === 'pdd') return clean(url.searchParams.get('goods_id'), 260);
    if (platformCode === '1688') return clean(url.pathname.match(/\/offer\/(\d+)\.html/iu)?.[1], 260);
    if (platformCode === 'ozon-buyer') return clean(url.pathname.match(/(?:-|\/)(\d{5,})(?:\/|$)/u)?.[1], 260);
    if (platformCode === 'jd') return clean(url.pathname.match(/\/(\d{5,})\.html/iu)?.[1], 260);
    if (platformCode === 'wildberries') return clean(url.pathname.match(/\/catalog\/(\d+)/iu)?.[1], 260);
    if (platformCode === 'amazon') return clean(url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{8,16})/iu)?.[1], 260);
    if (platformCode === 'aliexpress') return clean(url.pathname.match(/\/item\/(\d+)/iu)?.[1], 260);
    return '';
  } catch {
    return '';
  }
}

export function isMeaningfulCollectedProductTitle(value) {
  const title = clean(value, 1200);
  return title.length >= 4 && !TITLE_NOISE_PATTERNS.some((pattern) => pattern.test(title));
}

export function validateCollectedProduct(product = {}) {
  const coreMissing = [];
  const detailMissing = [];
  const platformCode = clean(product.platformCode, 80);
  const sourceProductId = clean(product.sourceProductId, 260);
  const urlProductId = sourceIdFromUrl(product.sourceUrl, platformCode);
  const skus = Array.isArray(product.skus) ? product.skus : [];
  const mainImages = Array.isArray(product.mainImages) ? product.mainImages : [];
  const skuImages = Array.isArray(product.skuImages) ? product.skuImages : [];
  const detailImages = Array.isArray(product.detailImages) ? product.detailImages : [];
  const attributes = Array.isArray(product.attributes) ? product.attributes : [];

  if (!SUPPORTED_PRODUCT_PLATFORMS.has(platformCode)) coreMissing.push('支持的平台');
  if (product.pageType && product.pageType !== 'product') coreMissing.push('商品详情页');
  if (product.captureStatus === 'rejected') coreMissing.push('有效商品页面');
  if (!isMeaningfulCollectedProductTitle(product.title)) coreMissing.push('正确标题');
  if (!sourceProductId) coreMissing.push('商品 ID');
  if (urlProductId && sourceProductId && urlProductId !== sourceProductId) coreMissing.push('商品 ID 匹配');
  if (!positiveNumber(product.purchasePrice)) coreMissing.push('有效价格');
  if (!mainImages.length) coreMissing.push('商品主图');
  if (!skus.length) coreMissing.push('SKU 明细');
  if (skus.length && !skus.some((sku) => clean(sku.id || sku.name, 500) && positiveNumber(sku.price || product.purchasePrice))) {
    coreMissing.push('SKU 价格');
  }

  if (!clean(product.description, 8000) && !attributes.length) detailMissing.push('商品描述或属性');
  if (!detailImages.length) detailMissing.push('详情图');
  if (skus.length > 1 && !skuImages.length) detailMissing.push('SKU 图片');

  const status = coreMissing.length ? 'rejected' : detailMissing.length ? 'usable' : 'complete';
  return Object.freeze({
    accepted: coreMissing.length === 0,
    status,
    label: status === 'complete' ? '完整' : status === 'usable' ? '可用' : '未通过',
    coreMissing: Object.freeze(coreMissing),
    detailMissing: Object.freeze(detailMissing),
    missing: Object.freeze([...coreMissing, ...detailMissing]),
  });
}

export function assertCollectedProductUsable(product = {}) {
  const validation = validateCollectedProduct(product);
  if (validation.accepted) return validation;
  const error = new Error(`商品资料校验未通过：${validation.coreMissing.join('、')}`);
  error.code = 'COLLECTION_PRODUCT_CAPTURE_INCOMPLETE';
  error.missing = [...validation.coreMissing];
  throw error;
}

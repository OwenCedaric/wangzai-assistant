const MAX_TEXT_LENGTH = 1200;
const SOURCE_PLATFORM_CODES = new Set([
  '1688', 'pdd', 'taobao', 'tmall', 'jd', 'wildberries', 'amazon', 'temu', 'aliexpress',
]);

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value, maximum = MAX_TEXT_LENGTH) {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeProductLink(value) {
  try {
    const url = new URL(text(value, 2400));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|credential|session|auth)/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return '';
  }
}

function safeDisplayImageUrl(value) {
  try {
    const url = new URL(text(value, 2400));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeSkuBindingName(value) {
  return text(value, 800)
    .normalize('NFKC')
    .replace(/[：﹕]/gu, ':')
    .replace(/[／|｜]/gu, '/')
    .replace(/\s*([:/])\s*/gu, '$1')
    .toLocaleLowerCase('zh-CN');
}

function normalizedAttributes(value) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const name = text(item.name || item.key || (item.id ? `属性 ${item.id}` : ''), 180);
    const attributeValue = text(item.value, 500);
    return name && attributeValue ? [{ name, value: attributeValue }] : [];
  });
}

export function readableSkuName(sku = {}) {
  const attributes = normalizedAttributes(sku.attributes);
  const attributeName = attributes.map((item) => `${item.name}：${item.value}`).join(' / ');
  return text(attributeName || sku.name || sku.offerId || sku.id, 800);
}

function skuRows(product = {}, platformCode = '') {
  const rows = (Array.isArray(product.skus) ? product.skus : []).map((sku, index) => {
    const id = text(sku.id || sku.skuId || sku.sku_id || sku.offerId || sku.offer_id, 260);
    const name = readableSkuName(sku);
    const priceValue = numberOrNull(sku.price ?? sku.priceValue);
    return {
      id,
      key: id ? `${platformCode}:${id}` : '',
      name,
      normalizedName: normalizeSkuBindingName(name),
      attributes: normalizedAttributes(sku.attributes),
      price: priceValue === null ? '' : String(priceValue),
      priceValue,
      currency: text(sku.currency || product.currency, 12).toUpperCase(),
      imageUrl: safeDisplayImageUrl(sku.imageUrl || sku.image_url),
      enabled: sku.enabled !== false,
      stock: numberOrNull(sku.stock ?? sku.option?.stock),
      productId: text(sku.productId || sku.product_id, 260),
      offerId: text(sku.offerId || sku.offer_id, 260),
      position: index,
    };
  }).filter((sku) => sku.id && sku.name);

  if (!rows.length) throw fail('AUTO_ORDER_SKU_IDS_MISSING', '商品没有返回可绑定的真实 SKU ID。');
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw fail('AUTO_ORDER_SKU_IDS_DUPLICATE', `商品中存在重复 SKU ID：${row.id}`);
    ids.add(row.id);
  }
  return rows;
}

export function createSkuNameCatalog(product = {}, { role = 'source' } = {}) {
  const url = safeProductLink(product.sourceUrl);
  const platformCode = text(product.platformCode, 80).toLowerCase();
  const title = text(product.title, 1200);
  if (!url || !title) throw fail('AUTO_ORDER_PRODUCT_INFORMATION_INCOMPLETE', '商品链接没有返回完整商品信息。');
  if (role === 'ozon' && platformCode !== 'ozon-buyer' && platformCode !== 'ozon-seller') {
    throw fail('AUTO_ORDER_OZON_LINK_REQUIRED', '左侧必须读取自己的 Ozon 商品。');
  }
  if (role === 'source' && platformCode.startsWith('ozon-')) {
    throw fail('AUTO_ORDER_SOURCE_LINK_REQUIRED', '右侧必须粘贴货源平台商品链接。');
  }
  if (role === 'source' && !SOURCE_PLATFORM_CODES.has(platformCode)) {
    throw fail('AUTO_ORDER_SOURCE_PLATFORM_UNSUPPORTED', '当前链接不是支持的货源平台商品详情页。');
  }
  return {
    role,
    url,
    platform: text(product.platform, 80),
    platformCode,
    productId: text(product.productId || product.sourceProductId, 260),
    offerId: text(product.offerId, 260),
    title,
    currency: text(product.currency, 12).toUpperCase(),
    skus: skuRows(product, platformCode),
  };
}

export function calculateSkuPriceDifference(ozonSku = {}, sourceSku = {}, rubToCnyRate = null) {
  const ozonPrice = numberOrNull(ozonSku.priceValue ?? ozonSku.price);
  const sourcePrice = numberOrNull(sourceSku.priceValue ?? sourceSku.price);
  const ozonCurrency = text(ozonSku.currency, 12).toUpperCase();
  const sourceCurrency = text(sourceSku.currency, 12).toUpperCase();
  const rate = numberOrNull(rubToCnyRate);
  if (ozonPrice === null || sourcePrice === null) {
    return { status: 'missing-price', ozonPrice, sourcePrice, ozonCurrency, sourceCurrency };
  }
  let ozonPriceCny = null;
  if (['CNY', 'RMB'].includes(ozonCurrency)) ozonPriceCny = ozonPrice;
  else if (['RUB', 'RUR'].includes(ozonCurrency) && rate) ozonPriceCny = ozonPrice * rate;
  const sourcePriceCny = ['CNY', 'RMB'].includes(sourceCurrency) ? sourcePrice : null;
  if (ozonPriceCny === null || sourcePriceCny === null) {
    return {
      status: 'exchange-rate-required', ozonPrice, sourcePrice, ozonCurrency, sourceCurrency,
      rubToCnyRate: rate,
    };
  }
  return {
    status: 'ready',
    ozonPrice,
    sourcePrice,
    ozonCurrency,
    sourceCurrency,
    rubToCnyRate: rate,
    ozonPriceCny: Number(ozonPriceCny.toFixed(2)),
    sourcePriceCny: Number(sourcePriceCny.toFixed(2)),
    differenceCny: Number((ozonPriceCny - sourcePriceCny).toFixed(2)),
  };
}

function scopeValue(scope = {}, name) {
  return text(scope?.[name], 260);
}

export function createSkuNameBinding({
  ozonCatalog,
  sourceCatalog,
  selections = {},
  scope = {},
  rubToCnyRate = null,
  now = () => new Date(),
} = {}) {
  if (!ozonCatalog?.skus?.length || !sourceCatalog?.skus?.length) {
    throw fail('AUTO_ORDER_SKU_CATALOGS_REQUIRED', '请先读取 Ozon 商品和货源商品的全部 SKU。');
  }
  const sourceById = new Map(sourceCatalog.skus.filter((sku) => sku.enabled).map((sku) => [sku.id, sku]));
  const selectedSourceIds = new Set();
  const pairs = ozonCatalog.skus.map((ozonSku) => {
    const sourceSkuId = text(selections[ozonSku.id], 260);
    const sourceSku = sourceById.get(sourceSkuId);
    if (!sourceSku) throw fail('AUTO_ORDER_SKU_BINDING_INCOMPLETE', `请选择“${ozonSku.name}”对应的货源 SKU。`);
    if (selectedSourceIds.has(sourceSkuId)) {
      throw fail('AUTO_ORDER_SOURCE_SKU_ALREADY_BOUND', `货源 SKU“${sourceSku.name}”不能重复绑定。`);
    }
    selectedSourceIds.add(sourceSkuId);
    return {
      ozonSkuId: ozonSku.id,
      ozonSkuName: ozonSku.name,
      ozonAttributes: ozonSku.attributes,
      ozonPrice: ozonSku.price,
      ozonCurrency: ozonSku.currency,
      ozonImageUrl: ozonSku.imageUrl,
      sourceSkuId: sourceSku.id,
      sourceSkuName: sourceSku.name,
      sourceAttributes: sourceSku.attributes,
      sourcePrice: sourceSku.price,
      sourceCurrency: sourceSku.currency,
      sourceImageUrl: sourceSku.imageUrl,
      priceDifference: calculateSkuPriceDifference(ozonSku, sourceSku, rubToCnyRate),
    };
  });
  return {
    version: 2,
    shopId: scopeValue(scope, 'shopId'),
    ozonProductId: scopeValue(scope, 'productId') || ozonCatalog.productId,
    ozonOfferId: scopeValue(scope, 'offerId') || ozonCatalog.offerId,
    ozonOrderSku: scopeValue(scope, 'sku'),
    ozonUrl: ozonCatalog.url,
    ozonTitle: ozonCatalog.title,
    sourceUrl: sourceCatalog.url,
    sourceTitle: sourceCatalog.title,
    sourcePlatform: sourceCatalog.platform,
    sourcePlatformCode: sourceCatalog.platformCode,
    bindingStatus: 'exact-bound',
    pairs,
    updatedAt: now().toISOString(),
  };
}

function normalizePair(pair = {}) {
  const ozonSkuId = text(pair.ozonSkuId, 260);
  const sourceSkuId = text(pair.sourceSkuId, 260);
  const ozonSkuName = text(pair.ozonSkuName, 800);
  const sourceSkuName = text(pair.sourceSkuName, 800);
  if (!ozonSkuName || !sourceSkuName) return null;
  return {
    ozonSkuId,
    ozonSkuName,
    ozonAttributes: normalizedAttributes(pair.ozonAttributes),
    ozonPrice: text(pair.ozonPrice, 80),
    ozonCurrency: text(pair.ozonCurrency, 12).toUpperCase(),
    ozonImageUrl: safeDisplayImageUrl(pair.ozonImageUrl),
    sourceSkuId,
    sourceSkuName,
    sourceAttributes: normalizedAttributes(pair.sourceAttributes),
    sourcePrice: text(pair.sourcePrice, 80),
    sourceCurrency: text(pair.sourceCurrency, 12).toUpperCase(),
    sourceImageUrl: safeDisplayImageUrl(pair.sourceImageUrl),
    priceDifference: pair.priceDifference && typeof pair.priceDifference === 'object'
      ? { ...pair.priceDifference }
      : null,
    exact: Boolean(ozonSkuId && sourceSkuId),
  };
}

export function normalizeSkuNameBindingDocument(value = {}) {
  const bindings = (Array.isArray(value.bindings) ? value.bindings : []).flatMap((binding) => {
    const ozonUrl = safeProductLink(binding?.ozonUrl);
    const sourceUrl = safeProductLink(binding?.sourceUrl);
    const pairs = (Array.isArray(binding?.pairs) ? binding.pairs : []).map(normalizePair).filter(Boolean);
    if (!ozonUrl || !sourceUrl || !pairs.length) return [];
    const exact = pairs.every((pair) => pair.exact);
    return [{
      version: 2,
      shopId: text(binding.shopId, 260),
      ozonProductId: text(binding.ozonProductId, 260),
      ozonOfferId: text(binding.ozonOfferId, 260),
      ozonOrderSku: text(binding.ozonOrderSku, 260),
      ozonUrl,
      ozonTitle: text(binding.ozonTitle, 1200),
      sourceUrl,
      sourceTitle: text(binding.sourceTitle, 1200),
      sourcePlatform: text(binding.sourcePlatform, 80),
      sourcePlatformCode: text(binding.sourcePlatformCode, 80),
      bindingStatus: exact ? 'exact-bound' : 'legacy-name-only',
      pairs,
      updatedAt: text(binding.updatedAt, 80),
    }];
  });
  return { version: 2, bindings };
}

function bindingIdentity(binding = {}) {
  return [binding.shopId, binding.ozonProductId || binding.ozonOfferId || binding.ozonUrl].join('|');
}

export function mergeSkuNameBinding(document = {}, binding = {}) {
  const current = normalizeSkuNameBindingDocument(document);
  const next = normalizeSkuNameBindingDocument({ bindings: [binding] }).bindings[0];
  if (!next || next.bindingStatus !== 'exact-bound') {
    throw fail('AUTO_ORDER_SKU_BINDING_INVALID', 'SKU精确绑定内容不完整。');
  }
  const nextIdentity = bindingIdentity(next);
  return {
    version: 2,
    bindings: [
      next,
      ...current.bindings.filter((item) => bindingIdentity(item) !== nextIdentity),
    ].slice(0, 200),
  };
}

export function resolveExactSkuBinding(document = {}, order = {}) {
  const normalized = normalizeSkuNameBindingDocument(document);
  const shopId = text(order.shopId || order.shop_id, 260);
  const ozonSkuId = text(order.sku || order.ozonSku || order.skuId, 260);
  const offerId = text(order.offerId || order.offer_id, 260);
  if (!shopId || !ozonSkuId) return null;
  const candidates = [];
  for (const binding of normalized.bindings) {
    if (binding.bindingStatus !== 'exact-bound' || binding.shopId !== shopId) continue;
    const pair = binding.pairs.find((item) => item.ozonSkuId === ozonSkuId);
    if (pair) candidates.push({ binding, pair });
  }
  if (!candidates.length) return null;
  // One Ozon product family can contain several SKUs with different offer_id
  // values while the binding document stores only the family's base offer.
  // The exact shop + Ozon SKU pair is authoritative. Use offer_id only to
  // disambiguate duplicated legacy rows instead of rejecting a valid variant.
  if (candidates.length === 1) return candidates[0];
  const exactOffer = offerId
    ? candidates.filter((candidate) => candidate.binding.ozonOfferId === offerId)
    : [];
  return exactOffer.length === 1 ? exactOffer[0] : null;
}

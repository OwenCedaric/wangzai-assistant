import { getLocalShops } from '../../../api/localApiClient.js';
import { readProductSourceLinksFromLocalApi, readProductSummary } from '../../../services/productModuleClient.js';
import { loadSkuNameBindings } from './purchaseSkuBindingService.js';

const PRODUCT_PAGE_SIZE = 5000;
const MAX_PRODUCT_PAGES = 100;

function text(value) {
  return String(value ?? '').trim();
}

function safeUrl(value) {
  try {
    const url = new URL(text(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function lastNumericIdentity(value) {
  const matches = String(value || '').match(/\d{5,}/gu);
  return matches?.at(-1) || '';
}

function ozonUrlIdentity(value) {
  try {
    const url = new URL(safeUrl(value));
    return /(^|\.)ozon\.ru$/iu.test(url.hostname) ? lastNumericIdentity(url.pathname) : '';
  } catch {
    return '';
  }
}

function sourceUrlIdentity(value) {
  try {
    const url = new URL(safeUrl(value));
    const explicit = ['goods_id', 'id', 'item_id', 'offer_id', 'product_id']
      .map((key) => text(url.searchParams.get(key)))
      .find(Boolean);
    return `${url.hostname.toLowerCase()}:${explicit || lastNumericIdentity(url.pathname) || url.pathname}`;
  } catch {
    return '';
  }
}

function sourceLinkRows(value) {
  return (Array.isArray(value) ? value : []).filter((row) => safeUrl(row?.link || row?.url));
}

function primarySourceLink(record = {}) {
  const links = sourceLinkRows(record.sourceLinks?.length ? record.sourceLinks : record.links);
  return links.find((row) => row.isPrimary || row.is_primary) || links[0] || null;
}

function buildOzonProductUrl(record = {}) {
  const publicSku = lastNumericIdentity(record.sku);
  return publicSku ? `https://www.ozon.ru/product/${publicSku}/` : '';
}

function recordUpdatedAt(record = {}, source = {}) {
  return [record.updatedAt, record.hydratedAt, source.updatedAt, source.savedAt]
    .map((value) => ({ value: text(value), time: Date.parse(value || '') || 0 }))
    .sort((left, right) => right.time - left.time)[0]?.value || '';
}

function shopIndex(value = {}) {
  const shops = Array.isArray(value?.shops) ? value.shops : Array.isArray(value) ? value : [];
  return new Map(shops.flatMap((shop) => {
    const id = text(shop?.id || shop?.shopId || shop?.shop_id);
    return id ? [[id, shop]] : [];
  }));
}

function productPrice(record = {}, complete = null) {
  const fallback = Array.isArray(complete?.pairs) ? complete.pairs[0] : null;
  const value = record.priceValue ?? record.price_value ?? fallback?.ozonPrice;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function ozonProductImage(record = {}, complete = null) {
  const fallback = Array.isArray(complete?.pairs) ? complete.pairs[0] : null;
  const images = Array.isArray(record.images) ? record.images : [];
  return safeUrl(record.primaryImageUrl || record.primary_image_url || images[0] || fallback?.ozonImageUrl);
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metricRange(values = []) {
  const numbers = values.map(numeric).filter((value) => value !== null);
  if (!numbers.length) return null;
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    count: numbers.length,
  };
}

function bindingPriceMetrics(pairs = []) {
  const rows = (Array.isArray(pairs) ? pairs : []).flatMap((pair) => {
    const sourceCurrency = text(pair?.sourceCurrency).toUpperCase();
    const ozonCurrency = text(pair?.ozonCurrency).toUpperCase();
    const sourcePrice = numeric(pair?.priceDifference?.sourcePriceCny)
      ?? (['CNY', 'RMB'].includes(sourceCurrency) ? numeric(pair?.sourcePrice) : null);
    const salePrice = numeric(pair?.priceDifference?.ozonPriceCny)
      ?? (['CNY', 'RMB'].includes(ozonCurrency) ? numeric(pair?.ozonPrice) : null);
    const difference = numeric(pair?.priceDifference?.differenceCny)
      ?? (salePrice !== null && sourcePrice !== null ? salePrice - sourcePrice : null);
    if (sourcePrice === null || salePrice === null || difference === null) return [];
    return [{
      sourcePrice,
      difference,
      grossMargin: salePrice > 0 ? (difference / salePrice) * 100 : null,
    }];
  });
  return {
    sourcePrice: metricRange(rows.map((row) => row.sourcePrice)),
    difference: metricRange(rows.map((row) => row.difference)),
    grossMargin: metricRange(rows.map((row) => row.grossMargin)),
  };
}

function completeBindingIndex(document = {}) {
  const rows = Array.isArray(document.bindings) ? document.bindings : [];
  return {
    byOzonIdentity: new Map(rows.map((row) => [ozonUrlIdentity(row.ozonUrl), row]).filter(([key]) => key)),
    bySourceIdentity: new Map(rows.map((row) => [sourceUrlIdentity(row.sourceUrl), row]).filter(([key]) => key)),
    rows,
  };
}

function matchingCompleteBinding(index, record, source) {
  const ozonIdentity = lastNumericIdentity(record.sku) || ozonUrlIdentity(record.ozonUrl);
  if (ozonIdentity && index.byOzonIdentity.has(ozonIdentity)) return index.byOzonIdentity.get(ozonIdentity);
  const sourceIdentity = sourceUrlIdentity(source?.link || source?.url);
  return sourceIdentity ? index.bySourceIdentity.get(sourceIdentity) || null : null;
}

function toCatalogRow(record, source, complete = null, shopsById = new Map()) {
  const sourceUrl = safeUrl(source?.link || source?.url || complete?.sourceUrl);
  const ozonUrl = safeUrl(complete?.ozonUrl) || buildOzonProductUrl(record);
  if (!sourceUrl || !ozonUrl) return null;
  const pairs = Array.isArray(complete?.pairs) ? complete.pairs.filter(Boolean) : [];
  const exactPairs = pairs.filter((pair) => text(pair.ozonSkuId) && text(pair.sourceSkuId));
  const shopId = text(record.shopId || record.shop_id);
  const shop = shopsById.get(shopId) || {};
  const productKey = text(record.productKey || record.product_key || record.offerId || record.offer_id || record.productId || record.product_id);
  const sku = text(record.sku);
  const productId = text(record.productId || record.product_id);
  const offerId = text(record.offerId || record.offer_id);
  const stableIdentity = sku
    ? `sku:${sku}`
    : productId
      ? `product:${productId}`
      : offerId
        ? `offer:${offerId}`
        : productKey || ozonUrl;
  return {
    id: `${shopId}:${stableIdentity}`,
    shopId,
    shopName: text(
      record.shopAlias || record.shopName || record.shop_name
      || shop.shopAlias || shop.alias || shop.name || shopId,
    ) || 'Ozon店铺',
    productKey,
    productId,
    offerId,
    sku,
    ozonUrl,
    ozonTitle: text(complete?.ozonTitle || record.name) || text(record.offerId || record.productId) || 'Ozon商品',
    ozonImageUrl: ozonProductImage(record, complete),
    salePrice: productPrice(record, complete),
    saleCurrency: text(record.currencyCode || record.currency_code || complete?.pairs?.[0]?.ozonCurrency || 'CNY').toUpperCase(),
    sourceUrl,
    sourceTitle: text(complete?.sourceTitle || source?.title) || '已保存货源商品',
    sourcePlatform: text(complete?.sourcePlatform || source?.platform) || '—',
    pairs,
    bindingPriceMetrics: bindingPriceMetrics(pairs),
    bindingStatus: pairs.length && exactPairs.length === pairs.length ? 'bound' : 'sku-pending',
    updatedAt: text(complete?.updatedAt) || recordUpdatedAt(record, source),
  };
}

async function readAllSourceLinkedProducts(readSummary) {
  const rows = [];
  for (let page = 1; page <= MAX_PRODUCT_PAGES; page += 1) {
    const result = await readSummary({
      scope: 'software_all',
      sourceStatuses: 'saved',
      page,
      pageSize: PRODUCT_PAGE_SIZE,
    });
    const pageRows = Array.isArray(result?.rows) ? result.rows : [];
    rows.push(...pageRows);
    const total = Number(result?.total) || rows.length;
    if (!pageRows.length || rows.length >= total || pageRows.length < PRODUCT_PAGE_SIZE) break;
  }
  return rows;
}

function uniqueSourceRecords(value = {}) {
  const records = new Map();
  Object.values(value && typeof value === 'object' ? value : {}).forEach((record) => {
    const shopId = text(record?.shopId || record?.shop_id);
    const productKey = text(record?.productKey || record?.product_key);
    const key = shopId && productKey ? `${shopId}:${productKey}` : '';
    if (key && !records.has(key)) records.set(key, record);
  });
  return [...records.values()];
}

export async function loadAutoOrderProductList(options = {}) {
  const readBindings = options.readBindings || loadSkuNameBindings;
  const readSummary = options.readSummary || readProductSummary;
  const readSourceLinks = options.readSourceLinks || readProductSourceLinksFromLocalApi;
  const readShops = options.readShops || getLocalShops;
  const [document, summaryRows, sourceRecords, shopResult] = await Promise.all([
    readBindings(),
    readAllSourceLinkedProducts(readSummary),
    readSourceLinks().then(uniqueSourceRecords).catch(() => []),
    readShops({ timeoutMs: 10000 }).catch(() => ({ shops: [] })),
  ]);
  const completeIndex = completeBindingIndex(document);
  const shopsById = shopIndex(shopResult);
  const items = new Map();

  summaryRows.forEach((record) => {
    const source = primarySourceLink(record);
    if (!source) return;
    const row = toCatalogRow(record, source, matchingCompleteBinding(completeIndex, record, source), shopsById);
    if (row) items.set(row.id, row);
  });

  sourceRecords.forEach((record) => {
    const source = primarySourceLink(record);
    if (!source) return;
    const row = toCatalogRow(record, source, matchingCompleteBinding(completeIndex, record, source), shopsById);
    if (row && !items.has(row.id)) items.set(row.id, row);
  });

  completeIndex.rows.forEach((binding) => {
    const id = `saved:${binding.ozonUrl}`;
    if ([...items.values()].some((item) => item.ozonUrl === safeUrl(binding.ozonUrl))) return;
    const row = toCatalogRow({ ozonUrl: binding.ozonUrl, shopId: binding.shopId }, { link: binding.sourceUrl }, binding, shopsById);
    if (row) items.set(id, { ...row, id });
  });

  const catalog = [...items.values()].sort((left, right) => (
    (Date.parse(right.updatedAt || '') || 0) - (Date.parse(left.updatedAt || '') || 0)
  ));
  return {
    version: 1,
    items: catalog,
    total: catalog.length,
    boundCount: catalog.filter((item) => item.bindingStatus === 'bound').length,
    pendingSkuCount: catalog.filter((item) => item.bindingStatus === 'sku-pending').length,
  };
}

export const autoOrderProductListInternals = Object.freeze({
  buildOzonProductUrl,
  sourceUrlIdentity,
});

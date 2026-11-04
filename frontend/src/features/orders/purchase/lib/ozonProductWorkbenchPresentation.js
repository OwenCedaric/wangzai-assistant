import { resolveOzonProductPageTarget } from '../../../../services/ozonProductPageLink.js';
import { buildPurchaseOrderWorkbenchPresentation } from './purchaseOrderWorkbenchPresentation.js';

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstSourceEntryFromRecord(record = {}) {
  const safeRecord = plainObject(record);
  if (Array.isArray(safeRecord.links)) {
    const primaryIndex = Number.isInteger(Number(safeRecord.primaryIndex)) ? Number(safeRecord.primaryIndex) : 0;
    return plainObject(safeRecord.links[primaryIndex] || safeRecord.links[0]);
  }
  return safeRecord;
}

function findEmbeddedSourceEntry(order = {}, product = {}) {
  const directCandidates = [
    product.sourceEntry,
    product.materialSource,
    product.sourceRecord,
    order.sourceEntry,
    order.materialSource,
    order.manualSourceRecord,
    order.sourceRecord,
  ];
  for (const candidate of directCandidates) {
    const entry = firstSourceEntryFromRecord(candidate);
    if (Object.keys(entry).length) return entry;
  }
  const recordGroups = [order.manualSourceRecords, order.sourceRecords];
  for (const group of recordGroups) {
    for (const record of Object.values(plainObject(group))) {
      const entry = firstSourceEntryFromRecord(record);
      if (Object.keys(entry).length) return entry;
    }
  }
  return {};
}

function sourceEntryForPresentation({ order, product, sourceEntry, purchaseInfo }) {
  const embedded = findEmbeddedSourceEntry(order, product);
  const explicit = plainObject(sourceEntry);
  const support = plainObject(purchaseInfo);
  return {
    ...embedded,
    ...explicit,
    link: explicit.link || embedded.link || support.sourceLink || '',
    platform: explicit.platform || embedded.platform || support.platform || '',
    title: explicit.title || embedded.title || support.sourceTitle || '',
    imageUrl: explicit.imageUrl || embedded.imageUrl || support.sourceImage || '',
    price: explicit.price || embedded.price || support.cost || '',
    qty: explicit.qty || embedded.qty || support.qty || '',
  };
}

function productForPresentation(order = {}, product = {}) {
  return {
    ...product,
    name: product.name || product.title || order.product || order.productName || '',
    title: product.title || product.name || order.product || order.productName || '',
    sku: product.sku || product.offerId || order.offerId || order.sku || '',
    quantity: product.quantity || product.qty || order.qty || order.items || 1,
  };
}

export function buildOzonProductWorkbenchOpenPayload({
  order = {},
  product = {},
  sourceEntry = {},
  sourceShop = null,
  purchaseInfo = {},
  crossBorderInfo = {},
  profitItems = null,
  sidebarKind = 'order',
  profit = null,
  afterSales = null,
  productAnalysis = null,
  title = '',
  subtitle = '',
} = {}) {
  const displayProduct = productForPresentation(order, product);
  const target = resolveOzonProductPageTarget(displayProduct, order);
  if (!target.url) return { target, presentation: null };
  const displaySourceEntry = sourceEntryForPresentation({
    order,
    product: displayProduct,
    sourceEntry,
    purchaseInfo,
  });
  const basePresentation = buildPurchaseOrderWorkbenchPresentation({
    order,
    product: displayProduct,
    sourceEntry: displaySourceEntry,
    sourceShop,
    sourceLink: displaySourceEntry.link,
    purchaseInfo,
    crossBorderInfo,
    profitItems,
  });
  return {
    target,
    presentation: {
      ...basePresentation,
      sidebarKind,
      ...(profit ? { profit } : {}),
      ...(afterSales ? { afterSales } : {}),
      ...(productAnalysis ? { productAnalysis } : {}),
      title: title || '商品订单操作台',
      subtitle: subtitle || '左侧商品订单信息固定，右侧 Ozon 商品页面独立操作',
      browserLabel: 'Ozon 商品页面',
      product: {
        ...basePresentation.product,
        title: displayProduct.title || displayProduct.name || basePresentation.product.title,
        sku: displayProduct.offerId || displayProduct.sku || basePresentation.product.sku,
        imageUrl: displayProduct.imageUrl
          || displayProduct.image
          || displayProduct.primaryImage
          || basePresentation.product.imageUrl,
      },
      notice: sidebarKind === 'product-analysis'
        ? '左侧当前商品数据固定，右侧可以查看完整的 Ozon 商品页面。'
        : '左侧商品订单信息固定，右侧可以查看完整的 Ozon 商品页面。',
    },
  };
}

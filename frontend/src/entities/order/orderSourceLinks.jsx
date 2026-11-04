import {
  hydratePurchaseOrderLocalOverridesFromLocalFile,
  normalizeOzonSalesRowToPurchaseOrder,
  readPurchaseOrderLocalOverrides,
} from '../../services/purchaseOrderRuntime.js';
import {
  getProductMaterialSourceMeta,
  hydrateProductMaterialProfilesFromLocalFile,
  readProductMaterialProfiles,
} from '../../services/productMaterialProfileStore';
import { migrateLegacyProductSourceLinksAtStartup } from '../../services/productSourceLinkStore';
import { SOURCE_LINK_LIMIT } from '../../shared/config/appConfigCore.jsx';
import { getSalesOrderRawPosting } from './orderRawFields.jsx';
import { firstFiniteNumber } from '../product/productAttributes.jsx';
import { getProfitPurchaseOrderOverride } from '../profit/profitPurchaseOverrideRules.jsx';
import { firstFilled, firstUsableOzonId, normalizeOzonId } from './orderShopScope.jsx';
import { getPurchaseCrossBorderProducts } from './crossBorderPackageRules.jsx';
import {
  buildProductSourceStorageRecord,
  buildSourceEntryForLink,
  detectSourcePlatformFromLink,
  normalizeProductSourceEntry,
  normalizeProductSourceRecord,
  normalizeSalesSourceLinkValue,
  normalizeSavedSalesSourceEntry,
  normalizeSourcePlatformName,
} from './orderSourceRecordRules.jsx';
import {
  formatSourceLinkSummary,
  getSourcePlatformClassName,
  getSourceRecordSlots,
  getSourceSlotLabel,
} from './orderSourceDisplayRules.jsx';

export {
  formatSourceLinkSummary,
  getSourcePlatformClassName,
  getSourceRecordSlots,
  getSourceSlotLabel,
} from './orderSourceDisplayRules.jsx';

export {
  buildProductSourceStorageRecord,
  buildSourceEntryForLink,
  detectSourcePlatformFromLink,
  normalizeProductSourceEntry,
  normalizeProductSourceRecord,
  normalizeSalesSourceLinkValue,
  normalizeSavedSalesSourceEntry,
  normalizeSourcePlatformName,
} from './orderSourceRecordRules.jsx';

export {
  isCrossBorderArrayConversionError,
  normalizeCrossBorderOrderSearchBody,
  normalizeCrossBorderOrderSearchScalar,
  requestCrossBorderOrderSearchPages,
} from './crossBorderOrderApi.jsx';

export { getSalesOrderCrossBorderKeys } from './orderCrossBorderKeys.jsx';

export { getAfterSalesOrderRecordKey, getSalesOrderRecordKey } from './orderRecordRules.jsx';

export function getProductSourceProductKeys(product = {}, fallback = {}) {
  const raw = product.raw ?? {};
  return [
    product.offerId,
    product.offer_id,
    product.productNo,
    product.product_no,
    fallback.offerId,
    fallback.offer_id,
    fallback.productNo,
    fallback.product_no,
    raw.offer_id,
    raw.offerId,
    raw.seller_sku,
    raw.sellerSku,
    product.sellerSku,
    product.seller_sku,
    product.sku,
    fallback.sku,
    product.productId,
    product.product_id,
    raw.product_id,
    raw.productId,
    product.ozonSku,
    product.skuId,
    product.id,
    fallback.id,
  ]
    .map((value) => normalizeOzonId(value).trim())
    .filter((value, index, values) => value && value !== '-' && value !== '未返回' && values.indexOf(value) === index);
}

export function getProductSourceShopKeys(product = {}, shop = {}) {
  return [
    shop?.id,
    product.shopId,
    product.shop_id,
    shop?.clientId,
    product.shopClientId,
    product.clientId,
    product.shop,
    shop?.shopAlias,
    shop?.sellerName,
    'default',
  ]
    .map((value) => normalizeOzonId(value).trim())
    .filter((value, index, values) => value && value !== '-' && value !== '未返回' && values.indexOf(value) === index);
}

export function getProductSourceLinkKey(product = {}, shop = {}, fallback = {}) {
  const productKey = getProductSourceProductKeys(product, fallback)[0] || '';
  if (!productKey) return '';
  return [getProductSourceShopKeys(product, shop)[0] || 'default', productKey].join(':');
}

export function getProductSourceCandidateKeys(product = {}, shop = {}, fallback = {}) {
  const productKeys = getProductSourceProductKeys(product, fallback);
  if (!productKeys.length) return [];
  const shopKeys = getProductSourceShopKeys(product, shop);
  const keys = [];
  shopKeys.forEach((shopKey) => {
    productKeys.forEach((productKey) => keys.push([shopKey || 'default', productKey].join(':')));
  });
  productKeys.forEach((productKey) => keys.push(productKey));
  return keys.filter((key, index, values) => key && values.indexOf(key) === index);
}

export function getProductSourceRecordFromLinks(sourceLinks = {}, product = {}, shop = {}, fallback = {}) {
  const safeLinks = sourceLinks && typeof sourceLinks === 'object' ? sourceLinks : {};
  for (const key of getProductSourceCandidateKeys(product, shop, fallback)) {
    const record = normalizeProductSourceRecord(safeLinks[key]);
    if (record.links.length) return record;
  }
  const productRecord = normalizeProductSourceRecord(
    product?.sourceRecord ||
      product?.productSourceRecord || {
        links: Array.isArray(product?.sourceLinks) ? product.sourceLinks : [],
        primaryIndex: 0,
      }
  );
  if (productRecord.links.length) return productRecord;
  return normalizeProductSourceRecord({});
}

export async function hydrateProfitLocalInputs(shops = []) {
  const [purchaseLocalOverrides, productSourceLinks] = await Promise.all([
    hydratePurchaseOrderLocalOverridesFromLocalFile().catch(() => readPurchaseOrderLocalOverrides()),
    migrateLegacyProductSourceLinksAtStartup(shops).catch(() => ({})),
    hydrateProductMaterialProfilesFromLocalFile().catch(() => readProductMaterialProfiles()),
  ]);
  return { purchaseLocalOverrides, productSourceLinks };
}

export function createProfitSourceRecordFromEntry(
  entry = {},
  order = {},
  product = {},
  source = 'product-source-link'
) {
  const normalizedEntry = normalizeProductSourceEntry(entry);
  const priceValue = firstFiniteNumber(
    normalizedEntry.priceValue,
    normalizedEntry.price,
    entry.purchasePriceValue,
    entry.purchasePrice,
    entry.sourcePriceValue,
    entry.sourcePrice
  );
  if (priceValue === null || priceValue <= 0) return null;

  const orderKey = firstUsableOzonId(
    order.profitRecordKey,
    order.recordKey,
    order.id,
    order.salesOrder,
    order.shipmentNo,
    order.posting,
    order.postingNumber,
    order.ozonOrderId
  );
  const offerId = firstUsableOzonId(
    product.offerId,
    product.offer_id,
    product.productNo,
    product.sellerSku,
    product.seller_sku,
    product.sku,
    order.offerId,
    order.productNo,
    order.sku
  );
  const skuId = firstUsableOzonId(product.skuId, product.sku_id, product.ozonSku, product.raw?.sku, order.skuId);
  const productId = firstUsableOzonId(product.productId, product.product_id, product.raw?.product_id, product.id);

  return {
    ...normalizedEntry,
    source,
    recordKey: orderKey,
    id: orderKey,
    salesOrder: order.salesOrder,
    shipmentNo: order.shipmentNo,
    postingNumber: order.posting || order.postingNumber || order.id,
    ozonOrderId: order.ozonOrderId,
    offerId,
    productNo: offerId,
    sku: firstUsableOzonId(product.sku, product.offerId, order.sku, offerId),
    skuId,
    productId,
    purchasePrice: normalizedEntry.price || String(priceValue),
    purchasePriceValue: priceValue,
    sourcePrice: normalizedEntry.price || String(priceValue),
    sourcePriceValue: priceValue,
  };
}

export function createProfitSourceRecordsFromRecord(
  record = {},
  order = {},
  product = {},
  source = 'product-source-link'
) {
  return normalizeProductSourceRecord(record)
    .links.map((entry) => createProfitSourceRecordFromEntry(entry, order, product, source))
    .filter(Boolean);
}

export function getProfitManualSourceRecordForProduct(override = {}, product = {}, order = {}, shop = {}) {
  const sourceRecords =
    override?.manualSourceRecords && typeof override.manualSourceRecords === 'object'
      ? override.manualSourceRecords
      : {};
  const fallback = {
    productNo: order.productNo || order.offerId || order.sku,
    offerId: order.offerId || order.productNo || order.sku,
    sku: order.sku || order.offerId || order.productNo,
  };
  const candidateKeys = [
    getProductSourceLinkKey(product, shop, fallback),
    ...getProductSourceCandidateKeys(product, shop, fallback),
    ...getProductSourceProductKeys(product, fallback),
  ].filter((key, index, values) => key && values.indexOf(key) === index);

  for (const key of candidateKeys) {
    const record = normalizeProductSourceRecord(sourceRecords[key]);
    if (record.links.length) return record;
  }

  if (getPurchaseCrossBorderProducts(order).length <= 1) {
    const record = normalizeProductSourceRecord(override.manualSourceRecord);
    if (record.links.length) return record;
  }

  return normalizeProductSourceRecord({});
}

export function buildProfitSourceRecordsForOrder(order = {}, context = {}) {
  const productSourceLinks =
    context.productSourceLinks && typeof context.productSourceLinks === 'object' ? context.productSourceLinks : {};
  const normalizedOrder = normalizeOzonSalesRowToPurchaseOrder(order);
  const override = getProfitPurchaseOrderOverride(normalizedOrder, context.purchaseLocalOverrides);
  const orderWithOverride = { ...normalizedOrder, ...override };
  const shop = context.shop ?? {
    id: orderWithOverride.shopId || orderWithOverride.shopClientId || orderWithOverride.shop || 'default',
    clientId: orderWithOverride.shopClientId || '',
  };
  const products =
    Array.isArray(order.products) && order.products.length
      ? order.products
      : getPurchaseCrossBorderProducts(orderWithOverride);
  const records = [];

  products.forEach((product) => {
    const productWithShop = {
      ...product,
      shopId: product.shopId || orderWithOverride.shopId,
      shopClientId: product.shopClientId || orderWithOverride.shopClientId,
      shop: product.shop || orderWithOverride.shop,
    };
    records.push(
      ...createProfitSourceRecordsFromRecord(
        getProfitManualSourceRecordForProduct(override, productWithShop, orderWithOverride, shop),
        orderWithOverride,
        productWithShop,
        'purchase-override-source'
      )
    );
    records.push(
      ...createProfitSourceRecordsFromRecord(
        getProductSourceRecordFromLinks(productSourceLinks, productWithShop, shop, {
          productNo: orderWithOverride.productNo,
          offerId: orderWithOverride.offerId,
          sku: orderWithOverride.sku,
        }),
        orderWithOverride,
        productWithShop,
        'product-source-link'
      )
    );
  });

  const seen = new Set();
  return records.filter((record) => {
    const key = [
      record.offerId,
      record.skuId,
      record.productId,
      record.link,
      record.purchasePriceValue,
      record.source,
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getProductMaterialTagItems(product = {}) {
  const sourceMeta = getProductMaterialSourceMeta(product);
  return [{ label: sourceMeta.label, tone: sourceMeta.tone }];
}

export function ProductMaterialTags({ product }) {
  const tags = getProductMaterialTagItems(product);
  if (tags.length === 0) return null;
  return (
    <div className="product-material-tags">
      {tags.map((tag) => (
        <span key={tag.label} className={`product-material-chip material-chip-${tag.tone}`}>
          {tag.label}
        </span>
      ))}
    </div>
  );
}

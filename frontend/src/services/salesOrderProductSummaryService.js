import { getProductSummary, hydrateProductSummary } from '../api/localApiClient';

const PRODUCT_SUMMARY_PAGE_SIZE = 100;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0) return value;
    const text = normalizeText(value);
    if (text) return value;
  }
  return '';
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function chunkValues(values = [], size = PRODUCT_SUMMARY_PAGE_SIZE) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function getShopClientId(shop = {}) {
  return normalizeText(shop.clientId || shop.client_id);
}

function getShopId(shop = {}) {
  return normalizeText(shop.id || shop.shopId || shop.shop_id);
}

function getShopName(shop = {}) {
  return normalizeText(shop.shopAlias || shop.alias || shop.sellerName || shop.name || shop.shopName);
}

function getOrderShopId(order = {}, shops = []) {
  const orderShopId = normalizeText(order.shopId || order.shop_id);
  const orderClientId = normalizeText(order.shopClientId || order.clientId || order.client_id || order.sellerId);
  const orderShopName = normalizeText(order.shop || order.shopName || order.storeName);
  const matchedShop =
    shops.find((shop) => orderShopId && getShopId(shop) === orderShopId) ||
    shops.find((shop) => orderClientId && getShopClientId(shop) === orderClientId) ||
    shops.find((shop) => orderShopName && getShopName(shop) === orderShopName);
  if (matchedShop) return getShopId(matchedShop);
  if (orderShopId) return orderShopId;
  if (shops.length === 1) return getShopId(shops[0]);
  return 'all';
}

function getOrderRecordKey(order = {}, getRecordKey) {
  if (typeof getRecordKey === 'function') {
    const key = normalizeText(getRecordKey(order));
    if (key) return key;
  }
  return normalizeText(order.recordKey || order.id || order.posting || order.salesOrder || order.orderId);
}

function getProductIdentity(product = {}, order = {}) {
  const raw = product.raw && typeof product.raw === 'object' ? product.raw : {};
  const fields = product.fields && typeof product.fields === 'object' ? product.fields : {};
  const financialRaw = product.financialRaw && typeof product.financialRaw === 'object' ? product.financialRaw : {};
  return {
    productId: normalizeText(
      firstFilled(
        product.productId,
        product.product_id,
        product.id,
        fields.productId,
        fields.product_id,
        fields.id,
        raw.productId,
        raw.product_id,
        raw.id,
        financialRaw.productId,
        financialRaw.product_id,
        financialRaw.id,
        order.productId,
        order.product_id
      )
    ),
    offerId: normalizeText(
      firstFilled(
        product.offerId,
        product.offer_id,
        product.offer,
        fields.offerId,
        fields.offer_id,
        raw.offerId,
        raw.offer_id,
        financialRaw.offerId,
        financialRaw.offer_id,
        order.offerId,
        order.offer_id,
        order.productNo
      )
    ),
    sku: normalizeText(
      firstFilled(
        product.skuId,
        product.sku_id,
        product.ozonSku,
        product.sku,
        fields.skuId,
        fields.sku_id,
        fields.sku,
        raw.skuId,
        raw.sku_id,
        raw.sku,
        financialRaw.skuId,
        financialRaw.sku_id,
        financialRaw.sku,
        order.skuId,
        order.sku_id,
        order.sku
      )
    ),
  };
}

function createLookupKey(shopId, type, value) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  return `${normalizeText(shopId) || 'all'}:${type}:${normalized}`;
}

function indexSummaryRows(rows = []) {
  const index = new Map();
  rows.forEach((row) => {
    const shopId = normalizeText(row.shopId || row.shop_id || 'all');
    [
      ['product', row.productId || row.product_id],
      ['offer', row.offerId || row.offer_id],
      ['sku', row.sku],
    ].forEach(([type, value]) => {
      const key = createLookupKey(shopId, type, value);
      if (key) index.set(key, row);
    });
  });
  return index;
}

function findSummaryRow(index, ref) {
  const shopId = normalizeText(ref.shopId || 'all');
  const shopIds = shopId === 'all' ? ['all'] : [shopId];
  const candidates = [
    ['product', ref.productId],
    ['offer', ref.offerId],
    ['sku', ref.sku],
  ];
  for (const shopId of shopIds) {
    for (const [type, value] of candidates) {
      const row = index.get(createLookupKey(shopId, type, value));
      if (row) return row;
    }
  }
  return null;
}

function summaryRowHasImage(row = {}) {
  return normalizeImages(row).length > 0;
}

function shouldHydrateRef(ref, index, options = {}) {
  const row = findSummaryRow(index, ref);
  if (!row) return true;
  return options.requireImages === true && !summaryRowHasImage(row);
}

async function hydrateMissingSummaryRows(refs = [], options = {}) {
  if (!options.hydrateMissing || !refs.length) return [];
  const groups = new Map();
  refs.forEach((ref) => {
    const shopId = normalizeText(ref.shopId);
    if (!shopId || ['all', '*'].includes(shopId.toLowerCase())) return;
    if (!groups.has(shopId)) groups.set(shopId, []);
    groups.get(shopId).push(ref);
  });
  const rowsByShop = await Promise.all([...groups.entries()].map(async ([shopId, groupRefs]) => {
    const compactRefs = [];
    const seen = new Set();
    groupRefs.forEach((ref) => {
      const compact = {
        productId: normalizeText(ref.productId),
        offerId: normalizeText(ref.offerId),
        sku: normalizeText(ref.sku),
      };
      const key = `${compact.productId}\u0000${compact.offerId}\u0000${compact.sku}`;
      if (!seen.has(key)) {
        seen.add(key);
        compactRefs.push(compact);
      }
    });
    try {
      const payload = await hydrateProductSummary(
        {
          shopId,
          refs: compactRefs,
          requireImages: options.requireImages === true,
          requestedBy: options.requestedBy || 'sales-order-product-cache-miss',
        },
        { timeoutMs: options.hydrateTimeoutMs || 30000, signal: options.signal }
      );
      return Array.isArray(payload?.rows) ? payload.rows : [];
    } catch {
      // 远端精准补查失败只保留当前 SQLite 结果，不能拖垮销售订单首屏。
      return [];
    }
  }));
  return rowsByShop.flat();
}

function normalizeImages(row = {}) {
  const images = Array.isArray(row.images) ? row.images.map(normalizeText).filter(Boolean) : [];
  const primaryImage = normalizeText(row.primaryImageUrl || row.primary_image || images[0]);
  return uniqueValues([primaryImage, ...images]);
}

function normalizeSourceRecord(row = {}) {
  const sourceLinks = Array.isArray(row.sourceLinks) ? row.sourceLinks.filter(Boolean) : [];
  const record = row.sourceRecord && typeof row.sourceRecord === 'object' ? row.sourceRecord : {};
  const recordLinks = Array.isArray(record.links) ? record.links.filter(Boolean) : [];
  const links = recordLinks.length ? recordLinks : sourceLinks;
  return links.length
    ? {
        links,
        primaryIndex: Math.max(0, Number(record.primaryIndex) || 0),
      }
    : null;
}

export function toOrderProductSummaryEntity(row = {}) {
  const images = normalizeImages(row);
  const primaryImage = images[0] || '';
  const sourceRecord = normalizeSourceRecord(row);
  return {
    productKey: row.productKey || row.product_key || '',
    productId: row.productId || row.product_id || '',
    product_id: row.productId || row.product_id || '',
    offerId: row.offerId || row.offer_id || '',
    offer_id: row.offerId || row.offer_id || '',
    sku: row.sku || '',
    name: row.name || '',
    title: row.name || '',
    image: primaryImage,
    images,
    mainImage: primaryImage,
    mainImages: images,
    productMainImage: primaryImage,
    productMainImages: images,
    primaryImage,
    primary_image: primaryImage,
    commissionPercent: row.commissionPercent,
    commissionPercents:
      row.commissionPercents && typeof row.commissionPercents === 'object' ? { ...row.commissionPercents } : {},
    acquiringFeeValue: row.acquiringFeeValue,
    acquiringUnitValue: row.acquiringFeeValue,
    acquiring: row.acquiringFeeValue,
    currencyCode: row.currencyCode || 'CNY',
    weightKg: row.weightKg,
    widthCm: row.widthCm,
    heightCm: row.heightCm,
    depthCm: row.depthCm,
    categoryId: row.categoryId,
    categoryName: row.softwareCategoryPath || row.softwareCategoryName || row.categoryName,
    materialProfile: row.materialProfile || null,
    materialProfiles: Array.isArray(row.materialProfiles) ? row.materialProfiles : [],
    materialCandidates: Array.isArray(row.materialCandidates) ? row.materialCandidates : [],
    materialSource: row.materialSource || row.materialProfile?.source || '',
    sourceLinks: Array.isArray(row.sourceLinks) ? row.sourceLinks : sourceRecord?.links || [],
    sourceRecord,
    productSourceRecord: sourceRecord,
    imageHealth: Array.isArray(row.imageHealth) ? row.imageHealth : [],
    source: 'local-api-products-summary',
    summaryUpdatedAt: row.updatedAt,
    hydratedAt: row.hydratedAt,
  };
}

async function fetchSummaryRowsForGroup(shopId, group = {}, options = {}) {
  const rows = [];
  const commonQuery = {
    shopId,
    scope: 'software_all',
    sort: 'stable',
    pageSize: PRODUCT_SUMMARY_PAGE_SIZE,
  };

  for (const offerIds of chunkValues(group.offerIds || [])) {
    const payload = await getProductSummary(
      { ...commonQuery, offerIds: offerIds.join(',') },
      { timeoutMs: options.timeoutMs, signal: options.signal }
    );
    rows.push(...(Array.isArray(payload?.rows) ? payload.rows : []));
  }

  for (const productIds of chunkValues(group.productIds || [])) {
    const payload = await getProductSummary(
      { ...commonQuery, productIds: productIds.join(',') },
      { timeoutMs: options.timeoutMs, signal: options.signal }
    );
    rows.push(...(Array.isArray(payload?.rows) ? payload.rows : []));
  }

  return rows;
}

async function fetchSummaryRowsBySkuFallback(refs = [], options = {}) {
  if (!options.enableSkuFallback) return [];
  const rows = [];
  const fetchedKeys = new Set();
  const commonOptions = { timeoutMs: options.timeoutMs, signal: options.signal };
  for (const ref of refs) {
    const sku = normalizeText(ref.sku);
    if (!sku) continue;
    const shopId = normalizeText(ref.shopId || 'all');
    const fetchKey = `${shopId}:${sku}`;
    if (fetchedKeys.has(fetchKey)) continue;
    fetchedKeys.add(fetchKey);
    try {
      const payload = await getProductSummary(
        {
          shopId,
          scope: 'software_all',
          sort: 'stable',
          pageSize: PRODUCT_SUMMARY_PAGE_SIZE,
          keyword: sku,
        },
        commonOptions
      );
      rows.push(
        ...(Array.isArray(payload?.rows) ? payload.rows : []).filter((row) =>
          uniqueValues([row.sku, row.offerId, row.offer_id, row.productId, row.product_id]).includes(sku)
        )
      );
    } catch {
      // SKU 兜底只服务利润页补材积，失败时不能阻断订单秒开和主摘要读取。
    }
  }
  return rows;
}

export async function readSalesOrderProductSummaryEntities(rows = [], shops = [], options = {}) {
  const getRecordKey = options.getRecordKey;
  const refs = [];
  const expectedLookupKeys = new Set();
  const groups = new Map();

  rows.forEach((order) => {
    const orderKey = getOrderRecordKey(order, getRecordKey);
    if (!orderKey) return;
    const shopId = getOrderShopId(order, shops);
    const products = Array.isArray(order.products) ? order.products : [];
    products.forEach((product, productIndex) => {
      const lookupKey = `${orderKey}:${productIndex}`;
      expectedLookupKeys.add(lookupKey);
      const identity = getProductIdentity(product, order);
      if (!identity.productId && !identity.offerId && !identity.sku) return;
      refs.push({ ...identity, shopId, lookupKey, orderKey });
      if (!groups.has(shopId)) groups.set(shopId, { productIds: new Set(), offerIds: new Set() });
      const group = groups.get(shopId);
      if (identity.offerId) group.offerIds.add(identity.offerId);
      if (identity.productId) group.productIds.add(identity.productId);
    });
  });

  if (!refs.length) {
    return {
      source: 'local-api-products-summary',
      entityMap: new Map(),
      matchedOrderKeys: new Set(),
      expectedLookupKeys,
      missingLookupKeys: new Set(expectedLookupKeys),
      fetchedRows: [],
    };
  }

  const fetchedRows = (await Promise.all([...groups.entries()].map(async ([shopId, group]) => {
    try {
      return await fetchSummaryRowsForGroup(
        shopId,
        {
          offerIds: [...group.offerIds],
          productIds: [...group.productIds],
        },
        options
      );
    } catch {
      return [];
    }
  }))).flat();

  let summaryIndex = indexSummaryRows(fetchedRows);
  let missingRefs = refs.filter((ref) => !findSummaryRow(summaryIndex, ref));
  if (missingRefs.length && options.enableSkuFallback) {
    const skuFallbackRows = await fetchSummaryRowsBySkuFallback(missingRefs, options);
    if (skuFallbackRows.length) {
      fetchedRows.push(...skuFallbackRows);
      summaryIndex = indexSummaryRows(fetchedRows);
    }
  }
  missingRefs = refs.filter((ref) => shouldHydrateRef(ref, summaryIndex, options));
  if (missingRefs.length && options.hydrateMissing) {
    const hydratedRows = await hydrateMissingSummaryRows(missingRefs, options);
    if (hydratedRows.length) {
      fetchedRows.push(...hydratedRows);
      summaryIndex = indexSummaryRows(fetchedRows);
    }
  }
  const entityMap = new Map();
  const matchedOrderKeys = new Set();

  refs.forEach((ref) => {
    const row = findSummaryRow(summaryIndex, ref);
    if (!row) return;
    entityMap.set(ref.lookupKey, toOrderProductSummaryEntity(row));
    matchedOrderKeys.add(ref.orderKey);
  });

  return {
    source: 'local-api-products-summary',
    entityMap,
    matchedOrderKeys,
    expectedLookupKeys,
    missingLookupKeys: new Set([...expectedLookupKeys].filter((key) => !entityMap.has(key))),
    fetchedRows,
  };
}

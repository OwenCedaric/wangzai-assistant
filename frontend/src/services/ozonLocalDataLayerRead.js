import { normalizeAfterSalesCachedClassificationFields } from './ozonAfterSalesCacheMergePolicy.js';
import { mergeFieldValues } from './ozonLocalDataLayerFieldMerge.js';
import {
  getAfterSalesOrderKeyCandidates,
  getProductIdentityCandidates,
  getProductQualityScore,
  getProductShopKeyCandidates,
  isAfterSalesSnapshot,
  scopedProductKey,
} from './ozonLocalDataLayerIdentity.js';
import {
  findCompatibleSnapshotRecord,
  getOzonLocalSnapshotHealth,
  normalizeOzonLocalDataStore,
  sortByLastSeenDesc,
} from './ozonLocalDataLayerStore.js';
import {
  MAX_REFRESH_LOGS,
  cloneJsonSafe,
  isPlainObject,
  mergeEffectiveObjectValue,
  normalizeArray,
  normalizeText,
  nowIso,
  uniqueImageUrls,
  uniqueValues,
} from './ozonLocalDataLayerShared.js';

export function hydrateProduct(store, orderProductKey) {
  const orderProduct = store.orderProducts[orderProductKey];
  if (!orderProduct) return null;
  const product = store.products[orderProduct.productKey] || {};
  const imageUrls = uniqueImageUrls(product.imageUrls);
  const skuImageUrls = uniqueImageUrls(product.skuImageUrls);
  const mainImageUrls = uniqueImageUrls(product.mainImageUrls);
  const fields = mergeEffectiveObjectValue(product.fields || {}, orderProduct.fields || {});
  return {
    ...fields,
    image: imageUrls[0] || '',
    images: imageUrls,
    skuImage: skuImageUrls[0] || '',
    skuImages: skuImageUrls,
    mainImage: mainImageUrls[0] || '',
    mainImages: mainImageUrls,
    productMainImage: mainImageUrls[0] || '',
    productMainImages: mainImageUrls,
  };
}

export function dedupeHydratedAfterSalesProducts(products = []) {
  const deduped = [];
  const indexByProductKey = new Map();

  products.forEach((item) => {
    if (!item?.productKey) {
      deduped.push(item);
      return;
    }

    const currentIndex = indexByProductKey.get(item.productKey);
    if (currentIndex === undefined) {
      indexByProductKey.set(item.productKey, deduped.length);
      deduped.push(item);
      return;
    }

    const current = deduped[currentIndex];
    if (getProductQualityScore(item) > getProductQualityScore(current)) {
      deduped[currentIndex] = item;
    }
  });

  return deduped.map(omitHydratedProductKey);
}

export function omitHydratedProductKey(item = {}) {
  const product = { ...item };
  delete product.productKey;
  return product;
}

export function hydrateStandaloneProduct(store, productKey) {
  const product = store.products[productKey];
  if (!product) return null;
  const imageUrls = uniqueImageUrls(product.imageUrls);
  const skuImageUrls = uniqueImageUrls(product.skuImageUrls);
  const mainImageUrls = uniqueImageUrls(product.mainImageUrls);
  return {
    ...(product.fields || {}),
    image: imageUrls[0] || '',
    images: imageUrls,
    skuImage: skuImageUrls[0] || '',
    skuImages: skuImageUrls,
    mainImage: mainImageUrls[0] || '',
    mainImages: mainImageUrls,
    productMainImage: mainImageUrls[0] || '',
    productMainImages: mainImageUrls,
  };
}

export function hydrateStandaloneProductWithLocalMeta(store, productKey) {
  const productRecord = store.products[productKey];
  const hydrated = hydrateStandaloneProduct(store, productKey);
  if (!hydrated || !productRecord) return null;
  return {
    ...hydrated,
    localProductKey: productRecord.key || productKey,
    localShopKey: productRecord.shopKey || '',
    localUpdatedAt: productRecord.updatedAt || '',
    localLastSeenAt: productRecord.lastSeenAt || '',
    localFieldMeta: productRecord.fieldMeta || {},
  };
}

export function hydrateProductSnapshotRow(store, productKey, snapshot = {}) {
  const hydrated = hydrateStandaloneProductWithLocalMeta(store, productKey);
  if (!hydrated) return null;
  const rowFields =
    snapshot?.rowFieldsByProductKey && isPlainObject(snapshot.rowFieldsByProductKey[productKey])
      ? snapshot.rowFieldsByProductKey[productKey]
      : {};
  return {
    ...hydrated,
    ...cloneJsonSafe(rowFields),
    image: hydrated.image,
    images: hydrated.images,
    skuImage: hydrated.skuImage,
    skuImages: hydrated.skuImages,
    mainImage: hydrated.mainImage,
    mainImages: hydrated.mainImages,
    productMainImage: hydrated.productMainImage,
    productMainImages: hydrated.productMainImages,
    localProductKey: hydrated.localProductKey,
    localShopKey: hydrated.localShopKey,
    localUpdatedAt: hydrated.localUpdatedAt,
    localLastSeenAt: hydrated.localLastSeenAt,
    localFieldMeta: hydrated.localFieldMeta,
  };
}

export function getStoredProductIdentityValues(record = {}) {
  return uniqueValues([
    record.offerId,
    record.sku,
    record.productId,
    record.fields?.offerId,
    record.fields?.offer_id,
    record.fields?.sku,
    record.fields?.skuId,
    record.fields?.sku_id,
    record.fields?.ozonSku,
    record.fields?.productId,
    record.fields?.product_id,
    record.fields?.id,
  ]);
}

export function findProductKeyByEntityFields(store, identityCandidates = [], shopKeys = []) {
  if (!identityCandidates.length || !shopKeys.length) return '';
  const identitySet = new Set(identityCandidates.map(normalizeText).filter(Boolean));
  const shopKeySet = new Set(shopKeys.map(normalizeText).filter(Boolean));
  return (
    Object.values(store.products).find((record) => {
      if (!record?.key || !shopKeySet.has(normalizeText(record.shopKey))) return false;
      return getStoredProductIdentityValues(record).some((value) => identitySet.has(value));
    })?.key || ''
  );
}

export function readOzonProductEntitiesFromLocalStore(store = {}, products = [], options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const rows = normalizeArray(products);

  return rows
    .map((product, index) => {
      if (!isPlainObject(product)) return null;
      const row = isPlainObject(options.row) ? options.row : product;
      const identityCandidates = getProductIdentityCandidates(product, row, index, { includeFallback: false });
      const shopKeys = getProductShopKeyCandidates(product, row, options);
      const directProductKeys = identityCandidates.filter((candidate) => normalizedStore.products[candidate]);
      const scopedProductKeys = shopKeys.flatMap((shopKey) =>
        identityCandidates.map((identity) => scopedProductKey(shopKey, identity))
      );
      const productKey =
        uniqueValues([...directProductKeys, ...scopedProductKeys]).find((key) => normalizedStore.products[key]) ||
        findProductKeyByEntityFields(normalizedStore, identityCandidates, shopKeys);
      if (!productKey) return null;

      return hydrateStandaloneProductWithLocalMeta(normalizedStore, productKey);
    })
    .filter(Boolean);
}

export function readOzonProductRowsFromLocalStore(store = {}, options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const shopKeySet = new Set(normalizeArray(options.shopKeys).map(normalizeText).filter(Boolean));
  const limit = Number(options.limit);
  const rows = sortByLastSeenDesc(
    Object.values(normalizedStore.products).filter((record) => {
      if (!record?.key) return false;
      if (shopKeySet.size > 0 && !shopKeySet.has(normalizeText(record.shopKey))) return false;
      return true;
    })
  )
    .map((record) => hydrateStandaloneProductWithLocalMeta(normalizedStore, record.key))
    .filter(Boolean);

  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}

export function searchOzonProductEntitiesFromLocalStore(store = {}, keyword = '', options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const query = normalizeText(keyword).toLowerCase();
  if (!query) return [];

  const shopKeySet = new Set(normalizeArray(options.shopKeys).map(normalizeText).filter(Boolean));
  const limit = Math.max(1, Number(options.limit) || 20);
  const matches = [];

  for (const record of Object.values(normalizedStore.products)) {
    if (!record?.key) continue;
    if (shopKeySet.size > 0 && !shopKeySet.has(normalizeText(record.shopKey))) continue;

    const searchText = uniqueValues([
      record.key,
      record.offerId,
      record.sku,
      record.productId,
      record.name,
      record.fields?.offerId,
      record.fields?.offer_id,
      record.fields?.sku,
      record.fields?.skuId,
      record.fields?.sku_id,
      record.fields?.ozonSku,
      record.fields?.productId,
      record.fields?.product_id,
      record.fields?.id,
      record.fields?.name,
      record.fields?.title,
      record.fields?.product,
    ])
      .join(' ')
      .toLowerCase();
    if (!searchText.includes(query)) continue;

    const hydrated = hydrateStandaloneProductWithLocalMeta(normalizedStore, record.key);
    if (!hydrated) continue;
    matches.push(hydrated);
    if (matches.length >= limit) break;
  }

  return matches;
}

export function mergeAfterSalesSnapshotRowsForRead(rows = []) {
  const mergedByKey = new Map();
  const canonicalKeyByCandidate = new Map();
  const outputKeys = [];

  normalizeArray(rows).forEach((row) => {
    const candidates = getAfterSalesOrderKeyCandidates(row, { snapshotKey: 'ozon-after-sales:read' });
    const key =
      candidates.map((candidate) => canonicalKeyByCandidate.get(candidate)).find(Boolean) || candidates[0] || '';
    if (!key) return;
    if (!mergedByKey.has(key)) outputKeys.push(key);
    candidates.forEach((candidate) => canonicalKeyByCandidate.set(candidate, key));

    const current = mergedByKey.get(key);
    if (!current) {
      mergedByKey.set(key, row);
      return;
    }

    const merged = mergeFieldValues(current, {}, row, nowIso(), { snapshotKey: 'ozon-after-sales:read' }).fields;
    const products = dedupeHydratedAfterSalesProducts([
      ...normalizeArray(current.products),
      ...normalizeArray(row.products),
    ]);
    mergedByKey.set(key, {
      ...merged,
      products,
    });
  });

  return outputKeys.map((key) => mergedByKey.get(key)).filter(Boolean);
}

export function readOzonSnapshotFromLocalStore(store = {}, snapshotKey = '') {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const afterSalesRead = isAfterSalesSnapshot(snapshotKey);
  let {
    key: matchedSnapshotKey,
    snapshot,
    migrated,
  } = findCompatibleSnapshotRecord(
    normalizedStore.snapshots,
    snapshotKey,
    (item) => Array.isArray(item?.rowKeys) && (!afterSalesRead || item.rowKeys.length > 0)
  );
  if (!snapshot && afterSalesRead) {
    ({
      key: matchedSnapshotKey,
      snapshot,
      migrated,
    } = findCompatibleSnapshotRecord(normalizedStore.snapshots, snapshotKey, (item) => Array.isArray(item?.rowKeys)));
  }
  if (!snapshot || !Array.isArray(snapshot.rowKeys)) return null;
  const shouldDedupeProducts = afterSalesRead;

  const rows = snapshot.rowKeys
    .map((orderKey) => {
      const order = normalizedStore.orders[orderKey];
      if (!order) return null;
      const products = normalizeArray(order.orderProductKeys)
        .map((key) => {
          const hydrated = hydrateProduct(normalizedStore, key);
          const orderProduct = normalizedStore.orderProducts[key];
          return hydrated ? { ...hydrated, productKey: orderProduct?.productKey || '' } : null;
        })
        .filter(Boolean);
      const fields = shouldDedupeProducts
        ? normalizeAfterSalesCachedClassificationFields(order.fields || {}).fields
        : order.fields || {};
      return {
        ...fields,
        products: shouldDedupeProducts
          ? dedupeHydratedAfterSalesProducts(products)
          : products.map(omitHydratedProductKey),
      };
    })
    .filter(Boolean);
  const outputRows = shouldDedupeProducts ? mergeAfterSalesSnapshotRowsForRead(rows) : rows;

  return {
    rows: outputRows,
    errors: normalizeArray(snapshot.errors),
    failureKeys: normalizeArray(snapshot.failureKeys),
    changeSummary: snapshot.changeSummary || null,
    cacheHealth: getOzonLocalSnapshotHealth(snapshot),
    crossBorder: snapshot.crossBorder || {},
    shops: snapshot.shops || [],
    classificationEvidence: snapshot.classificationEvidence || {},
    ruleVersion: snapshot.ruleVersion || '',
    cacheVersion: snapshot.cacheVersion || '',
    fetchedAt: snapshot.fetchedAt,
    localUpdatedAt: snapshot.updatedAt,
    localSnapshotKey: matchedSnapshotKey || snapshot.key || '',
    legacyCompatibleRead: Boolean(migrated),
    source: 'local-data-layer',
  };
}

export function readOzonProductSnapshotFromLocalStore(store = {}, snapshotKey = '') {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const {
    key: matchedSnapshotKey,
    snapshot,
    migrated,
  } = findCompatibleSnapshotRecord(normalizedStore.snapshots, snapshotKey, (item) => Array.isArray(item?.productKeys));
  if (!snapshot || !Array.isArray(snapshot.productKeys)) return null;

  const rows = snapshot.productKeys
    .map((productKey) => hydrateProductSnapshotRow(normalizedStore, productKey, snapshot))
    .filter(Boolean);

  return {
    rows,
    errors: normalizeArray(snapshot.errors),
    failureKeys: normalizeArray(snapshot.failureKeys),
    changeSummary: snapshot.changeSummary || null,
    cacheHealth: getOzonLocalSnapshotHealth(snapshot),
    total: Number.isFinite(Number(snapshot.total)) ? Number(snapshot.total) : rows.length,
    page: snapshot.page || '',
    pageSize: snapshot.pageSize || '',
    statusCounts: snapshot.statusCounts || {},
    fetchedAt: snapshot.fetchedAt,
    localUpdatedAt: snapshot.updatedAt,
    localSnapshotKey: matchedSnapshotKey || snapshot.key || '',
    legacyCompatibleRead: Boolean(migrated),
    source: 'local-data-layer',
  };
}

export function readDomainSnapshotFromLocalStore(store = {}, snapshotKey = '') {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const {
    key: matchedSnapshotKey,
    snapshot,
    migrated,
  } = findCompatibleSnapshotRecord(normalizedStore.domainSnapshots, snapshotKey, (item) =>
    isPlainObject(item?.payload)
  );
  if (!snapshot || !isPlainObject(snapshot.payload)) return null;

  return {
    ...cloneJsonSafe(snapshot.payload),
    errors: normalizeArray(snapshot.errors),
    failureKeys: normalizeArray(snapshot.failureKeys),
    changeSummary: snapshot.changeSummary || null,
    cacheHealth: getOzonLocalSnapshotHealth(snapshot),
    fetchedAt: snapshot.fetchedAt,
    localUpdatedAt: snapshot.updatedAt,
    localSnapshotKey: matchedSnapshotKey || snapshot.key || '',
    legacyCompatibleRead: Boolean(migrated),
    source: 'local-data-layer',
  };
}

export function readOzonRetryQueueFromLocalStore(store = {}, options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const snapshotKey = normalizeText(options.snapshotKey);
  const dueOnly = options.dueOnly === true;
  const nowMs = Date.parse(normalizeText(options.now || '')) || Date.now();
  return Object.values(normalizedStore.failures)
    .filter((failure) => !snapshotKey || failure.snapshotKey === snapshotKey)
    .filter((failure) => {
      if (!dueOnly) return true;
      if (failure.retryStatus === 'paused') return false;
      const nextRetryMs = Date.parse(normalizeText(failure.nextRetryAt || ''));
      return !Number.isFinite(nextRetryMs) || nextRetryMs <= nowMs;
    })
    .sort((left, right) => normalizeText(left.nextRetryAt).localeCompare(normalizeText(right.nextRetryAt)));
}

export function readOzonRefreshLogsFromLocalStore(store = {}, options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const snapshotKey = normalizeText(options.snapshotKey);
  const limit = Math.max(1, Number(options.limit) || MAX_REFRESH_LOGS);
  return normalizeArray(normalizedStore.logs)
    .filter((log) => !snapshotKey || log?.snapshotKey === snapshotKey)
    .slice(0, Math.min(limit, MAX_REFRESH_LOGS));
}

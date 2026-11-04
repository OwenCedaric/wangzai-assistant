import { normalizeAfterSalesCachedClassificationFields } from './ozonAfterSalesCacheMergePolicy.js';
import { mergeFieldValues } from './ozonLocalDataLayerFieldMerge.js';
import {
  collectProductImages,
  collectProductMainImages,
  collectProductSkuImages,
  dedupeAfterSalesProductsForOrder,
  getClientId,
  getOrderKey,
  getProductIdentity,
  getShopId,
  getShopKey,
  getStoreName,
  isAfterSalesSnapshot,
} from './ozonLocalDataLayerIdentity.js';
import {
  appendRefreshLog,
  collectRecordSignatures,
  countRecordSignatureChanges,
  countSignatureMapChanges,
  createSnapshotChangeSummary,
  markOrderSnapshotRowsNotSeen,
  markProductSnapshotRowsNotSeen,
  normalizeOzonLocalDataStore,
  pruneAfterSalesSnapshotVariants,
  pruneStore,
  pruneSupersededProductPageSnapshots,
  sanitizeLogText,
  toErrorRecords,
  upsertSnapshotFailures,
} from './ozonLocalDataLayerStore.js';
import {
  OMIT_ORDER_FIELDS,
  OMIT_PRODUCT_FIELDS,
  OZON_LOCAL_DATA_LAYER_VERSION,
  SNAPSHOT_TYPE_DOMAIN,
  SNAPSHOT_TYPE_ORDER,
  SNAPSHOT_TYPE_PRODUCT,
  cloneJsonSafe,
  compactFieldMetaMap,
  compactObject,
  compactProductSnapshotRowFields,
  createRecordSignature,
  createSignature,
  firstFilled,
  hasEffectiveFieldValue,
  isPlainObject,
  keepCurrentUnlessFresh,
  normalizeArray,
  normalizeText,
  nowIso,
  omitProductImagePayloadFields,
  scopeProductSnapshotRow,
  uniqueImageUrls,
  uniqueValues,
} from './ozonLocalDataLayerShared.js';

export function createEntityMetadata(domain, entityId, row = {}, options = {}) {
  return {
    domain,
    shopId: getShopId(row, options),
    clientId: getClientId(row, options),
    storeName: getStoreName(row, options),
    entityId: normalizeText(entityId),
    baseId: normalizeText(options.baseId || ''),
    source: normalizeText(options.source || row.source || 'ozon'),
    version: OZON_LOCAL_DATA_LAYER_VERSION,
  };
}

export function upsertImage(store, url, timestamp, row = {}, options = {}) {
  if (!url) return;
  const current = store.images[url];
  const rawHash = createSignature({ url });
  store.images[url] = {
    ...createEntityMetadata('04_product_images', url, row, {
      ...options,
      baseId: options.baseId || row.productId || row.product_id || row.offerId || row.offer_id || '',
      source: options.source || 'ozon-image-url',
    }),
    url,
    rawHash,
    firstSeenAt: current?.firstSeenAt || timestamp,
    updatedAt: current?.rawHash === rawHash ? current.updatedAt || current.firstSeenAt || timestamp : timestamp,
    lastSeenAt: timestamp,
  };
}

export function mergeProduct(store, product = {}, row = {}, index = 0, timestamp, options = {}) {
  const productKey = getProductIdentity(product, row, index);
  const imageUrls = collectProductImages(product);
  const skuImageUrls = collectProductSkuImages(product);
  const mainImageUrls = collectProductMainImages(product);
  const current = store.products[productKey];
  const resolvedImageUrls = imageUrls.length ? imageUrls : uniqueImageUrls(current?.imageUrls);
  const resolvedSkuImageUrls = skuImageUrls.length ? skuImageUrls : uniqueImageUrls(current?.skuImageUrls);
  const resolvedMainImageUrls = mainImageUrls.length ? mainImageUrls : uniqueImageUrls(current?.mainImageUrls);
  [...resolvedImageUrls, ...resolvedSkuImageUrls, ...resolvedMainImageUrls].forEach((url) =>
    upsertImage(store, url, timestamp, { ...row, ...product }, options)
  );

  const fields = omitProductImagePayloadFields(compactObject(product, OMIT_PRODUCT_FIELDS));
  const currentFields = omitProductImagePayloadFields(current?.fields);
  const currentFieldMeta = omitProductImagePayloadFields(current?.fieldMeta);
  const merged = mergeFieldValues(currentFields, currentFieldMeta, fields, timestamp, options);
  const record = {
    ...createEntityMetadata(
      '03_products',
      productKey,
      { ...row, ...product },
      {
        ...options,
        baseId:
          product.offerId ||
          product.offer_id ||
          row.productNo ||
          row.offerId ||
          product.productId ||
          product.product_id,
      }
    ),
    key: productKey,
    shopKey: keepCurrentUnlessFresh(current?.shopKey, getShopKey(row)),
    offerId: keepCurrentUnlessFresh(current?.offerId, product.offerId, product.offer_id, row.productNo, row.offerId),
    sku: keepCurrentUnlessFresh(current?.sku, product.sku, product.skuId, row.sku),
    productId: keepCurrentUnlessFresh(current?.productId, product.productId, product.product_id, product.id),
    name: keepCurrentUnlessFresh(current?.name, product.name, product.title, row.product),
    fields: merged.fields,
    imageUrls: resolvedImageUrls,
    skuImageUrls: resolvedSkuImageUrls,
    mainImageUrls: resolvedMainImageUrls,
  };
  const fieldMeta = compactFieldMetaMap(merged.fieldMeta);
  const signature = createRecordSignature(record);
  store.products[productKey] = {
    ...record,
    fieldMeta,
    signature,
    rawHash: signature,
    firstSeenAt: current?.firstSeenAt || timestamp,
    updatedAt: current?.signature === signature ? current.updatedAt : timestamp,
    lastSeenAt: timestamp,
  };
  return productKey;
}

export function mergeOrderProduct(
  store,
  orderKey,
  productKey,
  product = {},
  row = {},
  index = 0,
  timestamp,
  options = {}
) {
  const orderProductKey = `${orderKey}:${index}:${productKey}`;
  const fields = omitProductImagePayloadFields(compactObject(product, OMIT_PRODUCT_FIELDS));
  const current = store.orderProducts[orderProductKey];
  const merged = mergeFieldValues(
    omitProductImagePayloadFields(current?.fields),
    omitProductImagePayloadFields(current?.fieldMeta),
    fields,
    timestamp,
    options
  );
  const record = {
    ...createEntityMetadata(
      '06_order_items',
      orderProductKey,
      { ...row, ...product },
      {
        ...options,
        baseId: orderKey,
      }
    ),
    key: orderProductKey,
    orderKey,
    productKey,
    index,
    fields: merged.fields,
  };
  const signature = createRecordSignature(record);
  store.orderProducts[orderProductKey] = {
    ...record,
    signature,
    rawHash: signature,
    firstSeenAt: current?.firstSeenAt || timestamp,
    updatedAt: current?.signature === signature ? current.updatedAt : timestamp,
    lastSeenAt: timestamp,
  };
  return orderProductKey;
}

export function mergeOrder(store, row = {}, timestamp, options = {}) {
  const orderKey = getOrderKey(row, options);
  if (!orderKey) return '';

  const sourceProducts = Array.isArray(row.products) ? row.products : [];
  const products = isAfterSalesSnapshot(options)
    ? dedupeAfterSalesProductsForOrder(row, sourceProducts)
    : sourceProducts;
  const orderProductKeys = products.map((product, index) => {
    const productKey = mergeProduct(store, product, row, index, timestamp, options);
    return mergeOrderProduct(store, orderKey, productKey, product, row, index, timestamp, options);
  });
  const compactedFields = compactObject(row, OMIT_ORDER_FIELDS);
  const fields = isAfterSalesSnapshot(options)
    ? normalizeAfterSalesCachedClassificationFields(compactedFields).fields
    : compactedFields;
  const current = store.orders[orderKey];
  const merged = mergeFieldValues(current?.fields, current?.fieldMeta, fields, timestamp, options);
  const record = {
    ...createEntityMetadata(isAfterSalesSnapshot(options) ? '09_after_sales' : '05_sales_orders', orderKey, row, {
      ...options,
      baseId: row.baseId || row.posting || row.postingNumber || row.posting_number || row.orderNumber || row.orderId,
    }),
    key: orderKey,
    shopKey: keepCurrentUnlessFresh(current?.shopKey, getShopKey(row)),
    fields: merged.fields,
    orderProductKeys,
  };
  const signature = createRecordSignature(record);
  store.orders[orderKey] = {
    ...record,
    signature,
    rawHash: signature,
    firstSeenAt: current?.firstSeenAt || timestamp,
    updatedAt: current?.signature === signature ? current.updatedAt : timestamp,
    lastSeenAt: timestamp,
  };
  return orderKey;
}

export function mergeOzonSnapshotIntoLocalStore(store = {}, snapshotKey = '', snapshot = {}, options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const key = normalizeText(snapshotKey);
  if (!key) return { store: normalizedStore, stats: { changed: false, rows: 0 } };

  const timestamp = options.now || nowIso();
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const errors = toErrorRecords(snapshot?.errors);
  const afterSalesSnapshot = isAfterSalesSnapshot(key);
  const existingSnapshot = normalizedStore.snapshots[key];
  const existingRowKeys = normalizeArray(existingSnapshot?.rowKeys);
  const previousOrderSignatures = collectRecordSignatures(normalizedStore.orders, existingRowKeys);
  const shouldKeepPreviousRows =
    rows.length === 0 &&
    existingRowKeys.length > 0 &&
    options.allowEmptyRows !== true &&
    (errors.length > 0 || afterSalesSnapshot || options.keepPreviousOnEmpty === true);
  const freshRowKeys = shouldKeepPreviousRows
    ? []
    : uniqueValues(rows.map((row) => mergeOrder(normalizedStore, row, timestamp, { ...options, snapshotKey: key })));
  const rowKeys = shouldKeepPreviousRows
    ? existingSnapshot.rowKeys
    : afterSalesSnapshot &&
        options.allowEmptyRows !== true &&
        options.replaceAfterSalesSnapshotRows !== true &&
        snapshot?.replaceAfterSalesSnapshotRows !== true
      ? uniqueValues([...existingRowKeys, ...freshRowKeys])
      : freshRowKeys;
  if (!shouldKeepPreviousRows && errors.length === 0 && !afterSalesSnapshot) {
    markOrderSnapshotRowsNotSeen(normalizedStore, existingRowKeys, rowKeys, timestamp, key);
  }
  const failures = upsertSnapshotFailures(normalizedStore, key, SNAPSHOT_TYPE_ORDER, errors, timestamp);
  const orderChanges = countRecordSignatureChanges(previousOrderSignatures, normalizedStore.orders, rowKeys);
  const changeSummary = createSnapshotChangeSummary(existingSnapshot?.rowKeys, rowKeys, {
    failed: errors.length,
    skippedEmpty: shouldKeepPreviousRows ? 1 : 0,
    updated: orderChanges.updated,
    unchanged: orderChanges.unchanged,
  });

  const nextSnapshot = {
    key,
    type: SNAPSHOT_TYPE_ORDER,
    version: OZON_LOCAL_DATA_LAYER_VERSION,
    ruleVersion: sanitizeLogText(snapshot?.ruleVersion || snapshot?.snapshotRuleVersion || ''),
    cacheVersion: sanitizeLogText(snapshot?.cacheVersion || ''),
    rowKeys,
    fetchedAt: snapshot?.fetchedAt || timestamp,
    updatedAt: timestamp,
    errors,
    failureKeys: failures.map((failure) => failure.key),
    crossBorder: cloneJsonSafe(snapshot?.crossBorder) || {},
    shops: cloneJsonSafe(snapshot?.shops) || [],
    classificationEvidence: cloneJsonSafe(snapshot?.classificationEvidence) || {},
    lastFailedAt: errors.length ? timestamp : '',
    changeSummary,
  };
  const previousSignature = existingSnapshot?.signature || '';
  const signature = createSignature(nextSnapshot);
  normalizedStore.snapshots[key] = {
    ...nextSnapshot,
    signature,
  };
  normalizedStore.updatedAt = timestamp;
  appendRefreshLog(normalizedStore, {
    snapshotKey: key,
    type: SNAPSHOT_TYPE_ORDER,
    at: timestamp,
    source: snapshot?.source || 'ozon',
    rows: rowKeys.length,
    errors,
    failureCount: failures.length,
    changeSummary,
  });
  const afterSalesCompaction = afterSalesSnapshot
    ? pruneAfterSalesSnapshotVariants(normalizedStore, {
        preferredSnapshotKey: key,
        compatibleSnapshotKeys: options.afterSalesCompatibleSnapshotKeys,
      })
    : { changed: false, removedSnapshots: 0, removedOrders: 0, removedFailures: 0, removedLogs: 0 };
  pruneStore(normalizedStore);

  return {
    store: normalizedStore,
    stats: {
      changed: previousSignature !== signature,
      rows: rowKeys.length,
      errors: errors.length,
      failures: Object.keys(normalizedStore.failures).length,
      orders: Object.keys(normalizedStore.orders).length,
      products: Object.keys(normalizedStore.products).length,
      images: Object.keys(normalizedStore.images).length,
      afterSalesCompaction,
    },
  };
}

export function mergeProductSnapshotRow(store, row = {}, index = 0, timestamp, options = {}) {
  const scopedRow = scopeProductSnapshotRow(row, options);
  return mergeProduct(store, scopedRow, scopedRow, index, timestamp, { ...options, snapshotKey: options.snapshotKey });
}

export function mergeOzonProductSnapshotIntoLocalStore(store = {}, snapshotKey = '', snapshot = {}, options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const key = normalizeText(snapshotKey);
  if (!key) return { store: normalizedStore, stats: { changed: false, rows: 0 } };

  const timestamp = options.now || nowIso();
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const errors = toErrorRecords(snapshot?.errors);
  const existingSnapshot = normalizedStore.snapshots[key];
  const existingProductKeys = normalizeArray(existingSnapshot?.productKeys);
  const previousProductSignatures = collectRecordSignatures(normalizedStore.products, existingProductKeys);
  const shouldKeepPreviousRows = rows.length === 0 && errors.length > 0 && Array.isArray(existingSnapshot?.productKeys);
  const mergedProductRows = shouldKeepPreviousRows
    ? []
    : rows
        .map((row, index) => {
          const scopedRow = scopeProductSnapshotRow(row, options);
          const productKey = mergeProductSnapshotRow(normalizedStore, scopedRow, index, timestamp, {
            ...options,
            snapshotKey: key,
          });
          return productKey
            ? {
                productKey,
                rowFields: compactProductSnapshotRowFields(scopedRow),
              }
            : null;
        })
        .filter(Boolean);
  const productKeys = shouldKeepPreviousRows
    ? existingSnapshot.productKeys
    : uniqueValues(mergedProductRows.map((item) => item.productKey));
  const rowFieldsByProductKey = shouldKeepPreviousRows
    ? cloneJsonSafe(existingSnapshot?.rowFieldsByProductKey) || {}
    : mergedProductRows.reduce((acc, item) => {
        if (!item?.productKey || acc[item.productKey]) return acc;
        if (item.rowFields && Object.keys(item.rowFields).length) acc[item.productKey] = item.rowFields;
        return acc;
      }, {});
  if (!shouldKeepPreviousRows && errors.length === 0) {
    markProductSnapshotRowsNotSeen(normalizedStore, existingProductKeys, productKeys, timestamp, key);
  }
  const failures = upsertSnapshotFailures(normalizedStore, key, SNAPSHOT_TYPE_PRODUCT, errors, timestamp);
  const productChanges = countRecordSignatureChanges(previousProductSignatures, normalizedStore.products, productKeys);
  const changeSummary = createSnapshotChangeSummary(existingSnapshot?.productKeys, productKeys, {
    failed: errors.length,
    skippedEmpty: shouldKeepPreviousRows ? 1 : 0,
    updated: productChanges.updated,
    unchanged: productChanges.unchanged,
  });

  const nextSnapshot = {
    key,
    type: SNAPSHOT_TYPE_PRODUCT,
    version: OZON_LOCAL_DATA_LAYER_VERSION,
    productKeys,
    rowFieldsByProductKey,
    fetchedAt: snapshot?.fetchedAt || timestamp,
    updatedAt: timestamp,
    errors,
    failureKeys: failures.map((failure) => failure.key),
    total: Number.isFinite(Number(snapshot?.total)) ? Number(snapshot.total) : productKeys.length,
    page: Number.isFinite(Number(snapshot?.page)) ? Number(snapshot.page) : '',
    pageSize: Number.isFinite(Number(snapshot?.pageSize)) ? Number(snapshot.pageSize) : '',
    statusCounts: cloneJsonSafe(snapshot?.statusCounts) || {},
    lastFailedAt: errors.length ? timestamp : '',
    changeSummary,
  };
  const previousSignature = existingSnapshot?.signature || '';
  const signature = createSignature(nextSnapshot);
  normalizedStore.snapshots[key] = {
    ...nextSnapshot,
    signature,
  };
  const prunedPageSnapshots = pruneSupersededProductPageSnapshots(normalizedStore, key);
  normalizedStore.updatedAt = timestamp;
  appendRefreshLog(normalizedStore, {
    snapshotKey: key,
    type: SNAPSHOT_TYPE_PRODUCT,
    at: timestamp,
    source: snapshot?.source || 'ozon',
    rows: productKeys.length,
    errors,
    failureCount: failures.length,
    changeSummary,
  });
  pruneStore(normalizedStore);

  return {
    store: normalizedStore,
    stats: {
      changed: previousSignature !== signature,
      rows: productKeys.length,
      errors: errors.length,
      failures: Object.keys(normalizedStore.failures).length,
      orders: Object.keys(normalizedStore.orders).length,
      products: Object.keys(normalizedStore.products).length,
      images: Object.keys(normalizedStore.images).length,
      prunedPageSnapshots,
    },
  };
}

export function getDomainSnapshotRows(snapshot = {}) {
  if (Array.isArray(snapshot?.rows)) return snapshot.rows;
  if (Array.isArray(snapshot?.warehouses)) return snapshot.warehouses;
  if (Array.isArray(snapshot?.deliveryMethods)) return snapshot.deliveryMethods;
  if (Array.isArray(snapshot?.items)) return snapshot.items;
  return [];
}

export function getDomainSnapshotRowKey(row = {}, snapshotKey = '', index = 0) {
  return firstFilled(
    row?.key,
    row?.id,
    row?.entityId,
    row?.rawId,
    row?.warehouseId,
    row?.deliveryMethodId,
    row?.methodId,
    row?.shippingMethodId,
    row?.offerId,
    row?.productId,
    `${snapshotKey}:row-${index}`
  );
}

export function getDomainSnapshotRowKeys(snapshot = {}, snapshotKey = '') {
  const rows = getDomainSnapshotRows(snapshot);
  if (!rows.length) return hasEffectiveFieldValue(snapshot) ? [`${snapshotKey}:payload`] : [];
  return uniqueValues(rows.map((row, index) => getDomainSnapshotRowKey(row, snapshotKey, index)));
}

export function collectDomainPayloadSignatures(payload = {}, snapshotKey = '') {
  const rows = getDomainSnapshotRows(payload);
  if (!rows.length) {
    const rowKeys = getDomainSnapshotRowKeys(payload, snapshotKey);
    if (!rowKeys.length) return new Map();
    return new Map([[rowKeys[0], createSignature(payload)]]);
  }
  return new Map(
    rows
      .map((row, index) => [getDomainSnapshotRowKey(row, snapshotKey, index), createSignature(row)])
      .filter(([key]) => normalizeText(key))
  );
}

export function hasDomainSnapshotBusinessData(snapshot = {}) {
  if (Array.isArray(snapshot?.rows) && snapshot.rows.length) return true;
  if (Array.isArray(snapshot?.warehouses) && snapshot.warehouses.length) return true;
  if (Array.isArray(snapshot?.deliveryMethods) && snapshot.deliveryMethods.length) return true;
  if (Array.isArray(snapshot?.items) && snapshot.items.length) return true;
  return false;
}

export function mergeDomainSnapshotIntoLocalStore(store = {}, snapshotKey = '', snapshot = {}, options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  const key = normalizeText(snapshotKey);
  if (!key) return { store: normalizedStore, stats: { changed: false, rows: 0 } };

  const timestamp = options.now || nowIso();
  const errors = toErrorRecords(snapshot?.errors);
  const existingSnapshot = normalizedStore.domainSnapshots[key];
  const clonedPayload = cloneJsonSafe(snapshot) || {};
  const previousDomainSignatures = collectDomainPayloadSignatures(existingSnapshot?.payload, key);
  const incomingRowKeys = getDomainSnapshotRowKeys(clonedPayload, key);
  const shouldKeepPreviousPayload =
    !hasDomainSnapshotBusinessData(clonedPayload) && errors.length > 0 && isPlainObject(existingSnapshot?.payload);
  const payload = shouldKeepPreviousPayload ? existingSnapshot.payload : clonedPayload;
  const rowKeys = shouldKeepPreviousPayload ? normalizeArray(existingSnapshot?.rowKeys) : incomingRowKeys;
  const failures = upsertSnapshotFailures(normalizedStore, key, SNAPSHOT_TYPE_DOMAIN, errors, timestamp);
  const domainChanges = countSignatureMapChanges(
    previousDomainSignatures,
    collectDomainPayloadSignatures(payload, key),
    rowKeys
  );
  const changeSummary = createSnapshotChangeSummary(existingSnapshot?.rowKeys, rowKeys, {
    failed: errors.length,
    skippedEmpty: shouldKeepPreviousPayload ? 1 : 0,
    updated: domainChanges.updated,
    unchanged: domainChanges.unchanged,
  });

  const nextSnapshot = {
    key,
    type: SNAPSHOT_TYPE_DOMAIN,
    domain: normalizeText(options.domain || snapshot?.domain || 'generic'),
    version: OZON_LOCAL_DATA_LAYER_VERSION,
    rowKeys,
    payload,
    fetchedAt: snapshot?.fetchedAt || timestamp,
    updatedAt: timestamp,
    errors,
    failureKeys: failures.map((failure) => failure.key),
    lastFailedAt: errors.length ? timestamp : '',
    changeSummary,
  };
  const previousSignature = existingSnapshot?.signature || '';
  const signature = createSignature(nextSnapshot);
  normalizedStore.domainSnapshots[key] = {
    ...nextSnapshot,
    signature,
  };
  normalizedStore.updatedAt = timestamp;
  appendRefreshLog(normalizedStore, {
    snapshotKey: key,
    type: SNAPSHOT_TYPE_DOMAIN,
    at: timestamp,
    source: snapshot?.source || options.source || 'ozon',
    rows: rowKeys.length,
    errors,
    failureCount: failures.length,
    changeSummary,
  });
  pruneStore(normalizedStore);

  return {
    store: normalizedStore,
    stats: {
      changed: previousSignature !== signature,
      rows: rowKeys.length,
      errors: errors.length,
      failures: Object.keys(normalizedStore.failures).length,
    },
  };
}

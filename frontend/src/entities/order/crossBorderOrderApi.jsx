import { saveCrossBorderServerAccountSettings } from '../../services/crossBorderAccountClient';
import {
  areCrossBorderOrderCacheKeysEquivalent,
} from '../../services/crossBorderOrderCache';
import { readCrossBorderRecords, saveCrossBorderRecords } from '../../services/crossBorderOrderRecordClient';
import { readCrossBorderEndpoint } from '../../services/crossBorderReadClient';
import {
  confirmCrossBorderWriteOperation,
  previewCrossBorderWriteOperation,
} from '../../services/crossBorderWriteClient';
import { assertExternalInterfaceAllowed } from '../../services/externalInterfaceRegistry';
import {
  CROSS_BORDER_MAIN_ACCOUNT_ID,
  CROSS_BORDER_ORDER_PAGE_LIMIT,
  CROSS_BORDER_ORDER_PAGINATION_SAFETY_MAX_PAGES,
  OZON_PRODUCT_IMAGE_CHUNK_CONCURRENCY,
} from '../../shared/config/appConfigCore.jsx';
import { chunkValues } from '../../shared/lib/collectionUtils.js';
import { getCrossBorderPayload, readSavedCrossBorderSettings } from '../../shared/ozon/ozonRuntime.jsx';
import {
  getCrossBorderLocalApiAccountId,
  hasDirectCrossBorderAuthorization,
  hasLocalApiCrossBorderAuthorization,
  hasUsableCrossBorderAuthorization,
} from './crossBorderAuthRules.jsx';
import {
  buildOzonProductMap,
  getOzonProductKey,
  requestOzonProductDetailsByOfferIds,
  requestOzonProductInfoListSafely,
  requestOzonProductPictures,
} from '../product/productOzonApi.jsx';
import { formatPlainNumber, getOzonImages, toFiniteNumber } from '../product/productAttributes.jsx';
import { normalizeImageList, safeImageUrl } from '../product/productWriteHelpers.jsx';
import {
  crossBorderProtectedOrderOperations,
  firstFilled,
  firstUsableOzonId,
  normalizeOzonId,
} from './orderShopScope.jsx';
import { runLimitedAsync } from './orderAsyncRules.jsx';
import { getOzonOrderProductSalesAmount } from './orderProductAmountRules.jsx';
import { getSalesOrderProductPictureId, hasSalesOrderProductImage } from './orderProductImageRules.jsx';
import { getCrossBorderStoreForPurchaseOrder } from './crossBorderPackageRules.jsx';

export { getOzonOrderProductSalesAmount };

export { getSalesOrderProductPictureId, hasSalesOrderProductImage };

export async function requestOzonProductPicturesSafely(shop, productIds = [], options = {}) {
  const ids = [...new Set(productIds)].filter((id) => Number.isFinite(Number(id)) && Number(id) > 0);

  const readChunk = async (chunk) => {
    if (!chunk.length) return [];
    try {
      return await requestOzonProductPictures(shop, chunk, options);
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError' || /aborted|已中断/i.test(error?.message || '')) {
        throw error;
      }
      if (chunk.length === 1) return [];
      const middle = Math.ceil(chunk.length / 2);
      const [left, right] = await Promise.all([readChunk(chunk.slice(0, middle)), readChunk(chunk.slice(middle))]);
      return [...left, ...right];
    }
  };

  const chunkResults = await runLimitedAsync(chunkValues(ids, 50), OZON_PRODUCT_IMAGE_CHUNK_CONCURRENCY, readChunk);

  return chunkResults.flatMap((result) => (result.status === 'fulfilled' ? (result.value ?? []) : []));
}

export function applyOzonProductPicturesToSalesRows(rows = [], pictures = [], details = []) {
  const pictureMap = buildOzonProductMap(pictures);
  const detailMap = buildOzonProductMap(details);

  return rows.map((row) => ({
    ...row,
    products: (Array.isArray(row.products) ? row.products : []).map((product) => {
      const offerId = firstUsableOzonId(product.offerId, product.raw?.offer_id, product.raw?.offerId);
      const skuId = firstUsableOzonId(
        product.skuId,
        product.raw?.sku,
        product.raw?.sku_id,
        product.raw?.skuId,
        product.sku
      );
      const detailByOffer = detailMap.get(offerId);
      const detailBySku = detailMap.get(skuId);
      const productId = firstUsableOzonId(
        detailByOffer?.product_id,
        detailByOffer?.id,
        detailBySku?.product_id,
        detailBySku?.id,
        product.productIdSource === 'priceInfo' ? product.productId : '',
        product.productIdSource === 'productInfo' ? product.productId : ''
      );
      const detail = detailMap.get(productId) ?? detailByOffer ?? detailBySku;
      const picture = pictureMap.get(productId) ?? pictureMap.get(offerId) ?? pictureMap.get(skuId);
      const pictureImages = getOzonImages(detail, null, picture);
      const productWithId = productId
        ? {
            ...product,
            productId: productId || product.productId || '未返回',
            productIdSource: product.productIdSource || 'productInfo',
          }
        : product;
      if (!pictureImages.length) return productWithId;

      const raw = product.raw ?? {};
      const skuImages = normalizeImageList([
        productWithId.skuImage,
        productWithId.sku_image,
        ...(Array.isArray(productWithId.skuImages) ? productWithId.skuImages : []),
        raw.sku_image,
        raw.skuImage,
        raw.sku_picture,
        raw.skuPicture,
        productWithId.image,
        ...(Array.isArray(productWithId.images) ? productWithId.images : []),
      ]);
      const mainImages = [
        ...new Set(
          normalizeImageList([
            ...pictureImages,
            productWithId.mainImage,
            productWithId.productMainImage,
            productWithId.primaryImage,
            productWithId.primary_image,
            ...(Array.isArray(productWithId.mainImages) ? productWithId.mainImages : []),
            ...(Array.isArray(productWithId.productMainImages) ? productWithId.productMainImages : []),
            raw.primary_image,
            raw.primaryImage,
            raw.main_image,
            raw.mainImage,
          ])
        ),
      ];
      const mergedImages = [...new Set([...skuImages, ...mainImages])];
      return {
        ...productWithId,
        productId: productId || productWithId.productId || '未返回',
        productIdSource: productId ? (picture ? 'pictures' : 'productInfo') : productWithId.productIdSource,
        image: mergedImages[0] || '',
        images: mergedImages,
        skuImage: skuImages[0] || '',
        skuImages,
        mainImage: mainImages[0] || '',
        mainImages,
        productMainImage: mainImages[0] || '',
        productMainImages: mainImages,
      };
    }),
  }));
}

export async function enrichSalesRowsWithOzonProductImages(shop, rows = [], options = {}) {
  const products = rows.flatMap((row) => (Array.isArray(row.products) ? row.products : []));
  const offerIds = [
    ...new Set(
      products
        .map((product) => firstUsableOzonId(product.offerId, product.raw?.offer_id, product.raw?.offerId))
        .filter(Boolean)
    ),
  ];
  const skuIds = [
    ...new Set(
      products
        .map((product) => firstUsableOzonId(product.skuId, product.raw?.sku, product.raw?.sku_id, product.raw?.skuId))
        .filter(Boolean)
    ),
  ];
  const includeSkuFallback = Boolean(options.includeSkuFallback);

  const offerDetails = offerIds.length
    ? await requestOzonProductDetailsByOfferIds(shop, offerIds, { allowPartial: true, signal: options.signal })
    : [];
  const rowsWithOfferDetails = offerDetails.length ? applyOzonProductPicturesToSalesRows(rows, [], offerDetails) : rows;
  const productsAfterOfferDetails = rowsWithOfferDetails.flatMap((row) =>
    Array.isArray(row.products) ? row.products : []
  );
  const missingPictureProductIds = [
    ...new Set(
      productsAfterOfferDetails
        .filter((product) => !hasSalesOrderProductImage(product))
        .map(getSalesOrderProductPictureId)
        .filter(Boolean)
    ),
  ];

  const pictures = missingPictureProductIds.length
    ? await requestOzonProductPicturesSafely(shop, missingPictureProductIds, { signal: options.signal })
    : [];
  const rowsWithPictures = pictures.length
    ? applyOzonProductPicturesToSalesRows(rowsWithOfferDetails, pictures, offerDetails)
    : rowsWithOfferDetails;

  if (!includeSkuFallback) return rowsWithPictures;

  const productsAfterPictures = rowsWithPictures.flatMap((row) => (Array.isArray(row.products) ? row.products : []));
  const resolvedOfferSkus = new Set(offerDetails.map((item) => normalizeOzonId(item?.sku).trim()).filter(Boolean));
  const stillMissingSkuIds = new Set(
    productsAfterPictures
      .filter((product) => !hasSalesOrderProductImage(product))
      .map((product) => firstUsableOzonId(product.skuId, product.raw?.sku, product.raw?.sku_id, product.raw?.skuId))
      .filter(Boolean)
  );
  const missingDetailSkuIds = skuIds.filter(
    (sku) => stillMissingSkuIds.has(sku) && !resolvedOfferSkus.has(normalizeOzonId(sku).trim())
  );
  const skuDetails = missingDetailSkuIds.length
    ? await requestOzonProductInfoListSafely(shop, 'sku', missingDetailSkuIds, {
        allowPartial: true,
        signal: options.signal,
      })
    : [];
  const detailByKey = new Map();
  [...offerDetails, ...skuDetails].forEach((item) => {
    const key =
      getOzonProductKey(item) ||
      normalizeOzonId(item?.offer_id ?? item?.offerId).trim() ||
      normalizeOzonId(item?.sku ?? item?.sku_id ?? item?.skuId).trim();
    if (key) detailByKey.set(key, item);
  });
  const details = [...detailByKey.values()];
  const rowsWithSkuDetails = skuDetails.length
    ? applyOzonProductPicturesToSalesRows(rowsWithPictures, [], details)
    : rowsWithPictures;
  const productsAfterSkuDetails = rowsWithSkuDetails.flatMap((row) =>
    Array.isArray(row.products) ? row.products : []
  );
  const missingSkuPictureProductIds = [
    ...new Set(
      productsAfterSkuDetails
        .filter((product) => !hasSalesOrderProductImage(product))
        .map(getSalesOrderProductPictureId)
        .filter(Boolean)
    ),
  ];

  if (!missingSkuPictureProductIds.length) return rowsWithSkuDetails;
  const skuPictures = await requestOzonProductPicturesSafely(shop, missingSkuPictureProductIds, {
    signal: options.signal,
  });
  return skuPictures.length
    ? applyOzonProductPicturesToSalesRows(rowsWithSkuDetails, skuPictures, details)
    : rowsWithSkuDetails;
}

export function getOzonPackageDimensionText(source = {}) {
  const length = toFiniteNumber(firstFilled(source.length, source.package_length, source.packageLength, source.depth));
  const width = toFiniteNumber(firstFilled(source.width, source.package_width, source.packageWidth));
  const height = toFiniteNumber(firstFilled(source.height, source.package_height, source.packageHeight));
  const unit = firstFilled(source.dimension_unit, source.dimensionUnit, source.unit) || 'cm';
  if (length === null || width === null || height === null) return '未返回';
  return `${formatPlainNumber(length)} ${unit} x ${formatPlainNumber(width)} ${unit} x ${formatPlainNumber(height)} ${unit}`;
}

export function getOzonOrderCrossBorderInfo(item = {}) {
  const crossBorder =
    item.cross_border ??
    item.crossBorder ??
    item.cross_border_bus ??
    item.crossBorderBus ??
    item.kuajing ??
    item.cross_border_order ??
    {};
  const packageInfo =
    crossBorder.package ?? crossBorder.parcel ?? crossBorder.out_info ?? crossBorder.outInfo ?? crossBorder;
  const packageWeight = firstFilled(
    packageInfo.package_weight,
    packageInfo.packageWeight,
    packageInfo.weight,
    packageInfo.out_weight,
    packageInfo.outWeight
  );
  const weightUnit = firstFilled(packageInfo.weight_unit, packageInfo.weightUnit) || 'kg';

  return {
    orderId:
      normalizeOzonId(
        firstFilled(crossBorder.order_id, crossBorder.orderId, crossBorder.package_order_id, crossBorder.packageOrderId)
      ) || '未返回',
    packageWeight: packageWeight === '' ? '未返回' : `${formatPlainNumber(packageWeight)} ${weightUnit}`,
    packageSize: getOzonPackageDimensionText(packageInfo),
    readStatus: firstFilled(crossBorder.read_status, crossBorder.readStatus, crossBorder.status) || '未返回',
    warehouse:
      firstFilled(
        crossBorder.warehouse,
        crossBorder.storehouse,
        crossBorder.storehouse_name,
        crossBorder.storehouseName
      ) || '未返回',
  };
}

export function readSavedCrossBorderOrderSettings() {
  if (typeof window === 'undefined') return {};
  return readSavedCrossBorderSettings({});
}

export {
  getCrossBorderLocalApiAccountId,
  hasDirectCrossBorderAuthorization,
  hasLocalApiCrossBorderAuthorization,
  hasUsableCrossBorderAuthorization,
};

export async function saveCrossBorderAccountToLocalApi(settings = {}, options = {}) {
  const accountId = getCrossBorderLocalApiAccountId(settings);
  const payload = {
    ...(accountId ? { id: accountId } : {}),
    name: settings.accountAlias || settings.name || '跨境巴士主授权',
    status: 'active',
    defaultStorehouse: settings.cooperationWarehouse || settings.defaultStorehouse || '',
    defaultSection: settings.sectionId || settings.defaultSection || '',
    defaultService: settings.packageService || settings.defaultService || '',
    shopIds: Array.isArray(settings.shopIds) ? settings.shopIds : [],
    note: '旺崽助手设置中心保存',
  };
  if (options.accountRemovalRebind === true) payload.accountRemovalRebind = true;
  if (settings.authorizationRef?.trim()) payload.authorizationRef = settings.authorizationRef.trim();
  if (settings.authorizationExpiresAt?.trim()) {
    payload.authorizationExpiresAt = settings.authorizationExpiresAt.trim();
  }
  const result = await saveCrossBorderServerAccountSettings(payload);
  return result?.account || result;
}

export function canUseCrossBorderOrderRead(settings = {}) {
  return (
    hasDirectCrossBorderAuthorization(settings) ||
    hasLocalApiCrossBorderAuthorization(settings) ||
    Boolean(getCrossBorderLocalApiAccountId(settings))
  );
}

export function getCrossBorderSelectedStoreFilter(settings = {}, shopClientId = '') {
  const store = getCrossBorderStoreForPurchaseOrder(settings);
  const normalizedSectionId = normalizeOzonId(store.sectionId).trim();
  const normalizedSid = normalizeOzonId(store.sid).trim();
  if (!normalizedSectionId) return null;
  return {
    ...(normalizedSid ? { sid: normalizedSid } : {}),
    section_id: normalizedSectionId,
  };
}

export function getCrossBorderReadStatusDisplay(status) {
  const text = String(firstFilled(status) || '').trim();
  if (!text) return '未返回';
  if (text.includes('正在读取')) return '正在读取';
  if (text.includes('未查到')) return '未查到预报订单';
  if (text.includes('已读取材积')) return '已读取材积';
  if (text.includes('未返回材积')) return '已查到预报，未返回材积';
  if (text.includes('多个') || text.includes('人工核对')) return '需人工核对';
  if (text.includes('超时')) return '读取超时';
  if (/401|403|授权|token/i.test(text)) return '授权失败';
  if (/failed to fetch|networkerror|网络/i.test(text)) return '网络异常';
  if (/\/api\/|\/erpapi\/|https?:\/\/|请求失败|HTTP\s*\d+/i.test(text)) return '读取失败';
  return text;
}

export function canUseCrossBorderOrderOutInfoRead(settings = {}) {
  return canUseCrossBorderOrderRead(settings);
}

export function getPurchaseOrderOutInfoNumber(order = {}) {
  return firstFilled(order.shipmentNo, order.returnNo, order.salesOrder, order.ozonOrderId);
}

export async function requestPurchaseOrderOutInfo(settings = {}, order = {}, orderId = '', options = {}) {
  return requestCrossBorderReadOnly('/erpapi/order/get_order_out_info', settings, {
    order_id: orderId,
    section_code: getPurchaseOrderOutInfoNumber(order),
  }, options);
}

export function getCrossBorderListItems(data) {
  const payload = getCrossBorderPayload(data);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.result?.list)) return payload.result.list;
  return [];
}

export function getCrossBorderOptionalTotal(data) {
  const payload = getCrossBorderPayload(data);
  const candidates = [
    payload?.count,
    payload?.total,
    payload?.total_count,
    data?.count,
    data?.total,
    data?.data?.count,
    data?.result?.count,
  ];
  const total = candidates.find(
    (value) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))
  );
  return total === undefined ? null : Number(total);
}

export async function requestCrossBorderReadOnly(endpoint, settings, body = {}, options = {}) {
  if (!canUseCrossBorderOrderRead(settings)) {
    throw new Error('请先在设置里完成跨境巴士服务器授权。');
  }
  assertExternalInterfaceAllowed({
    provider: 'cross-border-bus',
    endpoint,
    method: 'POST',
    access: 'read',
  });
  const accountId = getCrossBorderLocalApiAccountId(settings) || CROSS_BORDER_MAIN_ACCOUNT_ID;
  const result = await readCrossBorderEndpoint(
    {
      legacyEndpoint: endpoint,
      accountId,
      shopId: options.shopId || settings.shopId || '',
      body,
      timeoutMs: options.timeoutMs,
      dedupeKey: options.dedupeKey,
      maxRetries: options.maxRetries,
    },
    {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }
  );
  return result?.data ?? result;
}

export async function requestCrossBorderOrderSearchPages(settings, baseBody = {}, shopScope = {}) {
  const items = [];
  let total = null;

  for (let page = 1; page <= CROSS_BORDER_ORDER_PAGINATION_SAFETY_MAX_PAGES; page += 1) {
    const data = await requestCrossBorderReadOnly(
      '/erpapi/orderlist/search',
      settings,
      {
        page,
        limit: CROSS_BORDER_ORDER_PAGE_LIMIT,
        ...baseBody,
      },
      {
        bodyFormat: 'form',
        shopId: shopScope.shopId || shopScope.shop_id || '',
        shopClientId: shopScope.shopClientId || shopScope.clientId || '',
      }
    );
    const pageItems = getCrossBorderListItems(data);
    total = getCrossBorderOptionalTotal(data) ?? total;
    items.push(...pageItems);
    if (pageItems.length < CROSS_BORDER_ORDER_PAGE_LIMIT) break;
    if (total !== null && items.length >= total) break;
  }

  return { items, total: total ?? items.length };
}

export function isCrossBorderArrayConversionError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Array to string conversion/i.test(message);
}

export function normalizeCrossBorderOrderSearchBody(body = {}) {
  return Object.fromEntries(
    Object.entries(body || {})
      .map(([key, value]) => [key, normalizeCrossBorderOrderSearchScalar(value)])
      .filter(([, value]) => value !== '')
  );
}

export function normalizeCrossBorderOrderSearchScalar(value) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const scalarValue = normalizeCrossBorderOrderSearchScalar(item);
      if (scalarValue !== '') return scalarValue;
    }
    return '';
  }
  if (typeof value === 'object') return '';
  return String(value).trim();
}

export function canUseCrossBorderOrderWrite(settings = {}) {
  return canUseCrossBorderOrderRead(settings);
}

export async function requestProtectedCrossBorderOrderOperation(
  operationId,
  settings,
  body,
  {
    confirmed = false,
    shopId = '',
    shopClientId = '',
    previewTimeoutMs = 30_000,
    confirmTimeoutMs = 120_000,
  } = {}
) {
  const operation = crossBorderProtectedOrderOperations[operationId];
  if (!operation) throw new Error('未找到对应跨境巴士订单操作');
  if (!canUseCrossBorderOrderWrite(settings)) {
    throw new Error('请先在设置里完成跨境巴士服务器授权。');
  }
  if (!confirmed) {
    throw new Error(`${operation.title} 是真实写入操作，需要二次确认后才能执行。`);
  }
  assertExternalInterfaceAllowed({
    provider: 'cross-border-bus',
    endpoint: operation.endpoint,
    method: 'POST',
    access: 'write',
    confirmed: true,
  });
  const accountId = getCrossBorderLocalApiAccountId(settings) || CROSS_BORDER_MAIN_ACCOUNT_ID;
  const writeInput = {
    legacyEndpoint: operation.endpoint,
    accountId,
    shopId: shopId || settings.shopId || '',
    shopClientId: shopClientId || settings.shopClientId || '',
    action: operationId,
    body,
    requestedBy: 'purchase-orders',
    idempotencyKey: [operationId, body?.order_number, body?.order_id, body?.sheet_order_sn, body?.platform_order]
      .filter(Boolean)
      .join(':'),
  };
  const preview = await previewCrossBorderWriteOperation(writeInput, { timeoutMs: previewTimeoutMs });
  if (!preview?.ok || !preview.previewId) {
    const message = preview?.error?.message || '跨境巴士写入预览未通过。';
    throw new Error(message);
  }
  const result = await confirmCrossBorderWriteOperation(
    {
      ...writeInput,
      previewId: preview.previewId,
      confirm: true,
    },
    { timeoutMs: confirmTimeoutMs }
  );
  if (!result?.ok) {
    const message = result?.error?.message || result?.message || '跨境巴士真实写入失败。';
    throw new Error(message);
  }
  return result.data ?? result;
}

export function getCrossBorderLocalRecordValues(record = {}) {
  const sheetInfo = record.sheet_info && typeof record.sheet_info === 'object' ? record.sheet_info : {};
  const body = record.body && typeof record.body === 'object' ? record.body : {};
  const packageList = Array.isArray(record.package_list) ? record.package_list : [];
  return [
    record.id,
    record.order_id,
    record.orderId,
    record.order_number,
    record.orderNumber,
    record.platform_order,
    record.platformOrder,
    record.purchaseOrderNumber,
    record.from_order,
    record.fromOrder,
    record.collectionNumber,
    record.collection_number,
    record.trackingNumber,
    record.tracking_number,
    record.logisticsOrder,
    record.logistics_order,
    record.sheetOrderNumber,
    record.sheet_order_sn,
    sheetInfo.sheet_order_sn,
    sheetInfo.section_order,
    sheetInfo.sectionOrder,
    body.order_id,
    body.orderId,
    body.section_code,
    body.sectionCode,
    ...packageList.flatMap((item) => [
      item?.from_order,
      item?.fromOrder,
      item?.logistics_order,
      item?.logisticsOrder,
      item?.tracking_number,
      item?.trackingNumber,
    ]),
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

export function getCrossBorderOrderSearchConcreteKeys(extraBody = {}) {
  const fields = [
    'id',
    'order_id',
    'orderId',
    'order_number',
    'orderNumber',
    'platform_order',
    'platformOrder',
    'from_order',
    'fromOrder',
    'collection_number',
    'collectionNumber',
    'tracking_number',
    'trackingNumber',
    'logistics_order',
    'logisticsOrder',
    'sheet_order_sn',
    'sheetOrderNumber',
  ];
  return fields
    .map((field) => String(extraBody?.[field] ?? '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

export function normalizeCrossBorderLocalOrderRecord(record = {}) {
  const sheetInfo = record.sheet_info && typeof record.sheet_info === 'object' ? record.sheet_info : {};
  const body = record.body && typeof record.body === 'object' ? record.body : {};
  const packageList = Array.isArray(record.package_list) ? record.package_list : [];
  const firstPackage = packageList.find((item) => item && typeof item === 'object') || {};
  const orderId = String(record.orderId ?? record.order_id ?? record.id ?? '').trim();
  const orderNumber = String(record.orderNumber ?? record.order_number ?? record.platform_order ?? '').trim();
  const purchaseOrderNumber = String(
    record.purchaseOrderNumber ?? record.from_order ?? record.fromOrder ?? firstPackage.from_order ?? ''
  ).trim();
  const sheetOrderNumber = String(
    record.sheetOrderNumber ??
      record.sheet_order_sn ??
      sheetInfo.sheet_order_sn ??
      sheetInfo.section_order ??
      body.section_code ??
      ''
  ).trim();
  const logisticsOrder = String(
    record.logisticsOrder ?? record.logistics_order ?? firstPackage.logistics_order ?? ''
  ).trim();
  const trackingNumber = String(
    record.trackingNumber ?? record.tracking_number ?? firstPackage.tracking_number ?? ''
  ).trim();
  const collectionNumber = String(record.collectionNumber ?? record.collection_number ?? '').trim();
  return {
    ...record,
    id: orderId,
    order_id: orderId,
    orderId,
    order_number: orderNumber,
    orderNumber,
    platform_order: orderNumber,
    platformOrder: orderNumber,
    from_order: purchaseOrderNumber,
    fromOrder: purchaseOrderNumber,
    from_platform: record.platform || record.from_platform || '',
    collection_number: collectionNumber,
    logistics_order: logisticsOrder,
    tracking_number: trackingNumber,
    sheet_order_sn: sheetOrderNumber,
    sheet_info: {
      ...(record.sheet_info && typeof record.sheet_info === 'object' ? record.sheet_info : {}),
      sheet_order_sn: sheetOrderNumber,
      sheet_url: record.sheetUrl || record.sheet_url || '',
    },
    offer_id: record.offerId || record.offer_id || '',
    _localRecord: true,
  };
}

export async function readLocalCrossBorderOrderRecords(query = {}) {
  const shopId = normalizeOzonId(query.shopId ?? query.shop_id).trim();
  if (!shopId) return [];
  const pageSize = 1000;
  const rows = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await readCrossBorderRecords({ shopId, page, pageSize });
    const pageRows = Array.isArray(result?.rows) ? result.rows : [];
    rows.push(...pageRows);
    const total = Number(result?.total) || rows.length;
    if (rows.length >= total || pageRows.length < pageSize) break;
  }
  return rows.filter((item) => item && typeof item === 'object');
}

export async function mergeLocalCrossBorderOrderRecords(records = [], context = {}) {
  const freshRecords = Array.isArray(records) ? records.filter((item) => item && typeof item === 'object') : [];
  if (!freshRecords.length) return [];
  const shopId = normalizeOzonId(context.shopId ?? context.shop_id).trim();
  if (!shopId) {
    const error = new Error('跨境巴士订单缓存必须明确内部 shopId。');
    error.code = 'CROSS_BORDER_INTERNAL_SHOP_ID_REQUIRED';
    throw error;
  }
  await saveCrossBorderRecords(freshRecords, {
    shopId,
    shopClientId: context.shopClientId,
    cachedAt: context.cachedAt || new Date().toISOString(),
  });
  return readLocalCrossBorderOrderRecords({ shopId });
}

export function normalizeCrossBorderOrderSearchScope(scope = '') {
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    return {
      shopId: normalizeOzonId(scope.shopId ?? scope.shop_id).trim(),
      shopClientId: normalizeOzonId(scope.shopClientId ?? scope.clientId ?? scope.client_id).trim(),
    };
  }
  return { shopId: '', shopClientId: normalizeOzonId(scope).trim() };
}

export async function requestLocalCrossBorderOrderSearch(extraBody = {}, shopScope = '') {
  const keys = getCrossBorderOrderSearchConcreteKeys(extraBody);
  if (!keys.length) return null;

  const scope = normalizeCrossBorderOrderSearchScope(shopScope);
  if (!scope.shopId) return null;
  const records = await readLocalCrossBorderOrderRecords({
    shopId: scope.shopId,
  });
  if (!records.length) return null;

  const matches = records.filter((record) => {
    const recordShopId = normalizeOzonId(record.shopId ?? record.shop_id).trim();
    const recordShopClientId = normalizeOzonId(
      record.shopClientId ?? record.clientId ?? record.client_id
    ).trim();
    if (scope.shopId) {
      if (recordShopId !== scope.shopId) return false;
      if (scope.shopClientId && recordShopClientId && recordShopClientId !== scope.shopClientId) return false;
    }
    const values = getCrossBorderLocalRecordValues(record);
    return keys.some((key) => values.some((value) => areCrossBorderOrderCacheKeysEquivalent(value, key)));
  });

  if (!matches.length) return null;
  const items = matches.map(normalizeCrossBorderLocalOrderRecord);
  return { items, total: items.length, source: 'local-order-records' };
}

export async function requestCrossBorderOrderSearch(settings, extraBody = {}, shopScope = '') {
  const searchBody = normalizeCrossBorderOrderSearchBody(extraBody);
  const scope = normalizeCrossBorderOrderSearchScope(shopScope);
  const localResult = await requestLocalCrossBorderOrderSearch(searchBody, scope);
  if (localResult?.items?.length) {
    return localResult;
  }

  const selectedStoreFilter = getCrossBorderSelectedStoreFilter(settings, scope.shopClientId);
  if (!selectedStoreFilter) {
    throw new Error('缺少跨境巴士仓库或平台设置，不能读取对应店铺订单。');
  }

  const storeFilter = normalizeCrossBorderOrderSearchBody(selectedStoreFilter);
  const bodyVariants = getCrossBorderOrderSearchBodyVariants(searchBody, storeFilter);
  let lastError = null;
  let emptyResult = null;
  if (bodyVariants.length === 0) return { items: [], total: 0 };

  for (const body of bodyVariants) {
    try {
      const result = await requestCrossBorderOrderSearchPages(settings, body, scope);
      if (result.items.length) {
        mergeLocalCrossBorderOrderRecords(result.items, scope).catch(() => undefined);
        return result;
      }
      emptyResult = emptyResult || result;
    } catch (error) {
      lastError = error;
      if (!isCrossBorderArrayConversionError(error)) throw error;
    }
  }

  if (emptyResult) return emptyResult;
  throw lastError;
}

export function getCrossBorderOrderSearchBodyVariants(searchBody = {}, storeFilter = {}) {
  const variants = [{ ...searchBody }, { ...searchBody, ...storeFilter }];
  const seen = new Set();
  return variants.filter((body) => {
    const normalizedBody = normalizeCrossBorderOrderSearchBody(body);
    const key = JSON.stringify(normalizedBody);
    if (seen.has(key)) return false;
    seen.add(key);
    return Object.keys(normalizedBody).length > 0;
  });
}

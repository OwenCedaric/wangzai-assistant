import {
  calculateCommissionFeeCny,
  calculateEstimatedProfitCny,
  convertFeeAmountToCny,
} from '../../services/feeCalculationService';
import { getProductMaterialSource } from '../../services/productMaterialProfileStore';
import { firstFilled, normalizeOzonId } from '../order/orderIdentityRules.jsx';
import { formatOzonPrice } from './productPriceRules.jsx';
import {
  findDirectByKeys,
  formatPlainNumber,
  getAttributeId,
  getAttributeValue,
  getImageUrlFromValue,
  getOzonDetailImages,
  getOzonStockItemQuantity,
  getOzonStockItemsFromSource,
  getOzonStockItemWarehouseId,
  stripHtmlText,
  toDisplayDimensionCm,
  toDisplayWeightKg,
  toFiniteNumber,
  toOzonDimensionMm,
  toOzonWeightGrams,
} from './productAttributes.jsx';

export function getOzonStockItemKey(item = {}, index = 0) {
  const warehouseId = getOzonStockItemWarehouseId(item);
  const source = normalizeOzonId(
    firstFilled(
      item?.source,
      item?.type,
      item?.stock_type,
      item?.stockType,
      item?.delivery_schema,
      item?.deliverySchema
    )
  );
  const sku = normalizeOzonId(firstFilled(item?.sku, item?.fbs_sku, item?.product_id, item?.offer_id));
  if (warehouseId || source || sku) return [warehouseId, source, sku].join(':');
  return `index:${index}`;
}

export function sumOzonStockItems(stockItems = []) {
  const seen = new Set();
  return stockItems.reduce((sum, item, index) => {
    const key = getOzonStockItemKey(item, index);
    if (seen.has(key)) return sum;
    seen.add(key);
    return sum + (getOzonStockItemQuantity(item) ?? 0);
  }, 0);
}

export function getOzonProductStock(detail, stockInfo) {
  const stockInfoItems = getOzonStockItemsFromSource(stockInfo);
  if (stockInfoItems.length > 0) return sumOzonStockItems(stockInfoItems);

  const detailItems = getOzonStockItemsFromSource(detail);
  if (detailItems.length > 0) return sumOzonStockItems(detailItems);

  const directValue = getOzonStockItemQuantity(stockInfo);
  if (directValue !== null) return directValue;

  const detailDirectValue = getOzonStockItemQuantity(detail);
  if (detailDirectValue !== null) return detailDirectValue;
  return null;
}

export function getOzonWarehouseId(stockInfo) {
  const stockItems = Array.isArray(stockInfo?.stocks) ? stockInfo.stocks : [];
  const itemWithWarehouse = stockItems.find((item) => item.warehouse_id || item.warehouseId);
  const value = itemWithWarehouse?.warehouse_id ?? itemWithWarehouse?.warehouseId ?? stockInfo?.warehouse_id;
  return value ? String(value) : '';
}

export function findKnownProductDimensionValue(source, names) {
  const directValue = findDirectByKeys(source, names);
  if (directValue !== undefined) return directValue;
  const containers = [
    source?.dimensions,
    source?.dimension,
    source?.package_dimensions,
    source?.packageDimensions,
    source?.size,
    source?.measurement,
  ];
  for (const container of containers) {
    const value = findDirectByKeys(container, names);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function getOzonDimensionValue(detail, attributes, names, type, unit) {
  const detailValue = findKnownProductDimensionValue(detail, names);
  const attributeDirectValue = findKnownProductDimensionValue(attributes, names);
  const value =
    detailValue !== undefined
      ? detailValue
      : attributeDirectValue !== undefined
        ? attributeDirectValue
        : getAttributeValue(attributes, names);
  return type === 'weight' ? toDisplayWeightKg(value, unit) : toDisplayDimensionCm(value, unit);
}

export function getEstimatedProfit(
  priceValue,
  commissionPercent,
  currencyCode,
  purchaseCost,
  freightCost,
  options = {}
) {
  const purchase = toFiniteNumber(purchaseCost);
  const freight = toFiniteNumber(freightCost);
  const priceCny = convertFeeAmountToCny(priceValue, currencyCode, { rubToCnyRate: options.rubToCnyRate });
  const commissionValue = calculateCommissionFeeCny({
    orderAmount: priceValue,
    orderCurrency: currencyCode,
    commissionPercent,
    rubToCnyRate: options.rubToCnyRate,
  });
  const value = calculateEstimatedProfitCny({
    orderPaymentCny: priceCny,
    sourcePurchaseCostCny: purchase,
    commissionFeeCny: commissionValue,
    acquiringFeeCny: null,
    deliveryServiceFeeCny: null,
    crossBorderBusFeeCny: null,
    logisticsFeeCny: freight,
  });
  return value === null ? '待确认' : formatOzonPrice(value, 'CNY');
}

export function getProductRowShopScopeKey(product = {}) {
  return String(
    firstFilled(
      product.localShopKey,
      product.shopClientId,
      product.shopId,
      product.sellerId,
      product.shop,
      product.shopName,
      product.raw?.entity?.localShopKey,
      'unknown-shop'
    )
  ).trim();
}

export function getProductSelectionKey(product) {
  const identity = String(product?.productId || product?.sku || product?.offerId || product?.id || '').trim();
  if (!identity) return '';
  return `${getProductRowShopScopeKey(product)}:${identity}`;
}

export function getProductFeeBreakdown(product) {
  return [
    { label: '佣金金额', value: product?.commissionAmount || '待确认' },
    { label: '收单费', value: product?.acquiringFee || '待确认' },
    { label: '里程费', value: product?.mileageFee || '待确认' },
    { label: '单笔合计', value: product?.feeTotal || '待确认', total: true },
  ];
}

export function compactObject(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    })
  );
}

export function cleanDecimal(value) {
  const number = toFiniteNumber(value);
  return number === null ? '' : String(number);
}

export function cleanInteger(value) {
  const number = toFiniteNumber(value);
  return number === null ? '' : String(Math.max(0, Math.round(number)));
}

export function getProductOperationLabel(product = {}) {
  return product.offerId || product.sku || product.productId || product.name || '当前商品';
}

export function normalizeAttributeText(value) {
  return stripHtmlText(value).toLowerCase();
}

export function getAttributeFormValues(rows) {
  return Object.fromEntries(rows.map((row) => [row.id, row.value || '']));
}

export function getAttributeComparableRows(form) {
  return Array.isArray(form?.attributeRows) ? form.attributeRows : [];
}

export function getChangedAttributeRows(rows, formValues = {}) {
  return rows.filter((row) => {
    const nextValue = formValues[row.id] ?? '';
    return normalizeAttributeText(nextValue) !== normalizeAttributeText(row.value);
  });
}

function normalizeOzonDictionaryValueId(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : text;
}

export function createOzonAttributeValueObjects(value, dictionaryValueIds = []) {
  const valueIds = Array.isArray(dictionaryValueIds) ? dictionaryValueIds : [];
  return String(value ?? '')
    .split(/[、,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => compactObject({
      value: item,
      dictionary_value_id: normalizeOzonDictionaryValueId(valueIds[index]),
    }));
}

export function normalizeOriginalAttributeValues(attribute) {
  const values = Array.isArray(attribute?.values) ? attribute.values : [];
  if (values.length > 0) {
    return values
      .map((item) => {
        if (item && typeof item === 'object') {
          return compactObject({
            value: item.value ?? item.dictionary_value ?? item.name,
            dictionary_value_id: item.dictionary_value_id ?? item.value_id,
          });
        }
        return { value: String(item ?? '') };
      })
      .filter((item) => item.value || item.dictionary_value_id);
  }
  const value = attribute?.value ?? attribute?.dictionary_value ?? attribute?.name;
  return value === undefined || value === null || value === '' ? [] : [{ value: String(value) }];
}

export function buildOzonEditableAttributes(rows = [], formValues = {}, dictionaryValueIds = {}) {
  return rows
    .map((row) => {
      const id = row.attributeId || getAttributeId(row.sourceAttribute) || getAttributeId(row.definition);
      if (!id) return null;
      const nextValue = formValues[row.id] ?? '';
      const changed = normalizeAttributeText(nextValue) !== normalizeAttributeText(row.value);
      const values = changed
        ? createOzonAttributeValueObjects(nextValue, dictionaryValueIds[row.id])
        : normalizeOriginalAttributeValues(row.sourceAttribute);
      if (values.length === 0) return null;
      const complexId = row.sourceAttribute?.complex_id ?? row.definition?.complex_id;
      return compactObject({
        complex_id: complexId === undefined || complexId === null || complexId === '' ? undefined : Number(complexId),
        id: Number(id),
        values,
      });
    })
    .filter(Boolean);
}

export function createProductEditForm(product) {
  return {
    name: product?.name || '',
    price: product?.priceValue === null ? '' : formatPlainNumber(product?.priceValue),
    oldPrice: product?.oldPriceValue === null ? '' : formatPlainNumber(product?.oldPriceValue),
    stock:
      product?.stock === null || product?.stock === undefined
        ? product?.stockValue === null || product?.stockValue === undefined
          ? ''
          : String(product.stockValue)
        : String(product.stock),
    weight: product?.weight || '',
    length: product?.length || '',
    width: product?.width || '',
    height: product?.height || '',
    materialSource: getProductMaterialSource(product),
    images: Array.isArray(product?.images) ? product.images : [],
    detailImages: getOzonDetailImages(product),
    attributeValues: {},
    attributeDictionaryValueIds: {},
    attributeRows: [],
    attributes: Array.isArray(product?.attributes) ? product.attributes : [],
  };
}

export function normalizeImageList(images) {
  return (images || []).map(getImageUrlFromValue).filter(Boolean);
}

export function isRemoteImageUrl(image) {
  return /^https?:\/\//i.test(String(image || '').trim());
}

export function normalizeRemoteImageList(images) {
  return normalizeImageList(images).filter(isRemoteImageUrl);
}

export function safeImageUrl(image) {
  const url = getImageUrlFromValue(image);
  return isRemoteImageUrl(url) || /^data:image\//i.test(url) || url.startsWith('/') ? url : '';
}

export function readImageFilesAsDataUrls(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith('image/'));
  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
          reader.readAsDataURL(file);
        })
    )
  );
}

export const MIN_PRODUCT_IMAGE_SLOTS = 5;

export function createProductImageSlots(images) {
  const filledSlots = normalizeImageList(images).map((image, index) => ({
    type: 'image',
    image,
    index,
    key: `${image}-${index}`,
  }));
  const emptyCount = Math.max(MIN_PRODUCT_IMAGE_SLOTS - filledSlots.length, 1);
  const emptySlots = Array.from({ length: emptyCount }, (_, index) => ({
    type: 'empty',
    index,
    key: `empty-${index}`,
  }));
  return [...filledSlots, ...emptySlots];
}

export function reorderItems(items, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function getMovedActiveIndex(activeIndex, fromIndex, toIndex) {
  if (activeIndex === fromIndex) return toIndex;
  if (fromIndex < toIndex && activeIndex > fromIndex && activeIndex <= toIndex) return activeIndex - 1;
  if (fromIndex > toIndex && activeIndex >= toIndex && activeIndex < fromIndex) return activeIndex + 1;
  return activeIndex;
}

export function hasLocalPreviewImages(form) {
  return [...normalizeImageList(form?.images), ...normalizeImageList(form?.detailImages)].some(
    (image) => !isRemoteImageUrl(image)
  );
}

export function hasProductDetailsChanged(product, form) {
  if (!product) return false;
  const currentImages = normalizeRemoteImageList(product.images);
  const nextImages = normalizeRemoteImageList(form.images);
  const changedAttributes = getChangedAttributeRows(getAttributeComparableRows(form), form.attributeValues);
  return (
    String(form.name || '').trim() !== String(product.name || '').trim() ||
    cleanDecimal(form.weight) !== cleanDecimal(product.weight) ||
    cleanDecimal(form.length) !== cleanDecimal(product.length) ||
    cleanDecimal(form.width) !== cleanDecimal(product.width) ||
    cleanDecimal(form.height) !== cleanDecimal(product.height) ||
    changedAttributes.length > 0 ||
    currentImages.length !== nextImages.length ||
    currentImages.some((image, index) => image !== nextImages[index])
  );
}

export function hasDetailImagesChanged(product, form) {
  const currentImages = normalizeImageList(getOzonDetailImages(product));
  const nextImages = normalizeImageList(form.detailImages);
  return (
    currentImages.length !== nextImages.length || currentImages.some((image, index) => image !== nextImages[index])
  );
}

export function hasPriceChanged(product, form) {
  return (
    cleanDecimal(form.price) !== cleanDecimal(product?.priceValue) ||
    cleanDecimal(form.oldPrice) !== cleanDecimal(product?.oldPriceValue)
  );
}

export function hasStockChanged(product, form) {
  return cleanInteger(form.stock) !== cleanInteger(product?.stock);
}

export function getOzonImportTaskId(data) {
  const candidates = [
    data,
    data?.data,
    data?.result,
    data?.confirm,
    data?.confirm?.schedulerResult,
    data?.confirm?.schedulerResult?.data,
    data?.schedulerResult,
    data?.schedulerResult?.data,
  ];
  for (const item of candidates) {
    const taskId = item?.result?.task_id ?? item?.task_id ?? item?.result?.id ?? item?.id;
    if (taskId) return taskId;
  }
  return '';
}

export function getProductWriteShopId(shop = {}) {
  return shop?.id || shop?.shopId || '';
}

export function createProductWriteIdempotencyKey(action, shop, subject = '') {
  const shopId = getProductWriteShopId(shop) || 'unknown-shop';
  const suffix = subject ? String(subject).replace(/\s+/g, '-').slice(0, 80) : 'item';
  return `${action}:${shopId}:${suffix}:${Date.now()}`;
}

export function getProductWriteErrorCode(result = {}) {
  return result?.error?.code || result?.confirm?.error?.code || result?.schedulerResult?.error?.code || '';
}

export function isProductWriteRealWriteDisabled(result = {}) {
  return getProductWriteErrorCode(result) === 'REAL_OZON_WRITE_DISABLED';
}

export function isProductWriteShopMissing(result = {}) {
  return getProductWriteErrorCode(result) === 'REAL_OZON_WRITE_SHOP_ID_REQUIRED';
}

export function isProductWriteExecutionNotConnected(result = {}) {
  const code = getProductWriteErrorCode(result);
  return code === 'WRITE_EXECUTION_NOT_CONNECTED' || code === 'REAL_OZON_WRITE_DISABLED';
}

export function getProductWriteReadBackStatus(result = {}) {
  return String(
    result?.readBack?.status || result?.confirm?.readBack?.status || result?.schedulerResult?.readBack?.status || ''
  ).trim();
}

export function isProductWriteReadBackMerged(result = {}) {
  return getProductWriteReadBackStatus(result) === 'merged';
}

export function getProductStockWriteBatchStatus(result = {}) {
  if (isProductWriteExecutionNotConnected(result)) return 'guarded';
  if (
    result?.ok === false ||
    result?.confirm?.ok === false ||
    result?.writeStatus === 'write_failed' ||
    result?.confirm?.writeStatus === 'write_failed' ||
    result?.schedulerResult?.status === 'failed' ||
    result?.confirm?.schedulerResult?.status === 'failed'
  ) {
    return 'failed';
  }
  return 'success';
}

export const PRODUCT_FAST_WRITE_OPTIONS = Object.freeze({
  confirmed: true,
  realWrite: true,
  dryRun: false,
  waitForResult: true,
  timeoutMs: 30_000,
});

export function createProductFastWriteOptions(options = {}) {
  return {
    ...PRODUCT_FAST_WRITE_OPTIONS,
    ...options,
    confirmed: true,
    realWrite: true,
    dryRun: false,
    waitForResult: true,
    timeoutMs: Number(options.timeoutMs) > 0 ? options.timeoutMs : PRODUCT_FAST_WRITE_OPTIONS.timeoutMs,
  };
}

export function getProductWriteRawErrorMessage(result = {}) {
  if (result instanceof Error) return result.message;
  if (typeof result === 'string') return result;
  const candidates = [
    result?.message,
    result?.error?.message,
    result?.errorMessage,
    result?.lastError,
    result?.last_error,
    result?.payload?.error?.message,
    result?.confirm?.error?.message,
    result?.confirm?.lastError,
    result?.confirm?.last_error,
    result?.confirm?.schedulerResult?.error?.message,
    result?.confirm?.schedulerResult?.job?.lastError,
    result?.confirm?.schedulerResult?.job?.last_error,
    result?.schedulerResult?.error?.message,
    result?.schedulerResult?.job?.lastError,
    result?.schedulerResult?.job?.last_error,
    result?.job?.lastError,
    result?.job?.last_error,
    result?.rawText,
  ];
  return String(candidates.find((message) => message !== undefined && message !== null && message !== '') || '').trim();
}

export function getProductWriteFailureMessage(result = {}, actionText = '商品写入') {
  if (isProductWriteRealWriteDisabled(result)) {
    return '真实写入未开启，本次不会提交 Ozon。';
  }
  if (isProductWriteShopMissing(result)) {
    return '店铺缺少真实写入配置，本次不会提交 Ozon。';
  }
  if (isProductWriteExecutionNotConnected(result)) {
    return '已通过写入安全门确认，但真实 Ozon 写入执行器未连接；本次没有提交 Ozon。';
  }

  const rawMessage = getProductWriteRawErrorMessage(result);
  if (/OZON_WRITE_APPLICATION_ERROR|PRODUCT_IS_ARCHIVED|archived product|Can't set positive stock/i.test(rawMessage)) {
    return 'Ozon 拒绝库存写入：商品已归档或已下架，不能设置正库存；页面已回滚本地库存显示。';
  }
  if (/restore\s+limit\s+exceeded/i.test(rawMessage)) {
    return 'Ozon 拒绝上架：该商品为 Ozon 自动归档商品，恢复额度已超限。本次未完成上架，状态已回滚。';
  }
  if (/rate.?limit|too\s+many\s+requests|HTTP\s*429|\b429\b/i.test(rawMessage)) {
    return 'Ozon 限流：请求过于频繁，请稍后再试。本次页面不会假显示完成。';
  }
  if (
    /HTTP\s*(401|403)|\b(401|403)\b|credential|api[-_\s]?key|client[-_\s]?id|unauthorized|forbidden/i.test(rawMessage)
  ) {
    return 'Ozon 授权失败：请检查店铺 Client-Id / Api-Key，本次未完成写入。';
  }
  if (/warehouse|склад|仓库/i.test(rawMessage)) {
    return 'Ozon 拒绝库存写入：仓库配置或仓库 ID 不可用，请检查默认仓和商品仓库。';
  }
  if (/stock|остат|库存/i.test(rawMessage)) {
    return 'Ozon 拒绝库存写入：请检查库存数量、商品状态和仓库。';
  }
  if (/local-api 请求超时|LOCAL_API_TIMEOUT|timeout|aborted/i.test(rawMessage)) {
    return '已提交或请求超时，正在等待 Ozon 回读，不能标记为完成。';
  }
  return rawMessage || `${actionText}失败，请稍后重试。`;
}

export function getProductWriteMessage(result = {}) {
  if (isProductWriteRealWriteDisabled(result)) {
    return '真实写入未开启，本次不会提交 Ozon。';
  }
  if (isProductWriteShopMissing(result)) {
    return '店铺缺少真实写入配置，本次不会提交 Ozon。';
  }
  if (isProductWriteExecutionNotConnected(result)) {
    return '已通过写入安全门确认，但真实 Ozon 写入执行器未连接；本次没有提交 Ozon。';
  }
  return getProductWriteFailureMessage(result);
}

export function buildProductInfoWriteCommand(shop, product, form, options = {}) {
  if (!product.offerId) throw new Error('缺少货号，无法提交商品资料');
  if (!product.descriptionCategoryId || !product.typeId) {
    throw new Error('缺少 Ozon 类目或商品类型，无法提交商品资料');
  }
  const allImages = normalizeImageList(form.images);
  if (allImages.some((image) => !isRemoteImageUrl(image))) {
    throw new Error('本地上传图片当前只用于预览。同步到 Ozon 需要先接入图片上传接口或图片地址。');
  }
  const images = [...new Set(normalizeRemoteImageList(form.images))];
  const attributes = Array.isArray(form.attributes) && form.attributes.length > 0 ? form.attributes : product.attributes;
  const item = compactObject({
    offer_id: product.offerId,
    name: form.name.trim(),
    description_category_id: Number(product.descriptionCategoryId),
    type_id: Number(product.typeId),
    currency_code: product.currencyCode || 'CNY',
    old_price: cleanDecimal(form.oldPrice) || '0',
    price: cleanDecimal(form.price),
    vat: product.vat || '0',
    weight: toOzonWeightGrams(form.weight),
    weight_unit: 'g',
    depth: toOzonDimensionMm(form.length),
    width: toOzonDimensionMm(form.width),
    height: toOzonDimensionMm(form.height),
    dimension_unit: 'mm',
    primary_image: images[0] || '',
    images,
    attributes,
  });
  return {
    shopId: getProductWriteShopId(shop),
    payload: { items: [item] },
    before: product,
    after: { items: [item] },
    idempotencyKey: createProductWriteIdempotencyKey('product.updateInfo', shop, product.offerId || product.productId),
    requestedBy: options.requestedBy || 'product-card-save',
  };
}

export function buildProductPriceWriteCommand(shop, product, form, options = {}) {
  const price = cleanDecimal(form.price);
  if (!price) throw new Error('价格不能为空');
  const priceItem = compactObject({
    offer_id: product.offerId,
    product_id: product.productId ? Number(product.productId) : undefined,
    price,
    old_price: cleanDecimal(form.oldPrice) || undefined,
    min_price: product.minPrice ? cleanDecimal(product.minPrice) : undefined,
    currency_code: product.currencyCode || 'CNY',
  });
  return {
    shopId: getProductWriteShopId(shop),
    payload: { prices: [priceItem] },
    before: { product_id: product.productId, offer_id: product.offerId, price: product.price, oldPrice: product.oldPrice },
    after: { prices: [priceItem] },
    idempotencyKey: createProductWriteIdempotencyKey('product.updatePrice', shop, product.offerId || product.productId),
    requestedBy: options.requestedBy || 'product-card-price',
  };
}

export const OZON_STOCK_WRITE_BATCH_SIZE = 50;

export function buildOzonStockUpdateItem(product, stock) {
  return compactObject({
    offer_id: product.offerId,
    product_id: product.productId ? Number(product.productId) : undefined,
    stock: Number(stock),
    warehouse_id: Number(product.warehouseId),
  });
}

export function buildProductStockWriteCommand(shop, stockItems, options = {}) {
  if (!Array.isArray(stockItems) || stockItems.length === 0) throw new Error('缺少库存写入数据');
  return {
    shopId: getProductWriteShopId(shop),
    payload: { stocks: stockItems },
    before: options.before || null,
    after: { stocks: stockItems },
    idempotencyKey: options.idempotencyKey || createProductWriteIdempotencyKey(
      'product.updateStock',
      shop,
      stockItems.map((item) => item.offer_id || item.product_id).join('-'),
    ),
    requestedBy: options.requestedBy || 'product-stock-update',
  };
}

export function buildSingleProductStockWriteCommand(shop, product, form, options = {}) {
  const stock = cleanInteger(form.stock);
  if (stock === '') throw new Error('库存不能为空');
  if (!product.warehouseId) throw new Error('缺少可写入仓库 ID，无法更新库存');
  return buildProductStockWriteCommand(shop, [buildOzonStockUpdateItem(product, stock)], {
    ...options,
    before: product,
  });
}

export function buildProductArchiveWriteCommand(shop, products, action, options = {}) {
  const rows = Array.isArray(products) ? products : [products];
  const productIds = rows.map((product) => Number(product?.productId)).filter(Number.isFinite);
  if (productIds.length === 0) throw new Error('缺少 Ozon 商品 ID，不能执行上下架。');
  const payload = { product_id: productIds };
  return {
    shopId: getProductWriteShopId(shop),
    payload,
    before: rows.map((product) => ({
      product_id: product.productId,
      offer_id: product.offerId,
      visibility: product.visibility,
      statusLabel: product.statusLabel,
    })),
    after: { ...payload, visibility: action === 'archive' ? 'ARCHIVED' : 'TO_SUPPLY' },
    idempotencyKey: createProductWriteIdempotencyKey(
      action === 'archive' ? 'product.archive' : 'product.unarchive',
      shop,
      productIds.join('-'),
    ),
    requestedBy: options.requestedBy || 'product-list-archive',
  };
}

export function getBusinessOzonStockError(error) {
  const message = getProductWriteRawErrorMessage(error);
  if (/HTTP\s*500/i.test(message)) return 'Ozon 库存接口当前返回异常，请稍后重试。';
  if (/HTTP\s*429/i.test(message)) return 'Ozon 请求过于频繁，请稍后再试。';
  if (/HTTP\s*(401|403)/i.test(message)) return '店铺授权失败，请检查 Ozon 店铺密钥。';
  if (/warehouse|仓库/i.test(message)) return '仓库配置异常，请检查商品仓库或默认仓。';
  if (/stock|库存/i.test(message)) return '库存设置失败，请检查库存数量和商品状态。';
  return message || '库存设置失败，请稍后重试。';
}

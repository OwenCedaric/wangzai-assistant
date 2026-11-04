import { getDomainCache } from '../../api/localApiClient';
import { assertExternalInterfaceAllowed } from '../../services/externalInterfaceRegistry';
import { requestOrderWriteOperation } from '../../services/orderWriteClient';
import { requestReturnsWriteOperation } from '../../services/returnsWriteClient';
import { LOCAL_OZON_DATA_LAYER_FILE_KEY, OZON_WRITE_TIMEOUT_MS } from '../../shared/config/appConfigCore.jsx';
import { requestOzonReadOnly } from '../../shared/ozon/ozonRuntime.jsx';
import {
  canUseOzonShop,
  firstFilled,
  firstUsableOzonId,
  normalizeOzonId,
  ozonProtectedOrderOperations,
} from '../order/orderShopScope.jsx';
import { getAfterSalesPostingLookupKeys, getAfterSalesRefundLossRuleState } from '../order/orderAsyncRules.jsx';
import { hasAfterSalesOriginalOrderCheck } from '../order/afterSalesOriginalOrderRules.jsx';
import { mergeAfterSalesOriginalOrderEvidence } from '../order/afterSalesOriginalOrderEvidence.jsx';
import { isLowPriorityAfterSalesReason, isMissingAfterSalesReason } from '../order/afterSalesReasonRules.jsx';
import { getAfterSalesProductLookupKeys } from '../order/afterSalesProductRules.jsx';
import { dedupeOzonAfterSalesProductsBySource, getOzonOrderProducts } from '../order/orderDisplayFormat.jsx';
import { getAfterSalesOrderRecordKey } from '../order/orderRecordRules.jsx';
import { getSalesOrderRawPosting } from '../order/orderRawFields.jsx';
import { readOzonLocalProductEntityRows } from '../product/productLocalMirror.jsx';
import { getOzonPayloadItems } from '../product/productOzonApi.jsx';
import { firstFiniteNumber } from '../product/productAttributes.jsx';
import { normalizeImageList, safeImageUrl } from '../product/productImageRules.jsx';
import {
  enrichSalesOrderWithCrossBorderDetail,
  normalizeOzonAfterSalesRow,
  normalizeOzonSalesOrderRow,
} from '../profit/profitOrderSnapshot.jsx';
import { getProfitPostingLookupKeys } from '../profit/profitPostingRules.jsx';

export function indexLocalOriginalOrderRowsForAfterSales(rows = []) {
  const index = new Map();
  rows.forEach((order) => {
    getProfitPostingLookupKeys(
      order.posting_number,
      order.postingNumber,
      order.posting,
      order.order_id,
      order.orderId,
      order.raw?.posting_number,
      order.raw?.postingNumber,
      order.raw?.order_id,
      order.raw?.orderId
    ).forEach((key) => {
      if (key && !index.has(key)) index.set(key, order);
    });
  });
  return index;
}

export async function readLocalOriginalOrderRowsForAfterSales(shop, rows = [], options = {}) {
  const shopId = shop?.id || shop?.shopId || '';
  if (!shopId || !rows.length) return [];
  const postingNumbers = [
    ...new Set(
      rows
        .flatMap((row) => getAfterSalesPostingLookupKeys(row))
        .map((value) => normalizeOzonId(value).trim())
        .filter(Boolean)
    ),
  ];
  if (!postingNumbers.length) return [];

  const chunkSize = 120;
  const chunks = [];
  for (let index = 0; index < postingNumbers.length; index += chunkSize) {
    chunks.push(postingNumbers.slice(index, index + chunkSize));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      getDomainCache(
        'orders',
        {
          shopId,
          postingNumbers: chunk.join(','),
          pageSize: chunk.length,
        },
        { timeoutMs: options.timeoutMs ?? 5000, signal: options.signal }
      ).catch(() => null)
    )
  );

  return results.flatMap((result) => (Array.isArray(result?.rows) ? result.rows : []));
}

export async function enrichAfterSalesRowsWithLocalOriginalOrderEvidence(shop, rows = [], options = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!sourceRows.length || !canUseOzonShop(shop)) return sourceRows;
  const localOrders = await readLocalOriginalOrderRowsForAfterSales(shop, sourceRows, options);
  if (!localOrders.length) return sourceRows;

  const originalOrderIndex = indexLocalOriginalOrderRowsForAfterSales(localOrders);
  return sourceRows.map((row) => {
    const originalOrder = getAfterSalesPostingLookupKeys(row)
      .map((key) => originalOrderIndex.get(key))
      .find(Boolean);
    if (!originalOrder) return row;
    const source = row.source || row.raw?.source || 'returns';
    const raw = mergeAfterSalesOriginalOrderEvidence(row.raw ?? row, originalOrder);
    return normalizeOzonAfterSalesRow(raw, { source, shop });
  });
}

export function shouldReadAfterSalesOriginalOrderDetail(row = {}) {
  const posting = firstUsableOzonId(row.salesOrder, row.posting, row.id);
  if (!posting) return false;
  const source = row.source || row.raw?.source;
  const hasOriginalOrderCheck = hasAfterSalesOriginalOrderCheck(row);
  if (source !== 'rfbs-return') return isMissingAfterSalesReason(row.reason) && !hasOriginalOrderCheck;
  return !hasOriginalOrderCheck;
}

export function shouldRequestAfterSalesRefundFinanceEvidence(row = {}) {
  if (row.financeRefundChecked || row.raw?.financeRefundChecked || row.raw?.financeRefundEvidence?.checked)
    return false;
  const source = row.source || row.raw?.source || 'returns';
  const ruleState = getAfterSalesRefundLossRuleState(row.raw ?? row, source);
  return (
    (ruleState.hasRefusedAndDestroyedEvidence && !ruleState.originalOrderEvidence.delivered) ||
    ruleState.originalOrderEvidence.delivered ||
    ruleState.deliveryEvidence.delivered
  );
}

export { hasAfterSalesOriginalOrderCheck };

export async function enrichAfterSalesRowsWithLocalProductSummary(shop, rows = [], options = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!sourceRows.length || !canUseOzonShop(shop)) return sourceRows;
  const result = await readOzonLocalProductEntityRows(
    options.localDataFileKey || LOCAL_OZON_DATA_LAYER_FILE_KEY,
    sourceRows,
    [shop],
    getAfterSalesOrderRecordKey,
    {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }
  ).catch(() => null);
  return result?.rows?.length ? result.rows : sourceRows;
}

export { getAfterSalesProductLookupKeys };

export function getAfterSalesOrderCardProductQty(product = {}) {
  const raw = product.raw ?? {};
  const qty = firstFiniteNumber(
    product.qty,
    product.quantity,
    product.count,
    product.returnQuantity,
    product.return_quantity,
    product.returnedQuantity,
    product.returned_quantity,
    raw.qty,
    raw.quantity,
    raw.count,
    raw.returnQuantity,
    raw.return_quantity,
    raw.returnedQuantity,
    raw.returned_quantity
  );
  return qty !== null && qty > 0 ? qty : 1;
}

export function getAfterSalesOrderCardProductMergeKey(product = {}, index = 0) {
  const key = getAfterSalesProductLookupKeys(product)[0];
  if (key) return `id:${key}`;

  const raw = product.raw ?? {};
  const name = String(
    firstFilled(product.name, product.productName, product.title, raw.name, raw.product_name, raw.title) || ''
  ).trim();
  if (name && name !== '未返回') {
    const price = String(firstFilled(product.price, product.refundPrice, raw.price, raw.refund_price) || '').trim();
    return `name:${name.toLowerCase()}:${price}`;
  }

  return `row:${index}`;
}

export function mergeAfterSalesOrderCardProduct(baseProduct = {}, nextProduct = {}) {
  const baseQty = getAfterSalesOrderCardProductQty(baseProduct);
  const nextQty = getAfterSalesOrderCardProductQty(nextProduct);
  const totalQty = baseQty + nextQty;
  const mergedImages = normalizeImageList([
    baseProduct.image,
    baseProduct.skuImage,
    baseProduct.mainImage,
    baseProduct.productMainImage,
    ...(Array.isArray(baseProduct.images) ? baseProduct.images : []),
    ...(Array.isArray(baseProduct.skuImages) ? baseProduct.skuImages : []),
    ...(Array.isArray(baseProduct.mainImages) ? baseProduct.mainImages : []),
    nextProduct.image,
    nextProduct.skuImage,
    nextProduct.mainImage,
    nextProduct.productMainImage,
    ...(Array.isArray(nextProduct.images) ? nextProduct.images : []),
    ...(Array.isArray(nextProduct.skuImages) ? nextProduct.skuImages : []),
    ...(Array.isArray(nextProduct.mainImages) ? nextProduct.mainImages : []),
  ]);

  return {
    ...baseProduct,
    name: firstFilled(baseProduct.name, nextProduct.name) || '未返回',
    sku: firstFilled(baseProduct.sku, nextProduct.sku) || '未返回',
    offerId: firstFilled(baseProduct.offerId, nextProduct.offerId),
    skuId: firstFilled(baseProduct.skuId, nextProduct.skuId),
    productId: firstFilled(baseProduct.productId, nextProduct.productId),
    qty: totalQty,
    mergedQty: totalQty,
    mergedCount: (baseProduct.mergedCount || 1) + (nextProduct.mergedCount || 1),
    image: baseProduct.image || nextProduct.image || mergedImages[0] || '',
    images: mergedImages.length ? mergedImages : baseProduct.images,
    skuImage: baseProduct.skuImage || nextProduct.skuImage || mergedImages[0] || '',
    mainImage: baseProduct.mainImage || nextProduct.mainImage || '',
    productMainImage: baseProduct.productMainImage || nextProduct.productMainImage || '',
  };
}

export function mergeAfterSalesOrderCardProducts(products = []) {
  const productList = Array.isArray(products) ? dedupeOzonAfterSalesProductsBySource(products) : [];
  const mergedMap = new Map();
  const mergedRows = [];

  productList.forEach((product, index) => {
    const key = getAfterSalesOrderCardProductMergeKey(product, index);
    const current = mergedMap.get(key);
    if (!current) {
      const qty = getAfterSalesOrderCardProductQty(product);
      const normalizedProduct = {
        ...product,
        qty,
        mergedQty: qty,
        mergedCount: 1,
      };
      mergedMap.set(key, normalizedProduct);
      mergedRows.push(normalizedProduct);
      return;
    }

    const mergedProduct = mergeAfterSalesOrderCardProduct(current, product);
    mergedMap.set(key, mergedProduct);
    const rowIndex = mergedRows.indexOf(current);
    if (rowIndex >= 0) mergedRows[rowIndex] = mergedProduct;
  });

  return mergedRows;
}

export function getAfterSalesOrderCardProductImage(product = {}) {
  const raw = product.raw ?? {};
  return (
    safeImageUrl(
      firstFilled(
        product.image,
        product.skuImage,
        product.mainImage,
        product.productMainImage,
        Array.isArray(product.images) ? product.images[0] : '',
        Array.isArray(product.skuImages) ? product.skuImages[0] : '',
        Array.isArray(product.mainImages) ? product.mainImages[0] : '',
        raw.image,
        raw.sku_image,
        raw.primary_image,
        raw.main_image
      )
    ) || ''
  );
}

export { isLowPriorityAfterSalesReason, isMissingAfterSalesReason };

export async function requestOzonSalesOrderDetail(shop, order, options = {}) {
  if (!order?.posting || order.posting === '未返回') return order;
  const isFbo = order.fulfillment === 'FBO';
  const data = await requestOzonReadOnly(isFbo ? '/v2/posting/fbo/get' : '/v3/posting/fbs/get', shop, {
    posting_number: order.posting,
    translit: true,
    forceRefresh: options.forceRefresh === true,
    syncSource: options.syncSource || (options.forceRefresh === true ? 'explicit-order-operation' : ''),
    requestedBy: options.requestedBy || (options.forceRefresh === true ? 'frontend-explicit-order-operation' : ''),
    priority: options.priority || '',
    profile: options.profile || options.schedulerProfile || '',
    schedulerProfile: options.schedulerProfile || options.profile || '',
    with: isFbo
      ? { analytics_data: true, financial_data: true }
      : {
          analytics_data: true,
          barcodes: true,
          financial_data: true,
          product_exemplars: true,
          related_postings: true,
          translit: true,
        },
  }, {
    timeoutMs: options.timeoutMs,
    orderSyncTimeoutMs: options.orderSyncTimeoutMs,
    orderSyncPollIntervalMs: options.orderSyncPollIntervalMs,
    signal: options.signal,
  });
  const normalized = normalizeOzonSalesOrderRow(data?.result ?? data, { source: order.fulfillment, shop });
  return enrichSalesOrderWithCrossBorderDetail({ ...order, ...normalized });
}

export function getOzonOrderWriteShopId(shop, body = {}) {
  return String(shop?.id || shop?.shopId || body?.shopId || body?.shop_id || '').trim();
}

export function getOzonOrderWriteReference(body = {}) {
  const postingNumber = Array.isArray(body?.posting_number) ? body.posting_number.join(',') : body?.posting_number;
  const postingNumbers = Array.isArray(body?.postingNumbers) ? body.postingNumbers.join(',') : body?.postingNumbers;
  return String(
    firstFilled(
      postingNumber,
      postingNumbers,
      body?.postingNumber,
      body?.task_id,
      body?.taskId,
      body?.order_id,
      body?.orderId,
      body?.package_id,
      body?.packageId,
      body?.return_id,
      body?.returnId,
      body?.cancellation_id,
      body?.cancellationId,
      body?.id
    )
  ).trim();
}

export async function requestProtectedOzonOrderOperation(operationId, shop, body, { confirmed = false } = {}) {
  const operation = ozonProtectedOrderOperations[operationId];
  if (!operation) throw new Error('未找到对应 Ozon 订单操作');
  if (!confirmed) {
    throw new Error(`${operation.title} 是真实写入操作，需要二次确认后才能执行。`);
  }
  if (!operation.endpointKey) {
    throw new Error(`${operation.title} 尚未接入写入安全门，已阻止旧入口真实写入。`);
  }
  assertExternalInterfaceAllowed({
    provider: 'ozon',
    endpoint: operation.endpoint,
    method: 'POST',
    access: 'write',
    confirmed: true,
  });

  const shopId = getOzonOrderWriteShopId(shop, body);
  const reference = getOzonOrderWriteReference(body);
  const writeDomain = operation.domain || 'orders';
  const writeClient =
    writeDomain === 'returns'
      ? requestReturnsWriteOperation
      : writeDomain === 'orders'
        ? requestOrderWriteOperation
        : null;
  if (!writeClient) {
    throw new Error(`${operation.title} 尚未接入 ${writeDomain} 写入安全门，已阻止旧入口真实写入。`);
  }
  return writeClient(
    {
      shopId,
      action: operationId,
      endpointKey: operation.endpointKey,
      payload: body,
      after: body,
      idempotencyKey: `${writeDomain}:${operationId}:${shopId || 'unknown-shop'}:${reference || Date.now()}`,
      requestedBy: writeDomain === 'returns' ? 'after-sales-page' : 'sales-order-page',
      realWrite: true,
      dryRun: false,
      waitForResult: true,
    },
    { timeoutMs: OZON_WRITE_TIMEOUT_MS }
  );
}

export function getSalesPostingNumber(order = {}) {
  const source = order || {};
  const value = firstFilled(
    source.posting,
    source.postingNumber,
    source.posting_number,
    source.id,
    source.raw?.posting_number,
    source.raw?.postingNumber
  );
  return value && value !== '未返回' ? String(value) : '';
}

export { getSalesOrderRawPosting };

export function getSalesOrderRawStatus(order = {}) {
  const source = order || {};
  const raw = getSalesOrderRawPosting(source);
  return String(firstFilled(raw.status, raw.substatus, source.raw?.status, source.raw?.substatus, source.status) || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function assertFbsSalesOrder(order = {}, actionName = '该操作') {
  const source = order || {};
  const postingNumber = getSalesPostingNumber(order);
  if (!postingNumber) throw new Error(`缺少 Ozon 货件号，不能执行${actionName}。`);
  if (String(source.fulfillment || '').toUpperCase() === 'FBO') {
    throw new Error(`FBO 平台仓订单不能在这里执行${actionName}，请到 Ozon 后台处理。`);
  }
  return postingNumber;
}

export function buildOzonShipProducts(order = {}, actionName = '确认发货') {
  const source = order || {};
  const raw = getSalesOrderRawPosting(source);
  const normalizedProducts = getOzonOrderProducts(raw);
  const products = normalizedProducts.length ? normalizedProducts : source.products || [];

  if (!products.length) throw new Error(`Ozon 没有返回商品明细，不能${actionName}。`);

  return products.map((product, index) => {
    const rawProduct = product.raw || product;
    const productId = Number(
      firstFilled(product.skuId, rawProduct.sku, rawProduct.product_id, rawProduct.productId, rawProduct.fbs_sku)
    );
    const quantity = Number(firstFilled(product.qty, rawProduct.quantity, rawProduct.qty, rawProduct.count, 1));
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new Error(`第 ${index + 1} 个商品缺少有效的 Ozon SKU ID，不能${actionName}。`);
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(`第 ${index + 1} 个商品数量无效，不能${actionName}。`);
    }
    return { product_id: productId, quantity };
  });
}

export function parseSplitQuantityPlan(value = '') {
  return String(value)
    .split(/[,\n，、\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

export function getSalesOrderSplitSourceProduct(order = {}) {
  const products = Array.isArray(order?.products) ? order.products : [];
  return products[0] ?? {};
}

export function getSalesOrderSplitProductTitle(order = {}) {
  const product = getSalesOrderSplitSourceProduct(order);
  return firstFilled(product.name, order.product, product.title, product.offerName, product.offer_name) || '未返回商品';
}

export function getSalesOrderSplitOfferText(order = {}) {
  const product = getSalesOrderSplitSourceProduct(order);
  return firstFilled(product.offerId, product.offer_id, product.sku, product.skuId, order.sku) || '未返回';
}

export function getSalesOrderSplitQuantity(order = {}) {
  const product = getSalesOrderSplitSourceProduct(order);
  const quantity = Number(firstFilled(product.qty, product.quantity, product.count, order.items, order.quantity, 0));
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

export function normalizeSalesOrderSplitPackages(order = {}, packages = []) {
  const total = getSalesOrderSplitQuantity(order);
  const values = Array.isArray(packages) ? packages : parseSplitQuantityPlan(packages);
  const normalized = values.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0);
  if (normalized.length) return normalized;
  return total > 0 ? [total] : [];
}

export function createInitialSalesOrderSplitPackages(order = {}) {
  const total = getSalesOrderSplitQuantity(order);
  return total > 0 ? [total] : [];
}

export function formatSalesOrderSplitPlan(packages = []) {
  const values = packages.filter((value) => Number.isSafeInteger(value) && value > 0);
  return values.length ? values.join(' + ') : '-';
}

export function validateSalesOrderSplitPackages(order = {}, packages = []) {
  const total = getSalesOrderSplitQuantity(order);
  const parts = normalizeSalesOrderSplitPackages(order, packages);
  if (!total || total <= 1) {
    return {
      valid: false,
      reason: '订单数量小于 2，不能拆解。',
      total,
      parts,
      sum: parts.reduce((value, item) => value + item, 0),
    };
  }
  if (parts.length < 2) {
    return { valid: false, reason: '至少需要拆成两个货件，请先新增一个货件。', total, parts, sum: parts[0] || 0 };
  }
  if (parts.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    return {
      valid: false,
      reason: '每个拆单货件数量都必须大于 0。',
      total,
      parts,
      sum: parts.reduce((value, item) => value + item, 0),
    };
  }
  const sum = parts.reduce((value, item) => value + item, 0);
  if (sum !== total) {
    return { valid: false, reason: `拆解数量合计是 ${sum}，必须等于原订单数量 ${total}。`, total, parts, sum };
  }
  return { valid: true, reason: '', total, parts, sum };
}

export function updateSalesOrderSplitPackageQuantity(order = {}, packages = [], index = 0, value = 1) {
  const total = getSalesOrderSplitQuantity(order);
  const parts = normalizeSalesOrderSplitPackages(order, packages);
  if (!Number.isSafeInteger(total) || total <= 0) return parts;
  if (!Number.isSafeInteger(index) || index < 0 || index >= parts.length) return parts;
  if (parts.length <= 1) return parts;
  const target = Math.max(1, Math.min(Math.floor(Number(value) || 1), Math.max(1, total - (parts.length - 1))));
  const delta = target - parts[index];
  parts[index] = target;
  if (delta > 0) {
    let remaining = delta;
    const donorIndexes = parts
      .map((quantity, packageIndex) => ({ packageIndex, quantity }))
      .filter((item) => item.packageIndex !== index && item.quantity > 1)
      .sort((left, right) => right.quantity - left.quantity);
    donorIndexes.forEach(({ packageIndex }) => {
      if (remaining <= 0) return;
      const taken = Math.min(remaining, parts[packageIndex] - 1);
      parts[packageIndex] -= taken;
      remaining -= taken;
    });
    if (remaining > 0) parts[index] -= remaining;
  } else if (delta < 0) {
    const receiverIndex = parts.findIndex((_, packageIndex) => packageIndex !== index);
    if (receiverIndex >= 0) parts[receiverIndex] += Math.abs(delta);
  }
  return parts;
}

export function addSalesOrderSplitPackageValue(order = {}, packages = []) {
  const total = getSalesOrderSplitQuantity(order);
  const parts = normalizeSalesOrderSplitPackages(order, packages);
  if (!Number.isSafeInteger(total) || total <= 1 || parts.length >= total) return parts;
  const donorIndex = parts.reduce(
    (bestIndex, quantity, index) => (quantity > (parts[bestIndex] || 0) ? index : bestIndex),
    0
  );
  if (parts[donorIndex] <= 1) return parts;
  parts[donorIndex] -= 1;
  parts.push(1);
  return parts;
}

export function removeSalesOrderSplitPackageValue(order = {}, packages = [], index = 0) {
  const parts = normalizeSalesOrderSplitPackages(order, packages);
  if (parts.length <= 1 || !Number.isSafeInteger(index) || index < 0 || index >= parts.length) return parts;
  const [removed] = parts.splice(index, 1);
  const receiverIndex = Math.min(index, parts.length - 1);
  parts[receiverIndex] = (parts[receiverIndex] || 0) + (removed || 0);
  return parts;
}

export function isSalesOrderSplitUiTestOrder(order = {}) {
  const raw = getSalesOrderRawPosting(order);
  return Boolean(
    order.uiTestOrder ||
    order.splitUiTestOrder ||
    order.raw?.uiTestOrder ||
    order.raw?.splitUiTestOrder ||
    raw?.uiTestOrder ||
    raw?.splitUiTestOrder ||
    /^TEST-SPLIT-/i.test(String(getSalesPostingNumber(order) || ''))
  );
}

export function buildSimulatedSalesOrderSplitResult(order = {}, quantities = []) {
  const postingNumber = getSalesPostingNumber(order);
  const basePosting = postingNumber.replace(/-\d+$/u, '');
  const suffixSeed = Number(postingNumber.match(/-(\d+)$/u)?.[1] || 0);
  const parentQuantity = quantities[0] ?? 0;
  const childQuantities = quantities.slice(1);
  const children = childQuantities.map((_, index) => `${basePosting}-${suffixSeed + index + 1}`);
  return {
    ok: true,
    simulated: true,
    postingNumber,
    parentPostingNumber: postingNumber,
    resultPostingNumbers: [postingNumber, ...children],
    childPostingNumbers: children,
    splitQuantities: quantities,
    payload: {
      result: {
        parent_posting: { posting_number: postingNumber, quantity: parentQuantity },
        postings: children.map((childPostingNumber, index) => ({
          posting_number: childPostingNumber,
          quantity: childQuantities[index],
        })),
      },
    },
    message: `测试单已模拟拆解：${postingNumber} -> ${formatSalesOrderSplitPlan(quantities)}。`,
  };
}

export function getOzonCancelReasonItems(data) {
  const sources = [data, data?.result, data?.data];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    if (Array.isArray(source)) return source;
    if (Array.isArray(source.items)) return source.items;
    if (Array.isArray(source.reasons)) return source.reasons;
    if (Array.isArray(source.cancel_reasons)) return source.cancel_reasons;
    if (Array.isArray(source.cancellation_reasons)) return source.cancellation_reasons;
  }
  return getOzonPayloadItems(data);
}

export const OZON_CANCEL_REASON_TRANSLATIONS = new Map([
  ['Товар закончился на вашем складе', '您的仓库商品已售完'],
  ['Продавец отклонил арбитраж', '卖家拒绝仲裁'],
  ['Другое', '其他'],
  ['Возврат из службы доставки: нет доставки в указанный регион', '配送服务退回：指定地区无法配送'],
]);

export const OZON_CANCEL_REASON_TRANSLATION_PATTERNS = [
  [/товар\s+закончился/i, '您的仓库商品已售完'],
  [/продавец\s+отклонил\s+арбитраж/i, '卖家拒绝仲裁'],
  [/возврат\s+из\s+службы\s+доставки.*нет\s+доставки/i, '配送服务退回：指定地区无法配送'],
  [/другое/i, '其他'],
];

export function containsCyrillicText(value = '') {
  return /[\u0400-\u04FF]/.test(String(value));
}

export function getOzonCancelReasonDisplayLabel(rawLabel = '', index = 0) {
  const label = String(rawLabel || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) return `Ozon 取消原因 ${index + 1}`;
  const exactLabel = OZON_CANCEL_REASON_TRANSLATIONS.get(label);
  if (exactLabel) return exactLabel;
  const patternLabel = OZON_CANCEL_REASON_TRANSLATION_PATTERNS.find(([pattern]) => pattern.test(label))?.[1];
  if (patternLabel) return patternLabel;
  return containsCyrillicText(label) ? `其他取消原因 ${index + 1}` : label;
}

export function normalizeOzonCancelReason(item = {}, index = 0) {
  const id = firstFilled(
    item.id,
    item.reason_id,
    item.cancel_reason_id,
    item.reasonId,
    item.cancelReasonId,
    item.type_id
  );
  const label = firstFilled(
    item.name,
    item.title,
    item.reason,
    item.reason_name,
    item.cancel_reason,
    item.message,
    item.description,
    item.text
  );
  const rawLabel = label ? String(label) : '';

  return {
    id: id !== undefined && id !== null ? String(id) : '',
    label: getOzonCancelReasonDisplayLabel(rawLabel, index),
    rawLabel,
    raw: item,
  };
}

export async function requestOzonFbsCancelReasons(shop) {
  const data = await requestOzonReadOnly('/v2/posting/fbs/cancel-reason/list', shop, {});
  const reasons = getOzonCancelReasonItems(data)
    .map((item, index) => normalizeOzonCancelReason(item, index))
    .filter((item) => item.id);
  if (!reasons.length) {
    throw new Error('Ozon 没有返回可用取消原因，已停止提交。');
  }
  return reasons;
}

export function formatSalesOperationFailure(order, error) {
  const postingNumber = getSalesPostingNumber(order) || order?.id || '未返回订单号';
  const message = error instanceof Error ? error.message : String(error);
  return `${postingNumber}：${message.replace(/\s+/g, ' ').slice(0, 180)}`;
}

export function getSalesOperationWriteStatus(result = {}) {
  return firstFilled(result?.localApiWrite?.writeStatus, result?.writeStatus, result?.readBack?.status);
}

export function getSalesOperationResultMessage(result = {}) {
  return firstFilled(result?.localApiWrite?.message, result?.message, result?.schedulerResult?.message);
}

export function getSalesOperationNoticeSeverity(results = [], hasFailures = false) {
  if (hasFailures) return 'warning';
  const statuses = results.map(getSalesOperationWriteStatus).map((item) => String(item || '').toLowerCase());
  if (
    statuses.some(
      (status) => status === 'submitted_waiting_readback' || status === 'pending' || status === 'dry_run_recorded'
    )
  ) {
    return 'info';
  }
  return 'success';
}

export function buildSalesOperationNoticeMessage(actionText, results = []) {
  const safeResults = Array.isArray(results) ? results.filter(Boolean) : [];
  if (safeResults.length === 1) {
    return getSalesOperationResultMessage(safeResults[0]) || `${actionText}已提交 Ozon，等待回读确认。`;
  }
  const counts = safeResults.reduce(
    (acc, result) => {
      const status = String(getSalesOperationWriteStatus(result) || '').toLowerCase();
      if (status === 'readback_merged' || status === 'merged') acc.merged += 1;
      else if (status === 'submitted_waiting_readback' || status === 'pending') acc.waiting += 1;
      else if (status === 'dry_run_recorded') acc.dryRun += 1;
      else acc.unknown += 1;
      return acc;
    },
    { waiting: 0, merged: 0, dryRun: 0, unknown: 0 }
  );
  const parts = [];
  if (counts.waiting) parts.push(`已提交 Ozon，等待回读 ${counts.waiting} 个`);
  if (counts.merged) parts.push(`回读成功，SQLite 已合并 ${counts.merged} 个`);
  if (counts.dryRun) parts.push(`dry-run 记录 ${counts.dryRun} 个`);
  if (counts.unknown) parts.push(`状态待确认 ${counts.unknown} 个`);
  return `${actionText}结果：${parts.join('；') || `已提交 ${safeResults.length} 个，等待回读确认`}。`;
}

export function buildSalesOperationPartialNoticeMessage(actionText, successResults = [], failures = []) {
  const successPart = buildSalesOperationNoticeMessage(actionText, successResults)
    .replace(`${actionText}结果：`, '')
    .replace(/。$/u, '');
  const sample = failures.slice(0, 3).join('；');
  const more = failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : '';
  return `${actionText}部分结果：${successPart}；失败 ${failures.length} 个。${sample}${more}`;
}

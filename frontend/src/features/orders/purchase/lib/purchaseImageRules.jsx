import { firstFilled } from '../../../../entities/order/orderIdentityRules.jsx';
import { getOzonOrderProductSalesAmount } from '../../../../entities/order/orderProductAmountRules.jsx';
import { formatOzonPrice } from '../../../../entities/product/productPriceRules.jsx';
import {
  firstFiniteNumber,
  getOzonMileageFeeCny,
  toFiniteNumber,
} from '../../../../entities/product/productAttributes.jsx';
import { isRemoteImageUrl, safeImageUrl } from '../../../../entities/product/productImageRules.jsx';
import { getCrossBorderFixedFeeValue } from '../../../../entities/profit/profitFeeRules.jsx';
import { firstCommissionRate } from '../../../../entities/profit/profitCommissionRules.jsx';
import {
  calculateAcquiringFeeCny,
  calculateCommissionFeeCny,
  calculateEstimatedProfitCny,
  calculateOrderPreDeductionFeeCny,
  ORDER_CARD_ACQUIRING_RATE,
} from '../../../../services/feeCalculationService';
import { getOrderRubToCnyRateForMode } from '../../../../services/orderExchangeRateRules';
import {
  getLogisticsFreightForPurchaseOrder,
  getGuooRealFbsFreightForPurchaseOrder,
  getOrderCardLogisticsFeeValue,
} from '../../../../services/purchaseLogisticsRuntime.js';
import {
  appendUniqueText,
  getCrossBorderSheetInfo,
  getNormalizedDeliveryRouteLine,
  getOzonDeliveryMethodIdFromPosting,
  getOzonPostingDetailPayload,
  getPurchaseCrossBorderStrictOrderId,
  getPurchaseOrderDisplayOrderId,
  getPurchaseOrderOzonMainImageUrl,
  getPurchaseOrderSkuImageUrl,
} from '../../../../services/purchaseImageRuntime.js';
import {
  PURCHASE_DIRECT_IMAGE_SEARCH_PLATFORMS,
  PURCHASE_SEARCH_PLATFORM_HOME_URL,
  PURCHASE_SEARCH_PLATFORM_KEY,
  PURCHASE_SEARCH_PLUGIN_API_BASE,
} from '../../../../shared/config/appConfigCore.jsx';
import { derivePurchaseOrderStatus, getPurchaseOrderActionState } from './purchaseOrderNormalize.jsx';

export { firstCommissionRate } from '../../../../entities/profit/profitCommissionRules.jsx';
export {
  appendUniqueText,
  getCrossBorderSheetInfo,
  getNormalizedDeliveryRouteLine,
  getOzonDeliveryMethodIdFromPosting,
  getOzonPostingDetailPayload,
  getPurchaseCrossBorderStrictOrderId,
  getPurchaseOrderDisplayOrderId,
  getPurchaseOrderOzonMainImageUrl,
  getPurchaseOrderSkuImageUrl,
} from '../../../../services/purchaseImageRuntime.js';

export {
  getGuooMaterialFromPurchaseOrder,
  getGuooMaterialFromText,
  getGuooProductValueRubFromOrder,
  getGuooRealFbsFreightForPurchaseOrder,
  getGuooRouteTextFromPurchaseOrder,
  getLogisticsFreightForPurchaseOrder,
  getLogisticsRouteTextFromPurchaseOrder,
  getNumbersFromText,
  getOrderCardLogisticsFeeValue,
  getPurchaseOrderVolumeItems,
  hasCompleteGuooMaterial,
  normalizePurchaseOrderVolumeItem,
} from '../../../../services/purchaseLogisticsRuntime.js';

export function getPurchaseOrderActionFlags(order = {}, actionState = getPurchaseOrderActionState(order)) {
  const status = order.status || derivePurchaseOrderStatus(order);
  return {
    status,
    showPurchasePayment: status === '待拍单',
    showCreateForecast: status === '已拍单-待预报',
    showRepairForecast: status === '已拍单-未操作',
    showCancelOrder: ['待拍单', '已拍单-待预报', '已拍单-待发货', '已拍单-未操作', '已拍单-售后单'].includes(status),
    showPurchaseRefund: ['已拍单-待预报', '已拍单-未操作', '已拍单-售后单'].includes(status),
    showTransferPending: status === '已拍单-待预报',
    showReadCrossBorder: [
      '已拍单-待发货',
      '已拍单-未操作',
      '已拍单-售后单',
      '已拍单-已发货',
      '完结单',
      '关闭单',
    ].includes(status),
    showCancelCrossBorder: ['已拍单-待发货', '已拍单-售后单'].includes(status),
    showReadVolume: ['已拍单-已发货', '完结单', '关闭单'].includes(status),
    showProfitCheck: ['完结单', '关闭单'].includes(status),
    canRepairForecast: actionState.forecastMode === 'repair' && actionState.canForecast,
  };
}

export function getPurchaseSourceProductImageUrl(sourceEntry = {}) {
  if (!sourceEntry || typeof sourceEntry !== 'object') return '';
  return (
    safeImageUrl(
      firstFilled(
        sourceEntry.image,
        sourceEntry.imageUrl,
        sourceEntry.image_url,
        sourceEntry.sourceImage,
        sourceEntry.sourceImageUrl,
        sourceEntry.source_image_url,
        sourceEntry.thumbnail,
        sourceEntry.thumbnailUrl,
        sourceEntry.thumbUrl,
        sourceEntry.picture,
        sourceEntry.pictureUrl,
        sourceEntry.picUrl,
        Array.isArray(sourceEntry.images) ? sourceEntry.images[0] : '',
        Array.isArray(sourceEntry.pictures) ? sourceEntry.pictures[0] : ''
      )
    ) || ''
  );
}

export function normalizeSourcePreviewImageUrl(value = '') {
  const imageUrl = safeImageUrl(value);
  if (!imageUrl) return '';

  let normalized = imageUrl;
  try {
    const url = new URL(imageUrl);
    if (/image(?:mogr|view|resize|process)|thumbnail|quality/i.test(url.search)) {
      url.search = '';
    }
    normalized = url.toString();
  } catch {
    normalized = imageUrl;
  }

  normalized = normalized
    .replace(/(\.(?:jpg|jpeg|png|webp|avif))_\d+x\d+(?:q\d+)?(?:s\d+)?(?:\.(?:jpg|jpeg|png|webp|avif))?(?=$|\?)/i, '$1')
    .replace(/(\.(?:jpg|jpeg|png|webp|avif))_\.webp(?=$|\?)/i, '$1')
    .replace(/_\d+x\d+(?:q\d+)?(?:s\d+)?(?=$|\?)/i, '');

  return safeImageUrl(normalized) || imageUrl;
}

export function getPurchaseSourceProductPreviewImageUrl(sourceEntry = {}) {
  if (!sourceEntry || typeof sourceEntry !== 'object') return '';
  const previewSource = firstFilled(
    sourceEntry.originalImageUrl,
    sourceEntry.original_image_url,
    sourceEntry.originalImage,
    sourceEntry.original_image,
    sourceEntry.fullImageUrl,
    sourceEntry.full_image_url,
    sourceEntry.largeImageUrl,
    sourceEntry.large_image_url,
    sourceEntry.highResImageUrl,
    sourceEntry.high_res_image_url,
    sourceEntry.previewImageUrl,
    sourceEntry.preview_image_url,
    sourceEntry.previewImage,
    sourceEntry.preview_image,
    getPurchaseSourceProductImageUrl(sourceEntry)
  );
  return normalizeSourcePreviewImageUrl(previewSource);
}

export function getPurchaseProductImageUrl(product = {}, sourceEntry = {}) {
  return (
    getPurchaseSourceProductImageUrl(sourceEntry) ||
    getPurchaseOrderSkuImageUrl(product) ||
    getPurchaseOrderOzonMainImageUrl(product) ||
    ''
  );
}

export function getPurchaseSearchPlatformKey(platform = '') {
  return (
    PURCHASE_SEARCH_PLATFORM_KEY[platform] ||
    String(platform || '')
      .trim()
      .toLowerCase()
  );
}

export function getPurchaseSearchHomeUrl(platform = '') {
  return PURCHASE_SEARCH_PLATFORM_HOME_URL[platform] || '';
}

export function getPurchaseDirectImageSearchUrl(platform = '', imageUrl = '') {
  const cleanPlatform = String(platform || '').trim();
  const cleanImageUrl = String(imageUrl || '').trim();
  if (!cleanImageUrl || (cleanPlatform !== '淘宝' && cleanPlatform !== '天猫')) {
    return getPurchaseSearchHomeUrl(cleanPlatform);
  }
  if (cleanPlatform === '淘宝' || cleanPlatform === '天猫') {
    const endpoint = new URL('https://s.taobao.com/search');
    endpoint.searchParams.set('imgSearchUrl', cleanImageUrl);
    endpoint.searchParams.set('tab', cleanPlatform === '天猫' ? 'mall' : 'all');
    endpoint.searchParams.set('ie', 'utf8');
    endpoint.searchParams.set('search_type', 'item');
    endpoint.searchParams.set('imgFrom', 'otherPage');
    return endpoint.href;
  }
  return getPurchaseSearchHomeUrl(cleanPlatform);
}

export function isPurchaseDirectImageSearchPlatform(platform = '') {
  return PURCHASE_DIRECT_IMAGE_SEARCH_PLATFORMS.has(platform);
}

export function buildPurchaseDirectImageSearchPayload(platform = '', imageUrl = '') {
  const searchUrl = getPurchaseDirectImageSearchUrl(platform, imageUrl);
  return {
    ok: true,
    externalOnly: true,
    provider: getPurchaseSearchPlatformKey(platform),
    providerLabel: `${platform} 以图搜款`,
    searchUrl,
    results: [],
    message: `已打开 ${platform} 自动识图页面，请使用当前商品图进行以图搜款，软件不会用 1688 或 Ozon 标题代替。`,
    imageUrl,
  };
}

export function getAbsolutePurchaseSearchImageUrl(value = '') {
  const clean = String(value || '').trim();
  if (!clean) return '';
  if (/^(https?:|data:|blob:)/i.test(clean)) return clean;
  if (typeof window === 'undefined') return clean;
  try {
    return new URL(clean, window.location.origin).href;
  } catch {
    return clean;
  }
}

export function buildPurchaseSourceResultImageUrl(value = '') {
  const imageUrl = safeImageUrl(value);
  if (!imageUrl || !isRemoteImageUrl(imageUrl)) return imageUrl;
  if (typeof globalThis.wangzaiDesktop?.purchaseBridgeRequest === 'function') {
    return `app://wangzai/purchase-image?url=${encodeURIComponent(imageUrl)}`;
  }
  return `${PURCHASE_SEARCH_PLUGIN_API_BASE}/api/purchase/image-proxy?url=${encodeURIComponent(imageUrl)}`;
}

export function normalizePurchaseSourceSearchResult(item = {}, index = 0) {
  const title = String(firstFilled(item.title, item.name, item.subject, '未返回商品标题')).trim();
  const link = String(firstFilled(item.url, item.link, item.sourceUrl, item.detailUrl)).trim();
  const originalImage = safeImageUrl(firstFilled(item.imageUrl, item.image, item.picUrl, item.imgUrl, item.thumbnail));
  const image = buildPurchaseSourceResultImageUrl(originalImage);
  const price = String(firstFilled(item.price, item.priceText, item.showPrice)).trim();
  const sales = String(firstFilled(item.sales, item.saleText, item.saleQuantity)).trim();
  const shopName = String(firstFilled(item.shopName, item.shop, item.sellerName)).trim();
  const platformLabel = String(firstFilled(item.platformLabel, item.platform, '1688')).trim();
  const meta = [price, sales, shopName, platformLabel].filter(Boolean).join(' · ');
  return {
    id: String(firstFilled(item.id, item.offerId, item.itemId, link, `${Date.now()}-${index}`)),
    title,
    link,
    image,
    originalImage,
    hint: meta || '请人工核对标题、规格和价格',
  };
}

export function getPurchaseSourceSearchErrorMessage(error, status = 0) {
  const rawMessage = String(error?.message || '').trim();
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(rawMessage)) {
    return '本地搜款服务未连接，请先启动本地搜款服务和采集插件后重试。';
  }
  if (status === 404 || status === 405) {
    return '本地搜款服务版本不支持当前拍单搜款，请更新或启动正确的本地搜款服务。';
  }
  if (status === 501) {
    return rawMessage || '当前采购平台还没有真实以图搜款通道，已停止，不使用标题搜索。';
  }
  if (status >= 500) {
    return '本地搜款服务暂时不可用，请先启动本地搜款服务和采集插件后重试。';
  }
  if (status === 422 && rawMessage) return rawMessage;
  if (/状态码\s*\d+/i.test(rawMessage)) {
    return '搜款失败，请稍后重试。';
  }
  return rawMessage || '搜款失败，请稍后重试。';
}

export function getPurchaseSourceProductTitle(product = {}, sourceEntry = {}) {
  return (
    firstFilled(
      sourceEntry.title,
      sourceEntry.name,
      sourceEntry.productTitle,
      sourceEntry.product_title,
      sourceEntry.sourceTitle,
      sourceEntry.source_title,
      sourceEntry.goodsTitle,
      sourceEntry.goods_title,
      sourceEntry.itemTitle,
      sourceEntry.item_title,
      product.sourceTitle,
      product.source_title,
      product.purchaseTitle,
      product.purchase_title,
      product.name
    ) || '未返回'
  );
}

export function getPurchaseSourceCardAmount(product = {}, order = {}, sourceEntry = {}) {
  const directText = firstFilled(
    sourceEntry.price,
    sourceEntry.purchasePrice,
    sourceEntry.purchase_price,
    sourceEntry.sourcePrice,
    sourceEntry.source_price,
    sourceEntry.amount,
    product.purchasePrice,
    product.purchase_price,
    product.sourcePrice,
    product.source_price,
    product.sourceAmount,
    product.source_amount,
    product.purchaseAmount,
    product.purchase_amount,
    order.purchasePrice
  );
  if (directText && directText !== '未返回' && directText !== '待确认') return String(directText);
  const numericValue = firstFiniteNumber(
    sourceEntry.priceValue,
    sourceEntry.purchasePriceValue,
    product.purchasePriceValue,
    product.purchase_price_value,
    product.sourcePriceValue,
    product.source_price_value
  );
  return numericValue === null
    ? '待确认'
    : formatOzonPrice(numericValue, product.currencyCode || order.currencyCode || 'CNY');
}

export function getPurchaseSourceCardQty(product = {}, order = {}, sourceEntry = {}) {
  const qty = firstFiniteNumber(
    sourceEntry.qty,
    sourceEntry.purchaseQty,
    sourceEntry.purchase_qty,
    sourceEntry.quantity,
    product.purchaseQty,
    product.purchase_qty,
    product.sourceQty,
    product.source_qty,
    product.qty,
    order.items
  );
  return `x${qty ?? 1}`;
}

export function getPurchaseOrderShortStatus(status = '') {
  const label = String(status || '未返回').trim();
  const map = {
    '已拍单-待预报': '待预报',
    '已拍单-待发货': '待发货',
    '已拍单-已发货': '已发货',
    '已拍单-未操作': '未操作',
    '已拍单-售后单': '售后单',
    关闭单: '关闭单',
  };
  return map[label] || label;
}

function getPurchaseOrderProfitPendingHint(order = {}, estimatedEntry = null) {
  const sourceCostEntry = order.profitLedger?.amounts?.sourcePurchaseCostCny;
  const sourceCostStatus = String(sourceCostEntry?.status || '').trim().toLowerCase();
  const sourceCostValue = firstFiniteNumber(sourceCostEntry?.value);
  const currentCostValue = getOrderCardSourcePurchaseCostValue(order);
  if (sourceCostStatus !== 'ready' && sourceCostValue === null && currentCostValue === null) return '成本待补';

  const missing = Array.isArray(estimatedEntry?.missing) ? estimatedEntry.missing : [];
  const reason = String(firstFilled(...missing, estimatedEntry?.reason) || '').trim();
  if (/成本|货源|source\s*(?:purchase\s*)?cost/i.test(reason)) return '成本待补';
  if (/物流|logistics/i.test(reason)) return '物流待补';
  if (/佣金|commission/i.test(reason)) return '佣金待补';
  if (/销售额|回款|sales|income/i.test(reason)) return '销售额待补';
  return reason || '核算待补';
}

function isPurchaseProfitLedgerStale(order = {}, profitLedger = null) {
  if (!profitLedger) return false;
  const currentCostValue = getOrderCardSourcePurchaseCostValue(order);
  if (currentCostValue === null) return false;
  const ledgerCostValue = firstFiniteNumber(
    profitLedger.amounts?.sourcePurchaseCostCny?.value,
    profitLedger.orderSnapshot?.sourcePurchaseCostCny
  );
  if (ledgerCostValue === null) return true;
  return Math.abs(currentCostValue - ledgerCostValue) > 0.005;
}

function getPurchaseProfitTone(value) {
  const number = toFiniteNumber(value);
  return number === null ? '' : number > 0 ? 'profit' : number < 0 ? 'loss' : '';
}

function getReadyProfitLedgerAmount(profitLedger = null, field = '') {
  const entry = profitLedger?.amounts?.[field];
  const status = String(entry?.status || '').trim().toLowerCase();
  if (!['ready', 'provisional'].includes(status)) return null;
  return firstFiniteNumber(entry?.value);
}

export function getPurchaseOrderListProfit(order = {}) {
  const profitLedger = order.profitLedger && typeof order.profitLedger === 'object' ? order.profitLedger : null;
  const estimatedEntry = profitLedger?.results?.estimatedProfitCny;
  const estimatedStatus = String(estimatedEntry?.status || '').trim().toLowerCase();
  const ledgerValue = firstFiniteNumber(estimatedEntry?.value);
  const ledgerStale = isPurchaseProfitLedgerStale(order, profitLedger);
  if (!ledgerStale && ['ready', 'provisional'].includes(estimatedStatus) && ledgerValue !== null) {
    return { value: formatOrderCardProfitValue(ledgerValue), hint: '已核算', tone: getPurchaseProfitTone(ledgerValue) };
  }

  const value = firstFilled(order.estimatedProfit, order.profitLoss, order.actualProfit);
  if (value !== '' && value !== '未返回' && value !== '待确认') {
    return { value, hint: '已核算', tone: getPurchaseProfitTone(value) };
  }

  const calculatedProfit = getOrderCardEstimatedProfit(order);
  if (calculatedProfit.value !== null) {
    return {
      value: calculatedProfit.display,
      hint: ledgerStale ? '按当前成本' : '已核算',
      tone: calculatedProfit.tone,
    };
  }
  if (ledgerStale) return { value: '待确认', hint: '利润待更新', tone: '' };
  return { value: '待确认', hint: getPurchaseOrderProfitPendingHint(order, estimatedEntry), tone: '' };
}

export function getPurchaseOrderProductsForFee(order = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const sourceProducts = Array.isArray(sourceOrder.products) ? sourceOrder.products : [];
  if (sourceProducts.length) return sourceProducts;
  return Array.isArray(order.products) ? order.products : [];
}

export function getOrderCardSalesAmountValue(order = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  return firstFiniteNumber(order.amount, sourceOrder.amount);
}

export function getOrderCardCommissionRates(order = {}) {
  const products = getPurchaseOrderProductsForFee(order);
  const productRates = products.map((product) =>
    firstCommissionRate(product.commissionPercent, product.raw?.commissionPercent, product.raw?.commission_percent)
  );
  const validProductRates = productRates.filter((value) => value !== null);
  if (validProductRates.length === products.length && validProductRates.length) {
    return [...new Set(validProductRates)];
  }
  if (validProductRates.length) return [];

  const sourceOrder = order.sourceOrder ?? {};
  const orderRate = firstCommissionRate(order.commissionPercent, sourceOrder.commissionPercent);
  return orderRate === null ? [] : [orderRate];
}

export function getOrderCardCommissionValue(order = {}, salesAmountValue = getOrderCardSalesAmountValue(order)) {
  const rates = getOrderCardCommissionRates(order);
  if (!rates.length || salesAmountValue === null) return null;
  if (rates.length === 1) {
    return calculateCommissionFeeCny({
      orderAmountCny: salesAmountValue,
      commissionPercent: rates[0],
    });
  }

  const products = getPurchaseOrderProductsForFee(order);
  if (!products.length) return null;
  const productFeeParts = products.map((product) => ({
    rate: firstCommissionRate(
      product.commissionPercent,
      product.raw?.commissionPercent,
      product.raw?.commission_percent
    ),
    weight: firstFiniteNumber(product.salesAmountValue, getOzonOrderProductSalesAmount(product)),
  }));
  if (productFeeParts.some((item) => item.rate === null || item.weight === null || item.weight < 0)) return null;
  const totalWeight = productFeeParts.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return null;
  return productFeeParts.reduce((total, item) => {
    const salesShare = salesAmountValue * (item.weight / totalWeight);
    const commissionPart = calculateCommissionFeeCny({
      orderAmountCny: salesShare,
      commissionPercent: item.rate,
    });
    return commissionPart === null ? total : total + commissionPart;
  }, 0);
}

export function getOrderCardRubToCnyRate(order = {}) {
  return firstFiniteNumber(getOrderRubToCnyRateForMode(order, {}, { mode: 'display' }));
}

export function getOrderCardPlatformFee(order = {}) {
  const salesAmountValue = getOrderCardSalesAmountValue(order);
  const commissionValue = getOrderCardCommissionValue(order, salesAmountValue);
  const acquiringValue = calculateAcquiringFeeCny({
    orderPaymentCny: salesAmountValue,
    acquiringRate: ORDER_CARD_ACQUIRING_RATE,
  });
  const rubToCnyRate = getOrderCardRubToCnyRate(order);
  const mileageValue = getOzonMileageFeeCny(rubToCnyRate);
  const crossBorderValue = getCrossBorderFixedFeeValue();
  const totalValue = calculateOrderPreDeductionFeeCny({
    commissionFeeCny: commissionValue,
    acquiringFeeCny: acquiringValue,
    deliveryServiceFeeCny: mileageValue,
    crossBorderBusFeeCny: crossBorderValue,
  });
  return {
    salesAmountValue,
    commissionValue,
    acquiringValue,
    mileageValue,
    crossBorderValue,
    totalValue,
    display: totalValue === null ? '待确认' : formatOzonPrice(totalValue, 'CNY'),
  };
}

export function getOrderCardSourcePurchaseCostValue(order = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  return firstFiniteNumber(
    order.purchasePriceValue,
    order.purchasePrice,
    sourceOrder.purchasePriceValue,
    sourceOrder.purchasePrice,
    sourceOrder.productCostValue,
    sourceOrder.productCost
  );
}

export function getOrderCardLogisticsFeeDisplay(order = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const storedDisplay = firstFilled(
    order.logisticsFreight?.display,
    order.guooFreight?.display,
    order.freightCost,
    order.shippingFee,
    sourceOrder.logisticsFreight?.display,
    sourceOrder.guooFreight?.display,
    sourceOrder.freightCost,
    sourceOrder.shippingFee
  );
  if (storedDisplay) return storedDisplay;
  const logisticsFreight = getLogisticsFreightForPurchaseOrder(order);
  return firstFilled(logisticsFreight.ok ? logisticsFreight.display : '', order.crossBorderFee, sourceOrder.crossBorderFee) || '待确认';
}

export function formatOrderCardProfitValue(value) {
  const number = toFiniteNumber(value);
  if (number === null) return '待确认';
  if (number > 0) return `+￥${number.toFixed(2)}`;
  if (number < 0) return `-￥${Math.abs(number).toFixed(2)}`;
  return '￥0.00';
}

export function getOrderCardEstimatedProfit(order = {}, orderCardPlatformFee = getOrderCardPlatformFee(order)) {
  const sourcePurchaseCostValue = getOrderCardSourcePurchaseCostValue(order);
  const logisticsFeeValue = getOrderCardLogisticsFeeValue(order);
  const value = calculateEstimatedProfitCny({
    orderPaymentCny: orderCardPlatformFee.salesAmountValue,
    sourcePurchaseCostCny: sourcePurchaseCostValue,
    commissionFeeCny: orderCardPlatformFee.commissionValue,
    acquiringFeeCny: orderCardPlatformFee.acquiringValue,
    deliveryServiceFeeCny: orderCardPlatformFee.mileageValue,
    crossBorderBusFeeCny: orderCardPlatformFee.crossBorderValue,
    logisticsFeeCny: logisticsFeeValue,
  });
  return {
    value,
    display: formatOrderCardProfitValue(value),
    tone: value === null ? '' : value > 0 ? 'profit' : value < 0 ? 'loss' : '',
  };
}

export function getPurchaseOrderProfitSummaryItems(order = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const profitLedger = order.profitLedger && typeof order.profitLedger === 'object' ? order.profitLedger : null;
  const estimatedEntry = profitLedger?.results?.estimatedProfitCny;
  const estimatedStatus = String(estimatedEntry?.status || '').trim().toLowerCase();
  const ledgerProfitValue = firstFiniteNumber(estimatedEntry?.value);
  const useProfitLedger = Boolean(
    profitLedger &&
      !isPurchaseProfitLedgerStale(order, profitLedger) &&
      ['ready', 'provisional'].includes(estimatedStatus) &&
      ledgerProfitValue !== null
  );
  if (useProfitLedger) {
    const salesAmountValue = getReadyProfitLedgerAmount(profitLedger, 'salesAmountCny');
    const sourcePurchaseCostValue = getReadyProfitLedgerAmount(profitLedger, 'sourcePurchaseCostCny');
    const estimatedOzonFeeValue = getReadyProfitLedgerAmount(profitLedger, 'estimatedOzonFeeCny');
    const estimatedCrossBorderBusFeeValue = getReadyProfitLedgerAmount(
      profitLedger,
      'estimatedCrossBorderBusFeeCny'
    );
    const logisticsFeeValue = getReadyProfitLedgerAmount(profitLedger, 'logisticsFeeCny');
    const platformFeeValue =
      estimatedOzonFeeValue === null || estimatedCrossBorderBusFeeValue === null
        ? null
        : estimatedOzonFeeValue + estimatedCrossBorderBusFeeValue;
    return [
      {
        label: '销售额',
        value: salesAmountValue === null ? '待确认' : formatOzonPrice(salesAmountValue, 'CNY'),
      },
      {
        label: '货源',
        value: sourcePurchaseCostValue === null ? '待确认' : formatOzonPrice(sourcePurchaseCostValue, 'CNY'),
      },
      {
        label: '平台费',
        value: platformFeeValue === null ? '待确认' : formatOzonPrice(platformFeeValue, 'CNY'),
      },
      {
        label: '物流',
        value: logisticsFeeValue === null ? '待确认' : formatOzonPrice(logisticsFeeValue, 'CNY'),
      },
      {
        label: '利润',
        value: formatOrderCardProfitValue(ledgerProfitValue),
        tone: getPurchaseProfitTone(ledgerProfitValue),
      },
    ];
  }

  const orderCardPlatformFee = getOrderCardPlatformFee(order);
  const profit = getOrderCardEstimatedProfit(order, orderCardPlatformFee);
  return [
    { label: '销售额', value: firstFilled(order.amount, sourceOrder.amount) || '未返回' },
    {
      label: '货源',
      value: firstFilled(order.purchasePrice, sourceOrder.purchasePrice, sourceOrder.productCost) || '待确认',
    },
    {
      label: '平台费',
      value: orderCardPlatformFee.display,
    },
    {
      label: '物流',
      value: getOrderCardLogisticsFeeDisplay(order),
    },
    { label: '利润', value: profit.display, tone: profit.tone },
  ];
}

export function getPurchaseOrderListSyncLabels(order = {}) {
  const hasOzonStatus = Boolean(order.ozonStatusLabel && order.ozonStatusLabel !== '未知状态');
  const hasCrossBorderRead = Boolean(order.crossBorderOrderFound || order.packageOrderId || order.crossBorderStatus);
  return {
    ozon: hasOzonStatus ? 'Ozon 已同步' : 'Ozon 未返回',
    crossBorder: hasCrossBorderRead ? '巴士已回查' : '巴士未回查',
  };
}

export function getPurchaseOrderPreviewImages(order = {}) {
  const product = order?.products?.[0] ?? {};
  const skuImage = getPurchaseOrderSkuImageUrl(product);
  const productMainImage = getPurchaseOrderOzonMainImageUrl(product);
  const firstImage = skuImage || productMainImage;

  return [
    {
      image: firstImage,
      label: skuImage ? 'SKU图' : productMainImage ? '主图' : '未返回',
      alt: skuImage ? product.name || order.product || '订单 SKU 图' : product.name || order.product || 'Ozon 产品主图',
    },
    {
      image: productMainImage,
      label: productMainImage ? '主图' : '未返回',
      alt: product.name || order.product || 'Ozon 产品主图',
    },
  ];
}

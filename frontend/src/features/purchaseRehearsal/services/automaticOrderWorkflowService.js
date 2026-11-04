import { requestOzonSalesOrdersSnapshotForShops } from '../../../entities/profit/profitOrderSnapshot.jsx';
import { listPurchaseAccounts } from '../../../api/localApiClient.js';
import {
  createOzonPackageLabelForPurchase,
  isOzonAwaitingDeliveryRawStatus,
  prepareOzonForPurchaseForecast,
  readOzonPurchaseForecastState,
} from '../../../entities/marketing/marketingSnapshotRuntime.jsx';
import {
  normalizeOzonOrderRawStatus,
  OZON_ORDER_RAW_STATUS,
} from '../../../entities/order/orderStatusRules.jsx';
import {
  readSavedCrossBorderOrderSettings,
  requestProtectedCrossBorderOrderOperation,
} from '../../../entities/order/crossBorderOrderApi.jsx';
import {
  buildPurchaseCrossBorderCreateBody,
  normalizeCrossBorderOrderCreateResult,
} from '../../../services/purchaseCrossBorderRuntime.js';
import {
  findPurchaseOrderLocalOverride,
  readPurchaseOrderOverridesFromLocalApi,
} from '../../../services/purchaseOrderRuntime.js';
import { normalizeOzonSalesRowToPurchaseOrder } from '../../orders/purchase/lib/purchaseOrderNormalize.jsx';
import {
  annotatePurchaseOrder,
  applyPurchaseManualFallbacks,
  getPurchaseOrderActionState,
  sanitizePurchaseOrderLocalOverrideForMerge,
} from '../../orders/purchase/lib/purchaseOrderNormalize.jsx';
import { getPurchaseOrderRecordKey } from '../../../entities/order/purchaseOrderRecordRules.jsx';
import { readPurchaseProfitLedgerSnapshot } from '../../orders/purchase/services/purchaseProfitLedgerService.js';
import { createOzonTimeRangeScope } from '../../../entities/order/orderShopScope.jsx';
import {
  OZON_ORDER_DEFAULT_RANGE_DAYS,
  PROFIT_ORDER_DEFAULT_RANGE_DAYS,
} from '../../../shared/config/appConfigCore.jsx';
import { clearVoidedPurchaseDisplayFields } from '../../../services/purchaseInfoSupport.js';
import { readProductSourceLinksFromLocalApi } from '../../../services/productModuleClient.js';
import { loadSkuNameBindings } from './purchaseSkuBindingService.js';
import { resolveExactSkuBinding } from '../lib/purchaseSkuNameBinding.js';
import { loadPurchaseAutoPaySettings } from './purchaseAutoPaySettingsService.js';

export const automaticOrderSections = Object.freeze({
  autoOrder: 'auto-order',
  stock: 'stock',
  forecast: 'forecast',
  binding: 'sku-binding',
});

export const automaticOrderActionLabels = Object.freeze({
  [automaticOrderSections.autoOrder]: '一键拍单并付款',
  [automaticOrderSections.stock]: '一键备货',
  [automaticOrderSections.forecast]: '一键预报',
});
const AUTO_ORDER_PURCHASE_PLATFORMS = new Set(['拼多多', '淘宝', '天猫', '1688']);

function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function orderPosting(order = {}) {
  return text(order.posting || order.postingNumber || order.posting_number || order.id || order.salesOrder);
}

function shopIdentity(shop = {}) {
  return [shop.id, shop.clientId, shop.shopAlias, shop.alias, shop.name].map(text).filter(Boolean);
}

function resolveOrderShop(shops = [], order = {}) {
  const values = new Set([
    order.shopId,
    order.shopClientId,
    order.shop,
    order.shopName,
  ].map(text).filter(Boolean));
  return shops.find((shop) => shopIdentity(shop).some((value) => values.has(value))) || null;
}

function productSku(product = {}) {
  return text(product.ozonSku || product.skuId || product.sku || product.raw?.sku);
}

function productOfferId(product = {}) {
  return text(product.offerId || product.offer_id || product.raw?.offer_id);
}

function purchaseFields(order = {}, override = {}) {
  return {
    platform: text(
      override.manualBuyerPlatform || override.purchasePlatform || override.buyerPlatform
      || order.manualBuyerPlatform || order.buyerPlatform,
    ),
    orderNumber: text(
      override.manualPurchaseOrderNo || override.purchaseOrderNumber || override.purchaseOrderNo
      || order.manualPurchaseOrderNo || order.purchaseOrderNo,
    ),
    amount: number(
      override.manualPurchasePriceValue ?? override.sourceCostCny ?? override.cost
      ?? order.manualPurchasePriceValue ?? order.purchasePriceValue,
    ),
    status: text(
      override.manualPurchaseOrderStatus || override.purchaseOrderStatus
      || order.manualPurchaseOrderStatus || order.purchaseOrderStatus,
    ),
    url: text(override.purchaseOrderUrl || override.manualPurchaseOrderUrl || order.purchaseOrderUrl),
    accountId: text(
      override.purchaseAccountId || override.purchase_account_id || order.purchaseAccountId || order.purchase_account_id,
    ),
    items: Array.isArray(override.purchaseOrderItems) ? override.purchaseOrderItems : [],
  };
}

function purchaseReceiver(row = {}) {
  const order = row.order || {};
  const raw = order.raw || order.sourceOrder?.raw || {};
  const receiver = order.receiver || raw.receiver || raw.customer || raw.recipient || {};
  const name = text(receiver.name || receiver.receiverName || order.receiverName || raw.receiver_name);
  const phone = text(receiver.phone || receiver.mobile || receiver.receiverMobile || order.receiverMobile || raw.receiver_phone);
  const province = text(receiver.province || receiver.region || order.receiverProvince || raw.receiver_province);
  const city = text(receiver.city || order.receiverCity || raw.receiver_city);
  const district = text(receiver.district || receiver.area || order.receiverDistrict || raw.receiver_district);
  const detail = text(
    receiver.detail || receiver.detailAddress || receiver.address || order.receiverAddress || raw.receiver_address,
  );
  return {
    name, phone, province, city, district, detail,
    fullAddress: [province, city, district, detail].filter(Boolean).join(''),
  };
}

export function groupAutomaticOrderProducts(products = []) {
  const groups = new Map();
  for (const product of products) {
    const key = JSON.stringify({
      platform: text(product.sourcePlatform),
      sourceUrl: text(product.sourceUrl),
      sourceSkuId: text(product.sourceSkuId),
      sourceSkuName: text(product.sourceSkuName),
      unitPrice: number(product.expectedUnitPrice),
    });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  return [...groups.values()].map((rows) => ({
    ...rows[0],
    quantity: rows.reduce((sum, row) => sum + Math.max(1, Number(row.quantity) || 1), 0),
    ozonSkuIds: rows.map((row) => text(row.ozonSkuId)).filter(Boolean),
  }));
}

function matchPendingPurchaseCandidate(candidates = [], product = {}, expectedTotal = 0) {
  const expectedTitle = text(product.sourceSkuName).replace(/\s+/gu, '').toLowerCase();
  const scored = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const amount = number(candidate.amount);
    const amountMatch = amount !== null && Math.abs(amount - expectedTotal) <= 0.01;
    const candidateText = `${text(candidate.title)} ${text(candidate.sku)}`.replace(/\s+/gu, '').toLowerCase();
    const titleMatch = !expectedTitle || candidateText.includes(expectedTitle)
      || expectedTitle.split(/[;/／|｜]/u).filter(Boolean).some((part) => candidateText.includes(part));
    return { candidate, score: (amountMatch ? 100 : 0) + (titleMatch ? 40 : 0), amountMatch, titleMatch };
  }).filter((entry) => entry.amountMatch);
  scored.sort((left, right) => right.score - left.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    throw fixtureError('AUTO_ORDER_PENDING_ORDER_AMBIGUOUS', '采购账号存在多笔相同金额的待付款订单，无法唯一匹配，已停止重复下单。');
  }
  return scored[0].candidate;
}

function normalizeOrderProducts(order = {}) {
  return (Array.isArray(order.products) ? order.products : []).map((product, index) => ({
    ...product,
    index,
    name: text(product.name) || `商品 ${index + 1}`,
    sku: productSku(product),
    offerId: productOfferId(product),
    quantity: Math.max(1, Number(product.qty || product.quantity) || 1),
    image: text(product.image || product.mainImage || product.images?.[0]),
  }));
}

function bindingForProduct(bindingDocument, shopId, product) {
  return resolveExactSkuBinding(bindingDocument, {
    shopId,
    sku: product.sku,
    offerId: product.offerId,
  });
}

function savedSourceLinkForProduct(sourceLinks = {}, shopId = '', product = {}) {
  const identities = [
    text(product.sku),
    text(product.sku) ? `sku:${text(product.sku)}` : '',
    text(product.offerId),
    text(product.offerId) ? `offer:${text(product.offerId)}` : '',
    text(product.productId),
    text(product.productId) ? `product:${text(product.productId)}` : '',
  ].filter(Boolean);
  const record = identities.map((identity) => sourceLinks[`${shopId}:${identity}`]).find(Boolean) || null;
  if (!record) return null;
  const links = Array.isArray(record.links) ? record.links : [];
  const primary = links[Math.max(0, Number(record.primaryIndex) || 0)] || links[0] || null;
  return primary?.link ? { ...primary, record } : null;
}

function mapAutomaticOrderRow(order, shops, bindingDocument, overrides, sourceLinks = {}) {
  const shop = resolveOrderShop(shops, order);
  const shopId = text(order.shopId || shop?.id);
  const override = findPurchaseOrderLocalOverride(overrides, order, shop) || {};
  const products = normalizeOrderProducts(order).map((product) => ({
    ...product,
    exactBinding: bindingForProduct(bindingDocument, shopId, product),
    savedSourceLink: savedSourceLinkForProduct(sourceLinks, shopId, product),
  }));
  const boundProducts = products.filter((product) => product.exactBinding);
  const purchase = purchaseFields(order, override);
  const rawStatus = normalizeOzonOrderRawStatus(order.ozonRawStatus || order.raw?.status || order.sourceStatus);
  const posting = orderPosting(order);
  const id = `${shopId || 'shop-unbound'}:${posting}`;
  const hasProducts = products.length > 0;
  const allBound = hasProducts && boundProducts.length === products.length;
  const autoOrderSupported = allBound && products.every((product) => (
    AUTO_ORDER_PURCHASE_PLATFORMS.has(text(product.exactBinding?.binding?.sourcePlatform))
  ));
  const purchaseManagementAction = getPurchaseOrderActionState(order);
  const alreadyPurchased = Boolean(purchase.orderNumber && purchase.status && !/待付款|失败|取消/u.test(purchase.status));
  const flow = override.purchaseForecastFlow && typeof override.purchaseForecastFlow === 'object'
    ? override.purchaseForecastFlow
    : {};
  return {
    id,
    posting,
    order,
    shop,
    shopId,
    shopName: text(shop?.shopAlias || shop?.alias || shop?.name || order.shop || order.shopName) || 'Ozon店铺',
    products,
    allBound,
    autoOrderSupported,
    purchase,
    rawStatus,
    purchaseManagementStatus: text(order.status),
    purchaseManagementCanPurchase: purchaseManagementAction.canPurchase === true,
    purchaseManagementPurchaseReason: text(purchaseManagementAction.purchaseReason),
    amount: number(order.amountValue ?? order.amount),
    paymentTime: text(order.paymentTime || order.paymentDate || order.capturedAt),
    workflow: {
      [automaticOrderSections.autoOrder]: alreadyPurchased
        ? 'completed'
        : autoOrderSupported && purchaseManagementAction.canPurchase === true ? 'ready' : 'blocked',
      stock: [
        'arbitration',
        OZON_ORDER_RAW_STATUS.delivering,
        OZON_ORDER_RAW_STATUS.delivered,
      ].includes(rawStatus) || isOzonAwaitingDeliveryRawStatus(rawStatus)
        ? 'completed'
        : rawStatus === OZON_ORDER_RAW_STATUS.awaitingPackaging ? 'ready' : 'blocked',
      forecast: flow.stage === 'completed' || override.crossBorderOrderFound === true
        ? 'completed'
        : isOzonAwaitingDeliveryRawStatus(rawStatus) ? 'ready' : 'blocked',
    },
    flow,
    override,
    fixtureScenario: text(order.fixtureScenario),
    fixture: order.fixture === true,
    cloudPurchase: order.cloudPurchase === true || override.cloudPurchase === true || override.purchaseSource === 'cloud',
  };
}

export function createAutomaticOrderFixtureRows() {
  const now = new Date().toISOString();
  const base = {
    fixture: true,
    shopId: 'virtual-shop-1',
    shop: '虚拟测试店',
    paymentTime: now,
    amount: 129,
    ozonRawStatus: 'awaiting_packaging',
  };
  return [
    {
      ...base,
      id: 'VIRTUAL-ORDER-SUCCESS-1',
      posting: 'VIRTUAL-ORDER-SUCCESS-1',
      products: [{
        name: '虚拟全链路商品', sku: 'virtual-ozon-sku-success', offerId: 'virtual-offer-success', qty: 1,
        fixtureBinding: {
          binding: { sourcePlatform: '拼多多', sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=10001' },
          pair: { sourceSkuId: 'virtual-source-sku-success', sourceSkuName: '黑色 / 标准款', sourcePrice: '23.80', sourceCurrency: 'CNY' },
        },
      }],
    },
    {
      ...base,
      id: 'VIRTUAL-ORDER-PRICE-ERROR',
      posting: 'VIRTUAL-ORDER-PRICE-ERROR',
      fixtureScenario: 'purchase-price-changed',
      products: [{
        name: '虚拟价格变化商品', sku: 'virtual-ozon-sku-price', offerId: 'virtual-offer-price', qty: 1,
        fixtureBinding: {
          binding: { sourcePlatform: '1688', sourceUrl: 'https://detail.1688.com/offer/10002.html' },
          pair: { sourceSkuId: 'virtual-source-sku-price', sourceSkuName: '白色 / 加强款', sourcePrice: '31.60', sourceCurrency: 'CNY' },
        },
      }],
    },
    {
      ...base,
      id: 'VIRTUAL-ORDER-NO-BINDING',
      posting: 'VIRTUAL-ORDER-NO-BINDING',
      products: [{ name: '虚拟未绑定商品', sku: '', offerId: 'virtual-offer-unbound', qty: 1 }],
    },
    {
      ...base,
      id: 'VIRTUAL-STOCK-STATUS-ERROR',
      posting: 'VIRTUAL-STOCK-STATUS-ERROR',
      fixtureScenario: 'stock-status-changed',
      fixturePurchase: { platform: '拼多多', orderNumber: 'VPO-STOCK-ERROR', amount: 19.9, status: '已付款' },
      products: [{
        name: '虚拟备货状态异常商品', sku: 'virtual-ozon-sku-stock', offerId: 'virtual-offer-stock', qty: 1,
        fixtureBinding: {
          binding: { sourcePlatform: '拼多多', sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=10003' },
          pair: { sourceSkuId: 'virtual-source-sku-stock', sourceSkuName: '蓝色 / 标准款', sourcePrice: '19.90', sourceCurrency: 'CNY' },
        },
      }],
    },
    {
      ...base,
      id: 'VIRTUAL-FORECAST-LABEL-ERROR',
      posting: 'VIRTUAL-FORECAST-LABEL-ERROR',
      ozonRawStatus: OZON_ORDER_RAW_STATUS.awaitingDeliver,
      fixtureScenario: 'forecast-label-waiting',
      fixturePurchase: { platform: '1688', orderNumber: 'VPO-FORECAST-ERROR', amount: 28.5, status: '已付款' },
      products: [{
        name: '虚拟面单等待商品', sku: 'virtual-ozon-sku-label', offerId: 'virtual-offer-label', qty: 1,
        fixtureBinding: {
          binding: { sourcePlatform: '1688', sourceUrl: 'https://detail.1688.com/offer/10004.html' },
          pair: { sourceSkuId: 'virtual-source-sku-label', sourceSkuName: '灰色 / 大号', sourcePrice: '28.50', sourceCurrency: 'CNY' },
        },
      }],
    },
  ];
}

function mapFixtureRow(order, shops) {
  const virtualShop = shops.find((shop) => shop.id === order.shopId) || {
    id: order.shopId,
    clientId: 'virtual-client-1',
    shopAlias: order.shop,
  };
  const normalized = normalizeOzonSalesRowToPurchaseOrder(order);
  normalized.shopId = order.shopId;
  normalized.shop = order.shop;
  normalized.ozonRawStatus = order.ozonRawStatus;
  normalized.fixture = true;
  normalized.fixtureScenario = order.fixtureScenario;
  normalized.products = order.products.map((product) => ({
    ...product,
    ozonSku: product.sku,
    exactBinding: product.fixtureBinding || null,
  }));
  const products = normalized.products.map((product, index) => ({
    ...product,
    index,
    name: product.name,
    sku: product.sku,
    offerId: product.offerId,
    quantity: Number(product.qty) || 1,
    exactBinding: product.exactBinding,
  }));
  const initialPurchase = order.fixturePurchase || {};
  const stockReady = order.fixtureScenario === 'stock-status-changed';
  const forecastReady = order.fixtureScenario === 'forecast-label-waiting';
  const allBound = products.length > 0 && products.every((product) => product.exactBinding);
  const autoOrderSupported = allBound && products.every((product) => (
    AUTO_ORDER_PURCHASE_PLATFORMS.has(text(product.exactBinding.binding?.sourcePlatform))
  ));
  return {
    id: `${order.shopId}:${order.posting}`,
    posting: order.posting,
    order: normalized,
    shop: virtualShop,
    shopId: order.shopId,
    shopName: order.shop,
    products,
    allBound,
    autoOrderSupported,
    purchase: initialPurchase,
    rawStatus: order.ozonRawStatus,
    amount: order.amount,
    paymentTime: order.paymentTime,
    workflow: {
      [automaticOrderSections.autoOrder]: initialPurchase.orderNumber
        ? 'completed'
        : autoOrderSupported ? 'ready' : 'blocked',
      stock: forecastReady ? 'completed' : stockReady ? 'ready' : 'blocked',
      forecast: forecastReady ? 'ready' : 'blocked',
    },
    flow: {},
    override: {},
    fixtureScenario: order.fixtureScenario,
    fixture: true,
  };
}

export async function loadAutomaticOrderWorkspace({
  shops = [],
  forceRefresh = false,
  fixture = null,
  readSnapshot = requestOzonSalesOrdersSnapshotForShops,
  readBindings = loadSkuNameBindings,
  readOverrides = readPurchaseOrderOverridesFromLocalApi,
  readProfitSnapshot = readPurchaseProfitLedgerSnapshot,
  readSourceLinks = readProductSourceLinksFromLocalApi,
} = {}) {
  if (fixture?.enabled) {
    const fixtureShops = [{ id: 'virtual-shop-1', clientId: 'virtual-client-1', shopAlias: '虚拟测试店' }];
    const rows = (fixture.orders || createAutomaticOrderFixtureRows()).map((order) => mapFixtureRow(order, fixtureShops));
    return { rows, overrides: {}, shops: fixtureShops, errors: [], fixture: true, fetchedAt: new Date().toISOString() };
  }
  const purchaseOrderTimeScope = createOzonTimeRangeScope({
    page: 'purchase-orders',
    defaultDays: OZON_ORDER_DEFAULT_RANGE_DAYS,
  });
  const profitTimeScope = createOzonTimeRangeScope({
    page: 'profit-calculation',
    defaultDays: PROFIT_ORDER_DEFAULT_RANGE_DAYS,
  });
  const [snapshot, bindingDocument, overrides, profitSnapshot, sourceLinks] = await Promise.all([
    readSnapshot(shops, {
      forceRefresh,
      autoSync: forceRefresh,
      enrichCrossBorder: false,
      dateRange: purchaseOrderTimeScope.apiRange,
      timeScope: purchaseOrderTimeScope,
    }),
    readBindings(),
    readOverrides().catch(() => ({})),
    readProfitSnapshot(shops, profitTimeScope).catch(() => ({ rowsByKey: {} })),
    readSourceLinks().catch(() => ({})),
  ]);
  const profitRowsByKey = profitSnapshot?.rowsByKey || {};
  const rows = (snapshot.rows || [])
    .map(normalizeOzonSalesRowToPurchaseOrder)
    .map((order) => {
      const shop = resolveOrderShop(shops, order);
      const rawOverride = findPurchaseOrderLocalOverride(overrides, order, shop);
      const override = rawOverride && typeof rawOverride === 'object' && !Array.isArray(rawOverride)
        ? sanitizePurchaseOrderLocalOverrideForMerge(rawOverride)
        : {};
      const recordKey = getPurchaseOrderRecordKey(order);
      return annotatePurchaseOrder(clearVoidedPurchaseDisplayFields(applyPurchaseManualFallbacks({
        ...order,
        ...override,
        profitLedger: recordKey ? (profitRowsByKey[recordKey] ?? order.profitLedger) : order.profitLedger,
        purchaseManagementStartedAt: shop?.purchaseManagementStartedAt || '',
      }), rawOverride));
    })
    .filter((order) => order.status === '待拍单')
    .map((order) => mapAutomaticOrderRow(order, shops, bindingDocument, overrides, sourceLinks))
    .filter((row) => row.posting)
    .sort((left, right) => (
      (Date.parse(right.paymentTime || '') || 0) - (Date.parse(left.paymentTime || '') || 0)
    ));
  return {
    rows,
    overrides,
    shops,
    errors: snapshot.errors || [],
    fixture: false,
    fetchedAt: snapshot.fetchedAt,
  };
}

function fixtureError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function fixtureResult(action, row) {
  if (action === automaticOrderSections.autoOrder && row.fixtureScenario === 'purchase-price-changed') {
    throw fixtureError('AUTO_ORDER_SOURCE_PRICE_CHANGED', '货源价格发生变化，已停止付款。');
  }
  if (action === automaticOrderSections.stock && row.fixtureScenario === 'stock-status-changed') {
    throw fixtureError('AUTO_ORDER_OZON_STATUS_CHANGED', 'Ozon 订单状态已变化，不再是等待备货，已停止提交。');
  }
  if (action === automaticOrderSections.forecast && row.fixtureScenario === 'forecast-label-waiting') {
    throw fixtureError('AUTO_ORDER_LABEL_NOT_READY', 'Ozon 面单尚未生成，本单已保留等待下次重试。');
  }
  const now = new Date().toISOString();
  if (action === automaticOrderSections.autoOrder) {
    const first = row.products[0]?.exactBinding;
    const amount = row.products.reduce((sum, product) => (
      sum + (Number(product.exactBinding?.pair?.sourcePrice) || 0) * product.quantity
    ), 0);
    return {
      action,
      status: 'completed',
      message: '虚拟采购订单已创建并完成付款回读。',
      patch: {
        manualBuyerPlatform: text(first?.binding?.sourcePlatform) || '虚拟采购平台',
        buyerPlatform: text(first?.binding?.sourcePlatform) || '虚拟采购平台',
        supplier: text(first?.binding?.sourcePlatform) || '虚拟采购平台',
        manualPurchaseOrderNo: `VPO-${row.posting}`,
        purchaseOrderNumber: `VPO-${row.posting}`,
        manualPurchasePriceValue: Number(amount.toFixed(2)),
        sourceCostCny: Number(amount.toFixed(2)),
        manualPurchaseOrderStatus: '已付款',
        purchaseOrderStatus: '已付款',
        purchaseOrderUrl: first?.binding?.sourceUrl || '',
        purchasePaidAt: now,
      },
    };
  }
  if (action === automaticOrderSections.stock) {
    return {
      action,
      status: 'completed',
      message: '虚拟 Ozon 备货已回读确认。',
      patch: {
        purchaseForecastFlow: {
          version: 1,
          stage: 'ozon_prepared',
          postingNumber: row.posting,
          shopId: row.shopId,
          ozonStatus: OZON_ORDER_RAW_STATUS.awaitingDeliver,
          ozonPreparedAt: now,
          updatedAt: now,
        },
      },
      rowPatch: { rawStatus: OZON_ORDER_RAW_STATUS.awaitingDeliver },
    };
  }
  if (action === automaticOrderSections.forecast) {
    return {
      action,
      status: 'completed',
      message: '虚拟跨境巴士预报已创建并回查确认。',
      patch: {
        crossBorderOrderFound: true,
        crossBorderOrderNumber: `VCB-${row.posting}`,
        purchaseForecastFlow: {
          version: 1,
          stage: 'completed',
          postingNumber: row.posting,
          shopId: row.shopId,
          crossBorderOrderFound: true,
          crossBorderOrderNumber: `VCB-${row.posting}`,
          forecastCompletedAt: now,
          updatedAt: now,
        },
      },
    };
  }
  throw fixtureError('AUTO_ORDER_ACTION_UNSUPPORTED', '不支持的自动拍单操作。');
}

function desktopBridge() {
  return globalThis.window?.wangzaiDesktop?.purchaseBrowser || globalThis.wangzaiDesktop?.purchaseBrowser;
}

function readyLedgerNumber(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.status && !['ready', 'provisional'].includes(String(entry.status))) return null;
  return number(entry.value);
}

export function evaluateAutoPayProfitGate(row = {}, settings = {}) {
  const ledger = row.order?.profitLedger || row.profitLedger || null;
  const profit = readyLedgerNumber(ledger?.results?.estimatedProfitCny);
  const minimumProfit = Number(settings.minProfit ?? 0);
  const minimumPercent = Number(settings.minProfitPercent ?? 0);
  if (profit === null) {
    throw fixtureError('AUTO_ORDER_PROFIT_PENDING', '订单预估利润尚未完整回读，已停止自动付款。');
  }
  if (profit < minimumProfit) {
    throw fixtureError('AUTO_ORDER_MIN_PROFIT_NOT_MET', `订单预估利润${profit.toFixed(2)}元，低于配置的${minimumProfit.toFixed(2)}元。`);
  }
  let profitPercent = null;
  if (minimumPercent !== 0) {
    const salesAmount = readyLedgerNumber(ledger?.amounts?.salesAmountCny);
    if (salesAmount === null || salesAmount <= 0) {
      throw fixtureError('AUTO_ORDER_PROFIT_PERCENT_PENDING', '订单人民币销售额尚未完整回读，无法核对利润率。');
    }
    profitPercent = Number(((profit / salesAmount) * 100).toFixed(2));
    if (profitPercent < minimumPercent) {
      throw fixtureError('AUTO_ORDER_MIN_PROFIT_PERCENT_NOT_MET', `订单预估利润率${profitPercent.toFixed(2)}%，低于配置的${minimumPercent.toFixed(2)}%。`);
    }
  }
  return { profit: Number(profit.toFixed(2)), profitPercent };
}

async function executeRealAutoOrder(row) {
  if (!row.allBound) throw fixtureError('AUTO_ORDER_SKU_BINDING_REQUIRED', '订单商品尚未完成货源 SKU 精确绑定。');
  const command = desktopBridge()?.command;
  if (typeof command !== 'function') throw fixtureError('AUTO_ORDER_DESKTOP_REQUIRED', '当前环境没有连接内置采购浏览器。');
  const rawProducts = row.products.map((product) => ({
    ozonSkuId: product.sku,
    quantity: product.quantity,
    sourceUrl: product.exactBinding.binding.sourceUrl,
    sourcePlatform: product.exactBinding.binding.sourcePlatform,
    sourceSkuId: product.exactBinding.pair.sourceSkuId,
    sourceSkuName: product.exactBinding.pair.sourceSkuName,
    expectedUnitPrice: number(product.exactBinding.pair.sourcePrice),
  }));
  const products = groupAutomaticOrderProducts(rawProducts);
  const settings = await loadPurchaseAutoPaySettings();
  if (!settings.enabled) throw fixtureError('AUTO_ORDER_PAYMENT_DISABLED', '请先在拍单配置中开启自动支付。');
  if (row.cloudPurchase === true && settings.allowCloudPurchase !== true) {
    throw fixtureError('AUTO_ORDER_CLOUD_PURCHASE_DISABLED', '当前订单属于云端采购，拍单配置未允许云端采购订单。');
  }
  const profitGate = evaluateAutoPayProfitGate(row, settings);
  const accountPayload = await listPurchaseAccounts({ timeoutMs: 10000 }).catch(() => ({ accounts: [] }));
  const purchaseAccounts = Array.isArray(accountPayload?.accounts) ? accountPayload.accounts : [];
  const receiver = purchaseReceiver(row);
  const note = text(row.order?.buyerMemo || row.order?.note || row.order?.raw?.buyer_comment);

  const platformAllowed = (platform) => ({
    拼多多: settings.allowPinduoduo,
    淘宝: settings.allowTaobao,
    天猫: settings.allowTmall,
    '1688': settings.allow1688,
  }[platform] === true);
  const platformAccountIds = (platform) => ({
    拼多多: settings.allowedPinduoduoAccountIds,
    淘宝: settings.allowedTaobaoAccountIds,
    天猫: settings.allowedTaobaoAccountIds,
    '1688': settings.allowed1688AccountIds,
  }[platform] || settings.allowedAccountIds || []);
  const chooseAccount = (platform) => {
    const labels = platform === '淘宝' || platform === '天猫' ? new Set(['淘宝', '天猫']) : new Set([platform]);
    const allowed = new Set(platformAccountIds(platform));
    const exactId = text(row.sourceAccountId || row.purchase?.accountId);
    return purchaseAccounts.find((account) => account.id === exactId && labels.has(text(account.platformName || account.platform)))
      || purchaseAccounts.find((account) => labels.has(text(account.platformName || account.platform))
        && (!allowed.size || allowed.has(account.id)) && account.isDefault === true)
      || purchaseAccounts.find((account) => labels.has(text(account.platformName || account.platform))
        && (!allowed.size || allowed.has(account.id)));
  };

  const executeGroup = async (product, index) => {
    const sourcePlatform = text(product.sourcePlatform);
    if (!platformAllowed(sourcePlatform)) {
      throw fixtureError('AUTO_ORDER_PLATFORM_DISABLED', `拍单配置未开启${sourcePlatform}自动支付。`);
    }
    if (sourcePlatform === '1688' && settings.paymentMode1688 === 'protocol') {
      throw fixtureError(
        'AUTO_ORDER_1688_PROTOCOL_PAYMENT_UNAVAILABLE',
        '1688免密代扣依赖独立签约支付接口，当前未配置该接口，已停止订单。',
      );
    }
    const sourceAccount = chooseAccount(sourcePlatform);
    if (!sourceAccount?.id) throw fixtureError('AUTO_ORDER_PURCHASE_ACCOUNT_REQUIRED', `没有可用的${sourcePlatform}采购账号。`);
    const expectedTotal = (number(product.expectedUnitPrice) || 0) * (Number(product.quantity) || 1);
    if (expectedTotal > Number(settings.maxPayPrice || 0)) {
      throw fixtureError('AUTO_ORDER_MAX_PAYMENT_EXCEEDED', `采购金额超过${settings.maxPayPrice}元，已停止拍单。`);
    }
    let existingOrderNumber = products.length === 1
      && row.purchase?.orderNumber
      && (!row.purchase.platform || row.purchase.platform === sourcePlatform)
      && /待付款|等待付款|未付款/u.test(row.purchase.status || '')
      ? row.purchase.orderNumber
      : '';
    if (!existingOrderNumber) {
      const scan = await command({
        command: 'scan-purchase-wait-pay-orders',
        accountId: sourceAccount.id,
        platform: sourcePlatform,
      }).catch(() => null);
      const candidate = matchPendingPurchaseCandidate(scan?.rows, product, expectedTotal);
      if (candidate?.orderNumber) existingOrderNumber = candidate.orderNumber;
    }
    const request = {
      posting: row.posting,
      shopId: row.shopId,
      sourcePlatform,
      sourceAccountId: sourceAccount.id,
      sourceAccountLogin: text(sourceAccount.username || sourceAccount.purchaseAccountName || sourceAccount.loginAccount || sourceAccount.name),
      expectedTotal: Number(expectedTotal.toFixed(2)),
      existingOrderNumber,
      receiver,
      buyerMemo: note,
      maxShippingFee: 20,
      allowSimilarSku: true,
      idempotencyKey: `purchase-auto-order:${row.shopId}:${row.posting}:${index}:${sourcePlatform}:${product.sourceSkuId || product.sourceUrl}`,
      autoPay: true,
      autoSubmitOrder: settings.autoSubmitOrder,
      allowTogetherPay: settings.allowTogetherPay,
      maxPayPrice: settings.maxPayPrice,
      minProfit: settings.minProfit,
      minProfitPercent: settings.minProfitPercent,
      verifiedProfit: profitGate.profit,
      verifiedProfitPercent: profitGate.profitPercent,
      paymentMode1688: settings.paymentMode1688,
      skipPresale: settings.skipPresale,
      showVerificationWindow: settings.showVerificationWindow,
      products: [product],
    };
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const result = await command({ command: 'purchase-auto-order', order: request });
        if (result?.paused === true) {
          throw fixtureError(
            'PURCHASE_AUTO_ORDER_PAYMENT_PAUSED',
            result.pauseReason || '自动付款已暂停，请处理验证后点击继续。',
            { resumeTabId: result.tabId || result.sourceTabId || '', pauseReason: result.pauseReason || '' },
          );
        }
        if (!result?.ok || result?.paymentConfirmed !== true || !text(result.purchaseOrderNumber)) {
          throw fixtureError(result?.code || 'AUTO_ORDER_PAYMENT_NOT_CONFIRMED', result?.message || '采购平台没有返回付款成功回执。');
        }
        return { ...result, sourcePlatform, sourceAccountId: sourceAccount.id, product };
      } catch (error) {
        lastError = error;
        const code = text(error?.code || error?.message);
        if (/PAUSED|PASSWORD|CAPTCHA|VERIFICATION|RISK|LOCKED|ADDRESS|PRESALE|MAX_PAYMENT|SHIPPING/u.test(code)) throw error;
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
    throw lastError || fixtureError('AUTO_ORDER_PAYMENT_NOT_CONFIRMED', '采购平台没有返回付款成功回执。');
  };

  const results = [];
  results.push(await executeGroup(products[0], 0));
  if (products.length > 1) {
    if (settings.allowTogetherPay) {
      const remaining = await Promise.all(products.slice(1).map(async (product, offset) => {
        await new Promise((resolve) => setTimeout(resolve, offset * 10_000));
        return executeGroup(product, offset + 1);
      }));
      results.push(...remaining);
    } else {
      for (let index = 1; index < products.length; index += 1) results.push(await executeGroup(products[index], index));
    }
  }

  const orderItems = results.map((result) => ({
    platform: text(result.purchasePlatform || result.sourcePlatform),
    accountId: result.sourceAccountId,
    orderNumber: text(result.purchaseOrderNumber),
    amount: number(result.purchaseAmount),
    status: text(result.purchaseOrderStatus) || '已付款',
    url: text(result.purchaseOrderUrl),
    paidAt: text(result.paidAt) || new Date().toISOString(),
    shippingFee: number(result.shippingFee),
    transactionNo: text(result.transactionNo),
    paymentAccount: text(result.paymentAccount),
    productTitle: text(result.productTitle),
    skuName: text(result.sourceSkuName || result.product?.sourceSkuName),
  }));
  const totalAmount = orderItems.reduce((sum, item) => sum + (number(item.amount) || 0), 0);
  const orderNumbers = orderItems.map((item) => item.orderNumber).filter(Boolean);
  const platforms = [...new Set(orderItems.map((item) => item.platform).filter(Boolean))];
  return {
    action: automaticOrderSections.autoOrder,
    status: 'completed',
    message: results.length > 1 ? `${results.length}笔采购订单已付款并完成回读。` : '采购订单已付款并完成回读。',
    patch: {
      manualBuyerPlatform: platforms.length === 1 ? platforms[0] : '多平台',
      buyerPlatform: platforms.length === 1 ? platforms[0] : '多平台',
      supplier: platforms.length === 1 ? platforms[0] : '多平台',
      manualPurchaseOrderNo: orderNumbers.join(' / '),
      purchaseOrderNumber: orderNumbers.join(' / '),
      manualPurchasePriceValue: Number(totalAmount.toFixed(2)),
      sourceCostCny: Number(totalAmount.toFixed(2)),
      manualPurchaseOrderStatus: '已付款',
      purchaseOrderStatus: '已付款',
      purchaseOrderUrl: orderItems[0]?.url || '',
      purchasePaidAt: orderItems.at(-1)?.paidAt || new Date().toISOString(),
      purchaseAccountId: orderItems.length === 1 ? orderItems[0].accountId : '',
      purchaseAccountIds: [...new Set(orderItems.map((item) => item.accountId).filter(Boolean))],
      purchaseOrderItems: orderItems,
    },
  };
}

async function executeRealStock(row) {
  if (!row.shop) throw fixtureError('AUTO_ORDER_SHOP_REQUIRED', '订单没有匹配到可用的 Ozon 店铺。');
  const prepared = await prepareOzonForPurchaseForecast(row.shop, {
    ...row.order,
    posting: row.posting,
  });
  const now = new Date().toISOString();
  return {
    action: automaticOrderSections.stock,
    status: 'completed',
    message: prepared?.skipped ? 'Ozon 已备货，没有重复提交。' : 'Ozon 备货已提交。',
    patch: {
      purchaseForecastFlow: {
        ...row.flow,
        version: 1,
        stage: 'ozon_prepared',
        postingNumber: row.posting,
        shopId: row.shopId,
        ozonStatus: prepared?.rawStatus || 'awaiting_packaging',
        ozonPreparedAt: row.flow?.ozonPreparedAt || now,
        updatedAt: now,
      },
    },
    rowPatch: { rawStatus: text(prepared?.rawStatus) || row.rawStatus },
  };
}

async function executeRealForecast(row) {
  if (!row.shop) throw fixtureError('AUTO_ORDER_SHOP_REQUIRED', '订单没有匹配到可用的 Ozon 店铺。');
  const state = await readOzonPurchaseForecastState(row.shop, row.order, {
    syncSource: 'auto-order-one-click-forecast',
  });
  const label = await createOzonPackageLabelForPurchase(row.shop, {
    ...row.order,
    ...state.detailOrder,
    posting: state.postingNumber || row.posting,
  }, { maxCreateAttempts: 1, initialDetailOrder: state.detailOrder });
  if (!label?.sheetUrl || !label?.sheetOrderSn) {
    throw fixtureError('AUTO_ORDER_LABEL_NOT_READY', 'Ozon 面单尚未生成，本单已保留等待下次重试。');
  }
  const settings = readSavedCrossBorderOrderSettings();
  const fields = {
    country: 'RU',
    sheetOrderSn: label.sheetOrderSn,
    sheetUrl: label.sheetUrl,
    dataStatus: '1',
    purchasePlatform: row.purchase.platform,
    purchaseOrderNo: row.purchase.orderNumber,
    packageDesc: row.products.map((product) => product.name).filter(Boolean).join(' / '),
  };
  const { missing, body } = buildPurchaseCrossBorderCreateBody(settings, row.order, fields, { requireSheet: true });
  if (missing.length) throw fixtureError('AUTO_ORDER_FORECAST_FIELDS_MISSING', `缺少${missing.join('、')}，不能预报。`);
  const result = await requestProtectedCrossBorderOrderOperation('createOrder', settings, body, {
    confirmed: true,
    shopId: row.shopId,
    shopClientId: row.shop?.clientId || '',
  });
  const created = normalizeCrossBorderOrderCreateResult(result);
  if (!created.orderId && !created.orderNumber) {
    throw fixtureError('AUTO_ORDER_FORECAST_READBACK_FAILED', '跨境巴士没有返回预报订单号。');
  }
  const now = new Date().toISOString();
  return {
    action: automaticOrderSections.forecast,
    status: 'completed',
    message: '跨境巴士预报已创建。',
    patch: {
      crossBorderOrderFound: true,
      crossBorderOrderId: created.orderId || '',
      crossBorderOrderNumber: created.orderNumber || '',
      purchaseForecastFlow: {
        ...row.flow,
        version: 1,
        stage: 'completed',
        postingNumber: row.posting,
        shopId: row.shopId,
        sheetOrderSn: label.sheetOrderSn,
        sheetUrl: label.sheetUrl,
        crossBorderOrderFound: true,
        crossBorderOrderId: created.orderId || '',
        crossBorderOrderNumber: created.orderNumber || '',
        forecastCompletedAt: now,
        updatedAt: now,
      },
    },
  };
}

export async function executeAutomaticOrderAction(action, row, options = {}) {
  if (options.fixture || row.fixture) return fixtureResult(action, row);
  if (action === automaticOrderSections.autoOrder) return executeRealAutoOrder(row);
  if (action === automaticOrderSections.stock) return executeRealStock(row);
  if (action === automaticOrderSections.forecast) return executeRealForecast(row);
  throw fixtureError('AUTO_ORDER_ACTION_UNSUPPORTED', '不支持的自动拍单操作。');
}

export function automaticOrderErrorMessage(error) {
  const code = text(error?.code || error?.message);
  const messages = {
    AUTO_ORDER_SKU_BINDING_REQUIRED: '订单商品尚未完成货源 SKU 精确绑定。',
    AUTO_ORDER_DESKTOP_REQUIRED: '请在旺崽桌面端内运行自动拍单。',
    AUTO_ORDER_PAYMENT_NOT_CONFIRMED: '采购平台没有返回付款成功回执，未写入采购信息。',
    PURCHASE_AUTO_ORDER_PAYMENT_PAUSED: '自动付款已暂停，请处理验证后点击继续。',
    PURCHASE_AUTO_ORDER_NOT_PAUSED: '当前自动拍单没有可恢复的暂停任务。',
    AUTO_ORDER_SOURCE_PRICE_CHANGED: '货源价格发生变化，已停止付款。',
    AUTO_ORDER_PAYMENT_DISABLED: '请先在拍单配置中开启自动支付。',
    AUTO_ORDER_PLATFORM_DISABLED: '拍单配置未开启当前货源平台自动支付。',
    AUTO_ORDER_PURCHASE_ACCOUNT_REQUIRED: '当前货源平台没有可用的采购账号。',
    AUTO_ORDER_MAX_PAYMENT_EXCEEDED: String(error?.message || '采购金额超过配置上限，已停止拍单。'),
    AUTO_ORDER_1688_PROTOCOL_PAYMENT_UNAVAILABLE: '1688免密代扣接口未配置，已停止订单。',
    AUTO_ORDER_CLOUD_PURCHASE_DISABLED: '拍单配置未允许云端采购订单。',
    AUTO_ORDER_PENDING_ORDER_AMBIGUOUS: '采购账号存在多笔相同金额的待付款订单，无法唯一匹配，已停止重复下单。',
    PURCHASE_AUTO_ORDER_ADDRESS_REQUIRED: '采购页没有匹配到精确收货地址，请处理后继续。',
    PURCHASE_AUTO_ORDER_PRESALE_SKIPPED: '检测到预售或发货时间超过7天，已跳过。',
    PURCHASE_AUTO_ORDER_SHIPPING_FEE_EXCEEDED: '采购运费超过20元，已暂停确认。',
    PURCHASE_AUTO_ORDER_ACCOUNT_MISMATCH: '采购账号与当前页面登录账号不一致，已暂停。',
    AUTO_ORDER_PROFIT_PENDING: '订单预估利润尚未完整回读，已停止自动付款。',
    AUTO_ORDER_MIN_PROFIT_NOT_MET: String(error?.message || '订单预估利润低于配置下限。'),
    AUTO_ORDER_PROFIT_PERCENT_PENDING: '订单销售额尚未完整回读，无法核对利润率。',
    AUTO_ORDER_MIN_PROFIT_PERCENT_NOT_MET: String(error?.message || '订单预估利润率低于配置下限。'),
    AUTO_ORDER_LABEL_NOT_READY: 'Ozon 面单尚未生成，本单已保留等待下次重试。',
  };
  return messages[code] || text(error?.message) || code || '操作失败。';
}

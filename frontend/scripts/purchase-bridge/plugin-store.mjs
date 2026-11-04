function normalizeBridgeSourcePlatform(platform = '') {
  const text = String(platform || '').trim().toLowerCase();
  if (!text) return '其他';
  if (text.includes('pdd') || text.includes('拼多多') || text.includes('yangkeduo')) return 'PDD';
  if (text.includes('1688')) return '1688';
  if (text.includes('taobao') || text.includes('淘宝')) return '淘宝';
  if (text.includes('tmall') || text.includes('天猫')) return '天猫';
  if (text.includes('ozon-buyer') || text.includes('ozon buyer') || text.includes('ozon买家') || text.includes('ozon 买家')) return 'Ozon买家';
  return String(platform || '其他').trim() || '其他';
}

function detectBridgeSourcePlatformFromLink(link = '') {
  const text = String(link || '').toLowerCase();
  if (text.includes('yangkeduo.com') || text.includes('pinduoduo.com') || text.includes('pdd')) return 'PDD';
  if (text.includes('1688.com')) return '1688';
  if (text.includes('taobao.com')) return '淘宝';
  if (text.includes('tmall.com')) return '天猫';
  if (text.includes('ozon.ru') && !text.includes('seller.ozon.ru')) return 'Ozon买家';
  return '其他';
}

function normalizeBridgeOzonOwnerScope(value = {}) {
  const source = value && typeof value === 'object' ? value : { ownerId: value };
  const ownerId = String(firstPresent(source.ownerId, source.shopId) || '').trim();
  const shopIncarnation = String(firstPresent(source.shopIncarnation, source.shop_incarnation) || '').trim();
  const revision = Number(firstPresent(source.credentialRevision, source.credential_revision));
  const credentialRevision = Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
  return { ownerId, shopIncarnation, credentialRevision };
}

function bridgeContextIsFenced(context = {}) {
  const candidate = normalizeBridgeOzonOwnerScope(context);
  return (purgePurchasePluginShopOwner.fencedOwnerScopes || []).some((fence) => {
    if (!candidate.ownerId || candidate.ownerId !== fence.ownerId) return false;
    if (
      candidate.shopIncarnation
      && candidate.credentialRevision > 0
      && fence.shopIncarnation
      && fence.credentialRevision > 0
    ) {
      return candidate.shopIncarnation === fence.shopIncarnation
        && candidate.credentialRevision === fence.credentialRevision;
    }
    return true;
  });
}

function bridgePurchaseAccountIsFenced(context = {}) {
  const purchaseAccountId = String(firstPresent(context?.purchaseAccountId) || '').trim();
  return Boolean(purchaseAccountId && (purgePurchasePluginPurchaseAccountOwner.fencedAccountIds || []).includes(purchaseAccountId));
}

function normalizeBridgeSourceLink(value = '') {
  const rawText = cleanUrl(value);
  if (!rawText) return { ok: false, link: '', productId: '', platform: '', error: '缺少货源链接。' };
  let url = null;
  try {
    url = new URL(rawText);
  } catch {
    return { ok: false, link: rawText, productId: '', platform: '', error: '货源链接格式不正确。' };
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host.includes('yangkeduo.com') || host.includes('pinduoduo.com') || host.includes('pdd')) {
    const productId = url.searchParams.get('goods_id') || url.searchParams.get('goodsId') || '';
    if (!productId) return { ok: false, link: rawText, productId: '', platform: 'PDD', error: '未识别到 PDD goods_id。' };
    return {
      ok: true,
      link: `https://mobile.yangkeduo.com/goods.html?goods_id=${encodeURIComponent(productId)}`,
      productId,
      platform: 'PDD',
    };
  }
  if (host.includes('1688.com')) {
    const productId = path.match(/\/offer\/(\d+)\.html/i)?.[1] || rawText.match(/offer\/(\d+)\.html/i)?.[1] || '';
    if (!productId) return { ok: false, link: rawText, productId: '', platform: '1688', error: '未识别到 1688 商品ID。' };
    return { ok: true, link: `https://detail.1688.com/offer/${productId}.html`, productId, platform: '1688' };
  }
  if (host.includes('taobao.com')) {
    const productId = url.searchParams.get('id') || '';
    if (!productId) return { ok: false, link: rawText, productId: '', platform: '淘宝', error: '未识别到淘宝商品ID。' };
    return { ok: true, link: `https://item.taobao.com/item.htm?id=${encodeURIComponent(productId)}`, productId, platform: '淘宝' };
  }
  if (host.includes('tmall.com')) {
    const productId = url.searchParams.get('id') || '';
    if (!productId) return { ok: false, link: rawText, productId: '', platform: '天猫', error: '未识别到天猫商品ID。' };
    return { ok: true, link: `https://detail.tmall.com/item.htm?id=${encodeURIComponent(productId)}`, productId, platform: '天猫' };
  }
  if ((host === 'ozon.ru' || host.endsWith('.ozon.ru')) && host !== 'seller.ozon.ru') {
    const productPath = path.match(/^\/product\/([^/]+)/iu)?.[1] || '';
    const shortCode = path.match(/^\/t\/([^/]+)/iu)?.[1] || '';
    const productId = url.searchParams.get('id')
      || url.searchParams.get('product_id')
      || url.searchParams.get('sku')
      || productPath.match(/(?:^|-)(\d{5,})(?:$|-)/u)?.[1]
      || productPath.match(/(\d{5,})$/u)?.[1]
      || shortCode
      || '';
    if (!productId) return { ok: false, link: rawText, productId: '', platform: 'Ozon买家', error: '未识别到 Ozon 买家商品ID。' };
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|credential|session|auth)/iu.test(key)) url.searchParams.delete(key);
    }
    return { ok: true, link: url.toString(), productId, platform: 'Ozon买家' };
  }
  return { ok: false, link: rawText, productId: '', platform: '', error: '暂只支持 PDD、1688、淘宝、天猫、Ozon 买家链接。' };
}

function normalizePurchasePluginContext(raw = {}) {
  const context = raw && typeof raw === 'object' ? raw : {};
  return {
    shopName: String(firstPresent(context.shopName, context.shop) || '').slice(0, 120),
    shopId: String(firstPresent(context.shopId) || '').slice(0, 120),
    shopClientId: String(firstPresent(context.shopClientId, context.clientId) || '').slice(0, 120),
    purchaseAccountId: String(firstPresent(context.purchaseAccountId) || '').slice(0, 128),
    shopIncarnation: String(firstPresent(context.shopIncarnation, context.shop_incarnation) || '').slice(0, 180),
    credentialRevision: Number.isSafeInteger(Number(context.credentialRevision)) && Number(context.credentialRevision) > 0
      ? Number(context.credentialRevision)
      : 0,
    orderId: String(firstPresent(context.orderId, context.postingNumber) || '').slice(0, 160),
    orderKey: String(firstPresent(context.orderKey, context.key, context.orderId) || '').slice(0, 260),
    productKey: String(firstPresent(context.productKey, context.sourceKey) || '').slice(0, 260),
    legacyProductKey: String(firstPresent(context.legacyProductKey, context.offerId, context.sku) || '').slice(0, 160),
    offerId: String(firstPresent(context.offerId) || '').slice(0, 160),
    sku: String(firstPresent(context.sku) || '').slice(0, 160),
    productIndex: Number.isFinite(Number(context.productIndex)) ? Number(context.productIndex) : 0,
    productName: String(firstPresent(context.productName) || '').slice(0, 260),
    ozonOrderId: String(firstPresent(context.ozonOrderId, context.ozonId, context.softwareOrderId) || '').slice(0, 160),
    salesAmount: String(firstPresent(context.salesAmount, context.amount, context.orderAmount) || '').slice(0, 80),
    productImageUrl: normalizeImageUrl(firstPresent(context.productImageUrl, context.imageUrl, context.ozonImageUrl) || ''),
    lockedAt: String(firstPresent(context.lockedAt) || '').slice(0, 80),
    updatedAt: new Date().toISOString(),
  };
}

function normalizePurchasePluginCapture(raw = {}) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const type = String(firstPresent(body.type, body.captureType) || '').trim().toLowerCase();
  const captureType = type === 'order' ? 'order' : 'source';
  const context = normalizePurchasePluginContext(body.context && typeof body.context === 'object' ? body.context : {});
  if (!context.orderKey || !context.productKey) {
    throw createHttpError('请先在旺崽助手拍单管理里选中订单和商品，再使用插件保存。', 409);
  }
  const rawLink = firstPresent(body.shortLink, body.link, body.pageUrl, body.url) || '';
  const parsedLink = normalizeBridgeSourceLink(rawLink);
  const platform = normalizeBridgeSourcePlatform(firstPresent(body.platform, parsedLink.platform, detectBridgeSourcePlatformFromLink(rawLink)));
  const receivedAt = new Date().toISOString();
  const id = [
    captureType,
    context.orderKey,
    context.productKey,
    firstPresent(body.purchaseOrderNumber, body.orderNumber, parsedLink.link, rawLink),
    Date.now().toString(36),
  ].filter(Boolean).join(':');
  if (captureType === 'source' && !parsedLink.ok) {
    throw createHttpError(parsedLink.error || '当前页面不是可保存的货源链接。', 400);
  }
  const purchaseOrderNumber = String(firstPresent(body.purchaseOrderNumber, body.orderNumber, body.orderSn, body.orderId) || '').trim().slice(0, 120);
  const amount = String(firstPresent(body.amount, body.payAmount, body.totalAmount) || '').trim().slice(0, 80);
  const purchaseOrderStatus = String(
    firstPresent(body.purchaseOrderStatus, body.orderStatus, body.statusText, body.purchaseStatus) || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 160);
  if (captureType === 'order' && !purchaseOrderNumber && !amount) {
    throw createHttpError('当前页面未识别到订单号或付款金额，不能回填订单。', 400);
  }
  return {
    id,
    type: captureType,
    platform,
    context,
    pageUrl: String(firstPresent(body.pageUrl, body.url, rawLink) || '').slice(0, 1000),
    shortLink: parsedLink.ok ? parsedLink.link : '',
    productId: String(firstPresent(body.productId, parsedLink.productId) || '').slice(0, 120),
    title: String(firstPresent(body.title, body.productTitle, body.pageTitle) || '').replace(/\s+/g, ' ').trim().slice(0, 260),
    imageUrl: normalizeImageUrl(firstPresent(body.imageUrl, body.image) || ''),
    purchaseOrderNumber,
    amount,
    purchaseOrderStatus,
    silent: Boolean(body.silent),
    autoFill: Boolean(body.autoFill),
    capturedAt: String(firstPresent(body.capturedAt) || '').slice(0, 80),
    receivedAt,
  };
}

export function savePurchasePluginCapture(raw = {}) {
  const capture = normalizePurchasePluginCapture(raw);
  if (bridgeContextIsFenced(capture.context) || bridgePurchaseAccountIsFenced(capture.context)) {
    throw createHttpError('对应 Ozon 店铺正在执行永久删除，拍单上下文已封锁。', 409);
  }
  purchasePluginCaptures = [
    capture,
    ...purchasePluginCaptures.filter((item) => item.id !== capture.id),
  ].slice(0, PURCHASE_PLUGIN_CAPTURE_LIMIT);
  return capture;
}

export function setPurchasePluginContext(raw = {}) {
  const next = normalizePurchasePluginContext(raw);
  if (bridgeContextIsFenced(next) || bridgePurchaseAccountIsFenced(next)) {
    throw createHttpError('对应 Ozon 店铺正在执行永久删除，拍单上下文已封锁。', 409);
  }
  purchasePluginContext = next;
  return purchasePluginContext;
}

export function purgePurchasePluginShopOwner(ownerScope = '') {
  const scope = normalizeBridgeOzonOwnerScope(ownerScope);
  const normalizedOwnerId = scope.ownerId;
  if (!normalizedOwnerId) throw createHttpError('缺少 Ozon 店铺 ownerId。', 400);
  const fenced = purgePurchasePluginShopOwner.fencedOwnerScopes || [];
  if (!fenced.some((entry) => (
    entry.ownerId === scope.ownerId
    && entry.shopIncarnation === scope.shopIncarnation
    && entry.credentialRevision === scope.credentialRevision
  ))) purgePurchasePluginShopOwner.fencedOwnerScopes = [...fenced, scope];
  if (String(purchasePluginContext.shopId || '').trim() === normalizedOwnerId) purchasePluginContext = {};
  purchasePluginCaptures = purchasePluginCaptures.filter(
    (capture) => String(capture?.context?.shopId || '').trim() !== normalizedOwnerId,
  );
  const remaining = countPurchasePluginShopOwnerReferences(normalizedOwnerId);
  return {
    ownerId: normalizedOwnerId,
    shopIncarnation: scope.shopIncarnation,
    credentialRevision: scope.credentialRevision,
    verified: remaining === 0,
    remaining,
  };
}

export function countPurchasePluginShopOwnerReferences(ownerId = '') {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) return 0;
  return (String(purchasePluginContext.shopId || '').trim() === normalizedOwnerId ? 1 : 0)
    + purchasePluginCaptures.filter(
      (capture) => String(capture?.context?.shopId || '').trim() === normalizedOwnerId,
    ).length;
}

export function purgePurchasePluginPurchaseAccountOwner(ownerId = '') {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) throw createHttpError('缺少采购账号 ownerId。', 400);
  const fenced = purgePurchasePluginPurchaseAccountOwner.fencedAccountIds || [];
  if (!fenced.includes(normalizedOwnerId)) {
    purgePurchasePluginPurchaseAccountOwner.fencedAccountIds = [...fenced, normalizedOwnerId];
  }
  if (String(purchasePluginContext.purchaseAccountId || '').trim() === normalizedOwnerId) purchasePluginContext = {};
  purchasePluginCaptures = purchasePluginCaptures.filter(
    (capture) => String(capture?.context?.purchaseAccountId || '').trim() !== normalizedOwnerId,
  );
  const remaining = countPurchasePluginPurchaseAccountReferences(normalizedOwnerId);
  return { ownerId: normalizedOwnerId, verified: remaining === 0, remaining };
}

export function countPurchasePluginPurchaseAccountReferences(ownerId = '') {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) return 0;
  return (String(purchasePluginContext.purchaseAccountId || '').trim() === normalizedOwnerId ? 1 : 0)
    + purchasePluginCaptures.filter(
      (capture) => String(capture?.context?.purchaseAccountId || '').trim() === normalizedOwnerId,
    ).length;
}

export function getPurchasePluginContext() {
  return purchasePluginContext;
}

export function getPurchasePluginCaptures(after = 0) {
  const captures = Number.isFinite(after) && after > 0
    ? purchasePluginCaptures.filter((item) => Date.parse(item.receivedAt || '') > after)
    : purchasePluginCaptures;
  return captures.slice(0, PURCHASE_PLUGIN_CAPTURE_LIMIT);
}

export function isPurchasePluginConnected() {
  return Boolean(purchasePluginContext.orderKey && purchasePluginContext.productKey);
}

export function resetPurchasePluginStoreForTest() {
  purchasePluginContext = {};
  purchasePluginCaptures = [];
  purgePurchasePluginShopOwner.fencedOwnerScopes = [];
  purgePurchasePluginPurchaseAccountOwner.fencedAccountIds = [];
}

import { createHttpError } from './auth.mjs';
import { PURCHASE_PLUGIN_CAPTURE_LIMIT } from './config.mjs';
import { cleanUrl, firstPresent, normalizeImageUrl } from './search-utils.mjs';

let purchasePluginContext = {};
let purchasePluginCaptures = [];

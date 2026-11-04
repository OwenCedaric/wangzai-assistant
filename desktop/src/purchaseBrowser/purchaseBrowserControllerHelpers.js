import { createHash } from 'node:crypto';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) fail('PURCHASE_BROWSER_COMMAND_CANCELLED');
}

function requiredText(value, code, maximum = 500) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum || /[\u0000-\u001F\u007F]/u.test(text)) fail(code);
  return text;
}

function sanitizedErrorCode(error) {
  const code = String(error?.code || error?.message || 'PURCHASE_BROWSER_EXECUTION_FAILED');
  return /^(?:PURCHASE_BROWSER|PURCHASE_REHEARSAL|CROSS_BORDER|FOLLOW_SELLER|OZON|ALIPAY)_[A-Z0-9_]+$/u.test(code)
    ? code
    : 'PURCHASE_BROWSER_EXECUTION_FAILED';
}

function isOzonSellerLoginUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const path = parsed.pathname.toLowerCase();
    return parsed.hostname.toLowerCase() === 'seller.ozon.ru'
      && (path.includes('/signin') || path.includes('/login'));
  } catch {
    return false;
  }
}

function isOzonAuthenticationDeniedResult(result = {}) {
  const status = Number(result?.status) || 0;
  return status === 401 || isOzonSellerLoginUrl(result?.url || result?.pageUrl);
}

function isRecoverableOpenError(error) {
  const code = String(error?.code || error?.message || '');
  return code === 'PURCHASE_BROWSER_SESSION_STALE'
    || code === 'PURCHASE_BROWSER_CEF_PROTOCOL_CLOSED'
    || code === 'PURCHASE_BROWSER_CEF_PROTOCOL_UNAVAILABLE'
    || code === 'PURCHASE_BROWSER_CEF_RUNTIME_CLOSED'
    || code === 'PURCHASE_BROWSER_CEF_HOST_UNHEALTHY'
    || code === 'PURCHASE_BROWSER_COMMAND_TIMEOUT'
    || code.startsWith('PURCHASE_BROWSER_CEF_HOST_');
}

function isTransientCaptureContextError(error) {
  return sanitizedErrorCode(error) === 'PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY';
}

function isPinduoduoUrl(value = '') {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return host === 'yangkeduo.com'
      || host.endsWith('.yangkeduo.com')
      || host === 'pinduoduo.com'
      || host.endsWith('.pinduoduo.com');
  } catch {
    return false;
  }
}

function isPinduoduoProductUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (!isPinduoduoUrl(url.toString())) return false;
    return /\/(?:goods|goods_detail)\.html$/iu.test(url.pathname)
      || Boolean(url.searchParams.get('goods_id') || url.searchParams.get('goodsId'));
  } catch {
    return false;
  }
}

function isAlibaba1688Url(value = '') {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return host === '1688.com'
      || host.endsWith('.1688.com')
      || host === 'alibaba.com'
      || host.endsWith('.alibaba.com');
  } catch {
    return false;
  }
}

function purchasePlatformFromUrl(value = '') {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    if (host === '1688.com' || host.endsWith('.1688.com') || host === 'alibaba.com' || host.endsWith('.alibaba.com')) return '1688';
    if (host === 'yangkeduo.com' || host.endsWith('.yangkeduo.com') || host === 'pinduoduo.com' || host.endsWith('.pinduoduo.com')) return '拼多多';
    if (host === 'tmall.com' || host.endsWith('.tmall.com')) return '天猫';
    if (host === 'taobao.com' || host.endsWith('.taobao.com')) return '淘宝';
    if ((host === 'ozon.ru' || host.endsWith('.ozon.ru')) && host !== 'seller.ozon.ru') return 'Ozon买家';
    return '';
  } catch {
    return '';
  }
}

function purchaseSourceProductId(value = '') {
  try {
    const url = new URL(String(value || ''));
    return cleanOptionalText(
      url.pathname.match(/\/(?:offer|item|goods)\/(\d{5,})/iu)?.[1]
      || url.pathname.match(/\/(\d{5,})\.html$/iu)?.[1]
      || ['offerId', 'offer_id', 'id', 'itemId', 'item_id', 'goods_id', 'goodsId', 'product_id']
        .map((key) => url.searchParams.get(key))
        .find(Boolean),
      260,
    );
  } catch {
    return '';
  }
}

function purchaseOverrideIsVoided(override = {}) {
  const raw = override.raw && typeof override.raw === 'object' ? override.raw : {};
  const refunded = [override.purchaseRefundConfirmed, raw.purchaseRefundConfirmed]
    .some((value) => value === true || value === 1 || ['true', '1'].includes(String(value ?? '').trim().toLowerCase()));
  const forceStatus = cleanOptionalText(override.forcePurchaseStatus || raw.forcePurchaseStatus, 80);
  const voidedOrderNo = cleanOptionalText(override.voidedPurchaseOrderNo || raw.voidedPurchaseOrderNo, 260);
  return refunded || (forceStatus === '待拍单' && Boolean(voidedOrderNo));
}

function isConfirmedPurchaseOrderStatus(value = '') {
  const text = String(value || '').trim();
  return Boolean(
    text
    && /支付成功|买家已付款|已付款|待发货|等待商家发货|等待卖家发货|已发货|待收货|交易成功|已完成/u.test(text)
    && !/待付款|等待付款|退款|关闭|取消/u.test(text)
  );
}

function isConfirmedPurchaseRefundStatus(value = '') {
  const text = String(value || '').trim();
  return Boolean(
    text
    && /极速退款成功|退款成功|已退款|退款完成/u.test(text)
    && !/申请退款|退款处理中|等待退款|退款审核|退款失败|退款关闭/u.test(text)
  );
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizePinduoduoTopLevelUrl(value = '') {
  const original = String(value || '').trim();
  try {
    const url = new URL(original);
    const host = url.hostname.toLowerCase();
    if (![
      'yangkeduo.com',
      'www.yangkeduo.com',
      'pinduoduo.com',
      'www.pinduoduo.com',
      'mobile.yangkeduo.com',
    ].includes(host)) return original;
    url.protocol = 'https:';
    url.hostname = 'mobile.yangkeduo.com';
    url.port = '';
    return url.toString();
  } catch {
    return original;
  }
}

function normalizePurchaseWorkbenchForPlatform(platformKey = '', workbench = null) {
  return workbench;
}

function canonicalReceipt(value = {}) {
  const amount = Number(String(value.amount ?? '').replace(/^[¥￥]/u, ''));
  if (!Number.isFinite(amount) || amount < 0) fail('PURCHASE_BROWSER_RECEIPT_AMOUNT_INVALID');
  return Object.freeze({
    orderNumber: requiredText(value.orderNumber, 'PURCHASE_BROWSER_RECEIPT_ORDER_NUMBER_REQUIRED', 260),
    amount: amount.toFixed(2),
    status: requiredText(value.status, 'PURCHASE_BROWSER_RECEIPT_STATUS_REQUIRED', 120),
    pageUrl: requiredText(value.pageUrl, 'PURCHASE_BROWSER_RECEIPT_PAGE_URL_REQUIRED', 1600),
  });
}

function cleanOptionalText(value, maximum = 1800) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, maximum)
    : '';
}

export {
  fail,
  assertNotAborted,
  requiredText,
  sanitizedErrorCode,
  isOzonSellerLoginUrl,
  isOzonAuthenticationDeniedResult,
  isRecoverableOpenError,
  isTransientCaptureContextError,
  isPinduoduoUrl,
  isPinduoduoProductUrl,
  isAlibaba1688Url,
  purchasePlatformFromUrl,
  purchaseSourceProductId,
  purchaseOverrideIsVoided,
  isConfirmedPurchaseOrderStatus,
  isConfirmedPurchaseRefundStatus,
  sha256,
  normalizePinduoduoTopLevelUrl,
  normalizePurchaseWorkbenchForPlatform,
  canonicalReceipt,
  cleanOptionalText,
};

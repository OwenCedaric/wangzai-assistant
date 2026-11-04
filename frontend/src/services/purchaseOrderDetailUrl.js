const PURCHASE_ORDER_DETAIL_URL_TEMPLATES = {
  天猫: 'https://trade.tmall.com/detail/orderDetail.htm?spm=tbpc.boughtlist.order_detail.1.21282e8ddrElZ2&bizOrderId=',
  淘宝: 'https://trade.taobao.com/trade/detail/trade_order_detail.htm?spm=tbpc.boughtlist.order_detail.1.67b22e8dtmbxOB&biz_order_id=',
  拼多多: 'https://mobile.yangkeduo.com/order.html?order_sn=',
  1688: 'https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=',
};

const EMPTY_TEXT_VALUES = new Set(['', '-', '--', '未返回', '待补录', '待拍单', '待确认', 'null', 'undefined', '0']);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeValidText(value) {
  const text = normalizeText(value);
  return EMPTY_TEXT_VALUES.has(text.toLowerCase()) || EMPTY_TEXT_VALUES.has(text) ? '' : text;
}

function normalizeUrl(value) {
  const text = normalizeText(value);
  return /^https?:\/\//iu.test(text) ? text : '';
}

export function normalizePurchasePlatformName(value) {
  const text = normalizeValidText(value);
  const lower = text.toLowerCase();
  if (!text) return '';
  if (/天猫|tmall/iu.test(text) || lower.includes('tmall')) return '天猫';
  if (/淘宝|taobao/iu.test(text) || lower.includes('taobao')) return '淘宝';
  if (/拼多多|pdd|yangkeduo|pinduoduo/iu.test(text) || lower.includes('pdd')) return '拼多多';
  if (/1688|阿里巴巴/iu.test(text)) return '1688';
  return '';
}

export function buildPurchaseOrderDetailUrl(platform, orderNumber) {
  const normalizedPlatform = normalizePurchasePlatformName(platform);
  const normalizedOrderNumber = normalizeValidText(orderNumber);
  const template = PURCHASE_ORDER_DETAIL_URL_TEMPLATES[normalizedPlatform];
  if (!template || !normalizedOrderNumber) return '';
  return `${template}${encodeURIComponent(normalizedOrderNumber)}`;
}

export function resolvePurchaseOrderDetailUrl({ platform, orderNumber, explicitUrl } = {}) {
  return normalizeUrl(explicitUrl) || buildPurchaseOrderDetailUrl(platform, orderNumber);
}

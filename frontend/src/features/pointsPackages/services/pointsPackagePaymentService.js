import {
  completeDevelopmentPayment,
  createStoreOrder,
  getPointWallet,
  getStoreOrder,
  listPointLedger,
  listPointPackages,
  queryStoreOrderPayment,
  startOrderPayment,
} from '../../licensing/services/licenseCenterClient.js';

const ALIPAY_CHECKOUT_HOSTS = new Set(['openapi.alipay.com', 'openapi-sandbox.dl.alipaydev.com']);

export function normalizePointPackage(item) {
  const points = Number(item?.points_amount || 0);
  const priceCent = Number(item?.sale_price_cent || 0);
  return {
    id: item?.id,
    name: String(item?.name || '积分套餐'),
    caption: String(item?.customer_description || '软件积分充值套餐'),
    price: priceCent / 100,
    priceCent,
    points,
    validityDays: Number(item?.validity_days || 0),
    tag: item?.featured ? '推荐' : `${Number(item?.validity_days || 0)} 天有效`,
    featured: Boolean(item?.featured),
    paymentProviders: Array.isArray(item?.payment_providers) ? item.payment_providers : [],
    projectCode: String(item?.project_code || ''),
  };
}

export async function loadPointPackageCatalog(runtime) {
  const packageItems = await listPointPackages(runtime);
  return packageItems.map(normalizePointPackage);
}

export async function loadPointsAccount(runtime) {
  const [packageItems, wallet, ledgerPage] = await Promise.all([
    listPointPackages(runtime),
    getPointWallet(runtime),
    listPointLedger(runtime, { page: 1, pageSize: 20 }),
  ]);
  return {
    packages: packageItems.map(normalizePointPackage),
    wallet,
    ledger: Array.isArray(ledgerPage?.items) ? ledgerPage.items : [],
  };
}

export function createPointsOrderIdempotencyKey(packageId) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  return `points-${packageId}-${random}`.slice(0, 64);
}

export async function beginPointsCheckout({ runtime, packageItem, provider, idempotencyKey }) {
  if (!packageItem?.id) throw new Error('积分套餐不存在或已停售');
  const order = await createStoreOrder(runtime, packageItem.id, idempotencyKey);
  const payment = await startOrderPayment(order.id, provider);
  return { order, payment };
}

export function resolvePointsPaymentCheckoutUrl(payment) {
  if (payment?.provider !== 'alipay') return '';
  try {
    const url = new URL(String(payment?.code_url || '').trim());
    if (
      url.protocol !== 'https:' ||
      !ALIPAY_CHECKOUT_HOSTS.has(url.hostname.toLowerCase()) ||
      url.pathname !== '/gateway.do' ||
      url.searchParams.get('method') !== 'alipay.trade.page.pay' ||
      url.username ||
      url.password ||
      url.hash
    )
      return '';
    return url.toString();
  } catch {
    return '';
  }
}

export async function queryPointsCheckout(orderId) {
  return queryStoreOrderPayment(orderId);
}

export async function completePointsDevelopmentCheckout(orderNo) {
  return completeDevelopmentPayment(orderNo);
}

export async function readPointsOrder(orderId) {
  return getStoreOrder(orderId);
}

export function pointOrderIsFulfilled(order) {
  return (
    order?.status === 'fulfilled' &&
    order?.plan_kind === 'points' &&
    Number(order?.fulfillment?.points_credited || 0) > 0
  );
}

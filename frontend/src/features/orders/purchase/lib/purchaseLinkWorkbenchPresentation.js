import { buildPurchaseOrderWorkbenchPresentation } from './purchaseOrderWorkbenchPresentation.js';

function browserLabel(url = '') {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    if (host === 'seller.ozon.ru') return 'Ozon Seller 页面';
    if (host === '1688.com' || host.endsWith('.1688.com') || host.endsWith('.alibaba.com')) return '1688 采购页面';
    if (host === 'taobao.com' || host.endsWith('.taobao.com')) return '淘宝采购页面';
    if (host === 'tmall.com' || host.endsWith('.tmall.com')) return '天猫采购页面';
    if (host.endsWith('.yangkeduo.com') || host.endsWith('.pinduoduo.com')) return '拼多多采购页面';
    if (host === 'ozon.ru' || host.endsWith('.ozon.ru')) return 'Ozon 买家页面';
  } catch {
    return '采购页面';
  }
  return '采购页面';
}

function workbenchNotice(url = '') {
  try {
    if (new URL(String(url || '')).hostname.toLowerCase() === 'seller.ozon.ru') {
      return 'Ozon Seller 页面已固定在当前售后操作台内，关闭卡片时浏览器会同步隐藏。';
    }
  } catch {
    // Use the normal purchase notice below.
  }
  return '采购页面已固定在当前订单操作台内，关闭卡片时浏览器会同步隐藏。';
}

export function buildPurchaseLinkWorkbenchPresentation({
  url = '',
  order = {},
  product = {},
  sourceEntry = {},
  sourceShop = null,
  purchaseInfo = {},
  crossBorderInfo = {},
  profitItems = null,
  sidebarKind = 'order',
  profit = null,
  afterSales = null,
  title = '',
  subtitle = '',
} = {}) {
  const sourceLink = sourceEntry.link || purchaseInfo.sourceLink || url;
  return {
    ...buildPurchaseOrderWorkbenchPresentation({
      order,
      product,
      sourceEntry,
      sourceShop,
      sourceLink,
      purchaseInfo,
      crossBorderInfo,
      profitItems,
    }),
    sidebarKind,
    ...(profit ? { profit } : {}),
    ...(afterSales ? { afterSales } : {}),
    title: title || '订单采购操作台',
    subtitle: subtitle || '左侧订单和采购信息固定，右侧国内采购页面独立操作',
    browserLabel: browserLabel(url),
    notice: workbenchNotice(url),
  };
}

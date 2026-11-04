using System.Text.Json.Nodes;

namespace Wangzai.CefBrowserHost;

internal static class PurchaseWaitPayScanScript
{
	public const string Value = """
(() => {
  const clean = (value, max = 800) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
  const number = (value) => {
    const match = String(value ?? '').replace(/,/gu, '').match(/-?\d+(?:\.\d+)?/u);
    const result = Number(match?.[0]);
    return Number.isFinite(result) ? result : null;
  };
  const deepRoots = () => {
    const result = [], pending = [document], seen = new Set();
    while (pending.length && result.length < 40) {
      const root = pending.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root); result.push(root);
      let nodes = [];
      try { nodes = [...root.querySelectorAll('*')]; } catch {}
      for (const node of nodes) if (node.shadowRoot) pending.push(node.shadowRoot);
    }
    return result;
  };
  const rows = [];
  const host = location.hostname.toLowerCase();
  if (host.includes('yangkeduo.com') || host.includes('pinduoduo.com')) {
    const source = globalThis.rawData?.ordersStore?.initOdersList?.['1']
      || globalThis.rawData?.ordersStore?.initOdersList?.[1] || [];
    for (const order of source) {
      const orderNumber = clean(order.order_sn || order.orderSn, 260);
      if (!orderNumber) continue;
      const goods = Array.isArray(order.order_goods) ? order.order_goods : Array.isArray(order.orderGoods) ? order.orderGoods : [];
      rows.push({
        platform: '拼多多', orderNumber,
        amount: Number(order.display_amount ?? order.displayAmount) / 100,
        status: clean(order.chatStatusPrompt || order.status_prompt || '待付款', 120),
        title: goods.map(item => clean(item.goods_name || item.goodsName)).filter(Boolean).join(' / '),
        sku: goods.map(item => clean(item.spec)).filter(Boolean).join(' / '),
        source: 'rawData', pageUrl: location.href,
      });
    }
  } else if (host.endsWith('taobao.com') || host.endsWith('tmall.com')) {
    const source = Array.isArray(globalThis.data?.mainOrders) ? globalThis.data.mainOrders : [];
    for (const order of source) {
      const orderNumber = clean(order.id || order.orderId, 260);
      if (!orderNumber) continue;
      rows.push({
        platform: host.endsWith('tmall.com') ? '天猫' : '淘宝', orderNumber,
        amount: number(order.payInfo?.actualFee), status: clean(order.statusInfo?.text || '待付款', 120),
        title: (order.subOrders || []).map(item => clean(item.title)).filter(Boolean).join(' / '),
        sku: (order.subOrders || []).map(item => clean(item.skuText || item.itemInfo?.skuText)).filter(Boolean).join(' / '),
        source: 'data.mainOrders', pageUrl: location.href,
      });
    }
    if (!rows.length) for (const container of document.querySelectorAll('div[id^="shopOrderContainer_"]')) {
      const orderNumber = clean(container.id.replace(/^shopOrderContainer_/u, ''), 260);
      if (!orderNumber) continue;
      const payment = container.querySelector(`#orderPaymentCol_${CSS.escape(orderNumber)}`) || container;
      rows.push({
        platform: '淘宝', orderNumber,
        amount: number(payment.querySelector('.trade-price-integer')?.textContent + payment.querySelector('.trade-price-point')?.textContent + payment.querySelector('.trade-price-decimal')?.textContent),
        status: clean(container.querySelector('.shopInfoStatus--InnfaPAJ')?.textContent || '待付款', 120),
        title: clean(container.querySelector('.suborder_itemtitle')?.textContent), sku: '',
        source: 'dom', pageUrl: location.href,
      });
    }
  } else if (host.endsWith('1688.com') || host.endsWith('alibaba.com')) {
    for (const root of deepRoots()) {
      let orders = [];
      try { orders = [...root.querySelectorAll('order-item, li.order-item')]; } catch {}
      for (const order of orders) {
        const text = clean(order.textContent, 5000);
        const orderNumber = clean(order.querySelector?.('.order-id')?.textContent?.replace(/订单号[：:]?/u, '') || text.match(/订单号[：:]?\s*(\d{8,30})/u)?.[1], 260);
        if (!orderNumber || rows.some(row => row.orderNumber === orderNumber)) continue;
        rows.push({
          platform: '1688', orderNumber,
          amount: number(order.querySelector?.('.total-price, order-item-total-price')?.textContent || text.match(/(?:合计|总价|实付款)[^¥￥\d]{0,20}(?:¥|￥)?\s*\d+(?:\.\d+)?/u)?.[0]),
          status: clean(order.querySelector?.('.order-status, order-item-status')?.textContent || '待付款', 120),
          title: clean(order.querySelector?.('.product-name, .productName, order-item-entry-product')?.textContent),
          sku: '', source: 'shadow-dom', pageUrl: location.href,
        });
      }
    }
  }
  return JSON.stringify({ ok: true, pageUrl: location.href, rows: rows.slice(0, 200) });
})()
""";
}

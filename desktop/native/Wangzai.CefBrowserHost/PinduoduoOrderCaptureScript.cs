namespace Wangzai.CefBrowserHost;

internal static class PinduoduoOrderCaptureScript
{
	public const string Value = """
(() => {
  const clean = (value, maximum = 600) => String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
  let body = clean(String(document.body?.innerText || '').replace(/[\r\n\t]/gu, ' '), 200000);
  let readPageFields = true;
  const params = new URLSearchParams(location.search || '');
  const firstText = (selectors, maximum = 600) => {
    if (!readPageFields) return '';
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)].slice(0, 80);
      for (const node of nodes) {
        const value = clean(node.getAttribute?.('content') || node.getAttribute?.('data-order-sn')
          || node.getAttribute?.('data-order-number') || node.getAttribute?.('data-order-id') || node.textContent, maximum);
        if (value) return value;
      }
    }
    return '';
  };
  const labelled = (patterns, maximum = 600) => {
    for (const pattern of patterns) {
      const match = body.match(pattern);
      if (match?.[1]) return clean(match[1], maximum);
    }
    return '';
  };
  const numeric = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;
    const match = clean(value, 100).replace(/,/gu, '').match(/\d+(?:\.\d{1,2})?/u);
    const number = match ? Number(match[0]) : Number.NaN;
    return Number.isFinite(number) ? number : null;
  };
  const roots = [];
  for (const value of [window.rawData, window.store?.initDataObj, window.__NEXT_DATA__, window.__INITIAL_STATE__]) {
    if (value && typeof value === 'object') roots.push(value);
  }
  for (const script of [...document.querySelectorAll('script[type="application/json"], script[id*="DATA" i]')].slice(0, 12)) {
    try {
      const value = JSON.parse(script.textContent || '');
      if (value && typeof value === 'object') roots.push(value);
    } catch { /* ignore non-JSON scripts */ }
  }
  const orderKeys = new Set(['order_sn', 'ordersn', 'order_id', 'orderid', 'order_number', 'ordernumber', 'trade_id', 'tradeid']);
  const ownOrder = value => Object.entries(value).filter(([key]) => orderKeys.has(key.toLowerCase()))
    .map(([, child]) => typeof child === 'string' || typeof child === 'number' ? clean(child, 260) : '').find(Boolean) || '';
  const records = [];
  const pending = roots.map(value => ({ value, depth: 0 }));
  const seen = new Set();
  for (let index = 0; index < pending.length && index < 5000; index += 1) {
    const { value, depth } = pending[index];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const id = ownOrder(value);
    if (id) records.push({ id, value });
    if (depth < 9) for (const child of Object.values(value)) {
      if (child && typeof child === 'object' && pending.length < 5000) pending.push({ value: child, depth: depth + 1 });
    }
  }
  let fieldRoots = roots;
  let selectedOrder = '';
  const deepValue = (keys) => {
    const wanted = new Set(keys.map(key => String(key).toLowerCase()));
    const queue = fieldRoots.map(value => ({ value, depth: 0 }));
    const visited = new Set();
    let examined = 0;
    while (queue.length && examined < 5000) {
      const current = queue.shift();
      const value = current?.value;
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      visited.add(value);
      examined += 1;
      if (selectedOrder && ownOrder(value) && ownOrder(value) !== selectedOrder) continue;
      for (const [key, child] of Object.entries(value)) {
        if (wanted.has(String(key).toLowerCase()) && child !== null && child !== undefined && child !== '') return child;
        if (current.depth < 9 && child && typeof child === 'object') queue.push({ value: child, depth: current.depth + 1 });
      }
    }
    return '';
  };
  const urlOrderNumber = ['order_sn', 'orderSn', 'order_id', 'orderId', 'trade_id', 'tradeId']
    .map(key => clean(params.get(key), 260)).find(Boolean) || '';
  const structuredIds = [...new Set(records.map(record => record.id))];
  const domOrderSelectors = [
    '[data-order-sn]', '[data-order-number]', '[data-order-id]', '[class*="order-sn"]',
    '[class*="orderSn"]', '[class*="order-number"]', '[class*="orderNumber"]',
  ];
  const domOrderIds = [];
  for (const selector of domOrderSelectors) for (const node of [...document.querySelectorAll(selector)].slice(0, 80)) {
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
    }
    const value = clean(node.getAttribute?.('data-order-sn') || node.getAttribute?.('data-order-number')
      || node.getAttribute?.('data-order-id') || node.textContent, 260);
    const id = value.match(/[A-Za-z0-9._:@/+\-=]{5,120}/u)?.[0];
    if (id) domOrderIds.push(id);
  }
  const textOrderNumber = labelled([
    /(?:订单编号|订单号码|订单号|交易号|交易编号|订单ID)\s*[:：]?\s*([A-Za-z0-9._:@/+\-=]{5,120})/u,
  ], 260);
  const textOrderIds = [...body.matchAll(/(?:订单编号|订单号码|订单号|交易号|交易编号|订单ID)\s*[:：]?\s*([A-Za-z0-9._:@/+\-=]{5,120})/gu)].map(match => match[1]);
  const visibleIds = [...new Set([...domOrderIds, textOrderNumber, ...textOrderIds].filter(Boolean))];
  const orderNumber = clean(urlOrderNumber || visibleIds[0] || (structuredIds.length === 1 ? structuredIds[0] : ''), 260);
  const matchingRecords = records.filter(record => record.id === orderNumber);
  const identityMismatch = visibleIds.length > 1 || visibleIds.some(id => id !== orderNumber)
    || (orderNumber && structuredIds.length > 0 && !matchingRecords.length)
    || (!orderNumber && structuredIds.length > 1);
  if (identityMismatch) return JSON.stringify({
    extensionVersion: '1.6.0', runtimeKind: 'builtin', platform: '拼多多', pageType: 'order-detail',
    pageUrl: location.href, sourceUrl: location.href, purchaseOrderUrl: location.href,
    orderNumber: '', purchaseOrderNumber: '', amount: '', purchasePrice: null, currency: 'CNY',
    purchaseOrderStatus: '', paymentConfirmed: false, refundConfirmed: false,
    orderCaptureStatus: 'rejected', orderRejectionReasons: ['order-identity-mismatch'],
    capturedAt: new Date().toISOString(), fieldConfidence: { purchaseOrderNumber: 0, purchasePrice: 0 },
  });
  selectedOrder = orderNumber;
  if (structuredIds.some(id => id !== orderNumber)) {
    // A page may retain a whole order list. Never pair URL order A with the
    // first cached order B's price/status. Unscoped DOM is not proof for A.
    fieldRoots = matchingRecords.map(record => record.value);
    if (!visibleIds.length) { body = ''; readPageFields = false; }
  }
  const statusTitle = readPageFields ? String(document.title || '') : '';

  const structuredStatus = clean(deepValue([
    'order_status_text', 'orderStatusText', 'status_text', 'statusText', 'order_status_desc',
    'orderStatusDesc', 'order_status', 'orderStatus', 'statusDesc',
  ]), 160);
  const domStatus = firstText([
    '[data-order-status]', '[data-status-text]', '[class*="order-status"]', '[class*="orderStatus"]',
    '[class*="status-text"]', '[class*="statusText"]',
  ], 160);
  const labelledStatus = labelled([
    /(?:订单状态|交易状态|付款状态|支付状态)\s*[:：]?\s*([^\n]{2,40})/u,
  ], 160);
  const confirmedRefundPattern = /(极速退款成功|退款成功|已退款|退款完成)/u;
  const pendingRefundPattern = /(申请退款|退款处理中|等待退款|退款审核|退款失败|退款关闭)/u;
  const titleRefundStatus = clean(statusTitle.match(confirmedRefundPattern)?.[1], 160);
  const bodyRefundStatus = clean(body.match(confirmedRefundPattern)?.[1], 160);
  const confirmedRefundStatus = titleRefundStatus || bodyRefundStatus;
  const knownStatusPattern = /(支付成功|买家已付款|已付款|待发货|等待商家发货|等待卖家发货|已发货|待收货|交易成功|已完成|待付款|等待付款|订单已关闭|交易关闭|已取消)/u;
  const titleStatus = clean(statusTitle.match(knownStatusPattern)?.[1], 160);
  const keywordStatus = clean(body.match(knownStatusPattern)?.[1], 160);
  const paidActionStatus = /催发货|申请退款/u.test(body) ? '待发货' : '';
  const readableStructuredStatus = /^\d+$/u.test(structuredStatus) ? '' : structuredStatus;
  const labelledKnownStatus = clean(labelledStatus.match(knownStatusPattern)?.[1], 160);
  // A confirmed refund page can still retain the previous paid status in rawData.
  // The current visible refund result must therefore win over stale structured state.
  // PDD also exposes unrelated numeric `status` fields deep inside rawData. The
  // visible current-page title/label must win, and a bare numeric value is not
  // an order status.
  const rawStatus = clean(confirmedRefundStatus || readableStructuredStatus || domStatus || labelledKnownStatus || titleStatus || keywordStatus || paidActionStatus, 160);
  const confirmedStatusPattern = /支付成功|买家已付款|已付款|待发货|等待商家发货|等待卖家发货|已发货|待收货|交易成功|已完成/u;
  const status = /待付款|等待付款|立即支付/u.test(`${rawStatus} ${body.slice(0, 20000)}`)
    && !confirmedStatusPattern.test(rawStatus)
    && !confirmedRefundPattern.test(rawStatus)
    ? '待付款'
    : clean(rawStatus, 160);
  const refundConfirmed = Boolean(
    status
    && confirmedRefundPattern.test(status)
    && !pendingRefundPattern.test(status)
  );
  const paymentConfirmed = Boolean(
    status
    && confirmedStatusPattern.test(status)
    && !refundConfirmed
    && !/待付款|等待付款|退款|关闭|取消/u.test(status)
  );

  const labelledAmount = labelled([
    /(?:实付款|实付金额|实付|付款金额|支付金额|订单金额|应付金额|合计)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/u,
  ], 80);
  const domAmount = firstText([
    '[data-pay-amount]', '[data-order-amount]', '[class*="pay-amount"]', '[class*="payAmount"]',
    '[class*="actual-amount"]', '[class*="actualAmount"]', '[class*="order-amount"]', '[class*="orderAmount"]',
  ], 80);
  const structuredAmount = deepValue([
    'pay_amount', 'payAmount', 'actual_amount', 'actualAmount', 'order_amount', 'orderAmount',
    'total_amount', 'totalAmount', 'amount',
  ]);
  const purchasePrice = numeric(labelledAmount) ?? numeric(domAmount) ?? numeric(structuredAmount);
  const productTitle = firstText([
    '[data-goods-name]', '[class*="goods-name"]', '[class*="goodsName"]', '[class*="product-name"]', '[class*="productName"]',
  ], 600) || labelled([/(?:商品名称|商品)\s*[:：]\s*([^\n]{4,200})/u], 600);
  const quantity = labelled([/(?:购买数量|商品数量|数量)\s*[:：xX×]?\s*(\d{1,6})/u], 40)
    || firstText(['[data-quantity]', '[class*="quantity"]'], 40).match(/\d{1,6}/u)?.[0] || '';
  const sourceProductId = clean(
    params.get('goods_id') || params.get('goodsId') || deepValue(['goods_id', 'goodsId']),
    260,
  );
  const pageHaystack = `${document.title} ${location.pathname} ${body.slice(0, 12000)}`;
  const pageType = orderNumber || /订单详情|交易详情|订单编号|订单号|支付成功|待发货|待收货|极速退款成功|退款成功|已退款|退款完成|complaints_refund_success/u.test(pageHaystack)
    ? 'order-detail'
    : 'unknown';
  return JSON.stringify({
    extensionVersion: '1.6.0', runtimeKind: 'builtin', platform: '拼多多', pageType,
    pageUrl: location.href, sourceUrl: location.href, purchaseOrderUrl: location.href,
    pageTitle: clean(document.title, 300), productTitle, quantity,
    amount: purchasePrice === null ? '' : String(purchasePrice),
    purchasePrice, currency: 'CNY', sourceProductId,
    orderNumber, purchaseOrderNumber: orderNumber,
    purchaseOrderStatus: status, orderStatus: status, statusText: status, status,
    paymentConfirmed, refundConfirmed, capturedAt: new Date().toISOString(),
    fieldConfidence: {
      platform: 1,
      purchaseOrderNumber: orderNumber ? (urlOrderNumber ? 1 : 0.92) : 0,
      purchasePrice: purchasePrice === null ? 0 : (labelledAmount ? 0.98 : 0.88),
      quantity: quantity ? 0.85 : 0,
    },
  });
})()
""";
}

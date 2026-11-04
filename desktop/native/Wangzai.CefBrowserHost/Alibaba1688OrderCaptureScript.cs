namespace Wangzai.CefBrowserHost;

internal static class Alibaba1688OrderCaptureScript
{
	public const string Value = """
(() => {
  const clean = (value, maximum = 1200) => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
  const blockText = (node, maximum = 40000) => clean(node?.innerText || node?.textContent || '', maximum);
  const ownText = (node) => clean(Array.from(node?.childNodes || [])
    .filter((child) => child?.nodeType === 3)
    .map((child) => child.textContent || '')
    .join(' '), 500);
  const absoluteUrl = (value) => {
    try {
      const url = new URL(String(value || ''), location.href);
      if (!/^https?:$/u.test(url.protocol)) return '';
      url.hash = '';
      return url.toString();
    } catch { return ''; }
  };
  const numeric = (value) => {
    const match = clean(value, 100).replace(/,/gu, '').match(/\d+(?:\.\d{1,2})?/u);
    const number = match ? Number(match[0]) : Number.NaN;
    return Number.isFinite(number) ? number : null;
  };
  const orderPattern = /(?:订单号|订单编号|交易号|交易编号)\s*[:：]?\s*([0-9]{12,30})/gu;
  const statusPattern = /(退款成功|已退款|退款完成|退款处理中|申请退款|交易关闭|订单关闭|已关闭|已取消|交易取消|待付款|等待付款|支付成功|买家已付款|已付款|待发货|等待卖家发货|等待商家发货|已发货|待收货|交易成功|已完成)/u;
  const explicitRefundPattern = /(退款成功|已退款|退款完成)/u;
  const currentOrderNumber = clean((() => {
    try {
      const url = new URL(location.href);
      return url.searchParams.get('orderId') || url.searchParams.get('order_id') || '';
    } catch { return ''; }
  })(), 40);
  const isExactOrderDetail = Boolean(currentOrderNumber)
    && /(?:order|trade|trade-order-detail)/iu.test(location.href);
  // 新版 1688 详情页的“交易关闭”位于顶部，而“退款成功”在商品行的兄弟
  // 区域。订单局部容器不一定覆盖商品行，所以在 URL 已精确绑定单号的详情
  // 页补扫一次可见页面文本。只认明确退款成功，绝不把普通关闭当退款。
  let pageRefundStatus = '';
  // 子框架的 location 可能不是订单详情 URL，但可见商品行仍在该框架内。
  // 先收集明确退款证据，最终是否归属于当前订单由宿主使用顶层精确
  // orderId 再绑定；列表页不会直接套用这份全页证据。
  {
    for (const node of Array.from(document.querySelectorAll('body *')).slice(0, 30000)) {
      if (!node?.getClientRects?.().length) continue;
      const match = ownText(node).match(explicitRefundPattern);
      if (match?.[1]) {
        pageRefundStatus = clean(match[1], 80);
        break;
      }
    }
    if (!pageRefundStatus) {
      pageRefundStatus = clean(blockText(document.body, 120000).match(explicitRefundPattern)?.[1], 80);
    }
  }
  const amountPattern = /(?:订单实付|实付款(?:含运费)?|实付金额|付款金额|支付金额|订单金额|应付金额|应付总额|订单总价|货品总价|总金额|总计|合计)[\s\S]{0,100}?[¥￥]?\s*(\d+(?:\.\d{1,2})?)/u;
  const moneyByKeyPattern = /["'](?:actualAmount|payAmount|paidAmount|totalAmount|orderAmount|sumPayment|sumPaymentNoCarriage|totalFee|actualFee)["']\s*:\s*["']?(\d+(?:\.\d{1,2})?)/iu;
  const rejectedTitle = /^(?:订单|订单号|下单账号|下单时间|商品快照|订单详情|交易操作|总金额|卖家|买家|联系卖家|查看保单|再次购买|申请退款|提醒发货|搜索)$/u;
  const markers = [];
  const seenMarker = new Set();
  for (const node of Array.from(document.querySelectorAll('body *')).slice(0, 20000)) {
    const direct = ownText(node);
    if (!direct || direct.length > 500) continue;
    orderPattern.lastIndex = 0;
    for (const match of direct.matchAll(orderPattern)) {
      const orderNumber = clean(match[1], 40);
      const key = `${orderNumber}:${markers.length}`;
      if (!orderNumber || seenMarker.has(key)) continue;
      markers.push({ node, orderNumber });
      seenMarker.add(key);
    }
  }
  if (!markers.length) {
    const body = blockText(document.body, 80000);
    orderPattern.lastIndex = 0;
    for (const match of body.matchAll(orderPattern)) {
      const orderNumber = clean(match[1], 40);
      if (orderNumber) markers.push({ node: document.body, orderNumber });
    }
  }
  const chooseContainer = (marker, orderNumber) => {
    let node = marker;
    let fallback = marker;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      const text = blockText(node, 40000);
      if (!text.includes(orderNumber)) continue;
      if (text.length >= 50 && text.length <= 40000) fallback = node;
      if (text.length >= 80 && text.length <= 40000 && statusPattern.test(text) && amountPattern.test(text)) return node;
    }
    return fallback;
  };
  const titleCandidates = (container) => {
    const values = [];
    const push = (value) => {
      const title = clean(value, 600);
      if (title.length < 4 || rejectedTitle.test(title) || /^https?:/iu.test(title)) return;
      if (/^(?:¥|￥)?\d+(?:\.\d+)?(?:\s*[xX×]\s*\d+)?$/u.test(title)) return;
      if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/u.test(title)) return;
      if (!values.includes(title)) values.push(title);
    };
    const selectors = [
      '[data-offer-title]', '[data-product-title]', '[class*="offer-title"]',
      '[class*="product-title"]', '[class*="item-title"]', '[class*="goods-title"]',
      '[class*="productName"]', '[class*="itemName"]',
      'a[href*="detail.1688.com/offer/"]', 'a[href*="/offer/"]',
      'a[title]', 'img[alt]'
    ];
    for (const node of Array.from(container?.querySelectorAll?.(selectors.join(',')) || []).slice(0, 120)) {
      push(node.getAttribute?.('data-offer-title'));
      push(node.getAttribute?.('data-product-title'));
      push(node.getAttribute?.('title'));
      push(node.getAttribute?.('alt'));
      push(node.innerText || node.textContent);
    }
    return values.sort((left, right) => right.length - left.length).slice(0, 12);
  };
  const structuredAmount = (container, orderNumber) => {
    const roots = [container, document].filter(Boolean);
    for (const root of roots) {
      const selectors = [
        '[data-actual-amount]', '[data-pay-amount]', '[data-paid-amount]',
        '[data-total-amount]', '[data-order-amount]', '[data-total-fee]'
      ];
      for (const node of Array.from(root.querySelectorAll?.(selectors.join(',')) || []).slice(0, 100)) {
        const value = numeric(
          node.getAttribute?.('data-actual-amount')
          || node.getAttribute?.('data-pay-amount')
          || node.getAttribute?.('data-paid-amount')
          || node.getAttribute?.('data-total-amount')
          || node.getAttribute?.('data-order-amount')
          || node.getAttribute?.('data-total-fee')
          || node.innerText
          || node.textContent
        );
        if (value !== null && value > 0) return value;
      }
    }
    for (const node of Array.from(document.querySelectorAll?.('script') || []).slice(0, 300)) {
      const scriptText = String(node.textContent || '');
      if (scriptText.length > 2000000 || (orderNumber && !scriptText.includes(orderNumber))) continue;
      const value = numeric(scriptText.match(moneyByKeyPattern)?.[1]);
      if (value !== null && value > 0) return value;
    }
    return null;
  };
  const legacyAmount = (text, quantityValue) => {
    const exact = numeric(text.match(amountPattern)?.[1]);
    if (exact !== null && exact > 0) return exact;
    const unitPrice = numeric(
      text.match(/(?:单价(?:（元）|\(元\))?|货品单价|商品单价)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/u)?.[1]
      || text.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)\s*元?\s*\/[\u3400-\u9fffA-Za-z]+/u)?.[1]
      || text.match(/(?:^|\s)(\d+(?:\.\d{1,2})?)\s*元\s*\/\s*[^\s]+/u)?.[1]
    );
    const quantity = Number(quantityValue);
    if (unitPrice === null || !Number.isFinite(quantity) || quantity <= 0) return null;
    const freightMatch = text.match(/(?:运费|物流费|配送费)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/u);
    const hasFreeFreight = /免运费|包邮|运费\s*[:：]?\s*[¥￥]?\s*0(?:\.0{1,2})?/u.test(text);
    if (!freightMatch && !hasFreeFreight) return null;
    const freight = freightMatch ? numeric(freightMatch[1]) : 0;
    if (freight === null) return null;
    return Number((unitPrice * quantity + freight).toFixed(2));
  };
  const linkInfo = (container) => {
    let orderUrl = '';
    let sourceUrl = '';
    for (const link of Array.from(container?.querySelectorAll?.('a[href]') || []).slice(0, 200)) {
      const href = absoluteUrl(link.getAttribute('href') || link.href);
      if (!href) continue;
      if (!sourceUrl && /(?:detail\.1688\.com\/offer\/\d+\.html|offerId=\d+|offer_id=\d+)/iu.test(href)) sourceUrl = href;
      if (!orderUrl && /(?:order|trade|bizOrder|orderId|tradeId|buyer_order)/iu.test(href)) orderUrl = href;
    }
    return { orderUrl, sourceUrl };
  };
  const candidateByNumber = new Map();
  for (const marker of markers) {
    if (candidateByNumber.has(marker.orderNumber)) continue;
    const container = chooseContainer(marker.node, marker.orderNumber);
    const text = blockText(container, 40000);
    const statuses = [...text.matchAll(new RegExp(statusPattern.source, 'gu'))]
      .map((match) => clean(match?.[1], 80))
      .filter(Boolean);
    // 1688 的退款详情顶部先显示“交易关闭”，商品行才显示“退款成功”。
    // 旧逻辑只取第一个状态，导致真实退款被当作普通关闭订单。明确的
    // 退款成功证据优先级最高；只有申请中/按钮文案时仍保留顶部状态。
    const refundStatus = statuses.find((value) => explicitRefundPattern.test(value))
      || (marker.orderNumber === currentOrderNumber ? pageRefundStatus : '')
      || '';
    const status = clean(refundStatus || statuses[0], 80);
    const productTitles = titleCandidates(container);
    const { orderUrl, sourceUrl } = linkInfo(container);
    const sourceProductId = clean(
      sourceUrl.match(/\/offer\/(\d+)\.html/iu)?.[1]
      || new URLSearchParams(sourceUrl.split('?')[1] || '').get('offerId')
      || new URLSearchParams(sourceUrl.split('?')[1] || '').get('offer_id'),
      80,
    );
    const quantity = clean(
      text.match(/(?:数量|购买数量)\s*[:：xX×]?\s*(\d{1,6})/u)?.[1]
      || text.match(/(?:^|\s)[xX×]\s*(\d{1,6})(?:\s|$)/u)?.[1]
      || text.match(/\d+(?:\.\d{1,2})?\s*元\s*\/\s*[^\s]+\s+(\d{1,6})(?:\s|$)/u)?.[1],
      20,
    );
    const purchasePrice = structuredAmount(container, marker.orderNumber)
      ?? legacyAmount(text, quantity);
    const refundConfirmed = Boolean(refundStatus) && /退款成功|已退款|退款完成/u.test(status)
      && !/退款处理中|申请退款/u.test(status);
    const paymentConfirmed = /支付成功|买家已付款|已付款|待发货|等待卖家发货|等待商家发货|已发货|待收货|交易成功|已完成/u.test(status)
      && !refundConfirmed;
    candidateByNumber.set(marker.orderNumber, {
      platform: '1688', pageType: 'order-detail',
      pageUrl: location.href, purchaseOrderUrl: orderUrl || location.href,
      sourceUrl, sourceProductId,
      productTitle: productTitles[0] || '', productTitles,
      quantity, purchaseOrderNumber: marker.orderNumber, orderNumber: marker.orderNumber,
      purchasePrice, amount: purchasePrice === null ? '' : String(purchasePrice), currency: 'CNY',
      purchaseOrderStatus: status, orderStatus: status, statusText: status, status,
      paymentConfirmed, refundConfirmed,
      fieldConfidence: {
        platform: 1, productTitle: productTitles.length ? 0.9 : 0,
        quantity: quantity ? 0.85 : 0, purchaseOrderNumber: 1,
        purchasePrice: purchasePrice === null ? 0 : 0.98,
      },
    });
  }
  const orderCandidates = [...candidateByNumber.values()];
  const single = orderCandidates.length === 1 ? orderCandidates[0] : {};
  return JSON.stringify({
    extensionVersion: '1.0.0', runtimeKind: 'builtin', platform: '1688',
    pageType: orderCandidates.length > 1 ? 'order-list' : (single.pageType || 'unknown'),
    pageUrl: location.href, sourceUrl: single.sourceUrl || location.href,
    pageTitle: clean(document.title, 300),
    currentOrderNumber,
    pageRefundStatus,
    ...single,
    orderCandidates,
    capturedAt: new Date().toISOString(),
  });
})()
""";
}

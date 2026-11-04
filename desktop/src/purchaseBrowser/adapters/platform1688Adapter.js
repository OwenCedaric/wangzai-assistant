import {
  captureNumber,
  captureUrl,
  cleanCaptureText,
  createPurchasePlatformAdapter,
} from './basePurchasePlatformAdapter.js';

const baseAdapter = createPurchasePlatformAdapter({
  id: '1688',
  label: '1688',
  hosts: ['1688.com', 'alibaba.com'],
  aliases: ['1688', '阿里巴巴'],
});

function normalizeOrderCandidate(value = {}) {
  const titles = (Array.isArray(value.productTitles) ? value.productTitles : [value.productTitle])
    .map((item) => cleanCaptureText(item, 600))
    .filter(Boolean)
    .slice(0, 20);
  return Object.freeze({
    purchaseOrderNumber: cleanCaptureText(value.purchaseOrderNumber || value.orderNumber, 260),
    purchaseOrderUrl: captureUrl(value.purchaseOrderUrl || value.orderUrl || value.pageUrl),
    sourceUrl: captureUrl(value.sourceUrl),
    sourceProductId: cleanCaptureText(value.sourceProductId, 260),
    productTitle: cleanCaptureText(value.productTitle || titles[0], 600),
    productTitles: Object.freeze(titles),
    quantity: value.quantity ?? null,
    purchasePrice: captureNumber(value.purchasePrice ?? value.amount),
    currency: cleanCaptureText(value.currency, 12).toUpperCase() || 'CNY',
    purchaseOrderStatus: cleanCaptureText(
      value.purchaseOrderStatus || value.orderStatus || value.statusText || value.status,
      160,
    ),
    paymentConfirmed: value.paymentConfirmed === true,
    refundConfirmed: value.refundConfirmed === true,
  });
}

export const platform1688Adapter = Object.freeze({
  ...baseAdapter,
  normalize(context = {}) {
    const capture = baseAdapter.normalize(context);
    return {
      ...capture,
      currentOrderNumber: cleanCaptureText(context.currentOrderNumber, 260),
      orderCandidates: Object.freeze(
        (Array.isArray(context.orderCandidates) ? context.orderCandidates : [])
          .map(normalizeOrderCandidate)
          .filter((candidate) => candidate.purchaseOrderNumber)
          .slice(0, 100),
      ),
    };
  },
});

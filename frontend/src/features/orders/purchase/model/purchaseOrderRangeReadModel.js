import { queryRowsIndex } from '../../../../services/localMirrorDataset';
import { shouldIncludeOrderInBusinessFlow } from '../../../../services/orderSplitRelationRules';
import { doesAssociatedOrderMatchKeyword } from '../../../../entities/profit/profitSearchRules.jsx';
import { getPurchaseOrderPaymentDateKey, purchaseOrderStageTabs } from '../lib/purchaseMarketingApi.jsx';
import { derivePurchaseOrderStatus, isPurchaseOrderRefundPending } from '../lib/purchaseOrderNormalize.jsx';

// Counts always cover the entire matching range, independently of page/status.
// Cache references only for the current immutable index; a new snapshot drops
// every entry, including any changed row that could affect manual classification.
export function createPurchaseOrderRangeReader() {
  let currentIndex = null;
  const entries = new Map();
  const metadata = new WeakMap();
  const describe = order => {
    if (!metadata.has(order)) metadata.set(order, {
      paymentDateKey: getPurchaseOrderPaymentDateKey(order),
      businessFlow: shouldIncludeOrderInBusinessFlow(order),
      status: derivePurchaseOrderStatus(order),
      refundPending: isPurchaseOrderRefundPending(order),
    });
    return metadata.get(order);
  };
  let retainedRows = 0;
  return (index, { selectedShopScope, keyword, fulfillment, paymentStartKey, paymentEndKey }) => {
    if (index !== currentIndex) {
      currentIndex = index;
      entries.clear();
      retainedRows = 0;
    }
    const key = JSON.stringify([selectedShopScope, keyword, fulfillment, paymentStartKey, paymentEndKey]);
    if (entries.has(key)) {
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    }
    const rows = queryRowsIndex(index, { shopScope: selectedShopScope, keyword }).filter((order) => {
      const description = describe(order);
      const matchSplitBusiness = description.businessFlow;
      const matchFulfillment = fulfillment === 'all' || order.fulfillment === fulfillment;
      const matchKeyword = doesAssociatedOrderMatchKeyword(order, keyword, [
        order.shop, order.supplier, order.product, order.sku, order.searchText, order.purchaseOrderNo, order.packageOrderId,
      ]);
      const paymentDateKey = description.paymentDateKey;
      const matchPaymentStart = !paymentStartKey || !paymentDateKey || paymentDateKey >= paymentStartKey;
      const matchPaymentEnd = !paymentEndKey || !paymentDateKey || paymentDateKey <= paymentEndKey;
      return matchSplitBusiness && matchFulfillment && matchKeyword && matchPaymentStart && matchPaymentEnd;
    });
    const stageCounts = Object.fromEntries(purchaseOrderStageTabs.map(tab => [tab.value, 0]));
    const moduleCounts = { all: rows.length, '待拍单': 0, exception: 0, afterSales: 0 };
    for (const order of rows) {
      const { status, refundPending } = describe(order);
      if (Object.hasOwn(stageCounts, status) && status !== 'all') stageCounts[status] += 1;
      if (status === '待拍单') moduleCounts['待拍单'] += 1;
      if (status === '已拍单-未操作') moduleCounts.exception += 1;
      if (status === '已拍单-售后单' || refundPending) moduleCounts.afterSales += 1;
    }
    if (Object.hasOwn(stageCounts, 'all')) stageCounts.all = rows.length;
    const result = { rows, stageCounts, moduleCounts };
    entries.set(key, result);
    retainedRows += rows.length;
    // Ten shops plus all/search, with at most two full-range arrays retained.
    while (entries.size > 12 || (entries.size > 1 && retainedRows > index.orderedKeys.length * 2)) {
      const oldest = entries.keys().next().value;
      retainedRows -= entries.get(oldest).rows.length;
      entries.delete(oldest);
    }
    return result;
  };
}

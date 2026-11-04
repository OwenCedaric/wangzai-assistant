import { requestOzonSalesOrderDetail } from '../marketing/marketingOrderFields.jsx';
import { getAfterSalesPostingLookupKeys } from './orderAsyncRules.jsx';
import { hasUsefulOzonOrderProductInfo } from './orderDisplayFormat.jsx';

export async function requestOzonAfterSalesOriginalOrderDetail(shop, row = {}) {
  const postingCandidates = getAfterSalesPostingLookupKeys(row);
  if (!postingCandidates.length) return row;

  const preferredFulfillment = String(row.channel || '')
    .toUpperCase()
    .includes('FBO')
    ? 'FBO'
    : 'FBS';
  const fulfillmentCandidates = preferredFulfillment === 'FBO' ? ['FBO', 'FBS'] : ['FBS', 'FBO'];
  let fallbackDetail = row;

  for (const posting of postingCandidates) {
    for (const fulfillment of fulfillmentCandidates) {
      try {
        const detailOrder = await requestOzonSalesOrderDetail(shop, {
          ...row,
          posting,
          fulfillment,
        });
        if (fallbackDetail === row) fallbackDetail = detailOrder;
        const detailProducts = Array.isArray(detailOrder.products) ? detailOrder.products : [];
        if (detailProducts.some(hasUsefulOzonOrderProductInfo)) return detailOrder;
      } catch {
        // 售后补图只读失败时继续试另一种订单详情或母单号。
      }
    }
  }

  return fallbackDetail;
}

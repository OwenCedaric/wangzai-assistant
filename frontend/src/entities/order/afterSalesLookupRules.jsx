import { getOzonOrderProducts } from './orderDisplayFormat.jsx';
import { getProfitPostingLookupKeys } from '../profit/profitPostingRules.jsx';

export function getAfterSalesItemLookupKeys(item = {}) {
  const firstProduct = getOzonOrderProducts(item)[0] ?? {};
  return getProfitPostingLookupKeys([
    item.posting_number,
    item.postingNumber,
    item.order_number,
    item.orderNumber,
    item.order_id,
    item.orderId,
    item.posting?.posting_number,
    item.posting?.postingNumber,
    item.posting?.order_id,
    item.posting?.orderId,
    firstProduct.raw?.posting_number,
    firstProduct.raw?.postingNumber,
    firstProduct.financialRaw?.posting_number,
    firstProduct.financialRaw?.postingNumber,
  ]);
}

import { firstFilled, getOzonRowShopScopeValues } from '../../../../entities/order/orderShopScope.jsx';
import { buildRowsIndex } from '../../../../services/localMirrorDataset';
import { getPurchaseOrderRecordKey, purchaseOrderStageTabs } from '../lib/purchaseMarketingApi.jsx';
import { derivePurchaseOrderStatus } from '../lib/purchaseOrderNormalize.jsx';

export const purchaseOrderSearchIndexOptions = {
  getRowKey: order => `${firstFilled(order.shopClientId, order.shopId, order.shop)}:${getPurchaseOrderRecordKey(order)}`,
  getRowShop: getOzonRowShopScopeValues,
  getRowStatuses: order => {
    const status = derivePurchaseOrderStatus(order);
    return purchaseOrderStageTabs.filter(tab => tab.value === 'all' || tab.value === status).map(tab => tab.value);
  },
  getSearchValues: order => [order.id, order.salesOrder, order.ozonOrderId, order.purchaseOrderNo, order.packageOrderId,
    ...(Array.isArray(order.packageOrderIds) ? order.packageOrderIds : []), order.busOrderId,
    order.shop, order.supplier, order.product, order.sku, order.productNo, order.searchText],
};

// Retain only one index. Images, money and detail enrichment must update the
// row objects, but do not change the search/status/shop inverted indexes.
export function createPurchaseOrderSearchIndex() {
  let previous = null;
  const byRow = new WeakMap();
  return rows => {
    const metadata = new Map();
    const identities = new Set();
    const signatures = [];
    let reusable = previous?.signatures.length === rows.length;
    for (const [index, row] of rows.entries()) {
      let entry = byRow.get(row);
      const key = entry?.key ?? String(purchaseOrderSearchIndexOptions.getRowKey(row) ?? '').trim();
      if (!key || identities.has(key)) {
        previous = null;
        return buildRowsIndex(rows, purchaseOrderSearchIndexOptions);
      }
      identities.add(key);
      if (!entry) {
        entry = { key, shops: purchaseOrderSearchIndexOptions.getRowShop(row),
          statuses: purchaseOrderSearchIndexOptions.getRowStatuses(row), search: purchaseOrderSearchIndexOptions.getSearchValues(row) };
        const normalize = values => (Array.isArray(values) ? values : [values]).map(value => String(value ?? '').trim());
        entry.signature = JSON.stringify([key, normalize(entry.shops), normalize(entry.statuses), normalize(entry.search)]);
        byRow.set(row, entry);
      }
      metadata.set(row, entry);
      const signature = entry.signature;
      signatures.push(signature);
      if (signature !== previous?.signatures[index]) reusable = false;
    }
    const index = reusable
      ? { ...previous.index, rowsByKey: new Map(rows.map(row => [metadata.get(row).key, row])) }
      : buildRowsIndex(rows, {
        getRowKey: row => metadata.get(row).key, getRowShop: row => metadata.get(row).shops,
        getRowStatuses: row => metadata.get(row).statuses, getSearchValues: row => metadata.get(row).search,
      });
    previous = { index, signatures };
    return index;
  };
}

import { getOzonShopClientId } from '../../../../entities/order/orderShopScope.jsx';
import { enrichAfterSalesRowsWithCachedClassificationEvidence } from '../services/afterSalesCachedClassificationService.js';
import React from 'react';

export function getAfterSalesClassificationCacheKey(row = {}) {
  const shopKey = row.shopId || row.shopClientId || row.shop || '';
  const rowKey = row.id || row.returnId || row.return_id || row.salesOrder || row.posting || '';
  return `${shopKey}:${rowKey}`;
}

export function useAfterSalesCachedClassification(rows = [], shops = []) {
  const [state, setState] = React.useState({ sourceRows: null, rows: [] });
  const classifiedRowsRef = React.useRef(new Map());

  React.useEffect(() => {
    if (!rows.length || !shops.length) {
      setState({ sourceRows: rows, rows });
      return undefined;
    }
    let disposed = false;
    void Promise.all(shops.map(async (shop) => {
      const clientId = getOzonShopClientId(shop);
      const shopRows = rows.filter((row) => row.shopId === shop.id || row.shopClientId === clientId);
      if (!shopRows.length) return { rows: [], errors: [] };
      return enrichAfterSalesRowsWithCachedClassificationEvidence(shop, shopRows);
    })).then((results) => {
      if (disposed) return;
      const enrichedByIdentity = new Map();
      results.flatMap((result) => result.rows || []).forEach((row) => {
        const key = getAfterSalesClassificationCacheKey(row);
        enrichedByIdentity.set(key, row);
        classifiedRowsRef.current.set(key, row);
      });
      while (classifiedRowsRef.current.size > 2_000) {
        classifiedRowsRef.current.delete(classifiedRowsRef.current.keys().next().value);
      }
      setState({
        sourceRows: rows,
        rows: rows.map((row) => {
          const key = getAfterSalesClassificationCacheKey(row);
          return enrichedByIdentity.get(key) || row;
        }),
      });
    }).catch(() => {
      if (!disposed) setState({ sourceRows: rows, rows });
    });
    return () => {
      disposed = true;
    };
  }, [rows, shops]);

  if (state.sourceRows === rows) return { rows: state.rows, ready: true };
  const cachedRows = rows.map((row) => classifiedRowsRef.current.get(getAfterSalesClassificationCacheKey(row)));
  if (cachedRows.every(Boolean)) return { rows: cachedRows, ready: true };
  return { rows: [], ready: rows.length === 0 };
}

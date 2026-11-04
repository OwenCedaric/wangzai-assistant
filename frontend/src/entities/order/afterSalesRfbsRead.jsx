import { OZON_AFTER_SALES_DETAIL_CONCURRENCY } from '../../shared/config/appConfigCore.jsx';
import { requestOzonReadOnly } from '../../shared/ozon/ozonRuntime.jsx';
import { runLimitedAsync } from './orderAsyncRules.jsx';
import { firstFilled, normalizeOzonId } from './orderIdentityRules.jsx';

export function getOzonRfbsReturnId(item = {}) {
  return normalizeOzonId(firstFilled(item.return_id, item.returnId, item.id, item.request_id, item.requestId));
}

export function getOzonRfbsReturnPayload(payload = {}) {
  return (
    payload?.returns ||
    payload?.return ||
    payload?.result?.returns ||
    payload?.result?.return ||
    payload?.result ||
    payload
  );
}

export async function requestOzonRfbsReturnDetail(shop, item = {}) {
  const returnId = getOzonRfbsReturnId(item);
  if (!returnId) return null;
  const payload = await requestOzonReadOnly('/v2/returns/rfbs/get', shop, {
    return_id: Number(returnId) || returnId,
  });
  return getOzonRfbsReturnPayload(payload);
}

export async function enrichOzonRfbsReturnItemsWithDetails(shop, items = []) {
  const maxDetailCount = 300;
  const detailItems = items.slice(0, maxDetailCount);
  const skippedItems = items.slice(maxDetailCount);
  const detailResults = await runLimitedAsync(detailItems, OZON_AFTER_SALES_DETAIL_CONCURRENCY, async (item) => {
    try {
      const detail = await requestOzonRfbsReturnDetail(shop, item);
      return detail
        ? {
            ...item,
            ...detail,
            return_id: firstFilled(item.return_id, item.returnId, detail.return_id, detail.returnId, detail.id),
            id: firstFilled(item.id, detail.id, detail.return_id, detail.returnId),
            listItem: item,
            detail,
          }
        : item;
    } catch {
      return item;
    }
  });
  return [
    ...detailResults.map((result, index) => (result.status === 'fulfilled' ? result.value : detailItems[index])),
    ...skippedItems,
  ];
}

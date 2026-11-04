import { shouldRequestAfterSalesRefundFinanceEvidence } from '../../../../entities/marketing/marketingOrderFields.jsx';
import { getAfterSalesPostingLookupKeys } from '../../../../entities/order/orderAsyncRules.jsx';
import { canUseOzonShop, normalizeOzonId } from '../../../../entities/order/orderShopScope.jsx';
import {
  applyAfterSalesFinanceEvidence,
  getFinanceOperationPostingKey,
  readLocalProfitFinanceCacheForShop,
  summarizeAfterSalesRefundFinanceOperations,
} from '../../../../entities/profit/profitAfterSalesRules.jsx';
import {
  buildFinanceOperationIndex,
  getProfitOrderFinanceOperations,
} from '../../../../entities/profit/profitLedgerMapping.jsx';

/** Classifies one complete after-sales snapshot from batched SQLite finance rows. */
export async function enrichAfterSalesRowsWithCachedClassificationEvidence(shop, rows = [], options = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!canUseOzonShop(shop) || !sourceRows.length) {
    return { rows: sourceRows, errors: [], attempted: 0, pending: 0 };
  }
  const candidates = sourceRows.filter(shouldRequestAfterSalesRefundFinanceEvidence);
  if (!candidates.length) return { rows: sourceRows, errors: [], attempted: 0, pending: 0 };
  const local = await readLocalProfitFinanceCacheForShop(shop, candidates, {
    ...options,
    forceRefresh: false,
    startBackgroundSync: false,
    localFinanceTimeoutMs: options.localFinanceTimeoutMs ?? 5_000,
    localFinancePostingChunkSize: options.localFinancePostingChunkSize ?? 100,
  });
  const financeIndex = buildFinanceOperationIndex(local.operations ?? []);
  const checked = new Set((local.checkedPostingNumbers ?? [])
    .map((value) => normalizeOzonId(value).trim())
    .filter(Boolean));
  const hadReadFailure = Boolean(local.errors?.length);
  let attempted = 0;
  const enrichedRows = sourceRows.map((row) => {
    if (!shouldRequestAfterSalesRefundFinanceEvidence(row)) return row;
    const lookupPostingNumbers = getAfterSalesPostingLookupKeys(row);
    const operations = getProfitOrderFinanceOperations(row, financeIndex);
    const wasChecked = lookupPostingNumbers.some((postingNumber) =>
      checked.has(normalizeOzonId(postingNumber).trim())
    );
    if (!operations.length && (!wasChecked || hadReadFailure)) return row;
    attempted += 1;
    const summary = summarizeAfterSalesRefundFinanceOperations(operations);
    return applyAfterSalesFinanceEvidence(row, {
      ...summary,
      checked: true,
      lookupPostingNumbers,
      matchedPostingNumbers: [...new Set(operations.map(getFinanceOperationPostingKey).filter(Boolean))],
      reason: `${summary.reason}；来自本机 SQLite 财务缓存`,
    });
  });
  return {
    rows: enrichedRows,
    errors: local.errors ?? [],
    attempted,
    pending: Math.max(candidates.length - attempted, 0),
  };
}

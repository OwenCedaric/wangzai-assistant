export const EMPTY_FINANCE_RECEIPT_VERSION = 1;
export const EMPTY_FINANCE_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const text = value => String(value ?? '').trim();

export function getEmptyFinancePostingKeys(order = {}) {
  const snapshot = order.profitLedger?.orderSnapshot ?? order.orderSnapshot ?? {};
  const posting = [order.posting, order.posting_number, snapshot.posting, order.id]
    .map(text).find(value => /^\d{6,}-\d{3,}(?:-\d+)?$/.test(value));
  if (!posting) return [];
  return [...new Set([posting, posting.replace(/^(\d+-\d+)-\d+$/, '$1')])];
}

export function isVerifiedEmptyFinanceReceipt(receipt, order = {}, { shop = {}, now = Date.now() } = {}) {
  const ledger = order.profitLedger ?? order;
  const shopId = text(shop.id || order.shopId || ledger.shopId);
  const clientId = text(shop.clientId || order.shopClientId || ledger.shopClientId);
  const keys = getEmptyFinancePostingKeys(order);
  const checkedAt = Date.parse(receipt?.checkedAt);
  return Boolean(receipt?.version === EMPTY_FINANCE_RECEIPT_VERSION && receipt.source === 'ozon-posting-finance'
    && !(Number(ledger.financeOperationCount) > 0)
    && receipt.scope === 'posting-all-history' && receipt.operationCount === 0
    && receipt.shopId === shopId && receipt.clientId === clientId && shopId && clientId
    && Number.isFinite(checkedAt) && checkedAt <= now + 60_000 && now - checkedAt < EMPTY_FINANCE_RECEIPT_TTL_MS
    && keys.length && Array.isArray(receipt.postingNumbers) && receipt.postingNumbers.length === keys.length
    && keys.every(key => receipt.postingNumbers.includes(key)));
}

// fetchPage must be the explicit live Ozon adapter, never the local-cache
// compatibility adapter. Each posting query covers its posting history.
export async function verifyEmptyFinanceAtOzon(shop, order, { fetchPage, signal, now = () => Date.now() } = {}) {
  const keys = getEmptyFinancePostingKeys(order);
  if (!shop?.id || !shop.clientId || !keys.length) throw new Error('EMPTY_FINANCE_OWNER_REQUIRED');
  const operations = [], seen = new Set();
  for (const posting of keys) {
    let expectedTotal = null, count = 0;
    const pageIds = new Set();
    for (let page = 1; ; page++) {
      if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      const response = await fetchPage(shop.id, posting, page, { signal });
      if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      const data = response?.result ?? response;
      if (response?.ok === false || response?.localApiCache || !Array.isArray(data?.operations) || !Number.isSafeInteger(data.row_count)
        || data.row_count < 0 || !Number.isSafeInteger(data.page_count) || data.page_count < 0 || data.page_count > 20
        || (data.page_count === 0 && data.row_count !== 0)
        || (expectedTotal !== null && expectedTotal !== data.row_count)) throw new Error('EMPTY_FINANCE_READ_INCOMPLETE');
      expectedTotal = data.row_count;
      for (const operation of data.operations) {
        const id = text(operation.operation_id ?? operation.operationId);
        const ownerPosting = text(operation.posting?.posting_number || operation.posting_number || operation.postingNumber);
        const base = posting.replace(/^(\d+-\d+)-\d+$/, '$1');
        if (!id || pageIds.has(id) || !(ownerPosting === base || ownerPosting.startsWith(base + '-'))) throw new Error('EMPTY_FINANCE_READ_SCOPE_MISMATCH');
        pageIds.add(id); count++;
        if (!seen.has(id)) { seen.add(id); operations.push(operation); }
      }
      if (count > expectedTotal || (count < expectedTotal && data.operations.length === 0)) throw new Error('EMPTY_FINANCE_READ_INCOMPLETE');
      if (page >= data.page_count) {
        if (count !== expectedTotal) throw new Error('EMPTY_FINANCE_READ_INCOMPLETE');
        break;
      }
    }
  }
  return { operations, receipt: operations.length ? null : {
    version: EMPTY_FINANCE_RECEIPT_VERSION, source: 'ozon-posting-finance', scope: 'posting-all-history',
    shopId: text(shop.id), clientId: text(shop.clientId), postingNumbers: keys,
    operationCount: 0, checkedAt: new Date(now()).toISOString(),
  } };
}

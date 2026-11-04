export const PROFIT_LOCAL_FINANCE_BATCH_SIZE = 250;
export const PROFIT_LOCAL_FINANCE_QUERY_BYTES = 6000;

// Bound both SQL parameter count and the encoded GET query. No identifier is
// truncated or dropped; the existing reader still fetches every result page.
export function splitProfitFinanceReadBatches(postings, { maxCount = PROFIT_LOCAL_FINANCE_BATCH_SIZE,
  maxEncodedBytes = PROFIT_LOCAL_FINANCE_QUERY_BYTES } = {}) {
  const countLimit = Math.max(1, Math.floor(Number(maxCount) || PROFIT_LOCAL_FINANCE_BATCH_SIZE));
  const byteLimit = Math.max(128, Math.floor(Number(maxEncodedBytes) || PROFIT_LOCAL_FINANCE_QUERY_BYTES));
  const prefixBytes = 'postingNumbers='.length;
  const batches = []; let current = [], bytes = prefixBytes;
  for (const posting of postings) {
    const encodedBytes = new URLSearchParams([['', posting]]).toString().length - 1;
    if (encodedBytes + prefixBytes > byteLimit) throw new Error('PROFIT_FINANCE_POSTING_TOO_LONG');
    if (current.length && (current.length >= countLimit || bytes + 3 + encodedBytes > byteLimit)) {
      batches.push(current); current = []; bytes = prefixBytes;
    }
    bytes += (current.length ? 3 : 0) + encodedBytes;
    current.push(posting);
  }
  if (current.length) batches.push(current);
  return batches;
}

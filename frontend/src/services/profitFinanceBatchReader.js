// Only first pages share a transport. Parent/child checks and subsequent pages
// still go through the existing complete-result verifier.
export function createProfitFinanceBatchReader(shopId, postingNumbers, { readBatch, readPage, signal } = {}) {
  const keys = [...new Set(postingNumbers)], groups = [];
  for (let index = 0; index < keys.length; index += 20) groups.push({ keys: keys.slice(index, index + 20), promise: null });
  return async (owner, posting, page = 1, options = {}) => {
    if (owner !== shopId) throw new Error('FINANCE_BATCH_OWNER_MISMATCH');
    if (page !== 1) return readPage(owner, posting, page, { ...options, signal });
    const group = groups.find(candidate => candidate.keys.includes(posting));
    if (!group) throw new Error('FINANCE_BATCH_POSTING_MISSING');
    group.promise ||= readBatch(owner, group.keys, { ...options, signal });
    const result = (await group.promise).get(posting);
    if (result?.ok !== true || !result.data) throw new Error('FINANCE_VERIFY_NOT_COMPLETE');
    return result.data;
  };
}

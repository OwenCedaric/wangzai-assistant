import { randomUUID } from 'node:crypto';

export async function readFinancePostingBatch({ shopId, postingNumbers, scheduler, requestedBy = 'profit-empty-finance-verification' }) {
  if (!shopId || !Array.isArray(postingNumbers) || postingNumbers.length < 1 || postingNumbers.length > 20
    || postingNumbers.some(posting => typeof posting !== 'string' || !/^\d{6,}-\d{3,}(?:-\d+)?$/.test(posting))) {
    const error = new Error('财务批量核验需要同店铺1至20个准确单号。');
    error.code = 'FINANCE_POSTING_BATCH_INVALID'; throw error;
  }
  const keys = [...new Set(postingNumbers)], postingResults = new Array(keys.length);
  const batchId = randomUUID(), started = Date.now();
  const to = new Date(), from = new Date(to); from.setUTCHours(0, 0, 0, 0);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, keys.length) }, async () => {
    while (cursor < keys.length) {
      const index = cursor++, posting = keys[index];
      try {
        // Keep the original per-shop scheduler, authorization, quota and retries.
        const result = await scheduler.executeReadOnly({ shopId, domain: 'finance', endpointKey: 'finance.transactionList',
          action: 'verify-finance-posting', requestedBy,
          params: { filter: { posting_number: posting, date: { from: from.toISOString(), to: to.toISOString() },
            operation_type: [], transaction_type: 'all' }, page: 1, page_size: 1000 },
          idempotencyKey: `finance-verify:${shopId}:${batchId}:${posting}`,
          forceRefresh: true, allowStale: false, waitForResult: true });
        postingResults[index] = result?.ok === true && result.status === 'success' && result.data
          ? { postingNumber: posting, ok: true, data: result.data }
          : { postingNumber: posting, ok: false, error: { code: 'FINANCE_VERIFY_NOT_COMPLETE', message: '官方流水未完整返回，请重试。' } };
      } catch {
        postingResults[index] = { postingNumber: posting, ok: false, error: { code: 'FINANCE_VERIFY_NOT_COMPLETE', message: '官方流水读取失败，请重试。' } };
      }
    }
  }));
  const stats = { postings: keys.length, successful: postingResults.filter(row => row.ok).length, durationMs: Date.now() - started };
  console.info('[profit-finance-batch-read]', JSON.stringify({ shopId, ...stats }));
  return { postingResults, stats };
}

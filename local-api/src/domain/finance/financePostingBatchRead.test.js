import assert from 'node:assert/strict';
import test from 'node:test';
import { readFinancePostingBatch } from './financePostingBatchRead.js';
test('finance batch keeps all lookups in the original owner scheduler with bounded concurrency', async () => {
  const keys = Array.from({ length: 10 }, (_, i) => `98765432-${String(i + 1).padStart(4, '0')}-1`);
  const calls = []; let active = 0, maxActive = 0;
  const result = await readFinancePostingBatch({ shopId: 'shop-1', postingNumbers: keys, scheduler: {
    async executeReadOnly(input) {
      calls.push(input); active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { ok: true, status: 'success', data: { result: { operations: [], row_count: 0, page_count: 0 } } };
    },
  } });
  assert.equal(calls.length, 10); assert.equal(maxActive, 4);
  assert.deepEqual(result.postingResults.map(r => r.postingNumber), keys);
  assert.ok(calls.every(r => r.shopId === 'shop-1' && r.endpointKey === 'finance.transactionList' && r.allowStale === false && r.forceRefresh === true));
  assert.equal(result.stats.successful, 10);
});
test('batch preserves partial failures and rejects invalid scope before dispatch', async () => {
  const scheduler = { async executeReadOnly(input) {
    if (input.params.filter.posting_number.endsWith('0001-1')) throw Error('unavailable');
    return { ok: true, status: 'success', data: { result: { operations: [], row_count: 0, page_count: 0 } } };
  } };
  const result = await readFinancePostingBatch({ shopId: 'shop-1', postingNumbers: ['98765432-0001-1','98765432-0002-1'], scheduler });
  assert.equal(result.postingResults[0].ok, false); assert.equal(result.postingResults[0].data, undefined);
  assert.equal(result.postingResults[1].ok, true);
  await assert.rejects(readFinancePostingBatch({ shopId: 'shop-1', postingNumbers: [''], scheduler }), { code: 'FINANCE_POSTING_BATCH_INVALID' });
});

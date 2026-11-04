import { expect, it, vi } from 'vitest';
import { createPrivateProfitBatchClient } from './privateProfitBatchClient.js';

const calls = count => Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, operation: 'ledger', input: { order: {} } }));

it('bounds concurrent shops to two and preserves split-batch ordering', async () => {
  let active = 0, peak = 0;
  const execute = vi.fn(async batch => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--; return batch.map(call => call.id);
  });
  const run = createPrivateProfitBatchClient({ execute });
  const result = await Promise.all(Array.from({ length: 5 }, () => run(calls(65))));
  expect(peak).toBe(2);
  expect(execute.mock.calls.every(([batch]) => batch.length <= 64)).toBe(true);
  expect(result).toEqual(Array.from({ length: 5 }, () => calls(65).map(call => call.id)));
});

it('rejects malformed later slices before dispatch and never turns partial results into success', async () => {
  const execute = vi.fn(async () => []), run = createPrivateProfitBatchClient({ execute });
  await expect(run([...calls(64), { id: 'bad', operation: 'eval', input: { order: {} } }])).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await expect(run(calls(1))).rejects.toThrow('PROFIT_CALCULATION_BATCH_INCOMPLETE');
});

it('cancels queued and in-flight work without publishing stale results', async () => {
  let release;
  const execute = vi.fn(batch => new Promise(resolve => { release = () => resolve(batch.map(call => call.id)); }));
  const run = createPrivateProfitBatchClient({ execute, concurrency: 1 });
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = run(calls(1), { signal: firstAbort.signal });
  await Promise.resolve();
  const second = run(calls(1), { signal: secondAbort.signal });
  const secondCheck = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  secondAbort.abort(); await secondCheck;
  const firstCheck = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  firstAbort.abort(); release(); await firstCheck;
  expect(execute).toHaveBeenCalledTimes(1);
});

it('retries busy responses only, boundedly, without retrying rejected authorization', async () => {
  const wait = vi.fn(async () => {});
  const execute = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(['fixture-0']);
  await expect(createPrivateProfitBatchClient({ execute, wait })(calls(1))).resolves.toEqual(['fixture-0']);
  expect(wait).toHaveBeenCalledTimes(1);
  const busy = vi.fn().mockRejectedValue({ status: 429 });
  await expect(createPrivateProfitBatchClient({ execute: busy, wait })(calls(1))).rejects.toEqual({ status: 429 });
  expect(busy).toHaveBeenCalledTimes(3);
  const denied = vi.fn().mockRejectedValue({ status: 403 });
  await expect(createPrivateProfitBatchClient({ execute: denied, wait })(calls(1))).rejects.toEqual({ status: 403 });
  expect(denied).toHaveBeenCalledTimes(1);
});

it('honors the server quota retry delay without raising the server request limit', async () => {
  const wait = vi.fn(async () => {});
  const execute = vi.fn().mockRejectedValueOnce({ status: 429, payload: { error: { retryAfterMs: 60_000 } } }).mockResolvedValueOnce([1]);
  await expect(createPrivateProfitBatchClient({ execute, wait })(calls(1))).resolves.toEqual([1]);
  expect(wait).toHaveBeenCalledWith(60_000, undefined);
});

it('snapshots queued facts so a later local edit cannot change the request ownership or amount', async () => {
  let release;
  const execute = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([0]); }))
    .mockImplementationOnce(async batch => batch.map(call => call.input.order));
  const run = createPrivateProfitBatchClient({ execute, concurrency: 1 });
  const first = run(calls(1)); await Promise.resolve();
  const input = calls(1); input[0].input.order = { shopId: 'before', amountValue: 12 };
  const second = run(input);
  input[0].input.order.shopId = 'after'; input[0].input.order.amountValue = 999;
  release(); await first;
  await expect(second).resolves.toEqual([{ shopId: 'before', amountValue: 12 }]);
});

import { createProfitCoreBatch, decodeProfitWire } from './profitCoreWire.js';
import { executePrivateProfitCalls } from './protectedComputeClient.js';

const abortError = () => Object.assign(new Error('PROFIT_CALCULATION_CANCELLED'), { name: 'AbortError', code: 'PROFIT_CALCULATION_CANCELLED' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

function waitBeforeRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const done = () => { signal?.removeEventListener('abort', cancelled); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const cancelled = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(abortError()); };
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

// One shared bounded queue per renderer. No fallback to client-side formulas.
export function createPrivateProfitBatchClient({ execute = executePrivateProfitCalls, concurrency = 2, maxQueued = 64, wait = waitBeforeRetry } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2
    || !Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 64) throw new Error('PROFIT_QUEUE_CONFIG_INVALID');
  let active = 0;
  const queued = [];
  const pump = () => {
    while (active < concurrency && queued.length) {
      const job = queued.shift();
      job.signal?.removeEventListener('abort', job.cancel);
      if (job.signal?.aborted) { job.reject(abortError()); continue; }
      active++;
      Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  };
  const schedule = (work, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    if (queued.length >= maxQueued) { reject(new Error('PROFIT_QUEUE_FULL')); return; }
    const job = { work, signal, resolve, reject, cancel: null };
    job.cancel = () => { const i = queued.indexOf(job); if (i >= 0) queued.splice(i, 1); reject(abortError()); };
    signal?.addEventListener('abort', job.cancel, { once: true });
    queued.push(job); pump();
  });
  const partition = calls => {
    try { createProfitCoreBatch(calls); return [calls]; }
    catch (error) {
      if (!['PROFIT_CORE_BATCH_TOO_LARGE', 'PROFIT_CORE_BATCH_SIZE_INVALID', 'PROFIT_CORE_WIRE_LIMIT'].includes(error.code) || calls.length < 2) throw error;
      const middle = Math.floor(calls.length / 2);
      return [...partition(calls.slice(0, middle)), ...partition(calls.slice(middle))];
    }
  };
  return async (calls, options = {}) => {
    options = { ...options };
    checkAbort(options.signal);
    // Validate the entire set before sending any slice; duplicate IDs may not
    // hide in separate partitions. Empty input is not a successful remote call.
    if (!Array.isArray(calls) || !calls.length || calls.length > 4096
      || new Set(calls.map(call => call?.id)).size !== calls.length) throw new Error('PROFIT_BATCH_INPUT_INVALID');
    const slices = partition(calls).map(slice => decodeProfitWire(JSON.parse(createProfitCoreBatch(slice).callsJson))), output = [];
    for (const slice of slices) {
      const values = await schedule(async () => {
        for (let attempt = 0; ; attempt++) {
          checkAbort(options.signal);
          try {
            const result = await execute(slice, { ...options, timeoutMs: options.timeoutMs || 35_000 });
            checkAbort(options.signal);
            if (!Array.isArray(result) || result.length !== slice.length) throw new Error('PROFIT_CALCULATION_BATCH_INCOMPLETE');
            return result;
          } catch (error) {
            checkAbort(options.signal);
            if (error?.status !== 429 || attempt >= 2) throw error;
            const retryAfterMs = Number(error?.payload?.error?.retryAfterMs ?? error?.retryAfterMs);
            await wait(Number.isFinite(retryAfterMs) && retryAfterMs > 0
              ? Math.min(60_000, retryAfterMs) : 300 * (attempt + 1), options.signal);
          }
        }
      }, options.signal);
      output.push(...values);
    }
    checkAbort(options.signal);
    return output;
  };
}

export const executePrivateProfitBatches = createPrivateProfitBatchClient();

import { randomUUID } from 'node:crypto';
import { validatePurchaseRemovalReceiptBinding } from './purchaseRemovalReceiptBinding.js';

function failure(code) { return Object.assign(new Error(code), { code }); }

/** One durable backend operation owns one cleanup; callers only observe it. */
export function createPurchaseRemovalMaintenance({ run, observeTimeoutMs = 20_000, maxActive = 16, maxCompleted = 64 } = {}) {
  if (typeof run !== 'function') throw failure('PURCHASE_BROWSER_REMOVAL_RUN_REQUIRED');
  const entries = new Map();
  function pending(entry) {
    return {
      ok: true, accepted: true, verified: false, inProgress: true, status: 202,
      code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS',
      operationId: entry.operationId, requestId: entry.requestId,
      ownerRef: entry.ownerRef || '', phase: entry.phase,
    };
  }
  function observe(entry) {
    if (entry.done) return Promise.resolve(entry.result);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(pending(entry)), observeTimeoutMs);
      entry.promise.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }
  function request(rawOperationId) {
    const operationId = typeof rawOperationId === 'string' ? rawOperationId.trim() : '';
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(operationId)) return Promise.reject(failure('ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED'));
    const existing = entries.get(operationId);
    if (existing) return observe(existing);
    if ([...entries.values()].filter((entry) => !entry.done).length >= maxActive) return Promise.reject(failure('PURCHASE_BROWSER_ACCOUNT_REMOVAL_BUSY'));
    const entry = { operationId, ownerRef: '', phase: 'prepare', requestId: `purchase_removal_${randomUUID()}`, done: false, result: null };
    entries.set(operationId, entry);
    const update = ({ ownerRef, phase } = {}) => {
      if (ownerRef) {
        if (entry.ownerRef && entry.ownerRef !== ownerRef) throw failure('PURCHASE_BROWSER_ACCOUNT_REMOVAL_SCOPE_CHANGED');
        entry.ownerRef = ownerRef;
      }
      if (phase) entry.phase = phase;
    };
    entry.promise = Promise.resolve().then(() => run(operationId, update)).then((result) => {
      if (result?.verified !== true && result?.restartRequired !== true) throw failure('PURCHASE_BROWSER_ACCOUNT_REMOVAL_READBACK_FAILED');
      if (result?.verified === true && (result.proof?.verified !== true || result.proof.ownerRef !== entry.ownerRef)) {
        throw failure('PURCHASE_BROWSER_ACCOUNT_REMOVAL_READBACK_FAILED');
      }
      if (result?.verified === true) validatePurchaseRemovalReceiptBinding(result.proof.receiptBinding, { operationId });
      entry.done = true;
      entry.phase = result?.verified === true ? 'completed' : result?.restartRequired ? 'restart-required' : 'pending';
      entry.result = { ...result, operationId, requestId: entry.requestId, phase: entry.phase };
      const completed = [...entries.values()].filter((item) => item.done);
      while (completed.length > maxCompleted) entries.delete(completed.shift().operationId);
      return entry.result;
    }).catch((error) => {
      // Only a genuinely settled cleanup may be retried under the SAME backend
      // operation. An observation timeout never reaches this path.
      if (entries.get(operationId) === entry) entries.delete(operationId);
      throw error;
    });
    entry.promise.catch(() => undefined);
    return observe(entry);
  }
  return Object.freeze({ request });
}

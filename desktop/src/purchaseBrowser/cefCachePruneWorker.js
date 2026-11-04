import { parentPort, workerData } from 'node:worker_threads';
import { pruneCefTransientCache } from './cefTransientCacheMaintenance.js';

try {
  parentPort?.postMessage(pruneCefTransientCache(workerData || {}));
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    removed: null,
    mutationOutcome: 'unknown',
    code: String(error?.code || error?.message || 'PURCHASE_BROWSER_CACHE_PRUNE_FAILED'),
  });
}

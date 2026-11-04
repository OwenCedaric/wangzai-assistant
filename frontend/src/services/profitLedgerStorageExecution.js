import { usesPrivateProfitExecution } from './privateProfitMode.js';
import {
  canonicalizeProfitLedgerRowKey, getProfitLedgerCanonicalRowKey, selectBestProfitLedgerRow,
  readProfitLedgerSnapshotFromStore, mergeProfitLedgerSnapshotIntoStore,
  readProfitLedgerSnapshotSteps, mergeProfitLedgerStoreSteps,
} from './profitLedgerService.js';
import { executePrivateProfitBatches } from './privateProfitBatchClient.js';

const abortIfNeeded = signal => { if (signal?.aborted) throw Object.assign(new Error('PROFIT_CALCULATION_CANCELLED'), { name: 'AbortError' }); };
const identity = row => getProfitLedgerCanonicalRowKey(row ?? {});
const orderScope = row => ({ shopId: row?.shopId ?? row?.orderSnapshot?.shopId ?? '',
  shopClientId: row?.shopClientId ?? row?.orderSnapshot?.shopClientId ?? '' });

function verifyRow(value, source, nullable) {
  if (value === null && nullable) return;
  if (!value || value.schemaVersion !== 1 || identity(value) !== identity(source)) throw new Error('PROFIT_LEDGER_RESULT_OWNER_MISMATCH');
}

async function computeSlices(items, operation, options, inputFor) {
  const output = [];
  const execute = options.execute ?? executePrivateProfitBatches;
  for (let offset = 0; offset < items.length; offset += 40) {
    abortIfNeeded(options.signal);
    const slice = items.slice(offset, offset + 40);
    const calls = slice.map((item, index) => ({ id: `ledger-${offset + index}`, operation, input: inputFor(item) }));
    const results = await execute(calls, { signal: options.signal });
    abortIfNeeded(options.signal);
    if (!Array.isArray(results) || results.length !== calls.length) throw new Error('PROFIT_LEDGER_RESULT_INCOMPLETE');
    results.forEach((value, index) => verifyRow(value, calls[index].input.ledger, operation === 'migrate-ledger'));
    output.push(...results);
  }
  return output;
}

export async function migrateProfitLedgerRowsRemotely(rows, options = {}) {
  const values = await computeSlices(rows, 'migrate-ledger', options, ledger => ({ order: orderScope(ledger), ledger }));
  return values.filter(Boolean);
}

export async function mergeProfitLedgerRowsRemotely(cachedRows = [], freshRows = [], options = {}) {
  abortIfNeeded(options.signal);
  const cached = new Map();
  // These are the original public identity/ranking helpers. Financial merging
  // and recomputation remain exclusively in the server merge-ledger operation.
  for (const row of (Array.isArray(cachedRows) ? cachedRows : []).map(canonicalizeProfitLedgerRowKey)) {
    if (!(row?.ledgerKey || row?.orderKey)) continue;
    const key = identity(row), current = cached.get(key);
    cached.set(key, current ? selectBestProfitLedgerRow([current, row]) : row);
  }
  const fresh = (Array.isArray(freshRows) ? freshRows : []).map(canonicalizeProfitLedgerRowKey).filter(row => getProfitLedgerCanonicalRowKey(row));
  const seen = new Set(fresh.map(identity));
  const merged = await computeSlices(fresh, 'merge-ledger', options, ledger => ({
    order: orderScope(ledger), ledger, cachedLedger: cached.get(identity(ledger)) ?? null,
  }));
  if (options.keepUnseenCached === false) return merged;
  return [...merged, ...[...cached].filter(([key]) => !seen.has(key)).map(([, row]) => row)];
}

export async function runRemoteProfitLedgerSteps(iterator, options = {}) {
  abortIfNeeded(options.signal);
  let state = iterator.next();
  try {
    while (!state.done) {
      abortIfNeeded(options.signal);
      const task = state.value;
      let rows;
      if (task.operation === 'migrate-ledgers') rows = await migrateProfitLedgerRowsRemotely(task.rows, options);
      else if (task.operation === 'merge-ledgers') rows = await mergeProfitLedgerRowsRemotely(task.cachedRows, task.freshRows, { ...options, ...task.options });
      else throw new Error('PROFIT_LEDGER_STEP_INVALID');
      abortIfNeeded(options.signal);
      state = iterator.next(rows);
    }
    return state.value;
  } finally { iterator.return?.(); }
}

export function readProfitLedgerSnapshotForExecution(store, key, options = {}) {
  if (!usesPrivateProfitExecution) return readProfitLedgerSnapshotFromStore(store, key);
  return runRemoteProfitLedgerSteps(readProfitLedgerSnapshotSteps(store, key), options);
}

export function mergeProfitLedgerStoreForExecution(store, key, fresh, options = {}) {
  if (!usesPrivateProfitExecution) return mergeProfitLedgerSnapshotIntoStore(store, key, fresh, options);
  return runRemoteProfitLedgerSteps(mergeProfitLedgerStoreSteps(store, key, fresh, options), options);
}

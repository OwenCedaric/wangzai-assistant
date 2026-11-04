import {
  clearProfitLedgerSnapshots,
  getProfitLedgerSnapshot,
  getProfitLedgerStorageLayout,
  saveProfitLedgerSnapshot,
} from '../../api/localApiClient.js';
import { createProfitLedgerSnapshotFromLedgers } from '../../services/profitLedgerService.js';
import { readProfitLedgerSnapshotForExecution, mergeProfitLedgerStoreForExecution } from '../../services/profitLedgerStorageExecution.js';
import {
  createProfitLedgerPersistencePlan,
  PROFIT_LEDGER_CHUNKED_FORMAT,
  compactProfitLedgerSnapshotForPersistence,
} from '../../services/profitLedgerPersistenceCompaction.js';
import {
  enqueueOzonLocalDataWrite,
  ozonLocalDataWriteQueues,
  getOzonLocalSnapshotKeyCandidates,
  recordLocalMirrorReadLog,
  recordLocalMirrorRetryTask,
} from '../product/productLocalData.jsx';

export const PROFIT_LEDGER_PARTITIONED_FORMAT = 'profit-ledger-partitioned-v1';
const ownerOf = (row) => String(row?.shopId || row?.orderSnapshot?.shopId || '').trim();
async function partitions() {
  const layout = await getProfitLedgerStorageLayout();
  if (!layout?.partitioned) return null;
  if (!Array.isArray(layout.independentShopIds)) throw new Error('PROFIT_LEDGER_LAYOUT_INVALID');
  const shopIds = [...new Set(layout.independentShopIds.filter(Boolean))];
  return [...shopIds.map((shopId) => ({ shopId, ...(layout.atomicBatchWrite ? { atomicBatch: true } : {}) })), { sharedOnly: true, excludedShopIds: shopIds }];
}
function partRows(snapshot, route) {
  return (snapshot.rows || []).filter((row) => route.shopId ? ownerOf(row) === route.shopId : !route.excludedShopIds.includes(ownerOf(row)));
}
function partErrors(snapshot, route) {
  return (snapshot.errors || []).filter((error) => route.shopId ? ownerOf(error) === route.shopId : !route.excludedShopIds.includes(ownerOf(error)));
}
function partitionError(route, reason, operation) {
  return {
    ...(route.shopId ? { shopId: route.shopId } : { sharedOnly: true }),
    code: `PROFIT_LEDGER_PARTITION_${operation}_FAILED`,
    message: reason instanceof Error ? reason.message : String(reason),
  };
}
function joinSnapshots(snapshots) {
  const available = snapshots.filter(Boolean);
  if (!available.length) return null;
  const rows = available.flatMap((snapshot) => snapshot.rows || []);
  const next = { ...available[0], persistenceFormat: PROFIT_LEDGER_PARTITIONED_FORMAT, rows, total: rows.length, rowCount: rows.length,
    penaltyDetails: Object.assign({}, ...available.map((snapshot) => snapshot.penaltyDetails || {})),
    profitPenaltyDetails: Object.assign({}, ...available.map((snapshot) => snapshot.profitPenaltyDetails ?? snapshot.penaltyDetails ?? {})),
    errors: available.flatMap((snapshot) => snapshot.errors || []),
    updatedAt: available.map((snapshot) => snapshot.updatedAt || snapshot.fetchedAt || '').sort().at(-1) || '',
  };
  delete next.chunkKeys; delete next.writeId; delete next.ownerShopId;
  return next;
}
function contentSignature(snapshot) {
  const compact = compactProfitLedgerSnapshotForPersistence(snapshot);
  const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  return JSON.stringify(stable({ calculationVersion: compact.calculationVersion,
    rows: [...(compact.rows || [])].sort((a, b) => String(a.ledgerKey).localeCompare(String(b.ledgerKey))),
    penaltyDetails: compact.penaltyDetails || {}, errors: compact.errors || [],
  }));
}

async function readPartition(fileKey, snapshotKey, route = {}) {
  if (!fileKey || !snapshotKey) return null;
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  let snapshot = null;
  try {
    const result = await getProfitLedgerSnapshot(snapshotKeys, route);
    if (result?.ok === false) throw new Error(result.error?.message || 'PROFIT_LEDGER_READ_FAILED');
    const storedKey = result.snapshotKey || snapshotKeys[0];
    snapshot = result.snapshot ? await readProfitLedgerSnapshotForExecution(
      { profitLedgerSnapshots: { [storedKey]: result.snapshot } }, storedKey, { signal: route.signal }
    ) : null;
  } catch (error) {
    recordLocalMirrorRetryTask({
      domain: '10_profit_ledgers',
      source: 'sqlite-cache',
      entityType: 'profitLedgerSnapshot',
      entityKey: snapshotKeys.join('|') || fileKey,
      fileKey,
      snapshotKey: snapshotKeys[0] || '',
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
  recordLocalMirrorReadLog({
    domain: '10_profit_ledgers',
    source: 'sqlite-cache',
    status: snapshot?.rows?.length ? 'hit' : 'miss',
    rows: snapshot?.rows?.length ?? 0,
    failures: snapshot?.errors?.length ?? 0,
    partial: Boolean(snapshot?.errors?.length),
    refreshedAt: snapshot?.updatedAt || snapshot?.fetchedAt || new Date().toISOString(),
    details: { fileKey, snapshotKeys, sqliteOnly: true },
  }).catch(() => undefined);
  return snapshot;
}

// Each owner publishes independently. The final snapshot explicitly distinguishes
// successful cache misses from failed reads; callers must not mark partial reads loaded.
export async function readProfitLedgerLocalSnapshot(fileKey, snapshotKey, options = {}) {
  if (!fileKey || !snapshotKey) return null;
  const routes = await partitions();
  if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
  if (!routes) return readPartition(fileKey, snapshotKey, options.signal ? { signal: options.signal } : {});
  const results = await Promise.all(routes.map(async (route) => {
    let result;
    try {
      const snapshot = await readPartition(fileKey, snapshotKey, {
        ...route,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      result = { ...route, status: 'fulfilled', snapshot };
    } catch (reason) {
      result = { ...route, status: 'rejected', error: partitionError(route, reason, 'READ') };
    }
    if (!options.signal?.aborted) options.onPartition?.(result);
    return result;
  }));
  if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.error);
  const snapshot = joinSnapshots(results.map((result) => result.snapshot));
  if (!snapshot && !failures.length) return null;
  return {
    ...(snapshot || createProfitLedgerSnapshotFromLedgers([])),
    persistenceFormat: PROFIT_LEDGER_PARTITIONED_FORMAT,
    partial: failures.length > 0,
    readComplete: failures.length === 0,
    partitionErrors: failures,
    partitionStatuses: results.map(({ snapshot: _snapshot, ...result }) => result),
    errors: [...(snapshot?.errors || []), ...failures],
  };
}

export async function writeProfitLedgerLocalSnapshot(fileKey, snapshotKey, snapshot) {
  if (!fileKey || !snapshotKey || !snapshot) return null;
  const routes = await partitions();
  if (!routes) return writePartition(fileKey, snapshotKey, snapshot);
  const touchedRoutes = routes.filter((route) => partRows(snapshot, route).length > 0 || partErrors(snapshot, route).length > 0);
  const settled = await Promise.allSettled(touchedRoutes.map(async (route) => {
    const rows = partRows(snapshot, route);
    const part = createProfitLedgerSnapshotFromLedgers(rows, {
      sourceKey: snapshot.sourceKey, fetchedAt: snapshot.fetchedAt,
      errors: partErrors(snapshot, route),
    });
    return writePartition(fileKey, snapshotKey, part, route);
  }));
  const results = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const failures = settled.flatMap((result, index) => result.status === 'rejected'
    ? [partitionError(touchedRoutes[index], result.reason, 'WRITE')] : []);
  const combined = joinSnapshots(results.map((result) => result.snapshot));
  const result = { snapshot: combined ? { ...combined, partial: failures.length > 0, writeComplete: failures.length === 0 } : null,
    partitionErrors: failures, stats: { changed: results.some((result) => result.stats.changed),
    compacted: results.some((result) => result.stats.compacted), rowCount: combined?.rows.length || 0, sqliteOnly: true, partitioned: true,
    partial: failures.length > 0,
    partialOwnerUpdate: touchedRoutes.length < routes.length || failures.length > 0,
    updatedShopIds: touchedRoutes.filter((_route, index) => settled[index].status === 'fulfilled')
      .flatMap((route) => route.shopId ? [route.shopId] : [...new Set(partRows(combined || {}, route).map(ownerOf))]) } };
  if (failures.length) {
    const error = new Error(failures.map((failure) => failure.message).join('; '));
    error.partialResult = result;
    error.partitionErrors = failures;
    throw error;
  }
  return result;
}

async function writePartition(fileKey, snapshotKey, snapshot, route = {}) {
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  const primarySnapshotKey = snapshotKeys[0];
  if (!primarySnapshotKey) return null;
  const queueKey = route.shopId ? `${fileKey}:shop:${route.shopId}` : route.sharedOnly ? `${fileKey}:shared` : fileKey;
  const signature = route.shopId ? contentSignature(snapshot) : '';
  const readScope = JSON.stringify(snapshotKeys);
  const pending = ozonLocalDataWriteQueues.get(queueKey)?.__profitSnapshotSave;
  if (route.shopId && pending?.key === readScope && pending.signature === signature) return pending.result;
  const result = enqueueOzonLocalDataWrite(queueKey, async () => {
    let saved;
    let merged;
    try {
      const sqliteRead = await getProfitLedgerSnapshot(snapshotKeys, route);
      if (sqliteRead?.ok === false) throw new Error(sqliteRead.error?.message || 'PROFIT_LEDGER_READ_FAILED');
      const sqliteSnapshot = sqliteRead?.snapshot || null;
      const sqliteSnapshotKey = sqliteRead?.snapshotKey || primarySnapshotKey;
      const baseStore = sqliteSnapshot
        ? { profitLedgerSnapshots: { [sqliteSnapshotKey]: sqliteSnapshot } }
        : {};
      merged = await mergeProfitLedgerStoreForExecution(baseStore, primarySnapshotKey, snapshot, { signal: route.signal });
      let shouldSave =
        !sqliteSnapshot ||
        merged.stats.changed ||
        merged.stats.compacted ||
        sqliteSnapshot.persistenceFormat !== PROFIT_LEDGER_CHUNKED_FORMAT;
      // One store's update must not rewrite the unchanged residual stores.
      if ((route.shopId || route.sharedOnly) && sqliteSnapshotKey === primarySnapshotKey && sqliteSnapshot?.persistenceFormat === PROFIT_LEDGER_CHUNKED_FORMAT
        && contentSignature(sqliteSnapshot) === contentSignature(merged.snapshot)) {
        shouldSave = false;
        merged = { ...merged, snapshot: sqliteSnapshot, stats: { ...merged.stats, changed: false } };
      }
      if (shouldSave) {
        const plan = createProfitLedgerPersistencePlan(merged.snapshot);
        const writeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const chunkKeys = plan.chunks.map((_chunk, index) => `${primarySnapshotKey}::chunk:${writeId}:${String(index).padStart(6, '0')}`);
        const manifest = { ...plan.manifest, chunkKeys, writeId };
        const canBatch = route.shopId && route.atomicBatch
          && new TextEncoder().encode(JSON.stringify({ snapshot: manifest, chunks: plan.chunks })).byteLength <= 12 * 1024 * 1024;
        if (canBatch) {
          saved = await saveProfitLedgerSnapshot(primarySnapshotKey, manifest, { ...route, chunks: plan.chunks, timeoutMs: 60_000 });
          if (saved?.ok !== true) throw new Error(saved?.error?.message || 'PROFIT_LEDGER_WRITE_FAILED');
          if (saved?.stats?.readbackVerified !== true || saved.stats.rowCount !== plan.rowCount || saved.snapshot?.writeId !== writeId) {
            throw new Error('PROFIT_LEDGER_BATCH_READBACK_MISMATCH');
          }
        } else {
          for (let index = 0; index < plan.chunks.length; index += 1) {
            const chunkSaved = await saveProfitLedgerSnapshot(chunkKeys[index], plan.chunks[index], {
              ...route, timeoutMs: 60_000, chunkOf: primarySnapshotKey, writeId,
              chunkIndex: index, chunkCount: plan.chunks.length,
            });
            if (chunkSaved?.ok !== true) throw new Error(chunkSaved?.error?.message || 'PROFIT_LEDGER_CHUNK_WRITE_FAILED');
          }
          saved = await saveProfitLedgerSnapshot(primarySnapshotKey, manifest, { ...route, timeoutMs: 60_000 });
          if (saved?.ok !== true) throw new Error(saved?.error?.message || 'PROFIT_LEDGER_WRITE_FAILED');
        }
      } else {
        saved = { snapshot: merged.snapshot, stats: { compacted: false, removedSnapshots: 0 } };
      }
    } catch (error) {
      recordLocalMirrorRetryTask({
        domain: '10_profit_ledgers',
        source: 'sqlite-cache',
        entityType: 'profitLedgerSnapshotWrite',
        entityKey: snapshotKeys.join('|') || fileKey,
        fileKey,
        snapshotKey: primarySnapshotKey,
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
    return {
      stats: {
        ...merged.stats,
        compacted: Boolean(merged.stats.compacted || saved?.stats?.compacted),
        sqliteOnly: true,
      },
      snapshot: merged.snapshot,
    };
  });
  if (route.shopId) ozonLocalDataWriteQueues.get(queueKey).__profitSnapshotSave = { key: readScope, signature, result };
  return result;
}

export async function clearProfitLedgerLocalSnapshot(fileKey, snapshotKey) {
  if (!fileKey || !snapshotKey) return null;
  const routes = await partitions();
  if (!routes) return clearPartition(fileKey, snapshotKey);
  const results = await Promise.all(routes.map((route) => clearPartition(fileKey, snapshotKey, route)));
  return { changed: results.some((result) => result.changed), removedSnapshots: results.reduce((sum, result) => sum + result.removedSnapshots, 0), sqliteOnly: true };
}

async function clearPartition(fileKey, snapshotKey, route = {}) {
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  const queueKey = route.shopId ? `${fileKey}:shop:${route.shopId}` : route.sharedOnly ? `${fileKey}:shared` : fileKey;
  return enqueueOzonLocalDataWrite(queueKey, async () => {
    try {
      const sqlite = route.shopId || route.sharedOnly ? await clearProfitLedgerSnapshots(snapshotKeys, route) : await clearProfitLedgerSnapshots(snapshotKeys);
      return {
        changed: Boolean(sqlite?.stats?.changed),
        removedSnapshots: Number(sqlite?.stats?.removedSnapshots || 0),
        sqliteOnly: true,
      };
    } catch (error) {
      recordLocalMirrorRetryTask({
        domain: '10_profit_ledgers',
        source: 'sqlite-cache',
        entityType: 'profitLedgerSnapshotClear',
        entityKey: snapshotKeys.join('|') || fileKey,
        fileKey,
        snapshotKey: snapshotKeys[0] || '',
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
  });
}

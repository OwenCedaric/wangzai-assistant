import { assertNoProfitEvidenceDowngrade, getProfitEvidenceRowIdentity, PROFIT_EVIDENCE_COMPATIBLE_VERSIONS } from './profitSnapshotEvidenceGuard.js';

const MAX_PROFIT_LEDGER_LOGICAL_SCOPES = 12;
const MAX_PROFIT_LEDGER_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const PROFIT_LEDGER_CHUNK_FORMAT = 'profit-ledger-chunk-v1';
const PROFIT_LEDGER_CHUNKED_FORMAT = 'profit-ledger-chunked-v1';
const PROFIT_LEDGER_CHUNK_MARKER = '::chunk:';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSnapshotKeys(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.flatMap((item) => normalizeText(item).split(',')).map(normalizeText).filter(Boolean))];
}

function getLogicalScope(snapshotKey = '') {
  return normalizeText(snapshotKey).replace(/:range:[^:]+(?=:|$)/g, ':range:current');
}

function isChunkSnapshotKey(snapshotKey = '') {
  return normalizeText(snapshotKey).includes(PROFIT_LEDGER_CHUNK_MARKER);
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeSnapshot(snapshot = {}) {
  if (!isPlainObject(snapshot)) throw new Error('PROFIT_LEDGER_SNAPSHOT_REQUIRED');
  let serialized = '';
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    throw new Error('PROFIT_LEDGER_SNAPSHOT_NOT_SERIALIZABLE');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_PROFIT_LEDGER_SNAPSHOT_BYTES) {
    throw new Error('PROFIT_LEDGER_SNAPSHOT_TOO_LARGE');
  }
  return serialized;
}

function toPublicSnapshot(row = {}) {
  const snapshot = parseJson(row.snapshot_json, {});
  if (!isPlainObject(snapshot)) return null;
  return {
    ...snapshot,
    cacheGroup: normalizeText(snapshot.cacheGroup || row.cache_group),
    calculationVersion: normalizeText(snapshot.calculationVersion || row.calculation_version),
    sourceKey: snapshot.sourceKey || row.source_key || '',
    signature: snapshot.signature || row.signature || '',
    fetchedAt: snapshot.fetchedAt || row.fetched_at || '',
    updatedAt: snapshot.updatedAt || row.updated_at,
  };
}

export function createProfitLedgerSnapshotRepository(db, { now = nowIso } = {}) {
  function pruneSnapshots(preferredSnapshotKey = '') {
    const rows = db
      .prepare(`
        SELECT snapshot_key, logical_scope, snapshot_json, updated_at,
               LENGTH(CAST(snapshot_json AS BLOB)) AS snapshot_bytes
        FROM profit_ledger_snapshots
        ORDER BY updated_at DESC, snapshot_key DESC
      `)
      .all();
    const baseRows = rows.filter((row) => !isChunkSnapshotKey(row.snapshot_key));
    const latestByScope = new Map();
    for (const row of baseRows) {
      if (!latestByScope.has(row.logical_scope) || row.snapshot_key === preferredSnapshotKey) {
        latestByScope.set(row.logical_scope, row);
      }
    }
    const scopeCandidates = [...latestByScope.values()]
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)) || String(right.snapshot_key).localeCompare(String(left.snapshot_key)))
      .slice(0, MAX_PROFIT_LEDGER_LOGICAL_SCOPES);
    const retainedKeys = new Set(scopeCandidates.map((row) => row.snapshot_key));
    for (const row of scopeCandidates) {
      const snapshot = parseJson(row.snapshot_json, {});
      if (snapshot?.persistenceFormat !== PROFIT_LEDGER_CHUNKED_FORMAT) continue;
      for (const chunkKey of Array.isArray(snapshot.chunkKeys) ? snapshot.chunkKeys : []) {
        if (normalizeText(chunkKey).startsWith(`${row.snapshot_key}${PROFIT_LEDGER_CHUNK_MARKER}`)) {
          retainedKeys.add(normalizeText(chunkKey));
        }
      }
    }
    const removeKeys = rows.map((row) => row.snapshot_key).filter((key) => !retainedKeys.has(key));
    if (removeKeys.length) {
      db.prepare(`DELETE FROM profit_ledger_snapshots WHERE snapshot_key IN (${removeKeys.map(() => '?').join(',')})`).run(...removeKeys);
    }
    const retainedBytes = rows
      .filter((row) => retainedKeys.has(row.snapshot_key))
      .reduce((sum, row) => sum + Math.max(0, Number(row.snapshot_bytes) || 0), 0);
    return { removed: removeKeys.length, retained: scopeCandidates.length, retainedBytes };
  }

  function validateChunkManifest(snapshotKey, snapshot) {
    if (snapshot?.persistenceFormat !== PROFIT_LEDGER_CHUNKED_FORMAT) return;
    const chunkKeys = Array.isArray(snapshot.chunkKeys) ? snapshot.chunkKeys.map(normalizeText).filter(Boolean) : [];
    if (!chunkKeys.length) throw new Error('PROFIT_LEDGER_SNAPSHOT_CHUNKS_REQUIRED');
    const rows = db
      .prepare(`SELECT snapshot_key, snapshot_json FROM profit_ledger_snapshots WHERE snapshot_key IN (${chunkKeys.map(() => '?').join(',')})`)
      .all(...chunkKeys);
    const byKey = new Map(rows.map((row) => [row.snapshot_key, parseJson(row.snapshot_json, {})]));
    let rowCount = 0;
    chunkKeys.forEach((chunkKey, index) => {
      const chunk = byKey.get(chunkKey);
      if (
        !chunkKey.startsWith(`${snapshotKey}${PROFIT_LEDGER_CHUNK_MARKER}`) ||
        chunk?.persistenceFormat !== PROFIT_LEDGER_CHUNK_FORMAT ||
        normalizeText(chunk.chunkOf) !== snapshotKey ||
        Number(chunk.chunkIndex) !== index ||
        Number(chunk.chunkCount) !== chunkKeys.length ||
        normalizeText(chunk.writeId) !== normalizeText(snapshot.writeId) ||
        !Array.isArray(chunk.rows)
      ) {
        throw new Error('PROFIT_LEDGER_SNAPSHOT_CHUNK_MISMATCH');
      }
      rowCount += chunk.rows.length;
    });
    if (rowCount !== Number(snapshot.rowCount)) throw new Error('PROFIT_LEDGER_SNAPSHOT_ROW_COUNT_MISMATCH');
  }

  function materializeSnapshot(row) {
    const snapshot = toPublicSnapshot(row);
    if (snapshot?.persistenceFormat !== PROFIT_LEDGER_CHUNKED_FORMAT) return snapshot;
    const chunkKeys = Array.isArray(snapshot.chunkKeys) ? snapshot.chunkKeys.map(normalizeText).filter(Boolean) : [];
    if (!chunkKeys.length) return null;
    const chunkRows = db
      .prepare(`SELECT snapshot_key, snapshot_json FROM profit_ledger_snapshots WHERE snapshot_key IN (${chunkKeys.map(() => '?').join(',')})`)
      .all(...chunkKeys);
    const byKey = new Map(chunkRows.map((chunk) => [chunk.snapshot_key, parseJson(chunk.snapshot_json, {})]));
    const rows = [];
    for (let index = 0; index < chunkKeys.length; index += 1) {
      const chunk = byKey.get(chunkKeys[index]);
      if (
        chunk?.persistenceFormat !== PROFIT_LEDGER_CHUNK_FORMAT ||
        normalizeText(chunk.chunkOf) !== row.snapshot_key ||
        normalizeText(chunk.writeId) !== normalizeText(snapshot.writeId) ||
        Number(chunk.chunkIndex) !== index ||
        Number(chunk.chunkCount) !== chunkKeys.length ||
        !Array.isArray(chunk.rows)
      ) return null;
      rows.push(...chunk.rows);
    }
    if (rows.length !== Number(snapshot.rowCount)) return null;
    return { ...snapshot, rows, total: rows.length };
  }

  function saveSnapshotUncommitted(input = {}) {
    const snapshotKey = normalizeSnapshotKeys(input.snapshotKey ?? input.snapshot_key ?? input.snapshotKeys ?? input.snapshot_keys)[0] || '';
    if (!snapshotKey) throw new Error('PROFIT_LEDGER_SNAPSHOT_KEY_REQUIRED');
    const sourceSnapshot = isPlainObject(input.snapshot) ? input.snapshot : input;
    const chunkOf = normalizeText(input.chunkOf ?? input.chunk_of);
    const chunkWrite = Boolean(chunkOf);
    const snapshot = chunkWrite
      ? {
          ...sourceSnapshot,
          persistenceFormat: PROFIT_LEDGER_CHUNK_FORMAT,
          chunkOf,
          writeId: normalizeText(input.writeId ?? input.write_id),
          chunkIndex: Number(input.chunkIndex ?? input.chunk_index),
          chunkCount: Number(input.chunkCount ?? input.chunk_count),
        }
      : sourceSnapshot;
    if (chunkWrite) {
      if (
        !snapshotKey.startsWith(`${chunkOf}${PROFIT_LEDGER_CHUNK_MARKER}`) ||
        !snapshot.writeId ||
        !Number.isInteger(snapshot.chunkIndex) ||
        !Number.isInteger(snapshot.chunkCount) ||
        snapshot.chunkIndex < 0 ||
        snapshot.chunkCount < 1 ||
        snapshot.chunkIndex >= snapshot.chunkCount ||
        !Array.isArray(snapshot.rows)
      ) throw new Error('PROFIT_LEDGER_SNAPSHOT_CHUNK_INVALID');
      const parentRow = db.prepare('SELECT snapshot_json FROM profit_ledger_snapshots WHERE snapshot_key = ?').get(chunkOf);
      const published = parseJson(parentRow?.snapshot_json, {});
      if (published.chunkKeys?.includes(snapshotKey)) {
        const previousChunk = db.prepare('SELECT snapshot_json FROM profit_ledger_snapshots WHERE snapshot_key = ?').get(snapshotKey);
        if (previousChunk?.snapshot_json !== serializeSnapshot(snapshot)) {
          const error = new Error('已发布的利润分块不能单独覆盖，必须使用新的完整批次。');
          error.code = 'PROFIT_LEDGER_PUBLISHED_CHUNK_IMMUTABLE';
          throw error;
        }
      }
    } else {
      validateChunkManifest(snapshotKey, snapshot);
      const previousRow = db.prepare('SELECT * FROM profit_ledger_snapshots WHERE snapshot_key = ?').get(snapshotKey)
        || db.prepare('SELECT * FROM profit_ledger_snapshots WHERE logical_scope = ? ORDER BY updated_at DESC LIMIT 1').get(getLogicalScope(snapshotKey));
      const previous = previousRow ? materializeSnapshot(previousRow) : null;
      const candidate = snapshot.persistenceFormat === PROFIT_LEDGER_CHUNKED_FORMAT
        ? materializeSnapshot({ snapshot_key: snapshotKey, snapshot_json: JSON.stringify(snapshot) })
        : snapshot;
      assertNoProfitEvidenceDowngrade(previous, candidate);
      // A new binding/filter can change the snapshot key without changing the
      // ownership of existing orders. Use other scopes only for rows absent
      // from the current baseline, newest first. Older historical snapshots
      // must not veto values already established in the current saved version.
      const remainingIdentities = new Set((candidate?.rows || []).map(getProfitEvidenceRowIdentity).filter(Boolean));
      for (const row of previous?.rows || []) remainingIdentities.delete(getProfitEvidenceRowIdentity(row));
      if (remainingIdentities.size && PROFIT_EVIDENCE_COMPATIBLE_VERSIONS.includes(candidate?.calculationVersion)) {
        const records = db.prepare(`SELECT * FROM profit_ledger_snapshots
          WHERE snapshot_key NOT LIKE ? AND snapshot_key <> ?
            AND calculation_version IN (${PROFIT_EVIDENCE_COMPATIBLE_VERSIONS.map(() => '?').join(',')})
          ORDER BY updated_at DESC, snapshot_key DESC`).all('%::chunk:%', previousRow?.snapshot_key || '', ...PROFIT_EVIDENCE_COMPATIBLE_VERSIONS);
        for (const record of records) {
          const other = materializeSnapshot(record);
          if (!other) continue;
          const baselineRows = (other.rows || []).filter((row) => remainingIdentities.has(getProfitEvidenceRowIdentity(row)));
          assertNoProfitEvidenceDowngrade({ ...other, rows: baselineRows }, candidate);
          for (const row of baselineRows) remainingIdentities.delete(getProfitEvidenceRowIdentity(row));
          if (!remainingIdentities.size) break;
        }
      }
    }
    const serialized = serializeSnapshot(snapshot);
    const storedAt = now();
    const record = {
      snapshotKey,
      logicalScope: chunkWrite ? `__profit_chunk__:${getLogicalScope(chunkOf)}` : getLogicalScope(snapshotKey),
      cacheGroup: normalizeText(snapshot.cacheGroup) || 'ozon-profit-ledger-v1',
      calculationVersion: normalizeText(snapshot.calculationVersion) || 'unknown',
      sourceKey: normalizeText(snapshot.sourceKey),
      signature: normalizeText(snapshot.signature),
      serialized,
      fetchedAt: normalizeText(snapshot.fetchedAt),
      storedAt,
    };
    db.prepare(`
      INSERT INTO profit_ledger_snapshots (
        snapshot_key, logical_scope, cache_group, calculation_version, source_key, signature,
        snapshot_json, fetched_at, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_key) DO UPDATE SET
        logical_scope = excluded.logical_scope,
        cache_group = excluded.cache_group,
        calculation_version = excluded.calculation_version,
        source_key = excluded.source_key,
        signature = excluded.signature,
        snapshot_json = excluded.snapshot_json,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `).run(
      record.snapshotKey,
      record.logicalScope,
      record.cacheGroup,
      record.calculationVersion,
      record.sourceKey || null,
      record.signature || null,
      record.serialized,
      record.fetchedAt || null,
      record.storedAt,
      record.storedAt,
    );
    const pruning = chunkWrite
      ? { removed: 0, retained: 0, retainedBytes: 0 }
      : pruneSnapshots(snapshotKey);
    const row = input.returnSnapshot === false ? null : db.prepare('SELECT * FROM profit_ledger_snapshots WHERE snapshot_key = ?').get(snapshotKey);
    return {
      ok: true,
      source: 'sqlite',
      snapshotKey,
      snapshot: row ? toPublicSnapshot(row) : null,
      stats: {
        compacted: pruning.removed > 0,
        removedSnapshots: pruning.removed,
        retainedScopes: pruning.retained,
        retainedBytes: pruning.retainedBytes,
        chunked: chunkWrite || snapshot.persistenceFormat === PROFIT_LEDGER_CHUNKED_FORMAT,
      },
    };
  }

  function saveSnapshot(input = {}) {
    db.exec('SAVEPOINT profit_snapshot_save');
    try {
      const result = saveSnapshotUncommitted(input);
      db.exec('RELEASE SAVEPOINT profit_snapshot_save');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT profit_snapshot_save');
      db.exec('RELEASE SAVEPOINT profit_snapshot_save');
      throw error;
    }
  }

  function saveSnapshotBundle(input = {}) {
    const snapshotKey = normalizeSnapshotKeys(input.snapshotKey)[0];
    const manifest = input.snapshot;
    const chunks = input.chunks;
    if (!snapshotKey || !isPlainObject(manifest) || manifest.persistenceFormat !== PROFIT_LEDGER_CHUNKED_FORMAT
      || !normalizeText(manifest.writeId) || !Array.isArray(chunks) || !chunks.length || chunks.length > 128
      || !Array.isArray(manifest.chunkKeys) || manifest.chunkKeys.length !== chunks.length
      || new Set(manifest.chunkKeys).size !== chunks.length
      || !Number.isSafeInteger(manifest.rowCount) || manifest.rowCount < 1
      || chunks.some((chunk) => !isPlainObject(chunk) || !Array.isArray(chunk.rows))) {
      throw new Error('PROFIT_LEDGER_BATCH_INVALID');
    }
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_PROFIT_LEDGER_SNAPSHOT_BYTES) throw new Error('PROFIT_LEDGER_SNAPSHOT_TOO_LARGE');
    const startedAt = Date.now();
    db.exec('SAVEPOINT profit_snapshot_bundle');
    try {
      chunks.forEach((chunk, index) => saveSnapshotUncommitted({
        snapshotKey: manifest.chunkKeys[index], snapshot: chunk, chunkOf: snapshotKey,
        writeId: manifest.writeId, chunkIndex: index, chunkCount: chunks.length, returnSnapshot: false,
      }));
      const saved = saveSnapshotUncommitted({ snapshotKey, snapshot: manifest });
      const readback = readSnapshot({ snapshotKey });
      if (!readback.ok || JSON.stringify(readback.snapshot.rows) !== JSON.stringify(chunks.flatMap((chunk) => chunk.rows))) {
        throw new Error('PROFIT_LEDGER_BATCH_READBACK_MISMATCH');
      }
      db.exec('RELEASE SAVEPOINT profit_snapshot_bundle');
      return { ...saved, stats: { ...saved.stats, batchWrite: true, rowCount: readback.snapshot.rows.length,
        chunkCount: chunks.length, readbackVerified: true, saveDurationMs: Date.now() - startedAt } };
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT profit_snapshot_bundle');
      db.exec('RELEASE SAVEPOINT profit_snapshot_bundle');
      throw error;
    }
  }

  function readSnapshot(query = {}) {
    const snapshotKeys = normalizeSnapshotKeys(query.snapshotKey ?? query.snapshot_key ?? query.keys ?? query.snapshotKeys);
    if (!snapshotKeys.length) return { ok: true, source: 'sqlite', snapshot: null, snapshotKey: '' };
    const rows = db
      .prepare(`SELECT * FROM profit_ledger_snapshots WHERE snapshot_key IN (${snapshotKeys.map(() => '?').join(',')})`)
      .all(...snapshotKeys);
    const byKey = new Map(rows.map((row) => [row.snapshot_key, row]));
    const snapshotKey = snapshotKeys.find((key) => byKey.has(key)) || '';
    const snapshot = snapshotKey ? materializeSnapshot(byKey.get(snapshotKey)) : null;
    if (snapshotKey && !snapshot) {
      return {
        ok: false,
        source: 'sqlite',
        snapshotKey,
        snapshot: null,
        error: { code: 'PROFIT_LEDGER_SNAPSHOT_CHUNK_INCOMPLETE', message: '利润缓存分块不完整。' },
      };
    }
    return { ok: true, source: 'sqlite', snapshotKey, snapshot };
  }

  function clearSnapshots(input = {}) {
    const snapshotKeys = normalizeSnapshotKeys(input.snapshotKey ?? input.snapshot_key ?? input.keys ?? input.snapshotKeys ?? input.snapshot_keys);
    if (!snapshotKeys.length) return { ok: true, source: 'sqlite', stats: { changed: false, removedSnapshots: 0 } };
    const allKeys = db.prepare('SELECT snapshot_key FROM profit_ledger_snapshots').all().map((row) => row.snapshot_key);
    const removalKeys = allKeys.filter((key) => snapshotKeys.some((base) => (
      key === base || key.startsWith(`${base}${PROFIT_LEDGER_CHUNK_MARKER}`)
    )));
    if (!removalKeys.length) return { ok: true, source: 'sqlite', stats: { changed: false, removedSnapshots: 0 } };
    const result = db
      .prepare(`DELETE FROM profit_ledger_snapshots WHERE snapshot_key IN (${removalKeys.map(() => '?').join(',')})`)
      .run(...removalKeys);
    return { ok: true, source: 'sqlite', stats: { changed: (result.changes || 0) > 0, removedSnapshots: result.changes || 0 } };
  }

  return { saveSnapshot, saveSnapshotBundle, readSnapshot, clearSnapshots };
}

/** Only published heads are business data; unreferenced staging chunks must never enter a report. */
export function readPublishedProfitSnapshots(db) {
  const repository = createProfitLedgerSnapshotRepository(db);
  const records = db.prepare('SELECT * FROM profit_ledger_snapshots WHERE snapshot_key NOT LIKE ? ORDER BY updated_at DESC, snapshot_key DESC').all('%::chunk:%');
  return records.map((record) => {
    const result = repository.readSnapshot({ snapshotKey: record.snapshot_key });
    if (result.ok === false) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }
    return { ...record, snapshot: result.snapshot };
  });
}

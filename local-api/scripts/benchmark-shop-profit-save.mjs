import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createProfitLedgerSnapshotRepository, readPublishedProfitSnapshots } from '../src/db/repositories/profitLedgerSnapshotRepository.js';

const args = process.argv.slice(2), option = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : '';
if (!option('--source') || !option('--report')) throw new Error('Required: --source --report');
const source = new DatabaseSync(resolve(option('--source')), { readOnly: true });
source.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=5000;BEGIN');
const schema = source.prepare("SELECT sql FROM sqlite_master WHERE name='profit_ledger_snapshots'").get().sql;
const owner = source.prepare('SELECT shop_id FROM shop_database_metadata WHERE singleton=1').get().shop_id;
const originals = source.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all();
const current = readPublishedProfitSnapshots(source)[0];
const originalChunks = current.snapshot.chunkKeys.map((key) => JSON.parse(source.prepare('SELECT snapshot_json FROM profit_ledger_snapshots WHERE snapshot_key=?').get(key).snapshot_json));
source.exec('ROLLBACK'); source.close();
const root = mkdtempSync(join(tmpdir(), 'wangzai-profit-speed-'));
try {
  const trials = [];
  for (let trial = 0; trial < 3; trial++) {
    for (const mode of ['serial', 'atomic']) {
      const db = new DatabaseSync(join(root, `${trial}-${mode}.sqlite`));
      try {
        db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;'); db.exec(schema);
        const columns = Object.keys(originals[0]);
        const insert = db.prepare(`INSERT INTO profit_ledger_snapshots (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        db.exec('BEGIN'); for (const row of originals) insert.run(...columns.map((key) => row[key])); db.exec('COMMIT');
        const repository = createProfitLedgerSnapshotRepository(db);
        const token = randomUUID();
        const chunks = originalChunks.map((chunk, index) => ({ persistenceFormat: 'profit-ledger-chunk-v1',
          calculationVersion: current.snapshot.calculationVersion, ownerShopId: owner,
          chunkIndex: index, chunkCount: originalChunks.length, rowCount: chunk.rows.length, rows: chunk.rows }));
        const manifest = { ...current.snapshot, rows: [], writeId: token, rowCount: current.snapshot.rows.length,
          chunkKeys: chunks.map((_chunk, index) => `${current.snapshot_key}::chunk:${token}:${index}`) };
        let requests = 0, requestBytes = 0, responseBytes = 0;
        const roundTrip = (payload, method) => {
          const encoded = JSON.stringify(payload); requestBytes += Buffer.byteLength(encoded); requests++;
          const result = repository[method](JSON.parse(encoded));
          const response = JSON.stringify(result); responseBytes += Buffer.byteLength(response);
          return JSON.parse(response);
        };
        const started = performance.now();
        if (mode === 'serial') {
          chunks.forEach((chunk, index) => roundTrip({ snapshotKey: manifest.chunkKeys[index], snapshot: chunk,
            chunkOf: current.snapshot_key, writeId: token, chunkIndex: index, chunkCount: chunks.length }, 'saveSnapshot'));
          roundTrip({ snapshotKey: current.snapshot_key, snapshot: manifest }, 'saveSnapshot');
        } else {
          const result = roundTrip({ snapshotKey: current.snapshot_key, snapshot: manifest, chunks }, 'saveSnapshotBundle');
          assert.equal(result.stats.readbackVerified, true);
        }
        const elapsedMs = Math.round(performance.now() - started);
        assert.deepEqual(repository.readSnapshot({ snapshotKey: current.snapshot_key }).snapshot.rows, current.snapshot.rows);
        trials.push({ trial: trial + 1, mode, elapsedMs, requests, requestBytes, responseBytes, allRowsUnchanged: true });
      } finally { db.close(); }
    }
  }
  const median = (mode) => trials.filter((row) => row.mode === mode).map((row) => row.elapsedMs).sort((a, b) => a - b)[1];
  const report = { isolatedRehearsal: true, liveSourceReadOnly: true, owner, orders: current.snapshot.rows.length,
    chunks: originalChunks.length, includes: 'JSON serialization and SQLite commits; excludes live Electron queue/network latency',
    serialMedianMs: median('serial'), atomicMedianMs: median('atomic'), trials };
  writeFileSync(resolve(option('--report')), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true });
}

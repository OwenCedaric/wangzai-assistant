import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublishedProfitSnapshots, createProfitLedgerSnapshotRepository } from '../../local-api/src/db/repositories/profitLedgerSnapshotRepository.js';
import { createFinanceRepository } from '../../local-api/src/db/repositories/financeRepository.js';
const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
for (const key of ['--shop', '--database', '--ledger']) if (!args.includes(key)) throw new Error(`${key} required`);
const owner = option('--shop');
const ledgerDb = new DatabaseSync(resolve(option('--ledger')), { readOnly: true });
ledgerDb.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=5000;BEGIN');
const head = readPublishedProfitSnapshots(ledgerDb)[0], snapshot = head.snapshot;
const tableSchema = ledgerDb.prepare("SELECT sql FROM sqlite_master WHERE name='profit_ledger_snapshots'").get().sql;
const originalRecords = ledgerDb.prepare('SELECT * FROM profit_ledger_snapshots').all();
const ledgerRows = snapshot.rows.filter(row => row.shopId === owner);
ledgerDb.exec('ROLLBACK'); ledgerDb.close();
assert.ok(ledgerRows.length);
const db = new DatabaseSync(resolve(option('--database')), { readOnly: true });
db.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=5000;BEGIN');
assert.equal(db.prepare('SELECT shop_id FROM shop_database_metadata WHERE singleton=1').get().shop_id, owner);
const server = await createServer({ configFile: false, root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
try {
  const display = await server.ssrLoadModule('/src/entities/profit/profitDisplayRules.jsx');
  const reader = await server.ssrLoadModule('/src/entities/profit/profitAfterSalesRules.jsx');
  const ledger = await server.ssrLoadModule('/src/services/profitLedgerService.js');
  const guard = await server.ssrLoadModule('/src/services/profitFinanceReadbackGuard.js');
  const penalty = await server.ssrLoadModule('/src/services/profitPenaltyAttribution.js');
  const partial = await server.ssrLoadModule('/src/services/profitPartialCompensation.js');
  const compaction = await server.ssrLoadModule('/src/services/profitLedgerPersistenceCompaction.js');
  const rows = ledgerRows.map(display.createProfitOrderFromLedgerRow);
  const shop = { id: owner, clientId: ledgerRows[0].shopClientId, apiKey: `synthetic-${randomUUID()}` };
  const repository = createFinanceRepository(db), trials = [];
  for (const batchSize of [80, 250]) {
    let requestCount = 0, maxUrlBytes = 0;
    globalThis.window = { wangzaiDesktop: { localApiRequest: async request => {
      const url = new URL(request.path, 'http://isolated.test');
      assert.equal(url.pathname, '/api/cache/finance');
      const query = Object.fromEntries(url.searchParams);
      assert.equal(query.shopId, owner);
      requestCount++; maxUrlBytes = Math.max(maxUrlBytes, Buffer.byteLength(request.path));
      return { ok: true, data: repository.listOperations(query) };
    } } };
    const started = performance.now();
    const result = await reader.readLocalProfitFinanceCacheForShop(shop, rows, { localFinancePostingChunkSize: batchSize });
    assert.equal(result.complete, true);
    trials.push({ batchSize, requestCount, maxUrlBytes, elapsedMs: Math.round(performance.now() - started),
      operations: result.operations, checked: [...result.checkedPostingNumbers].sort(), stats: result.stats });
  }
  const sorted = list => [...list].sort((a, b) => String(a.operation_id).localeCompare(String(b.operation_id)));
  assert.deepEqual(sorted(trials[0].operations), sorted(trials[1].operations));
  assert.deepEqual(trials[0].checked, trials[1].checked);
  assert.ok(trials[1].maxUrlBytes < 6500);
  const emptyFinanceReceipts = new Map(ledgerRows.filter(row => row.financeEmptyReceipt).map(row => [row.ledgerKey, row.financeEmptyReceipt]));
  const contexts = trials.map(trial => reader.buildLocalProfitFinanceHydrationContext(rows, trial.operations, {
    shop, allRowsForParentFallback: rows, emptyFinanceReceipts,
  }));
  const ratingPenaltyIndex = penalty.buildProfitPenaltyAttributionIndex(rows, snapshot.penaltyDetails);
  const project = row => ({
    amounts: Object.fromEntries(Object.entries(row.amounts).map(([key, value]) => [key, [value.value ?? null, value.status, value.source]])),
    results: Object.fromEntries(Object.entries(row.results).map(([key, value]) => [key, [value.value ?? null, value.status, value.formula]])),
    hasFinanceRefund: row.orderSnapshot.hasFinanceRefund,
    financeOperationCount: row.financeOperationCount,
  });
  const partialCases = [], rebuilt = new Map();
  for (const order of rows) {
    const old = ledger.migrateProfitLedgerRowToCurrentVersion(order.profitLedger);
    const calculate = (input, cached, context) => {
      const matched = context.matchedOrderKeys.has(old.ledgerKey);
      const prepared = partial.prepareProfitCalculationOrder(input, cached);
      const fresh = display.normalizeOzonProfitOrder(prepared, { ...context, ratingPenaltyIndex,
        exchangeRates: old.exchangeRates, actualExchangeRate: old.exchangeRates?.actual,
        estimatedExchangeRate: old.exchangeRates?.estimated, fetchedAt: snapshot.fetchedAt }).profitLedger;
      const protectedRow = guard.protectProfitLedgerFinanceInputs(cached, fresh, {
        financeReadbackComplete: matched, verifiedEmptyReceipt: context.emptyFinanceReceipts.get(old.ledgerKey),
      });
      return ledger.mergeProfitLedgerRows([cached], [protectedRow], { keepUnseenCached: false })[0];
    };
    const outputs = contexts.map(context => project(calculate(order, old, context)));
    assert.deepEqual(outputs[0], outputs[1], `Calculation changed for ${old.ledgerKey}`);
    const raw = { ...order }; delete raw.afterSalesStatus; delete raw.hasAfterSalesRefund; delete raw.hasFinanceRefund; delete raw.partialCompensationOnly;
    const preparedResult = calculate(raw, old, contexts[1]);
    assert.deepEqual(project(preparedResult), outputs[1], `Raw/cache business context drift: ${old.ledgerKey}`);
    const saved = compaction.compactProfitLedgerSnapshotForPersistence({ rows: [preparedResult] }).rows[0];
    const reopened = display.createProfitOrderFromLedgerRow(saved);
    const repeated = calculate(reopened, saved, contexts[1]);
    assert.deepEqual(project(repeated), outputs[1], `Repeated deduction after reopen: ${old.ledgerKey}`);
    rebuilt.set(old.ledgerKey, preparedResult);
    if (preparedResult.orderSnapshot.partialCompensationOnly) {
      const a = preparedResult.amounts;
      const expected = a.salesAmountCny.value - a.buyerCompensationCny.value - a.sourcePurchaseCostCny.value
        - a.actualOzonFeeCny.value - a.actualCrossBorderBusFeeCny.value;
      assert.ok(preparedResult.results.actualProfitCny.value != null &&
        Math.abs(preparedResult.results.actualProfitCny.value - expected) < 1e-8, `Partial rule: ${old.ledgerKey}`);
    }
    if (preparedResult.orderSnapshot.partialCompensationOnly) partialCases.push({ key: old.ledgerKey,
      gross: preparedResult.amounts.salesAmountCny.value, compensation: preparedResult.amounts.buyerCompensationCny.value,
      netIncome: preparedResult.amounts.actualSalesAmountCny.value, fees: preparedResult.amounts.actualOzonFeeCny.value,
      profit: preparedResult.results.actualProfitCny.value });
  }
  const isolated = new DatabaseSync(':memory:');
  try {
    isolated.exec(tableSchema);
    const columns = Object.keys(originalRecords[0]);
    const insert = isolated.prepare(`INSERT INTO profit_ledger_snapshots (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    originalRecords.forEach(record => insert.run(...columns.map(key => record[key])));
    const repo = createProfitLedgerSnapshotRepository(isolated);
    const next = { ...snapshot, calculationVersion: ledger.PROFIT_LEDGER_CALCULATION_VERSION,
      rows: snapshot.rows.map(row => rebuilt.get(row.ledgerKey) ?? row) };
    const plan = compaction.createProfitLedgerPersistencePlan(next), writeId = 'isolated-partial-compensation-check';
    const result = repo.saveSnapshotBundle({ snapshotKey: head.snapshot_key, chunks: plan.chunks,
      snapshot: { ...plan.manifest, writeId,
        chunkKeys: plan.chunks.map((_chunk, index) => `${head.snapshot_key}::chunk:${writeId}:${index}`) } });
    assert.equal(result.stats.readbackVerified, true);
    const readback = repo.readSnapshot({ snapshotKey: head.snapshot_key }).snapshot.rows;
    // SQLite stores JSON: JSON legitimately represents -0 as 0.
    const expected = JSON.parse(JSON.stringify(plan.chunks.flatMap(chunk => chunk.rows)));
    assert.equal(readback.length, expected.length);
    expected.forEach((row, index) => assert.ok(isDeepStrictEqual(readback[index], row), `Stored JSON changed: ${row.ledgerKey}`));
  } finally { isolated.close(); }
  console.log(JSON.stringify({ owner, orders: rows.length, sourceReadOnly: true, everyTransactionFieldUnchanged: true,
    isolatedAtomicSaveAndExactReadback: true,
    allPostingCoverageUnchanged: true, exactCalculationComparisonPassed: rows.length,
    rawCacheContextAndReopenVerified: rows.length, partialCases,
    trials: trials.map(({ operations, checked, ...trial }) => ({ ...trial, operations: operations.length, checked: checked.length })) }, null, 2));
} finally { delete globalThis.window; await server.close(); db.exec('ROLLBACK'); db.close(); }

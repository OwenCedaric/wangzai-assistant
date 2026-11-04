// Read-only regression against a real owner's snapshots. No APIs, writes or UI.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';
import { readPublishedProfitSnapshots, createProfitLedgerSnapshotRepository } from '../../local-api/src/db/repositories/profitLedgerSnapshotRepository.js';
import { createFinanceRepository } from '../../local-api/src/db/repositories/financeRepository.js';
import { assertNoProfitEvidenceDowngrade } from '../../local-api/src/db/repositories/profitSnapshotEvidenceGuard.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--source') || !args.includes('--baseline')) throw Error('--source and --baseline are required');
function open(path) { const db = new DatabaseSync(resolve(path), { readOnly: true }); db.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=5000;BEGIN'); return db; }
const db = open(option('--source')), baselineDb = open(option('--baseline'));
const capturedDb = args.includes('--snapshot') ? open(option('--snapshot')) : null;
const capture = capturedDb ?? db;
const currentHead = readPublishedProfitSnapshots(capture)[0];
const current = currentHead.snapshot;
const tableSchema = capture.prepare("SELECT sql FROM sqlite_master WHERE name='profit_ledger_snapshots'").get().sql;
const originalRecords = capture.prepare('SELECT * FROM profit_ledger_snapshots').all();
if (capturedDb) { capturedDb.exec('ROLLBACK'); capturedDb.close(); }
const baseline = readPublishedProfitSnapshots(baselineDb)[0].snapshot;
const owner = current.rows[0].shopId;
assert.ok(current.rows.every(r => r.shopId === owner));
const repository = createFinanceRepository(db), operations = [];
for (let page = 1; ; page++) {
  const result = repository.listOperations({ shopId: owner, page, pageSize: 1000 });
  operations.push(...result.rows);
  if (operations.length >= result.total) { assert.equal(operations.length, result.total); break; }
}
db.exec('ROLLBACK'); db.close(); baselineDb.exec('ROLLBACK'); baselineDb.close();
const server = await createServer({ configFile: false, root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
try {
  const display = await server.ssrLoadModule('/src/entities/profit/profitDisplayRules.jsx');
  const mapping = await server.ssrLoadModule('/src/entities/profit/profitLedgerMapping.jsx');
  const hydrationRules = await server.ssrLoadModule('/src/entities/profit/profitAfterSalesRules.jsx');
  const guard = await server.ssrLoadModule('/src/services/profitFinanceReadbackGuard.js');
  const ledger = await server.ssrLoadModule('/src/services/profitLedgerService.js');
  const penalties = await server.ssrLoadModule('/src/services/profitPenaltyAttribution.js');
  const orders = current.rows.map(display.createProfitOrderFromLedgerRow);
  const emptyReceipts = new Map();
  if (args.includes('--empty-evidence')) {
    const evidence = JSON.parse(readFileSync(resolve(option('--empty-evidence')), 'utf8'));
    assert.equal(evidence.allSuccessful, true);
    assert.equal(evidence.shopId, owner);
    const emptyRules = await server.ssrLoadModule('/src/services/profitEmptyFinanceEvidence.js');
    for (const order of orders) {
      const keys = emptyRules.getEmptyFinancePostingKeys(order);
      if (keys.length && keys.every(key => evidence.results.some(r => r.posting === key && r.ok && r.count === 0))) {
        emptyReceipts.set(order.profitLedger.ledgerKey, { version: 1, source: 'ozon-posting-finance', scope: 'posting-all-history',
          shopId: owner, clientId: order.shopClientId, operationCount: 0, postingNumbers: keys, checkedAt: evidence.checkedAt });
      }
    }
  }
  const hydration = hydrationRules.buildLocalProfitFinanceHydrationContext(orders, operations, {
    allRowsForParentFallback: orders, emptyFinanceReceipts: emptyReceipts,
  });
  const ratingPenaltyIndex = penalties.buildProfitPenaltyAttributionIndex(orders, current.penaltyDetails);
  const beforeByKey = new Map(baseline.rows.map(r => [r.ledgerKey, r]));
  const changes = [], unexpected = [], sourceReconciliations = [], emptyConfirmedChanges = [], kept = [], rebuilt = [];
  const profit = row => row?.results?.actualProfitCny?.value ?? null;
  const equal = (a, b) => a === b || (a != null && b != null && Math.abs(a - b) < 1e-8);
  for (const cached of current.rows) {
    const order = display.createProfitOrderFromLedgerRow(cached);
    const context = { ratingPenaltyIndex, profitFinanceVersion: cached.profitFinanceVersion,
      fetchedAt: current.fetchedAt, exchangeRates: cached.exchangeRates,
      estimatedExchangeRate: cached.exchangeRates?.estimated, actualExchangeRate: cached.exchangeRates?.actual };
    const build = (complete) => {
      const normalized = display.normalizeOzonProfitOrder(order, { ...context, ...(complete ? {
        financeIndex: hydration.financeIndex, financeLookupCheckedIndex: hydration.financeLookupCheckedIndex,
        financeParentFallbackIndex: hydration.financeParentFallbackIndex,
      } : {}) });
      const fresh = guard.protectProfitLedgerFinanceInputs(cached, normalized.profitLedger, {
        financeReadbackComplete: complete, verifiedEmptyReceipt: complete ? emptyReceipts.get(cached.ledgerKey) : null,
      });
      const merged = ledger.mergeProfitLedgerRows([cached], [fresh], { keepUnseenCached: false })[0];
      const result = mapping.rebuildProfitLedgerForFinalZeroActualSales(order, merged);
      return { ...result, financeReadbackState: fresh.financeReadbackState, financeEmptyReceipt: fresh.financeEmptyReceipt ?? null };
    };
    const retained = build(false);
    assert.equal(retained.orderSnapshot.hasFinanceRefund, cached.orderSnapshot.hasFinanceRefund === true);
    assert.ok(equal(profit(retained), profit(cached)), `Unloaded finance changed ${cached.ledgerKey}`);
    kept.push(retained);
    const matched = hydration.matchedOrderKeys.has(cached.ledgerKey);
    const fixed = build(matched); rebuilt.push(fixed);
    const old = beforeByKey.get(cached.ledgerKey);
    if (!equal(profit(fixed), profit(cached))) changes.push({ key: cached.ledgerKey, before: profit(old), current: profit(cached), rebuilt: profit(fixed) });
    if (old && !equal(profit(fixed), profit(old))) {
      if (fixed.financeReadbackState === 'empty-confirmed' && emptyReceipts.has(cached.ledgerKey)) {
        const inputs = ['sourcePurchaseCostCny', 'actualCommissionFeeCny', 'actualPenaltyFeeCny',
          'actualAcquiringFeeCny', 'actualDeliveryServiceFeeCny', 'actualLogisticsFeeCny', 'actualCrossBorderBusFeeCny'];
        assert.equal(fixed.amounts.actualSalesAmountCny.value, 0);
        assert.ok(inputs.every(k => fixed.amounts[k]?.status === 'ready'));
        assert.ok(equal(profit(fixed), -inputs.reduce((sum, k) => sum + fixed.amounts[k].value, 0)));
        emptyConfirmedChanges.push({ key: cached.ledgerKey, before: profit(old), actualProfit: profit(fixed),
          actualBusFee: fixed.amounts.actualCrossBorderBusFeeCny.value });
        continue;
      }
      // Some older caches had already omitted a real acquiring charge. Accept
      // only a fully explained difference, independently summing raw operations
      // once per operation ID (not duplicating their service line amounts).
      const matchedOperations = mapping.getProfitOrderFinanceOperations(order, hydration.financeIndex, {
        financeParentFallbackIndex: hydration.financeParentFallbackIndex,
      });
      const acquiring = matchedOperations.filter(op => String(op.operation_type).toLowerCase() === 'marketplaceredistributionofacquiringoperation');
      const netRub = acquiring.reduce((sum, op) => sum + Number(op.raw?.amount ?? op.amount), 0);
      const expectedFee = Math.max(0, -netRub) * cached.exchangeRates?.actual?.rubToCnyRate;
      const oldFee = old.amounts.actualAcquiringFeeCny?.value;
      const unchangedInputs = ['actualSalesAmountCny', 'sourcePurchaseCostCny', 'actualCommissionFeeCny',
        'actualPenaltyFeeCny', 'actualDeliveryServiceFeeCny', 'actualLogisticsFeeCny', 'actualCrossBorderBusFeeCny'];
      const explained = acquiring.length > 0 && new Set(acquiring.map(op => String(op.operation_id))).size === acquiring.length
        && Number.isFinite(expectedFee) && equal(fixed.amounts.actualAcquiringFeeCny?.value, expectedFee)
        && unchangedInputs.every(k => equal(fixed.amounts[k]?.value, old.amounts[k]?.value))
        && equal(profit(fixed) - profit(old), oldFee - expectedFee);
      const change = { key: cached.ledgerKey, baseline: profit(old), rebuilt: profit(fixed) };
      if (explained) sourceReconciliations.push({ ...change, netAcquiringRub: netRub, expectedFeeCny: expectedFee,
        operationIds: acquiring.map(op => op.operation_id) });
      else unexpected.push(change);
    }
  }
  assertNoProfitEvidenceDowngrade(current, { ...current, rows: kept });
  assertNoProfitEvidenceDowngrade(current, { ...current, rows: rebuilt });
  assert.equal(unexpected.length, 0, JSON.stringify(unexpected));
  const compaction = await server.ssrLoadModule('/src/services/profitLedgerPersistenceCompaction.js');
  const isolated = new DatabaseSync(':memory:');
  try {
    isolated.exec(tableSchema);
    const columns = Object.keys(originalRecords[0]);
    const insert = isolated.prepare(`INSERT INTO profit_ledger_snapshots (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    originalRecords.forEach(record => insert.run(...columns.map(key => record[key])));
    const repo = createProfitLedgerSnapshotRepository(isolated);
    const plan = compaction.createProfitLedgerPersistencePlan({ ...current, rows: rebuilt });
    const writeId = 'isolated-finance-readback-verification';
    const result = repo.saveSnapshotBundle({ snapshotKey: currentHead.snapshot_key, chunks: plan.chunks,
      snapshot: { ...plan.manifest, writeId,
        chunkKeys: plan.chunks.map((_chunk, index) => `${currentHead.snapshot_key}::chunk:${writeId}:${index}`) } });
    assert.equal(result.stats.readbackVerified, true);
    assert.deepEqual(repo.readSnapshot({ snapshotKey: currentHead.snapshot_key }).snapshot.rows, plan.chunks.flatMap(chunk => chunk.rows));
  } finally { isolated.close(); }
  console.log(JSON.stringify({ sourceReadOnly: true, owner, rows: current.rows.length, operations: operations.length,
    retainedInputsVerified: kept.length, rebuiltRows: rebuilt.length, unexplainedActualProfitChanges: unexpected.length,
    baselineMatchedRows: rebuilt.length - sourceReconciliations.length - emptyConfirmedChanges.length,
    isolatedAtomicSaveAndExactReadback: true,
    readyActualRows: rebuilt.filter(r => r.results.actualProfitCny?.status === 'ready').length,
    verifiedEmptyReceipts: emptyReceipts.size, changes, sourceReconciliations, emptyConfirmedChanges }, null, 2));
} finally { await server.close(); }

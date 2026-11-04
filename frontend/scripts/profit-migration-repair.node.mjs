import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { initializeDatabase } from '../../local-api/src/db/database.js';
import { createProfitLedgerSnapshotRepository } from '../../local-api/src/db/repositories/profitLedgerSnapshotRepository.js';
import { createFinanceRepository } from '../../local-api/src/db/repositories/financeRepository.js';

test('preview/apply/restart repair restores only proven fields for all shops and is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-profit-evidence-repair-'));
  const files = [];
  const open = (name) => {
    const { db } = initializeDatabase({ database: { path: join(root, name), enableWal: false, busyTimeoutMs: 5000 } });
    files.push(db); return db;
  };
  const oldDb = open('old.sqlite');
  const currentDb = open('current.sqlite');
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  try {
    const { createProfitLedgerRow } = await server.ssrLoadModule('/src/services/profitLedgerService.js');
    const oldRows = [];
    for (let i = 1; i <= 3; i++) {
      const shopId = `shop-${i}`;
      const directory = join(root, 'shops', shopId, 'scope-test'); mkdirSync(directory, { recursive: true });
      const shopDb = open(`shops/${shopId}/scope-test/shop-cache.sqlite`);
      for (const db of [oldDb, currentDb, shopDb]) db.prepare("INSERT INTO shops(id,name,status,profile_id,shop_incarnation) VALUES (?,?,'active','test','test')").run(shopId, shopId);
      shopDb.exec('CREATE TABLE shop_database_metadata (singleton INTEGER,shop_id TEXT,profile_id TEXT,shop_incarnation TEXT)');
      shopDb.prepare("INSERT INTO shop_database_metadata VALUES (1,?,'test','test')").run(shopId);
      const posting = 'same-order-1';
      if (i !== 3) {
        for (const db of [oldDb, shopDb]) createFinanceRepository(db).upsertOperations({ shopId, rows: [
          { operation_id: `op-${i}`, posting_number: posting, operation_type: 'OperationAgentDeliveredToCustomer', amount: 30, sale_commission: -i },
        ] });
      }
      const row = createProfitLedgerRow({ id: posting, posting, shopId, status: 'delivered', amountValue: 47, currencyCode: 'CNY', purchasePriceValue: 2.9 }, {
        actualFinanceStatus: 'confirmed', hasActualFinance: true, financeLookupChecked: true, financeOperationCount: i === 3 ? 0 : 1,
        amounts: { actualCommissionFeeCny: i === 3 ? 0 : i, actualPenaltyFeeCny: 0, actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0, actualLogisticsFeeCny: 0, crossBorderBusFeeCny: 1.2 },
      });
      row.calculationVersion = 'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge';
      oldRows.push(row);
    }
    createProfitLedgerSnapshotRepository(oldDb).saveSnapshot({ snapshotKey: 'all-history', snapshot: { calculationVersion: oldRows[0].calculationVersion, rows: oldRows } });
    const damaged = structuredClone(oldRows);
    for (const row of damaged) {
      row.calculationVersion = 'profit-ledger-v16-per-order-finance-exchange-rate';
      for (const field of ['actualCommissionFeeCny', 'actualOzonFeeCny']) row.amounts[field] = { value: null, status: 'pending', source: 'ozon-finance' };
      row.results.actualProfitCny = { value: null, status: 'pending' };
    }
    createProfitLedgerSnapshotRepository(currentDb).saveSnapshot({ snapshotKey: 'all-history', snapshot: { calculationVersion: damaged[0].calculationVersion, rows: damaged } });
    await server.close();
    const report = join(root, 'report.json');
    const parameters = ['scripts/repair-profit-migration-cache.mjs', '--target', join(root, 'current.sqlite'), '--source', join(root, 'old.sqlite'),
      '--shop-root', join(root, 'shops'), '--report', report];
    execFileSync(process.execPath, parameters, { cwd: resolve('.'), windowsHide: true });
    const preview = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(preview.repaired.length, 3);
    assert.equal(preview.skipped.length, 0);
    execFileSync(process.execPath, [...parameters, '--apply', '--expected', preview.planDigest, '--backup-dir', join(root, 'backups')], { cwd: resolve('.'), windowsHide: true });
    const repaired = createProfitLedgerSnapshotRepository(currentDb).readSnapshot({ snapshotKey: 'all-history' }).snapshot;
    for (let i = 0; i < 3; i++) {
      assert.equal(repaired.rows[i].shopId, oldRows[i].shopId);
      assert.equal(repaired.rows[i].amounts.actualCommissionFeeCny.value, oldRows[i].amounts.actualCommissionFeeCny.value);
      assert.equal(repaired.rows[i].results.actualProfitCny.value, oldRows[i].results.actualProfitCny.value);
    }
    execFileSync(process.execPath, parameters, { cwd: resolve('.'), windowsHide: true });
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).repaired.length, 0);
  } finally {
    await server.close();
    for (const db of files) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

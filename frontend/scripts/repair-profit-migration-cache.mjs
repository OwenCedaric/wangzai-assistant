import { createServer } from 'vite';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createProfitLedgerSnapshotRepository } from '../../local-api/src/db/repositories/profitLedgerSnapshotRepository.js';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
for (const name of ['--target', '--source', '--shop-root', '--report']) {
  if (!args.includes(name)) throw new Error(`Required: ${name}`);
}
const apply = args.includes('--apply');
const targetPath = resolve(option('--target'));
const sourcePath = resolve(option('--source'));
if (targetPath === sourcePath) throw new Error('REPAIR_SOURCE_MUST_BE_SEPARATE');
const reportPath = resolve(option('--report'));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const openRead = (path) => { const db = new DatabaseSync(path, { readOnly: true }); db.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=5000'); return db; };
const source = openRead(sourcePath);
const target = apply ? new DatabaseSync(targetPath) : openRead(targetPath);
target.exec('PRAGMA busy_timeout=5000');
const shopDbs = new Map();
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
const identity = (row) => row?.shopId && row?.orderSnapshot?.posting ? `${row.shopId}\u001f${row.orderSnapshot.posting}` : '';
const ready = (entry) => entry?.status === 'ready' && entry.value != null && entry.value !== '' && Number.isFinite(Number(entry.value));
const fields = ['actualCommissionFeeCny', 'actualOzonFeeCny'];
function snapshots(db) {
  const repo = createProfitLedgerSnapshotRepository(db);
  return db.prepare('SELECT snapshot_key,updated_at FROM profit_ledger_snapshots WHERE snapshot_key NOT LIKE ? ORDER BY updated_at DESC')
    .all('%::chunk:%').map((record) => ({ ...record, snapshot: repo.readSnapshot({ snapshotKey: record.snapshot_key }).snapshot }));
}
function finance(db, shopId, posting) {
  return db.prepare(`SELECT operation_id, posting_number, operation_type, operation_date, amount_total,
    sale_commission_cny, acquiring_fee_cny, delivery_fee_cny, currency_code, services_json
    FROM ozon_finance_transactions WHERE shop_id=? AND posting_number IN (?,?) AND is_stale=0
    ORDER BY operation_id, posting_number`).all(shopId, posting, posting.replace(/-\d+$/, ''));
}
let transaction = false;
try {
  const { mergeProfitLedgerRows } = await server.ssrLoadModule('/src/services/profitLedgerService.js');
  const { createProfitLedgerPersistencePlan } = await server.ssrLoadModule('/src/services/profitLedgerPersistenceCompaction.js');
  const active = target.prepare("SELECT id,profile_id,shop_incarnation FROM shops WHERE status='active'").all();
  const root = resolve(option('--shop-root'));
  for (const folder of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory() && item.name.startsWith('shop-'))) {
    for (const scope of readdirSync(join(root, folder.name), { withFileTypes: true }).filter((item) => item.isDirectory() && item.name.startsWith('scope-'))) {
      const path = join(root, folder.name, scope.name, 'shop-cache.sqlite');
      if (!existsSync(path)) continue;
      const db = openRead(path);
      const meta = db.prepare('SELECT * FROM shop_database_metadata WHERE singleton=1').get();
      if (active.some((s) => s.id === meta.shop_id && s.profile_id === meta.profile_id && s.shop_incarnation === meta.shop_incarnation)) shopDbs.set(meta.shop_id, db);
      else db.close();
    }
  }
  const originals = new Map();
  for (const { snapshot } of snapshots(source)) {
    if (snapshot?.calculationVersion !== 'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge') continue;
    for (const row of snapshot.rows || []) if (identity(row) && !originals.has(identity(row))) originals.set(identity(row), row);
  }
  target.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN'); transaction = true;
  const preimage = target.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all();
  const report = { mode: apply ? 'apply' : 'preview', beforeDigest: hash(preimage), formulaChanged: false, shops: {}, repaired: [], skipped: [] };
  const plans = [];
  for (const record of snapshots(target)) {
    if (record.snapshot?.calculationVersion !== 'profit-ledger-v16-per-order-finance-exchange-rate') continue;
    let changed = false;
    const rows = record.snapshot.rows.map((row) => {
      const original = originals.get(identity(row));
      const shopId = row.shopId;
      report.shops[shopId] ||= { examined: 0, restored: 0, readyBefore: 0, readyAfter: 0 };
      const stats = report.shops[shopId]; stats.examined++;
      if (ready(row.results?.actualProfitCny)) stats.readyBefore++;
      const restoreFields = original ? fields.filter((field) => !ready(row.amounts?.[field]) && ready(original.amounts?.[field])) : [];
      const skip = (reason) => { if (restoreFields.length) report.skipped.push({ shopId, posting: row.orderSnapshot?.posting, reason }); if (ready(row.results?.actualProfitCny)) stats.readyAfter++; return row; };
      if (!restoreFields.length) return skip('no_missing_confirmed_evidence');
      // A startup cache miss must settle before repairing derived results. Do
      // not publish a restored commission against an accidentally zeroed cost.
      if (original.amounts?.sourcePurchaseCostCny?.value > 0
        && row.amounts?.sourcePurchaseCostCny?.value === 0
        && ['confirmed-no-purchase', 'missing-purchase-cost-zero'].includes(row.amounts.sourcePurchaseCostCny.source)) {
        return skip('purchase_cost_requires_verified_readback');
      }
      if (!shopDbs.has(shopId)) return skip('current_shop_database_missing');
      const posting = row.orderSnapshot.posting;
      const beforeFinance = finance(source, shopId, posting);
      const nowFinance = finance(shopDbs.get(shopId), shopId, posting);
      const previouslyCheckedZero = original.financeLookupChecked === true
        && restoreFields.every((field) => original.amounts[field].value === 0);
      if ((!beforeFinance.length && !previouslyCheckedZero) || hash(beforeFinance) !== hash(nowFinance)) return skip('financial_evidence_changed_or_missing');
      const restored = structuredClone(row);
      for (const field of restoreFields) restored.amounts[field] = structuredClone(original.amounts[field]);
      const [recomputed] = mergeProfitLedgerRows([restored], [restored], { keepUnseenCached: false });
      // Only the two accidentally invalidated fields and their derived results may change.
      const otherFields = Object.keys(row.amounts || {}).filter((field) => !fields.includes(field));
      const financialValue = (entry) => ({ value: entry?.value, status: entry?.status, source: entry?.source });
      if (otherFields.some((field) => hash(financialValue(row.amounts[field])) !== hash(financialValue(recomputed.amounts[field])))) return skip('other_financial_field_would_change');
      for (const field of otherFields) recomputed.amounts[field] = row.amounts[field];
      changed = true; stats.restored++;
      if (ready(recomputed.results?.actualProfitCny)) stats.readyAfter++;
      report.repaired.push({ shopId, posting, fields: restoreFields, actualProfit: recomputed.results?.actualProfitCny?.value ?? null });
      return recomputed;
    });
    if (changed) plans.push({ key: record.snapshot_key, snapshot: { ...record.snapshot, rows, migrationRepair: 'v15-v16-evidence-preservation-20260904' } });
  }
  report.planDigest = hash({ before: report.beforeDigest, repaired: report.repaired, skipped: report.skipped });
  if (apply) {
    if (!args.includes('--expected') || option('--expected') !== report.planDigest) throw new Error('REPAIR_PREVIEW_CHANGED_REVIEW_AGAIN');
    if (!args.includes('--backup-dir')) throw new Error('REPAIR_BACKUP_DIR_REQUIRED');
    const backupRoot = resolve(option('--backup-dir')); mkdirSync(backupRoot, { recursive: true });
    const backupPath = join(backupRoot, `ledger-preimage-${Date.now()}.sqlite`);
    const backup = new DatabaseSync(backupPath);
    try {
      backup.exec(target.prepare('SELECT sql FROM sqlite_master WHERE name=?').get('profit_ledger_snapshots').sql);
      const columns = Object.keys(preimage[0]);
      const insert = backup.prepare(`INSERT INTO profit_ledger_snapshots (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      backup.exec('BEGIN'); for (const row of preimage) insert.run(...columns.map((key) => row[key])); backup.exec('COMMIT');
      if (hash(backup.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all()) !== report.beforeDigest) throw new Error('REPAIR_BACKUP_MISMATCH');
    } finally { backup.close(); }
    report.backupPath = backupPath;
    const repo = createProfitLedgerSnapshotRepository(target);
    for (const { key, snapshot } of plans) {
      const plan = createProfitLedgerPersistencePlan(snapshot);
      const writeId = `evidence-repair-${Date.now()}`;
      const chunkKeys = plan.chunks.map((chunk, i) => {
        const chunkKey = `${key}::chunk:${writeId}:${i}`;
        repo.saveSnapshot({ snapshotKey: chunkKey, snapshot: chunk, chunkOf: key, writeId, chunkIndex: i, chunkCount: plan.chunks.length });
        return chunkKey;
      });
      repo.saveSnapshot({ snapshotKey: key, snapshot: { ...plan.manifest, chunkKeys, writeId } });
      const loaded = repo.readSnapshot({ snapshotKey: key }).snapshot;
      if (loaded.rows.length !== snapshot.rows.length) throw new Error('REPAIR_ROW_COUNT_MISMATCH');
      for (let i = 0; i < loaded.rows.length; i++) {
        if (identity(loaded.rows[i]) !== identity(snapshot.rows[i])) throw new Error('REPAIR_SHOP_ORDER_MISMATCH');
        for (const field of fields) if (Number(loaded.rows[i].amounts[field]?.value) !== Number(snapshot.rows[i].amounts[field]?.value)) throw new Error('REPAIR_AMOUNT_MISMATCH');
      }
    }
    target.exec('COMMIT'); transaction = false;
  } else { target.exec('COMMIT'); transaction = false; }
  report.snapshotCount = plans.length;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode: report.mode, snapshotCount: plans.length, shops: report.shops,
    repaired: report.repaired.length, skipped: report.skipped.length, planDigest: report.planDigest, reportPath, backupPath: report.backupPath }, null, 2));
} finally {
  if (transaction) target.exec('ROLLBACK');
  for (const db of shopDbs.values()) db.close();
  source.close(); target.close(); await server.close();
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup as backupDatabase, DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';

function readArgument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
}

function requireArgument(name) {
  const value = readArgument(name);
  if (!value) throw new Error(`Missing required argument --${name}=...`);
  return resolve(value);
}

function parseSnapshotRow(row) {
  if (!row) return null;
  const snapshot = JSON.parse(String(row.snapshot_json || '{}'));
  return { ...row, snapshot };
}

function readSnapshotRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare('SELECT * FROM profit_ledger_snapshots ORDER BY updated_at DESC')
      .all()
      .map(parseSnapshotRow)
      .filter(Boolean);
  } finally {
    database.close();
  }
}

function normalizeIdentity(value) {
  return String(value ?? '').trim();
}

function expandOrderIdentities(...values) {
  const result = new Set();
  values.map(normalizeIdentity).filter(Boolean).forEach((value) => {
    result.add(value);
    const segments = value.split(':').filter(Boolean);
    if (segments.length > 1) result.add(segments.at(-1));
  });
  return [...result];
}

function readExactBusOverrides(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'purchase_order_overrides'")
      .get();
    if (!table) return new Map();
    const index = new Map();
    const rows = database
      .prepare('SELECT shop_id, order_key, posting_number, raw_json, updated_at FROM purchase_order_overrides')
      .all();
    for (const row of rows) {
      let raw = {};
      try {
        raw = JSON.parse(String(row.raw_json || '{}'));
      } catch {
        continue;
      }
      const actualFeeCny = Number(raw.actualCrossBorderBusFeeCny);
      if (!Number.isFinite(actualFeeCny) || actualFeeCny < 0) continue;
      const shopId = normalizeIdentity(raw.shopId || row.shop_id);
      if (!shopId) continue;
      const updatedAt = normalizeIdentity(raw.crossBorderUpdatedAt || raw.updatedAt || row.updated_at);
      const override = {
        shopId,
        actualFeeCny,
        source: normalizeIdentity(raw.actualCrossBorderBusFeeSource) || 'cross-border-bus-ledger-cash-converted',
        evidence: raw.crossBorderChargeEvidence || null,
        crossBorderOrderFound: raw.crossBorderOrderFound === true,
        packageOrderId: normalizeIdentity(raw.packageOrderId || raw.crossBorderOrderId),
        packageOrderIds: Array.isArray(raw.packageOrderIds) ? raw.packageOrderIds.map(normalizeIdentity).filter(Boolean) : [],
        crossBorderOrderNumber: normalizeIdentity(raw.crossBorderOrderNumber),
        updatedAt,
      };
      for (const orderIdentity of expandOrderIdentities(
        raw.postingNumber,
        raw.orderKey,
        raw.sheetOrderSn,
        row.posting_number,
        row.order_key
      )) {
        const key = `${shopId}|${orderIdentity}`;
        const current = index.get(key);
        if (!current || Date.parse(updatedAt || 0) >= Date.parse(current.updatedAt || 0)) index.set(key, override);
      }
    }
    return index;
  } finally {
    database.close();
  }
}

function rowKey(row) {
  return String(row?.ledgerKey || row?.orderKey || '').trim();
}

function findExactBusOverride(row, overrideIndex) {
  const shopId = normalizeIdentity(row?.shopId || row?.orderSnapshot?.shopId);
  if (!shopId) return null;
  const identities = expandOrderIdentities(
    row?.orderKey,
    row?.ledgerKey,
    row?.orderSnapshot?.postingNumber,
    row?.orderSnapshot?.posting,
    row?.orderSnapshot?.id,
    row?.orderSnapshot?.orderNumber
  );
  return identities.map((identity) => overrideIndex.get(`${shopId}|${identity}`)).find(Boolean) || null;
}

function applyExactBusOverrides(snapshot, overrideIndex, migrateRow) {
  let appliedCount = 0;
  const rows = (snapshot.rows || []).map((row) => {
    const override = findExactBusOverride(row, overrideIndex);
    if (!override) return row;
    appliedCount += 1;
    return migrateRow({
      ...row,
      orderSnapshot: {
        ...(row.orderSnapshot || {}),
        crossBorderOrderFound: override.crossBorderOrderFound,
        packageOrderId: override.packageOrderId,
        crossBorderOrderId: override.packageOrderId,
        packageOrderIds: override.packageOrderIds,
        crossBorderOrderNumber: override.crossBorderOrderNumber,
      },
      amounts: {
        ...(row.amounts || {}),
        actualCrossBorderBusFeeCny: {
          ...(row.amounts?.actualCrossBorderBusFeeCny || {}),
          value: override.actualFeeCny,
          status: 'ready',
          source: override.source,
          reason: '',
          updatedAt: override.updatedAt,
          evidence: override.evidence,
        },
      },
    });
  });
  return { snapshot: { ...snapshot, rows }, appliedCount };
}

function isReadyResult(row) {
  return row?.results?.bestProfitCny?.status === 'ready' && Number.isFinite(Number(row?.results?.bestProfitCny?.value));
}

function isReadyAmount(entry) {
  return entry?.status === 'ready' && Number.isFinite(Number(entry?.value));
}

function summarize(snapshot) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const sumReady = (selector) =>
    Math.round(
      rows.reduce((total, row) => {
        const entry = selector(row);
        return total + (entry?.status === 'ready' && Number.isFinite(Number(entry.value)) ? Number(entry.value) : 0);
      }, 0) * 100
    ) / 100;
  return {
    total: rows.length,
    ready: rows.filter(isReadyResult).length,
    pending: rows.filter((row) => !isReadyResult(row)).length,
    profit: rows.filter((row) => row?.status === 'profit').length,
    loss: rows.filter((row) => row?.status === 'loss').length,
    actualBusFeeCny: sumReady((row) => row?.amounts?.actualCrossBorderBusFeeCny),
    actualProfitCny: sumReady((row) => row?.results?.actualProfitCny),
    bestProfitCny: sumReady((row) => row?.results?.bestProfitCny),
  };
}

function createOrderAudit(oldSnapshot, currentSnapshot, repairedSnapshot) {
  const oldByKey = new Map((oldSnapshot.rows || []).map((row) => [rowKey(row), row]));
  const currentByKey = new Map((currentSnapshot.rows || []).map((row) => [rowKey(row), row]));
  return (repairedSnapshot.rows || []).map((repairedRow) => {
    const key = rowKey(repairedRow);
    const oldRow = oldByKey.get(key);
    const currentRow = currentByKey.get(key);
    return {
      orderKey: key,
      shopId: repairedRow.shopId || '',
      backupStatus: oldRow?.status || 'missing',
      targetStatus: currentRow?.status || 'missing',
      repairedStatus: repairedRow.status || 'pending',
      backupActualBusFeeCny: oldRow?.amounts?.actualCrossBorderBusFeeCny?.value ?? null,
      targetActualBusFeeCny: currentRow?.amounts?.actualCrossBorderBusFeeCny?.value ?? null,
      repairedActualBusFeeCny: repairedRow?.amounts?.actualCrossBorderBusFeeCny?.value ?? null,
      repairedActualProfitCny: repairedRow?.results?.actualProfitCny?.value ?? null,
      repairedBestProfitCny: repairedRow?.results?.bestProfitCny?.value ?? null,
      financeStatus: repairedRow.actualFinanceStatus || '',
      financeOperationCount: repairedRow.financeOperationCount || 0,
    };
  });
}

function assertEvidencePreserved(oldSnapshot, currentSnapshot, repairedSnapshot) {
  const currentByKey = new Map((currentSnapshot.rows || []).map((row) => [rowKey(row), row]));
  const repairedByKey = new Map((repairedSnapshot.rows || []).map((row) => [rowKey(row), row]));
  const regressions = [];
  const lostAmounts = [];
  const busMismatches = [];

  for (const oldRow of oldSnapshot.rows || []) {
    const key = rowKey(oldRow);
    const currentRow = currentByKey.get(key);
    const repairedRow = repairedByKey.get(key);
    if (!repairedRow) {
      regressions.push({ key, reason: 'row-missing-after-repair' });
      continue;
    }
    if (isReadyResult(oldRow) && !isReadyResult(repairedRow)) {
      regressions.push({ key, reason: 'ready-result-became-pending' });
    }
    for (const [field, oldEntry] of Object.entries(oldRow.amounts || {})) {
      const currentEntry = currentRow?.amounts?.[field];
      const repairedEntry = repairedRow?.amounts?.[field];
      if (isReadyAmount(oldEntry) && !isReadyAmount(currentEntry) && !isReadyAmount(repairedEntry)) {
        lostAmounts.push({ key, field, oldValue: oldEntry.value });
      }
    }
    const currentBus = currentRow?.amounts?.actualCrossBorderBusFeeCny;
    const repairedBus = repairedRow?.amounts?.actualCrossBorderBusFeeCny;
    const currentBusIsExact =
      isReadyAmount(currentBus) &&
      (/exact|reconciled/i.test(String(currentBus.source || '')) || currentBus.evidence?.matchMode === 'exact');
    if (currentBusIsExact && Number(repairedBus?.value) !== Number(currentBus.value)) {
      busMismatches.push({ key, expected: currentBus.value, actual: repairedBus?.value });
    }
  }

  if (regressions.length || lostAmounts.length || busMismatches.length) {
    throw new Error(
      `Profit repair validation failed: ${JSON.stringify({ regressions, lostAmounts, busMismatches }, null, 2)}`
    );
  }
}

function updateSnapshots(databasePath, repairedRows) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('BEGIN IMMEDIATE');
    const update = database.prepare(`
      UPDATE profit_ledger_snapshots
      SET calculation_version = ?, signature = ?, snapshot_json = ?, fetched_at = ?, updated_at = ?
      WHERE snapshot_key = ?
    `);
    for (const row of repairedRows) {
      const snapshot = row.snapshot;
      const result = update.run(
        snapshot.calculationVersion,
        snapshot.signature || '',
        JSON.stringify(snapshot),
        snapshot.fetchedAt || row.fetched_at || '',
        snapshot.updatedAt || row.updated_at || '',
        row.snapshot_key
      );
      if (Number(result.changes) !== 1) throw new Error(`Snapshot update missed ${row.snapshot_key}`);
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors after SQLite has already rolled back the transaction.
    }
    throw error;
  } finally {
    database.close();
  }
}

async function createConsistentDatabaseBackup(databasePath, backupPath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backupDatabase(database, backupPath);
  } finally {
    database.close();
  }
}

const targetPath = requireArgument('target');
const backupPath = requireArgument('backup');
const reportPath = resolve(readArgument('report') || './outputs/profit-ledger-v9-repair-report.json');
const apply = process.argv.includes('--apply');
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

try {
  const {
    PROFIT_LEDGER_CALCULATION_VERSION,
    migrateProfitLedgerRowToCurrentVersion,
    mergeProfitLedgerSnapshotIntoStore,
    readProfitLedgerSnapshotFromStore,
  } = await vite.ssrLoadModule('/src/services/profitLedgerService.js');
  const targetRows = readSnapshotRows(targetPath);
  const backupRows = readSnapshotRows(backupPath);
  const exactBusOverrides = readExactBusOverrides(targetPath);
  const backupByKey = new Map(backupRows.map((row) => [String(row.snapshot_key), row]));
  const repairedRows = [];
  const report = {
    schemaVersion: 1,
    calculationVersion: PROFIT_LEDGER_CALCULATION_VERSION,
    mode: apply ? 'apply' : 'dry-run',
    targetPath,
    backupPath,
    generatedAt: new Date().toISOString(),
    snapshots: [],
  };

  for (const targetRow of targetRows) {
    const backupRow = backupByKey.get(String(targetRow.snapshot_key));
    if (!backupRow) continue;
    const oldSnapshot = readProfitLedgerSnapshotFromStore(
      { profitLedgerSnapshots: { [backupRow.snapshot_key]: backupRow.snapshot } },
      backupRow.snapshot_key
    );
    const currentSnapshot = readProfitLedgerSnapshotFromStore(
      { profitLedgerSnapshots: { [targetRow.snapshot_key]: targetRow.snapshot } },
      targetRow.snapshot_key
    );
    if (!oldSnapshot || !currentSnapshot) continue;

    const merged = mergeProfitLedgerSnapshotIntoStore(
      { profitLedgerSnapshots: { [targetRow.snapshot_key]: backupRow.snapshot } },
      targetRow.snapshot_key,
      currentSnapshot,
      { keepUnseenCached: true }
    );
    const exactBusResult = applyExactBusOverrides(
      merged.snapshot,
      exactBusOverrides,
      migrateProfitLedgerRowToCurrentVersion
    );
    const repairedSnapshot = mergeProfitLedgerSnapshotIntoStore(
      {},
      targetRow.snapshot_key,
      exactBusResult.snapshot,
      { keepUnseenCached: true }
    ).store.profitLedgerSnapshots[targetRow.snapshot_key];
    assertEvidencePreserved(oldSnapshot, currentSnapshot, repairedSnapshot);
    const orderAudit = createOrderAudit(oldSnapshot, currentSnapshot, repairedSnapshot);
    repairedRows.push({ ...targetRow, snapshot: repairedSnapshot });
    report.snapshots.push({
      snapshotKey: targetRow.snapshot_key,
      beforeBackup: summarize(oldSnapshot),
      beforeTarget: summarize(currentSnapshot),
      afterRepair: summarize(repairedSnapshot),
      signature: repairedSnapshot.signature || '',
      exactBusOverrideCount: exactBusResult.appliedCount,
      restoredReadyOrderCount: orderAudit.filter(
        (row) => row.targetStatus === 'pending' && row.repairedStatus !== 'pending'
      ).length,
      changedBusOrderCount: orderAudit.filter(
        (row) => Number(row.targetActualBusFeeCny) !== Number(row.repairedActualBusFeeCny)
      ).length,
      orders: orderAudit,
    });
  }

  if (!repairedRows.length) throw new Error('No compatible profit snapshots were found in the supplied backup.');
  mkdirSync(dirname(reportPath), { recursive: true });
  if (apply) {
    const safetyBackupPath = `${targetPath}.before-profit-v10-source-authority-${new Date().toISOString().replace(/[:.]/g, '')}.bak`;
    await createConsistentDatabaseBackup(targetPath, safetyBackupPath);
    updateSnapshots(targetPath, repairedRows);
    report.safetyBackupPath = safetyBackupPath;
    const readbackByKey = new Map(readSnapshotRows(targetPath).map((row) => [String(row.snapshot_key), row]));
    report.snapshots.forEach((entry) => {
      const readback = readbackByKey.get(entry.snapshotKey);
      if (!readback || readback.calculation_version !== PROFIT_LEDGER_CALCULATION_VERSION) {
        throw new Error(`Readback validation failed for ${entry.snapshotKey}`);
      }
      entry.readback = summarize(readback.snapshot);
    });
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await vite.close();
}

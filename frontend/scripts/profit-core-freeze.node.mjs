import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { auditProfitCoreFreeze, sha256File } from './profit-core-freeze-core.mjs';

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-profit-freeze-'));
  try {
    const ledgerPath = join(root, 'src/services/profitLedgerService.js');
    const runtimePath = join(root, 'src/features/profit/ProfitPage.jsx');
    mkdirSync(dirname(ledgerPath), { recursive: true });
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(
      ledgerPath,
      "export const PROFIT_LEDGER_CALCULATION_VERSION = 'profit-ledger-v16-test';\nexport function invalidateMigratedCommissionEvidence(row) { return { ...row, source: 'ozon-finance-sale-commission' }; }\nexport function migrateProfitLedgerRowToCurrentVersion(row) { return invalidateMigratedCommissionEvidence(row); }\nexport function read(snapshot) { return snapshot.rows.map(migrateProfitLedgerRowToCurrentVersion); }\nexport const formula = 1;\n",
      'utf8'
    );
    writeFileSync(runtimePath, 'export const runtime = 1;\n', 'utf8');
    return run({ root, ledgerPath, runtimePath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createManifest(ledgerPath, runtimePath) {
  return {
    schemaVersion: 2,
    calculationVersion: 'profit-ledger-v16-test',
    runtimeVersion: 'profit-page-runtime-v6-test',
    migratableCalculationVersions: [
      'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge',
      'profit-ledger-v14-final-cross-border-charge-evidence',
      'profit-ledger-v13-rfbs-finance-commission',
      'profit-ledger-v12-explicit-no-forecast-evidence',
      'profit-ledger-v10-test',
    ],
    verifiedDataBaseline: {
      salesOrders: 1,
      distinctPostingNumbers: 1,
      duplicateShopPostingPairs: 0,
    },
    verifiedRuntimeBaseline: {
      verifiedAt: '2026-08-18T00:00:00.000Z',
      scope: 'full-history-test',
      snapshotKey: 'profit-runtime-test',
      salesOrders: 1,
      distinctPostingNumbers: 1,
      distinctShopPostingPairs: 1,
      duplicateShopPostingPairs: 0,
      shopCounts: { 'shop-test': 1 },
    },
    calculationFiles: { 'src/services/profitLedgerService.js': sha256File(ledgerPath) },
    runtimeFiles: { 'src/features/profit/ProfitPage.jsx': sha256File(runtimePath) },
    retiredPaths: [],
    retiredSymbols: {},
  };
}

test('profit freeze accepts the exact verified source', () => {
  withFixture(({ root, ledgerPath, runtimePath }) => {
    const report = auditProfitCoreFreeze({
      root,
      manifest: createManifest(ledgerPath, runtimePath),
    });
    assert.equal(report.ok, true);
  });
});

test('profit freeze rejects silent formula changes without a reviewed version update', () => {
  withFixture(({ root, ledgerPath, runtimePath }) => {
    const manifest = createManifest(ledgerPath, runtimePath);
    writeFileSync(
      ledgerPath,
      "export const PROFIT_LEDGER_CALCULATION_VERSION = 'profit-ledger-v16-test';\nexport function migrateProfitLedgerRowToCurrentVersion(row) { return row; }\nexport function read(snapshot) { return snapshot.rows.map(migrateProfitLedgerRowToCurrentVersion); }\nexport const formula = 2;\n",
      'utf8'
    );
    const report = auditProfitCoreFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'hash-mismatch'), true);
  });
});

test('a runtime hash cannot mask a conflicting calculation hash for the same file', () => {
  withFixture(({ root, ledgerPath, runtimePath }) => {
    const manifest = createManifest(ledgerPath, runtimePath);
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('formula = 1', 'formula = 2'), 'utf8');
    manifest.runtimeFiles['src/services/profitLedgerService.js'] = sha256File(ledgerPath);
    const report = auditProfitCoreFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some(row => row.kind === 'conflicting-protected-hash'), true);
  });
});

test('an identical hash can protect a file in both calculation and runtime roles', () => {
  withFixture(({ root, ledgerPath, runtimePath }) => {
    const manifest = createManifest(ledgerPath, runtimePath);
    manifest.runtimeFiles['src/services/profitLedgerService.js'] = manifest.calculationFiles['src/services/profitLedgerService.js'];
    assert.equal(auditProfitCoreFreeze({ root, manifest }).ok, true);
  });
});

test('profit freeze rejects a v16 manifest that drops the compatible snapshot migration contract', () => {
  withFixture(({ root, ledgerPath, runtimePath }) => {
    const manifest = createManifest(ledgerPath, runtimePath);
    delete manifest.migratableCalculationVersions;
    const report = auditProfitCoreFreeze({
      root,
      manifest,
    });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'missing-migration-contract'), true);
  });
});

test('profit freeze rejects a runtime manifest without a verified full-history order baseline', () => {
  withFixture(({ root, ledgerPath, runtimePath }) => {
    const manifest = createManifest(ledgerPath, runtimePath);
    delete manifest.verifiedRuntimeBaseline;
    const report = auditProfitCoreFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'invalid-runtime-data-baseline'), true);
  });
});

test('profit freeze rejects a v16 source that filters compatible rows instead of migrating them', () => {
  withFixture(({ root, ledgerPath, runtimePath }) => {
    writeFileSync(
      ledgerPath,
      "export const PROFIT_LEDGER_CALCULATION_VERSION = 'profit-ledger-v16-test';\nexport const formula = 1;\n",
      'utf8'
    );
    const report = auditProfitCoreFreeze({
      root,
      manifest: createManifest(ledgerPath, runtimePath),
    });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'migration-path-missing'), true);
  });
});

test('profit freeze rejects a restored retired path or symbol', () => {
  withFixture(({ root, ledgerPath, runtimePath }) => {
    const retiredPath = join(root, 'src/services/profitLegacyPipelineFreeze.js');
    mkdirSync(dirname(retiredPath), { recursive: true });
    writeFileSync(retiredPath, 'export const legacy = true;\n', 'utf8');
    writeFileSync(runtimePath, 'export const filterProfitSplitAggregateRows = true;\n', 'utf8');
    const manifest = createManifest(ledgerPath, runtimePath);
    manifest.runtimeFiles['src/features/profit/ProfitPage.jsx'] = sha256File(runtimePath);
    manifest.retiredPaths = ['src/services/profitLegacyPipelineFreeze.js'];
    manifest.retiredSymbols = {
      filterProfitSplitAggregateRows: ['src/features/profit/ProfitPage.jsx'],
    };
    const report = auditProfitCoreFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'retired-path-restored'), true);
    assert.equal(report.violations.some((row) => row.kind === 'retired-symbol-restored'), true);
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  auditDataAnalysisMarketCaptureFreeze,
  sha256DataAnalysisMarketCaptureFile,
} from './data-analysis-market-capture-freeze-core.mjs';

const FEATURE_VERSION = 'data-analysis-market-capture-v2-test';

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-data-analysis-market-capture-freeze-'));
  try {
    const versionPath = join(root, 'src/features/dataAnalysis/constants/dataAnalysisMarketCaptureFreezeContract.js');
    const runtimePath = join(root, 'src/features/dataAnalysis/services/dataAnalysisMarketHotRuntime.js');
    const hookPath = join(root, 'src/features/dataAnalysis/model/useDataAnalysisMarket.js');
    [versionPath, runtimePath, hookPath].forEach((filePath) => mkdirSync(dirname(filePath), { recursive: true }));
    writeFileSync(versionPath, `export const DATA_ANALYSIS_MARKET_CAPTURE_FREEZE_VERSION = '${FEATURE_VERSION}';\n`, 'utf8');
    writeFileSync(runtimePath, 'const INTERVAL = 30 * 60_000;\nconst profileId = profileIds[0];\n', 'utf8');
    writeFileSync(hookPath, 'export function useDataAnalysisMarket({ enabled = false } = {}) {}\n', 'utf8');
    const manifest = {
      schemaVersion: 1,
      featureVersion: FEATURE_VERSION,
      files: {
        'src/features/dataAnalysis/constants/dataAnalysisMarketCaptureFreezeContract.js': sha256DataAnalysisMarketCaptureFile(versionPath),
        'src/features/dataAnalysis/services/dataAnalysisMarketHotRuntime.js': sha256DataAnalysisMarketCaptureFile(runtimePath),
      },
      contracts: [
        {
          file: 'src/features/dataAnalysis/services/dataAnalysisMarketHotRuntime.js',
          required: ['30 * 60_000', 'profileIds[0]'],
          forbidden: ['5 * 60_000', 'for (const profileId of profileIds)'],
        },
        {
          file: 'src/features/dataAnalysis/model/useDataAnalysisMarket.js',
          required: ['useDataAnalysisMarket({ enabled = false }'],
          forbidden: ["shopId = ''", "profileId = ''"],
        },
      ],
    };
    return run({ root, manifest, runtimePath, hookPath, versionPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('market capture freeze accepts the exact single-collector account-level implementation', () => {
  withFixture(({ root, manifest }) => {
    assert.equal(auditDataAnalysisMarketCaptureFreeze({ root, manifest }).ok, true);
  });
});

test('market capture freeze rejects silent changes to protected files', () => {
  withFixture(({ root, manifest, runtimePath }) => {
    writeFileSync(runtimePath, 'const INTERVAL = 5 * 60_000;\n', 'utf8');
    const report = auditDataAnalysisMarketCaptureFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'hash-mismatch'), true);
    assert.equal(report.violations.some((row) => row.kind === 'missing-required-contract'), true);
    assert.equal(report.violations.some((row) => row.kind === 'forbidden-legacy-code'), true);
  });
});

test('market capture freeze rejects reintroducing shop-scoped market UI state', () => {
  withFixture(({ root, manifest, hookPath }) => {
    writeFileSync(hookPath, "export function useDataAnalysisMarket({ enabled = false, profileId = '', shopId = '' } = {}) {}\n", 'utf8');
    const report = auditDataAnalysisMarketCaptureFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'forbidden-legacy-code'), true);
  });
});

test('market capture freeze rejects a manifest/source version mismatch', () => {
  withFixture(({ root, manifest, versionPath }) => {
    writeFileSync(versionPath, "export const DATA_ANALYSIS_MARKET_CAPTURE_FREEZE_VERSION = 'wrong-version';\n", 'utf8');
    const report = auditDataAnalysisMarketCaptureFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'version-source-mismatch'), true);
  });
});

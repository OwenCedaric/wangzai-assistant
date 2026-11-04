import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  auditDataAnalysisInsightFreeze,
  sha256DataAnalysisInsightFile,
  sha256DataAnalysisInsightText,
} from './data-analysis-insight-freeze-core.mjs';

const FEATURE_VERSION = 'data-analysis-insight-v2-test';

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-data-analysis-insight-freeze-'));
  try {
    const versionPath = join(root, 'src/features/dataAnalysis/constants/dataAnalysisInsightFreezeContract.js');
    const reportPath = join(root, 'src/features/dataAnalysis/components/DataAnalysisInsightReport.jsx');
    const entryPath = join(root, 'src/features/dataAnalysis/DataAnalysisPage.jsx');
    const stylePath = join(root, 'src/styles.css');
    [versionPath, reportPath, entryPath, stylePath].forEach((filePath) => {
      mkdirSync(dirname(filePath), { recursive: true });
    });
    writeFileSync(versionPath, `export const DATA_ANALYSIS_INSIGHT_FREEZE_VERSION = '${FEATURE_VERSION}';\n`, 'utf8');
    writeFileSync(reportPath, 'export const report = true;\n', 'utf8');
    writeFileSync(entryPath, 'void analyzeInsight();\n', 'utf8');
    const styleSegment = '/* START */\n.report { width: 100%; }\n/* END */';
    writeFileSync(stylePath, styleSegment, 'utf8');
    const manifest = {
      schemaVersion: 1,
      featureVersion: FEATURE_VERSION,
      files: {
        'src/features/dataAnalysis/constants/dataAnalysisInsightFreezeContract.js': sha256DataAnalysisInsightFile(versionPath),
        'src/features/dataAnalysis/components/DataAnalysisInsightReport.jsx': sha256DataAnalysisInsightFile(reportPath),
      },
      segments: [{
        name: 'report-style',
        file: 'src/styles.css',
        startMarker: '/* START */',
        endMarker: '/* END */',
        sha256: sha256DataAnalysisInsightText(styleSegment),
      }],
      contracts: [{
        file: 'src/features/dataAnalysis/DataAnalysisPage.jsx',
        required: ['void analyzeInsight();'],
        forbidden: ['refreshAnalysis({ keepStatus: true })'],
      }],
    };
    return run({ root, manifest, reportPath, entryPath, stylePath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('data analysis insight freeze accepts the exact implementation, layout and entry contract', () => {
  withFixture(({ root, manifest }) => {
    assert.equal(auditDataAnalysisInsightFreeze({ root, manifest }).ok, true);
  });
});

test('data analysis insight freeze rejects silent report changes', () => {
  withFixture(({ root, manifest, reportPath }) => {
    writeFileSync(reportPath, 'export const report = false;\n', 'utf8');
    const report = auditDataAnalysisInsightFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'hash-mismatch'), true);
  });
});

test('data analysis insight freeze rejects broken layout and retired concurrent refresh code', () => {
  withFixture(({ root, manifest, entryPath, stylePath }) => {
    writeFileSync(entryPath, 'refreshAnalysis({ keepStatus: true });\n', 'utf8');
    writeFileSync(stylePath, '/* START */\n.report { width: 50%; }\n/* END */', 'utf8');
    const report = auditDataAnalysisInsightFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'missing-required-contract'), true);
    assert.equal(report.violations.some((row) => row.kind === 'forbidden-legacy-code'), true);
    assert.equal(report.violations.some((row) => row.kind === 'segment-hash-mismatch'), true);
  });
});

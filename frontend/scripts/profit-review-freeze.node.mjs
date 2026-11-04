import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  auditProfitReviewFreeze,
  sha256File,
  sha256Text,
} from './profit-review-freeze-core.mjs';

const FEATURE_VERSION = 'profit-order-review-v2-test';

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-profit-review-freeze-'));
  try {
    const contractPath = join(root, 'src/features/profitReview/constants/profitOrderReviewContract.js');
    const implementationPath = join(root, 'src/features/profitReview/services/profitOrderReviewService.js');
    const entryPath = join(root, 'src/entry.js');
    const stylePath = join(root, 'src/styles.css');
    [contractPath, implementationPath, entryPath, stylePath].forEach((filePath) => {
      mkdirSync(dirname(filePath), { recursive: true });
    });
    writeFileSync(contractPath, `export const PROFIT_ORDER_REVIEW_FREEZE_VERSION = '${FEATURE_VERSION}';\n`, 'utf8');
    writeFileSync(implementationPath, 'export const run = true;\n', 'utf8');
    writeFileSync(entryPath, "import './features/profitReview/services/profitOrderReviewService.js';\n", 'utf8');
    const styleSegment = '/* START */\n.profit-review { color: #000; }\n/* END */';
    writeFileSync(stylePath, styleSegment, 'utf8');
    const manifest = {
      schemaVersion: 1,
      featureVersion: FEATURE_VERSION,
      files: {
        'src/features/profitReview/constants/profitOrderReviewContract.js': sha256File(contractPath),
        'src/features/profitReview/services/profitOrderReviewService.js': sha256File(implementationPath),
      },
      segments: [{
        name: 'style',
        file: 'src/styles.css',
        startMarker: '/* START */',
        endMarker: '/* END */',
        sha256: sha256Text(styleSegment),
      }],
      contracts: [{
        file: 'src/entry.js',
        required: ['./features/profitReview/services/profitOrderReviewService.js'],
        forbidden: ['legacyProfitEstimate'],
      }],
    };
    return run({ root, manifest, implementationPath, entryPath, stylePath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('profit review freeze accepts the exact implementation, style segment and entry contract', () => {
  withFixture(({ root, manifest }) => {
    assert.equal(auditProfitReviewFreeze({ root, manifest }).ok, true);
  });
});

test('profit review freeze rejects silent implementation changes', () => {
  withFixture(({ root, manifest, implementationPath }) => {
    writeFileSync(implementationPath, 'export const run = false;\n', 'utf8');
    const report = auditProfitReviewFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'hash-mismatch'), true);
  });
});

test('profit review freeze rejects broken paths, style changes and legacy code restoration', () => {
  withFixture(({ root, manifest, entryPath, stylePath }) => {
    writeFileSync(entryPath, 'legacyProfitEstimate();\n', 'utf8');
    writeFileSync(stylePath, '/* START */\n.profit-review { color: red; }\n/* END */', 'utf8');
    const report = auditProfitReviewFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'missing-required-contract'), true);
    assert.equal(report.violations.some((row) => row.kind === 'forbidden-legacy-code'), true);
    assert.equal(report.violations.some((row) => row.kind === 'segment-hash-mismatch'), true);
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  auditFollowSellerScheme1Freeze,
  sha256FollowSellerScheme1File,
} from './follow-seller-scheme1-freeze-core.mjs';

const VERSION = 'follow-seller-scheme1-v1-test';

function withFixture(run) {
  const caseRoot = mkdtempSync(join(tmpdir(), 'wangzai-follow-seller-scheme1-freeze-'));
  const root = join(caseRoot, 'frontend');
  try {
    const servicePath = join(root, 'src/features/followSellerDefense/services/followSellerDefenseService.js');
    const flowPath = join(root, 'src/features/followSellerDefense/model/useFollowSellerDefense.js');
    mkdirSync(dirname(servicePath), { recursive: true });
    mkdirSync(dirname(flowPath), { recursive: true });
    writeFileSync(servicePath, `export const FOLLOW_SELLER_SCHEME1_FREEZE_VERSION = '${VERSION}';\nprepareFollowSellerVerification();\n`, 'utf8');
    writeFileSync(flowPath, 'prepareQuick();\nsubmitQuick();\nrecordSubmission();\nprepareVerification();\ncaptureOne();\nverifyCount();\n', 'utf8');
    const manifest = {
      schemaVersion: 1,
      featureVersion: VERSION,
      route: Array.from({ length: 9 }, (_, index) => `step-${index + 1}`),
      files: {
        'src/features/followSellerDefense/services/followSellerDefenseService.js': sha256FollowSellerScheme1File(servicePath),
        'src/features/followSellerDefense/model/useFollowSellerDefense.js': sha256FollowSellerScheme1File(flowPath),
      },
      contracts: [{
        file: 'src/features/followSellerDefense/services/followSellerDefenseService.js',
        required: ['prepareFollowSellerVerification'],
        forbidden: ['ozon-read-follow-seller-complaint'],
      }],
      sequences: [{
        file: 'src/features/followSellerDefense/model/useFollowSellerDefense.js',
        markers: ['prepareQuick()', 'submitQuick()', 'recordSubmission()', 'prepareVerification()', 'captureOne()', 'verifyCount()'],
      }],
    };
    return run({ root, manifest, servicePath, flowPath });
  } finally {
    rmSync(caseRoot, { recursive: true, force: true });
  }
}

test('accepts the exact frozen scheme1 route', () => withFixture(({ root, manifest }) => {
  assert.equal(auditFollowSellerScheme1Freeze({ root, manifest }).ok, true);
}));

test('rejects a silent scheme1 implementation change', () => withFixture(({ root, manifest, flowPath }) => {
  writeFileSync(flowPath, 'prepareQuick();\nsubmitQuick();\nrecordSubmission();\n', 'utf8');
  const report = auditFollowSellerScheme1Freeze({ root, manifest });
  assert.equal(report.violations.some((item) => item.kind === 'hash-mismatch'), true);
}));

test('rejects a reordered submission and verification route', () => withFixture(({ root, manifest, flowPath }) => {
  writeFileSync(flowPath, 'prepareQuick();\nprepareVerification();\nsubmitQuick();\nrecordSubmission();\ncaptureOne();\nverifyCount();\n', 'utf8');
  manifest.files['src/features/followSellerDefense/model/useFollowSellerDefense.js'] = sha256FollowSellerScheme1File(flowPath);
  const report = auditFollowSellerScheme1Freeze({ root, manifest });
  assert.equal(report.violations.some((item) => item.kind === 'missing-sequence-step'), true);
}));

test('rejects restoration of the retired support readback branch', () => withFixture(({ root, manifest, servicePath }) => {
  writeFileSync(servicePath, `export const FOLLOW_SELLER_SCHEME1_FREEZE_VERSION = '${VERSION}';\nprepareFollowSellerVerification();\nozon-read-follow-seller-complaint\n`, 'utf8');
  manifest.files['src/features/followSellerDefense/services/followSellerDefenseService.js'] = sha256FollowSellerScheme1File(servicePath);
  const report = auditFollowSellerScheme1Freeze({ root, manifest });
  assert.equal(report.violations.some((item) => item.kind === 'forbidden-legacy-code'), true);
}));

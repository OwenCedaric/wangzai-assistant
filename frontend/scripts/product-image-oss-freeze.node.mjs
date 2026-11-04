import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { auditProductImageOssFreeze, sha256ProductImageOssFile } from './product-image-oss-freeze-core.mjs';

const VERSION = 'product-image-oss-v3-test';

function withFixture(run) {
  const caseRoot = mkdtempSync(join(tmpdir(), 'wangzai-product-image-oss-freeze-'));
  const root = join(caseRoot, 'frontend');
  try {
    const servicePath = join(root, 'src/features/products/services/productImageAssetService.js');
    const backendPath = join(root, '../local-api/src/domain/productImages/productImageAssetService.js');
    mkdirSync(dirname(servicePath), { recursive: true });
    mkdirSync(dirname(backendPath), { recursive: true });
    writeFileSync(servicePath, `export const PRODUCT_IMAGE_OSS_FREEZE_VERSION = '${VERSION}';\npromoteProductImageAsset();\n`, 'utf8');
    writeFileSync(backendPath, 'function promoteAsset() {}\nfunction getUsageStatus() {}\n', 'utf8');
    const manifest = { schemaVersion: 1, featureVersion: VERSION, files: {
      'src/features/products/services/productImageAssetService.js': sha256ProductImageOssFile(servicePath),
      '../local-api/src/domain/productImages/productImageAssetService.js': sha256ProductImageOssFile(backendPath),
    }, contracts: [{ file: '../local-api/src/domain/productImages/productImageAssetService.js',
      required: ['promoteAsset', 'getUsageStatus'], forbidden: ['tenantId: body.tenantId'] }] };
    return run({ root, manifest, servicePath, backendPath });
  } finally { rmSync(caseRoot, { recursive: true, force: true }); }
}

test('accepts the exact multi-user OSS implementation and contracts', () => withFixture(({ root, manifest }) => {
  assert.equal(auditProductImageOssFreeze({ root, manifest }).ok, true);
}));

test('rejects a silent service change', () => withFixture(({ root, manifest, backendPath }) => {
  writeFileSync(backendPath, 'function promoteAsset() { return false; }\nfunction getUsageStatus() {}\n', 'utf8');
  assert.equal(auditProductImageOssFreeze({ root, manifest }).violations.some((item) => item.kind === 'hash-mismatch'), true);
}));

test('rejects removal of the Ozon promotion and usage contracts', () => withFixture(({ root, manifest, backendPath }) => {
  writeFileSync(backendPath, 'export const value = true;\n', 'utf8');
  const report = auditProductImageOssFreeze({ root, manifest });
  assert.equal(report.violations.filter((item) => item.kind === 'missing-required-contract').length, 2);
}));

test('rejects a body-controlled tenant boundary', () => withFixture(({ root, manifest, backendPath }) => {
  writeFileSync(backendPath, 'function promoteAsset() {}\nfunction getUsageStatus() {}\nconst scope = { tenantId: body.tenantId };\n', 'utf8');
  assert.equal(auditProductImageOssFreeze({ root, manifest }).violations.some((item) => item.kind === 'forbidden-legacy-code'), true);
}));

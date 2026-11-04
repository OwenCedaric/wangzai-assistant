import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  auditPurchasePddRouteFreeze,
  sha256File,
  sha256Text,
} from './purchase-pdd-route-freeze-core.mjs';

const FEATURE_VERSION = 'purchase-pdd-1688-route-v2-test';

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-purchase-pdd-route-freeze-'));
  try {
    const versionPath = join(root, 'src/features/orders/purchase/constants/purchasePddRouteFreezeContract.js');
    const servicePath = join(root, 'scripts/purchase-bridge/pdd-title-search-service.mjs');
    const hookPath = join(root, 'src/features/orders/purchase/model/usePurchaseSourceLinkState.jsx');
    const entryPath = join(root, 'scripts/purchase-search-bridge.mjs');
    [versionPath, servicePath, hookPath, entryPath].forEach((filePath) => {
      mkdirSync(dirname(filePath), { recursive: true });
    });
    writeFileSync(versionPath, `export const PURCHASE_PDD_1688_ROUTE_FREEZE_VERSION = '${FEATURE_VERSION}';\n`, 'utf8');
    writeFileSync(servicePath, 'search1688ByImage(imageUrl);\nbuildPddSearchUrl(sourceSearch.searchTitle);\n', 'utf8');
    const hookSegment = '// START\n/api/purchase/pdd-title-search\nopenSourceSearchUrl(autoOpenUrl);\n// END';
    writeFileSync(hookPath, hookSegment, 'utf8');
    writeFileSync(entryPath, 'handlePddTitleSearch(payload);\n', 'utf8');
    const manifest = {
      schemaVersion: 1,
      featureVersion: FEATURE_VERSION,
      files: {
        'src/features/orders/purchase/constants/purchasePddRouteFreezeContract.js': sha256File(versionPath),
        'scripts/purchase-bridge/pdd-title-search-service.mjs': sha256File(servicePath),
      },
      segments: [{
        name: 'frontend-route',
        file: 'src/features/orders/purchase/model/usePurchaseSourceLinkState.jsx',
        startMarker: '// START',
        endMarker: '// END',
        sha256: sha256Text(hookSegment),
      }],
      contracts: [{
        file: 'scripts/purchase-search-bridge.mjs',
        required: ['handlePddTitleSearch(payload);'],
        forbidden: ['resolvePurchasePddSearchTitle'],
      }],
    };
    return run({ root, manifest, servicePath, hookPath, entryPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('purchase PDD route freeze accepts the exact 1688 to PDD implementation', () => {
  withFixture(({ root, manifest }) => {
    assert.equal(auditPurchasePddRouteFreeze({ root, manifest }).ok, true);
  });
});

test('purchase PDD route freeze rejects silent route changes', () => {
  withFixture(({ root, manifest, servicePath }) => {
    writeFileSync(servicePath, 'resolvePurchasePddSearchTitle(imageUrl);\n', 'utf8');
    const report = auditPurchasePddRouteFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'hash-mismatch'), true);
  });
});

test('purchase PDD route freeze rejects segment changes and forbidden legacy code', () => {
  withFixture(({ root, manifest, hookPath, entryPath }) => {
    writeFileSync(hookPath, '// START\nvisual-model\n// END', 'utf8');
    writeFileSync(entryPath, 'resolvePurchasePddSearchTitle();\n', 'utf8');
    const report = auditPurchasePddRouteFreeze({ root, manifest });
    assert.equal(report.ok, false);
    assert.equal(report.violations.some((row) => row.kind === 'segment-hash-mismatch'), true);
    assert.equal(report.violations.some((row) => row.kind === 'forbidden-legacy-code'), true);
  });
});

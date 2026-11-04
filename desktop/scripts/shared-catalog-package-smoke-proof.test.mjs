import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../local-api/src/db/database.js';
import { createSharedCatalogService } from '../../local-api/src/domain/catalog/sharedCatalogService.js';
import {
  PACKAGED_SHARED_CATALOG_EXPECTATION,
  assertPackagedSharedCatalogUnchanged,
  verifyPackagedSharedCatalog,
} from './shared-catalog-package-smoke-proof.mjs';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptsRoot, '..');

test('SQLite-only proof accepts the actual local-api packaged seed and survives shop deletion', () => {
  const database = new DatabaseSync(':memory:');
  try {
    runMigrations(database);
    database.exec('PRAGMA foreign_keys = ON');
    createSharedCatalogService(database).seedFromPackagedJson({
      platform: 'ozon',
      marketplace: 'ozon',
      locale: 'ZH_HANS',
      contractVersion: 'ozon-description-category-v1',
    });

    const baseline = verifyPackagedSharedCatalog(database, { phase: 'unit-first-launch' });
    assert.equal(baseline.nodeCount, PACKAGED_SHARED_CATALOG_EXPECTATION.nodeCount);
    assert.equal(baseline.contentHash, PACKAGED_SHARED_CATALOG_EXPECTATION.contentHash);
    assert.equal(baseline.nodeSetHash, PACKAGED_SHARED_CATALOG_EXPECTATION.nodeSetHash);
    assert.equal(baseline.quarantineCount, 0);

    database.prepare(`
      INSERT INTO shops (
        id, name, alias, client_id, api_key_encrypted, status,
        created_at, updated_at, profile_id, external_identity_hash,
        shop_incarnation, credential_revision, bound_at, disabled_at
      ) VALUES (?, ?, ?, NULL, NULL, 'inactive', ?, ?, ?, NULL, ?, 1, ?, NULL)
    `).run(
      'shared-catalog-smoke-deletion-shop',
      'Shared catalog smoke deletion shop',
      'Shared catalog smoke',
      '2026-07-16T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
      'shared-catalog-smoke-profile',
      'inc_shared_catalog_smoke',
      '2026-07-16T00:00:00.000Z',
    );
    assert.equal(
      Number(database.prepare('DELETE FROM shops WHERE id = ?').run(
        'shared-catalog-smoke-deletion-shop',
      ).changes),
      1,
    );
    const afterShopDeletion = verifyPackagedSharedCatalog(database, {
      phase: 'unit-after-shop-deletion',
    });
    assertPackagedSharedCatalogUnchanged(baseline, afterShopDeletion, {
      phase: 'unit-after-shop-deletion',
    });

    database.prepare(`
      UPDATE shared_catalog_versions SET content_hash = ? WHERE catalog_id = ?
    `).run('0'.repeat(64), baseline.catalogId);
    assert.throws(
      () => verifyPackagedSharedCatalog(database, { phase: 'unit-drift' }),
      /节点数量或哈希不符合内置 seed 合同/u,
    );
  } finally {
    database.close();
  }
});

test('package smoke statically wires first-launch, cache-clear, and shop-deletion proof for every artifact mode', async () => {
  const [smokeSource, proofSource, packageConfigText] = await Promise.all([
    readFile(path.join(scriptsRoot, 'smoke-package.mjs'), 'utf8'),
    readFile(path.join(scriptsRoot, 'shared-catalog-package-smoke-proof.mjs'), 'utf8'),
    readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
  ]);
  const packageConfig = JSON.parse(packageConfigText);

  assert.doesNotMatch(proofSource, /from\s+['"][^'"]+\.json['"]/u);
  assert.doesNotMatch(proofSource, /frontend[\\/]/iu);
  assert.match(smokeSource, /phase:\s*'新 Profile 首启后'/u);
  assert.match(smokeSource, /phase:\s*'普通清缓存后'/u);
  assert.match(smokeSource, /phase:\s*'删除烟测测试店后'/u);
  assert.match(smokeSource, /DELETE FROM shops WHERE id = \?/u);
  assert.match(smokeSource, /assertPackagedSharedCatalogUnchanged\(\s*sharedCatalogBaseline/u);

  const firstLaunchIndex = smokeSource.indexOf('const freshProfile = verifyFreshProfileDatabase()');
  const cacheClearIndex = smokeSource.indexOf('const cacheMaintenance = await runProfileCacheMaintenanceSmoke');
  const commonShopDeletionIndex = smokeSource.indexOf(
    'const smokeShopDeletion = deleteSmokeShopAndVerifySharedCatalog',
  );
  assert.ok(firstLaunchIndex >= 0 && firstLaunchIndex < cacheClearIndex);
  assert.ok(cacheClearIndex < commonShopDeletionIndex);
  assert.equal(
    packageConfig.scripts['smoke:installer'],
    'node scripts/smoke-package.mjs --installer',
  );
  assert.equal(
    packageConfig.scripts['smoke:portable'],
    'node scripts/smoke-package.mjs --portable',
  );
});

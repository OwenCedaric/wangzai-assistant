import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRecoveryExporter } from '../../local-api/src/backup/recoveryExporter.js';
import { createRecoveryStorageAdapter } from '../../local-api/src/backup/recoveryStorageAdapter.js';
import { createShopIdentityRepository } from '../../local-api/src/db/repositories/shopIdentityRepository.js';
import { createShopDatabaseManager } from '../../local-api/src/db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../../local-api/src/db/shopDatabaseRouter.js';
import { createShopDomainStorageResolver } from '../../local-api/src/db/shopDomainStorageResolver.js';
import { resolveDataLayout } from '../src/runtime/dataLayout.js';
import { validatePerformanceFixtureSize } from './performanceFixture.mjs';

function plainPath(file, directory = false) {
  const metadata = fs.lstatSync(file);
  assert.ok(!metadata.isSymbolicLink() && (directory ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1), 'PERFORMANCE_RECOVERY_LINKED_INPUT');
}

// Only consume a newly seeded managed fixture manifest, never an arbitrary DB/profile path.
export function runFixtureRecoveryExport({ fixtureManifest, rounds = 1 } = {}) {
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 10, 'PERFORMANCE_RECOVERY_ROUNDS_INVALID');
  const manifestPath = path.resolve(fixtureManifest || '');
  const owned = path.dirname(manifestPath);
  assert.match(owned, /[\\/]\.managed-dev-scratch[\\/]run-[a-f0-9-]+[\\/]work$/u);
  for (let current = owned; current !== path.dirname(current); current = path.dirname(current)) plainPath(current, true);
  plainPath(manifestPath);
  assert.ok(fs.statSync(manifestPath).size < 128000, 'PERFORMANCE_RECOVERY_MANIFEST_SIZE');
  const fixture = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validatePerformanceFixtureSize(fixture);
  assert.equal(fixture.reopened, true, 'PERFORMANCE_RECOVERY_REOPEN_RECEIPT_REQUIRED');
  assert.equal(path.dirname(path.resolve(fixture.dataRoot)), owned, 'PERFORMANCE_RECOVERY_PROFILE_OUTSIDE_LEASE');
  const layout = resolveDataLayout({ dataRoot: fixture.dataRoot });
  assert.equal(fixture.databasePath, layout.databasePath, 'PERFORMANCE_RECOVERY_DATABASE_PATH_MISMATCH');
  plainPath(layout.dataRoot, true); plainPath(layout.localApiDataRoot, true); plainPath(layout.databasePath);
  const profile = JSON.parse(fs.readFileSync(layout.profilePath, 'utf8'));
  assert.equal(profile.profileId, fixture.profileId, 'PERFORMANCE_RECOVERY_PROFILE_MISMATCH');
  const db = new DatabaseSync(layout.databasePath, { readOnly: true });
  const opened = [];
  try {
    // The writable shop repository performs owner backfill on construction. A read-only
    // workload uses its existing identity repository without repairing or decrypting anything.
    const shopRepository = { profileId: profile.profileId,
      identityRepository: createShopIdentityRepository(db, { profileId: profile.profileId, skipBackfill: true }),
      getPublicShopById(shopId) {
        return db.prepare('SELECT id, name, alias FROM shops WHERE id = ? AND profile_id = ? AND user_id = ?')
          .get(shopId, profile.profileId, profile.profileId) || null;
      },
    };
    const manager = createShopDatabaseManager({ root: layout.shopDatabaseRoot, profileId: profile.profileId });
    const router = createShopDatabaseRouter({ shopRepository, shopDatabaseManager: manager });
    const sessions = new Map();
    for (const receipt of fixture.shopReceipts || []) {
      const route = router.resolve(receipt.shopId, { expectedScopeToken: receipt.route.scopeToken });
      assert.equal(route.databasePath, receipt.route.databasePath, 'PERFORMANCE_RECOVERY_ROUTE_MISMATCH');
      for (let current = path.dirname(route.databasePath); current !== layout.localApiDataRoot; current = path.dirname(current)) plainPath(current, true);
      plainPath(route.databasePath);
      const source = new DatabaseSync(route.databasePath, { readOnly: true });
      opened.push(source);
      const metadata = source.prepare('SELECT * FROM shop_database_metadata WHERE singleton = 1').get();
      assert.equal(metadata.profile_id, profile.profileId); assert.equal(metadata.shop_id, receipt.shopId);
      assert.equal(metadata.shop_incarnation, route.shopIncarnation); assert.equal(metadata.scope_digest, route.scopeDigest);
      assert.equal(source.prepare('SELECT COUNT(*) AS n FROM ozon_products WHERE shop_id = ?').get(receipt.shopId).n, receipt.products);
      assert.equal(source.prepare('SELECT COUNT(*) AS n FROM ozon_orders WHERE shop_id = ?').get(receipt.shopId).n, receipt.orders);
      assert.equal(source.prepare('SELECT write_mode FROM shop_product_storage_state WHERE singleton = 1').get().write_mode, 'direct');
      assert.equal(source.prepare('SELECT mode FROM shop_order_storage_state WHERE singleton = 1').get().mode, 'direct');
      sessions.set(receipt.shopId, { db: source, route });
    }
    assert.equal(sessions.size, fixture.shops, 'PERFORMANCE_RECOVERY_SHOP_COVERAGE');
    // Reuse the application's domain routing table, with validated read-only handles.
    const storage = { isDirectWriteShop: (id) => sessions.has(id), resolveDirectWriteSession({ shopId }) {
      assert.ok(sessions.has(shopId), 'PERFORMANCE_RECOVERY_EXACT_SHOP_REQUIRED'); return sessions.get(shopId);
    } };
    const adapter = createRecoveryStorageAdapter({ db, resolveShopDomainDatabase: createShopDomainStorageResolver({
      canonicalDb: db, shopProductStorage: storage, shopOrderStorage: storage,
    }) });
    const startedAt = performance.now();
    let totalCipherBytes = 0;
    let exportedRecords = 0;
    const encryptionKey = Buffer.alloc(32, 37);
    const dedupeKey = Buffer.alloc(32, 73);
    for (let index = 0; index < rounds; index += 1) {
      // Keep the original exporter workload (no new VACUUM/copy/restore work).
      // Pin a read transaction on each authority; these are individually consistent,
      // not an atomic multi-database snapshot and not a portable backup acceptance.
      const pinned = [];
      try {
        for (const source of [db, ...opened]) {
          source.exec('BEGIN'); pinned.push(source);
          source.prepare('SELECT COUNT(*) FROM sqlite_master').get();
        }
        const exporter = createRecoveryExporter({ db, resolveDomainDatabase: adapter.resolveDatabase });
        for (const shopId of sessions.keys()) {
          const candidate = exporter.buildShopCandidate({ shopId, encryptionKey, dedupeKey, aad: 'wangzai-performance-recovery-workload:v1' });
          assert.equal(candidate.ok, true);
          totalCipherBytes += candidate.totalCipherBytes;
          exportedRecords += candidate.domains.reduce((sum, domain) => sum + (domain.recordCount || 0), 0);
        }
      } finally { for (const source of pinned.reverse()) source.exec('ROLLBACK'); }
    }
    // Core recovery intentionally excludes replaceable Ozon cache rows. Report zero honestly;
    // a snapshot workload is not proof of a complete product/order portable backup.
    return { ok: true, workload: 'recovery-export', rounds, shops: fixture.shops, authoritativeDatabases: 1 + sessions.size,
      meaningfulExport: totalCipherBytes > 0 && exportedRecords > 0, crossDatabaseAtomicSnapshot: false,
      totalCipherBytes, exportedRecords, cacheRowsAreNotBackupAcceptance: true, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 };
  } finally { for (const source of opened) source.close(); db.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !/^--(?:fixture-manifest|rounds)=.+$/u.test(arg))) throw new Error('PERFORMANCE_RECOVERY_ARGUMENT_INVALID');
  const value = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  console.log(JSON.stringify(runFixtureRecoveryExport({ fixtureManifest: value('fixture-manifest', ''), rounds: Number(value('rounds', '1')) })));
}

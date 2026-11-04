import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createShopCacheCompatibilityStore } from '../cache/shopCacheCompatibilityStore.js';
import { createShopAggregateIndex } from './shopAggregateIndex.js';
import { createShopDatabaseLifecycle } from './shopDatabaseLifecycle.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-shop-lifecycle-'));
  const manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: 'profile-a' });
  const index = createShopAggregateIndex({
    databasePath: path.join(root, 'shop-aggregate-index.sqlite'),
    profileId: 'profile-a',
  });
  const store = createShopCacheCompatibilityStore({
    shopDatabaseManager: manager,
    onCommitted: (contract) => index.record(contract),
  });
  const lifecycle = createShopDatabaseLifecycle({
    shopDatabaseManager: manager,
    shopAggregateIndex: index,
    backupRoot: path.join(root, 'backups'),
    now: () => new Date('2026-09-03T12:00:00.000Z'),
  });
  const scopeA = { profileId: 'profile-a', shopId: 'shop-a', shopIncarnation: 'inc-a' };
  const scopeB = { profileId: 'profile-a', shopId: 'shop-b', shopIncarnation: 'inc-b' };
  const close = () => {
    manager.closeAll();
    index.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, manager, index, store, lifecycle, scopeA, scopeB, close };
}

test('delete-with-backup removes only one shop and restore recovers its exact cache', async () => {
  const f = fixture();
  const sharedFile = path.join(f.root, 'shared-collection.json');
  writeFileSync(sharedFile, '{"collection":["shared"]}\n', 'utf8');
  const query = { page: 1, pageSize: 20 };
  const payloadA = { ok: true, rows: [{ orderId: 'a', amount: 0 }] };
  const payloadB = { ok: true, rows: [{ orderId: 'b', amount: 88 }] };
  try {
    f.store.commit({ scopeToken: f.scopeA, domain: 'orders', query, payload: payloadA });
    f.store.commit({ scopeToken: f.scopeB, domain: 'orders', query, payload: payloadB });
    const layoutA = f.manager.resolve(f.scopeA);
    const layoutB = f.manager.resolve(f.scopeB);
    assert.equal(existsSync(layoutA.scopeDirectory), true);
    assert.equal(existsSync(layoutB.scopeDirectory), true);
    const preview = await f.lifecycle.preview(f.scopeA);
    const deletion = await f.lifecycle.deleteWithBackup({
      scopeToken: f.scopeA,
      expectedFingerprint: preview.fingerprint,
    });
    assert.equal(deletion.deleted, true);
    assert.equal(existsSync(deletion.backup.backupPath), true);
    assert.equal(f.manager.has(f.scopeA), false);
    assert.equal(f.manager.has(f.scopeB), true);
    assert.equal(existsSync(layoutA.scopeDirectory), false);
    assert.equal(existsSync(layoutA.shopDirectory), false);
    assert.equal(existsSync(layoutB.scopeDirectory), true);
    assert.deepEqual(f.store.read({ scopeToken: f.scopeB, domain: 'orders', query }).payload, payloadB);
    assert.equal(readFileSync(sharedFile, 'utf8'), '{"collection":["shared"]}\n');
    assert.equal(f.index.list({ shopId: 'shop-a' }).length, 0);
    assert.equal(f.index.list({ shopId: 'shop-b' }).length, 1);

    const restored = await f.lifecycle.restoreFromBackup({
      scopeToken: f.scopeA,
      backupPath: deletion.backup.backupPath,
      backupSha256: deletion.backup.backupSha256,
    });
    assert.equal(restored.restored, true);
    assert.equal(existsSync(layoutA.shopIdentityPath), true);
    assert.equal(existsSync(layoutA.scopeIdentityPath), true);
    assert.deepEqual(f.store.read({ scopeToken: f.scopeA, domain: 'orders', query }).payload, payloadA);
    assert.equal(f.index.list({ shopId: 'shop-a' }).length, 1);
  } finally {
    f.close();
  }
});

test('stale preview blocks deletion and leaves the current shop database intact', async () => {
  const f = fixture();
  try {
    f.store.commit({ scopeToken: f.scopeA, domain: 'products', query: { page: 1 }, payload: { ok: true, rows: [1] } });
    const preview = await f.lifecycle.preview(f.scopeA);
    f.store.commit({ scopeToken: f.scopeA, domain: 'products', query: { page: 1 }, payload: { ok: true, rows: [1, 2] } });
    await assert.rejects(
      f.lifecycle.deleteWithBackup({ scopeToken: f.scopeA, expectedFingerprint: preview.fingerprint }),
      { code: 'SHOP_DATABASE_PREVIEW_STALE' },
    );
    assert.equal(f.manager.has(f.scopeA), true);
    assert.deepEqual(f.store.read({ scopeToken: f.scopeA, domain: 'products', query: { page: 1 } }).payload.rows, [1, 2]);
  } finally {
    f.close();
  }
});

test('restore rejects a tampered backup and a backup from another shop', async () => {
  const f = fixture();
  try {
    f.store.commit({ scopeToken: f.scopeA, domain: 'orders', query: {}, payload: { ok: true, rows: [] } });
    const deletion = await f.lifecycle.deleteWithBackup({ scopeToken: f.scopeA });
    const scopeC = { profileId: 'profile-a', shopId: 'shop-c', shopIncarnation: 'inc-c' };
    await assert.rejects(
      f.lifecycle.restoreFromBackup({
        scopeToken: scopeC,
        backupPath: deletion.backup.backupPath,
        backupSha256: deletion.backup.backupSha256,
      }),
      { code: 'SHOP_DATABASE_BACKUP_SCOPE_MISMATCH' },
    );
    appendFileSync(deletion.backup.backupPath, 'tampered', 'utf8');
    await assert.rejects(
      f.lifecycle.restoreFromBackup({
        scopeToken: f.scopeA,
        backupPath: deletion.backup.backupPath,
        backupSha256: deletion.backup.backupSha256,
      }),
      { code: 'SHOP_DATABASE_BACKUP_HASH_MISMATCH' },
    );
    assert.equal(f.manager.has(f.scopeA), false);
  } finally {
    f.close();
  }
});

test('rebuild-empty keeps a verified rollback backup and creates only the exact shop database', async () => {
  const f = fixture();
  try {
    f.store.commit({ scopeToken: f.scopeA, domain: 'finance', query: {}, payload: { ok: true, total: 1 } });
    f.store.commit({ scopeToken: f.scopeB, domain: 'finance', query: {}, payload: { ok: true, total: 2 } });
    const result = await f.lifecycle.rebuildEmpty({ scopeToken: f.scopeA });
    assert.equal(result.rebuilt, true);
    assert.equal(existsSync(result.backup.backupPath), true);
    assert.equal(f.manager.has(f.scopeA), true);
    assert.equal(f.manager.has(f.scopeB), true);
    assert.equal(f.index.list({ shopId: 'shop-a' }).length, 0);
    assert.equal(f.index.list({ shopId: 'shop-b' }).length, 1);
  } finally {
    f.close();
  }
});

test('delete does not start when its durable backup receipt cannot be persisted', async () => {
  const f = fixture();
  try {
    f.store.commit({ scopeToken: f.scopeA, domain: 'orders', query: {}, payload: { ok: true, rows: [1] } });
    await assert.rejects(
      f.lifecycle.deleteWithBackup({
        scopeToken: f.scopeA,
        onBackup() {
          throw new Error('simulated receipt persistence failure');
        },
      }),
      /receipt persistence failure/u,
    );
    assert.equal(f.manager.has(f.scopeA), true);
    assert.deepEqual(f.store.read({ scopeToken: f.scopeA, domain: 'orders', query: {} }).payload.rows, [1]);
  } finally {
    f.close();
  }
});

test('account-removal observations read back the exact database and aggregate-index scope', async () => {
  const f = fixture();
  const owner = { ownerType: 'ozon_shop', ownerId: 'shop-a' };
  try {
    assert.equal(f.lifecycle.observeResource({
      owner,
      scopeToken: f.scopeA,
      resourceId: 'filesystem:shop-database-scope',
    }).state, 'absent');
    f.store.commit({ scopeToken: f.scopeA, domain: 'orders', query: { page: 1 }, payload: { ok: true, rows: [1] } });
    f.store.commit({ scopeToken: f.scopeB, domain: 'orders', query: { page: 1 }, payload: { ok: true, rows: [2] } });
    const database = f.lifecycle.observeResource({
      owner,
      scopeToken: f.scopeA,
      resourceId: 'filesystem:shop-database-scope',
    });
    const aggregate = f.lifecycle.observeResource({
      owner,
      scopeToken: f.scopeA,
      resourceId: 'filesystem:shop-aggregate-index-scope',
    });
    assert.equal(database.state, 'observed');
    assert.equal(database.count, 1);
    assert.equal(aggregate.state, 'observed');
    assert.equal(aggregate.count, 1);
    assert.match(database.hash, /^[a-f0-9]{64}$/u);
    assert.match(aggregate.hash, /^[a-f0-9]{64}$/u);

    await f.lifecycle.deleteWithBackup({ scopeToken: f.scopeA });
    assert.equal(f.lifecycle.observeResource({ owner, scopeToken: f.scopeA, resourceId: 'filesystem:shop-database-scope' }).state, 'absent');
    assert.equal(f.lifecycle.observeResource({ owner, scopeToken: f.scopeA, resourceId: 'filesystem:shop-aggregate-index-scope' }).state, 'absent');
    assert.equal(f.manager.has(f.scopeB), true);
    assert.equal(f.index.list({ shopId: 'shop-b' }).length, 1);
  } finally {
    f.close();
  }
});

test('scope reconciliation finds and repairs every missing aggregate-index row', async () => {
  const f = fixture();
  try {
    f.store.commit({ scopeToken: f.scopeA, domain: 'orders', query: { page: 1 }, payload: { ok: true, total: 1 } });
    f.store.commit({ scopeToken: f.scopeA, domain: 'products', query: { page: 1 }, payload: { ok: true, total: 2 } });
    f.store.commit({ scopeToken: f.scopeB, domain: 'orders', query: { page: 1 }, payload: { ok: true, total: 3 } });
    f.index.removeScope(f.manager.resolve(f.scopeA));

    const mismatch = f.lifecycle.reconcileScope(f.scopeA);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.before.expected, 2);
    assert.equal(mismatch.before.actual, 0);
    assert.equal(mismatch.before.missing.length, 2);

    const repaired = f.lifecycle.reconcileScope(f.scopeA, { repair: true });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.after.expected, 2);
    assert.equal(repaired.after.actual, 2);
    assert.equal(f.index.list({ shopId: 'shop-b' }).length, 1);
  } finally {
    f.close();
  }
});

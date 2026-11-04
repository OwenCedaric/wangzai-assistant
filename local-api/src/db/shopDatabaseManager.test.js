import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createShopDatabaseManager,
  openShopDatabase,
  resolveShopDatabaseLayout,
} from './shopDatabaseManager.js';

test('unchanged reads retain identity documents while renamed, missing or damaged documents are repaired', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-identity-stable-'));
  const manager = createShopDatabaseManager({ root, profileId: 'identity-test' });
  try {
    const scope = { shopId: 'a', shopIncarnation: 'generation-1' };
    const identity = { displayName: 'Shop A', alias: 'A店' };
    const handle = manager.ensure(scope, identity);
    const file = handle.layout.scopeIdentityPath;
    const before = await stat(file, { bigint: true });
    const contents = await readFile(file, 'utf8');
    for (let i = 0; i < 5; i++) manager.openExisting(scope, identity);
    const after = await stat(file, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(await readFile(file, 'utf8'), contents);
    await writeFile(file, 'damaged');
    manager.ensure(scope, identity);
    assert.equal(await readFile(file, 'utf8'), contents);
    await rm(file);
    manager.ensure(scope, identity);
    assert.equal(await readFile(file, 'utf8'), contents);
    manager.ensure(scope, { ...identity, alias: '新简称' });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).shopAlias, '新简称');
  } finally { manager.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('shop database paths are deterministic, human-identifiable, and incarnation isolated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-db-layout-'));
  try {
    const base = { root, profileId: 'profile-a', shopId: '../shop-a', shopIncarnation: 'inc-1' };
    const first = resolveShopDatabaseLayout(base);
    const same = resolveShopDatabaseLayout(base);
    const otherShop = resolveShopDatabaseLayout({ ...base, shopId: 'shop-b' });
    const rebound = resolveShopDatabaseLayout({ ...base, shopIncarnation: 'inc-2' });
    assert.equal(first.databasePath, same.databasePath);
    assert.notEqual(first.databasePath, otherShop.databasePath);
    assert.notEqual(first.databasePath, rebound.databasePath);
    assert.equal(path.dirname(first.shopDirectory), path.resolve(root));
    assert.equal(path.dirname(first.scopeDirectory), first.shopDirectory);
    assert.equal(path.dirname(first.databasePath), first.scopeDirectory);
    assert.equal(path.basename(first.databasePath), 'shop-cache.sqlite');
    assert.match(path.basename(first.shopDirectory), /^shop-.*shop-a.*--[a-f0-9]{12}$/u);
    assert.match(path.basename(first.scopeDirectory), /^scope-[a-f0-9]{16}$/u);
    assert.equal(first.shopDirectory, rebound.shopDirectory);
    assert.notEqual(first.scopeDirectory, rebound.scopeDirectory);
    assert.notEqual(first.shopDirectory, otherShop.shopDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manager creates physically independent SQLite files for each shop incarnation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-db-manager-'));
  const manager = createShopDatabaseManager({
    root,
    profileId: 'profile-a',
    now: () => new Date('2026-09-03T10:00:00.000Z'),
  });
  try {
    const shopA = manager.ensure({ shopId: 'shop-a', shopIncarnation: 'inc-a' });
    const shopB = manager.ensure({ shopId: 'shop-b', shopIncarnation: 'inc-b' });
    assert.notEqual(shopA.layout.databasePath, shopB.layout.databasePath);
    shopA.db.exec('CREATE TABLE shop_fact (id TEXT PRIMARY KEY); INSERT INTO shop_fact VALUES (\'only-a\');');
    shopB.db.exec('CREATE TABLE shop_fact (id TEXT PRIMARY KEY); INSERT INTO shop_fact VALUES (\'only-b\');');
    assert.deepEqual(shopA.db.prepare('SELECT id FROM shop_fact').all().map((row) => row.id), ['only-a']);
    assert.deepEqual(shopB.db.prepare('SELECT id FROM shop_fact').all().map((row) => row.id), ['only-b']);
    assert.equal(manager.snapshot().openCount, 2);
    assert.equal(manager.close({ shopId: 'shop-a', shopIncarnation: 'inc-a' }), true);
    assert.equal(manager.snapshot().openCount, 1);
    const reopened = openShopDatabase({
      root,
      profileId: 'profile-a',
      shopId: 'shop-a',
      shopIncarnation: 'inc-a',
    });
    assert.deepEqual(reopened.db.prepare('SELECT id FROM shop_fact').all().map((row) => row.id), ['only-a']);
    reopened.db.close();
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('opening a missing or wrong-scope shop database fails closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-db-guard-'));
  try {
    assert.throws(() => openShopDatabase({
      root,
      profileId: 'profile-a',
      shopId: 'missing',
      shopIncarnation: 'inc-1',
    }), { code: 'SHOP_DATABASE_NOT_FOUND' });

    const expected = resolveShopDatabaseLayout({
      root,
      profileId: 'profile-a',
      shopId: 'shop-a',
      shopIncarnation: 'inc-1',
    });
    const wrong = openShopDatabase({
      root,
      profileId: 'profile-a',
      shopId: 'shop-b',
      shopIncarnation: 'inc-1',
      create: true,
    });
    wrong.db.close();
    await mkdir(path.dirname(expected.databasePath), { recursive: true });
    await writeFile(expected.databasePath, await readFile(wrong.layout.databasePath));
    assert.throws(() => openShopDatabase({
      root,
      profileId: 'profile-a',
      shopId: 'shop-a',
      shopIncarnation: 'inc-1',
    }), { code: 'SHOP_DATABASE_SCOPE_MISMATCH' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shop metadata cannot be silently rewritten for another owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-db-metadata-'));
  try {
    const created = openShopDatabase({
      root,
      profileId: 'profile-a',
      shopId: 'shop-a',
      shopIncarnation: 'inc-a',
      create: true,
    });
    const databasePath = created.layout.databasePath;
    created.db.close();
    const tamper = new DatabaseSync(databasePath);
    tamper.prepare('UPDATE shop_database_metadata SET shop_id = ? WHERE singleton = 1').run('shop-z');
    tamper.close();
    assert.throws(() => openShopDatabase({
      root,
      profileId: 'profile-a',
      shopId: 'shop-a',
      shopIncarnation: 'inc-a',
    }), { code: 'SHOP_DATABASE_SCOPE_MISMATCH' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manager can inspect and reopen an existing shop database without creating a missing one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-db-existing-'));
  const scopeToken = { shopId: 'shop-a', shopIncarnation: 'inc-a' };
  const manager = createShopDatabaseManager({ root, profileId: 'profile-a' });
  try {
    assert.equal(manager.has(scopeToken), false);
    assert.equal(manager.get(scopeToken), null);
    assert.throws(() => manager.openExisting(scopeToken), { code: 'SHOP_DATABASE_NOT_FOUND' });
    const created = manager.ensure(scopeToken);
    assert.equal(manager.has(scopeToken), true);
    assert.equal(manager.get(scopeToken), created);
    assert.equal(manager.close(scopeToken), true);
    const reopened = manager.openExisting(scopeToken);
    assert.equal(reopened.metadata.shopId, 'shop-a');
    assert.equal(reopened.created, false);
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('manager writes a readable non-secret identity document and preserves display names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-db-identity-'));
  const manager = createShopDatabaseManager({
    root,
    profileId: 'profile-a',
    now: () => new Date('2026-09-03T10:00:00.000Z'),
  });
  const scopeToken = { shopId: 'ozon-shop-1001', shopIncarnation: 'inc-a' };
  try {
    const handle = manager.ensure(scopeToken, {
      displayName: 'Super Shop',
      alias: 'Ozon 1店',
      apiKey: 'must-never-be-written',
    });
    const shopInfo = JSON.parse(await readFile(handle.layout.shopIdentityPath, 'utf8'));
    const scopeInfo = JSON.parse(await readFile(handle.layout.scopeIdentityPath, 'utf8'));
    assert.equal(shopInfo.displayLabel, 'Ozon 1店');
    assert.equal(shopInfo.shopName, 'Super Shop');
    assert.equal(shopInfo.shopAlias, 'Ozon 1店');
    assert.equal(scopeInfo.shopId, scopeToken.shopId);
    assert.equal(scopeInfo.shopIncarnation, scopeToken.shopIncarnation);
    assert.equal(scopeInfo.databaseFile, 'shop-cache.sqlite');
    assert.equal(JSON.stringify({ shopInfo, scopeInfo }).includes('must-never-be-written'), false);

    manager.ensure(scopeToken, { displayName: 'Super Shop', alias: '' });
    const clearedAlias = JSON.parse(await readFile(handle.layout.shopIdentityPath, 'utf8'));
    assert.equal(clearedAlias.shopAlias, '');
    assert.equal(clearedAlias.displayLabel, 'Super Shop');
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('manager migrates a verified flat v1 database into its v2 shop folder without losing rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-db-v1-migration-'));
  const scope = { profileId: 'profile-a', shopId: 'shop-a', shopIncarnation: 'inc-a' };
  const layout = resolveShopDatabaseLayout({ root, ...scope });
  const createdAt = '2026-09-03T09:00:00.000Z';
  const legacy = new DatabaseSync(layout.legacyDatabasePath);
  legacy.exec(`
    CREATE TABLE shop_database_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      layout_version INTEGER NOT NULL,
      profile_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      shop_incarnation TEXT NOT NULL,
      scope_digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE preserved_rows (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  legacy.prepare(`
    INSERT INTO shop_database_metadata (
      singleton, layout_version, profile_id, shop_id, shop_incarnation, scope_digest, created_at
    ) VALUES (1, 1, ?, ?, ?, ?, ?)
  `).run(scope.profileId, scope.shopId, scope.shopIncarnation, layout.scopeDigest, createdAt);
  legacy.prepare('INSERT INTO preserved_rows (id, value) VALUES (?, ?)').run('row-1', 'preserved');
  legacy.close();

  const manager = createShopDatabaseManager({ root, profileId: scope.profileId });
  try {
    assert.equal(manager.has(scope), true);
    assert.equal(existsSync(layout.legacyDatabasePath), false);
    assert.equal(existsSync(path.join(layout.migrationBackupDirectory, 'legacy-shop-cache.sqlite')), true);
    const migrated = manager.openExisting(scope);
    assert.equal(migrated.db.prepare('SELECT layout_version FROM shop_database_metadata').get().layout_version, 2);
    const preserved = migrated.db.prepare('SELECT * FROM preserved_rows').get();
    assert.equal(preserved.id, 'row-1');
    assert.equal(preserved.value, 'preserved');
    assert.equal(manager.snapshot().migration.migrated, 1);
  } finally {
    manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

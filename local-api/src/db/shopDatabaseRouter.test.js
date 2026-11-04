import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopRepository } from './repositories/shopRepository.js';

async function createFixture() {
  const databaseRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-router-'));
  const db = createMigratedTestDb();
  let incarnation = 0;
  const shops = createShopRepository(db, {
    profileId: 'profile-router',
    createIncarnation: () => `inc-router-${++incarnation}`,
  });
  const manager = createShopDatabaseManager({
    root: databaseRoot,
    profileId: shops.profileId,
  });
  const router = createShopDatabaseRouter({
    shopRepository: shops,
    shopDatabaseManager: manager,
  });
  return {
    db,
    databaseRoot,
    shops,
    manager,
    router,
    async close() {
      manager.closeAll();
      db.close();
      await rm(databaseRoot, { recursive: true, force: true });
    },
  };
}

function saveActiveShop(shops, id, name) {
  return shops.saveShop({
    id,
    name,
    alias: `${name} alias`,
    clientId: `client-${id}`,
    apiKey: `secret-${id}`,
    status: 'active',
  });
}

test('router creates and reuses the exact current database for one canonical shop id', async () => {
  const fixture = await createFixture();
  try {
    const binding = saveActiveShop(fixture.shops, 'shop-a', 'Shop A');
    const first = fixture.router.open('shop-a');
    const second = fixture.router.open('shop-a');

    assert.equal(first.route.shopId, 'shop-a');
    assert.equal(first.route.profileId, fixture.shops.profileId);
    assert.equal(first.route.shopIncarnation, binding.scopeToken.shopIncarnation);
    assert.equal(first.route.credentialRevision, binding.scopeToken.credentialRevision);
    assert.equal(first.db, second.db);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(fixture.router.has('shop-a'), true);
    assert.equal(JSON.stringify(first.route).includes('secret-shop-a'), false);
  } finally {
    await fixture.close();
  }
});

test('router inspect mode never creates a missing database', async () => {
  const fixture = await createFixture();
  try {
    saveActiveShop(fixture.shops, 'shop-inspect', 'Inspect Shop');
    assert.equal(fixture.router.has('shop-inspect'), false);
    assert.throws(
      () => fixture.router.open('shop-inspect', { createIfMissing: false }),
      (error) => error?.code === 'SHOP_DATABASE_NOT_FOUND',
    );
    assert.equal(fixture.router.has('shop-inspect'), false);
    assert.equal(fixture.manager.snapshot().physical.databases, 0);
  } finally {
    await fixture.close();
  }
});

test('router keeps shop databases physically isolated and never accepts an aggregate id', async () => {
  const fixture = await createFixture();
  try {
    saveActiveShop(fixture.shops, 'shop-a', 'Shop A');
    saveActiveShop(fixture.shops, 'shop-b', 'Shop B');
    const shopA = fixture.router.open('shop-a');
    const shopB = fixture.router.open('shop-b');

    assert.notEqual(shopA.route.databasePath, shopB.route.databasePath);
    assert.notEqual(shopA.route.shopDirectory, shopB.route.shopDirectory);
    shopA.db.exec("CREATE TABLE isolated_fact (id TEXT PRIMARY KEY); INSERT INTO isolated_fact VALUES ('only-a');");
    shopB.db.exec("CREATE TABLE isolated_fact (id TEXT PRIMARY KEY); INSERT INTO isolated_fact VALUES ('only-b');");
    assert.deepEqual(shopA.db.prepare('SELECT id FROM isolated_fact').all().map((row) => row.id), ['only-a']);
    assert.deepEqual(shopB.db.prepare('SELECT id FROM isolated_fact').all().map((row) => row.id), ['only-b']);

    for (const invalid of ['', 'all', '*', 'shop-a,shop-b', 'shop-a，shop-b']) {
      assert.throws(
        () => fixture.router.open(invalid),
        (error) => ['SHOP_DATABASE_ROUTE_SHOP_ID_INVALID', 'SHOP_DATABASE_ROUTE_AGGREGATE_FORBIDDEN'].includes(error?.code),
      );
    }
  } finally {
    await fixture.close();
  }
});

test('router follows rebind incarnation and rejects disabled or missing shops', async () => {
  const fixture = await createFixture();
  try {
    const firstBinding = saveActiveShop(fixture.shops, 'shop-rebind', 'Rebind Shop');
    const firstRoute = fixture.router.open('shop-rebind').route;
    fixture.shops.saveShop({ id: 'shop-rebind', name: 'Rebind Shop', status: 'disabled' });
    assert.throws(
      () => fixture.router.open('shop-rebind'),
      (error) => error?.code === 'SHOP_BINDING_DISABLED',
    );

    const rebound = fixture.shops.rebindShop({
      id: 'shop-rebind',
      name: 'Rebind Shop',
      clientId: 'client-shop-rebind',
      apiKey: 'secret-shop-rebind',
    });
    const reboundRoute = fixture.router.open('shop-rebind').route;
    assert.equal(firstRoute.shopIncarnation, firstBinding.scopeToken.shopIncarnation);
    assert.equal(reboundRoute.shopIncarnation, rebound.scopeToken.shopIncarnation);
    assert.notEqual(reboundRoute.scopeDirectory, firstRoute.scopeDirectory);
    assert.throws(
      () => fixture.router.open('shop-rebind', { expectedScopeToken: firstBinding.scopeToken }),
      (error) => error?.code === 'SHOP_INCARNATION_STALE',
    );
    assert.throws(
      () => fixture.router.open('shop-rebind', {
        expectedScopeToken: { ...rebound.scopeToken, shopId: 'another-shop' },
      }),
      (error) => error?.code === 'SHOP_DATABASE_ROUTE_EXPECTED_SCOPE_MISMATCH',
    );
    assert.throws(
      () => fixture.router.open('missing-shop'),
      (error) => error?.code === 'SHOP_SCOPE_NOT_FOUND',
    );
  } finally {
    await fixture.close();
  }
});

test('router fails closed if a manager returns another shop handle', async () => {
  const db = createMigratedTestDb();
  const shops = createShopRepository(db, { profileId: 'profile-router-readback' });
  saveActiveShop(shops, 'shop-a', 'Shop A');
  const scopeToken = shops.identityRepository.createScopeToken('shop-a', shops.profileId);
  const layout = {
    profileId: shops.profileId,
    shopId: scopeToken.shopId,
    shopIncarnation: scopeToken.shopIncarnation,
    scopeDigest: 'expected-scope',
    databasePath: 'expected.sqlite',
    shopDirectory: 'expected-shop',
    scopeDirectory: 'expected-scope-directory',
  };
  const router = createShopDatabaseRouter({
    shopRepository: shops,
    shopDatabaseManager: {
      resolve: () => layout,
      has: () => true,
      openExisting: () => null,
      ensure: () => ({
        db: {},
        layout: { ...layout, shopId: 'shop-b' },
        metadata: { ...layout, shopId: 'shop-b' },
      }),
    },
  });
  try {
    assert.throws(
      () => router.open('shop-a'),
      (error) => error?.code === 'SHOP_DATABASE_ROUTE_READBACK_MISMATCH',
    );
    assert.equal(router.snapshot().failures, 1);
  } finally {
    db.close();
  }
});

test('router preserves sync and async repository return values without owning business logic', async () => {
  const fixture = await createFixture();
  try {
    saveActiveShop(fixture.shops, 'shop-callback', 'Callback Shop');
    const syncResult = fixture.router.withShopDatabase('shop-callback', ({ route }) => route.shopId);
    const asyncResult = await fixture.router.withShopDatabase(
      'shop-callback',
      async ({ route }) => ({ shopId: route.shopId, databasePath: route.databasePath }),
    );
    assert.equal(syncResult, 'shop-callback');
    assert.equal(asyncResult.shopId, 'shop-callback');
    assert.match(asyncResult.databasePath, /shop-cache\.sqlite$/u);
    assert.throws(
      () => fixture.router.withShopDatabase('shop-callback', null),
      (error) => error?.code === 'SHOP_DATABASE_ROUTE_CALLBACK_REQUIRED',
    );
  } finally {
    await fixture.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createShopRepository } from './shopRepository.js';

function deterministicRepository(db, profileId = 'profile-a') {
  let incarnation = 0;
  return createShopRepository(db, {
    profileId,
    now: () => new Date('2026-07-16T00:00:00.000Z'),
    createIncarnation: () => `incarnation-${profileId}-${++incarnation}`,
  });
}

test('shop binding has a profile scope, stable incarnation and monotonic credential revision', () => {
  const db = createMigratedTestDb();
  const shops = deterministicRepository(db);

  const created = shops.saveShop({
    id: 'shop-a',
    name: 'Shop A',
    clientId: 'OZON-CLIENT-A',
    apiKey: 'secret-a-v1',
    status: 'active',
  });
  assert.deepEqual(created.scopeToken, {
    profileId: 'profile-a',
    shopId: 'shop-a',
    shopIncarnation: 'incarnation-profile-a-1',
    credentialRevision: 1,
  });
  assert.equal(created.syncBootstrapRequired, true);

  const unchanged = shops.saveShop({
    id: 'shop-a',
    name: 'Renamed Shop A',
    clientId: 'OZON-CLIENT-A',
    apiKey: 'secret-a-v1',
    status: 'active',
  });
  assert.equal(unchanged.credentialsUpdated, false);
  assert.equal(unchanged.incarnationChanged, false);
  assert.equal(unchanged.scopeToken.shopIncarnation, created.scopeToken.shopIncarnation);
  assert.equal(unchanged.scopeToken.credentialRevision, 1);
  assert.equal(unchanged.syncBootstrapRequired, false);

  const rotated = shops.saveShop({
    id: 'shop-a',
    name: 'Renamed Shop A',
    apiKey: 'secret-a-v2',
    status: 'active',
  });
  assert.equal(rotated.credentialsUpdated, true);
  assert.equal(rotated.scopeToken.shopIncarnation, created.scopeToken.shopIncarnation);
  assert.equal(rotated.scopeToken.credentialRevision, 2);
  assert.equal(rotated.syncBootstrapRequired, true);

  assert.throws(
    () => shops.identityRepository.assertCurrentScopeToken(created.scopeToken),
    (error) => error?.code === 'SHOP_CREDENTIAL_REVISION_STALE',
  );
  assert.equal(shops.getShopCredentialsForInternalUse('shop-a').credentialRevision, 2);
  db.close();
});

test('disabled binding rejects tasks and explicit rebind creates a fresh incarnation', () => {
  const db = createMigratedTestDb();
  const shops = deterministicRepository(db);
  const created = shops.saveShop({
    id: 'shop-rebind',
    name: 'Rebind shop',
    clientId: 'client-rebind',
    apiKey: 'key-rebind',
    status: 'active',
  });

  const disabled = shops.saveShop({ id: 'shop-rebind', name: 'Rebind shop', status: 'disabled' });
  assert.ok(disabled.shop.disabledAt);
  assert.throws(
    () => shops.identityRepository.assertCurrentScopeToken(disabled.scopeToken),
    (error) => error?.code === 'SHOP_BINDING_DISABLED',
  );

  const rebound = shops.rebindShop({
    id: 'shop-rebind',
    name: 'Rebind shop',
    clientId: 'client-rebind',
    apiKey: 'key-rebind',
  });
  assert.equal(rebound.rebound, true);
  assert.notEqual(rebound.scopeToken.shopIncarnation, created.scopeToken.shopIncarnation);
  assert.equal(rebound.scopeToken.credentialRevision, 2);
  assert.equal(rebound.shop.disabledAt, null);
  assert.throws(
    () => shops.identityRepository.assertCurrentScopeToken(created.scopeToken),
    (error) => error?.code === 'SHOP_INCARNATION_STALE',
  );
  assert.equal(shops.identityRepository.assertCurrentScopeToken(rebound.scopeToken).shopId, 'shop-rebind');
  db.close();
});

test('external Ozon identity cannot be rebound twice inside one profile and profile queries stay isolated', () => {
  const db = createMigratedTestDb();
  const profileA = deterministicRepository(db, 'profile-a');
  const profileB = deterministicRepository(db, 'profile-b');
  profileA.saveShop({ id: 'shop-a', name: 'A', clientId: 'client-shared', apiKey: 'key-a', status: 'active' });

  assert.throws(
    () => profileA.saveShop({ id: 'shop-a-duplicate', name: 'A2', clientId: ' CLIENT-SHARED ', apiKey: 'key-a2', status: 'active' }),
    (error) => error?.code === 'SHOP_EXTERNAL_IDENTITY_ALREADY_BOUND',
  );

  profileB.saveShop({ id: 'shop-b', name: 'B', clientId: 'client-shared', apiKey: 'key-b', status: 'active' });
  assert.deepEqual(profileA.listShops().map((shop) => shop.id), ['shop-a']);
  assert.deepEqual(profileB.listShops().map((shop) => shop.id), ['shop-b']);
  assert.equal(profileA.getPublicShopById('shop-b'), null);
  assert.throws(
    () => profileA.saveShop({ id: 'shop-b', name: 'Wrong profile' }),
    (error) => error?.code === 'SHOP_SCOPE_FORBIDDEN',
  );
  db.close();
});

test('tenant and user scope keep same-profile shops separated and block cross-owner rebinding', () => {
  const db = createMigratedTestDb();
  const ownerA = createShopRepository(db, {
    profileId: 'shared-profile',
    tenantId: 'tenant-a',
    userId: 'user-a',
  });
  const ownerB = createShopRepository(db, {
    profileId: 'shared-profile',
    tenantId: 'tenant-b',
    userId: 'user-b',
  });
  ownerA.saveShop({ id: 'shop-owner-a', name: 'A', clientId: 'client-owner-a', apiKey: 'key-a', status: 'active' });
  ownerB.saveShop({ id: 'shop-owner-b', name: 'B', clientId: 'client-owner-b', apiKey: 'key-b', status: 'active' });

  assert.deepEqual(ownerA.listShops().map((shop) => shop.id), ['shop-owner-a']);
  assert.deepEqual(ownerB.listShops().map((shop) => shop.id), ['shop-owner-b']);
  assert.throws(
    () => ownerA.listShopsForContext({ tenantId: 'tenant-b', userId: 'user-b' }),
    (error) => error?.code === 'SHOP_SCOPE_FORBIDDEN',
  );
  assert.throws(
    () => ownerB.saveShop({ id: 'shop-owner-a', name: 'hijack' }),
    (error) => error?.code === 'SHOP_SCOPE_FORBIDDEN',
  );
  db.close();
});

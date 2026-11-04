import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopLifecycleRepository } from '../../db/repositories/shopLifecycleRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createShopIdentityLifecycleService } from './shopIdentityLifecycleService.js';

function createFixture(options = {}) {
  const db = createMigratedTestDb();
  let incarnationSequence = 0;
  let runSequence = 0;
  let tombstoneSequence = 0;
  let timeSequence = 0;
  const now = () => new Date(Date.parse('2026-07-16T00:00:00.000Z') + timeSequence++ * 1000);
  const shops = createShopRepository(db, {
    profileId: 'profile-lifecycle',
    now,
    createIncarnation: () => `inc-${++incarnationSequence}`,
  });
  const lifecycle = createShopLifecycleRepository(db, {
    profileId: 'profile-lifecycle',
    now,
    identityRepository: shops.identityRepository,
    createRunId: () => `bootstrap-${++runSequence}`,
    createTombstoneId: () => `tombstone-${++tombstoneSequence}`,
  });
  const shopDatabaseCalls = [];
  const shopDatabaseIdentityCalls = [];
  const newShopDatabaseCalls = [];
  const initialShop = options.initialShop ? shops.saveShop(options.initialShop) : null;
  const shopDatabaseManager = options.shopDatabaseManager || {
    ensure(scopeToken, displayIdentity) {
      shopDatabaseCalls.push({ action: 'ensure', scopeToken: { ...scopeToken } });
      shopDatabaseIdentityCalls.push({ ...displayIdentity });
    },
    close(scopeToken) {
      shopDatabaseCalls.push({ action: 'close', scopeToken: { ...scopeToken } });
      return true;
    },
  };
  const service = createShopIdentityLifecycleService({
    shopRepository: shops,
    lifecycleRepository: lifecycle,
    requiredDomains: ['products', 'orders'],
    shopDatabaseManager,
    onShopDatabaseError: options.onShopDatabaseError,
    onNewShopDatabaseProvisioned(input) {
      newShopDatabaseCalls.push(input);
      options.onNewShopDatabaseProvisioned?.(input);
    },
  });
  return { db, shops, lifecycle, service, shopDatabaseCalls, shopDatabaseIdentityCalls, newShopDatabaseCalls, initialShop };
}

test('existing active shops receive readable cache identity during service startup', () => {
  const fixture = createFixture({
    initialShop: {
      id: 'shop-existing',
      name: 'Existing Shop',
      alias: 'Ozon 1店',
      clientId: 'client-existing',
      apiKey: 'key-existing',
      status: 'active',
    },
  });
  assert.equal(fixture.shopDatabaseCalls.length, 1);
  assert.equal(fixture.shopDatabaseCalls[0].scopeToken.shopId, 'shop-existing');
  assert.deepEqual(fixture.shopDatabaseIdentityCalls, [{
    displayName: 'Existing Shop',
    alias: 'Ozon 1店',
  }]);
  fixture.db.close();
});

test('bootstrap activation rejects old credential revisions and only completes proven domain coverage', () => {
  const fixture = createFixture();
  const first = fixture.service.saveBinding({
    id: 'shop-lifecycle',
    name: 'Lifecycle shop',
    clientId: 'client-lifecycle',
    apiKey: 'key-v1',
    status: 'active',
  });
  assert.equal(first.bootstrapRun.reason, 'initial_bind');
  assert.equal(first.bootstrapRun.status, 'queued');
  assert.equal(first.bindingReady, false);
  assert.equal(fixture.newShopDatabaseCalls.length, 1);
  assert.equal(fixture.newShopDatabaseCalls[0].scopeToken.shopId, 'shop-lifecycle');
  assert.deepEqual(fixture.shopDatabaseCalls, [{
    action: 'ensure',
    scopeToken: first.scopeToken,
  }]);

  const rotated = fixture.service.saveBinding({
    id: 'shop-lifecycle',
    name: 'Lifecycle shop',
    apiKey: 'key-v2',
    status: 'active',
  });
  assert.equal(rotated.bootstrapRun.reason, 'credential_rotation');
  assert.equal(fixture.newShopDatabaseCalls.length, 1);
  assert.equal(rotated.scopeToken.credentialRevision, 2);
  assert.equal(fixture.shopDatabaseCalls.at(-1).action, 'ensure');
  assert.equal(fixture.shopDatabaseCalls.at(-1).scopeToken.shopIncarnation, first.scopeToken.shopIncarnation);
  assert.equal(fixture.lifecycle.getBootstrapRun(first.bootstrapRun.runId).status, 'invalid');
  assert.throws(
    () => fixture.service.activateBootstrap(first.bootstrapRun.runId, first.scopeToken),
    (error) => error?.code === 'SHOP_CREDENTIAL_REVISION_STALE',
  );

  assert.equal(
    fixture.service.activateBootstrap(rotated.bootstrapRun.runId, rotated.scopeToken).status,
    'running',
  );
  fixture.service.recordBootstrapDomain({
    runId: rotated.bootstrapRun.runId,
    scopeToken: rotated.scopeToken,
    domain: 'products',
    status: 'completed',
    proofHash: 'a'.repeat(64),
    activeSnapshotId: 'product-snapshot-1',
  });
  fixture.service.beginBootstrapVerification(rotated.bootstrapRun.runId, rotated.scopeToken);
  assert.throws(
    () => fixture.service.completeBootstrap({
      runId: rotated.bootstrapRun.runId,
      scopeToken: rotated.scopeToken,
      proofHash: 'c'.repeat(64),
    }),
    (error) => error?.code === 'SHOP_BOOTSTRAP_COVERAGE_INCOMPLETE',
  );
  fixture.service.recordBootstrapDomain({
    runId: rotated.bootstrapRun.runId,
    scopeToken: rotated.scopeToken,
    domain: 'orders',
    status: 'completed',
    proofHash: 'b'.repeat(64),
    activeSnapshotId: 'order-snapshot-1',
  });
  const completed = fixture.service.completeBootstrap({
    runId: rotated.bootstrapRun.runId,
    scopeToken: rotated.scopeToken,
    proofHash: 'c'.repeat(64),
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.completedDomains, ['orders', 'products']);
  assert.deepEqual(
    fixture.service.getBindingReadiness('shop-lifecycle'),
    {
      bindingReady: true,
      bindingStatus: 'completed',
      scopeToken: rotated.scopeToken,
      bootstrapRun: completed,
    },
  );
  fixture.db.close();
});

test('shadow shop database failure never changes the existing binding result', () => {
  const observed = [];
  const fixture = createFixture({
    shopDatabaseManager: {
      ensure() {
        const error = new Error('simulated shadow storage failure');
        error.code = 'SHOP_DATABASE_TEST_FAILURE';
        throw error;
      },
      close() {
        return false;
      },
    },
    onShopDatabaseError(error, context) {
      observed.push({ code: error.code, action: context.action });
    },
  });
  const saved = fixture.service.saveBinding({
    id: 'shop-shadow-failure',
    name: 'Shadow failure shop',
    clientId: 'client-shadow-failure',
    apiKey: 'key-shadow-failure',
    status: 'active',
  });
  assert.equal(saved.shop.id, 'shop-shadow-failure');
  assert.equal(saved.bootstrapRun.status, 'queued');
  assert.deepEqual(observed, [{ code: 'SHOP_DATABASE_TEST_FAILURE', action: 'provision' }]);
  fixture.db.close();
});

test('rebind fences the old incarnation and creates an independent full bootstrap', () => {
  const fixture = createFixture();
  const first = fixture.service.saveBinding({
    id: 'shop-rebind-service',
    name: 'Rebind service shop',
    clientId: 'client-rebind-service',
    apiKey: 'key-rebind-service',
    status: 'active',
  });
  fixture.service.disableBinding('shop-rebind-service');
  assert.deepEqual(fixture.shopDatabaseCalls.at(-1), {
    action: 'close',
    scopeToken: first.scopeToken,
  });
  assert.equal(fixture.service.getBindingReadiness('shop-rebind-service').bindingReady, false);
  assert.equal(fixture.service.getBindingReadiness('shop-rebind-service').bindingStatus, 'disabled');
  const rebound = fixture.service.rebind({
    id: 'shop-rebind-service',
    name: 'Rebind service shop',
    clientId: 'client-rebind-service',
    apiKey: 'key-rebind-service',
  });

  assert.equal(rebound.bootstrapRun.reason, 'rebind');
  assert.notEqual(rebound.scopeToken.shopIncarnation, first.scopeToken.shopIncarnation);
  assert.deepEqual(fixture.shopDatabaseCalls.slice(-2), [
    { action: 'close', scopeToken: first.scopeToken },
    { action: 'ensure', scopeToken: rebound.scopeToken },
  ]);
  assert.throws(
    () => fixture.service.assertTaskMayActivate(first.scopeToken),
    (error) => error?.code === 'SHOP_INCARNATION_STALE',
  );
  assert.equal(fixture.service.assertTaskMayActivate(rebound.scopeToken).shopId, 'shop-rebind-service');
  assert.equal(fixture.service.activateBootstrap(rebound.bootstrapRun.runId, rebound.scopeToken).status, 'running');
  fixture.db.close();
});

test('identity tombstone is idempotent, contains no credentials and survives shop-owned row cascade', () => {
  const fixture = createFixture();
  const binding = fixture.service.saveBinding({
    id: 'shop-delete-evidence',
    name: 'Delete evidence shop',
    clientId: 'client-delete-evidence',
    apiKey: 'key-delete-evidence',
    status: 'active',
  });
  const tombstone = fixture.lifecycle.createCurrentIdentityTombstone({
    shopId: binding.shop.id,
    deletionOperationId: 'delete-operation-1',
    metadata: { rowCount: 42, catalogPreserved: true },
  });
  assert.equal(tombstone.formerShopIncarnation, binding.scopeToken.shopIncarnation);
  assert.equal(tombstone.finalCredentialRevision, binding.scopeToken.credentialRevision);
  assert.equal(tombstone.metadata.catalogPreserved, true);
  assert.equal(
    fixture.lifecycle.createCurrentIdentityTombstone({
      shopId: binding.shop.id,
      deletionOperationId: 'delete-operation-1',
      metadata: { ignoredOnIdempotentReplay: true },
    }).tombstoneId,
    tombstone.tombstoneId,
  );
  assert.throws(
    () => fixture.lifecycle.createCurrentIdentityTombstone({
      shopId: binding.shop.id,
      deletionOperationId: 'delete-operation-2',
      metadata: { apiKey: 'must-never-be-stored' },
    }),
    (error) => error?.code === 'SHOP_TOMBSTONE_METADATA_SECRET_FORBIDDEN',
  );

  fixture.db.prepare('DELETE FROM shops WHERE id = ?').run(binding.shop.id);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS total FROM shop_bootstrap_runs').get().total, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS total FROM shop_domain_sync_state').get().total, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS total FROM shop_identity_tombstones').get().total, 1);
  assert.equal(
    fixture.lifecycle.findLatestTombstoneByExternalIdentity(tombstone.externalIdentityHash).formerShopId,
    binding.shop.id,
  );
  fixture.db.close();
});

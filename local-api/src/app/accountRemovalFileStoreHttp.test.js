import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createAccountRemovalOperationRepository } from '../db/repositories/accountRemovalOperationRepository.js';
import { createProductRepository } from '../db/repositories/productRepository.js';
import { createShopDatabaseManager } from '../db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../db/shopDatabaseRouter.js';
import { createShopDatabaseLifecycle } from '../db/shopDatabaseLifecycle.js';
import { createShopProductStorage } from '../db/shopProductStorage.js';
import { createShopOrderStorage } from '../db/shopOrderStorage.js';
import { createShopOperationalStorage } from '../db/shopOperationalStorage.js';
import { getAccountRemovalClientBarrierIds, isAccountRemovalServerVerifiedClientResource } from '../domain/accountRemoval/accountRemovalClientResources.js';
import { ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION } from '../domain/accountRemoval/accountRemovalContract.js';

test('file-backed direct shop deletion completes through HTTP with live read connections and preserves another shop', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-removal-file-http-'));
  const db = createMigratedTestDb(path.join(root, 'main.sqlite'));
  const shops = createShopRepository(db, { profileId: 'removal-file-http' });
  for (const id of ['a', 'b']) shops.saveShop({ id, name: `Synthetic ${id}`, status: 'active' });
  const manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const products = createShopProductStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  const orders = createShopOrderStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  const operational = createShopOperationalStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  for (const id of ['a', 'b']) {
    products.initializeDirectShop({ shopId: id });
    orders.initializeEmptyShop({ shopId: id }); orders.initializeDirectShop({ shopId: id });
    operational.initializeDirectShop({ shopId: id });
    createProductRepository(router.open(id).db).upsertProducts({ shopId: id, rows: [{ product_id: id === 'a' ? '1001' : '1002', offer_id: id, name: id, price: '10' }] });
  }
  const tokenA = shops.identityRepository.createScopeToken('a', shops.profileId);
  const layoutA = manager.resolve(tokenA);
  const lifecycle = createShopDatabaseLifecycle({ shopDatabaseManager: manager, backupRoot: path.join(root, 'backups') });
  const server = createApp({ db, shopDatabaseManager: manager, shopDatabaseLifecycle: lifecycle,
    config: { root, security: {}, database: { path: path.join(root, 'main.sqlite') }, runtime: { profileId: shops.profileId },
      sync: { continuousEnabled: false }, ozon: {}, storage: { productDirectWriteAllShops: true, orderDirectWriteAllShops: true, operationalDirectWriteAllShops: true } },
    getDatabaseStatus: () => ({ ok: true }), listAppliedMigrations: () => [], startedAt: Date.now(),
    ozonClient: { requestReadOnly() { throw new Error('FIXTURE_FORBIDS_EXTERNAL_REQUEST'); }, requestWrite() { throw new Error('FIXTURE_FORBIDS_EXTERNAL_WRITE'); } },
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); products.stop(); manager.closeAll(); db.close(); rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  };
  await request('/api/products/source-links?shopIds=a,b');
  const owner = { ownerType: 'ozon_shop', ownerId: 'a' };
  const prepared = await request('/api/account-removal/prepare-preview', { owner });
  const p = prepared.preview;
  const barriers = getAccountRemovalClientBarrierIds(owner.ownerType).sort();
  let operation = await request('/api/account-removal/confirm', {
    preview: p,
    confirm: { version: p.version, contractVersion: p.version, owner, requestedOwnerType: p.requestedOwnerType,
      requestedOwnerId: p.requestedOwnerId, requestedResourceIdsSemantics: p.requestedResourceIdsSemantics,
      requestedResourceIds: p.requestedResourceIds, catalogVersion: p.catalogVersion, catalogFingerprint: p.catalogFingerprint,
      resourceObservations: p.resourceObservations, snapshotFingerprint: p.snapshotFingerprint, previewFingerprint: p.previewFingerprint,
      idempotencyKey: 'removal-file-http-once' },
    barrierProof: { version: ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION, owner, previewFingerprint: p.previewFingerprint,
      fencedResourceIds: barriers, drainedResourceIds: barriers },
    confirmationCode: 'DELETE_ACCOUNT_PERMANENTLY',
    backupAuthorization: prepared.backupReview.required ? { outcome: 'explicitly-skipped', previewFingerprint: p.previewFingerprint,
      dataFingerprint: prepared.backupReview.dataFingerprint, skipConfirmationCode: 'SKIP_BACKUP_AND_DELETE_PERMANENTLY' } : null,
  });
  assert.equal(operation.requiresClientCleanup, true);
  assert.equal(existsSync(layoutA.databasePath), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shops WHERE id='a'").get().n, 0);
  // Reproduce the legacy persisted challenge: it omitted the category-template
  // cache that today's verifier requires. GET is still strictly read-only;
  // only an explicit resume upgrades this known additive contract.
  const initialNonce = operation.clientCleanup.nonce;
  const initialIds = operation.clientCleanup.resourceIds;
  const initialBackup = operation.deletionSummary.shopStorage.backupSha256;
  const legacyIds = initialIds.filter(id => id !== 'memory:renderer-collection-listing-category-template-cache');
  assert.equal(legacyIds.length, initialIds.length - 1);
  db.prepare('UPDATE account_removal_operations SET client_resource_ids_json = ? WHERE operation_id = ?').run(JSON.stringify(legacyIds), operation.operationId);
  const legacyStatus = await request(`/api/account-removal/operations/${operation.operationId}`);
  assert.deepEqual(legacyStatus.clientCleanup.resourceIds, legacyIds);
  assert.equal(legacyStatus.clientCleanup.nonce, initialNonce);
  const legacyProof = await fetch(base + '/api/account-removal/client-verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    operationId: operation.operationId, nonce: initialNonce, previewFingerprint: operation.previewFingerprint,
    resourceObservations: legacyIds.map(resourceId => ({ resourceId, state: 'absent' })),
  }) });
  assert.equal(legacyProof.status, 400);
  assert.equal((await legacyProof.json()).error.code, 'ACCOUNT_REMOVAL_CLIENT_CLEANUP_PROOF_INVALID');
  const originalId = operation.operationId;
  operation = await request(`/api/account-removal/operations/${originalId}/resume`, {});
  assert.equal(operation.operationId, originalId);
  assert.deepEqual(operation.clientCleanup.resourceIds, initialIds);
  assert.notEqual(operation.clientCleanup.nonce, initialNonce);
  assert.equal(operation.deletionSummary.shopStorage.backupSha256, initialBackup);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_removal_operations').get().n, 1);
  const repeated = await request(`/api/account-removal/operations/${originalId}/resume`, {});
  assert.equal(repeated.clientCleanup.nonce, operation.clientCleanup.nonce);
  const staleNonce = await fetch(base + '/api/account-removal/client-verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    operationId: originalId, nonce: initialNonce, previewFingerprint: operation.previewFingerprint,
    resourceObservations: initialIds.map(resourceId => ({ resourceId, state: 'absent' })),
  }) });
  assert.equal(staleNonce.status, 400);
  const pending = await request('/api/account-removal/pending');
  assert.deepEqual(pending.operations.find(row => row.operationId === operation.operationId).pendingOwner, owner);
  const statusPath = `/api/account-removal/operations/${operation.operationId}`;
  const status = await request(statusPath);
  assert.deepEqual(status.pendingOwner, owner);
  assert.equal(status.pendingOwnerGeneration.shopIncarnation, tokenA.shopIncarnation);
  assert.equal(status.clientCleanup.nonce, operation.clientCleanup.nonce);
  assert.equal('payload' in status, false);
  assert.equal('account' in status, false);
  const filteredPath = '/api/account-removal/pending?ownerType=ozon_shop&ownerId=a';
  assert.deepEqual((await request(filteredPath)).operations.map(row => row.operationId), [operation.operationId]);
  assert.deepEqual((await request('/api/account-removal/pending?ownerType=ozon_shop&ownerId=b')).operations, []);
  assert.equal((await fetch(base + '/api/account-removal/pending?ownerType=ozon_shop')).status, 400);
  // Broken legacy recovery data remains visible, but cannot be resumed using
  // an invented owner. This corruption/restore only touches the synthetic DB.
  const savedPayload = db.prepare('SELECT payload_encrypted FROM account_removal_operations WHERE operation_id = ?').get(operation.operationId).payload_encrypted;
  db.prepare('UPDATE account_removal_operations SET payload_encrypted = ? WHERE operation_id = ?').run('synthetic-invalid-ciphertext', operation.operationId);
  for (const invalid of [await request(statusPath), ...(await request('/api/account-removal/pending')).operations]) {
    assert.equal(invalid.recoveryUnavailable, true);
    assert.equal(invalid.error.code, 'ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE');
    assert.equal('pendingOwner' in invalid, false);
    assert.equal('payload' in invalid, false);
  }
  assert.equal((await request(filteredPath)).operations[0].recoveryUnavailable, true);
  assert.deepEqual((await request('/api/account-removal/pending?ownerType=ozon_shop&ownerId=b')).operations, []);
  db.prepare('UPDATE account_removal_operations SET payload_encrypted = ? WHERE operation_id = ?').run(savedPayload, operation.operationId);
  const resumed = await request(`${statusPath}/resume`, { directDelete: true });
  assert.equal(resumed.operationId, operation.operationId);
  assert.equal(resumed.requiresClientCleanup, true);
  assert.equal(existsSync(layoutA.databasePath), false);
  const invalidResume = await fetch(base + `${statusPath}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directDelete: 'true', owner }) });
  assert.equal(invalidResume.status, 400);
  assert.equal((await invalidResume.json()).error.code, 'ACCOUNT_REMOVAL_RESUME_OPTIONS_INVALID');
  assert.equal((await request('/api/cache/orders?shopId=b')).ok, true);
  // Non-browser external cleanup is a declared fixture boundary, not a real
  // cloud purge claim. Browser and remote adapters have separate contract tests.
  const repository = createAccountRemovalOperationRepository(db);
  for (const id of operation.clientCleanup.resourceIds) if (isAccountRemovalServerVerifiedClientResource(owner.ownerType, id)) repository.recordTrustedClientResourceReceipt(operation.operationId, id);
  const completed = await request('/api/account-removal/client-verify', { operationId: operation.operationId,
    nonce: operation.clientCleanup.nonce, previewFingerprint: operation.previewFingerprint,
    resourceObservations: operation.clientCleanup.resourceIds.map(resourceId => ({ resourceId, state: 'absent' })) });
  assert.equal(completed.completed, true);
  assert.equal('pendingOwner' in completed, false);
  assert.equal('pendingOwner' in await request(statusPath), false);
  assert.equal(router.open('b').db.prepare("SELECT COUNT(*) n FROM ozon_products WHERE shop_id='b'").get().n, 1);
  assert.equal((await request('/api/account-removal/pending')).operations.length, 0);
});

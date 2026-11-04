import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createProductRepository } from '../../db/repositories/productRepository.js';
import { createShopDatabaseManager } from '../../db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../../db/shopDatabaseRouter.js';
import { createShopDatabaseLifecycle } from '../../db/shopDatabaseLifecycle.js';
import { createDomainServiceRegistry } from '../domainRegistry.js';

test('removal closes both live federations and prevents reopening until physical deletion ends', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-removal-live-readers-'));
  const db = createMigratedTestDb(path.join(root, 'main.sqlite'));
  const shops = createShopRepository(db, { profileId: 'removal-live-readers' });
  for (const id of ['a', 'b']) shops.saveShop({ id, name: id, status: 'active' });
  const manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  for (const id of ['a', 'b']) router.open(id);
  const registry = createDomainServiceRegistry({ db, shopRepository: shops, shopDatabaseManager: manager, shopDatabaseRouter: router,
    productDirectWriteAllShops: true, orderDirectWriteAllShops: true, operationalDirectWriteAllShops: true });
  const lifecycle = createShopDatabaseLifecycle({ shopDatabaseManager: manager, backupRoot: path.join(root, 'backups') });
  t.after(() => { registry.stopBackgroundStorage(); manager.closeAll(); db.close(); rmSync(root, { recursive: true, force: true }); });
  for (const id of ['a', 'b']) {
    registry.initializeNewShopOrderStorage(id);
    registry.initializeNewShopProductStorage(id);
    registry.initializeNewShopOperationalStorage(id);
    createProductRepository(router.open(id).db).upsertProducts({ shopId: id, rows: [{ product_id: id === 'a' ? '1001' : '1002', offer_id: `offer-${id}`, name: id, price: '10' }] });
  }
  // This creates the second long-lived product federation, not only the dashboard union.
  registry.get('products').listSourceLinks({ shopIds: ['a', 'b'] });
  const owner = { ownerType: 'ozon_shop', ownerId: 'a' };
  const token = shops.identityRepository.createScopeToken('a', shops.profileId);
  await registry.quiesceOwnerStorage('a');
  registry.suspendReadConnections(owner);
  assert.throws(() => registry.get('products').listSourceLinks({ shopIds: ['a', 'b'] }), { code: 'ACCOUNT_REMOVAL_STORAGE_READ_PAUSED' });
  assert.throws(() => registry.get('orders').readCache({ shopId: 'a' }), { code: 'ACCOUNT_REMOVAL_OWNER_QUIESCED' });
  assert.equal(registry.get('orders').readCache({ shopId: 'b' }).ok, true);
  const deletion = await lifecycle.deleteWithBackup({ scopeToken: token });
  assert.equal(deletion.deleted, true);
  assert.ok(existsSync(deletion.backup.backupPath));
  assert.equal(manager.has(token), false);
  assert.equal(router.open('b').db.prepare("SELECT COUNT(*) n FROM ozon_products WHERE shop_id='b'").get().n, 1);
  // Real orchestration removes the central owner before physical cleanup. This
  // fixture drops it here to verify lazy reconnect uses the remaining owner set.
  db.prepare('DELETE FROM shops WHERE id=?').run('a');
  registry.releaseTransientResources(owner);
  assert.equal(registry.get('orders').readCache({}).ok, true, 'a pending client cleanup must not block healthy aggregate reads');
  registry.completeOwnerStorageRemoval('a');
  assert.equal(registry.get('products').readCache({ shopId: 'b' }).total, 1);
});

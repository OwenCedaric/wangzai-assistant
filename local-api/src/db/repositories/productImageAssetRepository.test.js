import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createProductImageAssetRepository } from './productImageAssetRepository.js';

test('isolates 27 images across three tenants, users and shops', () => {
  const db = createMigratedTestDb();
  try {
    const repositories = [];
    const saved = [];
    for (let tenant = 1; tenant <= 3; tenant += 1) {
      const repository = createProductImageAssetRepository(db, {
        tenantId: `tenant-${tenant}`,
        userId: `user-${tenant}`,
      });
      repositories.push(repository);
      for (let shop = 1; shop <= 3; shop += 1) {
        for (let image = 1; image <= 3; image += 1) {
          const scope = { shopId: `shop-${shop}` };
          const pending = repository.upsertPending({
            sha256: `same-content-${image}`,
            mimeType: 'image/png',
            byteLength: 100 + image,
            width: 100,
            height: 100,
            storageScope: 'permanent',
            variant: `image-${image}`,
            sourceType: 'test',
          }, scope);
          const objectKey = `wangzai/assets/images/tenant-${tenant}/shop-${shop}/${pending.asset.id}/image-${image}.png`;
          const stored = repository.markStored(pending.asset.id, { objectKey, uploadAttempts: 1 }, scope);
          repository.recordUsage({ assetId: stored.id, operation: 'upload', byteLength: stored.byteLength }, scope);
          saved.push(stored);
        }
      }
    }

    assert.equal(saved.length, 27);
    assert.equal(new Set(saved.map((asset) => asset.id)).size, 27);
    assert.equal(repositories[0].listAssets({ shopId: 'shop-1' }).length, 3);
    assert.throws(
      () => repositories[0].getAsset(saved.find((asset) => asset.tenantId === 'tenant-2').id, { shopId: 'shop-1' }),
      (error) => error.code === 'PRODUCT_IMAGE_SCOPE_FORBIDDEN',
    );
    assert.throws(
      () => repositories[0].getAsset(saved.find((asset) => asset.tenantId === 'tenant-1' && asset.shopId === 'shop-2').id, { shopId: 'shop-1' }),
      (error) => error.code === 'PRODUCT_IMAGE_SCOPE_FORBIDDEN',
    );
    assert.equal(repositories[0].getUsageSummary({ shopId: 'shop-1' }).day.uploads, 9);
  } finally {
    db.close();
  }
});

test('publishes only permanent assets owned by the confirmed shop', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProductImageAssetRepository(db, { tenantId: 'tenant-a', userId: 'user-a' });
    const create = (shopId, suffix) => {
      const pending = repository.upsertPending({
        sha256: `sha-${suffix}`, mimeType: 'image/png', byteLength: 200,
        storageScope: 'permanent', variant: suffix, sourceType: 'test',
      }, { shopId });
      return repository.markStored(pending.asset.id, {
        objectKey: `wangzai/assets/images/tenant-a/${shopId}/${suffix}.png`,
      }, { shopId });
    };
    const shopA = [create('shop-a', 'a1'), create('shop-a', 'a2'), create('shop-a', 'a3')];
    const shopB = [create('shop-b', 'b1'), create('shop-b', 'b2')];
    const urls = [...shopA, ...shopB].map((asset) => `https://bucket.example/${asset.objectKey}?Expires=123&Signature=x`);
    const published = repository.markPublishedByUrls({ shopId: 'shop-a', urls, productId: '100', offerId: 'offer-100' });
    assert.equal(published.changed, 3);
    assert.ok(shopA.every((asset) => repository.getAsset(asset.id, { shopId: 'shop-a' }).status === 'published'));
    assert.ok(shopB.every((asset) => repository.getAsset(asset.id, { shopId: 'shop-b' }).status === 'stored'));
  } finally {
    db.close();
  }
});

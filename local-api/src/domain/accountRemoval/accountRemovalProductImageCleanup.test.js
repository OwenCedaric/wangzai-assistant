import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createAccountRemovalProductImageCleanup } from './accountRemovalProductImageCleanup.js';

function insertAsset(db, {
  id,
  tenantId,
  userId,
  shopId,
  objectKey,
  status = 'stored',
} = {}) {
  db.prepare(`
    INSERT INTO product_image_assets (
      id, tenant_id, user_id, shop_id, sha256, mime_type, byte_length,
      storage_scope, variant, source_type, object_key, status,
      reference_count, upload_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'image/png', 68, 'permanent', 'original',
              'account-removal-test', ?, ?, 1, 1, ?, ?)
  `).run(
    id,
    tenantId,
    userId,
    shopId,
    id.padEnd(64, '0').slice(0, 64),
    objectKey,
    status,
    '2026-08-03T00:00:00.000Z',
    '2026-08-03T00:00:00.000Z',
  );
}

test('shop cleanup deletes all 12 exact owner objects and preserves other shops', async () => {
  const db = createMigratedTestDb();
  try {
    for (let index = 0; index < 12; index += 1) {
      insertAsset(db, {
        id: `asset-a-${index}`,
        tenantId: `tenant-${index % 3}`,
        userId: `user-${index % 4}`,
        shopId: 'shop-a',
        objectKey: `wangzai/assets/images/tenant-${index % 3}/shop-a/a-${index}.png`,
        status: index % 3 === 0 ? 'deleted' : index % 3 === 1 ? 'published' : 'stored',
      });
    }
    for (let index = 0; index < 5; index += 1) {
      insertAsset(db, {
        id: `asset-b-${index}`,
        tenantId: 'tenant-shared',
        userId: `user-${index}`,
        shopId: 'shop-b',
        objectKey: `wangzai/assets/images/tenant-shared/shop-b/b-${index}.png`,
      });
    }
    const deletedKeys = [];
    const cleanup = createAccountRemovalProductImageCleanup({
      db,
      objectStorage: { async deleteImage(objectKey) { deletedKeys.push(objectKey); } },
      concurrency: 4,
    });
    const result = await cleanup.cleanupOwner({ ownerType: 'ozon_shop', ownerId: 'shop-a' });
    assert.deepEqual(result, { completed: true, candidates: 12, deleted: 12, retries: 0 });
    assert.equal(deletedKeys.length, 12);
    assert.equal(deletedKeys.every((key) => key.includes('/shop-a/')), true);
    assert.equal(deletedKeys.some((key) => key.includes('/shop-b/')), false);
  } finally {
    db.close();
  }
});

test('shop cleanup retries transient remote failures without widening owner scope', async () => {
  const db = createMigratedTestDb();
  try {
    for (let index = 0; index < 6; index += 1) {
      insertAsset(db, {
        id: `retry-${index}`,
        tenantId: 'tenant-retry',
        userId: 'user-retry',
        shopId: 'shop-retry',
        objectKey: `wangzai/assets/images/tenant-retry/shop-retry/${index}.png`,
      });
    }
    const attempts = new Map();
    const cleanup = createAccountRemovalProductImageCleanup({
      db,
      objectStorage: {
        async deleteImage(objectKey) {
          const count = (attempts.get(objectKey) || 0) + 1;
          attempts.set(objectKey, count);
          if (objectKey.endsWith('/2.png') && count < 3) throw new Error('temporary OSS error');
          if (objectKey.endsWith('/4.png') && count < 2) throw new Error('temporary OSS error');
        },
      },
      concurrency: 3,
      maxAttempts: 3,
    });
    const result = await cleanup.cleanupOwner({ ownerType: 'ozon_shop', ownerId: 'shop-retry' });
    assert.deepEqual(result, { completed: true, candidates: 6, deleted: 6, retries: 3 });
    assert.equal([...attempts.values()].reduce((sum, value) => sum + value, 0), 9);
  } finally {
    db.close();
  }
});

test('shop cleanup fails closed when remote storage is unavailable or deletion exhausts retries', async () => {
  const db = createMigratedTestDb();
  try {
    insertAsset(db, {
      id: 'fail-closed',
      tenantId: 'tenant-fail',
      userId: 'user-fail',
      shopId: 'shop-fail',
      objectKey: 'wangzai/assets/images/tenant-fail/shop-fail/fail.png',
    });
    const unavailable = createAccountRemovalProductImageCleanup({ db, objectStorage: null });
    await assert.rejects(
      unavailable.cleanupOwner({ ownerType: 'ozon_shop', ownerId: 'shop-fail' }),
      { code: 'ACCOUNT_REMOVAL_REMOTE_STORAGE_UNAVAILABLE' },
    );
    let calls = 0;
    const failing = createAccountRemovalProductImageCleanup({
      db,
      objectStorage: { async deleteImage() { calls += 1; throw new Error('persistent OSS error'); } },
      maxAttempts: 3,
    });
    await assert.rejects(
      failing.cleanupOwner({ ownerType: 'ozon_shop', ownerId: 'shop-fail' }),
      { code: 'ACCOUNT_REMOVAL_REMOTE_OBJECT_DELETE_FAILED' },
    );
    assert.equal(calls, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_image_assets WHERE shop_id = ?').get('shop-fail').count, 1);
  } finally {
    db.close();
  }
});

test('cleanup is a no-op for empty shops and non-Ozon account types', async () => {
  const db = createMigratedTestDb();
  try {
    const cleanup = createAccountRemovalProductImageCleanup({ db, objectStorage: null });
    assert.deepEqual(
      await cleanup.cleanupOwner({ ownerType: 'ozon_shop', ownerId: 'empty-shop' }),
      { completed: true, candidates: 0, deleted: 0, retries: 0 },
    );
    assert.deepEqual(
      await cleanup.cleanupOwner({ ownerType: 'purchase_account', ownerId: 'purchase-1' }),
      { completed: true, candidates: 0, deleted: 0, retries: 0 },
    );
  } finally {
    db.close();
  }
});


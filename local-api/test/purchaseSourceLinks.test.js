import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createPurchaseSourceLinkRepository } from '../src/db/repositories/purchaseSourceLinkRepository.js';
import { createMigratedTestDb } from './testDb.js';

async function withServer(db, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: { async requestReadOnly() { throw new Error('purchase source tests must not call Ozon'); } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('purchase source link repository saves order-scoped source links', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseSourceLinkRepository(db);
    const saved = repository.saveLinks({
      shopId: 'shop-ps1',
      orderKey: 'posting-ps1',
      primaryIndex: 0,
      links: [{
        platform: 'PDD',
        url: 'https://example.test/item/1',
        title: '货源1',
        price: 12.5,
        qty: '1',
        previewImageUrl: 'https://img.test/purchase-preview.jpg',
        originalImageUrl: 'https://img.test/purchase-original.jpg',
      }],
    });
    assert.equal(saved.ok, true);
    const page = repository.listLinks({ shopId: 'shop-ps1', orderKey: 'posting-ps1' });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].platform, 'PDD');
    assert.equal(page.rows[0].isPrimary, true);
    assert.equal(page.rows[0].priceValue, 12.5);
    assert.equal(page.rows[0].previewImageUrl, 'https://img.test/purchase-preview.jpg');
    assert.equal(page.rows[0].originalImageUrl, 'https://img.test/purchase-original.jpg');
    assert.equal(db.prepare('SELECT raw_json FROM purchase_source_links').get().raw_json, null);
  } finally {
    db.close();
  }
});

test('purchase source link repository keeps existing title and image when retry payload is empty', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseSourceLinkRepository(db);
    repository.saveLinks({
      shopId: 'shop-ps2',
      orderKey: 'posting-ps2',
      links: [{ platform: 'PDD', url: 'https://example.test/item/2', title: '有效标题', imageUrl: 'https://img.test/1.jpg' }],
    });
    repository.saveLinks({
      shopId: 'shop-ps2',
      orderKey: 'posting-ps2',
      links: [{ platform: '', url: '', title: '', imageUrl: '', price: 20 }],
    });
    const row = repository.listLinks({ shopId: 'shop-ps2', orderKey: 'posting-ps2' }).rows[0];
    assert.equal(row.title, '有效标题');
    assert.equal(row.imageUrl, 'https://img.test/1.jpg');
    assert.equal(row.priceValue, 20);
  } finally {
    db.close();
  }
});

test('purchase source link HTTP routes save list and delete without remote calls', async () => {
  const db = createMigratedTestDb();
  try {
    await withServer(db, async (base) => {
      const saveResponse = await fetch(`${base}/api/purchase/source-links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopId: 'shop-ps3',
          orderKey: 'posting-ps3',
          links: [{ platform: '1688', url: 'https://example.test/1688', title: '1688货源' }],
        }),
      });
      const savePayload = await saveResponse.json();
      assert.equal(savePayload.ok, true);

      const listPayload = await (await fetch(`${base}/api/purchase/source-links?shopId=shop-ps3&orderKey=posting-ps3`)).json();
      assert.equal(listPayload.total, 1);
      assert.equal(listPayload.rows[0].platform, '1688');

      const deleteResponse = await fetch(`${base}/api/purchase/source-links`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopId: 'shop-ps3', orderKey: 'posting-ps3' }),
      });
      const deletePayload = await deleteResponse.json();
      assert.equal(deletePayload.deleted, 1);
    });
  } finally {
    db.close();
  }
});

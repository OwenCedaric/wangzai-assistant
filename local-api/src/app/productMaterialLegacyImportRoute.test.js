import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function profile(index, source = 'supplier-confirmed') {
  return {
    key: `shop-material:offer-${index}`,
    shopId: 'shop-material',
    offerId: `offer-${index}`,
    source,
    sourceRank: source === 'supplier-confirmed' ? 300 : 180,
    weight: String(index / 10),
    length: '20',
    width: '10',
    height: '8',
    applyToProduct: true,
    isConfirmed: true,
    ozonSyncTaskId: `task-${index}`,
  };
}

test('product material legacy bulk route commits all rows once and exposes cursor-only readback DTO', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    saveUnitShop(createShopRepository(db), 'shop-material');
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${baseUrl}/api/products/material/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: [profile(1), profile(2)] }),
    });
    const imported = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      { ok: imported.ok, importedCount: imported.importedCount, scopeCount: imported.scopeCount },
      { ok: true, importedCount: 2, scopeCount: 1 },
    );
    assert.equal(typeof imported.digest, 'string');
    const timestamps = db
      .prepare('SELECT DISTINCT updated_at AS updatedAt FROM product_material_profiles ORDER BY updated_at ASC')
      .all();
    assert.equal(timestamps.length, 1);

    const firstPage = await (
      await fetch(`${baseUrl}/api/products/material?cursorMode=legacy-migration&limit=1`)
    ).json();
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.rows.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.equal(Array.isArray(firstPage.materialProfiles), false);
    assert.equal(firstPage.rows[0].ozonSyncTaskId.startsWith('task-'), true);

    const secondPage = await (
      await fetch(
        `${baseUrl}/api/products/material?cursorMode=legacy-migration&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      )
    ).json();
    assert.equal(secondPage.total, 2);
    assert.equal(secondPage.rows.length, 1);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.nextCursor, '');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('product material legacy bulk route rejects an invalid sibling before any material row is written', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    saveUnitShop(createShopRepository(db), 'shop-material');
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/products/material/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profiles: [
          profile(1),
          { ...profile(2), unexpectedPayloadField: 'must-reject' },
        ],
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS total FROM product_material_profiles').get().total),
      0,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

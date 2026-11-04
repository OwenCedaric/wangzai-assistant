import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createShopRepository } from './repositories/shopRepository.js';

function migration(name) {
  return readFileSync(resolve('src/db/migrations', name), 'utf8').replace(/^\uFEFF/u, '');
}

test('migration 099 persists one isolated Ozon push endpoint binding per shop', () => {
  process.env.LOCAL_API_SECRET = 'migration-test-secret-material-that-is-long-enough';
  const db = new DatabaseSync(':memory:');
  db.exec(migration('001_create_base_tables.sql'));
  db.exec(migration('058_create_shop_identity_lifecycle.sql'));
  db.exec(migration('075_add_shop_owner_scope.sql'));
  db.exec(migration('099_add_ozon_push_endpoint_bindings.sql'));
  const repository = createShopRepository(db);
  repository.saveShop({ id: 'shop-a', name: 'A', clientId: '1001', apiKey: 'key-a', status: 'active' });
  repository.saveShop({ id: 'shop-b', name: 'B', clientId: '1002', apiKey: 'key-b', status: 'active' });

  repository.saveShop({
    id: 'shop-a',
    name: 'A',
    ozonPushBindingId: 'binding-a',
    ozonPushBindingMode: 'desktop',
    ozonPushPublicBaseUrl: 'https://node.example.ts.net:8443',
    ozonPushStatus: 'receiving',
    ozonPushCreatedAt: '2026-08-28T01:00:00.000Z',
    ozonPushLastReceivedAt: '2026-08-28T02:00:00.000Z',
  });
  const a = repository.getPublicShopById('shop-a');
  const b = repository.getPublicShopById('shop-b');
  assert.equal(a.ozonPushBindingId, 'binding-a');
  assert.equal(a.ozonPushBindingMode, 'desktop');
  assert.equal(a.ozonPushStatus, 'receiving');
  assert.equal(a.ozonPushLastReceivedAt, '2026-08-28T02:00:00.000Z');
  assert.equal(a.hasApiKey, true);
  assert.equal(b.ozonPushBindingId, '');
  assert.throws(() => repository.saveShop({
    id: 'shop-b',
    name: 'B',
    ozonPushBindingId: 'binding-a',
  }), /UNIQUE constraint failed/u);
  db.close();
});


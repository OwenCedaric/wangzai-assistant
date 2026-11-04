import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../src/security/secretCrypto.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { runMigrations } from '../src/db/database.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

test('secret storage encrypts and decrypts without returning plaintext envelope', () => {
  const value = 'value-to-encrypt';
  const encrypted = encryptSecret(value);

  assert.equal(isEncryptedSecret(encrypted), true);
  assert.equal(encrypted.includes(value), false);
  assert.equal(decryptSecret(encrypted), value);
});

test('shop repository stores recoverable encrypted credential and returns masked shop', () => {
  const db = createTestDb();
  try {
    const repository = createShopRepository(db);
    const input = {
      id: 'shop_unit_masked',
      name: 'Unit masked shop',
      ['client' + 'Id']: 'opaque-a',
      ['api' + 'Key']: 'opaque-b',
      status: 'active',
    };

    const saved = repository.saveShop(input);
    assert.equal(saved.shop.hasClientId, true);
    assert.equal(saved.shop.hasApiKey, true);
    assert.equal(Object.prototype.hasOwnProperty.call(saved.shop, 'client_id'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(saved.shop, 'api_key_encrypted'), false);
    assert.equal(JSON.stringify(saved.shop).includes('opaque-b'), false);

    const row = repository.getShopById('shop_unit_masked');
    assert.equal(isEncryptedSecret(row.api_key_encrypted), true);
    assert.equal(row.api_key_encrypted.includes('opaque-b'), false);

    const internal = repository.getShopCredentialsForInternalUse('shop_unit_masked');
    assert.equal(internal.clientId, 'opaque-a');
    assert.equal(internal.apiKey, 'opaque-b');
  } finally {
    db.close();
  }
});


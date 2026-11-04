import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileAssetRepository } from './profileAssetRepository.js';
import { createMigratedTestDb } from '../../../test/testDb.js';

test('profile asset repository content-addresses an allowed image without returning blob data by default', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfileAssetRepository(db);
    const input = { mimeType: 'image/png', dataBase64: Buffer.from('watermark-png-fixture').toString('base64') };
    const saved = repository.saveAsset(input);
    const duplicate = repository.saveAsset(input);
    assert.equal(saved.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(saved.asset.id, duplicate.asset.id);
    assert.equal(Object.hasOwn(saved.asset, 'dataBase64'), false);
    assert.equal(repository.getAsset(saved.asset.id, { includeData: true }).dataBase64, input.dataBase64);
    assert.throws(
      () => repository.saveAsset({ mimeType: 'image/svg+xml', dataBase64: input.dataBase64 }),
      /MIME type is not allowed/,
    );
  } finally {
    db.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { getAccountRemovalSqliteResources } from '../domain/accountRemoval/accountRemovalSqliteCatalog.js';

test('every current Ozon account-removal owner lookup has a leading owner index', () => {
  const db = createMigratedTestDb();
  try {
    const descriptors = getAccountRemovalSqliteResources('ozon_shop');
    assert.ok(descriptors.length > 0, 'Ozon account-removal catalog must not be empty');
    for (const descriptor of descriptors) {
      const indexes = db.prepare(`PRAGMA index_list("${descriptor.table}")`).all();
      const hasLeadingOwnerIndex = indexes.some((index) => {
        const columns = db.prepare(`PRAGMA index_info("${index.name}")`).all();
        return columns[0]?.name === descriptor.ownerField;
      });
      assert.equal(hasLeadingOwnerIndex, true, `${descriptor.table}.${descriptor.ownerField} requires a leading owner index`);
    }
  } finally {
    db.close();
  }
});

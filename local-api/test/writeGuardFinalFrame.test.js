import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createWriteGuardService } from '../src/security/writeGuardService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

test('writeGuard final frame records preview and blocks real execution after confirm', () => {
  const db = createMigratedTestDb();
  try {
    const guard = createWriteGuardService(db);
    saveUnitShop(createShopRepository(db), 'shop-write');
    const preview = guard.previewWrite('orders', {
      shopId: 'shop-write', endpointKey: 'orders.cancel', action: 'cancel', requestedBy: 'unit',
      after: { status: 'cancelled', ['api' + 'Key']: 'secret' },
    });
    assert.equal(preview.ok, true);
    const confirm = guard.confirmWrite('orders', { previewId: preview.previewId, confirm: true, shopId: 'shop-write' });
    assert.equal(confirm.ok, false);
    assert.equal(confirm.error.code, 'WRITE_EXECUTION_NOT_CONNECTED');
    assert.equal(confirm.writeQueue.priority, 'WRITE');
    const auditRows = db.prepare('SELECT audit_payload_json FROM ozon_write_audit_log').all();
    assert.equal(auditRows.length, 2);
    assert.equal(auditRows.some((row) => row.audit_payload_json.includes('secret')), false);
    assert.equal(auditRows.some((row) => row.audit_payload_json.includes('[REDACTED]')), true);
  } finally {
    db.close();
  }
});

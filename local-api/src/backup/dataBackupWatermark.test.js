import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDataBackupWatermark,
  DATA_BACKUP_OWNER_WATERMARK_VERSION,
  validateDataBackupWatermark,
} from './dataBackupWatermark.js';

const domains = [{
  domain: 'purchase-browser-tasks',
  schemaVersion: 1,
  recordCount: 2,
  recordsRootHash: `sha256:${'a'.repeat(64)}`,
}];

test('owner watermark binds owner type, id, incarnation, schema generation, and domain roots', () => {
  const input = {
    owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' },
    ownerIncarnation: '2026-07-17T01:00:00.000Z',
    sqliteUserVersion: 66,
    domains,
  };
  const first = createDataBackupWatermark(input);
  assert.equal(first.version, DATA_BACKUP_OWNER_WATERMARK_VERSION);
  assert.deepEqual(
    validateDataBackupWatermark(first, { owner: input.owner, domains }),
    first,
  );
  assert.notEqual(
    createDataBackupWatermark({ ...input, owner: { ...input.owner, ownerId: 'purchase-b' } }).dataFingerprint,
    first.dataFingerprint,
  );
  assert.notEqual(
    createDataBackupWatermark({ ...input, ownerIncarnation: '2026-07-17T02:00:00.000Z' }).dataFingerprint,
    first.dataFingerprint,
  );
  assert.throws(
    () => validateDataBackupWatermark(first, {
      owner: { ownerType: 'purchase_account', ownerId: 'purchase-b' },
      domains,
    }),
    /DATA_BACKUP_WATERMARK_OWNER_MISMATCH/u,
  );
});

test('legacy shop watermark remains valid for already-created shop packages', () => {
  const watermark = createDataBackupWatermark({
    shopId: 'shop-a',
    shopIncarnation: 'shop-inc-a',
    sqliteUserVersion: 64,
    domains,
  });
  assert.equal(validateDataBackupWatermark(watermark, { shopId: 'shop-a', domains }).shopId, 'shop-a');
});

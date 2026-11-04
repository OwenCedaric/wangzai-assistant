import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createAccountRemovalOperationRepository } from './accountRemovalOperationRepository.js';
import { getAccountRemovalClientResourceIds } from '../../domain/accountRemoval/accountRemovalClientResources.js';

process.env.LOCAL_API_SECRET = 'synthetic-operation-repository-test-key';

function input(key = 'synthetic-idempotency-key', digest = 'synthetic-request-digest') {
  return {
    preview: { plannedResources: [] },
    confirm: { idempotencyKey: key, requestDigest: digest,
      owner: { ownerType: 'purchase_account', ownerId: 'synthetic-race-owner' },
      previewFingerprint: 'synthetic-preview', catalogFingerprint: 'synthetic-catalog', snapshotFingerprint: 'synthetic-snapshot' },
    account: { id: 'synthetic-race-owner' }, ownerIncarnation: 'synthetic-incarnation',
    barrierProof: {}, backupAuthorization: { outcome: 'not-required' },
  };
}

function race(t, competingInput) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-operation-race-test-'));
  const db = createMigratedTestDb(join(root, 'operations.sqlite'));
  const other = new DatabaseSync(join(root, 'operations.sqlite'));
  t.after(() => { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const second = createAccountRemovalOperationRepository(other, { encryptPayload: JSON.stringify, decryptPayload: JSON.parse });
  let competed = false;
  const first = createAccountRemovalOperationRepository(db, {
    encryptPayload(payload) {
      // Simulate another API writer committing after the first precheck but
      // before its INSERT, using a real second connection and unique index.
      if (!competed) { competed = true; second.beginOrReuse(competingInput); }
      return JSON.stringify(payload);
    }, decryptPayload: JSON.parse,
  });
  return { db, first, second };
}

test('same-key concurrent insert returns the existing matching operation instead of a native SQLite constraint error', (t) => {
  const f = race(t, input());
  const result = f.first.beginOrReuse(input());
  assert.equal(result.created, false);
  assert.equal(result.operation.operationId, f.second.findByIdempotencyKey(input().confirm.idempotencyKey).operationId);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_removal_operations').get().n, 1);
});

test('concurrent same-key different intent remains a conflict, never an idempotent reuse', (t) => {
  const f = race(t, input('synthetic-idempotency-key', 'different-intent'));
  assert.throws(() => f.first.beginOrReuse(input()), /ACCOUNT_REMOVAL_IDEMPOTENCY_KEY_CONFLICT/);
});

test('a different-key same-owner insert race retains the durable owner lock', (t) => {
  const f = race(t, input('different-idempotency-key'));
  assert.throws(() => f.first.beginOrReuse(input()), /ACCOUNT_REMOVAL_OWNER_LOCKED/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_removal_operations WHERE completed_at IS NULL').get().n, 1);
});

test('a stale phase request cannot downgrade or falsely fail an already completed operation', (t) => {
  const db = createMigratedTestDb(); t.after(() => db.close());
  const repo = createAccountRemovalOperationRepository(db, { encryptPayload: JSON.stringify, decryptPayload: JSON.parse });
  const started = repo.beginOrReuse(input()).operation;
  repo.markCompleted(started.operationId, { verified: true });
  const result = repo.markPhase(started.operationId, 'quiescing', { incrementAttempt: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.phase, 'completed');
  assert.equal(result.attemptCount, 0);
  assert.equal(result.payload, null);
  assert.equal(repo.recordFailure(started.operationId, 'LATE_FAILURE').status, 'completed');
});

function legacyShopChallenge(db, options = {}) {
  const ids = [...getAccountRemovalClientResourceIds('ozon_shop')].sort();
  const addedId = 'memory:renderer-collection-listing-category-template-cache';
  assert.equal(ids.includes(addedId), true);
  const repo = createAccountRemovalOperationRepository(db, { encryptPayload: JSON.stringify, decryptPayload: JSON.parse, ...options });
  const fixture = input();
  fixture.confirm.owner = { ownerType: 'ozon_shop', ownerId: 'synthetic-legacy-shop' };
  fixture.preview.plannedResources = ids.map(id => ({ id }));
  const started = repo.beginOrReuse(fixture).operation;
  repo.markPhase(started.operationId, 'external-delete-pending', { deletionSummary: { syntheticBackupDigest: 'preserved' } });
  const legacyIds = ids.filter(id => id !== addedId);
  db.prepare('UPDATE account_removal_operations SET client_resource_ids_json = ? WHERE operation_id = ?')
    .run(JSON.stringify(legacyIds), started.operationId);
  return { repo, operationId: started.operationId, owner: fixture.confirm.owner, ids, legacyIds };
}

test('known additive legacy challenge upgrades once, preserves operation payload and owner lock, and rotates only its nonce', t => {
  const db = createMigratedTestDb(); t.after(() => db.close());
  const f = legacyShopChallenge(db);
  const before = f.repo.getOperation(f.operationId);
  const rawPayload = db.prepare('SELECT payload_encrypted FROM account_removal_operations WHERE operation_id = ?').get(f.operationId).payload_encrypted;
  const upgraded = f.repo.upgradeLegacyClientCleanupChallenge(f.operationId);
  assert.deepEqual(upgraded.clientResourceIds, f.ids);
  assert.notEqual(upgraded.clientCleanupNonce, before.clientCleanupNonce);
  assert.equal(upgraded.operationId, before.operationId);
  assert.equal(upgraded.previewFingerprint, before.previewFingerprint);
  assert.deepEqual(upgraded.deletionSummary, before.deletionSummary);
  assert.equal(f.repo.hasActiveOwner(f.owner), true);
  assert.equal(db.prepare('SELECT payload_encrypted FROM account_removal_operations WHERE operation_id = ?').get(f.operationId).payload_encrypted, rawPayload);
  assert.equal(f.repo.upgradeLegacyClientCleanupChallenge(f.operationId).clientCleanupNonce, upgraded.clientCleanupNonce);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_removal_operations').get().n, 1);
});

test('unknown resource drift or a verified legacy proof is never silently widened', t => {
  const db = createMigratedTestDb(); t.after(() => db.close());
  const f = legacyShopChallenge(db);
  for (const changedIds of [f.legacyIds.slice(1), [...f.legacyIds, 'memory:unknown-future-resource']]) {
    db.prepare('UPDATE account_removal_operations SET client_resource_ids_json = ? WHERE operation_id = ?')
      .run(JSON.stringify(changedIds), f.operationId);
    const before = f.repo.getOperation(f.operationId);
    assert.throws(() => f.repo.upgradeLegacyClientCleanupChallenge(f.operationId), /UPGRADE_UNSUPPORTED/);
    assert.deepEqual(f.repo.getOperation(f.operationId), before);
  }
  db.prepare('UPDATE account_removal_operations SET client_resource_ids_json = ? WHERE operation_id = ?')
    .run(JSON.stringify(f.legacyIds), f.operationId);
  f.repo.updatePayload(f.operationId, { clientCleanupVerification: { verified: true } });
  assert.throws(() => f.repo.upgradeLegacyClientCleanupChallenge(f.operationId), /UPGRADE_UNSUPPORTED/);
  assert.equal(f.repo.hasActiveOwner(f.owner), true);
  f.repo.markCompleted(f.operationId, { verified: true });
  const completed = f.repo.upgradeLegacyClientCleanupChallenge(f.operationId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.clientCleanupNonce, null);
});

test('legacy challenge upgrade reconciles another connection winning the nonce update without issuing a second challenge', t => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-challenge-upgrade-test-'));
  const db = createMigratedTestDb(join(root, 'operations.sqlite'));
  const other = new DatabaseSync(join(root, 'operations.sqlite'));
  t.after(() => { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  let competingUpgrade = null;
  let sequence = 0;
  const f = legacyShopChallenge(db, { createClientCleanupNonce() {
    sequence += 1;
    if (sequence > 1) competingUpgrade?.();
    return `synthetic-first-nonce-${sequence}`;
  } });
  const second = createAccountRemovalOperationRepository(other, { encryptPayload: JSON.stringify, decryptPayload: JSON.parse,
    createClientCleanupNonce: () => 'synthetic-second-winner-nonce' });
  competingUpgrade = () => second.upgradeLegacyClientCleanupChallenge(f.operationId);
  const upgraded = f.repo.upgradeLegacyClientCleanupChallenge(f.operationId);
  assert.equal(upgraded.clientCleanupNonce, 'synthetic-second-winner-nonce');
  assert.deepEqual(upgraded.clientResourceIds, f.ids);
  assert.equal(f.repo.upgradeLegacyClientCleanupChallenge(f.operationId).clientCleanupNonce, upgraded.clientCleanupNonce);
});

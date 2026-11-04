import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createAccountRemovalOperationRepository } from './accountRemovalOperationRepository.js';
import { getAccountRemovalClientResourceIds } from '../../domain/accountRemoval/accountRemovalClientResources.js';

process.env.LOCAL_API_SECRET = 'synthetic-client-failure-contract-key';

function fixture(t, onTimestamp = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-client-failure-contract-'));
  const db = createMigratedTestDb(join(root, 'operations.sqlite'));
  const other = new DatabaseSync(join(root, 'operations.sqlite'));
  t.after(() => { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const codecs = { encryptPayload: JSON.stringify, decryptPayload: JSON.parse };
  const competing = createAccountRemovalOperationRepository(other, codecs);
  const repo = createAccountRemovalOperationRepository(db, { ...codecs, now() { onTimestamp(); return '2026-09-05T00:00:00.000Z'; } });
  const owner = { ownerType: 'model_api_account', ownerId: 'synthetic-client-failure-owner' };
  const operation = repo.beginOrReuse({
    preview: { plannedResources: getAccountRemovalClientResourceIds(owner.ownerType).map((id) => ({ id })) },
    confirm: { owner, idempotencyKey: 'synthetic-client-failure-key', requestDigest: 'request',
      previewFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), snapshotFingerprint: 'c'.repeat(64) },
    account: { id: owner.ownerId }, ownerIncarnation: 'synthetic-incarnation',
    barrierProof: {}, backupAuthorization: { outcome: 'not-required' },
  }).operation;
  repo.markPhase(operation.operationId, 'external-delete-pending', { deletionSummary: { preserved: 'synthetic-receipt' } });
  const report = { operationId: operation.operationId, nonce: operation.clientCleanupNonce,
    previewFingerprint: operation.previewFingerprint, errorCode: 'RECOVERY_REMOTE_UNAVAILABLE',
    resourceId: 'backup:remote-recovery-owner-model-api-account' };
  return { db, other, repo, competing, owner, operation, report };
}

test('client failure changes only diagnostics/status and retains phase, nonce, payload and owner lock', (t) => {
  const f = fixture(t);
  const before = f.db.prepare('SELECT * FROM account_removal_operations').get();
  const result = f.repo.recordClientFailure(f.report);
  const after = f.db.prepare('SELECT * FROM account_removal_operations').get();
  assert.equal(result.reported, true);
  assert.equal(after.status, 'retryable-failed');
  assert.equal(after.last_error_code, f.report.errorCode);
  assert.equal(after.phase, before.phase);
  assert.equal(after.client_cleanup_nonce, before.client_cleanup_nonce);
  assert.equal(after.payload_encrypted, before.payload_encrypted);
  assert.equal(after.attempt_count, before.attempt_count);
  assert.equal(after.completed_at, null);
  assert.equal(f.repo.hasActiveOwner(f.owner), true);
  assert.deepEqual(JSON.parse(after.deletion_summary_json), { preserved: 'synthetic-receipt',
    clientFailure: { code: f.report.errorCode, resourceId: f.report.resourceId } });
});

test('raw messages, extra owner data, unknown codes, wrong challenge and unrelated resource are rejected', (t) => {
  const f = fixture(t);
  for (const report of [
    { ...f.report, message: 'must-not-persist' }, { ...f.report, stack: 'must-not-persist' },
    { ...f.report, token: 'must-not-persist' }, { ...f.report, owner: f.owner },
    { ...f.report, errorCode: 'MY_PRIVATE_TOKEN_123' }, { ...f.report, errorCode: 'raw error message' },
    { ...f.report, nonce: 'wrong-nonce-value-123' }, { ...f.report, previewFingerprint: 'd'.repeat(64) },
    { ...f.report, resourceId: 'browser:purchase-cookies' },
  ]) assert.throws(() => f.repo.recordClientFailure(report), /ACCOUNT_REMOVAL_CLIENT_FAILURE_/);
  assert.equal(f.repo.getOperation(f.operation.operationId).lastErrorCode, null);
});

test('completion racing the diagnostic UPDATE wins atomically and is never downgraded', (t) => {
  let race = false;
  let f;
  f = fixture(t, () => { if (race) { race = false; f.competing.markCompleted(f.operation.operationId, { verified: true }); } });
  race = true;
  const result = f.repo.recordClientFailure(f.report);
  assert.equal(result.reported, false);
  assert.equal(result.operation.status, 'completed');
  assert.equal(result.operation.lastErrorCode, null);
  assert.deepEqual(result.operation.deletionSummary, { verified: true });
});

test('phase advance racing the diagnostic UPDATE is not overwritten', (t) => {
  let race = false;
  let f;
  f = fixture(t, () => { if (race) { race = false; f.competing.markPhase(f.operation.operationId, 'verifying'); } });
  race = true;
  assert.throws(() => f.repo.recordClientFailure(f.report), /ACCOUNT_REMOVAL_CLIENT_CLEANUP_REQUIRED/);
  const result = f.repo.getOperation(f.operation.operationId);
  assert.equal(result.phase, 'verifying');
  assert.equal(result.status, 'pending');
  assert.equal(result.lastErrorCode, null);
});

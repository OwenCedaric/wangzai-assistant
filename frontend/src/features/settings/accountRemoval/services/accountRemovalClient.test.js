import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestLocalApi = vi.hoisted(() => vi.fn());

vi.mock('../../../../api/localApiClient.js', () => ({ requestLocalApi }));

import {
  ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_CODE,
  ACCOUNT_REMOVAL_CONFIRMATION_CODE,
  ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION,
  buildAccountRemovalConfirm,
  confirmAccountRemoval,
  getAccountRemovalOperation,
  listPendingAccountRemovals,
  prepareAccountRemovalPreview,
  previewAccountRemoval,
  recoverAccountRemoval,
  recoverAccountRemovalDirectly,
  releaseAccountRemovalPreview,
  resumeAccountRemovalOperation,
  reportAccountRemovalClientFailure,
  verifyAccountRemovalClientCleanup,
} from './accountRemovalClient.js';

const preview = Object.freeze({
  version: 'account-removal-contract-v4',
  owner: { ownerType: 'purchase_account', ownerId: 'purchase_client_test' },
  requestedOwnerType: 'purchase_account',
  requestedOwnerId: 'purchase_client_test',
  requestedResourceIdsSemantics: 'assertion-allowlist',
  requestedResourceIds: ['registry:purchase-accounts'],
  catalogVersion: 'account-ownership-catalog-v4',
  catalogFingerprint: 'a'.repeat(64),
  resourceObservations: [{ resourceId: 'registry:purchase-accounts', state: 'observed', count: 1, hash: 'b'.repeat(64) }],
  snapshotFingerprint: 'c'.repeat(64),
  previewFingerprint: 'd'.repeat(64),
});

describe('accountRemovalClient', () => {
  beforeEach(() => {
    requestLocalApi.mockReset();
    requestLocalApi.mockResolvedValue({ ok: true });
  });

  it('builds an exact confirm echo without inventing deletion scope', () => {
    const confirm = buildAccountRemovalConfirm(preview, 'account-removal-client-idempotency-01');
    expect(confirm).toEqual({
      version: preview.version,
      contractVersion: preview.version,
      owner: preview.owner,
      requestedOwnerType: preview.requestedOwnerType,
      requestedOwnerId: preview.requestedOwnerId,
      requestedResourceIdsSemantics: preview.requestedResourceIdsSemantics,
      requestedResourceIds: preview.requestedResourceIds,
      catalogVersion: preview.catalogVersion,
      catalogFingerprint: preview.catalogFingerprint,
      resourceObservations: preview.resourceObservations,
      snapshotFingerprint: preview.snapshotFingerprint,
      previewFingerprint: preview.previewFingerprint,
      idempotencyKey: 'account-removal-client-idempotency-01',
    });
    expect(confirm.owner).not.toBe(preview.owner);
    expect(confirm.resourceObservations[0]).not.toBe(preview.resourceObservations[0]);
  });

  it('uses only canonical local-api account-removal routes and never issues DELETE', async () => {
    const barrierProof = {
      version: ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION,
      owner: preview.owner,
      previewFingerprint: preview.previewFingerprint,
      fencedResourceIds: [],
      drainedResourceIds: [],
    };
    const backupAuthorization = {
      outcome: 'explicitly-skipped',
      previewFingerprint: preview.previewFingerprint,
      dataFingerprint: 'e'.repeat(64),
      skipConfirmationCode: ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_CODE,
    };
    await previewAccountRemoval(preview.owner);
    await prepareAccountRemovalPreview(preview.owner);
    await releaseAccountRemovalPreview(preview.owner);
    await confirmAccountRemoval({
      preview,
      idempotencyKey: 'account-removal-client-idempotency-01',
      barrierProof,
      backupAuthorization,
    });
    await verifyAccountRemovalClientCleanup({ operationId: 'operation-1' });
    await recoverAccountRemoval(preview.owner);
    await recoverAccountRemovalDirectly(preview.owner);
    await getAccountRemovalOperation('operation/1');
    await resumeAccountRemovalOperation('operation/1');
    await listPendingAccountRemovals();

    expect(requestLocalApi).toHaveBeenCalledTimes(10);
    const calls = requestLocalApi.mock.calls;
    expect(calls.map(([path]) => path)).toEqual([
      '/api/account-removal/preview',
      '/api/account-removal/prepare-preview',
      '/api/account-removal/release-preview',
      '/api/account-removal/confirm',
      '/api/account-removal/client-verify',
      '/api/account-removal/recover',
      '/api/account-removal/recover-direct',
      '/api/account-removal/operations/operation%2F1',
      '/api/account-removal/operations/operation%2F1/resume',
      '/api/account-removal/pending',
    ]);
    expect(calls.every(([path]) => path.startsWith('/api/account-removal/'))).toBe(true);
    expect(calls.every(([, options]) => options.method !== 'DELETE')).toBe(true);
    expect(calls[3][1].body.confirmationCode).toBe(ACCOUNT_REMOVAL_CONFIRMATION_CODE);
    expect(calls[3][1].body.barrierProof).toBe(barrierProof);
    expect(calls[3][1].body.backupAuthorization).toBe(backupAuthorization);
  });
  it('encodes the read-only owner lookup and scopes direct resume to its existing operation id', async () => {
    await listPendingAccountRemovals({ owner: { ownerType: 'model_api_account', ownerId: 'model/a b' } });
    await resumeAccountRemovalOperation('old/task', { directDelete: true });
    await reportAccountRemovalClientFailure({ operationId: 'old/task', nonce: 'n', previewFingerprint: 'f', errorCode: 'RECOVERY_REMOTE_LOGIN_REQUIRED' });
    expect(requestLocalApi.mock.calls[0]).toEqual([
      '/api/account-removal/pending?ownerType=model_api_account&ownerId=model%2Fa%20b', expect.objectContaining({ method: 'GET' }),
    ]);
    expect(requestLocalApi.mock.calls[1]).toEqual([
      '/api/account-removal/operations/old%2Ftask/resume', expect.objectContaining({ method: 'POST', body: { directDelete: true } }),
    ]);
    expect(requestLocalApi.mock.calls[2][0]).toBe('/api/account-removal/client-failure');
    expect(requestLocalApi.mock.calls[2][1].body).not.toHaveProperty('owner');
  });
});

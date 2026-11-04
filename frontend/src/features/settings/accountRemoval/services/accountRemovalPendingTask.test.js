import { describe, expect, it, vi } from 'vitest';
import { accountRemovalGenerationKey, continuePendingAccountRemovalTask, lookupPendingAccountRemovalTask, readPendingAccountRemovalTask } from './accountRemovalPendingTask.js';

const owner = { ownerType: 'model_api_account', ownerId: 'synthetic-model' };
const pending = { operationId: 'synthetic-old-task', completed: false, previewFingerprint: 'c'.repeat(64),
  phase: 'external-delete-pending', pendingOwner: owner, pendingOwnerGeneration: null };

describe('pending removal operation resumption', () => {
  it('compares actual generation fields rather than property insertion order', () => {
    const first = { ownerId: 'a', clientId: 'client', profileId: 'profile', shopIncarnation: 'old', credentialRevision: 2 };
    const reordered = { credentialRevision: 2, shopIncarnation: 'old', profileId: 'profile', clientId: 'client', ownerId: 'a' };
    expect(accountRemovalGenerationKey(first)).toBe(accountRemovalGenerationKey(reordered));
    expect(accountRemovalGenerationKey(first)).not.toBe(accountRemovalGenerationKey({ ...reordered, shopIncarnation: 'new' }));
  });
  it('uses the server-filtered owner lookup and then a fresh exact operation read', async () => {
    const list = vi.fn().mockResolvedValue({ operations: [pending] });
    const read = vi.fn().mockResolvedValue(pending);
    expect((await lookupPendingAccountRemovalTask(owner, { list, read })).operation).toEqual(pending);
    expect(list).toHaveBeenCalledWith({ owner });
    expect(read).toHaveBeenCalledWith(pending.operationId);
    list.mockResolvedValue({ operations: [] });
    await expect(lookupPendingAccountRemovalTask(owner, { list, read })).rejects.toMatchObject({ code: 'ACCOUNT_REMOVAL_OPERATION_NOT_FOUND' });
  });
  it('fresh-reads only the selected operation and rejects missing recovery data', async () => {
    const read = vi.fn().mockResolvedValue(pending);
    expect(await readPendingAccountRemovalTask(pending, { read })).toEqual(pending);
    expect(read).toHaveBeenCalledWith(pending.operationId);
    read.mockResolvedValue({ ...pending, recoveryUnavailable: true });
    await expect(readPendingAccountRemovalTask(pending, { read })).rejects.toMatchObject({ code: 'ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE' });
  });
  it('establishes the fresh renderer/desktop barrier before resuming the same operation id', async () => {
    let release;
    const barrier = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const resumed = { ...pending, requiresClientCleanup: true, clientCleanup: { nonce: 'current-nonce', resourceIds: [] } };
    const resume = vi.fn().mockResolvedValue(resumed);
    const finishClientCleanup = vi.fn().mockResolvedValue({ operationId: pending.operationId, completed: true });
    const result = continuePendingAccountRemovalTask(pending, { barrier, resume, finishClientCleanup });
    expect(barrier).toHaveBeenCalledWith({ owner, previewFingerprint: pending.previewFingerprint });
    expect(resume).not.toHaveBeenCalled();
    release({});
    expect(await result).toMatchObject({ operationId: pending.operationId, completed: true });
    expect(resume).toHaveBeenCalledExactlyOnceWith(pending.operationId);
    expect(finishClientCleanup).toHaveBeenCalledWith(resumed, { owner, previewFingerprint: pending.previewFingerprint });
  });
  it('does not invent an owner for a completed task or accept a changed task id', async () => {
    const read = vi.fn().mockResolvedValue({ operationId: pending.operationId, completed: true });
    expect(await readPendingAccountRemovalTask(pending, { read })).not.toHaveProperty('pendingOwner');
    read.mockResolvedValue({ ...pending, operationId: 'different' });
    await expect(readPendingAccountRemovalTask(pending, { read })).rejects.toMatchObject({ code: 'ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE' });
  });
});

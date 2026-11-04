import { expect, it, vi } from 'vitest';
import { findAccountRemovalActivity, registerAccountRemovalActivity, releaseAccountRemovalActivity, updateAccountRemovalActivity } from './accountRemovalActivity.js';

it('delegates an existing operation but never steals a different active task', async () => {
  const instance = Symbol('one'), reader = Symbol('reader');
  const owner = { ownerType: 'model_api_account', ownerId: 'owner-a' };
  const resume = vi.fn().mockResolvedValue('joined');
  const entry = registerAccountRemovalActivity(instance, owner, resume);
  try {
    updateAccountRemovalActivity(instance, { operationId: 'operation-a' });
    expect(findAccountRemovalActivity(reader, { operationId: 'other-op', pendingOwner: { ...owner, ownerId: 'owner-b' } }).blocked).toBe(true);
    const selected = findAccountRemovalActivity(reader, { operationId: 'operation-a', pendingOwner: owner });
    expect(await selected.matching.resume({ operationId: 'operation-a' })).toBe('joined');
    expect(resume).toHaveBeenCalledTimes(1);
  } finally { releaseAccountRemovalActivity(instance, entry); }
});

it('ignores a stale callback or cleanup token after the same instance starts another task', async () => {
  const instance = Symbol('same-instance'), reader = Symbol('reader');
  const oldResume = vi.fn();
  const old = registerAccountRemovalActivity(instance, { ownerType: 'purchase_account', ownerId: 'old' }, oldResume);
  const next = registerAccountRemovalActivity(instance, { ownerType: 'purchase_account', ownerId: 'new' }, vi.fn());
  try {
    releaseAccountRemovalActivity(instance, old);
    expect(findAccountRemovalActivity(reader, { operationId: 'x', pendingOwner: { ownerType: 'purchase_account', ownerId: 'third' } }).blocked).toBe(true);
    expect(await old.resume({ operationId: 'old-op' })).toBeNull();
    expect(oldResume).not.toHaveBeenCalled();
  } finally { releaseAccountRemovalActivity(instance, next); }
  expect(findAccountRemovalActivity(reader, { operationId: 'x' }).blocked).toBe(false);
});

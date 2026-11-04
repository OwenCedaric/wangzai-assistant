import { expect, it, vi } from 'vitest';
import { filterCompletedOzonOwner, filterObservedAccountRemoval, observeAccountRemovalRow,
  observePendingAccountRemoval, publishAccountRemovalCompletion, subscribeAccountRemovalCompletion } from './accountRemovalCompletion.js';

it('filters only an observed old account binding and preserves unrelated unsaved forms and same-id replacements', () => {
  const owner = { ownerType: 'model_api_account', ownerId: 'model-old' };
  const start = { operationId: 'observed-binding-test', owner };
  const old = { id: 'model-old', savedAt: '2026-09-01', value: 'old' };
  const draft = { id: 'another-model', value: 'unsaved form input' };
  const observation = observeAccountRemovalRow([old, draft], start);
  const completed = { ...start, completed: true };
  expect(filterObservedAccountRemoval([{ ...old }, draft], observation, completed)).toEqual([draft]);
  expect(filterObservedAccountRemoval([{ ...old }, draft], observation, completed)[0]).toBe(draft);
  const rebound = { ...old, savedAt: '2026-09-05', value: 'new binding' };
  const current = [rebound, draft];
  expect(filterObservedAccountRemoval(current, observation, completed)).toBe(current);
  const legacy = { id: 'model-old' };
  const legacyObservation = observeAccountRemovalRow([legacy], start);
  const replacement = [{ ...legacy }];
  expect(filterObservedAccountRemoval(replacement, legacyObservation, completed)).toBe(replacement);
});

it('removes exactly the completed Ozon generation without touching a rebound same-id shop or other drafts', () => {
  const old = { id: 'shop-a', shopIncarnation: 'old', credentialRevision: 2, shopAlias: 'old shop' };
  const rebound = { ...old, shopIncarnation: 'new', credentialRevision: 1 };
  const other = { id: 'shop-b', shopAlias: 'unsaved alias' };
  const event = { completed: true, owner: { ownerType: 'ozon_shop', ownerId: old.id }, ownerGeneration: { ownerId: old.id, shopIncarnation: 'old', credentialRevision: 2 } };
  expect(filterCompletedOzonOwner([old, other], event)).toEqual([other]);
  const current = [rebound, other];
  expect(filterCompletedOzonOwner(current, event)).toBe(current);
  expect(filterCompletedOzonOwner([old], { ...event, completed: false })).toEqual([old]);
});

it('publishes completion only after verification and never replays the same operation into a later binding', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeAccountRemovalCompletion(listener);
  const owner = { ownerType: 'purchase_account', ownerId: 'event-owner' };
  try {
    observePendingAccountRemoval({ operationId: 'event-once-test', pendingOwner: owner });
    expect(publishAccountRemovalCompletion({ operationId: 'event-once-test', completed: false }, owner)).toBe(false);
    expect(publishAccountRemovalCompletion({ operationId: 'event-once-test', completed: true }, owner)).toBe(true);
    expect(publishAccountRemovalCompletion({ operationId: 'event-once-test', completed: true }, owner)).toBe(false);
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual(['observing', 'completed']);
  } finally { unsubscribe(); }
});

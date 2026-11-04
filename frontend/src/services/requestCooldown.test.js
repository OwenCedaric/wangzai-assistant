import { describe, expect, it } from 'vitest';
import {
  createRequestCooldownState,
  getRequestCooldownSnapshot,
  recordRequestFailure,
  recordRequestSuccess,
  shouldAttemptRequest,
} from './requestCooldown.js';

describe('requestCooldown', () => {
  it('blocks repeated failures until the cooldown expires', () => {
    const state = createRequestCooldownState({ now: () => 1000, baseCooldownMs: 5000 });

    expect(shouldAttemptRequest(state, 'image:1', 1000)).toBe(true);
    recordRequestFailure(state, 'image:1', { now: 1000 });
    expect(shouldAttemptRequest(state, 'image:1', 5999)).toBe(false);
    expect(shouldAttemptRequest(state, 'image:1', 6000)).toBe(true);
  });

  it('backs off repeated failures and clears on success', () => {
    const state = createRequestCooldownState({ now: () => 0, baseCooldownMs: 1000, maxCooldownMs: 3000 });

    recordRequestFailure(state, 'finance:1', { now: 0 });
    const second = recordRequestFailure(state, 'finance:1', { now: 100 });
    expect(second.attemptCount).toBe(2);
    expect(second.failedUntil).toBe(2100);
    expect(getRequestCooldownSnapshot(state)).toHaveLength(1);

    recordRequestSuccess(state, 'finance:1');
    expect(getRequestCooldownSnapshot(state)).toEqual([]);
  });
});

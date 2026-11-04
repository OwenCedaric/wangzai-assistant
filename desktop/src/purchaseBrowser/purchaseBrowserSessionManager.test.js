import assert from 'node:assert/strict';
import test from 'node:test';
import { createPurchaseBrowserSessionManager } from './purchaseBrowserSessionManager.js';

test('session manager isolates generations and enforces one active account session', () => {
  const manager = createPurchaseBrowserSessionManager({
    createSessionId: (() => { let index = 0; return () => `session-${++index}`; })(),
    now: (() => { let index = 0; return () => `time-${++index}`; })(),
  });
  const first = manager.createSession({ accountId: 'account-a', profilePath: 'profile-a' });
  assert.equal(first.generation, 1);
  assert.equal(manager.createSession({ accountId: 'account-a' }).sessionId, first.sessionId);
  assert.equal(manager.isCurrent(first.sessionId, first.generation), true);
  manager.invalidate(first.sessionId, 'crashed');
  const second = manager.createSession({ accountId: 'account-a', profilePath: 'profile-a' });
  assert.equal(second.generation, 2);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(manager.isCurrent(first.sessionId, first.generation), false);
  assert.equal(manager.isCurrent(second.sessionId, second.generation), true);
});

test('session manager retains target and fences removed sessions', () => {
  const manager = createPurchaseBrowserSessionManager();
  const session = manager.createSession({ accountId: 'account-b' });
  const target = { targetId: 'target-1', orderKey: 'order-1' };
  const updated = manager.updateSession(session.sessionId, { phase: 'ready', target, health: 'healthy' });
  assert.deepEqual(updated.target, target);
  assert.equal(updated.phase, 'ready');
  assert.equal(manager.removeSession(session.sessionId), true);
  assert.equal(manager.getSession(session.sessionId), null);
  assert.equal(manager.isCurrent(session.sessionId, session.generation), false);
});

test('session manager rejects illegal phase transitions instead of silently corrupting lifecycle state', () => {
  const manager = createPurchaseBrowserSessionManager();
  const session = manager.createSession({ accountId: 'account-c' });
  manager.updateSession(session.sessionId, { phase: 'opening' });
  assert.throws(
    () => manager.updateSession(session.sessionId, { phase: 'idle' }),
    /PURCHASE_BROWSER_SESSION_PHASE_INVALID/u,
  );
  assert.equal(manager.getSession(session.sessionId).phase, 'opening');
  manager.updateSession(session.sessionId, { phase: 'ready' });
  assert.equal(manager.getSession(session.sessionId).phase, 'ready');
});

test('one account keeps independent role sessions through ten close and reopen rounds', () => {
  let nextId = 0;
  const manager = createPurchaseBrowserSessionManager({
    createSessionId: () => `role-session-${++nextId}`,
  });
  const roles = ['interactive', 'market-collector', 'follow-seller-collector', 'product-link-parser'];
  const retained = new Map();
  for (const role of roles.slice(1)) {
    retained.set(role, manager.createSession({
      accountId: 'shared-account',
      sessionKey: `owner-${role}`,
      phase: 'ready',
    }));
  }
  for (let round = 0; round < 10; round += 1) {
    const interactive = manager.createSession({
      accountId: 'shared-account',
      sessionKey: 'owner-interactive',
      phase: 'ready',
    });
    assert.equal(new Set([
      interactive.sessionId,
      ...[...retained.values()].map((session) => session.sessionId),
    ]).size, roles.length);
    manager.invalidate(interactive.sessionId, 'closing');
    manager.removeSession(interactive.sessionId);
    for (const session of retained.values()) {
      assert.equal(manager.isCurrent(session.sessionId, session.generation), true);
    }
  }
});

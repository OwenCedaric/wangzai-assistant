import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS,
  ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS_VERSION,
  verifyAccountOwnershipSystemSourceFacts,
} from './accountOwnershipSystemSourceFacts.js';

const completionModule = new URL('../../../../frontend/src/features/settings/accountRemoval/services/accountRemovalCompletion.js', import.meta.url);

function currentScan() {
  const reviewed = ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS[0];
  return {
    sourceByFile: new Map([[reviewed.sourceFile, readFileSync(completionModule, 'utf8')]]),
    discoveredStateFacts: [{ sourceFile: reviewed.sourceFile, sourceSymbol: 'listeners', structured: { kind: 'set', declaration: 'listeners' } }],
  };
}

test('notification source sidecar is immutable, separate from deletion resources, and fails for source or discovery drift', () => {
  const scan = currentScan();
  const result = verifyAccountOwnershipSystemSourceFacts(scan);
  assert.equal(result.length, 1);
  assert.equal(result[0].version, ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS_VERSION);
  assert.equal(result[0].removable, false);
  assert.equal(result[0].ownerType, 'system');
  assert.equal(result[0].disposition, 'preserve system');
  assert.equal(result[0].deduplication.maximumEntries, 500);
  assert.ok(Object.isFrozen(ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS));
  assert.ok(Object.isFrozen(result[0].deduplication));
  assert.ok(Object.isFrozen(result[0].requiredSourceStatements));
  for (const discoveredStateFacts of [[], [...scan.discoveredStateFacts, ...scan.discoveredStateFacts], [{ ...scan.discoveredStateFacts[0], sourceSymbol: 'ownerMap' }]]) {
    assert.throws(() => verifyAccountOwnershipSystemSourceFacts({ ...scan, discoveredStateFacts }), /ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACT_DRIFT/u);
  }
});

test('real notification subscriptions are synchronous, duplicate-free, unsubscribe-owned and not replayed to future subscribers', async () => {
  const module = await import(`${completionModule.href}?system-fact-subscriptions`);
  const owner = { ownerType: 'purchase_account', ownerId: 'synthetic-notification-owner' };
  const events = [];
  const callback = (event) => events.push(event);
  const unsubscribe = module.subscribeAccountRemovalCompletion(callback);
  const unsubscribeDuplicate = module.subscribeAccountRemovalCompletion(callback);
  const completed = { operationId: 'synthetic-system-fact-op', completed: true };
  try {
    module.observePendingAccountRemoval({ ...completed, completed: false, pendingOwner: owner });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'observing');
    assert.equal(module.publishAccountRemovalCompletion(completed, owner), true);
    assert.equal(events.length, 2);
    assert.equal(module.publishAccountRemovalCompletion(completed, owner), false);
    unsubscribe();
    assert.equal(module.publishAccountRemovalCompletion({ ...completed, operationId: 'synthetic-unsubscribed-op' }, owner), true);
    assert.equal(events.length, 2);
  } finally {
    unsubscribe();
    unsubscribeDuplicate();
  }
  const laterEvents = [];
  const stop = module.subscribeAccountRemovalCompletion((event) => laterEvents.push(event));
  try {
    assert.equal(laterEvents.length, 0, 'registration must not replay any prior owner payload');
    assert.equal(module.publishAccountRemovalCompletion(completed, owner), false);
    assert.equal(laterEvents.length, 0);
  } finally { stop(); }
});

test('real operation-id deduplication has a 500-entry FIFO bound and retains no payload object as its identity', async () => {
  const module = await import(`${completionModule.href}?system-fact-bound`);
  const owner = { ownerType: 'model_api_account', ownerId: 'synthetic-bounded-owner' };
  const operation = (index) => ({ operationId: `synthetic-bounded-${index}`, completed: true });
  assert.equal(module.publishAccountRemovalCompletion({ ...operation(0), completed: false }, owner), false);
  for (let index = 0; index < 500; index += 1) {
    assert.equal(module.publishAccountRemovalCompletion(operation(index), owner), true);
  }
  assert.equal(module.publishAccountRemovalCompletion({ ...operation(0), syntheticDifferentPayload: true }, owner), false);
  assert.equal(module.publishAccountRemovalCompletion(operation(500), owner), true);
  assert.equal(module.publishAccountRemovalCompletion(operation(1), owner), false, 'the next oldest id remains within the 500-entry bound');
  assert.equal(module.publishAccountRemovalCompletion(operation(0), owner), true, 'the oldest id was evicted, not retained without bound');
});

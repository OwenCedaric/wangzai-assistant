import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesEmbeddedWorkbenchOwner } from '../runtime/desktopIpc.js';

test('ten stale workbench callbacks cannot hide or resize the current browser owner', () => {
  const owner = {
    requestKey: 'current-workbench',
    tabId: 'tab-current',
    sessionId: 'session-current',
    generation: 7,
  };
  assert.equal(matchesEmbeddedWorkbenchOwner(owner, owner), true);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(matchesEmbeddedWorkbenchOwner(owner, {
      requestKey: `stale-workbench-${index}`,
      tabId: `tab-stale-${index}`,
      sessionId: `session-stale-${index}`,
      generation: index + 1,
    }), false);
  }
});

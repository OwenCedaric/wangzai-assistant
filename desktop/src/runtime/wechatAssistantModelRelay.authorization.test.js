import assert from 'node:assert/strict';
import test from 'node:test';
import { createWechatAssistantModelRelay } from './wechatAssistantModelRelay.js';
import { createWechatAssistantReadonly } from './wechatAssistantReadonly.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const body = JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'same request' }] });
const completion = id => ({ response: { id, model: 'fixture-model', choices: [{ message: { role: 'assistant', content: id }, finish_reason: 'stop' }] }, billing: { chargedPoints: 3 } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const relay = createWechatAssistantModelRelay({ getSettings: () => ({ modelSource: 'builtin-points', modelName: 'fixture-model' }), ...options });
  const { baseUrl } = await relay.start();
  t.after(() => relay.stop());
  return { relay, grant: ownerScope => relay.setAuthorization({ authorized: true, ownerScope }),
    request: (token = relay.token, suffix = '/chat/completions', method = 'POST') => fetch(baseUrl + suffix, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body } : {}),
    }) };
}

test('anonymous authorization and old tokens fail closed; same-user relogin reuses only that owner result', async t => {
  const ids = [];
  const f = await fixture(t, { executeRequest: async ({ requestId }) => { ids.push(requestId); return completion(`result-${ids.length}`); } });
  assert.equal((await f.request()).status, 401);
  f.grant('anonymous');
  assert.equal((await f.request(undefined, '/models', 'GET')).status, 401);
  f.grant(A);
  const oldToken = f.relay.token;
  const first = await (await f.request()).json();
  f.relay.setAuthorization({ authorized: false });
  assert.equal((await f.request(oldToken)).status, 401);
  f.grant(B);
  assert.notEqual(f.relay.token, oldToken);
  assert.equal((await f.request(oldToken)).status, 401);
  const second = await (await f.request()).json();
  assert.notEqual(second.id, first.id);
  f.grant(A);
  const newToken = f.relay.token;
  assert.notEqual(newToken, oldToken);
  assert.equal((await (await f.request()).json()).id, first.id);
  f.grant(A);
  assert.equal(f.relay.token, newToken, 'same-user refreshed authorization does not create a new model attempt');
  assert.equal((await (await f.request()).json()).id, first.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('old in-flight results never reach another authorization generation or update its billing state', async t => {
  const started = deferred(), gate = deferred();
  let calls = 0;
  const billing = [];
  const f = await fixture(t, { executeRequest: async () => {
    calls += 1;
    if (calls === 1) { started.resolve(); return gate.promise; }
    return completion('private-b');
  }, onBillingResult: result => billing.push(result) });
  t.after(() => gate.resolve(completion('private-a')));
  f.grant(A);
  const oldRequest = f.request();
  await started.promise;
  f.relay.setAuthorization({ authorized: false });
  f.grant(B);
  assert.equal((await (await f.request()).json()).id, 'private-b');
  gate.resolve(completion('private-a'));
  const rejected = await oldRequest;
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, 'WECHAT_AUTHORIZATION_CHANGED');
  assert.equal(billing.length, 1);
  f.grant(A);
  assert.equal((await (await f.request()).json()).id, 'private-a');
  assert.equal(calls, 2, 'returning to A must not execute or charge the original A request again');
});

test('same-owner relogin joins the original pending model call without replaying it', async t => {
  const started = deferred(), gate = deferred();
  let calls = 0;
  const f = await fixture(t, { executeRequest: () => { calls += 1; started.resolve(); return gate.promise; } });
  t.after(() => gate.resolve(completion('same-owner-result')));
  f.grant(A);
  const original = f.request();
  await started.promise;
  f.relay.setAuthorization({ authorized: false });
  f.grant(A);
  const resumed = f.request();
  gate.resolve(completion('same-owner-result'));
  assert.equal((await original).status, 409);
  assert.equal((await (await resumed).json()).id, 'same-owner-result');
  assert.equal(calls, 1);
});

test('unknown dispatched outcomes remain no-retry after logout and same-owner relogin', async t => {
  let calls = 0;
  const f = await fixture(t, { executeRequest: async () => {
    calls += 1;
    throw Object.assign(new Error('unknown fixture result'), { status: 503, code: 'MODEL_CHANNEL_OUTCOME_UNKNOWN', outcome: 'unknown', retrySafe: false });
  } });
  f.grant(A);
  assert.equal((await f.request()).status, 503);
  f.relay.setAuthorization({ authorized: false }); f.grant(A);
  const repeated = await f.request();
  assert.equal(repeated.status, 503);
  assert.equal(repeated.headers.get('x-wangzai-retry-safe'), 'false');
  assert.equal(calls, 1);
});

test('readonly bridge rejects old in-flight data and cannot forward arbitrary or write routes', async t => {
  const started = deferred(), gate = deferred();
  const calls = [];
  const reader = createWechatAssistantReadonly({ executeRequest: request => { calls.push(request); started.resolve(); return gate.promise; } });
  const f = await fixture(t, { executeReadonlyRequest: reader, executeRequest: async () => completion('unused') });
  t.after(() => gate.resolve({ ok: true, data: { ok: true, shops: [] } }));
  assert.equal((await f.request(undefined, '/readonly/shops', 'GET')).status, 401);
  f.grant(A);
  assert.equal((await f.request(undefined, '/readonly/shops')).status, 404);
  assert.equal((await f.request(undefined, '/readonly/other?path=/api/write/products/confirm', 'GET')).status, 404);
  const pending = f.request(undefined, '/readonly/summary?path=/api/write/products/confirm', 'GET');
  await started.promise;
  f.grant(B);
  gate.resolve({ ok: true, data: { ok: true, shops: [{ id: 'private-a', name: 'private-a' }] } });
  const result = await pending;
  assert.equal(result.status, 409);
  assert.doesNotMatch(await result.text(), /private-a/);
  assert.deepEqual(calls.map(({ path, method }) => ({ path, method })), [{ path: '/api/shops', method: 'GET' }]);
});

test('a completed charged model result withheld after owner change never claims no dispatch or safe retry', async t => {
  let calls = 0, billingUpdates = 0;
  const f = await fixture(t, { executeRequest: async () => {
    calls += 1;
    const result = completion('completed-and-charged-for-a');
    f.grant(B);
    return result;
  }, onBillingResult: () => { billingUpdates += 1; } });
  f.grant(A);
  const withheld = await f.request();
  const rejected = await withheld.json();
  assert.equal(withheld.status, 409);
  assert.equal(withheld.headers.get('x-wangzai-retry-safe'), 'false');
  assert.equal(rejected.error.outcome, 'unknown');
  assert.equal(rejected.error.retry_safe, false);
  assert.equal(withheld.headers.get('x-wangzai-charged-points'), null, 'withholding a result must not fabricate a zero-charge receipt');
  assert.equal(billingUpdates, 0);
  f.grant(A);
  const recovered = await f.request();
  assert.equal((await recovered.json()).id, 'completed-and-charged-for-a');
  assert.equal(recovered.headers.get('x-wangzai-charged-points'), '3');
  assert.equal(calls, 1);
});

test('an authorization assertion after execution started keeps the unknown-result dedupe record', async t => {
  let calls = 0;
  const f = await fixture(t, { executeRequest: async ({ assertAuthorizationCurrent }) => {
    calls += 1;
    f.grant(B); // Simulated model work may already have run; no pre-dispatch proof remains.
    assertAuthorizationCurrent();
    return completion('must-not-deliver');
  } });
  f.grant(A);
  const first = await f.request();
  assert.equal((await first.json()).error.outcome, 'unknown');
  f.grant(A);
  const retry = await f.request();
  const error = (await retry.json()).error;
  assert.equal(error.outcome, 'unknown');
  assert.equal(error.retry_safe, false);
  assert.equal(calls, 1, 'the started executor must not be invoked a second time after relogin');
});

test('authorization lost before the executor starts retains a proven not-dispatched response', async t => {
  let requests = 0, observations = 0;
  const f = await fixture(t, { onConversationRequest: () => { if (++observations === 1) f.grant(B); },
    executeRequest: async () => { requests += 1; return completion('first-actual-execution'); } });
  f.grant(A);
  const canceled = await f.request();
  const error = (await canceled.json()).error;
  assert.equal(error.outcome, 'not-dispatched');
  assert.equal(error.retry_safe, true);
  assert.equal(requests, 0);
  f.grant(A);
  assert.equal((await (await f.request()).json()).id, 'first-actual-execution');
  assert.equal(requests, 1);
});

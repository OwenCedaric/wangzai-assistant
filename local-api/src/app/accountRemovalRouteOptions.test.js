import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createAccountRemovalRoute } from './accountRemovalRoute.js';

test('resume options bind direct mode to the exact URL operation and reject extra authority', async t => {
  const runs = [];
  const lookups = [];
  const handle = createAccountRemovalRoute({ orchestrator: {
    runOperation(operationId, options) {
      runs.push({ operationId, options });
      return { ok: true, completed: false, operationId };
    },
    listPending(owner) { lookups.push(owner); return []; },
  } });
  const server = createServer((req, res) => {
    if (!handle({ req, res, requestUrl: new URL(req.url, 'http://127.0.0.1'), corsHeaders: {} })) {
      res.writeHead(404); res.end();
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `${base}/api/account-removal/operations/original-operation/resume`;
  for (const body of [undefined, {}, { directDelete: true }, { directDelete: false }]) {
    const response = await fetch(route, { method: 'POST', ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).operationId, 'original-operation');
  }
  assert.deepEqual(runs, [false, false, true, false].map(directDelete => ({
    operationId: 'original-operation', options: { directDelete },
  })));
  for (const body of [{ directDelete: 'true' }, { directDelete: true, operationId: 'next-operation' },
    { owner: { ownerType: 'ozon_shop', ownerId: 'other-owner' } }, [], null]) {
    const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'ACCOUNT_REMOVAL_RESUME_OPTIONS_INVALID');
  }
  assert.equal(runs.length, 4);
  for (const query of ['', '?ownerType=model_api_account&ownerId=exact%20owner']) {
    const response = await fetch(`${base}/api/account-removal/pending${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).operations, []);
  }
  assert.deepEqual(lookups, [undefined, { ownerType: 'model_api_account', ownerId: 'exact owner' }]);
  assert.equal(runs.length, 4, 'read-only lookup must not advance any deletion');
});

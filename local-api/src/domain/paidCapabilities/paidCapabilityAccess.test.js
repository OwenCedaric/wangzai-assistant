import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPaidCapabilityAccess,
  paidCapabilityContextFromRequest,
  PAID_CAPABILITY_ACCESS_TOKEN_HEADER,
} from './paidCapabilityAccess.js';

test('extracts only main-process injected paid access context', () => {
  assert.deepEqual(
    paidCapabilityContextFromRequest({
      headers: {
        [PAID_CAPABILITY_ACCESS_TOKEN_HEADER]: ' signed-license-token ',
        'x-request-id': ' renderer-request-1 ',
      },
    }),
    { accessToken: 'signed-license-token', requestId: 'renderer-request-1' },
  );
});

test('uses a stable idempotency key for the same capability and request id', async () => {
  const observed = [];
  const access = createPaidCapabilityAccess({
    runtime: {
      client: {
        executePaid: async (request, context) => {
          observed.push({ request, context });
          return { chargedPoints: 3, result: { content: 'ok' } };
        },
      },
    },
  });
  const input = { systemPrompt: 'system', userPrompt: 'user' };
  await access.execute({
    capability: 'text.product-description',
    input,
    context: { accessToken: 'token', requestId: 'request-123' },
  });
  await access.execute({
    capability: 'text.product-description',
    input,
    context: { accessToken: 'token', requestId: 'request-123' },
  });
  assert.equal(observed.length, 2);
  assert.equal(observed[0].request.idempotencyKey, observed[1].request.idempotencyKey);
  assert.match(observed[0].request.idempotencyKey, /^paid:[0-9a-f]{64}$/u);
  assert.equal(observed[0].context.accessToken, 'token');
});

test('separates idempotency keys by capability', async () => {
  const keys = [];
  const access = createPaidCapabilityAccess({
    runtime: {
      client: {
        executePaid: async (request) => {
          keys.push(request.idempotencyKey);
          return { result: {} };
        },
      },
    },
  });
  for (const capability of ['text.product-description', 'text.data-analysis']) {
    await access.execute({
      capability,
      input: { systemPrompt: 'system', userPrompt: 'user' },
      context: { accessToken: 'token', requestId: 'same-request' },
    });
  }
  assert.notEqual(keys[0], keys[1]);
});

test('fails closed when authenticated access token is absent', async () => {
  let called = false;
  const access = createPaidCapabilityAccess({
    runtime: { client: { executePaid: async () => { called = true; } } },
  });
  await assert.rejects(
    access.execute({ capability: 'text.product-description', input: {}, context: {} }),
    (error) => error.code === 'PAID_CAPABILITY_AUTH_UNAVAILABLE' && error.statusCode === 401,
  );
  assert.equal(called, false);
});

test('fails closed when signed paid runtime is unavailable', async () => {
  const access = createPaidCapabilityAccess({ runtime: { client: {} } });
  await assert.rejects(
    access.execute({
      capability: 'text.product-description',
      input: {},
      context: { accessToken: 'token' },
    }),
    (error) => error.code === 'PAID_CAPABILITY_RUNTIME_UNAVAILABLE' && error.statusCode === 503,
  );
});

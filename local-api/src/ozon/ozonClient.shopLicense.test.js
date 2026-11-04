import assert from 'node:assert/strict';
import test from 'node:test';

import { createOzonClient } from './ozonClient.js';

function successResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    async text() {
      return JSON.stringify({ result: [] });
    },
  };
}

test('blocks Ozon reads before transport when the exact shop grant is absent', async () => {
  let transportCalls = 0;
  const client = createOzonClient({
    retry: { maxAttempts: 1 },
    transport: async () => {
      transportCalls += 1;
      return successResponse();
    },
    authorizeClientId(clientId) {
      const error = new Error(`not entitled: ${clientId}`);
      error.code = 'SHOP_LICENSE_REQUIRED';
      error.retryable = false;
      throw error;
    },
  });

  await assert.rejects(
    client.requestReadOnly({
      endpointKey: 'shop.sellerInfo',
      shopCredentials: { clientId: 'expired-client', apiKey: 'secret' },
    }),
    (error) => error?.code === 'SHOP_LICENSE_REQUIRED',
  );
  assert.equal(transportCalls, 0);
});

test('checks the same exact grant before Ozon reads and writes', async () => {
  const checks = [];
  let transportCalls = 0;
  const client = createOzonClient({
    retry: { maxAttempts: 1 },
    writeRetry: { maxAttempts: 1 },
    transport: async () => {
      transportCalls += 1;
      return successResponse();
    },
    authorizeClientId(clientId, context) {
      assert.equal(clientId, 'active-client');
      checks.push(context);
    },
  });

  await client.requestReadOnly({
    endpointKey: 'shop.sellerInfo',
    shopCredentials: { clientId: 'active-client', apiKey: 'secret' },
  });
  await client.requestWrite({
    endpointKey: 'products.import',
    shopCredentials: { clientId: 'active-client', apiKey: 'secret' },
    payload: { items: [] },
  });

  assert.equal(transportCalls, 2);
  assert.deepEqual(checks.map((item) => item.operation), ['read', 'write']);
});

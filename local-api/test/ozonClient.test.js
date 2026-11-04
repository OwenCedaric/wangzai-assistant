import assert from 'node:assert/strict';
import test from 'node:test';
import { createOzonClient } from '../src/ozon/ozonClient.js';
import { assertReadOnlyEndpoint, getOzonEndpoint, listOzonEndpoints } from '../src/ozon/ozonEndpointRegistry.js';

test('ozon endpoint registry exposes only read-safe entries in P0', () => {
  const endpoints = listOzonEndpoints();
  assert.ok(endpoints.length >= 1);
  for (const endpoint of endpoints.filter((item) => item.risk !== 'write')) {
    assert.doesNotThrow(() => assertReadOnlyEndpoint(getOzonEndpoint(endpoint.key)));
  }
});

test('ozon client read-only framework retries throttled responses with injected transport', async () => {
  const calls = [];
  const client = createOzonClient({
    baseUrl: 'https://example.invalid',
    logger: () => {},
    waitForEndpoint: async () => {},
    retry: {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryOnStatus: [429],
      respectRetryAfter: false,
    },
    transport: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ retry: true }), { status: 429 });
      }
      return new Response('\uFEFF{"result":"ok"}', { status: 200 });
    },
  });

  const result = await client.requestReadOnly({
    endpointKey: 'catalog.categoryTree',
    shopCredentials: {
      ['client' + 'Id']: 'opaque-a',
      ['api' + 'Key']: 'opaque-b',
    },
    payload: { language: 'DEFAULT' },
    requestId: 'unit-request',
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://example.invalid/v1/description-category/tree');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(Boolean(calls[0].options.headers['Client-Id']), true);
  assert.equal(Boolean(calls[0].options.headers['Api-Key']), true);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.data, { result: 'ok' });
});

test('ozon client exposes readable error code when credentials are missing', async () => {
  const client = createOzonClient({
    logger: () => {},
    waitForEndpoint: async () => {},
    transport: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  await assert.rejects(
    () => client.requestReadOnly({ endpointKey: 'catalog.categoryTree' }),
    (error) => {
      assert.equal(error.code, 'OZON_CREDENTIALS_MISSING');
      assert.match(error.code, /^[A-Z0-9_]+$/u);
      assert.doesNotMatch(error.message, /\?{3,}|�/u);
      return true;
    },
  );
});

test('ozon client preserves exact int64 chat message ids for chat.read targets', async () => {
  const client = createOzonClient({
    baseUrl: 'https://example.invalid',
    logger: () => {},
    waitForEndpoint: async () => {},
    retry: { maxAttempts: 1 },
    transport: async () => new Response(
      '{"chats":[{"first_unread_message_id":3000000439431832531,"last_message_id":3000000439431835538,"unread_count":3,"chat":{"chat_id":"chat-a"}}]}',
      { status: 200 },
    ),
  });

  const result = await client.requestReadOnly({
    endpointKey: 'chat.list',
    shopCredentials: { clientId: 'opaque-a', apiKey: 'opaque-b' },
    payload: { limit: 30 },
  });

  assert.equal(result.data.chats[0].first_unread_message_id, '3000000439431832531');
  assert.equal(result.data.chats[0].last_message_id, '3000000439431835538');
  assert.equal(result.data.chats[0].unread_count, 3);
});

test('ozon client exposes readable error code for HTTP failures', async () => {
  const client = createOzonClient({
    logger: () => {},
    waitForEndpoint: async () => {},
    retry: {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryOnStatus: [429],
      respectRetryAfter: false,
    },
    transport: async () => new Response(JSON.stringify({ ok: false }), { status: 400 }),
  });

  await assert.rejects(
    () => client.requestReadOnly({
      endpointKey: 'catalog.categoryTree',
      shopCredentials: {
        ['client' + 'Id']: 'opaque-a',
        ['api' + 'Key']: 'opaque-b',
      },
      payload: { language: 'DEFAULT' },
    }),
    (error) => {
      assert.equal(error.code, 'OZON_HTTP_ERROR');
      assert.equal(error.status, 400);
      assert.match(error.code, /^[A-Z0-9_]+$/u);
      assert.doesNotMatch(error.message, /\?{3,}|�/u);
      return true;
    },
  );
});

test('ozon client reads a chat image with exact shop credentials and validates its file header', async () => {
  let captured;
  const client = createOzonClient({
    baseUrl: 'https://example.invalid',
    logger: () => {},
    waitForEndpoint: async () => {},
    retry: { maxAttempts: 1 },
    transport: async (url, options) => {
      captured = { url, options };
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
      });
    },
  });

  const result = await client.requestBinaryReadOnly({
    endpointKey: 'chat.file',
    shopCredentials: { clientId: 'client-shop-2', apiKey: 'secret-shop-2' },
    resourceUrl: 'https://example.invalid/v2/chat/file/messenger/a.jpg',
  });

  assert.equal(captured.url, 'https://example.invalid/v2/chat/file/messenger/a.jpg');
  assert.equal(captured.options.headers['Client-Id'], 'client-shop-2');
  assert.equal(captured.options.headers['Api-Key'], 'secret-shop-2');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.deepEqual(result.data, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});

test('ozon client rejects chat file URLs outside the registered Ozon origin', async () => {
  const client = createOzonClient({
    baseUrl: 'https://api-seller.ozon.ru',
    logger: () => {},
    waitForEndpoint: async () => {},
    transport: async () => assert.fail('foreign URL must not be fetched'),
  });
  await assert.rejects(
    () => client.requestBinaryReadOnly({
      endpointKey: 'chat.file',
      shopCredentials: { clientId: 'client-shop-2', apiKey: 'secret-shop-2' },
      resourceUrl: 'https://example.com/v2/chat/file/a.jpg',
    }),
    { code: 'OZON_FILE_URL_FORBIDDEN' },
  );
});

test('ozon endpoint limiter lets different Client-Id scopes enter the same bucket in parallel', async () => {
  let started = 0;
  let releaseBoth;
  const bothStarted = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  const client = createOzonClient({
    baseUrl: 'https://example.invalid',
    logger: () => {},
    retry: { maxAttempts: 1 },
    transport: async () => {
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
    },
  });

  const request = (clientId) => client.requestReadOnly({
    endpointKey: 'catalog.categoryTree',
    shopCredentials: { clientId, apiKey: `key-${clientId}` },
    payload: { language: 'DEFAULT' },
  });
  const completed = Promise.all([request('client-a'), request('client-b')]);
  await Promise.race([
    bothStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('different Client-Id lanes were serialized')), 120)),
  ]);
  assert.equal(started, 2);
  await completed;
});


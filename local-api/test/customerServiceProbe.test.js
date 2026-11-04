import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerServiceService } from '../src/domain/customerService/customerServiceService.js';

function createFakeScheduler(response = { ok: true, status: 'success', data: { chats: [] }, jobId: 'job-customer-1' }) {
  const calls = [];
  return {
    calls,
    async executeReadOnly(input) {
      calls.push(input);
      return response;
    },
    readCache() {
      return { ok: true, rows: [] };
    },
  };
}

test('customer service probe clamps review and question list limits to Ozon allowed minimum', async () => {
  const scheduler = createFakeScheduler({ ok: true, status: 'success', data: { reviews: [] }, jobId: 'job-review' });
  const service = createCustomerServiceService({ ozonScheduler: scheduler });

  const review = await service.probeRead({
    shopId: 'ozon-shop-1',
    endpointKey: 'review.list',
    limit: 5,
    offset: 0,
  });
  assert.equal(review.ok, true);
  assert.equal(scheduler.calls[0].endpointKey, 'review.list');
  assert.equal(scheduler.calls[0].params.limit, 20);
  assert.equal(scheduler.calls[0].params.offset, 0);

  await service.probeRead({
    shopId: 'ozon-shop-1',
    endpointKey: 'question.list',
    params: { limit: 1, offset: 3 },
  });
  assert.equal(scheduler.calls[1].endpointKey, 'question.list');
  assert.equal(scheduler.calls[1].params.limit, 20);
  assert.equal(scheduler.calls[1].params.offset, 3);
});

test('customer service probe blocks write endpoints and requires chat id for history', async () => {
  const scheduler = createFakeScheduler();
  const service = createCustomerServiceService({ ozonScheduler: scheduler });

  const write = await service.probeRead({
    shopId: 'ozon-shop-1',
    endpointKey: 'chat.sendMessage',
    text: 'hello',
  });
  assert.equal(write.ok, false);
  assert.equal(write.error.code, 'CUSTOMER_SERVICE_ENDPOINT_NOT_ALLOWED');
  assert.equal(scheduler.calls.length, 0);

  const history = await service.probeRead({
    shopId: 'ozon-shop-1',
    endpointKey: 'chat.history',
  });
  assert.equal(history.ok, false);
  assert.equal(history.error.code, 'CHAT_ID_REQUIRED');
  assert.equal(scheduler.calls.length, 0);
});

test('customer service probe reads scheduler cache payload and bypasses fixed idempotency on force refresh', async () => {
  const scheduler = createFakeScheduler({
    ok: true,
    status: 'success',
    cache: { payload_json: JSON.stringify({ chats: [{ chat: { chat_id: 'chat-1' } }] }) },
    jobId: 'job-cache',
  });
  const service = createCustomerServiceService({ ozonScheduler: scheduler });

  const cached = await service.probeRead({
    shopId: 'ozon-shop-1',
    endpointKey: 'chat.list',
    limit: 20,
    offset: 0,
  });
  assert.equal(cached.ok, true);
  assert.equal(cached.rowCount, 1);
  assert.match(scheduler.calls[0].idempotencyKey, /^customer-service-probe:ozon-shop-1:chat\.list:/);

  await service.probeRead({
    shopId: 'ozon-shop-1',
    endpointKey: 'chat.list',
    limit: 20,
    offset: 0,
    forceRefresh: true,
  });
  assert.equal(scheduler.calls[1].forceRefresh, true);
  assert.equal(scheduler.calls[1].idempotencyKey, undefined);
});

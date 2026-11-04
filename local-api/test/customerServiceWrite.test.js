import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerServiceWriteService } from '../src/domain/customerService/customerServiceWriteService.js';

function createContext(overrides = {}) {
  return {
    preview: {
      previewId: 'preview-1',
      shopId: 'ozon-shop-1',
      endpointKey: 'chat.sendMessage',
      action: 'customerService.chat.sendMessage',
      payload: { chat_id: 'chat-live-1', text: 'Здравствуйте!' },
      ...overrides.preview,
    },
    input: {
      shopId: 'ozon-shop-1',
      endpointKey: 'chat.sendMessage',
      action: 'customerService.chat.sendMessage',
      payload: { chat_id: 'chat-live-1', text: 'Здравствуйте!' },
      realWrite: true,
      dryRun: false,
      ...overrides.input,
    },
  };
}

test('customer service send uses write queue and only completes after chat history readback', async () => {
  const calls = [];
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite(input) {
        calls.push({ type: 'write', input });
        return {
          ok: true,
          realWrite: true,
          dryRun: false,
          data: { result: { message_id: 'message-101' } },
        };
      },
      async executeReadOnly(input) {
        calls.push({ type: 'read', input });
        return {
          ok: true,
          data: {
            messages: [
              {
                message_id: 'message-101',
                user: { type: 'Seller' },
                data: ['Здравствуйте!'],
              },
            ],
          },
        };
      },
    },
  });

  const result = await service.executeConfirmedWrite(createContext());

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'readback_confirmed');
  assert.equal(result.readBack.status, 'success');
  assert.deepEqual(calls.map((call) => call.type), ['write', 'read']);
  assert.deepEqual(calls[0].input.params, { chat_id: 'chat-live-1', text: 'Здравствуйте!' });
  assert.equal(calls[1].input.endpointKey, 'chat.history');
});

test('customer service send stays pending when Ozon history does not contain the reply', async () => {
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite() {
        return { ok: true, realWrite: true, dryRun: false, data: { result: { message_id: 'message-102' } } };
      },
      async executeReadOnly() {
        return { ok: true, data: { messages: [] } };
      },
    },
  });

  const result = await service.executeConfirmedWrite(createContext());

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'submitted_waiting_readback');
  assert.equal(result.readBack.status, 'pending');
});

test('customer service send rejects endpoint replacement', async () => {
  const service = createCustomerServiceWriteService({
    ozonScheduler: { executeWrite: async () => ({ ok: true }) },
  });

  const result = await service.executeConfirmedWrite(
    createContext({ input: { endpointKey: 'chat.sendFile' } })
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CUSTOMER_SERVICE_WRITE_ENDPOINT_MISMATCH');
});

test('customer service mark-all-read uses Ozon chat.read and exact unread readback', async () => {
  const calls = [];
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite(input) {
        calls.push({ type: 'write', input });
        return {
          ok: true,
          realWrite: true,
          dryRun: false,
          data: { unread_count: 0 },
        };
      },
      async executeReadOnly(input) {
        calls.push({ type: 'read', input });
        throw new Error('chat.list must not be called for mark-read confirmation');
      },
    },
  });

  const chats = [{
    chat_id: 'chat-live-1',
    first_unread_message_id: '3000000000118032000',
    unread_count: 3,
  }];
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: 'preview-read-1',
      shopId: 'ozon-shop-1',
      endpointKey: 'chat.read',
      action: 'customerService.chat.markAllRead',
      payload: { chats },
    },
    input: {
      shopId: 'ozon-shop-1',
      endpointKey: 'chat.read',
      action: 'customerService.chat.markAllRead',
      payload: { chats },
      realWrite: true,
      dryRun: false,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'success');
  assert.deepEqual(calls[0].input.params, {
    chat_id: 'chat-live-1',
    from_message_id: '3000000000118032000',
  });
  assert.equal(result.readBack.source, 'chat.read');
  assert.equal(calls.length, 1);
});

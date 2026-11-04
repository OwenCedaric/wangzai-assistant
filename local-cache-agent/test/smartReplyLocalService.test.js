import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalSmartReplyService } from '../src/smartReply/localService.js';
import { createLocalCacheStore } from '../src/store.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-local-smart-reply-'));
  const store = createLocalCacheStore({
    databasePath: path.join(root, 'cache.sqlite'),
    assetRoot: path.join(root, 'assets'),
    encryptionKey: crypto.randomBytes(32),
  });
  let clock = new Date('2026-08-24T10:00:00.000Z');
  const calls = [];
  const postingsByClientId = new Map();
  const listErrorsByClientId = new Map();
  const service = createLocalSmartReplyService({
    store,
    now: () => new Date(clock),
    ozonClientFactory: ({ shop }) => ({
      async listRecentPostings() {
        calls.push({ type: 'list', clientId: shop.clientId });
        if (listErrorsByClientId.has(shop.clientId)) {
          throw listErrorsByClientId.get(shop.clientId);
        }
        return postingsByClientId.get(shop.clientId) || [];
      },
      async readPosting(postingNumber) {
        calls.push({ type: 'get', clientId: shop.clientId, postingNumber });
        const posting = (postingsByClientId.get(shop.clientId) || [])
          .find((row) => row.posting_number === postingNumber);
        return { posting, source: 'FBS' };
      },
      async hasReturnOrRefund() {
        calls.push({ type: 'returns', clientId: shop.clientId });
        return false;
      },
      async startChat(postingNumber) {
        calls.push({ type: 'start', clientId: shop.clientId, postingNumber });
        return `chat-${postingNumber}`;
      },
      async sendMessage(chatId, message) {
        calls.push({ type: 'send', clientId: shop.clientId, chatId, message });
        return `message-${chatId}`;
      },
      async history(chatId) {
        const sent = calls.findLast((call) => call.type === 'send' && call.chatId === chatId);
        calls.push({ type: 'history', clientId: shop.clientId, chatId });
        return [{ id: `message-${chatId}`, data: sent?.message, user: { type: 'seller' } }];
      },
    }),
  });

  function request(input = {}) {
    return service.handle({
      method: input.method || 'GET',
      pathname: input.pathname,
      searchParams: new URLSearchParams(input.search || ''),
      payload: input.payload || {},
      scopeId: input.scopeId || 'user-1',
    });
  }

  return {
    root,
    store,
    service,
    calls,
    postingsByClientId,
    listErrorsByClientId,
    request,
    setClock(value) { clock = new Date(value); },
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function saveShop(store, scopeId, { id, clientId, apiKey = 'secret' }) {
  store.putRecord({
    scopeId,
    namespace: 'shops',
    key: id,
    payload: {
      id,
      name: `店铺 ${clientId}`,
      alias: `店铺 ${clientId}`,
      status: 'active',
      clientId,
      apiKey,
      updatedAt: '2026-08-24T09:00:00.000Z',
    },
  });
  const current = store.getRecord({
    scopeId,
    namespace: 'smart-reply-shop-entitlements',
    key: 'current',
  })?.payload?.grants || [];
  store.putRecord({
    scopeId,
    namespace: 'smart-reply-shop-entitlements',
    key: 'current',
    payload: {
      grants: [
        ...current.filter((grant) => grant.clientId !== clientId),
        { clientId, expireAt: '2027-08-24T10:00:00.000Z' },
      ],
      updatedAt: '2026-08-24T09:00:00.000Z',
    },
  });
}

test('local mode stores rules per user, sends a fixed template once, and never calls a model', async () => {
  const f = fixture();
  try {
    saveShop(f.store, 'user-1', { id: 'shop-1', clientId: '10001' });
    f.postingsByClientId.set('10001', [{
      posting_number: '10001-1',
      status: 'delivering',
      substatus: 'posting_in_carriage',
      in_process_at: '2026-08-24T10:00:00.000Z',
      analytics_data: { buyer_name: 'Анна' },
      products: [{ name: 'Чехол' }],
      tracking_number: 'TRACK-100',
    }]);

    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'local' } });
    const saved = await f.request({
      method: 'POST',
      pathname: '/api/smart-reply/local/rules',
      payload: {
        scene: 'shipmentNotice',
        shop_client_ids: ['10001'],
        send_time_type: 'immediate',
        template_id: 'shipment-1',
        message_template: 'Здравствуйте, {{买家昵称}}! {{产品名称}} {{运单号}}',
        message_template_zh: '发货通知',
        enabled: true,
      },
    });
    assert.equal(saved.payload.enabled, true);

    await f.service.runCycle();
    const tasks = await f.request({ pathname: '/api/smart-reply/local/tasks' });
    assert.equal(tasks.payload.total, 1);
    assert.equal(tasks.payload.items[0].status, 'sent');
    assert.equal(f.calls.filter((call) => call.type === 'send').length, 1);
    assert.match(f.calls.find((call) => call.type === 'send').message, /Анна! Чехол TRACK-100/u);
    assert.equal(f.calls.some((call) => call.type === 'model'), false);

    await f.service.runCycle();
    assert.equal(f.calls.filter((call) => call.type === 'send').length, 1, 'same shop/posting/scene must be idempotent');
  } finally {
    f.close();
  }
});

test('switching to local mode immediately starts software monitoring without waiting for the interval', async () => {
  const f = fixture();
  try {
    saveShop(f.store, 'user-1', { id: 'shop-local-switch', clientId: '11001' });
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'local' } });
    await f.request({
      method: 'POST',
      pathname: '/api/smart-reply/local/rules',
      payload: {
        scene: 'shipmentNotice',
        shop_client_ids: ['11001'],
        send_time_type: 'immediate',
        template_id: 'shipment-local-switch',
        message_template: 'Заказ {{货件编号}} отправлен',
        enabled: true,
      },
    });
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'cloud' } });
    f.postingsByClientId.set('11001', [{
      posting_number: '11001-1',
      status: 'delivering',
      substatus: 'posting_in_carriage',
      in_process_at: '2026-08-24T10:00:00.000Z',
    }]);

    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'local' } });
    for (let attempt = 0; attempt < 20 && !f.calls.some((call) => call.type === 'send'); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(f.calls.filter((call) => call.type === 'send').length, 1);
    const status = await f.request({ pathname: '/api/smart-reply/local/status' });
    assert.equal(status.payload.polling_active, true);
  } finally {
    await f.service.stop();
    f.close();
  }
});

test('enabling a local rule immediately establishes the order baseline', async () => {
  const f = fixture();
  try {
    saveShop(f.store, 'user-1', { id: 'shop-enable', clientId: '11501' });
    f.postingsByClientId.set('11501', [{
      posting_number: '11501-1',
      status: 'delivering',
      substatus: 'posting_in_carriage',
      in_process_at: '2026-08-20T10:00:00.000Z',
    }]);
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'local' } });
    await f.request({
      method: 'POST',
      pathname: '/api/smart-reply/local/rules',
      payload: {
        scene: 'shipmentNotice',
        shop_client_ids: ['11501'],
        template_id: 'shipment-enable',
        message_template: 'Заказ {{货件编号}} отправлен',
        enabled: true,
      },
    });
    for (let attempt = 0; attempt < 20 && !f.calls.some((call) => call.type === 'list'); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(f.calls.some((call) => call.type === 'list' && call.clientId === '11501'), true);
  } finally {
    await f.service.stop();
    f.close();
  }
});

test('a failed shop scan remains visible instead of being reported as a successful cycle', async () => {
  const f = fixture();
  try {
    saveShop(f.store, 'user-1', { id: 'shop-failed-scan', clientId: '11601' });
    f.listErrorsByClientId.set('11601', Object.assign(new Error('Ozon 临时不可用'), {
      code: 'SMART_REPLY_OZON_TEMPORARY_FAILURE',
    }));
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'local' } });
    await f.request({
      method: 'POST',
      pathname: '/api/smart-reply/local/rules',
      payload: {
        scene: 'shipmentNotice',
        shop_client_ids: ['11601'],
        template_id: 'shipment-failed-scan',
        message_template: 'Заказ {{货件编号}} отправлен',
        enabled: true,
      },
    });
    await f.service.runCycle();
    for (let attempt = 0; attempt < 20 && !f.calls.some((call) => call.type === 'list'); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    let status = await f.request({ pathname: '/api/smart-reply/local/status' });
    for (let attempt = 0; attempt < 20 && !status.payload.last_error_code; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      status = await f.request({ pathname: '/api/smart-reply/local/status' });
    }
    assert.equal(status.payload.last_error_code, 'SMART_REPLY_OZON_TEMPORARY_FAILURE');
    assert.equal(status.payload.last_error_message, 'Ozon 临时不可用');
    assert.equal(status.payload.last_success_at, '');
  } finally {
    await f.service.stop();
    f.close();
  }
});

test('cloud mode keeps the local worker idle and local mode isolates user scopes', async () => {
  const f = fixture();
  try {
    saveShop(f.store, 'user-a', { id: 'shop-a', clientId: '20001' });
    saveShop(f.store, 'user-b', { id: 'shop-b', clientId: '20002' });
    f.postingsByClientId.set('20001', [{
      posting_number: 'A-1',
      status: 'delivering',
      substatus: 'posting_in_pickup_point',
      in_process_at: '2026-08-24T10:00:00.000Z',
    }]);
    f.postingsByClientId.set('20002', [{
      posting_number: 'B-1',
      status: 'delivering',
      substatus: 'posting_in_pickup_point',
      in_process_at: '2026-08-24T10:00:00.000Z',
    }]);
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', scopeId: 'user-a', payload: { mode: 'local' } });
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', scopeId: 'user-b', payload: { mode: 'cloud' } });
    for (const [scopeId, clientId] of [['user-a', '20001'], ['user-b', '20002']]) {
      await f.request({
        method: 'POST',
        pathname: '/api/smart-reply/local/rules',
        scopeId,
        payload: {
          scene: 'pickupReminder',
          shop_client_ids: [clientId],
          template_id: 'pickup-1',
          message_template: 'Заказ {{货件编号}} готов',
          enabled: scopeId === 'user-a',
        },
      });
    }

    await f.service.runCycle();
    assert.equal(f.calls.some((call) => call.clientId === '20001'), true);
    assert.equal(f.calls.some((call) => call.clientId === '20002'), false);
    assert.equal((await f.request({ pathname: '/api/smart-reply/local/tasks', scopeId: 'user-a' })).payload.total, 1);
    assert.equal((await f.request({ pathname: '/api/smart-reply/local/tasks', scopeId: 'user-b' })).payload.total, 0);
  } finally {
    f.close();
  }
});

test('turning a rule off cancels unsent delayed tasks', async () => {
  const f = fixture();
  try {
    saveShop(f.store, 'user-1', { id: 'shop-1', clientId: '30001' });
    f.postingsByClientId.set('30001', [{
      posting_number: '30001-1',
      status: 'posting_delivered',
      in_process_at: '2026-08-24T10:00:00.000Z',
    }]);
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'local' } });
    const saved = await f.request({
      method: 'POST', pathname: '/api/smart-reply/local/rules',
      payload: {
        scene: 'reviewRequest', shop_client_ids: ['30001'], send_time_type: 'delayed', delay_hours: 24,
        template_id: 'review-1', message_template: 'Заказ {{货件编号}}', enabled: true,
      },
    });
    await f.service.runCycle();
    let tasks = await f.request({ pathname: '/api/smart-reply/local/tasks' });
    assert.equal(tasks.payload.items[0].status, 'pending');
    await f.request({
      method: 'POST',
      pathname: `/api/smart-reply/local/rules/${encodeURIComponent(saved.payload.rule_id)}/enabled`,
      payload: { enabled: false },
    });
    tasks = await f.request({ pathname: '/api/smart-reply/local/tasks' });
    assert.equal(tasks.payload.items[0].status, 'cancelled');
    assert.equal(f.calls.some((call) => call.type === 'send'), false);
  } finally {
    f.close();
  }
});

test('message-center notification hints immediately recheck the exact posting before sending', async () => {
  const f = fixture();
  try {
    saveShop(f.store, 'user-1', { id: 'shop-1', clientId: '40001' });
    f.postingsByClientId.set('40001', [{
      posting_number: '40001-1',
      status: 'awaiting_deliver',
      substatus: 'posting_awaiting_deliver',
      in_process_at: '2026-08-20T10:00:00.000Z',
    }]);
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'local' } });
    await f.request({
      method: 'POST', pathname: '/api/smart-reply/local/rules',
      payload: {
        scene: 'pickupReminder', shop_client_ids: ['40001'],
        template_id: 'pickup-1', message_template: 'Заказ {{货件编号}} готов', enabled: true,
      },
    });
    await f.service.runCycle();
    assert.equal((await f.request({ pathname: '/api/smart-reply/local/tasks' })).payload.total, 0);

    f.setClock('2026-08-24T10:01:00.000Z');
    f.postingsByClientId.set('40001', [{
      posting_number: '40001-1',
      status: 'delivering',
      substatus: 'posting_in_pickup_point',
      in_process_at: '2026-08-20T10:00:00.000Z',
    }]);
    const accepted = await f.request({
      method: 'POST', pathname: '/v1/internal/smart-reply/notification-hints',
      payload: {
        notifications: [{
          id: 'notification-40001-1', domain: 'orders', eventType: 'order_status_changed',
          shopId: 'shop-1', postingNumber: '40001-1', createdAt: '2026-08-24T10:01:00.000Z',
        }],
      },
    });
    assert.equal(accepted.payload.accepted, 1);
    await new Promise((resolve) => setImmediate(resolve));
    await f.service.runCycle();

    const tasks = await f.request({ pathname: '/api/smart-reply/local/tasks' });
    assert.equal(tasks.payload.total, 1);
    assert.equal(tasks.payload.items[0].status, 'sent');
    assert.equal(f.calls.filter((call) => call.type === 'send').length, 1);
  } finally {
    await f.service.stop();
    f.close();
  }
});

test('local mode refuses an expired shop entitlement and cancels pending work after expiry', async () => {
  const f = fixture();
  try {
    saveShop(f.store, 'user-1', { id: 'shop-1', clientId: '50001' });
    f.postingsByClientId.set('50001', [{
      posting_number: '50001-1',
      status: 'posting_delivered',
      in_process_at: '2026-08-24T10:00:00.000Z',
    }]);
    await f.request({ method: 'POST', pathname: '/api/smart-reply/mode', payload: { mode: 'local' } });
    const saved = await f.request({
      method: 'POST', pathname: '/api/smart-reply/local/rules',
      payload: {
        scene: 'reviewRequest', shop_client_ids: ['50001'], send_time_type: 'delayed', delay_hours: 24,
        template_id: 'review-1', message_template: 'Заказ {{货件编号}}', enabled: true,
      },
    });
    assert.equal(saved.payload.enabled, true);
    await f.service.runCycle();
    assert.equal((await f.request({ pathname: '/api/smart-reply/local/tasks' })).payload.items[0].status, 'pending');

    await f.request({
      method: 'POST',
      pathname: '/v1/internal/smart-reply/shop-entitlements',
      payload: { grants: [{ clientId: '50001', expireAt: '2026-08-24T10:30:00.000Z' }] },
    });
    f.setClock('2026-08-25T10:01:00.000Z');
    await f.service.runCycle();
    const tasks = await f.request({ pathname: '/api/smart-reply/local/tasks' });
    assert.equal(tasks.payload.items[0].status, 'cancelled');
    assert.equal(tasks.payload.items[0].last_error_code, 'SMART_REPLY_SHOP_LICENSE_INACTIVE');
    assert.equal(f.calls.some((call) => call.type === 'send'), false);

    await assert.rejects(
      () => f.request({
        method: 'POST', pathname: '/api/smart-reply/local/rules',
        payload: {
          rule_id: saved.payload.rule_id,
          scene: 'reviewRequest', shop_client_ids: ['50001'],
          template_id: 'review-1', message_template: 'Заказ {{货件编号}}', enabled: true,
        },
      }),
      (error) => error.code === 'SMART_REPLY_SHOP_LICENSE_INACTIVE',
    );
    const disabledAfterExpiry = await f.request({
      method: 'POST',
      pathname: `/api/smart-reply/local/rules/${saved.payload.rule_id}/enabled`,
      payload: { enabled: false },
    });
    assert.equal(disabledAfterExpiry.payload.enabled, false);
    await assert.rejects(
      () => f.request({
        method: 'POST',
        pathname: `/api/smart-reply/local/rules/${saved.payload.rule_id}/enabled`,
        payload: { enabled: true },
      }),
      (error) => error.code === 'SMART_REPLY_SHOP_LICENSE_INACTIVE',
    );
    await f.request({
      method: 'POST',
      pathname: '/v1/internal/smart-reply/shop-entitlements',
      payload: { grants: [{ clientId: '50001', expireAt: '2027-08-24T10:30:00.000Z' }] },
    });
    await assert.rejects(
      () => f.request({
        method: 'POST', pathname: '/api/smart-reply/local/rules',
        payload: {
          scene: 'reviewRequest', shop_client_ids: ['50001'],
          template_id: 'review-too-long', message_template: 'x'.repeat(501), enabled: false,
        },
      }),
      (error) => error.code === 'SMART_REPLY_TEMPLATE_INVALID',
    );
  } finally {
    f.close();
  }
});

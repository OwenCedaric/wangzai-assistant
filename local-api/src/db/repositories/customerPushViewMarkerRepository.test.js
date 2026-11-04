import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createCustomerPushViewMarkerRepository } from './customerPushViewMarkerRepository.js';

function insertShop(db, id) {
  db.prepare("INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')").run(id, `Shop ${id}`);
}

test('customer push view markers survive repository recreation and stay account scoped', () => {
  const db = createMigratedTestDb();
  try {
    insertShop(db, 'shop-a');
    const firstRepository = createCustomerPushViewMarkerRepository(db);
    firstRepository.saveMarker({
      shopId: 'shop-a',
      accountScope: 'account-generation-a',
      chatId: 'push-chat',
      lastMessageId: 'message-1',
      lastMessageAt: '2026-07-19T01:00:00.000Z',
    });

    const reopenedRepository = createCustomerPushViewMarkerRepository(db);
    assert.deepEqual(
      reopenedRepository.listMarkers({ shopId: 'shop-a', accountScope: 'account-generation-a' })
        .map(({ viewedAt, ...marker }) => marker),
      [{
        shopId: 'shop-a',
        accountScope: 'account-generation-a',
        chatId: 'push-chat',
        lastMessageId: 'message-1',
        lastMessageAt: '2026-07-19T01:00:00.000Z',
      }],
    );
    assert.deepEqual(
      reopenedRepository.listMarkers({ shopId: 'shop-a', accountScope: 'account-generation-b' }),
      [],
    );
  } finally {
    db.close();
  }
});

test('saving a newer push message replaces the older marker for that chat', () => {
  const db = createMigratedTestDb();
  try {
    insertShop(db, 'shop-a');
    const repository = createCustomerPushViewMarkerRepository(db);
    repository.saveMarker({ shopId: 'shop-a', accountScope: 'account-a', chatId: 'chat-1', lastMessageId: 'message-1' });
    repository.saveMarker({ shopId: 'shop-a', accountScope: 'account-a', chatId: 'chat-1', lastMessageId: 'message-2' });

    assert.deepEqual(
      repository.listMarkers({ shopId: 'shop-a', accountScope: 'account-a' })
        .map(({ lastMessageId }) => lastMessageId),
      ['message-2'],
    );
    assert.throws(
      () => repository.saveMarker({ shopId: 'shop-a', accountScope: 'account-a', chatId: 'chat-2' }),
      /MESSAGE_IDENTITY_REQUIRED/u,
    );
  } finally {
    db.close();
  }
});

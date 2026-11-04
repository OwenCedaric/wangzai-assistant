import assert from "node:assert/strict";
import test from "node:test";
import { createMigratedTestDb } from "../../../test/testDb.js";
import { createShopRepository } from "../../db/repositories/shopRepository.js";
import { createSyncSnapshotService } from "../../sync/syncSnapshotService.js";
import { createApp } from "../../app/createApp.js";
import {
  createOzonPushNotificationService,
  createOzonPushSignature,
  ozonPushTypeRules,
} from "./ozonPushNotificationService.js";

const SECRET = "test-ozon-push-secret-that-is-long-enough";

function fixture(options = {}) {
  const db = createMigratedTestDb();
  db.prepare(`INSERT INTO shops (id, name, alias, client_id, status, created_at, updated_at)
    VALUES ('shop-a', '店铺A', '一店', '100500', 'active', datetime('now'), datetime('now'))`).run();
  const shopRepository = createShopRepository(db);
  const service = createOzonPushNotificationService({
    db,
    shopRepository,
    notificationService: createSyncSnapshotService(db),
    secret: SECRET,
    onAcceptedEvent: options.onAcceptedEvent,
  });
  return { db, service };
}

test("all 22 Ozon selectable push types have an explicit bell rule", () => {
  assert.equal(Object.keys(ozonPushTypeRules).length, 22);
});

test("signed Ozon event is bound to exact shop and appears once in the bell ledger", () => {
  const { db, service } = fixture();
  try {
    const envelope = {
      events: [{
        id: "remote-1",
        message_type: "TYPE_STATE_CHANGED",
        seller_id: "100500",
        received_at: "2026-08-22T14:00:00Z",
        payload: {
          message_type: "TYPE_STATE_CHANGED",
          seller_id: 100500,
          posting_number: "123456-0001-1",
          old_state: "awaiting_deliver",
          new_state: "delivering",
        },
      }],
    };
    const signature = createOzonPushSignature(SECRET, envelope, 1787407200);
    const first = service.ingestEnvelope(envelope, signature, { now: 1787407200000 });
    const second = service.ingestEnvelope(envelope, signature, { now: 1787407200000 });
    assert.deepEqual(first.accepted, ["remote-1"]);
    assert.deepEqual(second.deduped, ["remote-1"]);
    const row = db.prepare("SELECT * FROM ozon_notification_events WHERE id = 'ozon_push_remote-1'").get();
    assert.equal(row.shop_id, "shop-a");
    assert.equal(row.event_type, "order_status_changed");
    assert.match(row.summary, /123456-0001-1/);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM ozon_notification_events").get().total, 1);
  } finally {
    db.close();
  }
});

test("invalid signature and unknown seller fail closed", () => {
  const { db, service } = fixture();
  try {
    const envelope = { events: [{ id: "remote-2", message_type: "TYPE_NEW_POSTING", seller_id: "other", payload: {} }] };
    assert.equal(service.ingestEnvelope(envelope, "t=1,v1=bad").statusCode, 401);
    const signature = createOzonPushSignature(SECRET, envelope, 1787407200);
    const result = service.ingestEnvelope(envelope, signature, { now: 1787407200000 });
    assert.equal(result.rejected[0].code, "OZON_PUSH_SHOP_NOT_FOUND");
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM ozon_notification_events").get().total, 0);
  } finally {
    db.close();
  }
});

test("accepted push schedules follow-up once, while a duplicate never schedules again", () => {
  const scheduled = [];
  const { db, service } = fixture({
    onAcceptedEvent: ({ remoteId, normalized }) => {
      scheduled.push({ remoteId, postingNumber: normalized.postingNumber });
      return { queued: true, postingNumber: normalized.postingNumber };
    },
  });
  try {
    const envelope = {
      events: [{
        id: "new-order-once",
        message_type: "TYPE_ORDER_NEW",
        seller_id: "100500",
        payload: { posting_number: "ORDER-ONCE-1" },
      }],
    };
    const signature = createOzonPushSignature(SECRET, envelope, 1787407200);
    const first = service.ingestEnvelope(envelope, signature, { now: 1787407200000 });
    const second = service.ingestEnvelope(envelope, signature, { now: 1787407200000 });

    assert.deepEqual(scheduled, [{ remoteId: "new-order-once", postingNumber: "ORDER-ONCE-1" }]);
    assert.deepEqual(first.followUp, [{ id: "new-order-once", queued: true, postingNumber: "ORDER-ONCE-1" }]);
    assert.deepEqual(second.followUp, []);
  } finally {
    db.close();
  }
});

test("product and chat push identities retain every exact refresh target", () => {
  const { db, service } = fixture({
    onAcceptedEvent: ({ normalized }) => ({
      queued: true,
      productRefs: normalized.productRefs,
      chatId: normalized.chatId,
    }),
  });
  try {
    const envelope = {
      events: [
        {
          id: "stock-many",
          message_type: "TYPE_STOCKS_CHANGED",
          seller_id: "100500",
          payload: {
            stocks: [
              { product_id: "7001", offer_id: "SKU-1", sku: "9001" },
              { product_id: "7002", offer_id: "SKU-2", sku: "9002" },
            ],
          },
        },
        {
          id: "chat-one",
          message_type: "TYPE_NEW_MESSAGE",
          seller_id: "100500",
          payload: { message: { id: "MSG-1", chat_id: "CHAT-1" } },
        },
      ],
    };
    const signature = createOzonPushSignature(SECRET, envelope, 1787407200);
    const result = service.ingestEnvelope(envelope, signature, { now: 1787407200000 });
    assert.deepEqual(result.followUp[0].productRefs, [
      { productId: "7001", offerId: "SKU-1", sku: "9001" },
      { productId: "7002", offerId: "SKU-2", sku: "9002" },
    ]);
    assert.equal(result.followUp[1].chatId, "CHAT-1");
  } finally {
    db.close();
  }
});

test("internal sink accepts HMAC without exposing the desktop renderer auth token", async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare(`INSERT INTO shops (id, name, alias, client_id, status, created_at, updated_at)
      VALUES ('shop-http', '店铺HTTP', 'HTTP店', '200600', 'active', datetime('now'), datetime('now'))`).run();
    server = createApp({
      db,
      config: {
        security: { authToken: "renderer-auth-token-that-is-long-enough", ozonPushSinkSecret: SECRET },
        sync: { ozonPushOrderSync: { debounceMs: 0, minBatchIntervalMs: 0, retryDelaysMs: [0, 0] } },
        ozon: {},
        runtime: {},
      },
      ozonScheduler: {
        async executeReadOnly(input) {
          assert.equal(input.endpointKey, "orders.fbsGet");
          return {
            ok: true,
            data: {
              result: {
                posting_number: "HTTP-ORDER-1",
                order_id: "HTTP-ORDER-ID-1",
                status: "awaiting_packaging",
                products: [{ product_id: "7001", offer_id: "HTTP-SKU-1" }],
              },
            },
          };
        },
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    const envelope = { events: [{ id: "remote-http", message_type: "TYPE_ORDER_NEW", seller_id: "200600", payload: { posting_number: "HTTP-ORDER-1" } }] };
    const response = await fetch(`http://127.0.0.1:${port}/api/internal/ozon/push-notifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Wangzai-Ozon-Push-Signature": createOzonPushSignature(SECRET, envelope),
      },
      body: JSON.stringify(envelope),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.accepted, ["remote-http"]);
    assert.equal(payload.followUp[0].queued, true);
    assert.equal(payload.followUp[0].postingNumber, "HTTP-ORDER-1");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (db.prepare("SELECT 1 FROM ozon_orders WHERE shop_id = ? AND posting_number = ?")
        .get("shop-http", "HTTP-ORDER-1")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cached = db.prepare("SELECT order_id, status FROM ozon_orders WHERE shop_id = ? AND posting_number = ?")
      .get("shop-http", "HTTP-ORDER-1");
    assert.equal(cached.order_id, "HTTP-ORDER-ID-1");
    assert.equal(cached.status, "awaiting_packaging");
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("buyer message push refreshes exact history and list before waking the authenticated customer page", async () => {
  const db = createMigratedTestDb();
  const calls = [];
  let server;
  const authToken = "renderer-auth-token-that-is-long-enough";
  try {
    db.prepare(`INSERT INTO shops (id, name, alias, client_id, status, created_at, updated_at)
      VALUES ('shop-chat', '客服店铺', '客服店', '300700', 'active', datetime('now'), datetime('now'))`).run();
    server = createApp({
      db,
      config: {
        security: { authToken, ozonPushSinkSecret: SECRET },
        sync: { ozonPushDomainRefresh: { debounceMs: 0, minBatchIntervalMs: 0, retryDelaysMs: [0, 0] } },
        ozon: {},
        runtime: {},
      },
      ozonScheduler: {
        async executeReadOnly(input) {
          calls.push(input);
          if (input.endpointKey === "chat.history") {
            return { ok: true, data: { messages: [{ message_id: "MSG-CHAT-1", data: ["您好"] }] } };
          }
          if (input.endpointKey === "chat.list") {
            return {
              ok: true,
              data: {
                chats: [{
                  unread_count: 1,
                  last_message_id: "MSG-CHAT-1",
                  chat: { chat_id: "CHAT-1", chat_type: "BUYER_SELLER", chat_status: "OPENED" },
                }],
                has_next: false,
              },
            };
          }
          throw new Error(`unexpected endpoint ${input.endpointKey}`);
        },
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    const waitResponsePromise = fetch(
      `http://127.0.0.1:${port}/api/customer-service/realtime/wait?shopId=shop-chat&afterSequence=0&timeoutMs=2000`,
      { headers: { "x-wangzai-local-api-token": authToken } },
    );
    const envelope = {
      events: [{
        id: "remote-chat-http",
        message_type: "TYPE_NEW_MESSAGE",
        seller_id: "300700",
        payload: { message: { id: "MSG-CHAT-1", chat_id: "CHAT-1" } },
      }],
    };
    const pushResponse = await fetch(`http://127.0.0.1:${port}/api/internal/ozon/push-notifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Wangzai-Ozon-Push-Signature": createOzonPushSignature(SECRET, envelope),
      },
      body: JSON.stringify(envelope),
    });
    assert.equal(pushResponse.status, 200);

    const bindingResponse = await fetch(
      `http://127.0.0.1:${port}/api/ozon/push-bindings?domain=customer`,
      { headers: { "x-wangzai-local-api-token": authToken } },
    );
    const bindingPayload = await bindingResponse.json();
    assert.equal(bindingResponse.status, 200);
    assert.deepEqual(bindingPayload.shopIds, ["shop-chat"]);
    assert.equal(bindingPayload.rows[0].eventCount, 1);

    const waitResponse = await waitResponsePromise;
    const payload = await waitResponse.json();
    assert.equal(waitResponse.status, 200);
    assert.deepEqual(payload.event.chatIds, ["CHAT-1"]);
    assert.deepEqual(payload.event.messageTypes, ["TYPE_NEW_MESSAGE"]);
    assert.deepEqual(calls.map((call) => call.endpointKey), ["chat.history", "chat.list"]);
    assert.deepEqual(calls[0].params, { chat_id: "CHAT-1", limit: 50, direction: "Backward" });
    assert.deepEqual(calls[1].params, { limit: 100, offset: 0 });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

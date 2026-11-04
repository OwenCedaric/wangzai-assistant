import assert from "node:assert/strict";
import test from "node:test";
import { createShopRepository } from "../../db/repositories/shopRepository.js";
import { createMigratedTestDb, saveUnitShop } from "../../../test/testDb.js";
import { createCustomerServiceService } from "./customerServiceService.js";
import { createOrderRepository } from "../../db/repositories/orderRepository.js";
import { createPurchaseOrderOverrideRepository } from "../../db/repositories/purchaseOrderOverrideRepository.js";
import { createCrossBorderOrderRepository } from "../../db/repositories/crossBorderOrderRepository.js";

test("customer service order route resolves a base order to child postings and linked domestic logistics", () => {
  const db = createMigratedTestDb();
  const shopId = saveUnitShop(createShopRepository(db), "shop-customer-route");
  createOrderRepository(db).upsertOrders({
    shopId,
    rows: [
      {
        posting_number: "75577421-0029-1",
        order_number: "75577421-0029",
        order_id: "37468026221",
        status: "delivered",
        in_process_at: "2026-07-28T02:23:41.000Z",
        products: [{ offer_id: "offer-1", sku: "4146125120", name: "商品 A" }],
      },
    ],
    source: "FBS",
  });
  createPurchaseOrderOverrideRepository(db).upsertOverride({
    shopId,
    orderKey: "75577421-0029-1",
    postingNumber: "75577421-0029-1",
    purchasePlatform: "1688",
    purchaseOrderNumber: "1688-1001",
  });
  createCrossBorderOrderRepository(db).upsertRecord({
    shopId,
    recordKey: "route-1",
    platformOrder: "75577421-0029-1",
    purchaseOrderNumber: "1688-1001",
    trackingNumber: "YT123456",
    warehouse: "义乌仓",
    routeName: "标准线",
  });

  const payload = createCustomerServiceService({ db }).readOrderRouteContext({
    shopId,
    postingNumber: "75577421-0029",
  });

  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].postingNumber, "75577421-0029-1");
  assert.equal(payload.purchaseRows[0].purchaseOrderNumber, "1688-1001");
  assert.equal(payload.logisticsRows[0].trackingNumber, "YT123456");
});

test("customer service lists recent current-shop orders when starting a real conversation", () => {
  const db = createMigratedTestDb();
  const shopId = saveUnitShop(createShopRepository(db), "shop-customer-start-list");
  createOrderRepository(db).upsertOrders({
    shopId,
    rows: [
      {
        posting_number: "0146426393-0087-1",
        order_number: "0146426393-0087",
        status: "delivering",
        in_process_at: "2026-08-20T02:23:41.000Z",
      },
    ],
    source: "FBS",
  });

  const payload = createCustomerServiceService({ db }).readOrderRouteContext({ shopId });

  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].postingNumber, "0146426393-0087-1");
});

test("customer service background sync persists every bounded chat list page through scheduler", async () => {
  const db = createMigratedTestDb();
  const shopId = saveUnitShop(createShopRepository(db), "shop-customer-sync");
  const calls = [];
  const pending = [];
  const service = createCustomerServiceService({
    db,
    ozonScheduler: {
      async executeReadOnly(input) {
        calls.push(input);
        const page = calls.length;
        return {
          ok: true,
          status: "success",
          data: {
            chats: Array.from({ length: page === 1 ? 2 : 1 }, (_, index) => ({
              chat: { chat_id: `chat-${page}-${index}` },
            })),
            has_next: page === 1,
            cursor: `cursor-${page}`,
          },
        };
      },
    },
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    pageSize: 2,
    maxPages: 5,
  });
  assert.equal(accepted.accepted, true);
  await Promise.all(pending);

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.params),
    [
      { limit: 2, offset: 0 },
      { limit: 2, cursor: "cursor-1" },
    ],
  );
  assert.equal(
    calls.every((call) => call.endpointKey === "chat.list"),
    true,
  );
  assert.equal(
    calls.every((call) => call.domain === "customerService"),
    true,
  );
  const finalJob = db
    .prepare(
      "SELECT status, changed_count, failed_count FROM ozon_request_jobs WHERE id = ?",
    )
    .get(accepted.jobId);
  assert.equal(finalJob.status, "success");
  assert.equal(finalJob.changed_count, 3);
  assert.equal(finalJob.failed_count, 0);
});

test("customer service default sync follows Ozon has_next beyond two short pages", async () => {
  const db = createMigratedTestDb();
  const shopId = saveUnitShop(
    createShopRepository(db),
    "shop-customer-full-sync",
  );
  const calls = [];
  const pending = [];
  const service = createCustomerServiceService({
    db,
    ozonScheduler: {
      async executeReadOnly(input) {
        calls.push(input);
        const page = calls.length;
        return {
          ok: true,
          status: "success",
          data: {
            chats: Array.from({ length: page < 3 ? 30 : 1 }, (_, index) => ({
              chat: { chat_id: `full-chat-${page}-${index}` },
            })),
            has_next: page < 3,
            cursor: `cursor-${page}`,
            total_chats_count: 61,
          },
        };
      },
    },
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  service.startSync({ shopId });
  await Promise.all(pending);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.params),
    [
      { limit: 100, offset: 0 },
      { limit: 100, cursor: "cursor-1" },
      { limit: 100, cursor: "cursor-2" },
    ],
  );
});

test("customer service background sync validates its real dependencies", () => {
  assert.equal(
    createCustomerServiceService().startSync({ shopId: "shop-a" }).error.code,
    "CUSTOMER_SERVICE_SYNC_NOT_CONNECTED",
  );
  const db = createMigratedTestDb();
  const service = createCustomerServiceService({
    db,
    ozonScheduler: { executeReadOnly() {} },
  });
  assert.equal(
    service.startSync({}).error.code,
    "CUSTOMER_SERVICE_SHOP_ID_REQUIRED",
  );
});

test("customer service read probe keeps shop and cursor pagination in the Ozon scheduler request", async () => {
  const calls = [];
  const service = createCustomerServiceService({
    ozonScheduler: {
      async executeReadOnly(input) {
        calls.push(input);
        return { ok: true, data: { chats: [] } };
      },
    },
  });

  const result = await service.probeRead({
    shopId: "shop-a",
    endpointKey: "chat.list",
    limit: 30,
    cursor: "cursor-2",
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shopId, "shop-a");
  assert.equal(calls[0].endpointKey, "chat.list");
  assert.equal(calls[0].waitForResult, true);
  assert.deepEqual(calls[0].params, { limit: 30, cursor: "cursor-2" });
  assert.match(calls[0].cacheKey, /^customerService:shop-a:chat\.list:/u);
});

test("customer service read probe rejects missing shop, missing chat id and write endpoints", async () => {
  let callCount = 0;
  const service = createCustomerServiceService({
    ozonScheduler: {
      async executeReadOnly() {
        callCount += 1;
        return { ok: true };
      },
    },
  });

  assert.equal(
    (await service.probeRead({ endpointKey: "chat.list" })).error.code,
    "CUSTOMER_SERVICE_SHOP_ID_REQUIRED",
  );
  assert.equal(
    (await service.probeRead({ shopId: "shop-a", endpointKey: "chat.history" }))
      .error.code,
    "CHAT_ID_REQUIRED",
  );
  assert.equal(
    (await service.probeRead({ shopId: "shop-a", endpointKey: "chat.read" }))
      .error.code,
    "CUSTOMER_SERVICE_ENDPOINT_NOT_ALLOWED",
  );
  assert.equal(callCount, 0);
});

test("customer consultation can read the existing seller profile endpoint without enabling writes", async () => {
  const calls = [];
  const service = createCustomerServiceService({
    ozonScheduler: {
      async executeReadOnly(input) {
        calls.push(input);
        return { ok: true, data: { result: { company_name: "SuperBaiss" } } };
      },
    },
  });

  const result = await service.probeRead({
    shopId: "shop-a",
    endpointKey: "shop.sellerInfo",
    requestedBy: "customer-consultation-shop-profile",
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].endpointKey, "shop.sellerInfo");
  assert.deepEqual(calls[0].params, {});
  assert.equal(service.allowedReadEndpoints.includes("shop.sellerInfo"), true);
});

test("customer chat image read uses only the exact selected shop credentials", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop-chat-image");
  let captured;
  const service = createCustomerServiceService({
    db,
    shopRepository,
    ozonClient: {
      async requestBinaryReadOnly(input) {
        captured = input;
        return {
          ok: true,
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          mimeType: "image/jpeg",
        };
      },
    },
  });
  const fileUrl = "https://api-seller.ozon.ru/v2/chat/file/messenger/a.jpg";

  const result = await service.readChatFile({ shopId, fileUrl });

  assert.equal(result.ok, true);
  assert.equal(captured.endpointKey, "chat.file");
  assert.equal(captured.resourceUrl, fileUrl);
  assert.equal(captured.shopCredentials.clientId, `client-${shopId}`);
  assert.equal(captured.shopCredentials.apiKey, `key-${shopId}`);
});

test("customer translation cancellation stops the exact active request", async () => {
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  let receivedSignal;
  const service = createCustomerServiceService({
    messageTranslationService: {
      translateMessages(input) {
        receivedSignal = input.signal;
        notifyStarted();
        return new Promise((resolve) => {
          input.signal.addEventListener(
            "abort",
            () => resolve({ ok: true, rows: [], cancelled: true }),
            { once: true },
          );
        });
      },
    },
  });

  const pending = service.translateMessages({
    requestId: "translation-request-1",
    messages: [],
  });
  await started;
  const cancelled = service.cancelMessageTranslation({
    requestId: "translation-request-1",
  });
  const result = await pending;

  assert.equal(cancelled.cancelled, true);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(result.cancelled, true);
  assert.equal(
    service.cancelMessageTranslation({ requestId: "translation-request-1" })
      .cancelled,
    false,
  );
});

test("customer translation cancellation also closes the cancel-before-start race", async () => {
  let receivedAborted = false;
  const service = createCustomerServiceService({
    messageTranslationService: {
      async translateMessages(input) {
        receivedAborted = input.signal.aborted;
        return { ok: true, rows: [], cancelled: input.signal.aborted };
      },
    },
  });

  const cancelled = service.cancelMessageTranslation({
    requestId: "translation-request-before-start",
  });
  const result = await service.translateMessages({
    requestId: "translation-request-before-start",
    messages: [],
  });

  assert.equal(cancelled.cancelled, false);
  assert.equal(receivedAborted, true);
  assert.equal(result.cancelled, true);
});

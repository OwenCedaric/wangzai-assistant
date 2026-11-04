import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerServiceWriteService } from "./customerServiceWriteService.js";

function createSendContext(overrides = {}) {
  return {
    preview: {
      previewId: "preview-1",
      action: "customerService.chat.sendMessage",
      endpointKey: "chat.sendMessage",
      shopId: "shop-a",
      payload: { chat_id: "chat-1", text: "您好" },
    },
    input: {
      action: "customerService.chat.sendMessage",
      endpointKey: "chat.sendMessage",
      shopId: "shop-a",
      payload: { chat_id: "chat-1", text: "您好" },
      realWrite: true,
      dryRun: false,
      ...overrides,
    },
  };
}

test("customer service text reply only completes after Ozon history readback", async () => {
  const writeCalls = [];
  const readCalls = [];
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite(input) {
        writeCalls.push(input);
        return { ok: true, data: { result: { message_id: "message-1" } } };
      },
      async executeReadOnly(input) {
        readCalls.push(input);
        return {
          ok: true,
          data: {
            messages: [
              {
                message_id: "message-1",
                user: { type: "Seller" },
                data: ["您好"],
              },
            ],
          },
        };
      },
    },
  });

  const result = await service.executeConfirmedWrite(createSendContext());

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, "readback_confirmed");
  assert.equal(result.readBack.status, "success");
  assert.equal(writeCalls[0].endpointKey, "chat.sendMessage");
  assert.equal(writeCalls[0].realWrite, true);
  assert.deepEqual(readCalls[0].params, {
    chat_id: "chat-1",
    limit: 30,
    direction: "Backward",
  });
  assert.equal(readCalls[0].forceRefresh, true);
  assert.equal(readCalls[0].allowStale, false);
});

test("customer service text reply stays pending when Ozon readback has not found it", async () => {
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite() {
        return {
          ok: true,
          data: { result: { message_id: "message-pending" } },
        };
      },
      async executeReadOnly() {
        return { ok: true, data: { messages: [] } };
      },
    },
  });

  const result = await service.executeConfirmedWrite(createSendContext());
  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, "submitted_waiting_readback");
  assert.equal(result.readBack.status, "pending");
  assert.doesNotMatch(result.message, /发送完成/u);
});

test("customer service file send uses staged bytes and completes only after filename readback", async () => {
  const writes = [];
  let consumedToken = "";
  const service = createCustomerServiceWriteService({
    outboundFileStore: {
      resolve(input) {
        assert.deepEqual(input, {
          token: "file-token",
          shopId: "shop-a",
          chatId: "chat-1",
        });
        return {
          name: "evidence.png",
          base64Content: "aGVsbG8=",
          sha256: "sha-1",
        };
      },
      consume(token) {
        consumedToken = token;
      },
    },
    ozonScheduler: {
      async executeWrite(input) {
        writes.push(input);
        return { ok: true, data: { result: "success" } };
      },
      async executeReadOnly() {
        return {
          ok: true,
          data: {
            messages: [
              {
                message_id: "file-message-1",
                user: { type: "Seller" },
                data: [{ name: "evidence.png" }],
              },
            ],
          },
        };
      },
    },
  });
  const payload = {
    chat_id: "chat-1",
    file_token: "file-token",
    name: "evidence.png",
    size: 5,
    sha256: "sha-1",
  };
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "preview-file",
      action: "customerService.chat.sendFile",
      endpointKey: "chat.sendFile",
      shopId: "shop-a",
      payload,
    },
    input: {
      action: "customerService.chat.sendFile",
      endpointKey: "chat.sendFile",
      shopId: "shop-a",
      payload,
      realWrite: true,
      dryRun: false,
    },
  });
  assert.equal(result.writeStatus, "readback_confirmed");
  assert.equal(result.readBack.messageId, "file-message-1");
  assert.deepEqual(writes[0].params, {
    chat_id: "chat-1",
    name: "evidence.png",
    base64_content: "aGVsbG8=",
  });
  assert.equal(consumedToken, "file-token");
});

test("customer service file send recognizes the Markdown attachment returned by Ozon history", async () => {
  let consumedToken = "";
  const service = createCustomerServiceWriteService({
    outboundFileStore: {
      resolve() {
        return {
          name: "customer-consultation-ozon-send-test.txt",
          base64Content:
            "5pe66LWE5Yqp5omL6ZmE5Lu25Y+R6YCB5a6e5py65rWL6K+V77yM6K+35b+955Wl44CC",
          sha256: "sha-markdown",
        };
      },
      consume(token) {
        consumedToken = token;
      },
    },
    ozonScheduler: {
      async executeWrite() {
        return { ok: true, data: { result: "success" } };
      },
      async executeReadOnly() {
        return {
          ok: true,
          data: {
            messages: [
              {
                message_id: "3000000441969932523",
                user: { id: "4067587", type: "Seller" },
                data: [
                  "[customer-consultation-ozon-send-test.txt (52B)](https://api-seller.ozon.ru/v2/chat/file/messenger-rotated-3/813e481a-e554-477c-847e-2b63b3a88c50.txt)",
                ],
              },
            ],
          },
        };
      },
    },
  });

  const payload = {
    chat_id: "8071b145-3c91-4bf6-9c5b-fd7b269c6edc",
    file_token: "markdown-file-token",
    name: "customer-consultation-ozon-send-test.txt",
    size: 52,
    sha256: "sha-markdown",
  };
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "preview-markdown-file",
      action: "customerService.chat.sendFile",
      endpointKey: "chat.sendFile",
      shopId: "ozon-shop-example-02",
      payload,
    },
    input: {
      action: "customerService.chat.sendFile",
      endpointKey: "chat.sendFile",
      shopId: "ozon-shop-example-02",
      payload,
      realWrite: true,
      dryRun: false,
    },
  });

  assert.equal(result.writeStatus, "readback_confirmed");
  assert.equal(result.readBack.messageId, "3000000441969932523");
  assert.equal(consumedToken, "markdown-file-token");
});

test("customer service image send confirms a new anonymous Ozon image without matching the older image", async () => {
  let consumedToken = "";
  let readCount = 0;
  const oldBuyerImage = {
    message_id: "old-buyer-image",
    created_at: "2026-08-16T08:21:40.025108Z",
    user: { id: "266113191", type: "Customer" },
    is_image: true,
    data: ["![](https://api-seller.ozon.ru/v2/chat/file/old-image.jpg)"],
  };
  const newSellerImage = {
    message_id: "new-seller-image",
    created_at: "2026-08-21T13:41:49.503133Z",
    user: { id: "4067587", type: "Seller" },
    is_image: true,
    data: ["![](https://api-seller.ozon.ru/v2/chat/file/generated-uuid.png)"],
  };
  const service = createCustomerServiceWriteService({
    outboundFileStore: {
      resolve() {
        return {
          name: "wangzai-app-icon.png",
          mimeType: "image/png",
          base64Content: "aGVsbG8=",
          sha256: "sha-image",
          createdAt: "2026-08-21T13:41:40.000Z",
        };
      },
      consume(token) {
        consumedToken = token;
      },
    },
    ozonScheduler: {
      async executeWrite() {
        return { ok: true, data: { result: "success" } };
      },
      async executeReadOnly() {
        readCount += 1;
        return {
          ok: true,
          data: {
            messages:
              readCount === 1
                ? [oldBuyerImage]
                : [newSellerImage, oldBuyerImage],
          },
        };
      },
    },
  });

  const payload = {
    chat_id: "8071b145-3c91-4bf6-9c5b-fd7b269c6edc",
    file_token: "image-file-token",
    name: "wangzai-app-icon.png",
    size: 196590,
    sha256: "sha-image",
  };
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "preview-image-file",
      action: "customerService.chat.sendFile",
      endpointKey: "chat.sendFile",
      shopId: "ozon-shop-example-02",
      payload,
    },
    input: {
      action: "customerService.chat.sendFile",
      endpointKey: "chat.sendFile",
      shopId: "ozon-shop-example-02",
      payload,
      realWrite: true,
      dryRun: false,
    },
  });

  assert.equal(readCount, 2);
  assert.equal(result.writeStatus, "readback_confirmed");
  assert.equal(result.readBack.messageId, "new-seller-image");
  assert.equal(consumedToken, "image-file-token");
});

test("customer service start chat verifies returned chat through Ozon history", async () => {
  const writes = [];
  const reads = [];
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite(input) {
        writes.push(input);
        return { ok: true, data: { result: { chat_id: "new-chat-1" } } };
      },
      async executeReadOnly(input) {
        reads.push(input);
        return { ok: true, data: { messages: [] } };
      },
    },
  });
  const payload = { posting_number: "47873153-0052-1" };
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "preview-start",
      action: "customerService.chat.start",
      endpointKey: "chat.start",
      shopId: "shop-a",
      payload,
    },
    input: {
      action: "customerService.chat.start",
      endpointKey: "chat.start",
      shopId: "shop-a",
      payload,
      realWrite: true,
      dryRun: false,
    },
  });
  assert.equal(result.writeStatus, "readback_confirmed");
  assert.equal(result.readBack.chatId, "new-chat-1");
  assert.deepEqual(writes[0].params, payload);
  assert.deepEqual(reads[0].params, {
    chat_id: "new-chat-1",
    limit: 1,
    direction: "Backward",
  });
});

test("customer service mark-read action writes each chat and completes after unread readback", async () => {
  const writeCalls = [];
  const readCalls = [];
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite(input) {
        writeCalls.push(input);
        return {
          ok: true,
          realWrite: true,
          dryRun: false,
          data: { unread_count: 0 },
        };
      },
      async executeReadOnly(input) {
        readCalls.push(input);
        throw new Error("chat.list must not be called for mark-read confirmation");
      },
    },
  });

  const chats = [
    {
      chat_id: "chat-1",
      first_unread_message_id: "3000000000118021931",
      last_message_id: "3000000000118021939",
      unread_count: 2,
    },
    {
      chat_id: "chat-2",
      last_message_id: "3000000000118021940",
      unread_count: 1,
    },
  ];
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "read-preview-1",
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
    },
    input: {
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
      realWrite: true,
      dryRun: false,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, "readback_confirmed");
  assert.equal(result.readBack.status, "success");
  assert.deepEqual(
    writeCalls.map((call) => call.params),
    [
      { chat_id: "chat-1", from_message_id: "3000000000118021939" },
      { chat_id: "chat-2", from_message_id: "3000000000118021940" },
    ],
  );
  assert.equal(readCalls.length, 0);
  assert.equal(result.readBack.source, "chat.read");
});

test("customer service mark-read never reports completion when Ozon readback still has unread messages", async () => {
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite() {
        return {
          ok: true,
          realWrite: true,
          dryRun: false,
          data: { unread_count: 1 },
        };
      },
    },
  });
  const chats = [
    { chat_id: "chat-1", first_unread_message_id: "3001", unread_count: 1 },
  ];
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "read-preview-2",
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
    },
    input: {
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
      realWrite: true,
      dryRun: false,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.writeStatus, "partial_failure");
  assert.equal(result.readBack.status, "mismatch");
  assert.match(result.message, /未显示全部完成/u);
});

test("customer service mark-read trusts the direct Ozon response and never polls chat.list", async () => {
  let readCount = 0;
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite() {
        return {
          ok: true,
          realWrite: true,
          dryRun: false,
          data: { unread_count: 0 },
        };
      },
      async executeReadOnly() {
        readCount += 1;
        throw new Error("chat.list must not be called");
      },
    },
  });
  const chats = [
    { chat_id: "chat-retry", first_unread_message_id: "3001", unread_count: 1 },
  ];
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "read-preview-retry",
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
    },
    input: {
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
      realWrite: true,
      dryRun: false,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, "success");
  assert.equal(result.readBack.attempts, 1);
  assert.equal(result.readBack.source, "chat.read");
  assert.equal(readCount, 0);
});

test("customer service single-chat mark-read never scans the whole account when chat.list has more pages", async () => {
  const readCalls = [];
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite() {
        return {
          ok: true,
          realWrite: true,
          dryRun: false,
          data: { unread_count: 0 },
        };
      },
      async executeReadOnly(input) {
        readCalls.push(input);
        throw new Error("chat.list must not be called");
      },
    },
  });
  const chats = [
    {
      chat_id: "chat-current",
      first_unread_message_id: "3001",
      unread_count: 3,
    },
  ];

  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "read-preview-current",
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
    },
    input: {
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
      realWrite: true,
      dryRun: false,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, "success");
  assert.equal(readCalls.length, 0);
});

test("customer service mark-read accepts Ozon write unread_count zero without a list readback", async () => {
  let readCount = 0;
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite() {
        return {
          ok: true,
          realWrite: true,
          dryRun: false,
          data: { unread_count: 0 },
        };
      },
      async executeReadOnly() {
        readCount += 1;
        throw new Error("chat.list must not be called");
      },
    },
  });
  const chats = [
    {
      chat_id: "chat-omitted",
      first_unread_message_id: "3001",
      unread_count: 1,
    },
  ];
  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: "read-preview-omitted",
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
    },
    input: {
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: { chats },
      realWrite: true,
      dryRun: false,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, "success");
  assert.equal(result.readBack.targets[0].writeUnreadCount, 0);
  assert.equal(readCount, 0);
});

test("customer service mark-read replays a completed preview without submitting twice", async () => {
  let writeCount = 0;
  let readCount = 0;
  const service = createCustomerServiceWriteService({
    ozonScheduler: {
      async executeWrite() {
        writeCount += 1;
        return {
          ok: true,
          realWrite: true,
          dryRun: false,
          data: { unread_count: 0 },
        };
      },
      async executeReadOnly() {
        readCount += 1;
        throw new Error("chat.list must not be called");
      },
    },
  });
  const context = {
    preview: {
      previewId: "read-preview-replay",
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      payload: {
        chats: [
          {
            chat_id: "chat-1",
            first_unread_message_id: "3001",
            unread_count: 1,
          },
        ],
      },
    },
    input: {
      action: "customerService.chat.markAllRead",
      endpointKey: "chat.read",
      shopId: "shop-a",
      realWrite: true,
      dryRun: false,
    },
  };
  const first = await service.executeConfirmedWrite(context);
  const replay = await service.executeConfirmedWrite(context);
  assert.equal(first.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(writeCount, 1);
  assert.equal(readCount, 0);
});

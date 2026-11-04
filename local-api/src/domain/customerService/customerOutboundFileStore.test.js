import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerOutboundFileStore } from "./customerOutboundFileStore.js";

test("customer outbound file store isolates the exact shop and chat then consumes once", () => {
  const store = createCustomerOutboundFileStore({ maxBytes: 1024 });
  const staged = store.stage({
    shopId: "shop-1",
    chatId: "chat-1",
    name: "photo.png",
    mimeType: "image/png",
    base64Content: Buffer.from("hello").toString("base64"),
  });
  const resolved = store.resolve({
    token: staged.token,
    shopId: "shop-1",
    chatId: "chat-1",
  });
  assert.equal(resolved.name, "photo.png");
  assert.equal(resolved.base64Content, "aGVsbG8=");
  assert.throws(
    () =>
      store.resolve({
        token: staged.token,
        shopId: "shop-2",
        chatId: "chat-1",
      }),
    /店铺或会话已变化/u,
  );
  store.consume(staged.token);
  assert.throws(
    () =>
      store.resolve({
        token: staged.token,
        shopId: "shop-1",
        chatId: "chat-1",
      }),
    /已过期/u,
  );
});

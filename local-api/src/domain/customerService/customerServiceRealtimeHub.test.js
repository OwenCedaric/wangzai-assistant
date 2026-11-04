import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerServiceRealtimeHub } from "./customerServiceRealtimeHub.js";

test("customer realtime hub delivers a refreshed chat only to the exact shop", async () => {
  const hub = createCustomerServiceRealtimeHub();
  const shopA = hub.waitForEvent({ shopId: "shop-a", timeoutMs: 2_000 });
  const shopBController = new AbortController();
  const shopB = hub.waitForEvent({ shopId: "shop-b", timeoutMs: 2_000, signal: shopBController.signal });

  const event = hub.publish({
    shopId: "shop-a",
    chatIds: ["chat-1", "chat-1"],
    messageTypes: ["TYPE_NEW_MESSAGE"],
    occurredAt: "2026-08-23T01:02:03.000Z",
  });
  assert.equal(event.sequence, 1);
  assert.deepEqual((await shopA).event, {
    sequence: 1,
    shopId: "shop-a",
    chatIds: ["chat-1"],
    messageTypes: ["TYPE_NEW_MESSAGE"],
    occurredAt: "2026-08-23T01:02:03.000Z",
  });

  shopBController.abort();
  await assert.rejects(shopB, { name: "AbortError", code: "CUSTOMER_SERVICE_REALTIME_ABORTED" });
  hub.close();
});

test("customer realtime hub replays bounded unseen events and then times out cleanly", async () => {
  const timers = [];
  const hub = createCustomerServiceRealtimeHub({
    setTimeoutFn(callback, timeoutMs) {
      const timer = { callback, timeoutMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn() {},
  });
  hub.publish({ shopId: "shop-a", chatIds: ["chat-1"] });
  hub.publish({ shopId: "shop-a", chatIds: ["chat-2"] });

  assert.deepEqual(hub.getCursor("shop-a"), {
    ok: true,
    sequence: 2,
    event: null,
    initialized: true,
  });

  assert.equal((await hub.waitForEvent({ shopId: "shop-a", afterSequence: 0 })).event.chatIds[0], "chat-1");
  assert.equal((await hub.waitForEvent({ shopId: "shop-a", afterSequence: 1 })).event.chatIds[0], "chat-2");

  const waiting = hub.waitForEvent({ shopId: "shop-a", afterSequence: 2, timeoutMs: 500 });
  assert.equal(timers.at(-1).timeoutMs, 500);
  timers.at(-1).callback();
  assert.deepEqual(await waiting, { ok: true, sequence: 2, event: null, timedOut: true });
  hub.close();
});

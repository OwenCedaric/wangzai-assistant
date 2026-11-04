import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWechatAssistantPointsAvailable,
  createWechatAssistantPointsReader,
  normalizeWechatAssistantPointsWallet,
} from "./wechatAssistantPoints.js";

test("normalizes the authoritative available point balance", () => {
  const wallet = normalizeWechatAssistantPointsWallet({ balance_points: 120, reserved_points: 20, available_points: 100 });
  assert.deepEqual(
    { ...wallet, checkedAt: "checked" },
    { balancePoints: 120, reservedPoints: 20, availablePoints: 100, checkedAt: "checked" },
  );
  assert.match(wallet.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test("points reader fails closed and zero available points cannot activate the built-in model", async () => {
  const read = createWechatAssistantPointsReader({
    licenseRuntime: { request: async () => ({ ok: true, data: { balance_points: 5, reserved_points: 5, available_points: 0 } }) },
  });
  const wallet = await read();
  assert.throws(() => assertWechatAssistantPointsAvailable(wallet), (error) => error.code === "POINT_BALANCE_INSUFFICIENT" && error.status === 402);
});

test("points reader treats an unavailable wallet service as a blocking verification failure", async () => {
  const read = createWechatAssistantPointsReader({
    licenseRuntime: { request: async () => ({ ok: false, status: 503, error: "服务不可用" }) },
  });
  await assert.rejects(read, (error) => error.code === "POINTS_CHECK_FAILED" && error.status === 503);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createProfileCacheMaintenanceIpcHandler,
  isBackgroundPurchaseBrowserCommand,
  isRendererRecoveryCommandRequest,
  requiresPurchaseBrowserBusinessEntitlement,
} from "./desktopIpc.js";

test('operation-scoped cleanup is independent of the active Seller business license', () => {
  assert.equal(requiresPurchaseBrowserBusinessEntitlement('purge-operation'), false);
  for (const command of ['open', 'activate', 'ozon-data-read', 'purchase-auto-order', 'capture-confirm', 'purge-operation-other']) {
    assert.equal(requiresPurchaseBrowserBusinessEntitlement(command), true);
  }
});

test("market collector commands bypass every visible browser host presentation path", () => {
  assert.equal(isBackgroundPurchaseBrowserCommand({ command: "open", browserRole: "market-collector" }), true);
  assert.equal(isBackgroundPurchaseBrowserCommand({ command: "open", browserRole: "follow-seller-collector" }), true);
  assert.equal(isBackgroundPurchaseBrowserCommand({ command: "open", browserRole: "product-link-parser" }), true);
  assert.equal(isBackgroundPurchaseBrowserCommand({ command: "open", background: true }), true);
  assert.equal(isBackgroundPurchaseBrowserCommand({ command: "open", restoreVisible: false }), true);
  assert.equal(isBackgroundPurchaseBrowserCommand({ command: "open", browserRole: "interactive" }), false);
  assert.equal(isBackgroundPurchaseBrowserCommand({
    command: "activate",
    tabId: "collector-tab",
  }, {
    tabs: [{ tabId: "collector-tab", browserRole: "market-collector", background: true }],
  }), true);
});

test("generic renderer local-api IPC cannot bypass the trusted recovery bridge", () => {
  for (const path of [
    "/api/app/recovery/command",
    "/api/app/recovery/command?attempt=1",
    "http://127.0.0.1:3790/api/app/recovery/command",
  ]) {
    assert.equal(isRendererRecoveryCommandRequest({ method: "POST", path }), true);
  }

  assert.equal(isRendererRecoveryCommandRequest({ method: "GET", path: "/api/app/recovery/command" }), false);
  assert.equal(isRendererRecoveryCommandRequest({ method: "POST", path: "/api/app/recovery/commands" }), false);
  assert.equal(isRendererRecoveryCommandRequest({ method: "POST", path: "/api/account-removal/confirm" }), false);
});

test("ordinary cache maintenance IPC refuses recovery mode and pending deletion", async () => {
  let requested = 0;
  const recoveryHandler = createProfileCacheMaintenanceIpcHandler({
    isRecoveryMode: () => true,
    hasPendingAccountRemoval: async () => false,
    requestProfileCacheMaintenance: async () => {
      requested += 1;
      return { ok: true };
    },
  });
  assert.equal((await recoveryHandler()).code, "PROFILE_DATABASE_RECOVERY_REQUIRED");

  const pendingHandler = createProfileCacheMaintenanceIpcHandler({
    hasPendingAccountRemoval: async () => true,
    requestProfileCacheMaintenance: async () => {
      requested += 1;
      return { ok: true };
    },
  });
  assert.equal((await pendingHandler()).code, "ACCOUNT_REMOVAL_PENDING");
  assert.equal(requested, 0);
});

test("ordinary cache maintenance IPC schedules only after both fences pass", async () => {
  const handler = createProfileCacheMaintenanceIpcHandler({
    hasPendingAccountRemoval: async () => false,
    requestProfileCacheMaintenance: async () => ({
      ok: true,
      scheduled: true,
    }),
  });
  assert.deepEqual(await handler(), { ok: true, scheduled: true });
});

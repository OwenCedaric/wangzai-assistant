import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPurchaseBridgeStateStore,
  sanitizePurchaseBridgeLicenseState,
} from "./purchaseBridgeState.js";

test("purchase bridge state only persists public entitlement fields", () => {
  const state = sanitizePurchaseBridgeLicenseState({
    mode: "enforce",
    authorized: true,
    permissions: ["purchase.manage", "purchase.manage"],
    expire: "2030-01-01T00:00:00Z",
    offline_until: "invalid",
    ["access_" + "token"]: "must-not-leak",
  });
  assert.deepEqual(state.permissions, ["purchase.manage"]);
  assert.equal(state.expire, "2030-01-01T00:00:00.000Z");
  assert.equal(state.offline_until, "");
  assert.equal(["access_", "token"].join("") in state, false);
});

test("purchase bridge state store creates a fail-closed initial file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-bridge-state-"));
  try {
    fs.writeFileSync(
      path.join(directory, "purchase-bridge-license.json.100.stale.tmp"),
      "stale",
    );
    const store = createPurchaseBridgeStateStore({ directory });
    const initial = JSON.parse(fs.readFileSync(store.statePath, "utf8"));
    assert.equal(initial.mode, "pending");
    assert.equal(initial.authorized, false);
    assert.match(store.authToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(
      fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("purchase bridge state retries a transient Windows rename conflict without deleting the last state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-bridge-state-retry-"));
  let renameCount = 0;
  const fileSystem = {
    ...fs,
    renameSync(source, target) {
      renameCount += 1;
      if (renameCount === 2 || renameCount === 3) {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      }
      return fs.renameSync(source, target);
    },
  };
  try {
    const store = createPurchaseBridgeStateStore({
      directory,
      fileSystem,
      retryDelaysMs: [0, 0],
      waitForRetry: () => undefined,
    });
    await store.updateLicenseState({
      mode: "enforce",
      authorized: true,
      permissions: ["purchase.manage"],
      expire: "2030-01-01T00:00:00Z",
    });
    const current = JSON.parse(fs.readFileSync(store.statePath, "utf8"));
    assert.equal(renameCount, 4);
    assert.equal(current.mode, "enforce");
    assert.equal(current.authorized, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("purchase bridge state falls back to a bounded direct overwrite when rename stays busy", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-bridge-state-fallback-"));
  let blockRename = false;
  let temporaryRemoveFailures = 2;
  let temporaryRemoveAttempts = 0;
  const fileSystem = {
    ...fs,
    renameSync(source, target) {
      if (blockRename) {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      }
      return fs.renameSync(source, target);
    },
    rmSync(target, options) {
      if (blockRename && String(target).endsWith(".tmp")) {
        temporaryRemoveAttempts += 1;
        if (temporaryRemoveFailures > 0) {
          temporaryRemoveFailures -= 1;
          const error = new Error("resource busy");
          error.code = "EBUSY";
          throw error;
        }
      }
      return fs.rmSync(target, options);
    },
  };
  try {
    const store = createPurchaseBridgeStateStore({
      directory,
      fileSystem,
      retryDelaysMs: [0, 0],
      waitForRetry: () => undefined,
    });
    blockRename = true;
    await store.updateLicenseState({ mode: "observe", authorized: true });
    const current = JSON.parse(fs.readFileSync(store.statePath, "utf8"));
    assert.equal(current.mode, "observe");
    assert.equal(current.authorized, true);
    assert.equal(temporaryRemoveAttempts, 3);
    assert.equal(
      fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("purchase bridge state schedules cleanup when a scanner keeps the temp file busy", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-bridge-state-cleanup-"));
  let blockRename = false;
  let temporaryRemoveFailures = 4;
  const scheduled = [];
  const fileSystem = {
    ...fs,
    renameSync(source, target) {
      if (blockRename) {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      }
      return fs.renameSync(source, target);
    },
    rmSync(target, options) {
      if (
        blockRename &&
        String(target).endsWith(".tmp") &&
        temporaryRemoveFailures > 0
      ) {
        temporaryRemoveFailures -= 1;
        const error = new Error("resource busy");
        error.code = "EBUSY";
        throw error;
      }
      return fs.rmSync(target, options);
    },
  };
  try {
    const store = createPurchaseBridgeStateStore({
      directory,
      fileSystem,
      retryDelaysMs: [0, 0],
      waitForRetry: () => undefined,
      cleanupRetryDelaysMs: [0, 0],
      scheduleCleanup(callback) {
        scheduled.push(callback);
      },
    });
    blockRename = true;
    await store.updateLicenseState({ mode: "enforce", authorized: true });
    assert.equal(scheduled.length, 1);
    while (scheduled.length > 0) await scheduled.shift()();
    assert.equal(
      fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

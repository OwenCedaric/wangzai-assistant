import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LicenseSessionStore } from "./licenseSessionStore.js";

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString("utf8"),
};

test("persists tokens encrypted and returns only public session state", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-session-test-"));
  try {
    const store = new LicenseSessionStore({ directory, safeStorage: fakeSafeStorage });
    await store.save({
      userAccessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      user: { id: 7, phone_masked: "138****8000" },
    });
    const bytes = await fs.readFile(store.sessionPath, "utf8");
    assert.equal(bytes.includes("test-access-token"), false);

    const reloaded = new LicenseSessionStore({ directory, safeStorage: fakeSafeStorage });
    await reloaded.load();
    assert.deepEqual(reloaded.publicSnapshot(), {
      authenticated: true,
      authorized: false,
      persistent: true,
      user: { id: 7, phone_masked: "138****8000" },
      entitlement: null,
    });
    const firstDevice = await reloaded.getDeviceCode();
    const secondDevice = await reloaded.getDeviceCode();
    assert.equal(firstDevice, secondDevice);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("falls back to memory when operating-system encryption is unavailable", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-session-test-"));
  try {
    const store = new LicenseSessionStore({
      directory,
      safeStorage: { isEncryptionAvailable: () => false },
    });
    await store.save({ userAccessToken: "memory-only" });
    assert.equal(store.publicSnapshot().authenticated, true);
    await assert.rejects(fs.access(store.sessionPath));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("never treats an expired cached entitlement as an active license", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-session-test-"));
  try {
    const store = new LicenseSessionStore({ directory, safeStorage: fakeSafeStorage });
    await store.save({
      userAccessToken: "user-token",
      entitlement: {
        valid: true,
        offline_until: new Date(Date.now() - 60_000).toISOString(),
        expire: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    assert.equal(store.publicSnapshot().authorized, false);
    assert.equal(store.publicSnapshot().entitlement, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the system clock moves backwards", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-session-test-"));
  try {
    const store = new LicenseSessionStore({ directory, safeStorage: fakeSafeStorage });
    const now = Date.now();
    await store.save({ lastObservedAtMs: now + 300_000 });
    assert.equal(await store.observeClock(now), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent session writes without losing rotated tokens", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-session-test-"));
  try {
    const store = new LicenseSessionStore({ directory, safeStorage: fakeSafeStorage });
    await Promise.all([
      store.save({ userAccessToken: "test-concurrent-access" }),
      store.save({ refreshToken: "test-concurrent-refresh" }),
    ]);
    const reloaded = new LicenseSessionStore({ directory, safeStorage: fakeSafeStorage });
    const session = await reloaded.load();
    assert.equal(session.userAccessToken, "test-concurrent-access");
    assert.equal(session.refreshToken, "test-concurrent-refresh");

    const pendingSave = store.save({ userAccessToken: "test-stale-access" });
    const pendingClear = store.clear();
    await Promise.all([pendingSave, pendingClear]);
    await assert.rejects(fs.access(store.sessionPath));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

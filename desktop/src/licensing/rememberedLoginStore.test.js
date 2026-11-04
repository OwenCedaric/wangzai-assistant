import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RememberedLoginStore } from "./rememberedLoginStore.js";

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8").map((byte) => byte ^ 0x91),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x91).toString("utf8"),
};

test("remembered login encrypts both email and password and exposes only public metadata", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".remembered-login-test-"));
  try {
    const store = new RememberedLoginStore({ directory, safeStorage: fakeSafeStorage });
    const snapshot = await store.save({
      email: " Demo@Example.com ",
      password: "DesktopPass123!",
    });
    assert.deepEqual(snapshot, {
      remembered: true,
      email: "demo@example.com",
      persistent: true,
    });
    const bytes = await fs.readFile(store.filePath, "utf8");
    assert.equal(bytes.includes("demo@example.com"), false);
    assert.equal(bytes.includes("DesktopPass123!"), false);

    const reloaded = new RememberedLoginStore({ directory, safeStorage: fakeSafeStorage });
    assert.deepEqual(await reloaded.credentials(), {
      email: "demo@example.com",
      password: "DesktopPass123!",
    });
    assert.deepEqual(await reloaded.publicSnapshot(), snapshot);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("clearing remembered login removes the encrypted file and secret", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".remembered-login-test-"));
  try {
    const store = new RememberedLoginStore({ directory, safeStorage: fakeSafeStorage });
    await store.save({ email: "demo@example.com", password: "DesktopPass123!" });
    assert.deepEqual(await store.clear(), {
      remembered: false,
      email: "",
      persistent: true,
    });
    assert.equal(await store.credentials(), null);
    await assert.rejects(fs.access(store.filePath));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("remembered login fails closed when operating-system encryption is unavailable", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".remembered-login-test-"));
  try {
    const store = new RememberedLoginStore({
      directory,
      safeStorage: { isEncryptionAvailable: () => false },
    });
    assert.deepEqual(
      await store.save({ email: "demo@example.com", password: "DesktopPass123!" }),
      { remembered: false, email: "", persistent: false },
    );
    assert.equal(await store.credentials(), null);
    await assert.rejects(fs.access(store.filePath));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const RETRYABLE_RENAME_CODES = new Set(["EBUSY", "EPERM"]);
const EMPTY_LOGIN = Object.freeze({ email: "", password: "" });

function normalizeLogin(value = {}) {
  return {
    email: String(value.email || "").trim().toLowerCase(),
    password: String(value.password || ""),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function replaceAtomically(temporaryPath, targetPath) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await fs.rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt === 4) throw error;
      await delay(attempt * 20);
    }
  }
}

export class RememberedLoginStore {
  constructor({ directory, safeStorage }) {
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.filePath = path.join(directory, "license-remembered-login.bin");
    this.memory = normalizeLogin(EMPTY_LOGIN);
    this.loaded = false;
    this.loadPromise = null;
    this.operationQueue = Promise.resolve();
  }

  canPersist() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
  }

  async load() {
    if (this.loaded) return this.memory;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        if (this.canPersist()) {
          try {
            const encrypted = await fs.readFile(this.filePath);
            const plaintext = this.safeStorage.decryptString(encrypted);
            this.memory = normalizeLogin(JSON.parse(plaintext));
          } catch {
            this.memory = normalizeLogin(EMPTY_LOGIN);
          }
        }
        this.loaded = true;
        return this.memory;
      })();
    }
    return this.loadPromise;
  }

  enqueue(operation) {
    const pending = this.operationQueue.then(operation, operation);
    this.operationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  save(value) {
    return this.enqueue(async () => {
      const next = normalizeLogin(value);
      if (!next.email || !next.password || !this.canPersist()) {
        await this.clearNow();
        return this.publicSnapshot();
      }
      this.memory = next;
      this.loaded = true;
      this.loadPromise = Promise.resolve(this.memory);
      await fs.mkdir(this.directory, { recursive: true });
      const encrypted = this.safeStorage.encryptString(JSON.stringify(this.memory));
      const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, encrypted, { mode: 0o600 });
      await replaceAtomically(temporary, this.filePath);
      return this.publicSnapshot();
    });
  }

  async clearNow() {
    this.memory = normalizeLogin(EMPTY_LOGIN);
    this.loaded = true;
    this.loadPromise = Promise.resolve(this.memory);
    await fs.rm(this.filePath, { force: true }).catch(() => undefined);
  }

  clear() {
    return this.enqueue(async () => {
      await this.clearNow();
      return this.publicSnapshot();
    });
  }

  async credentials() {
    const value = await this.load();
    if (!value.email || !value.password) return null;
    return { ...value };
  }

  async publicSnapshot() {
    const value = await this.load();
    const remembered = Boolean(value.email && value.password && this.canPersist());
    return {
      remembered,
      email: remembered ? value.email : "",
      persistent: this.canPersist(),
    };
  }
}

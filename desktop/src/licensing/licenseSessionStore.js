import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { verifyOfflineToken } from "./offlineTokenVerifier.js";

const RETRYABLE_RENAME_CODES = new Set(["EBUSY", "EPERM"]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function replaceAtomically(temporaryPath, targetPath) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      const retryable = RETRYABLE_RENAME_CODES.has(error?.code);
      if (!retryable || attempt === maxAttempts) throw error;
      await delay(attempt * 20);
    }
  }
}

const EMPTY_SESSION = Object.freeze({
  userAccessToken: "",
  refreshToken: "",
  licenseAccessToken: "",
  licenseKey: "",
  user: null,
  entitlement: null,
  offlinePublicKeyPem: "",
  offlineKeyId: "",
  lastObservedAtMs: 0,
});

function cleanSession(value = {}) {
  return {
    userAccessToken: String(value.userAccessToken || ""),
    refreshToken: String(value.refreshToken || ""),
    licenseAccessToken: String(value.licenseAccessToken || ""),
    licenseKey: String(value.licenseKey || ""),
    user: value.user && typeof value.user === "object" ? value.user : null,
    entitlement:
      value.entitlement && typeof value.entitlement === "object"
        ? value.entitlement
        : null,
    offlinePublicKeyPem: String(value.offlinePublicKeyPem || ""),
    offlineKeyId: String(value.offlineKeyId || ""),
    lastObservedAtMs:
      Number.isFinite(Number(value.lastObservedAtMs)) && Number(value.lastObservedAtMs) > 0
        ? Number(value.lastObservedAtMs)
        : 0,
  };
}

function verifiedEntitlement(session, expected) {
  if (
    expected.clockValid === false ||
    !session.entitlement?.valid ||
    !session.entitlement.offline_token
  ) {
    return null;
  }
  try {
    const claims = verifyOfflineToken(session.entitlement.offline_token, {
      publicKeyPem: session.offlinePublicKeyPem,
      keyId: session.offlineKeyId,
      expectedKeyFingerprint: expected.offlineKeyFingerprint,
      issuer: expected.jwtIssuer,
      audience: expected.jwtAudience,
      projectCode: expected.projectCode,
      deviceCode: expected.deviceCode,
    });
    return {
      ...session.entitlement,
      expire: claims.expire,
      offline_until: claims.offline_until,
      permissions: claims.permissions,
      device_limit: claims.device_limit,
      shop_limit: claims.shop_limit,
    };
  } catch {
    return null;
  }
}

export class LicenseSessionStore {
  constructor({ directory, safeStorage }) {
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.sessionPath = path.join(directory, "license-session.bin");
    this.devicePath = path.join(directory, "license-device-id");
    this.memory = cleanSession(EMPTY_SESSION);
    this.loaded = false;
    this.loadPromise = null;
    this.operationQueue = Promise.resolve();
    this.deviceCodePromise = null;
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
            const encrypted = await fs.readFile(this.sessionPath);
            const plaintext = this.safeStorage.decryptString(encrypted);
            this.memory = cleanSession(JSON.parse(plaintext));
          } catch {
            this.memory = cleanSession(EMPTY_SESSION);
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

  save(next) {
    return this.enqueue(async () => {
      this.memory = cleanSession({ ...(await this.load()), ...next });
      if (!this.canPersist()) return this.memory;
      await fs.mkdir(this.directory, { recursive: true });
      const encrypted = this.safeStorage.encryptString(JSON.stringify(this.memory));
      const temporary = `${this.sessionPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, encrypted, { mode: 0o600 });
      await replaceAtomically(temporary, this.sessionPath);
      return this.memory;
    });
  }

  clear() {
    return this.enqueue(async () => {
      this.memory = cleanSession(EMPTY_SESSION);
      this.loaded = true;
      this.loadPromise = Promise.resolve(this.memory);
      await fs.rm(this.sessionPath, { force: true }).catch(() => undefined);
    });
  }

  async readOrCreateDeviceCode() {
    try {
      const existing = String(await fs.readFile(this.devicePath, "utf8")).trim();
      if (existing) return existing;
    } catch {
      // First run creates a stable non-secret identifier below.
    }
    const deviceCode = `WZ-${crypto.randomUUID()}`;
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = `${this.devicePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, deviceCode, { encoding: "utf8", mode: 0o600 });
    await replaceAtomically(temporary, this.devicePath);
    return deviceCode;
  }

  getDeviceCode() {
    this.deviceCodePromise ||= this.readOrCreateDeviceCode();
    return this.deviceCodePromise;
  }

  async observeClock(now = Date.now()) {
    await this.load();
    const previous = this.memory.lastObservedAtMs;
    if (previous && now + 120_000 < previous) return false;
    if (!previous || now - previous >= 60_000) await this.save({ lastObservedAtMs: now });
    return true;
  }

  publicSnapshot(expected = {}) {
    const entitlement = verifiedEntitlement(this.memory, expected);
    const authorized = Boolean(entitlement);
    const publicEntitlement = entitlement ? { ...entitlement, valid: true } : null;
    if (publicEntitlement) delete publicEntitlement.offline_token;
    return {
      authenticated: Boolean(this.memory.userAccessToken),
      authorized,
      persistent: this.canPersist(),
      user: this.memory.user,
      entitlement: publicEntitlement,
    };
  }
}

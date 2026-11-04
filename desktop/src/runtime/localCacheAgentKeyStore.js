import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const RETRYABLE_RENAME_CODES = new Set(['EBUSY', 'EPERM']);

function cacheKeyError(code) {
  return Object.assign(new Error(code), { code });
}

function validKey(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(text)) throw cacheKeyError('LOCAL_CACHE_AGENT_KEY_INVALID');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== 32) throw cacheKeyError('LOCAL_CACHE_AGENT_KEY_INVALID');
  return text;
}

async function replaceAtomically(temporaryPath, targetPath) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await fs.rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 20));
    }
  }
}

export class LocalCacheAgentKeyStore {
  constructor({ directory, safeStorage }) {
    this.directory = path.resolve(directory);
    this.safeStorage = safeStorage;
    this.filePath = path.join(this.directory, 'local-cache-agent-key.bin');
    this.keyPromise = null;
  }

  encryptionAvailable() {
    return this.safeStorage?.isEncryptionAvailable?.() === true;
  }

  async loadOrCreateKey() {
    if (!this.encryptionAvailable()) throw cacheKeyError('LOCAL_CACHE_AGENT_OS_ENCRYPTION_UNAVAILABLE');
    this.keyPromise ||= this.loadOrCreateKeyNow().catch((error) => {
      this.keyPromise = null;
      throw error;
    });
    return this.keyPromise;
  }

  async loadOrCreateKeyNow() {
    try {
      const encrypted = await fs.readFile(this.filePath);
      return validKey(this.safeStorage.decryptString(encrypted));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.code?.startsWith?.('LOCAL_CACHE_AGENT_')) throw error;
        throw cacheKeyError('LOCAL_CACHE_AGENT_KEY_DECRYPT_FAILED');
      }
    }

    const key = crypto.randomBytes(32).toString('base64url');
    const encrypted = this.safeStorage.encryptString(key);
    await fs.mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, encrypted, { mode: 0o600, flag: 'wx' });
      await replaceAtomically(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return validKey(key);
  }
}


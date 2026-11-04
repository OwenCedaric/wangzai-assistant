import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalCacheAgentKeyStore } from './localCacheAgentKeyStore.js';

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0x73),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x73).toString('utf8'),
};

test('creates one OS-protected cache encryption key and reuses it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wangzai-cache-key-'));
  try {
    const firstStore = new LocalCacheAgentKeyStore({ directory, safeStorage });
    const first = await firstStore.loadOrCreateKey();
    const persisted = await fs.readFile(firstStore.filePath);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(persisted.toString('utf8').includes(first), false);
    const second = await new LocalCacheAgentKeyStore({ directory, safeStorage }).loadOrCreateKey();
    assert.equal(second, first);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when Windows safe storage is unavailable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wangzai-cache-key-'));
  try {
    const store = new LocalCacheAgentKeyStore({
      directory,
      safeStorage: { isEncryptionAvailable: () => false },
    });
    await assert.rejects(store.loadOrCreateKey(), { code: 'LOCAL_CACHE_AGENT_OS_ENCRYPTION_UNAVAILABLE' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('does not replace an unreadable key and orphan existing local data', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wangzai-cache-key-'));
  try {
    await fs.writeFile(path.join(directory, 'local-cache-agent-key.bin'), Buffer.from('broken'));
    const store = new LocalCacheAgentKeyStore({ directory, safeStorage });
    await assert.rejects(store.loadOrCreateKey(), { code: 'LOCAL_CACHE_AGENT_KEY_INVALID' });
    assert.deepEqual(await fs.readFile(store.filePath), Buffer.from('broken'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalCacheAgentRuntime } from './localCacheAgentRuntime.js';

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0x51),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x51).toString('utf8'),
};

test('starts the cache agent on loopback with main-process-only capabilities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wangzai-cache-runtime-'));
  const spawned = [];
  try {
    const runtime = createLocalCacheAgentRuntime({
      supervisor: {
        spawnElectronNodeScript(name, scriptPath, options) {
          spawned.push({ name, scriptPath, options });
          return { exitCode: null };
        },
      },
      safeStorage,
      dataRoot: path.join(root, 'customer-data'),
      scriptPath: path.join(root, 'local-cache-agent', 'server.js'),
      resolvePort: async () => 43792,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ ok: true, service: 'wangzai-local-cache-agent' }),
      }),
    });
    const started = await runtime.start();
    assert.equal(started.baseUrl, 'http://127.0.0.1:43792');
    assert.equal(started.remote, false);
    assert.equal(Object.hasOwn(started, 'encryptionKey'), false);
    assert.match(started.authToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(spawned[0].name, 'local-cache-agent-v2');
    assert.match(spawned[0].options.env.WANGZAI_CACHE_AGENT_ENCRYPTION_KEY, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(spawned[0].options.env.WANGZAI_CACHE_AGENT_DATA_ROOT, path.join(root, 'customer-data'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


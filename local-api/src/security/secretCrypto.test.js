import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deriveScopedEncryptionKey, encryptSecret } from './secretCrypto.js';

test('scoped internal keys are stable, 256-bit, and domain separated', () => {
  const originalSecret = process.env.LOCAL_API_SECRET;
  try {
    process.env.LOCAL_API_SECRET = 'scoped-key-test-master-secret';
    const first = deriveScopedEncryptionKey('technical-archive/encryption/v1');
    const second = deriveScopedEncryptionKey('technical-archive/encryption/v1');
    const dedupe = deriveScopedEncryptionKey('technical-archive/dedupe/v1');
    assert.equal(first.length, 32);
    assert.deepEqual(first, second);
    assert.notDeepEqual(first, dedupe);
  } finally {
    if (originalSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = originalSecret;
  }
});

async function loadFreshSecretCrypto(label) {
  const moduleUrl = new URL('./secretCrypto.js', import.meta.url);
  return import(`${moduleUrl.href}?runtime=${label}-${Date.now()}-${Math.random()}`);
}

test('canonical profile key decrypts after a fresh runtime load and a portable profile copy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-secret-crypto-'));
  const originalSecret = process.env.LOCAL_API_SECRET;
  const originalSecretFile = process.env.LOCAL_API_SECRET_FILE;
  try {
    delete process.env.LOCAL_API_SECRET;
    const sourceKeyPath = path.join(root, 'source-profile', 'local-api-data', 'local-api-secret.key');
    process.env.LOCAL_API_SECRET_FILE = sourceKeyPath;
    const encrypted = encryptSecret('account-secret-survives-restart');
    assert.ok(fs.existsSync(sourceKeyPath));

    const restarted = await loadFreshSecretCrypto('restart');
    assert.equal(restarted.decryptSecret(encrypted), 'account-secret-survives-restart');
    assert.equal(restarted.describeSecretStorage().source, sourceKeyPath);

    const portableKeyPath = path.join(root, 'portable-profile', 'local-api-data', 'local-api-secret.key');
    fs.mkdirSync(path.dirname(portableKeyPath), { recursive: true });
    fs.copyFileSync(sourceKeyPath, portableKeyPath);
    process.env.LOCAL_API_SECRET_FILE = portableKeyPath;
    const portable = await loadFreshSecretCrypto('portable');
    assert.equal(portable.decryptSecret(encrypted), 'account-secret-survives-restart');
    assert.equal(portable.describeSecretStorage().source, portableKeyPath);
  } finally {
    if (originalSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = originalSecret;
    if (originalSecretFile === undefined) delete process.env.LOCAL_API_SECRET_FILE;
    else process.env.LOCAL_API_SECRET_FILE = originalSecretFile;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('direct development runtime does not recreate the legacy desktop profile key path', async () => {
  const originalSecret = process.env.LOCAL_API_SECRET;
  const originalSecretFile = process.env.LOCAL_API_SECRET_FILE;
  try {
    delete process.env.LOCAL_API_SECRET;
    delete process.env.LOCAL_API_SECRET_FILE;
    const development = await loadFreshSecretCrypto('development-default');
    const source = development.describeSecretStorage().source;

    assert.equal(path.basename(source), 'local-api.development-secret.key');
    assert.notEqual(path.basename(source), 'local-api-secret.key');
  } finally {
    if (originalSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = originalSecret;
    if (originalSecretFile === undefined) delete process.env.LOCAL_API_SECRET_FILE;
    else process.env.LOCAL_API_SECRET_FILE = originalSecretFile;
  }
});

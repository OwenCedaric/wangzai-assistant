import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config/loadConfig.js';

const ENVIRONMENT_KEYS = Object.freeze([
  'LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH',
  'LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH',
  'LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID',
  'LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256',
  'LOCAL_API_PROTECTED_COMPUTE_VERSION_STATE_PATH',
]);

function restoreEnvironment(previous) {
  for (const key of ENVIRONMENT_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

test('protected-compute environment trust tuple is all-or-nothing and validated', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wangzai-protected-config-'));
  const configPath = path.join(directory, 'local-api.config.json');
  writeFileSync(configPath, '{}\n', 'utf8');
  const previous = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );

  try {
    for (const key of ENVIRONMENT_KEYS) delete process.env[key];
    assert.equal(loadConfig(configPath).protectedCompute.signedPublicConfigPath, '');

    process.env.LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH = path.join(directory, 'signed.json');
    process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH = path.join(directory, 'public.pem');
    process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID = 'protected-compute-config-v1';
    process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256 = 'a'.repeat(64);
    assert.throws(
      () => loadConfig(configPath),
      /必须同时提供 signed config、公钥、key id、公钥指纹和持久版本状态路径/u,
    );

    process.env.LOCAL_API_PROTECTED_COMPUTE_VERSION_STATE_PATH = path.join(directory, 'state.enc');
    const loaded = loadConfig(configPath).protectedCompute;
    assert.equal(loaded.signedPublicConfigPath, path.join(directory, 'signed.json'));
    assert.equal(loaded.configurationPublicKeyPath, path.join(directory, 'public.pem'));
    assert.equal(loaded.configurationKeyId, 'protected-compute-config-v1');
    assert.equal(loaded.configurationKeySha256, 'a'.repeat(64));
    assert.equal(loaded.versionStatePath, path.join(directory, 'state.enc'));

    process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256 = 'not-a-fingerprint';
    assert.throws(() => loadConfig(configPath), /SHA-256 指纹格式无效/u);
  } finally {
    restoreEnvironment(previous);
    rmSync(directory, { force: true, recursive: true });
  }
});

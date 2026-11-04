import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/domain/protectedCompute/canonicalJson.js';
import { createProtectedComputeRuntimeFromConfig } from '../src/domain/protectedCompute/protectedComputeRuntime.js';

const NOW = new Date('2026-07-16T00:00:00.000Z');
const COLLECTION_REQUEST = Object.freeze({
  capability: 'collection-pricing.quote',
  version: 1,
  input: Object.freeze({
    commissionBasisPoints: 1_700,
    currency: 'CNY',
    currentPriceMinor: 5_516,
    extraCostMinor: 100,
    firstMileCostMinor: 600,
    purchaseCostMinor: 2_500,
    targetMarginBasisPoints: 2_000,
  }),
});

function fingerprint(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

function signedConfig(configurationPrivateKey, computePublicKey, overrides = {}) {
  const payload = {
    computeKeys: [{
      algorithm: 'Ed25519',
      keyId: 'runtime-compute-v1',
      publicKeyPem: computePublicKey.export({ type: 'spki', format: 'pem' }),
    }],
    configVersion: 1,
    contract: 'signed-public-protected-compute-config/v1',
    expiresAt: '2026-07-17T00:00:00.000Z',
    issuedAt: NOW.toISOString(),
    revocationEpoch: 4,
    revokedCapabilities: [],
    revokedKeyIds: [],
    serverBaseUrl: 'https://license.example.test',
    signatureAlgorithm: 'Ed25519',
    signingKeyId: 'runtime-config-v1',
    ...overrides,
  };
  return {
    ...payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      configurationPrivateKey,
    ).toString('base64url'),
  };
}

test('runtime composition accepts only fingerprint-pinned signed-public configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protected-runtime-'));
  try {
    const configurationKeys = generateKeyPairSync('ed25519');
    const computeKeys = generateKeyPairSync('ed25519');
    const keyPath = path.join(root, 'configuration-public.pem');
    const configPath = path.join(root, 'protected-compute.signed-public.json');
    await writeFile(
      keyPath,
      configurationKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      'utf8',
    );
    await writeFile(
      configPath,
      JSON.stringify(signedConfig(configurationKeys.privateKey, computeKeys.publicKey)),
      'utf8',
    );
    const config = {
      signedPublicConfigPath: configPath,
      configurationPublicKeyPath: keyPath,
      configurationKeyId: 'runtime-config-v1',
      configurationKeySha256: fingerprint(configurationKeys.publicKey),
      offlineEnabled: true,
    };

    const runtime = createProtectedComputeRuntimeFromConfig(config, {
      now: () => NOW,
      fetchImpl: async () => assert.fail('status bootstrap must not call the remote server'),
    });
    assert.equal(runtime.status.available, true);
    assert.equal(runtime.status.configVersion, 1);
    assert.equal(runtime.status.offlineEnabled, false, 'no approved signed-result store was injected');
    assert.equal(typeof runtime.client.execute, 'function');
    assert.equal(typeof runtime.getStatus, 'function');
    assert.equal(typeof runtime.reloadSignedPublicConfig, 'function');

    const wrongFingerprint = createProtectedComputeRuntimeFromConfig({
      ...config,
      configurationKeySha256: '0'.repeat(64),
    }, { now: () => NOW });
    assert.equal(wrongFingerprint.status.available, false);
    assert.equal(
      wrongFingerprint.status.reasonCode,
      'PROTECTED_COMPUTE_CONFIG_KEY_FINGERPRINT_MISMATCH',
    );

    const incomplete = createProtectedComputeRuntimeFromConfig({
      signedPublicConfigPath: configPath,
    }, { now: () => NOW });
    assert.equal(incomplete.status.available, false);
    assert.equal(incomplete.status.reasonCode, 'PROTECTED_COMPUTE_RUNTIME_CONFIG_INCOMPLETE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime rechecks signed-public expiry on status and every execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protected-runtime-expiry-'));
  try {
    const configurationKeys = generateKeyPairSync('ed25519');
    const computeKeys = generateKeyPairSync('ed25519');
    const keyPath = path.join(root, 'configuration-public.pem');
    const configPath = path.join(root, 'protected-compute.signed-public.json');
    await writeFile(
      keyPath,
      configurationKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      'utf8',
    );
    await writeFile(
      configPath,
      JSON.stringify(signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
        expiresAt: '2026-07-16T00:01:00.000Z',
      })),
      'utf8',
    );
    let currentTime = NOW;
    let transportCalls = 0;
    const runtime = createProtectedComputeRuntimeFromConfig({
      signedPublicConfigPath: configPath,
      configurationPublicKeyPath: keyPath,
      configurationKeyId: 'runtime-config-v1',
      configurationKeySha256: fingerprint(configurationKeys.publicKey),
    }, {
      now: () => currentTime,
      fetchImpl: async () => {
        transportCalls += 1;
        return new Response('{}', { status: 500 });
      },
    });
    assert.equal(runtime.getStatus().available, true);

    currentTime = new Date('2026-07-16T00:01:00.000Z');
    const expiredStatus = runtime.getStatus();
    assert.equal(expiredStatus.available, false);
    assert.equal(expiredStatus.configVersion, 1);
    assert.equal(expiredStatus.reasonCode, 'PROTECTED_COMPUTE_CONFIG_EXPIRED');
    await assert.rejects(
      runtime.client.execute(COLLECTION_REQUEST),
      (error) => error?.code === 'PROTECTED_COMPUTE_CONFIG_EXPIRED' && error?.status === 503,
    );
    assert.equal(transportCalls, 0, 'expired public policy must block before transport or offline reuse');

    const replacement = signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
      configVersion: 2,
      issuedAt: '2026-07-16T00:00:30.000Z',
      expiresAt: '2026-07-17T00:00:00.000Z',
      revocationEpoch: 5,
    });
    await writeFile(configPath, JSON.stringify(replacement), 'utf8');
    assert.equal(runtime.reloadSignedPublicConfig().available, true);
    assert.equal(runtime.getStatus().configVersion, 2);
    assert.equal(transportCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime accepts explicit forward signed rotation and fails closed on rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protected-runtime-rotation-'));
  try {
    const configurationKeys = generateKeyPairSync('ed25519');
    const computeKeys = generateKeyPairSync('ed25519');
    const keyPath = path.join(root, 'configuration-public.pem');
    const configPath = path.join(root, 'protected-compute.signed-public.json');
    const initialConfig = signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
      configVersion: 2,
      revocationEpoch: 4,
    });
    await writeFile(
      keyPath,
      configurationKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      'utf8',
    );
    await writeFile(configPath, JSON.stringify(initialConfig), 'utf8');
    let transportCalls = 0;
    const runtime = createProtectedComputeRuntimeFromConfig({
      signedPublicConfigPath: configPath,
      configurationPublicKeyPath: keyPath,
      configurationKeyId: 'runtime-config-v1',
      configurationKeySha256: fingerprint(configurationKeys.publicKey),
    }, {
      now: () => new Date('2026-07-16T00:10:00.000Z'),
      fetchImpl: async () => {
        transportCalls += 1;
        return new Response('{}', { status: 500 });
      },
    });
    assert.equal(runtime.getStatus().configVersion, 2);

    const forwardConfig = signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
      configVersion: 3,
      issuedAt: '2026-07-16T00:05:00.000Z',
      expiresAt: '2026-07-18T00:00:00.000Z',
      revocationEpoch: 5,
      revokedKeyIds: ['retired-compute-v0'],
    });
    await writeFile(configPath, JSON.stringify(forwardConfig), 'utf8');
    const rotatedStatus = runtime.reloadSignedPublicConfig();
    assert.equal(rotatedStatus.available, true);
    assert.equal(rotatedStatus.configVersion, 3);
    assert.equal(rotatedStatus.configExpiresAt, '2026-07-18T00:00:00.000Z');

    const rollbackConfig = signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
      configVersion: 2,
      issuedAt: '2026-07-16T00:06:00.000Z',
      expiresAt: '2026-07-18T00:00:00.000Z',
      revocationEpoch: 5,
      revokedKeyIds: ['retired-compute-v0'],
    });
    await writeFile(configPath, JSON.stringify(rollbackConfig), 'utf8');
    assert.throws(
      () => runtime.reloadSignedPublicConfig(),
      (error) => error?.code === 'PROTECTED_COMPUTE_CONFIG_ROLLBACK_REJECTED'
        && error?.status === 503,
    );
    assert.equal(runtime.getStatus().available, false);
    assert.equal(runtime.getStatus().reasonCode, 'PROTECTED_COMPUTE_CONFIG_ROLLBACK_REJECTED');
    await assert.rejects(
      runtime.client.execute(COLLECTION_REQUEST),
      (error) => error?.code === 'PROTECTED_COMPUTE_CONFIG_ROLLBACK_REJECTED',
    );
    assert.equal(transportCalls, 0, 'rollback candidate must block before transport');

    await writeFile(configPath, JSON.stringify(forwardConfig), 'utf8');
    assert.equal(runtime.reloadSignedPublicConfig().available, true);
    assert.equal(runtime.getStatus().configVersion, 3);

    const revocationRollback = signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
      configVersion: 4,
      issuedAt: '2026-07-16T00:07:00.000Z',
      expiresAt: '2026-07-18T00:00:00.000Z',
      revocationEpoch: 4,
      revokedKeyIds: [],
    });
    await writeFile(configPath, JSON.stringify(revocationRollback), 'utf8');
    assert.throws(
      () => runtime.reloadSignedPublicConfig(),
      (error) => error?.code === 'PROTECTED_COMPUTE_CONFIG_ROLLBACK_REJECTED',
    );

    await writeFile(configPath, JSON.stringify(forwardConfig), 'utf8');
    assert.equal(runtime.reloadSignedPublicConfig().available, true);
    const tamperedConfig = {
      ...forwardConfig,
      serverBaseUrl: 'https://tampered.example.test',
    };
    await writeFile(configPath, JSON.stringify(tamperedConfig), 'utf8');
    assert.throws(
      () => runtime.reloadSignedPublicConfig(),
      (error) => error?.code === 'PROTECTED_COMPUTE_CONFIG_SIGNATURE_INVALID',
    );
    assert.equal(runtime.getStatus().available, false);
    assert.equal(runtime.getStatus().reasonCode, 'PROTECTED_COMPUTE_CONFIG_SIGNATURE_INVALID');
    assert.equal(transportCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('authenticated version high-water mark rejects rollback after local-api restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protected-runtime-persistent-'));
  const previousSecretFile = process.env.LOCAL_API_SECRET_FILE;
  try {
    process.env.LOCAL_API_SECRET_FILE = path.join(root, 'local-api-secret.key');
    const configurationKeys = generateKeyPairSync('ed25519');
    const computeKeys = generateKeyPairSync('ed25519');
    const keyPath = path.join(root, 'configuration-public.pem');
    const configPath = path.join(root, 'protected-compute.signed-public.json');
    const versionStatePath = path.join(root, 'protected-compute-version-state.enc');
    await writeFile(
      keyPath,
      configurationKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      'utf8',
    );
    const runtimeConfig = {
      signedPublicConfigPath: configPath,
      configurationPublicKeyPath: keyPath,
      configurationKeyId: 'runtime-config-v1',
      configurationKeySha256: fingerprint(configurationKeys.publicKey),
      versionStatePath,
    };
    const dependencies = {
      now: () => new Date('2026-07-16T00:10:00.000Z'),
      fetchImpl: async () => assert.fail('persistent-state bootstrap must not call transport'),
    };
    const versionThree = signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
      configVersion: 3,
      expiresAt: '2026-07-18T00:00:00.000Z',
      revocationEpoch: 5,
      revokedKeyIds: ['retired-key-v0'],
    });
    await writeFile(configPath, JSON.stringify(versionThree), 'utf8');
    const firstRuntime = createProtectedComputeRuntimeFromConfig(runtimeConfig, dependencies);
    assert.equal(firstRuntime.getStatus().available, true);
    assert.equal(firstRuntime.getStatus().configVersion, 3);
    assert.equal(fs.existsSync(versionStatePath), true);
    assert.doesNotMatch(fs.readFileSync(versionStatePath, 'utf8'), /retired-key|configVersion/u);

    const versionTwo = signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
      configVersion: 2,
      issuedAt: '2026-07-16T00:01:00.000Z',
      expiresAt: '2026-07-18T00:00:00.000Z',
      revocationEpoch: 5,
      revokedKeyIds: ['retired-key-v0'],
    });
    await writeFile(configPath, JSON.stringify(versionTwo), 'utf8');
    const restartedOnRollback = createProtectedComputeRuntimeFromConfig(runtimeConfig, dependencies);
    assert.equal(restartedOnRollback.status.available, false);
    assert.equal(
      restartedOnRollback.status.reasonCode,
      'PROTECTED_COMPUTE_CONFIG_ROLLBACK_REJECTED',
    );

    const versionFour = signedConfig(configurationKeys.privateKey, computeKeys.publicKey, {
      configVersion: 4,
      issuedAt: '2026-07-16T00:05:00.000Z',
      expiresAt: '2026-07-18T00:00:00.000Z',
      revocationEpoch: 6,
      revokedKeyIds: ['retired-key-v0'],
    });
    await writeFile(configPath, JSON.stringify(versionFour), 'utf8');
    const restartedForward = createProtectedComputeRuntimeFromConfig(runtimeConfig, dependencies);
    assert.equal(restartedForward.status.available, true);
    assert.equal(restartedForward.status.configVersion, 4);

    await writeFile(versionStatePath, 'secretbox:v1:tampered:state:value\n', 'utf8');
    const restartedWithTamperedState = createProtectedComputeRuntimeFromConfig(
      runtimeConfig,
      dependencies,
    );
    assert.equal(restartedWithTamperedState.status.available, false);
    assert.equal(
      restartedWithTamperedState.status.reasonCode,
      'PROTECTED_COMPUTE_VERSION_STATE_INVALID',
    );
  } finally {
    if (previousSecretFile === undefined) delete process.env.LOCAL_API_SECRET_FILE;
    else process.env.LOCAL_API_SECRET_FILE = previousSecretFile;
    await rm(root, { recursive: true, force: true });
  }
});

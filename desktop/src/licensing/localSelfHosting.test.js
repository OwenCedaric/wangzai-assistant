import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalSelfHostingUrl, verifySignedProtectedComputePublicConfig, protectedComputePublicKeyFingerprint } from './protectedComputeDistribution.js';
import { generateKeyPairSync, sign } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

test('local self hosting only accepts authenticated TLS on loopback addresses', () => {
  assert.equal(isLocalSelfHostingUrl('https://127.0.0.1:18443'), true);
  for (const url of ['http://127.0.0.1:18443', 'https://127.0.0.1.example.com', 'https://localhost@remote.example', 'https://192.168.1.10', 'https://license.example.invalid', 'https://localhost?token=sample']) {
    assert.equal(isLocalSelfHostingUrl(url), false, url);
  }
});

test('a local signed configuration still requires the trusted key, exact URL and unexpired signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' });
  const body = {
    contract: 'signed-public-protected-compute-config/v1', configVersion: 1,
    signatureAlgorithm: 'Ed25519', signingKeyId: 'local-configuration-v1',
    issuedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z',
    serverBaseUrl: 'https://127.0.0.1:18443', revocationEpoch: 0, revokedCapabilities: [], revokedKeyIds: [],
    computeKeys: [{ keyId: 'compute-v1', algorithm: 'Ed25519', publicKeyPem: publicPem }],
  };
  const signedConfig = { ...body, signature: sign(null, Buffer.from(canonical(body)), privateKey).toString('base64url') };
  const args = { signedConfig, configurationPublicKeyPem: publicPem, configurationKeyId: body.signingKeyId,
    configurationKeySha256: protectedComputePublicKeyFingerprint(publicPem), expectedServerUrl: body.serverBaseUrl,
    now: () => new Date('2026-11-05'), allowLocalSelfHosting: true };
  assert.doesNotThrow(() => verifySignedProtectedComputePublicConfig(args));
  assert.throws(() => verifySignedProtectedComputePublicConfig({ ...args, allowLocalSelfHosting: false }));
  assert.throws(() => verifySignedProtectedComputePublicConfig({ ...args, signedConfig: { ...signedConfig, configVersion: 2 } }));
  assert.throws(() => verifySignedProtectedComputePublicConfig({ ...args, expectedServerUrl: 'https://127.0.0.1:18444' }));
  assert.throws(() => verifySignedProtectedComputePublicConfig({ ...args, now: () => new Date('2027-01-01') }));
});

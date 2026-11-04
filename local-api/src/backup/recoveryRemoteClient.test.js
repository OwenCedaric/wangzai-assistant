import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecoveryChunk, encryptRecoveryChunk } from './recoveryChunkCodec.js';
import {
  createRecoveryRemoteClient,
  deriveRecoveryOwnerRef,
  deriveRecoveryScopeKey,
} from './recoveryRemoteClient.js';

const encryptionKey = Buffer.alloc(32, 71);
const dedupeKey = Buffer.alloc(32, 72);

function encryptedObject(domain, record) {
  return encryptRecoveryChunk({
    chunk: buildRecoveryChunk({ domain, partitionKey: 'profile:current', records: [record] }),
    encryptionKey,
    dedupeKey,
    aad: 'remote-test',
  });
}

function transport() {
  const data = encryptedObject('products', { key: 'shop_id:shop-a|product_key:1', value: { shop_id: 'shop-a' } });
  const manifest = encryptedObject('recovery-generation-manifest', { key: 'generation:g', value: { version: 1 } });
  return {
    format: 'wangzai-recovery-generation',
    version: 1,
    keyEnvelope: { format: 'wangzai-recovery-key-envelope', version: 1, ciphertextB64u: 'opaque' },
    manifestObject: { chunkId: manifest.chunkId, cipherBytes: manifest.cipherBytes, cipherSha256: manifest.cipherSha256 },
    logicalCipherBytes: data.cipherBytes + manifest.cipherBytes,
    objects: [data, manifest],
  };
}

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('recovery remote client uploads opaque bytes, commits references, and checks every server confirmation', async () => {
  const input = transport();
  const calls = [];
  const scopeKey = deriveRecoveryScopeKey({ dedupeKey, shopId: 'shop-a' });
  const ownerRef = deriveRecoveryOwnerRef({
    dedupeKey,
    ownerType: 'ozon_shop',
    ownerId: 'shop-a',
    ownerIncarnation: '2026-07-15T00:00:00.000Z',
  });
  const client = createRecoveryRemoteClient({
    baseUrl: 'https://recovery.example',
    accessToken: 'token',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'PUT') {
        const chunkId = url.split('/').at(-1);
        const bytes = Buffer.from(options.body);
        return responseJson({ chunk_id: chunkId, cipher_bytes: bytes.length, reused: false });
      }
      if (!options.method && url.endsWith('/generations')) return responseJson([]);
      return responseJson({
        generation_id: 'g'.repeat(36),
        scope_key: scopeKey,
        manifest_chunk_id: input.manifestObject.chunkId,
        key_envelope: input.keyEnvelope,
        logical_cipher_bytes: input.logicalCipherBytes,
        owner_refs: [ownerRef],
      }, 201);
    },
  });
  assert.equal(scopeKey.includes('shop-a'), false);
  const committed = await client.uploadGeneration({ scopeKey, ownerRefs: [ownerRef], transport: input });
  assert.equal(committed.generation_id, 'g'.repeat(36));
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  const commitPayload = JSON.parse(calls.at(-1).options.body);
  assert.equal(JSON.stringify(commitPayload).includes('shop-a'), false);
  assert.equal(commitPayload.object_refs.length, 2);
  assert.equal(commitPayload.expected_generation_id, null);
  assert.deepEqual(commitPayload.owner_refs, [ownerRef]);
  assert.equal(ownerRef.includes('shop-a'), false);
  assert.notEqual(ownerRef, deriveRecoveryOwnerRef({
    dedupeKey,
    ownerType: 'ozon_shop',
    ownerId: 'shop-a',
    ownerIncarnation: '2026-07-16T00:00:00.000Z',
  }));
});

test('recovery remote client creates and reads a race-safe opaque owner purge tombstone', async () => {
  const ownerRef = deriveRecoveryOwnerRef({
    dedupeKey,
    ownerType: 'purchase_account',
    ownerId: 'purchase-a',
    ownerIncarnation: '2026-07-15T00:00:00.000Z',
  });
  const expectedGenerationIds = ['a'.repeat(43), 'b'.repeat(43)];
  const calls = [];
  const client = createRecoveryRemoteClient({
    baseUrl: 'https://recovery.example',
    accessToken: 'token',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/purge-status')) {
        return responseJson({ owner_ref: ownerRef, tombstoned: true });
      }
      return responseJson({
        owner_ref: ownerRef,
        tombstoned: true,
        deleted_generation_ids: ['a'.repeat(43)],
        remaining_generation_count: 1,
      });
    },
  });
  const purged = await client.purgeOwner({ ownerRef, expectedGenerationIds });
  assert.deepEqual(purged, {
    ownerRef,
    tombstoned: true,
    deletedGenerationIds: ['a'.repeat(43)],
    remainingGenerationCount: 1,
  });
  assert.deepEqual(JSON.parse(calls[0].options.body).expected_generation_ids, expectedGenerationIds);
  assert.deepEqual(await client.getOwnerPurgeStatus({ ownerRef }), { ownerRef, tombstoned: true });
});

test('recovery remote client stops on a generation CAS conflict instead of replacing a newer backup', async () => {
  const input = transport();
  const scopeKey = deriveRecoveryScopeKey({ dedupeKey, shopId: 'shop-a' });
  let commitPayload = null;
  const client = createRecoveryRemoteClient({
    baseUrl: 'https://recovery.example',
    accessToken: 'token',
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'PUT') {
        const bytes = Buffer.from(options.body);
        return responseJson({ chunk_id: url.split('/').at(-1), cipher_bytes: bytes.length, reused: false });
      }
      if (options.method === 'POST') {
        commitPayload = JSON.parse(options.body);
        return responseJson({ detail: 'Recovery generation conflict' }, 409);
      }
      return responseJson([{
        generation_id: 'a'.repeat(43),
        scope_key: scopeKey,
        manifest_chunk_id: input.manifestObject.chunkId,
        key_envelope: input.keyEnvelope,
        logical_cipher_bytes: input.logicalCipherBytes,
      }]);
    },
  });
  await assert.rejects(
    client.uploadGeneration({ scopeKey, transport: input }),
    /RECOVERY_REMOTE_COMMIT_CONFLICT/,
  );
  assert.equal(commitPayload.expected_generation_id, 'a'.repeat(43));
});

test('recovery remote client rebuilds a transport only after each downloaded object matches its headers and refs', async () => {
  const input = transport();
  const generationId = 'g'.repeat(36);
  const objects = new Map(input.objects.map((item) => [item.chunkId, item]));
  const client = createRecoveryRemoteClient({
    baseUrl: 'https://recovery.example',
    accessToken: 'token',
    fetchImpl: async (url) => {
      if (url.endsWith(`/generations/${generationId}`)) {
        return responseJson({
          generation_id: generationId,
          scope_key: 's'.repeat(43),
          manifest_chunk_id: input.manifestObject.chunkId,
          key_envelope: input.keyEnvelope,
          logical_cipher_bytes: input.logicalCipherBytes,
          object_refs: input.objects.map((item) => ({
            chunk_id: item.chunkId,
            cipher_bytes: item.cipherBytes,
            cipher_sha256: item.cipherSha256,
          })),
        });
      }
      const chunkId = url.split('/').at(-1);
      const item = objects.get(chunkId);
      const bytes = Buffer.concat([
        Buffer.from(item.nonceB64u, 'base64url'),
        Buffer.from(item.tagB64u, 'base64url'),
        Buffer.from(item.ciphertextB64u, 'base64url'),
      ]);
      return new Response(bytes, {
        headers: {
          'X-Recovery-Cipher-Sha256': item.cipherSha256,
          'X-Recovery-Cipher-Bytes': String(item.cipherBytes),
        },
      });
    },
  });
  const restored = await client.downloadGeneration({ generationId });
  assert.deepEqual(restored.manifestObject, input.manifestObject);
  assert.deepEqual(new Set(restored.objects.map((item) => item.chunkId)), new Set(input.objects.map((item) => item.chunkId)));
});

test('recovery remote client restores legacy UUID generations but rejects an unvalidated commit response', async () => {
  const input = transport();
  const legacyGenerationId = 'd3a1ba67-c52c-4e6a-9332-f8a765cbdf14';
  const scopeKey = deriveRecoveryScopeKey({ dedupeKey, shopId: 'shop-a' });
  const objects = new Map(input.objects.map((item) => [item.chunkId, item]));
  const client = createRecoveryRemoteClient({
    baseUrl: 'https://recovery.example',
    accessToken: 'token',
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST') {
        return responseJson({
          generation_id: legacyGenerationId,
          scope_key: scopeKey,
          manifest_chunk_id: 'm'.repeat(43),
          key_envelope: input.keyEnvelope,
          logical_cipher_bytes: input.logicalCipherBytes,
        }, 201);
      }
      if (options.method === 'PUT') {
        const bytes = Buffer.from(options.body);
        return responseJson({ chunk_id: url.split('/').at(-1), cipher_bytes: bytes.length, reused: false });
      }
      if (url.endsWith(`/generations/${legacyGenerationId}`)) {
        return responseJson({
          generation_id: legacyGenerationId,
          scope_key: 's'.repeat(43),
          manifest_chunk_id: input.manifestObject.chunkId,
          key_envelope: input.keyEnvelope,
          logical_cipher_bytes: input.logicalCipherBytes,
          object_refs: input.objects.map((item) => ({
            chunk_id: item.chunkId,
            cipher_bytes: item.cipherBytes,
            cipher_sha256: item.cipherSha256,
          })),
        });
      }
      if (!options.method && url.endsWith('/generations')) return responseJson([]);
      const item = objects.get(url.split('/').at(-1));
      const bytes = Buffer.concat([
        Buffer.from(item.nonceB64u, 'base64url'),
        Buffer.from(item.tagB64u, 'base64url'),
        Buffer.from(item.ciphertextB64u, 'base64url'),
      ]);
      return new Response(bytes, {
        headers: {
          'X-Recovery-Cipher-Sha256': item.cipherSha256,
          'X-Recovery-Cipher-Bytes': String(item.cipherBytes),
        },
      });
    },
  });
  const restored = await client.downloadGeneration({ generationId: legacyGenerationId });
  assert.equal(restored.logicalCipherBytes, input.logicalCipherBytes);
  await assert.rejects(
    client.uploadGeneration({ scopeKey, transport: input }),
    /RECOVERY_REMOTE_COMMIT_RESPONSE_INVALID/,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecoveryChunk,
  canonicalJson,
  decryptRecoveryChunk,
  encryptRecoveryChunk,
  parseAndValidateRecoveryChunk,
} from './recoveryChunkCodec.js';

const encryptionKey = Buffer.alloc(32, 7);
const dedupeKey = Buffer.alloc(32, 9);
const aad = 'wangzai-recovery:v1:account-opaque:shop-opaque';

test('recovery chunk canonicalization, compression, encryption and verification round-trip without plaintext metadata', () => {
  assert.equal(canonicalJson({ z: 1, a: { d: true, b: [2, 1] } }), '{"a":{"b":[2,1],"d":true},"z":1}');
  const chunk = buildRecoveryChunk({
    domain: 'orders',
    domainSchemaVersion: 3,
    partitionKey: 'month:2026-07/shard:00',
    records: [
      { key: 'posting:2', value: { amountMinor: 200, shopId: 'shop-private' } },
      { key: 'posting:1', value: { amountMinor: 100, shopId: 'shop-private' } },
    ],
  });
  const encrypted = encryptRecoveryChunk({ chunk, encryptionKey, dedupeKey, aad });
  assert.equal(encrypted.chunkId.includes('orders'), false);
  assert.equal(encrypted.ciphertextB64u.includes('shop-private'), false);
  const restored = decryptRecoveryChunk({ encrypted, encryptionKey, aad });
  assert.equal(restored.header.domain, 'orders');
  assert.deepEqual(restored.records.map((record) => record.key), ['posting:1', 'posting:2']);
  assert.equal(restored.recordsRootHash, chunk.recordsRootHash);
});

test('recovery chunk is deterministic for the same logical records and fails closed after ciphertext tampering', () => {
  const input = {
    domain: 'products', partitionKey: 'current/shard:00', records: [{ key: 'product:1', value: { name: 'A' } }],
  };
  const first = encryptRecoveryChunk({ chunk: buildRecoveryChunk(input), encryptionKey, dedupeKey, aad });
  const second = encryptRecoveryChunk({ chunk: buildRecoveryChunk({ ...input, records: [...input.records].reverse() }), encryptionKey, dedupeKey, aad });
  assert.equal(first.chunkId, second.chunkId);
  assert.equal(first.ciphertextB64u, second.ciphertextB64u);
  assert.throws(
    () => decryptRecoveryChunk({
      encrypted: { ...first, ciphertextB64u: `${first.ciphertextB64u.slice(0, -1)}A` }, encryptionKey, aad,
    }),
    /RECOVERY_CIPHER_HASH_MISMATCH/,
  );
});

test('recovery chunk build and read use the same canonical key order for mixed case', () => {
  const chunk = buildRecoveryChunk({
    domain: 'purchase-overrides',
    partitionKey: 'scope:current',
    records: [
      { key: 'shop_id:shop-a|order_key:client:purchase-status-check-105', value: { id: 2 } },
      { key: 'shop_id:shop-a|order_key:client:TEST-SPLIT-0001-1', value: { id: 1 } },
    ],
  });
  const parsed = parseAndValidateRecoveryChunk(chunk.plaintext);

  assert.deepEqual(parsed.records.map((record) => record.key), [
    'shop_id:shop-a|order_key:client:TEST-SPLIT-0001-1',
    'shop_id:shop-a|order_key:client:purchase-status-check-105',
  ]);
});

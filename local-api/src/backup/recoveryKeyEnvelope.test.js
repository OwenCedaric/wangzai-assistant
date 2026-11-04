import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRecoveryKeyEnvelope,
  generateRecoveryKeyset,
  openRecoveryKeyEnvelope,
} from './recoveryKeyEnvelope.js';

const passphrase = 'correct horse battery staple 2026';
const aad = 'wangzai-recovery:v1:account-opaque:shop-opaque';

test('recovery key envelope restores the exact keyset without exposing key material in server-visible fields', () => {
  const keyset = generateRecoveryKeyset((size) => Buffer.alloc(size, size));
  const envelope = createRecoveryKeyEnvelope({ keyset, passphrase, aad });
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(keyset.chunkEncryptionKey.toString('base64url')), false);
  assert.equal(serialized.includes(keyset.dedupeKey.toString('base64url')), false);
  assert.equal(envelope.aad, aad);
  const restored = openRecoveryKeyEnvelope({ envelope, passphrase, aad });
  assert.deepEqual(restored.chunkEncryptionKey, keyset.chunkEncryptionKey);
  assert.deepEqual(restored.dedupeKey, keyset.dedupeKey);
});

test('recovery key envelope fails closed for wrong passphrase, changed AAD, and ciphertext tampering', () => {
  const envelope = createRecoveryKeyEnvelope({ keyset: generateRecoveryKeyset(), passphrase, aad });
  assert.throws(() => openRecoveryKeyEnvelope({ envelope, passphrase: 'wrong passphrase 2026', aad }), /RECOVERY_ENVELOPE_DECRYPT_FAILED/);
  assert.throws(() => openRecoveryKeyEnvelope({ envelope, passphrase, aad: 'wrong-owner' }), /RECOVERY_ENVELOPE_AAD_MISMATCH/);
  assert.deepEqual(openRecoveryKeyEnvelope({ envelope, passphrase }), openRecoveryKeyEnvelope({ envelope, passphrase, aad }));
  const tamperedCiphertext = `${envelope.ciphertextB64u.startsWith('A') ? 'B' : 'A'}${envelope.ciphertextB64u.slice(1)}`;
  assert.throws(
    () => openRecoveryKeyEnvelope({
      envelope: { ...envelope, ciphertextB64u: tamperedCiphertext }, passphrase, aad,
    }),
    /RECOVERY_ENVELOPE_HASH_MISMATCH/,
  );
});

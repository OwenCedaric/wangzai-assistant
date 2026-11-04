import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { canonicalJson } from './recoveryChunkCodec.js';

const ENVELOPE_FORMAT = 'wangzai-recovery-key-envelope';
const ENVELOPE_VERSION = 1;
const KDF_PARAMS = Object.freeze({ N: 16_384, r: 8, p: 1, keylen: 32 });

function fail(code) {
  throw new Error(code);
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value, code) {
  const text = String(value || '').trim();
  if (!text) fail(code);
  return Buffer.from(text, 'base64url');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePassphrase(value) {
  const passphrase = String(value || '');
  if (passphrase.length < 12) fail('RECOVERY_PASSPHRASE_TOO_SHORT');
  return passphrase;
}

function normalizeAad(value) {
  const aad = String(value || '');
  if (aad.length > 256 || /[\u0000-\u001f]/u.test(aad)) fail('RECOVERY_ENVELOPE_AAD_INVALID');
  return aad;
}

function deriveWrappingKey(passphrase, salt, params = KDF_PARAMS) {
  return scryptSync(normalizePassphrase(passphrase), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function assertKey(value, code) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (key.length !== 32) fail(code);
  return key;
}

function keysetPayload(keyset) {
  return {
    format: 'wangzai-recovery-keyset',
    version: 1,
    chunkEncryptionKeyB64u: toBase64Url(assertKey(keyset.chunkEncryptionKey, 'RECOVERY_CHUNK_KEY_INVALID')),
    dedupeKeyB64u: toBase64Url(assertKey(keyset.dedupeKey, 'RECOVERY_DEDUPE_KEY_INVALID')),
  };
}

export function generateRecoveryKeyset(randomBytesImpl = randomBytes) {
  return {
    chunkEncryptionKey: randomBytesImpl(32),
    dedupeKey: randomBytesImpl(32),
  };
}

/**
 * A passphrase-wrapped portable key envelope. The server may store this object but never sees
 * the keyset. The supplied AAD should contain only stable opaque account/shop identifiers.
 */
export function createRecoveryKeyEnvelope({ keyset, passphrase, aad = '', randomBytesImpl = randomBytes } = {}) {
  const normalizedAad = normalizeAad(aad);
  const salt = randomBytesImpl(16);
  const nonce = randomBytesImpl(12);
  const plain = Buffer.from(canonicalJson(keysetPayload(keyset)), 'utf8');
  const wrappingKey = deriveWrappingKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
  cipher.setAAD(Buffer.from(normalizedAad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const cipherHash = sha256(Buffer.concat([nonce, tag, ciphertext]));
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: { name: 'scrypt', ...KDF_PARAMS },
    keyEnvelopeId: sha256(Buffer.concat([salt, nonce, tag, ciphertext])).slice(0, 48),
    aad: normalizedAad,
    saltB64u: toBase64Url(salt),
    nonceB64u: toBase64Url(nonce),
    tagB64u: toBase64Url(tag),
    ciphertextB64u: toBase64Url(ciphertext),
    cipherSha256: cipherHash,
  };
}

function verifyEnvelopeHash(envelope) {
  const received = Buffer.from(String(envelope?.cipherSha256 || ''), 'hex');
  const actual = Buffer.from(sha256(Buffer.concat([
    fromBase64Url(envelope?.nonceB64u, 'RECOVERY_ENVELOPE_NONCE_REQUIRED'),
    fromBase64Url(envelope?.tagB64u, 'RECOVERY_ENVELOPE_TAG_REQUIRED'),
    fromBase64Url(envelope?.ciphertextB64u, 'RECOVERY_ENVELOPE_CIPHERTEXT_REQUIRED'),
  ])), 'hex');
  if (received.length !== actual.length || !timingSafeEqual(received, actual)) fail('RECOVERY_ENVELOPE_HASH_MISMATCH');
}

export function openRecoveryKeyEnvelope({ envelope, passphrase, aad } = {}) {
  if (envelope?.format !== ENVELOPE_FORMAT || envelope?.version !== ENVELOPE_VERSION || envelope?.kdf?.name !== 'scrypt') {
    fail('RECOVERY_ENVELOPE_UNSUPPORTED');
  }
  const envelopeAad = normalizeAad(envelope.aad);
  const normalizedAad = aad === undefined ? envelopeAad : normalizeAad(aad);
  if (normalizedAad !== envelopeAad) fail('RECOVERY_ENVELOPE_AAD_MISMATCH');
  const params = envelope.kdf;
  if (params.N !== KDF_PARAMS.N || params.r !== KDF_PARAMS.r || params.p !== KDF_PARAMS.p || params.keylen !== KDF_PARAMS.keylen) {
    fail('RECOVERY_ENVELOPE_KDF_UNSUPPORTED');
  }
  verifyEnvelopeHash(envelope);
  const salt = fromBase64Url(envelope.saltB64u, 'RECOVERY_ENVELOPE_SALT_REQUIRED');
  const nonce = fromBase64Url(envelope.nonceB64u, 'RECOVERY_ENVELOPE_NONCE_REQUIRED');
  const tag = fromBase64Url(envelope.tagB64u, 'RECOVERY_ENVELOPE_TAG_REQUIRED');
  const ciphertext = fromBase64Url(envelope.ciphertextB64u, 'RECOVERY_ENVELOPE_CIPHERTEXT_REQUIRED');
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveWrappingKey(passphrase, salt, params), nonce);
    decipher.setAAD(Buffer.from(normalizedAad, 'utf8'));
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    if (payload?.format !== 'wangzai-recovery-keyset' || payload?.version !== 1) fail('RECOVERY_KEYSET_INVALID');
    return {
      chunkEncryptionKey: assertKey(fromBase64Url(payload.chunkEncryptionKeyB64u, 'RECOVERY_CHUNK_KEY_INVALID'), 'RECOVERY_CHUNK_KEY_INVALID'),
      dedupeKey: assertKey(fromBase64Url(payload.dedupeKeyB64u, 'RECOVERY_DEDUPE_KEY_INVALID'), 'RECOVERY_DEDUPE_KEY_INVALID'),
    };
  } catch (error) {
    if (String(error?.message || '').startsWith('RECOVERY_')) throw error;
    fail('RECOVERY_ENVELOPE_DECRYPT_FAILED');
  }
}

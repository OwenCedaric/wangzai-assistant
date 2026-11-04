import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const CHUNK_FORMAT = 'wangzai-recovery-chunk';
const CHUNK_VERSION = 1;

function fail(code) {
  throw new Error(code);
}

function normalizeCanonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('RECOVERY_CANONICAL_INVALID_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeCanonical(value[key])]),
    );
  }
  fail('RECOVERY_CANONICAL_UNSUPPORTED_VALUE');
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonical(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertKeyMaterial(value, code) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (buffer.length !== 32) fail(code);
  return buffer;
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value, code) {
  const text = String(value || '').trim();
  if (!text) fail(code);
  return Buffer.from(text, 'base64url');
}

function recordLine(record) {
  const key = String(record?.key || '').trim();
  if (!key) fail('RECOVERY_RECORD_KEY_REQUIRED');
  if (!record || !Object.hasOwn(record, 'value')) fail('RECOVERY_RECORD_VALUE_REQUIRED');
  return canonicalJson({ kind: 'record', key, value: record.value });
}

function recordsRoot(recordLines) {
  return sha256(recordLines.map((line) => sha256(line)).join(''));
}

function compareCanonicalRecordKeys(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Builds deterministic canonical JSONL before any compression/encryption. */
export function buildRecoveryChunk({
  domain,
  domainSchemaVersion = 1,
  partitionKey,
  records = [],
} = {}) {
  const normalizedDomain = String(domain || '').trim();
  const normalizedPartition = String(partitionKey || '').trim();
  if (!normalizedDomain) fail('RECOVERY_DOMAIN_REQUIRED');
  if (!normalizedPartition) fail('RECOVERY_PARTITION_REQUIRED');
  if (!Array.isArray(records)) fail('RECOVERY_RECORDS_REQUIRED');

  const sortedRecords = records
    .map((record) => ({ key: String(record?.key || '').trim(), value: record?.value }))
    .sort((left, right) => compareCanonicalRecordKeys(left.key, right.key));
  if (sortedRecords.some((record) => !record.key)) fail('RECOVERY_RECORD_KEY_REQUIRED');
  if (sortedRecords.some((record, index) => index > 0 && record.key === sortedRecords[index - 1].key)) {
    fail('RECOVERY_RECORD_KEY_DUPLICATE');
  }
  const lines = sortedRecords.map(recordLine);
  const root = recordsRoot(lines);
  const header = canonicalJson({
    kind: 'header',
    format: CHUNK_FORMAT,
    version: CHUNK_VERSION,
    domain: normalizedDomain,
    domainSchemaVersion: Number(domainSchemaVersion) || 1,
    partitionKey: normalizedPartition,
    recordCount: lines.length,
  });
  const footer = canonicalJson({ kind: 'footer', recordCount: lines.length, recordsRootHash: `sha256:${root}` });
  const plaintext = Buffer.from([header, ...lines, footer].join('\n') + '\n', 'utf8');
  return {
    format: CHUNK_FORMAT,
    version: CHUNK_VERSION,
    domain: normalizedDomain,
    partitionKey: normalizedPartition,
    recordCount: lines.length,
    recordsRootHash: `sha256:${root}`,
    plainCanonicalSha256: sha256(plaintext),
    plaintext,
    compressed: zstdCompressSync(plaintext),
  };
}

export function deriveRecoveryChunkId({ dedupeKey, plainCanonicalSha256 }) {
  const key = assertKeyMaterial(dedupeKey, 'RECOVERY_DEDUPE_KEY_INVALID');
  const hash = String(plainCanonicalSha256 || '').trim();
  if (!/^[a-f0-9]{64}$/u.test(hash)) fail('RECOVERY_PLAIN_HASH_INVALID');
  return createHmac('sha256', key).update(hash).digest('base64url');
}

function deterministicNonce(encryptionKey, plainCanonicalSha256) {
  return createHmac('sha256', encryptionKey).update(`nonce:${plainCanonicalSha256}`).digest().subarray(0, 12);
}

/**
 * Encrypts a compressed deterministic chunk. The nonce is derived from the keyed plaintext
 * hash, so identical chunks for the same owner/key have identical ciphertext and can dedupe.
 */
export function encryptRecoveryChunk({ chunk, encryptionKey, dedupeKey, aad = '' } = {}) {
  if (!chunk?.compressed || !chunk?.plainCanonicalSha256) fail('RECOVERY_CHUNK_REQUIRED');
  const key = assertKeyMaterial(encryptionKey, 'RECOVERY_ENCRYPTION_KEY_INVALID');
  const nonce = deterministicNonce(key, chunk.plainCanonicalSha256);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(chunk.compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    objectFormatVersion: 1,
    algorithm: 'AES-256-GCM',
    chunkId: deriveRecoveryChunkId({ dedupeKey, plainCanonicalSha256: chunk.plainCanonicalSha256 }),
    plainCanonicalSha256: chunk.plainCanonicalSha256,
    compressedBytes: chunk.compressed.length,
    cipherBytes: ciphertext.length + nonce.length + tag.length,
    cipherSha256: sha256(Buffer.concat([nonce, tag, ciphertext])),
    nonceB64u: toBase64Url(nonce),
    tagB64u: toBase64Url(tag),
    ciphertextB64u: toBase64Url(ciphertext),
  };
}

function verifyCipherHash(encrypted) {
  const received = Buffer.from(String(encrypted?.cipherSha256 || ''), 'hex');
  const actual = Buffer.from(sha256(Buffer.concat([
    fromBase64Url(encrypted?.nonceB64u, 'RECOVERY_NONCE_REQUIRED'),
    fromBase64Url(encrypted?.tagB64u, 'RECOVERY_TAG_REQUIRED'),
    fromBase64Url(encrypted?.ciphertextB64u, 'RECOVERY_CIPHERTEXT_REQUIRED'),
  ])), 'hex');
  if (received.length !== actual.length || !timingSafeEqual(received, actual)) fail('RECOVERY_CIPHER_HASH_MISMATCH');
}

export function parseAndValidateRecoveryChunk(plaintext) {
  const text = Buffer.from(plaintext).toString('utf8');
  if (!text.endsWith('\n')) fail('RECOVERY_CHUNK_NEWLINE_REQUIRED');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2) fail('RECOVERY_CHUNK_TOO_SHORT');
  const header = JSON.parse(lines[0]);
  const footer = JSON.parse(lines.at(-1));
  if (header?.kind !== 'header' || header.format !== CHUNK_FORMAT || header.version !== CHUNK_VERSION) {
    fail('RECOVERY_CHUNK_HEADER_INVALID');
  }
  if (footer?.kind !== 'footer') fail('RECOVERY_CHUNK_FOOTER_INVALID');
  const recordLines = lines.slice(1, -1);
  const records = recordLines.map((line) => {
    const record = JSON.parse(line);
    if (record?.kind !== 'record' || !String(record.key || '').trim() || !Object.hasOwn(record, 'value')) {
      fail('RECOVERY_CHUNK_RECORD_INVALID');
    }
    if (canonicalJson(record) !== line) fail('RECOVERY_CHUNK_NOT_CANONICAL');
    return record;
  });
  const keys = records.map((record) => record.key);
  if (keys.some((key, index) => index > 0 && key <= keys[index - 1])) fail('RECOVERY_CHUNK_RECORD_ORDER_INVALID');
  const root = `sha256:${recordsRoot(recordLines)}`;
  if (header.recordCount !== records.length || footer.recordCount !== records.length || footer.recordsRootHash !== root) {
    fail('RECOVERY_CHUNK_INTEGRITY_MISMATCH');
  }
  return { header, records, footer, recordsRootHash: root };
}

export function decryptRecoveryChunk({ encrypted, encryptionKey, aad = '' } = {}) {
  if (encrypted?.algorithm !== 'AES-256-GCM') fail('RECOVERY_CIPHER_ALGORITHM_UNSUPPORTED');
  verifyCipherHash(encrypted);
  const key = assertKeyMaterial(encryptionKey, 'RECOVERY_ENCRYPTION_KEY_INVALID');
  const nonce = fromBase64Url(encrypted.nonceB64u, 'RECOVERY_NONCE_REQUIRED');
  const tag = fromBase64Url(encrypted.tagB64u, 'RECOVERY_TAG_REQUIRED');
  const ciphertext = fromBase64Url(encrypted.ciphertextB64u, 'RECOVERY_CIPHERTEXT_REQUIRED');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const plaintext = zstdDecompressSync(compressed);
  const parsed = parseAndValidateRecoveryChunk(plaintext);
  const plainCanonicalSha256 = sha256(plaintext);
  if (encrypted.plainCanonicalSha256 && encrypted.plainCanonicalSha256 !== plainCanonicalSha256) {
    fail('RECOVERY_PLAIN_HASH_MISMATCH');
  }
  return { ...parsed, plaintext, plainCanonicalSha256 };
}

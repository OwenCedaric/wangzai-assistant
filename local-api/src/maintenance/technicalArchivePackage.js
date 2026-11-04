import {
  buildRecoveryChunk,
  canonicalJson,
  decryptRecoveryChunk,
  deriveRecoveryChunkId,
  encryptRecoveryChunk,
} from '../backup/recoveryChunkCodec.js';

export const TECHNICAL_ARCHIVE_FORMAT = 'wangzai-technical-archive';
export const TECHNICAL_ARCHIVE_VERSION = 1;

function fail(code) {
  throw new Error(code);
}

function normalizeIso(value, code) {
  const text = String(value || '').trim();
  const date = new Date(text);
  if (!text || !Number.isFinite(date.getTime()) || date.toISOString() !== text) fail(code);
  return text;
}

function normalizeArchiveType(value) {
  const text = String(value || '').trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(text)) fail('TECHNICAL_ARCHIVE_TYPE_INVALID');
  return text;
}

function normalizeRecordCount(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail('TECHNICAL_ARCHIVE_RECORD_COUNT_INVALID');
  return number;
}

function packageMetadata({ archiveType, archiveId, sourceFrom, sourceTo, recordCount, expiresAt }) {
  const normalized = {
    format: TECHNICAL_ARCHIVE_FORMAT,
    version: TECHNICAL_ARCHIVE_VERSION,
    archiveType: normalizeArchiveType(archiveType),
    archiveId: String(archiveId || '').trim(),
    sourceFrom: normalizeIso(sourceFrom, 'TECHNICAL_ARCHIVE_SOURCE_FROM_INVALID'),
    sourceTo: normalizeIso(sourceTo, 'TECHNICAL_ARCHIVE_SOURCE_TO_INVALID'),
    recordCount: normalizeRecordCount(recordCount),
    expiresAt: normalizeIso(expiresAt, 'TECHNICAL_ARCHIVE_EXPIRES_AT_INVALID'),
  };
  if (!/^[A-Za-z0-9_-]{43}$/u.test(normalized.archiveId)) fail('TECHNICAL_ARCHIVE_ID_INVALID');
  if (normalized.sourceFrom > normalized.sourceTo) fail('TECHNICAL_ARCHIVE_SOURCE_RANGE_INVALID');
  if (normalized.expiresAt < normalized.sourceTo) fail('TECHNICAL_ARCHIVE_EXPIRY_INVALID');
  return normalized;
}

function archiveAad(metadata) {
  return `wangzai-technical-archive:v1:${canonicalJson(metadata)}`;
}

export function buildTechnicalArchivePackage({
  archiveType,
  sourceFrom,
  sourceTo,
  expiresAt,
  records,
  encryptionKey,
  dedupeKey,
} = {}) {
  const normalizedType = normalizeArchiveType(archiveType);
  const normalizedFrom = normalizeIso(sourceFrom, 'TECHNICAL_ARCHIVE_SOURCE_FROM_INVALID');
  const normalizedTo = normalizeIso(sourceTo, 'TECHNICAL_ARCHIVE_SOURCE_TO_INVALID');
  const normalizedExpiry = normalizeIso(expiresAt, 'TECHNICAL_ARCHIVE_EXPIRES_AT_INVALID');
  if (!Array.isArray(records) || !records.length) fail('TECHNICAL_ARCHIVE_RECORDS_REQUIRED');

  const chunk = buildRecoveryChunk({
    domain: `technical-archive/${normalizedType}`,
    domainSchemaVersion: 1,
    partitionKey: `time:${normalizedFrom}/${normalizedTo}`,
    records,
  });
  const archiveId = deriveRecoveryChunkId({
    dedupeKey,
    plainCanonicalSha256: chunk.plainCanonicalSha256,
  });
  const metadata = packageMetadata({
    archiveType: normalizedType,
    archiveId,
    sourceFrom: normalizedFrom,
    sourceTo: normalizedTo,
    recordCount: chunk.recordCount,
    expiresAt: normalizedExpiry,
  });
  const encrypted = encryptRecoveryChunk({
    chunk,
    encryptionKey,
    dedupeKey,
    aad: archiveAad(metadata),
  });
  if (encrypted.chunkId !== archiveId) fail('TECHNICAL_ARCHIVE_CHUNK_ID_MISMATCH');
  return Object.freeze({ ...metadata, encrypted });
}

export function serializeTechnicalArchivePackage(archivePackage) {
  return Buffer.from(`${canonicalJson(archivePackage)}\n`, 'utf8');
}

export function parseTechnicalArchivePackage(bytes) {
  const text = Buffer.from(bytes || '').toString('utf8');
  if (!text.endsWith('\n')) fail('TECHNICAL_ARCHIVE_NEWLINE_REQUIRED');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    fail('TECHNICAL_ARCHIVE_JSON_INVALID');
  }
  if (canonicalJson(parsed) !== text.slice(0, -1)) fail('TECHNICAL_ARCHIVE_NOT_CANONICAL');
  if (parsed?.format !== TECHNICAL_ARCHIVE_FORMAT || parsed?.version !== TECHNICAL_ARCHIVE_VERSION) {
    fail('TECHNICAL_ARCHIVE_HEADER_INVALID');
  }
  const expectedFields = [
    'archiveId',
    'archiveType',
    'encrypted',
    'expiresAt',
    'format',
    'recordCount',
    'sourceFrom',
    'sourceTo',
    'version',
  ];
  if (
    !parsed
    || typeof parsed !== 'object'
    || Object.keys(parsed).sort().join('\0') !== expectedFields.sort().join('\0')
  ) {
    fail('TECHNICAL_ARCHIVE_FIELDS_INVALID');
  }
  const metadata = packageMetadata(parsed);
  if (!parsed.encrypted || typeof parsed.encrypted !== 'object') fail('TECHNICAL_ARCHIVE_CIPHER_REQUIRED');
  return { ...metadata, encrypted: parsed.encrypted };
}

export function decryptTechnicalArchivePackage({ bytes, archivePackage, encryptionKey } = {}) {
  const parsed = archivePackage || parseTechnicalArchivePackage(bytes);
  const metadata = packageMetadata(parsed);
  if (parsed.encrypted?.chunkId !== metadata.archiveId) fail('TECHNICAL_ARCHIVE_CHUNK_ID_MISMATCH');
  const restored = decryptRecoveryChunk({
    encrypted: parsed.encrypted,
    encryptionKey,
    aad: archiveAad(metadata),
  });
  if (restored.header.domain !== `technical-archive/${metadata.archiveType}`) {
    fail('TECHNICAL_ARCHIVE_DOMAIN_MISMATCH');
  }
  if (restored.records.length !== metadata.recordCount) fail('TECHNICAL_ARCHIVE_RECORD_COUNT_MISMATCH');
  return { metadata, records: restored.records, plainCanonicalSha256: restored.plainCanonicalSha256 };
}

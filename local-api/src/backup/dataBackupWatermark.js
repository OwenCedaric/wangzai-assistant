import { createHash } from 'node:crypto';
import { canonicalJson } from './recoveryChunkCodec.js';

export const DATA_BACKUP_WATERMARK_VERSION = 'wangzai-data-backup-watermark-v1';
export const DATA_BACKUP_OWNER_WATERMARK_VERSION = 'wangzai-data-backup-owner-watermark-v2';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value, code) {
  const text = String(value || '').trim();
  if (!text) fail(code);
  return text;
}

function normalizeInteger(value, code, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) fail(code);
  return number;
}

function normalizeHash(value, code) {
  const hash = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/u.test(hash)) fail(code);
  return hash;
}

function normalizeRecordsRootHash(value) {
  const hash = String(value || '').trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) {
    fail('DATA_BACKUP_WATERMARK_RECORDS_ROOT_INVALID');
  }
  return hash;
}

export function normalizeDataBackupWatermarkDomains(domains = []) {
  if (!Array.isArray(domains)) fail('DATA_BACKUP_WATERMARK_DOMAINS_INVALID');
  const seen = new Set();
  return domains.map((domain) => {
    const normalized = {
      domain: normalizeText(domain?.domain, 'DATA_BACKUP_WATERMARK_DOMAIN_INVALID'),
      schemaVersion: normalizeInteger(
        domain?.schemaVersion,
        'DATA_BACKUP_WATERMARK_SCHEMA_VERSION_INVALID',
        { minimum: 1 },
      ),
      recordCount: normalizeInteger(domain?.recordCount, 'DATA_BACKUP_WATERMARK_RECORD_COUNT_INVALID'),
      recordsRootHash: normalizeRecordsRootHash(domain?.recordsRootHash),
    };
    if (seen.has(normalized.domain)) fail('DATA_BACKUP_WATERMARK_DOMAIN_DUPLICATE');
    seen.add(normalized.domain);
    return normalized;
  }).sort((left, right) => left.domain.localeCompare(right.domain));
}

export function createDataBackupWatermark({
  owner,
  ownerIncarnation,
  shopId,
  shopIncarnation,
  sqliteUserVersion,
  domains,
} = {}) {
  if (owner !== undefined) {
    const shape = {
      version: DATA_BACKUP_OWNER_WATERMARK_VERSION,
      owner: {
        ownerType: normalizeText(owner?.ownerType, 'DATA_BACKUP_WATERMARK_OWNER_TYPE_REQUIRED'),
        ownerId: normalizeText(owner?.ownerId, 'DATA_BACKUP_WATERMARK_OWNER_ID_REQUIRED'),
        ownerIncarnation: normalizeText(
          ownerIncarnation,
          'DATA_BACKUP_WATERMARK_OWNER_INCARNATION_REQUIRED',
        ),
      },
      sqliteUserVersion: normalizeInteger(
        sqliteUserVersion,
        'DATA_BACKUP_WATERMARK_SQLITE_VERSION_INVALID',
      ),
      domains: normalizeDataBackupWatermarkDomains(domains),
    };
    return Object.freeze({
      ...shape,
      owner: Object.freeze(shape.owner),
      dataFingerprint: sha256(canonicalJson(shape)),
    });
  }
  const shape = {
    version: DATA_BACKUP_WATERMARK_VERSION,
    shopId: normalizeText(shopId, 'DATA_BACKUP_WATERMARK_SHOP_ID_REQUIRED'),
    shopIncarnation: normalizeText(
      shopIncarnation,
      'DATA_BACKUP_WATERMARK_SHOP_INCARNATION_REQUIRED',
    ),
    sqliteUserVersion: normalizeInteger(
      sqliteUserVersion,
      'DATA_BACKUP_WATERMARK_SQLITE_VERSION_INVALID',
    ),
    domains: normalizeDataBackupWatermarkDomains(domains),
  };
  return Object.freeze({
    ...shape,
    dataFingerprint: sha256(canonicalJson(shape)),
  });
}

export function validateDataBackupWatermark(watermark, {
  owner,
  shopId,
  domains,
} = {}) {
  if (!watermark || typeof watermark !== 'object' || Array.isArray(watermark)) {
    fail('DATA_BACKUP_WATERMARK_INVALID');
  }
  if (![DATA_BACKUP_WATERMARK_VERSION, DATA_BACKUP_OWNER_WATERMARK_VERSION].includes(watermark.version)) {
    fail('DATA_BACKUP_WATERMARK_VERSION_UNSUPPORTED');
  }
  const canonical = watermark.version === DATA_BACKUP_OWNER_WATERMARK_VERSION
    ? createDataBackupWatermark({
        owner: watermark.owner,
        ownerIncarnation: watermark.owner?.ownerIncarnation,
        sqliteUserVersion: watermark.sqliteUserVersion,
        domains: watermark.domains,
      })
    : createDataBackupWatermark({
        shopId: watermark.shopId,
        shopIncarnation: watermark.shopIncarnation,
        sqliteUserVersion: watermark.sqliteUserVersion,
        domains: watermark.domains,
      });
  if (normalizeHash(watermark.dataFingerprint, 'DATA_BACKUP_WATERMARK_FINGERPRINT_INVALID')
    !== canonical.dataFingerprint) {
    fail('DATA_BACKUP_WATERMARK_FINGERPRINT_MISMATCH');
  }
  if (owner !== undefined && (
    canonical.version !== DATA_BACKUP_OWNER_WATERMARK_VERSION
    || String(owner?.ownerType || '').trim() !== canonical.owner.ownerType
    || String(owner?.ownerId || '').trim() !== canonical.owner.ownerId
  )) {
    fail('DATA_BACKUP_WATERMARK_OWNER_MISMATCH');
  }
  if (shopId !== undefined && (
    canonical.version !== DATA_BACKUP_WATERMARK_VERSION
    || String(shopId || '').trim() !== canonical.shopId
  )) {
    fail('DATA_BACKUP_WATERMARK_SHOP_MISMATCH');
  }
  if (domains !== undefined) {
    const expectedDomains = normalizeDataBackupWatermarkDomains(domains);
    if (canonicalJson(expectedDomains) !== canonicalJson(canonical.domains)) {
      fail('DATA_BACKUP_WATERMARK_DOMAINS_MISMATCH');
    }
  }
  return canonical;
}

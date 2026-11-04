import { createHash } from 'node:crypto';
import { getDataDomain } from '../data/dataDomainRegistry.js';
import {
  canonicalJson,
  decryptRecoveryChunk,
} from './recoveryChunkCodec.js';
import { createRecoveryGeneration, openRecoveryGeneration } from './recoveryGeneration.js';
import { openRecoveryKeyEnvelope } from './recoveryKeyEnvelope.js';
import { assertOwnerScopedRecoveryProfileCandidate } from './recoveryProfileCore.js';
import { assertRequiredDataBackupShopDomainCoverage } from './recoveryExporter.js';
import {
  DATA_BACKUP_WATERMARK_VERSION,
  validateDataBackupWatermark,
} from './dataBackupWatermark.js';

export const DATA_BACKUP_PACKAGE_FORMAT = 'wangzai-user-data-backup';
export const DATA_BACKUP_PACKAGE_VERSION = 1;
const SELF_CONTAINED_UNLOCK_MODE = 'self-contained-local';

function fail(code) {
  throw new Error(code);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value, code) {
  const text = String(value || '').trim();
  if (!text) fail(code);
  return text;
}

function normalizeSelfContainedUnlockSecret(value) {
  const secret = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) fail('DATA_BACKUP_UNLOCK_SECRET_INVALID');
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== secret) {
    fail('DATA_BACKUP_UNLOCK_SECRET_INVALID');
  }
  return secret;
}

function packageUnlock(passphrase) {
  return {
    mode: SELF_CONTAINED_UNLOCK_MODE,
    secretB64u: normalizeSelfContainedUnlockSecret(passphrase),
  };
}

function packagePassphrase(payload, passphrase) {
  if (payload?.unlock !== undefined) {
    if (payload.unlock?.mode !== SELF_CONTAINED_UNLOCK_MODE) {
      fail('DATA_BACKUP_UNLOCK_MODE_UNSUPPORTED');
    }
    return normalizeSelfContainedUnlockSecret(payload.unlock.secretB64u);
  }
  const legacyPassphrase = String(passphrase || '');
  if (legacyPassphrase.length < 12) fail('DATA_BACKUP_LEGACY_PASSPHRASE_REQUIRED');
  return legacyPassphrase;
}

function assertUserDataShopCandidate(candidate, encryptionKey, aad) {
  if (
    !candidate?.ok
    || candidate.format !== 'wangzai-recovery-export-candidate'
    || candidate.mode !== 'core-only'
    || !Array.isArray(candidate.domains)
    || !Array.isArray(candidate.chunks)
  ) fail('DATA_BACKUP_SHOP_CANDIDATE_INVALID');
  const chunks = new Map(candidate.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const domains = [];
  for (const manifest of candidate.domains) {
    const policy = getDataDomain(manifest.domain);
    if (
      policy.scopeType !== 'shop'
      || policy.backup !== 'required'
      || policy.storageAdapter === 'secret-vault'
      || policy.recoveryChannel === 'profile-core'
      || manifest.disposition !== 'required'
    ) fail(`DATA_BACKUP_DOMAIN_NOT_ALLOWED:${policy.domain}`);
    const encrypted = chunks.get(manifest.chunkId);
    if (!encrypted) fail(`DATA_BACKUP_CHUNK_MISSING:${policy.domain}`);
    const decoded = decryptRecoveryChunk({ encrypted, encryptionKey, aad });
    const schemaVersion = Number(manifest.schemaVersion ?? decoded.header.domainSchemaVersion);
    if (
      decoded.header.domain !== policy.domain
      || schemaVersion !== Number(decoded.header.domainSchemaVersion)
      || decoded.recordsRootHash !== manifest.recordsRootHash
      || decoded.records.length !== Number(manifest.recordCount)
    ) fail(`DATA_BACKUP_DOMAIN_INTEGRITY_MISMATCH:${policy.domain}`);
    domains.push({
      domain: policy.domain,
      schemaVersion,
      recordCount: decoded.records.length,
      recordsRootHash: decoded.recordsRootHash,
    });
  }
  if (chunks.size !== domains.length) fail('DATA_BACKUP_OBJECT_SET_MISMATCH');
  const shopId = normalizeText(candidate.shopId, 'DATA_BACKUP_SHOP_ID_REQUIRED');
  return { shopId, domains, dataWatermark: candidate.dataWatermark || null };
}

function combinedUserDataDomains(shopDomains, profileDomains) {
  const combined = [
    ...shopDomains,
    ...profileDomains.filter((domain) => Number(domain.recordCount) > 0),
  ].sort((left, right) => left.domain.localeCompare(right.domain));
  const names = combined.map((domain) => domain.domain);
  if (new Set(names).size !== names.length) fail('DATA_BACKUP_DOMAIN_DUPLICATE');
  return combined;
}

function assertUserDataProfileCandidate(candidate, encryptionKey, aad, owner) {
  const verified = assertOwnerScopedRecoveryProfileCandidate({
    candidate,
    owner,
    encryptionKey,
    aad,
  });
  return verified;
}

function emptyOwnerShopCandidate(owner) {
  return {
    ok: true,
    format: 'wangzai-recovery-export-candidate',
    version: 1,
    mode: 'core-only',
    ownerScope: { ...owner },
    domains: [],
    chunks: [],
  };
}

function assertEmptyOwnerShopCandidate(candidate, owner) {
  if (
    !candidate?.ok
    || candidate.format !== 'wangzai-recovery-export-candidate'
    || candidate.mode !== 'core-only'
    || candidate.ownerScope?.ownerType !== owner.ownerType
    || candidate.ownerScope?.ownerId !== owner.ownerId
    || !Array.isArray(candidate.domains)
    || candidate.domains.length !== 0
    || !Array.isArray(candidate.chunks)
    || candidate.chunks.length !== 0
  ) fail('DATA_BACKUP_OWNER_SHOP_CANDIDATE_INVALID');
  return { domains: [], dataWatermark: candidate.dataWatermark || null };
}

function validateOwnerWatermark(dataWatermark, owner, domains) {
  if (dataWatermark?.version === DATA_BACKUP_WATERMARK_VERSION) {
    if (owner.ownerType !== 'ozon_shop') fail('DATA_BACKUP_WATERMARK_OWNER_MISMATCH');
    return validateDataBackupWatermark(dataWatermark, { shopId: owner.ownerId, domains });
  }
  return validateDataBackupWatermark(dataWatermark, { owner, domains });
}

export function createDataBackupPackage({
  owner,
  profileCandidate,
  shopCandidate,
  keyEnvelope,
  encryptionKey,
  dedupeKey,
  aad,
  backupId,
  createdAt,
  dataWatermark,
  quotaBytes = null,
  selfContainedUnlockSecret,
} = {}) {
  const id = normalizeText(backupId, 'DATA_BACKUP_ID_REQUIRED');
  const timestamp = normalizeText(createdAt, 'DATA_BACKUP_CREATED_AT_REQUIRED');
  if (Number.isNaN(Date.parse(timestamp))) fail('DATA_BACKUP_CREATED_AT_INVALID');
  const verifiedProfile = assertUserDataProfileCandidate(
    profileCandidate,
    encryptionKey,
    aad,
    owner,
  );
  const scopedOwner = verifiedProfile.owner;
  let resolvedShopCandidate = shopCandidate;
  let verifiedShop;
  if (scopedOwner.ownerType === 'ozon_shop') {
    assertRequiredDataBackupShopDomainCoverage();
    verifiedShop = assertUserDataShopCandidate(resolvedShopCandidate, encryptionKey, aad);
    if (verifiedShop.shopId !== scopedOwner.ownerId) fail('DATA_BACKUP_PROFILE_OWNER_MISMATCH');
  } else {
    resolvedShopCandidate ||= emptyOwnerShopCandidate(scopedOwner);
    verifiedShop = assertEmptyOwnerShopCandidate(resolvedShopCandidate, scopedOwner);
  }
  const domains = combinedUserDataDomains(verifiedShop.domains, verifiedProfile.domains);
  const verifiedWatermark = validateOwnerWatermark(dataWatermark, scopedOwner, domains);
  const transport = createRecoveryGeneration({
    profileCandidate,
    shopCandidate: {
      ...resolvedShopCandidate,
      dataWatermark: verifiedWatermark,
    },
    keyEnvelope,
    encryptionKey,
    dedupeKey,
    aad,
    generationId: id,
    createdAt: timestamp,
    quotaBytes,
  });
  const payload = {
    format: DATA_BACKUP_PACKAGE_FORMAT,
    version: DATA_BACKUP_PACKAGE_VERSION,
    backupId: id,
    createdAt: timestamp,
    ...(selfContainedUnlockSecret
      ? { unlock: packageUnlock(selfContainedUnlockSecret) }
      : {}),
    transport,
  };
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  return {
    payload,
    bytes,
    packageSha256: sha256(bytes),
    packageBytes: bytes.byteLength,
  };
}

export function openDataBackupPackage({ bytes, passphrase } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  let payload;
  try {
    payload = JSON.parse(buffer.toString('utf8'));
  } catch {
    fail('DATA_BACKUP_PACKAGE_JSON_INVALID');
  }
  if (
    payload?.format !== DATA_BACKUP_PACKAGE_FORMAT
    || payload.version !== DATA_BACKUP_PACKAGE_VERSION
    || canonicalJson(payload) !== buffer.toString('utf8')
  ) fail('DATA_BACKUP_PACKAGE_UNSUPPORTED');
  const envelope = payload.transport?.keyEnvelope;
  const encryptionKeyset = openRecoveryKeyEnvelope({
    envelope,
    passphrase: packagePassphrase(payload, passphrase),
    aad: envelope?.aad,
  });
  const opened = openRecoveryGeneration({
    transport: payload.transport,
    encryptionKey: encryptionKeyset.chunkEncryptionKey,
    aad: envelope.aad,
  });
  if (
    opened.generationId !== payload.backupId
    || opened.createdAt !== payload.createdAt
  ) fail('DATA_BACKUP_MANIFEST_INVALID');
  const verifiedProfile = assertUserDataProfileCandidate(
    opened.profileCandidate,
    encryptionKeyset.chunkEncryptionKey,
    envelope.aad,
  );
  const owner = verifiedProfile.owner;
  let verifiedShop;
  if (owner.ownerType === 'ozon_shop') {
    assertRequiredDataBackupShopDomainCoverage();
    verifiedShop = assertUserDataShopCandidate(
      opened.shopCandidate,
      encryptionKeyset.chunkEncryptionKey,
      envelope.aad,
    );
    if (verifiedShop.shopId !== owner.ownerId) fail('DATA_BACKUP_PROFILE_OWNER_MISMATCH');
  } else {
    verifiedShop = assertEmptyOwnerShopCandidate(opened.shopCandidate, owner);
  }
  const domains = combinedUserDataDomains(verifiedShop.domains, verifiedProfile.domains);
  const dataWatermark = verifiedShop.dataWatermark
    ? validateOwnerWatermark(verifiedShop.dataWatermark, owner, domains)
    : null;
  return {
    ok: true,
    backupId: payload.backupId,
    createdAt: payload.createdAt,
    packageVersion: payload.version,
    packageSha256: sha256(buffer),
    packageBytes: buffer.byteLength,
    passwordProtected: payload.unlock === undefined,
    unlockMode: payload.unlock?.mode || 'legacy-passphrase',
    owner,
    shopId: owner.ownerType === 'ozon_shop' ? verifiedShop.shopId : null,
    domains,
    dataWatermark,
    dataFingerprint: dataWatermark?.dataFingerprint || null,
    profileCandidate: opened.profileCandidate,
    shopCandidate: opened.shopCandidate,
    keyset: encryptionKeyset,
    aad: envelope.aad,
  };
}

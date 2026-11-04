import { buildRecoveryChunk, decryptRecoveryChunk, encryptRecoveryChunk } from "./recoveryChunkCodec.js";

export function assertEncryptedChunk(candidate, domain) {
  const manifest = candidate?.domains?.find((item) => item.domain === domain);
  const encrypted = candidate?.chunks?.find((item) => item.chunkId === manifest?.chunkId);
  if (!manifest || !encrypted) throw new Error(`RESTORE_PROFILE_CHUNK_MISSING:${domain}`);
  return { manifest, encrypted };
}

export function toChunkManifest(policy, chunk, encrypted) {
  return {
    domain: policy.domain,
    schemaVersion: Number(policy.schemaVersion ?? 1),
    recordCount: chunk.recordCount,
    recordsRootHash: chunk.recordsRootHash,
    chunkId: encrypted.chunkId,
    cipherBytes: encrypted.cipherBytes,
    cipherSha256: encrypted.cipherSha256,
  };
}

export function decryptProfileSecret(decryptSecret, value, domain, accountId, field) {
  if (!value) return null;
  let plain;
  try {
    plain = decryptSecret(value);
  } catch {
    throw new Error(`BACKUP_SECRET_DECRYPT_FAILED:${domain}:${accountId}:${field}`);
  }
  if (!plain) throw new Error(`BACKUP_SECRET_DECRYPT_FAILED:${domain}:${accountId}:${field}`);
  return plain;
}

export function decryptProfileJson(decryptSecret, value, domain, recordId, field) {
  const plain = decryptProfileSecret(decryptSecret, value, domain, recordId, field);
  try {
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  } catch {
    throw new Error(`BACKUP_ENCRYPTED_JSON_INVALID:${domain}:${recordId}:${field}`);
  }
}

export function buildEncryptedDomain({ policy, partitionKey, records, encryptionKey, dedupeKey, aad }) {
  const chunk = buildRecoveryChunk({
    domain: policy.domain,
    domainSchemaVersion: policy.schemaVersion,
    partitionKey,
    records,
  });
  const encrypted = encryptRecoveryChunk({ chunk, encryptionKey, dedupeKey, aad });
  return { encrypted, manifest: toChunkManifest(policy, chunk, encrypted) };
}

export function openProfileDomain(candidate, domain, encryptionKey, aad, { optional = false } = {}) {
  const manifest = candidate?.domains?.find((item) => item.domain === domain);
  if (!manifest && optional) return { records: [] };
  const { manifest: expected, encrypted } = assertEncryptedChunk(candidate, domain);
  const chunk = decryptRecoveryChunk({ encrypted, encryptionKey, aad });
  if (chunk.header.domain !== domain || chunk.recordsRootHash !== expected.recordsRootHash) {
    throw new Error('RESTORE_PROFILE_INTEGRITY_MISMATCH');
  }
  return chunk;
}

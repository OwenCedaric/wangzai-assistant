import { buildRecoveryChunk, decryptRecoveryChunk, encryptRecoveryChunk } from './recoveryChunkCodec.js';

const GENERATION_FORMAT = 'wangzai-recovery-generation';
const GENERATION_VERSION = 1;
const MANIFEST_DOMAIN = 'recovery-generation-manifest';
const MANIFEST_PARTITION = 'profile:current';

function fail(code) {
  throw new Error(code);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, code) {
  const text = String(value || '').trim();
  if (!text) fail(code);
  return text;
}

function assertIsoTimestamp(value) {
  const timestamp = normalizeText(value, 'RECOVERY_GENERATION_CREATED_AT_REQUIRED');
  if (Number.isNaN(Date.parse(timestamp))) fail('RECOVERY_GENERATION_CREATED_AT_INVALID');
  return timestamp;
}

function opaqueObject(encrypted) {
  const object = {
    objectFormatVersion: encrypted?.objectFormatVersion,
    algorithm: encrypted?.algorithm,
    chunkId: encrypted?.chunkId,
    cipherBytes: encrypted?.cipherBytes,
    cipherSha256: encrypted?.cipherSha256,
    nonceB64u: encrypted?.nonceB64u,
    tagB64u: encrypted?.tagB64u,
    ciphertextB64u: encrypted?.ciphertextB64u,
  };
  if (
    object.objectFormatVersion !== 1
    || object.algorithm !== 'AES-256-GCM'
    || !/^[A-Za-z0-9_-]{20,}$/u.test(String(object.chunkId || ''))
    || !Number.isSafeInteger(object.cipherBytes)
    || object.cipherBytes <= 28
    || !/^[a-f0-9]{64}$/u.test(String(object.cipherSha256 || ''))
    || !String(object.nonceB64u || '').trim()
    || !String(object.tagB64u || '').trim()
    || !String(object.ciphertextB64u || '').trim()
  ) {
    fail('RECOVERY_TRANSPORT_OBJECT_INVALID');
  }
  return object;
}

function objectMatches(left, right) {
  return left.chunkId === right.chunkId
    && left.cipherBytes === right.cipherBytes
    && left.cipherSha256 === right.cipherSha256
    && left.nonceB64u === right.nonceB64u
    && left.tagB64u === right.tagB64u
    && left.ciphertextB64u === right.ciphertextB64u;
}

function makeObjectMap(chunks) {
  if (!Array.isArray(chunks)) fail('RECOVERY_CANDIDATE_CHUNKS_INVALID');
  const map = new Map();
  for (const chunk of chunks) {
    const object = opaqueObject(chunk);
    const previous = map.get(object.chunkId);
    if (previous && !objectMatches(previous, object)) fail('RECOVERY_TRANSPORT_CHUNK_ID_COLLISION');
    map.set(object.chunkId, object);
  }
  return map;
}

function candidateManifest(candidate, expectedFormat) {
  if (!candidate?.ok || candidate.format !== expectedFormat || !Array.isArray(candidate.domains)) {
    fail('RECOVERY_GENERATION_CANDIDATE_INVALID');
  }
  const chunksById = makeObjectMap(candidate.chunks);
  const chunkIds = [];
  for (const domain of candidate.domains) {
    const chunkId = normalizeText(domain?.chunkId, 'RECOVERY_GENERATION_DOMAIN_CHUNK_MISSING');
    const object = chunksById.get(chunkId);
    if (!object || object.cipherBytes !== domain.cipherBytes || object.cipherSha256 !== domain.cipherSha256) {
      fail('RECOVERY_GENERATION_DOMAIN_OBJECT_MISMATCH');
    }
    chunkIds.push(chunkId);
  }
  if (new Set(chunkIds).size !== chunkIds.length || chunksById.size !== chunkIds.length) {
    fail('RECOVERY_GENERATION_CANDIDATE_REFERENCE_INVALID');
  }
  const { chunks, ...metadata } = candidate;
  return { metadata: cloneJson(metadata), chunksById, chunkIds };
}

function hydrateCandidate(metadata, objectsById) {
  const candidate = cloneJson(metadata);
  if (!Array.isArray(candidate.domains)) fail('RECOVERY_GENERATION_MANIFEST_CANDIDATE_INVALID');
  const chunks = candidate.domains.map((domain) => {
    const object = objectsById.get(domain?.chunkId);
    if (!object || object.cipherBytes !== domain.cipherBytes || object.cipherSha256 !== domain.cipherSha256) {
      fail('RECOVERY_GENERATION_OBJECT_REFERENCE_INVALID');
    }
    return cloneJson(object);
  });
  if (new Set(chunks.map((chunk) => chunk.chunkId)).size !== chunks.length) {
    fail('RECOVERY_GENERATION_MANIFEST_REFERENCE_DUPLICATE');
  }
  return { ...candidate, chunks };
}

function normalizedTransportObjects(objects) {
  if (!Array.isArray(objects) || !objects.length) fail('RECOVERY_TRANSPORT_OBJECTS_REQUIRED');
  const map = makeObjectMap(objects);
  if (map.size !== objects.length) fail('RECOVERY_TRANSPORT_OBJECT_ID_DUPLICATE');
  return map;
}

function assertManifestPointer(pointer, objectsById) {
  const chunkId = normalizeText(pointer?.chunkId, 'RECOVERY_TRANSPORT_MANIFEST_POINTER_INVALID');
  const object = objectsById.get(chunkId);
  if (!object || object.cipherBytes !== pointer.cipherBytes || object.cipherSha256 !== pointer.cipherSha256) {
    fail('RECOVERY_TRANSPORT_MANIFEST_OBJECT_MISSING');
  }
  return object;
}

/**
 * Builds the upload-ready representation of one shop's recovery generation. The outer
 * transport contains only opaque encrypted objects and a passphrase-wrapped key envelope;
 * shop id, domains, records and counts live solely in the encrypted inner manifest.
 */
export function createRecoveryGeneration({
  profileCandidate,
  shopCandidate,
  keyEnvelope,
  encryptionKey,
  dedupeKey,
  aad = '',
  generationId,
  createdAt,
  quotaBytes = null,
} = {}) {
  const profile = candidateManifest(profileCandidate, 'wangzai-recovery-profile-core');
  const shop = candidateManifest(shopCandidate, 'wangzai-recovery-export-candidate');
  const id = normalizeText(generationId, 'RECOVERY_GENERATION_ID_REQUIRED');
  const timestamp = assertIsoTimestamp(createdAt);
  if (!keyEnvelope || keyEnvelope.format !== 'wangzai-recovery-key-envelope' || keyEnvelope.version !== 1) {
    fail('RECOVERY_GENERATION_KEY_ENVELOPE_REQUIRED');
  }
  const manifestChunk = buildRecoveryChunk({
    domain: MANIFEST_DOMAIN,
    domainSchemaVersion: GENERATION_VERSION,
    partitionKey: MANIFEST_PARTITION,
    records: [{
      key: `generation:${id}`,
      value: {
        format: GENERATION_FORMAT,
        version: GENERATION_VERSION,
        generationId: id,
        createdAt: timestamp,
        profileCandidate: profile.metadata,
        shopCandidate: shop.metadata,
      },
    }],
  });
  const manifestEncrypted = encryptRecoveryChunk({ chunk: manifestChunk, encryptionKey, dedupeKey, aad });
  const objectsById = new Map();
  for (const object of [
    ...profile.chunksById.values(),
    ...shop.chunksById.values(),
    opaqueObject(manifestEncrypted),
  ]) {
    const previous = objectsById.get(object.chunkId);
    if (previous && !objectMatches(previous, object)) fail('RECOVERY_TRANSPORT_CHUNK_ID_COLLISION');
    objectsById.set(object.chunkId, object);
  }
  const objects = [...objectsById.values()].sort((left, right) => left.chunkId.localeCompare(right.chunkId));
  const logicalCipherBytes = objects.reduce((total, object) => total + object.cipherBytes, 0);
  if (Number.isFinite(quotaBytes) && logicalCipherBytes > quotaBytes) {
    fail('RECOVERY_GENERATION_QUOTA_EXCEEDED');
  }
  return {
    format: GENERATION_FORMAT,
    version: GENERATION_VERSION,
    keyEnvelope: cloneJson(keyEnvelope),
    manifestObject: {
      chunkId: manifestEncrypted.chunkId,
      cipherBytes: manifestEncrypted.cipherBytes,
      cipherSha256: manifestEncrypted.cipherSha256,
    },
    logicalCipherBytes,
    objects,
  };
}

/** Decrypts and validates the inner manifest, then rebuilds importer-ready candidates in memory. */
export function openRecoveryGeneration({ transport, encryptionKey, aad = '' } = {}) {
  if (transport?.format !== GENERATION_FORMAT || transport.version !== GENERATION_VERSION) {
    fail('RECOVERY_TRANSPORT_UNSUPPORTED');
  }
  const objectsById = normalizedTransportObjects(transport.objects);
  const manifestObject = assertManifestPointer(transport.manifestObject, objectsById);
  const decoded = decryptRecoveryChunk({ encrypted: manifestObject, encryptionKey, aad });
  if (
    decoded.header.domain !== MANIFEST_DOMAIN
    || decoded.header.domainSchemaVersion !== GENERATION_VERSION
    || decoded.header.partitionKey !== MANIFEST_PARTITION
    || decoded.records.length !== 1
  ) {
    fail('RECOVERY_GENERATION_MANIFEST_INVALID');
  }
  const manifest = decoded.records[0];
  const value = manifest?.value;
  if (
    !value
    || value.format !== GENERATION_FORMAT
    || value.version !== GENERATION_VERSION
    || manifest.key !== `generation:${value.generationId}`
    || !normalizeText(value.generationId, 'RECOVERY_GENERATION_MANIFEST_ID_INVALID')
    || !assertIsoTimestamp(value.createdAt)
  ) {
    fail('RECOVERY_GENERATION_MANIFEST_INVALID');
  }
  const profileCandidate = hydrateCandidate(value.profileCandidate, objectsById);
  const shopCandidate = hydrateCandidate(value.shopCandidate, objectsById);
  const expectedObjectIds = new Set([
    manifestObject.chunkId,
    ...profileCandidate.chunks.map((chunk) => chunk.chunkId),
    ...shopCandidate.chunks.map((chunk) => chunk.chunkId),
  ]);
  if (expectedObjectIds.size !== objectsById.size) fail('RECOVERY_GENERATION_OBJECT_SET_MISMATCH');
  return {
    generationId: value.generationId,
    createdAt: value.createdAt,
    keyEnvelope: cloneJson(transport.keyEnvelope),
    profileCandidate,
    shopCandidate,
  };
}

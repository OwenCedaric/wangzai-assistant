import { createHash, createHmac } from 'node:crypto';

const GENERATION_FORMAT = 'wangzai-recovery-generation';
const GENERATION_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;
const LEGACY_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const RECOVERY_OWNER_TYPES = new Set([
  'ozon_shop',
  'cross_border_bus',
  'promotion_account',
  'purchase_account',
  'model_api_account',
  'integration_profile',
]);

function fail(code) {
  throw new Error(code);
}

function remoteAccessError(code, message, remoteStatus, safeAuthRetry = false) {
  const error = new Error(message);
  error.code = code;
  error.remoteStatus = remoteStatus;
  error.safeAuthRetry = safeAuthRetry;
  return error;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    fail('RECOVERY_REMOTE_URL_INVALID');
  }
  return url.toString().replace(/\/$/u, '');
}

function assertOpaqueId(value, code) {
  const id = String(value || '').trim();
  if (!OPAQUE_ID_PATTERN.test(id)) fail(code);
  return id;
}

function assertGenerationId(value, code) {
  const id = String(value || '').trim();
  // Existing encrypted backups created before CU-073 used UUID generation IDs.
  // They remain opaque and must be restorable after upgrading the desktop client.
  if (!OPAQUE_ID_PATTERN.test(id) && !LEGACY_UUID_PATTERN.test(id)) fail(code);
  return id;
}

function assertCipherHash(value, code) {
  const hash = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/u.test(hash)) fail(code);
  return hash;
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

function encryptedObjectBytes(object) {
  const nonce = fromBase64Url(object?.nonceB64u, 'RECOVERY_REMOTE_NONCE_REQUIRED');
  const tag = fromBase64Url(object?.tagB64u, 'RECOVERY_REMOTE_TAG_REQUIRED');
  const ciphertext = fromBase64Url(object?.ciphertextB64u, 'RECOVERY_REMOTE_CIPHERTEXT_REQUIRED');
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES || !ciphertext.length) {
    fail('RECOVERY_REMOTE_CIPHER_LAYOUT_INVALID');
  }
  const bytes = Buffer.concat([nonce, tag, ciphertext]);
  if (object?.algorithm !== 'AES-256-GCM' || object?.objectFormatVersion !== 1) {
    fail('RECOVERY_REMOTE_CIPHER_ALGORITHM_INVALID');
  }
  if (bytes.length !== object?.cipherBytes || sha256(bytes) !== assertCipherHash(object?.cipherSha256, 'RECOVERY_REMOTE_CIPHER_HASH_INVALID')) {
    fail('RECOVERY_REMOTE_CIPHER_INTEGRITY_MISMATCH');
  }
  return bytes;
}

function transportObjectRefs(transport) {
  if (!Array.isArray(transport?.objects) || !transport.objects.length) fail('RECOVERY_REMOTE_OBJECTS_REQUIRED');
  const seen = new Set();
  return transport.objects.map((object) => {
    const chunkId = assertOpaqueId(object?.chunkId, 'RECOVERY_REMOTE_CHUNK_ID_INVALID');
    if (seen.has(chunkId)) fail('RECOVERY_REMOTE_CHUNK_ID_DUPLICATE');
    seen.add(chunkId);
    const bytes = encryptedObjectBytes(object);
    return {
      chunkId,
      cipherBytes: bytes.length,
      cipherSha256: object.cipherSha256,
      bytes,
    };
  });
}

function assertTransport(transport) {
  if (transport?.format !== GENERATION_FORMAT || transport.version !== GENERATION_VERSION) {
    fail('RECOVERY_REMOTE_TRANSPORT_INVALID');
  }
  if (transport?.keyEnvelope?.format !== 'wangzai-recovery-key-envelope' || transport.keyEnvelope.version !== 1) {
    fail('RECOVERY_REMOTE_KEY_ENVELOPE_INVALID');
  }
  const manifestChunkId = assertOpaqueId(transport?.manifestObject?.chunkId, 'RECOVERY_REMOTE_MANIFEST_INVALID');
  const refs = transportObjectRefs(transport);
  const manifest = refs.find((item) => item.chunkId === manifestChunkId);
  if (
    !manifest
    || manifest.cipherBytes !== transport.manifestObject.cipherBytes
    || manifest.cipherSha256 !== transport.manifestObject.cipherSha256
  ) {
    fail('RECOVERY_REMOTE_MANIFEST_INVALID');
  }
  const logicalCipherBytes = refs.reduce((total, item) => total + item.cipherBytes, 0);
  if (logicalCipherBytes !== transport.logicalCipherBytes || logicalCipherBytes > 30 * 1024 * 1024) {
    fail('RECOVERY_REMOTE_QUOTA_INVALID');
  }
  return { manifestChunkId, refs, logicalCipherBytes };
}

function assertGenerationRead(value, { expectedGenerationId, expectedScopeKey } = {}) {
  const generationId = assertGenerationId(value?.generation_id, 'RECOVERY_REMOTE_GENERATION_ID_INVALID');
  const scopeKey = assertOpaqueId(value?.scope_key, 'RECOVERY_REMOTE_SCOPE_KEY_INVALID');
  const manifestChunkId = assertOpaqueId(value?.manifest_chunk_id, 'RECOVERY_REMOTE_MANIFEST_INVALID');
  const logicalCipherBytes = Number(value?.logical_cipher_bytes);
  if (!Number.isSafeInteger(logicalCipherBytes) || logicalCipherBytes <= 0 || logicalCipherBytes > 30 * 1024 * 1024) {
    fail('RECOVERY_REMOTE_QUOTA_INVALID');
  }
  if (expectedGenerationId && generationId !== expectedGenerationId) fail('RECOVERY_REMOTE_GENERATION_ID_MISMATCH');
  if (expectedScopeKey && scopeKey !== expectedScopeKey) fail('RECOVERY_REMOTE_SCOPE_KEY_MISMATCH');
  if (value?.key_envelope?.format !== 'wangzai-recovery-key-envelope' || value?.key_envelope?.version !== 1) {
    fail('RECOVERY_REMOTE_KEY_ENVELOPE_INVALID');
  }
  const ownerRefs = normalizeOwnerRefs(value?.owner_refs);
  return { generationId, scopeKey, manifestChunkId, logicalCipherBytes, ownerRefs };
}

function normalizeOwnerRefs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('RECOVERY_REMOTE_OWNER_REFS_INVALID');
  const refs = value.map((entry) => assertOpaqueId(entry, 'RECOVERY_REMOTE_OWNER_REF_INVALID')).sort();
  if (new Set(refs).size !== refs.length) fail('RECOVERY_REMOTE_OWNER_REFS_INVALID');
  return refs;
}

function normalizeGenerationIds(value) {
  if (!Array.isArray(value)) fail('RECOVERY_REMOTE_EXPECTED_GENERATIONS_INVALID');
  const ids = value.map((entry) => assertGenerationId(entry, 'RECOVERY_REMOTE_GENERATION_ID_INVALID')).sort();
  if (new Set(ids).size !== ids.length) fail('RECOVERY_REMOTE_EXPECTED_GENERATIONS_INVALID');
  return ids;
}

async function readJson(response, code) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(code);
  }
  return payload;
}

async function assertOk(response, code) {
  if (response.ok) return response;
  const message = await response.text().catch(() => '');
  fail(`${code}:${response.status}${message ? `:${message.slice(0, 256)}` : ''}`);
}

async function assertCommitOk(response) {
  if (response.ok) return response;
  // A new desktop backup is CAS-protected.  Do not silently retry a stale
  // device: doing so could replace a newer encrypted generation from elsewhere.
  if (response.status === 409) fail('RECOVERY_REMOTE_COMMIT_CONFLICT');
  await assertOk(response, 'RECOVERY_REMOTE_COMMIT_FAILED');
}

/** A deterministic opaque scope id; raw local/Ozon shop identifiers never leave this client. */
export function deriveRecoveryScopeKey({ dedupeKey, shopId } = {}) {
  const key = Buffer.isBuffer(dedupeKey) ? dedupeKey : Buffer.from(dedupeKey || '');
  const normalizedShopId = String(shopId || '').trim();
  if (key.length !== 32) fail('RECOVERY_DEDUPE_KEY_INVALID');
  if (!normalizedShopId) fail('RECOVERY_SCOPE_SHOP_ID_REQUIRED');
  return createHmac('sha256', key).update(`scope:shop:${normalizedShopId}`).digest('base64url');
}

/** Stable only for one encrypted owner incarnation; a same-id rebind receives a different ref. */
export function deriveRecoveryOwnerRef({ dedupeKey, ownerType, ownerId, ownerIncarnation } = {}) {
  const key = Buffer.isBuffer(dedupeKey) ? dedupeKey : Buffer.from(dedupeKey || '');
  const type = String(ownerType || '').trim();
  const id = String(ownerId || '').trim();
  const incarnation = String(ownerIncarnation || '').trim();
  if (key.length !== 32) fail('RECOVERY_DEDUPE_KEY_INVALID');
  if (!RECOVERY_OWNER_TYPES.has(type) || !id || !incarnation || incarnation.length > 160) {
    fail('RECOVERY_OWNER_REF_INPUT_INVALID');
  }
  return createHmac('sha256', key)
    .update(`scope:owner:v1:${type}\0${id}\0${incarnation}`)
    .digest('base64url');
}

/**
 * Network adapter for the opaque-object protocol. It receives already encrypted transport
 * objects and never receives passphrases, decrypted keys, domains, shop ids or records.
 */
export function createRecoveryRemoteClient({ baseUrl, accessToken, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizeBaseUrl(baseUrl);
  const token = String(accessToken || '').trim();
  if (!token) throw remoteAccessError('RECOVERY_REMOTE_LOGIN_REQUIRED', '请登录软件账号后继续清理远端恢复记录。', 401);
  if (typeof fetchImpl !== 'function') fail('RECOVERY_REMOTE_FETCH_REQUIRED');
  const authorization = `Bearer ${token}`;
  let mutationAttempted = false;

  async function fetchRecovery(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) mutationAttempted = true;
    let response;
    try { response = await fetchImpl(url, options); }
    catch (cause) {
      const error = remoteAccessError('RECOVERY_REMOTE_UNAVAILABLE', '无法连接远端恢复服务，请检查网络后继续同一删除任务。', 0);
      error.cause = cause;
      throw error;
    }
    if (response.status === 401) {
      // The caller may restart a purge only when the rejected request came
      // before every remote mutation. Never replay a partially committed purge.
      throw remoteAccessError('RECOVERY_REMOTE_AUTH_REQUIRED', '远端恢复服务拒绝了当前登录凭证，请刷新登录后重试。', 401, !mutationAttempted);
    }
    if (response.status === 403) {
      throw remoteAccessError('RECOVERY_REMOTE_ACCESS_DENIED', '当前账号没有远端恢复数据的访问权限，请检查登录账号和权限。', 403);
    }
    if (response.status === 404) {
      throw remoteAccessError('RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE', '远端恢复接口或记录不可用，请检查服务版本和恢复数据状态；不能据此认定数据不存在。', 404);
    }
    return response;
  }

  async function uploadGeneration({ scopeKey, ownerRefs: ownerRefsInput, transport } = {}) {
    const normalizedScopeKey = assertOpaqueId(scopeKey, 'RECOVERY_REMOTE_SCOPE_KEY_INVALID');
    const ownerRefs = normalizeOwnerRefs(ownerRefsInput);
    const { manifestChunkId, refs, logicalCipherBytes } = assertTransport(transport);
    for (const object of refs) {
      const response = await fetchRecovery(`${origin}/api/recovery/objects/${encodeURIComponent(object.chunkId)}`, {
        method: 'PUT',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/octet-stream',
          'X-Recovery-Cipher-Sha256': object.cipherSha256,
          'X-Recovery-Cipher-Bytes': String(object.cipherBytes),
        },
        body: object.bytes,
      });
      await assertOk(response, 'RECOVERY_REMOTE_UPLOAD_FAILED');
      const confirmation = await readJson(response, 'RECOVERY_REMOTE_UPLOAD_RESPONSE_INVALID');
      if (confirmation?.chunk_id !== object.chunkId || confirmation?.cipher_bytes !== object.cipherBytes) {
        fail('RECOVERY_REMOTE_UPLOAD_CONFIRMATION_INVALID');
      }
    }
    const activeForScope = (await listGenerations()).filter(
      (generation) => generation.scope_key === normalizedScopeKey,
    );
    if (activeForScope.length > 1) fail('RECOVERY_REMOTE_SCOPE_GENERATION_INVALID');
    const expectedGenerationId = activeForScope[0]?.generation_id || null;
    const response = await fetchRecovery(`${origin}/api/recovery/generations`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope_key: normalizedScopeKey,
        expected_generation_id: expectedGenerationId,
        owner_refs: ownerRefs,
        key_envelope: transport.keyEnvelope,
        manifest_chunk_id: manifestChunkId,
        logical_cipher_bytes: logicalCipherBytes,
        object_refs: refs.map(({ chunkId, cipherBytes, cipherSha256 }) => ({
          chunk_id: chunkId,
          cipher_bytes: cipherBytes,
          cipher_sha256: cipherSha256,
        })),
      }),
    });
    await assertCommitOk(response);
    const committed = await readJson(response, 'RECOVERY_REMOTE_COMMIT_RESPONSE_INVALID');
    const generation = assertGenerationRead(committed, { expectedScopeKey: normalizedScopeKey });
    if (
      generation.manifestChunkId !== manifestChunkId
      || generation.logicalCipherBytes !== logicalCipherBytes
      || JSON.stringify(generation.ownerRefs) !== JSON.stringify(ownerRefs)
    ) {
      fail('RECOVERY_REMOTE_COMMIT_RESPONSE_INVALID');
    }
    return committed;
  }

  async function listGenerations() {
    const response = await fetchRecovery(`${origin}/api/recovery/generations`, {
      headers: { Authorization: authorization },
    });
    await assertOk(response, 'RECOVERY_REMOTE_LIST_FAILED');
    const generations = await readJson(response, 'RECOVERY_REMOTE_LIST_RESPONSE_INVALID');
    if (!Array.isArray(generations)) fail('RECOVERY_REMOTE_LIST_RESPONSE_INVALID');
    generations.forEach((generation) => assertGenerationRead(generation));
    return generations;
  }

  async function downloadGeneration({ generationId } = {}) {
    const id = assertGenerationId(generationId, 'RECOVERY_REMOTE_GENERATION_ID_INVALID');
    const detailResponse = await fetchRecovery(`${origin}/api/recovery/generations/${encodeURIComponent(id)}`, {
      headers: { Authorization: authorization },
    });
    await assertOk(detailResponse, 'RECOVERY_REMOTE_DETAIL_FAILED');
    const detail = await readJson(detailResponse, 'RECOVERY_REMOTE_DETAIL_RESPONSE_INVALID');
    const generation = assertGenerationRead(detail, { expectedGenerationId: id });
    if (!Array.isArray(detail?.object_refs) || !detail.object_refs.length) fail('RECOVERY_REMOTE_DETAIL_RESPONSE_INVALID');
    const refs = detail.object_refs.map((item) => ({
      chunkId: assertOpaqueId(item?.chunk_id, 'RECOVERY_REMOTE_OBJECT_REF_INVALID'),
      cipherBytes: Number(item?.cipher_bytes),
      cipherSha256: assertCipherHash(item?.cipher_sha256, 'RECOVERY_REMOTE_OBJECT_REF_INVALID'),
    }));
    if (new Set(refs.map((item) => item.chunkId)).size !== refs.length) fail('RECOVERY_REMOTE_OBJECT_REF_DUPLICATE');
    const objects = [];
    for (const ref of refs) {
      const response = await fetchRecovery(
        `${origin}/api/recovery/generations/${encodeURIComponent(id)}/objects/${encodeURIComponent(ref.chunkId)}`,
        { headers: { Authorization: authorization } },
      );
      await assertOk(response, 'RECOVERY_REMOTE_DOWNLOAD_FAILED');
      const bytes = Buffer.from(await response.arrayBuffer());
      const cipherHash = response.headers.get('x-recovery-cipher-sha256');
      const cipherBytes = Number(response.headers.get('x-recovery-cipher-bytes'));
      if (
        cipherHash !== ref.cipherSha256
        || cipherBytes !== ref.cipherBytes
        || bytes.length !== ref.cipherBytes
        || sha256(bytes) !== ref.cipherSha256
        || bytes.length <= NONCE_BYTES + TAG_BYTES
      ) {
        fail('RECOVERY_REMOTE_DOWNLOAD_INTEGRITY_MISMATCH');
      }
      objects.push({
        objectFormatVersion: 1,
        algorithm: 'AES-256-GCM',
        chunkId: ref.chunkId,
        cipherBytes: ref.cipherBytes,
        cipherSha256: ref.cipherSha256,
        nonceB64u: toBase64Url(bytes.subarray(0, NONCE_BYTES)),
        tagB64u: toBase64Url(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)),
        ciphertextB64u: toBase64Url(bytes.subarray(NONCE_BYTES + TAG_BYTES)),
      });
    }
    const logicalCipherBytes = objects.reduce((total, object) => total + object.cipherBytes, 0);
    const manifest = objects.find((item) => item.chunkId === generation.manifestChunkId);
    if (!manifest || logicalCipherBytes !== generation.logicalCipherBytes) {
      fail('RECOVERY_REMOTE_DOWNLOAD_MANIFEST_INVALID');
    }
    return {
      format: GENERATION_FORMAT,
      version: GENERATION_VERSION,
      keyEnvelope: detail.key_envelope,
      manifestObject: {
        chunkId: manifest.chunkId,
        cipherBytes: manifest.cipherBytes,
        cipherSha256: manifest.cipherSha256,
      },
      logicalCipherBytes,
      objects,
    };
  }

  async function purgeOwner({ ownerRef, expectedGenerationIds } = {}) {
    const ref = assertOpaqueId(ownerRef, 'RECOVERY_REMOTE_OWNER_REF_INVALID');
    const expectedIds = normalizeGenerationIds(expectedGenerationIds);
    const response = await fetchRecovery(`${origin}/api/recovery/owners/${encodeURIComponent(ref)}/purge`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_generation_ids: expectedIds }),
    });
    if (response.status === 409) fail('RECOVERY_REMOTE_OWNER_PURGE_CONFLICT');
    await assertOk(response, 'RECOVERY_REMOTE_OWNER_PURGE_FAILED');
    const payload = await readJson(response, 'RECOVERY_REMOTE_OWNER_PURGE_RESPONSE_INVALID');
    const deletedGenerationIds = normalizeGenerationIds(payload?.deleted_generation_ids);
    if (
      payload?.owner_ref !== ref
      || payload?.tombstoned !== true
      || !Number.isSafeInteger(payload?.remaining_generation_count)
      || payload.remaining_generation_count < 0
    ) {
      fail('RECOVERY_REMOTE_OWNER_PURGE_RESPONSE_INVALID');
    }
    return {
      ownerRef: ref,
      tombstoned: true,
      deletedGenerationIds,
      remainingGenerationCount: payload.remaining_generation_count,
    };
  }

  async function getOwnerPurgeStatus({ ownerRef } = {}) {
    const ref = assertOpaqueId(ownerRef, 'RECOVERY_REMOTE_OWNER_REF_INVALID');
    const response = await fetchRecovery(`${origin}/api/recovery/owners/${encodeURIComponent(ref)}/purge-status`, {
      headers: { Authorization: authorization },
    });
    await assertOk(response, 'RECOVERY_REMOTE_OWNER_PURGE_STATUS_FAILED');
    const payload = await readJson(response, 'RECOVERY_REMOTE_OWNER_PURGE_STATUS_INVALID');
    if (payload?.owner_ref !== ref || typeof payload?.tombstoned !== 'boolean') {
      fail('RECOVERY_REMOTE_OWNER_PURGE_STATUS_INVALID');
    }
    return { ownerRef: ref, tombstoned: payload.tombstoned };
  }

  return {
    downloadGeneration,
    getOwnerPurgeStatus,
    listGenerations,
    purgeOwner,
    uploadGeneration,
  };
}

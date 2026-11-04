import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LOCAL_DATA_ROUTE_PREFIX = '/local-data-api/';
const RETIRED_PURCHASE_PLUGIN_CONTEXT_ROUTE = '/legacy-migration-api/purchase-source-plugin-context';
const RETIRED_MARKETING_ACTIVITY_CACHE_ROUTE = '/legacy-migration-api/marketing-activity-cache';
const PURCHASE_IMAGE_ROUTE = '/purchase-image';
const COLLECTION_PRICING_DRAFT_ROUTE = '/collection-pricing-draft-api';
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const COLLECTION_PRICING_DRAFT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const COLLECTION_PRICING_DRAFT_SCHEMA_VERSION = 2;
const COLLECTION_PRICING_DRAFT_ITEM_LIMIT = 500;
const ATOMIC_WRITE_MAX_ATTEMPTS = 6;
const ATOMIC_WRITE_RETRY_BASE_MS = 80;

const LOCAL_DATA_FILES = {
  'ozon-shop-settings': { directory: '分类缓存/01-店铺设置', fileName: 'ozon-shop-settings.json' },
  'sales-source-links': { directory: '分类缓存/05-销售订单', fileName: 'sales-source-links.json' },
  'product-material-profiles': { directory: '商品资料', fileName: 'product-material-profiles.json' },
  'product-source-links': { directory: '商品资料', fileName: 'product-source-links.json' },
  'purchase-source-links': { directory: '分类缓存/07-拍单采购', fileName: 'purchase-source-links.json' },
  'purchase-order-local-overrides': { directory: '商品资料', fileName: 'purchase-order-local-overrides.json' },
  'cross-border-bus-order-records': { directory: '商品资料', fileName: 'cross-border-bus-order-records.json' },
  'after-sales-display-snapshots': {
    directory: '分类缓存/09-售后订单',
    fileName: 'after-sales-display-snapshots.json',
    maxBodyBytes: 16 * 1024 * 1024,
  },
  'profit-local-cache': {
    directory: '分类缓存/10-利润核算',
    fileName: 'profit-local-cache.json',
    maxBodyBytes: 64 * 1024 * 1024,
  },
  'local-mirror-read-log': { directory: '分类缓存/14-失败重试', fileName: 'local-mirror-read-log.json' },
  'local-mirror-retry-queue': { directory: '分类缓存/14-失败重试', fileName: 'local-mirror-retry-queue.json' },
  'browser-local-storage': { directory: 'settings', fileName: 'browser-local-storage.json' },
};
// FROZEN-FOR-REMOVAL: retained only as an audited legacy inventory.  No
// generic business JSON key may read or write at runtime.
const FROZEN_LEGACY_LOCAL_DATA_FILE_KEYS = new Set(Object.keys(LOCAL_DATA_FILES));

const RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE = Object.freeze({
  directory: '分类缓存/07-拍单采购',
  fileName: 'purchase-source-plugin-context.json',
});

const RETIRED_MARKETING_ACTIVITY_CACHE_FILE = Object.freeze({
  directory: '分类缓存/12-营销活动',
  fileName: 'marketing-activity-cache.json',
});
const COLLECTION_PRICING_DRAFT_FILE = Object.freeze({
  directory: '分类缓存/17-采集核价',
  fileName: 'collection-pricing-draft.json',
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const writeQueues = new Map();

function jsonResponse(statusCode, payload) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function textResponse(statusCode, text, contentType = 'text/plain; charset=utf-8') {
  return new Response(text, {
    status: statusCode,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readDataFile(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeDataFile(directory, filePath, data) {
  await fsp.mkdir(directory, { recursive: true });
  const tempFilePath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    await fsp.writeFile(tempFilePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    for (let attempt = 1; attempt <= ATOMIC_WRITE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await fsp.rename(tempFilePath, filePath);
        return;
      } catch (error) {
        const canRetry = ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
        if (!canRetry || attempt >= ATOMIC_WRITE_MAX_ATTEMPTS) throw error;
        await sleep(ATOMIC_WRITE_RETRY_BASE_MS * attempt);
      }
    }
  } catch (error) {
    await fsp.rm(tempFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function queueDataFileWrite(filePath, writeTask) {
  const previousWrite = writeQueues.get(filePath) ?? Promise.resolve();
  const currentWrite = previousWrite.catch(() => undefined).then(writeTask);
  const queueTail = currentWrite
    .catch(() => undefined)
    .then(() => {
      if (writeQueues.get(filePath) === queueTail) writeQueues.delete(filePath);
    });
  writeQueues.set(filePath, queueTail);
  return currentWrite;
}

async function readJsonRequest(request, maxBodyBytes) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) {
    const error = new Error('Body too large');
    error.code = 'LOCAL_DATA_BODY_TOO_LARGE';
    throw error;
  }
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function resolveSafeStaticPath(frontendDist, requestPathname) {
  const decodedPath = decodeURIComponent(requestPathname || '/');
  const normalizedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const relativePath = normalizedPath.replace(/^\/+/u, '');
  const filePath = path.resolve(frontendDist, relativePath);
  const rootPath = path.resolve(frontendDist);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) {
    return null;
  }
  return filePath;
}

async function serveStatic(frontendDist, requestUrl) {
  const filePath = resolveSafeStaticPath(frontendDist, requestUrl.pathname);
  if (!filePath) return textResponse(403, 'Forbidden');

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return textResponse(404, 'Not found');
    const body = await fsp.readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return textResponse(500, `Desktop static file error: ${error?.code || 'unknown'}`);
    }

    // A missing hashed asset is not a client-side route. Returning index.html
    // here turns a stale chunk into a misleading MIME error and can crash the
    // whole lazy route. Keep SPA fallback only for extensionless navigation.
    if (path.extname(requestUrl.pathname)) {
      const contentType = MIME_TYPES[path.extname(requestUrl.pathname).toLowerCase()] || 'text/plain; charset=utf-8';
      return textResponse(404, 'Static asset not found', contentType);
    }

    const indexPath = path.join(frontendDist, 'index.html');
    if (fs.existsSync(indexPath)) {
      const body = await fsp.readFile(indexPath);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    return textResponse(
      404,
      '<!doctype html><meta charset="utf-8"><title>旺崽助手</title><body>前端 dist 不存在，请先运行 frontend npm run build。</body>',
      'text/html; charset=utf-8',
    );
  }
}

async function handleLocalDataRequest(request, requestUrl, localDataRoot, legacyRetirementFault = null) {
  const method = String(request.method || 'GET').toUpperCase();
  const key = decodeURIComponent(requestUrl.pathname.slice(LOCAL_DATA_ROUTE_PREFIX.length).split('/')[0] || '');
  if (key === 'purchase-source-plugin-context') {
    return jsonResponse(410, {
      ok: false,
      message: 'Retired purchase plugin context is migration-only.',
    });
  }
  if (key === 'marketing-activity-cache') {
    return jsonResponse(410, {
      ok: false,
      message: 'Retired marketing activity cache is migration-only.',
    });
  }
  if (FROZEN_LEGACY_LOCAL_DATA_FILE_KEYS.has(key)) {
    return jsonResponse(410, {
      ok: false,
      message: 'Legacy JSON business storage is frozen; use local-api SQLite.',
    });
  }
  const rejected = legacyRetirementFault?.beforeRequest?.({
    surface: 'local-data',
    method,
    path: requestUrl.pathname,
  });
  if (rejected) {
    return jsonResponse(rejected.status || 503, {
      ok: false,
      message: rejected.error || 'Legacy retirement fixture failure',
    });
  }
  const fileConfig = LOCAL_DATA_FILES[key];
  if (!fileConfig) return jsonResponse(404, { ok: false, message: 'Not found' });

  const dataDirectory = path.join(localDataRoot, fileConfig.directory);
  const filePath = path.join(dataDirectory, fileConfig.fileName);

  try {
    if (method === 'GET') {
      const data = await readDataFile(filePath);
      return jsonResponse(200, { ok: true, data });
    }

    if (method === 'PUT' || method === 'POST') {
      const data = await readJsonRequest(request, fileConfig.maxBodyBytes || DEFAULT_MAX_BODY_BYTES);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return jsonResponse(400, { ok: false, message: 'Invalid data' });
      }
      await queueDataFileWrite(filePath, () => writeDataFile(dataDirectory, filePath, data));
      legacyRetirementFault?.recordResult?.({
        surface: 'local-data',
        method,
        path: requestUrl.pathname,
        result: { ok: true },
      });
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(405, { ok: false, message: 'Method not allowed' });
  } catch (error) {
    if (error?.code === 'LOCAL_DATA_BODY_TOO_LARGE') {
      return jsonResponse(413, { ok: false, message: 'Local data body too large' });
    }
    return jsonResponse(500, {
      ok: false,
      message: `Local data write failed: ${error?.code || 'unknown'}`,
    });
  }
}

function isRetiredPurchasePluginContextMarker(data) {
  return Boolean(
    data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Object.keys(data).length === 3 &&
      data.migration === 'profile-settings' &&
      data.namespace === 'purchase-plugin-context' &&
      typeof data.migratedAt === 'string' &&
      data.migratedAt.length <= 80,
  );
}

/** Fixed migration-only endpoint; it never accepts a business context payload. */
async function handleRetiredPurchasePluginContextRequest(request, localDataRoot) {
  const method = String(request.method || 'GET').toUpperCase();
  const dataDirectory = path.join(localDataRoot, RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE.directory);
  const filePath = path.join(dataDirectory, RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE.fileName);
  try {
    if (method === 'GET') {
      return jsonResponse(200, { ok: true, data: await readDataFile(filePath) });
    }
    if (method === 'PUT') {
      const marker = await readJsonRequest(request, DEFAULT_MAX_BODY_BYTES);
      if (!isRetiredPurchasePluginContextMarker(marker)) {
        return jsonResponse(400, { ok: false, message: 'Invalid retired purchase plugin context marker' });
      }
      await queueDataFileWrite(filePath, () => writeDataFile(dataDirectory, filePath, marker));
      return jsonResponse(200, { ok: true, data: {} });
    }
    return jsonResponse(405, { ok: false, message: 'Method not allowed' });
  } catch (error) {
    if (error?.code === 'LOCAL_DATA_BODY_TOO_LARGE') {
      return jsonResponse(413, { ok: false, message: 'Local data body too large' });
    }
    return jsonResponse(500, {
      ok: false,
      message: `Retired purchase plugin context migration failed: ${error?.code || 'unknown'}`,
    });
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isPlainDataRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function emptyCollectionPricingDraft() {
  return { schemaVersion: COLLECTION_PRICING_DRAFT_SCHEMA_VERSION, savedAt: '', items: [] };
}

function isCollectionPricingDraft(value, { allowLegacy = false } = {}) {
  const acceptedVersions = allowLegacy ? [1, COLLECTION_PRICING_DRAFT_SCHEMA_VERSION] : [COLLECTION_PRICING_DRAFT_SCHEMA_VERSION];
  if (!isPlainDataRecord(value) || !acceptedVersions.includes(value.schemaVersion) || !Array.isArray(value.items)) return false;
  if (value.items.length > COLLECTION_PRICING_DRAFT_ITEM_LIMIT || (value.savedAt && typeof value.savedAt !== 'string')) return false;
  return value.items.every((item) => {
    if (!isPlainDataRecord(item)) return false;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 300) return false;
    if (item.sourceUrl != null && (typeof item.sourceUrl !== 'string' || item.sourceUrl.length > 3000)) return false;
    if (item.title != null && (typeof item.title !== 'string' || item.title.length > 1200)) return false;
    return (
      (!Array.isArray(item.skus) || item.skus.length <= 800) &&
      (!Array.isArray(item.mainImages) || item.mainImages.length <= 60) &&
      (!Array.isArray(item.skuImages) || item.skuImages.length <= 800) &&
      (!Array.isArray(item.detailImages) || item.detailImages.length <= 300) &&
      (!Array.isArray(item.images) || item.images.length <= 1200)
    );
  });
}

function collectionPricingDraftScope(requestUrl) {
  return String(requestUrl?.searchParams?.get('scope') || '').trim().slice(0, 500);
}

export function collectionPricingOwnerScopeFromSession(session = {}) {
  if (session?.authenticated !== true) return '';
  const userId = session?.user?.id ?? session?.user?.userId;
  if (userId == null) return '';
  return String(userId).trim().slice(0, 500);
}

function collectionPricingDraftPath(localDataRoot, scope = '') {
  const dataDirectory = path.join(localDataRoot, COLLECTION_PRICING_DRAFT_FILE.directory);
  if (!scope) {
    return { dataDirectory, filePath: path.join(dataDirectory, COLLECTION_PRICING_DRAFT_FILE.fileName) };
  }
  const scopeDigest = createHash('sha256').update(scope, 'utf8').digest('hex');
  const scopedDirectory = path.join(dataDirectory, 'scopes');
  return { dataDirectory: scopedDirectory, filePath: path.join(scopedDirectory, `${scopeDigest}.json`) };
}

async function migrateLegacyCollectionPricingDraft(localDataRoot, scopedLocation) {
  const legacyLocation = collectionPricingDraftPath(localDataRoot);
  if (fs.existsSync(scopedLocation.filePath) || !fs.existsSync(legacyLocation.filePath)) return false;
  return queueDataFileWrite(legacyLocation.filePath, async () => {
    if (fs.existsSync(scopedLocation.filePath) || !fs.existsSync(legacyLocation.filePath)) return false;
    const legacy = await readDataFile(legacyLocation.filePath);
    if (!Object.keys(legacy).length || !isCollectionPricingDraft(legacy, { allowLegacy: true })) return false;
    const migrated = {
      schemaVersion: COLLECTION_PRICING_DRAFT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      items: legacy.items.slice(0, COLLECTION_PRICING_DRAFT_ITEM_LIMIT),
    };
    await writeDataFile(scopedLocation.dataDirectory, scopedLocation.filePath, migrated);
    const archivePath = path.join(
      legacyLocation.dataDirectory,
      `collection-pricing-draft.migrated-${Date.now()}.json`,
    );
    await fsp.rename(legacyLocation.filePath, archivePath);
    return true;
  });
}

async function handleCollectionPricingDraftRequest(
  request,
  requestUrl,
  localDataRoot,
  getCollectionPricingOwnerSession,
) {
  const method = String(request.method || 'GET').toUpperCase();
  let scope = '';
  try {
    const session = typeof getCollectionPricingOwnerSession === 'function'
      ? await getCollectionPricingOwnerSession()
      : null;
    scope = collectionPricingOwnerScopeFromSession(session);
  } catch {
    scope = '';
  }
  if (!scope) {
    return jsonResponse(401, { ok: false, code: 'COLLECTION_PRICING_DRAFT_OWNER_REQUIRED' });
  }
  const requestedScope = collectionPricingDraftScope(requestUrl);
  if (requestedScope && requestedScope !== scope) {
    return jsonResponse(403, { ok: false, code: 'COLLECTION_PRICING_DRAFT_OWNER_MISMATCH' });
  }
  const { dataDirectory, filePath } = collectionPricingDraftPath(localDataRoot, scope);
  try {
    if (method === 'GET') {
      if (scope) await migrateLegacyCollectionPricingDraft(localDataRoot, { dataDirectory, filePath });
      const data = await readDataFile(filePath);
      if (!Object.keys(data).length) return jsonResponse(200, { ok: true, data: emptyCollectionPricingDraft() });
      if (!isCollectionPricingDraft(data)) {
        return jsonResponse(422, { ok: false, code: 'COLLECTION_PRICING_DRAFT_INVALID' });
      }
      return jsonResponse(200, { ok: true, data });
    }

    if (method === 'PUT') {
      const data = await readJsonRequest(request, COLLECTION_PRICING_DRAFT_MAX_BODY_BYTES);
      if (!isCollectionPricingDraft(data)) {
        return jsonResponse(400, { ok: false, code: 'COLLECTION_PRICING_DRAFT_INVALID' });
      }
      await queueDataFileWrite(filePath, async () => {
        await writeDataFile(dataDirectory, filePath, data);
        const readback = await readDataFile(filePath);
        if (JSON.stringify(readback) !== JSON.stringify(data)) {
          const error = new Error('Collection pricing draft readback mismatch');
          error.code = 'COLLECTION_PRICING_DRAFT_READBACK_MISMATCH';
          throw error;
        }
      });
      return jsonResponse(200, { ok: true, data: { savedAt: data.savedAt, itemCount: data.items.length } });
    }

    return jsonResponse(405, { ok: false, message: 'Method not allowed' });
  } catch (error) {
    if (error?.code === 'LOCAL_DATA_BODY_TOO_LARGE') {
      return jsonResponse(413, { ok: false, code: 'COLLECTION_PRICING_DRAFT_TOO_LARGE' });
    }
    return jsonResponse(500, {
      ok: false,
      code: error?.code || 'COLLECTION_PRICING_DRAFT_WRITE_FAILED',
    });
  }
}

function isMarketingConditionalClearRequest(value) {
  return Boolean(
    isPlainDataRecord(value) &&
      Object.keys(value).length === 1 &&
      typeof value.expectedRevision === 'string' &&
      /^[a-f0-9]{64}$/u.test(value.expectedRevision),
  );
}

/**
 * Read legacy marketing bytes without normalizing or rewriting them.  The
 * revision is a hash of the original byte sequence, so a renderer can prove it
 * cleared the exact source it independently imported into SQLite.  Invalid JSON
 * is deliberately not coerced to `{}`: preserving a malformed source is safer
 * than manufacturing a successful migration.
 */
async function readRetiredMarketingActivityCacheSource(filePath) {
  let bytes;
  try {
    bytes = await fsp.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: true,
        exists: false,
        data: {},
        revision: sha256Hex(Buffer.alloc(0)),
      };
    }
    throw error;
  }

  const revision = sha256Hex(bytes);
  try {
    const data = JSON.parse(bytes.toString('utf8'));
    if (!isPlainDataRecord(data)) {
      return { ok: false, code: 'LEGACY_SOURCE_INVALID' };
    }
    return { ok: true, exists: true, data, revision };
  } catch {
    return { ok: false, code: 'LEGACY_SOURCE_INVALID' };
  }
}

/**
 * Fixed migration-only endpoint for the retired marketing cache.  Its PUT is
 * an intentional CAS delete, never a generic business-data writer:
 *
 * GET  -> parsed legacy object + raw-byte SHA-256 revision
 * PUT  -> { expectedRevision } only; re-read inside the file queue, then delete
 *
 * No source bytes, paths, or business payload are included in write responses.
 */
async function handleRetiredMarketingActivityCacheRequest(request, localDataRoot) {
  const method = String(request.method || 'GET').toUpperCase();
  const dataDirectory = path.join(localDataRoot, RETIRED_MARKETING_ACTIVITY_CACHE_FILE.directory);
  const filePath = path.join(dataDirectory, RETIRED_MARKETING_ACTIVITY_CACHE_FILE.fileName);
  try {
    if (method === 'GET') {
      const source = await readRetiredMarketingActivityCacheSource(filePath);
      if (!source.ok) {
        return jsonResponse(422, { ok: false, code: source.code });
      }
      return jsonResponse(200, {
        ok: true,
        exists: source.exists,
        revision: source.revision,
        data: source.data,
      });
    }

    if (method === 'PUT') {
      const input = await readJsonRequest(request, 64 * 1024);
      if (!isMarketingConditionalClearRequest(input)) {
        return jsonResponse(400, { ok: false, code: 'INVALID_LEGACY_CLEAR_REQUEST' });
      }
      const result = await queueDataFileWrite(filePath, async () => {
        const current = await readRetiredMarketingActivityCacheSource(filePath);
        if (!current.ok) return { ok: false, status: 422, code: current.code };
        if (current.revision !== input.expectedRevision) {
          return { ok: false, status: 409, code: 'LEGACY_SOURCE_CHANGED' };
        }
        await fsp.rm(filePath, { force: true });
        const readback = await readRetiredMarketingActivityCacheSource(filePath);
        if (!readback.ok || readback.exists) {
          const error = new Error('Retired marketing cache clear readback failed');
          error.code = 'LEGACY_SOURCE_CLEAR_READBACK_FAILED';
          throw error;
        }
        return { ok: true };
      });
      if (!result.ok) return jsonResponse(result.status, { ok: false, code: result.code });
      return jsonResponse(200, { ok: true, data: {} });
    }

    return jsonResponse(405, { ok: false, message: 'Method not allowed' });
  } catch (error) {
    if (error?.code === 'LOCAL_DATA_BODY_TOO_LARGE') {
      return jsonResponse(413, { ok: false, message: 'Local data body too large' });
    }
    return jsonResponse(500, {
      ok: false,
      code: 'RETIRED_MARKETING_CACHE_MIGRATION_FAILED',
    });
  }
}

export async function proxyPurchaseBridgeImage({
  requestUrl,
  purchaseBridge,
  fetchImpl = fetch,
}) {
  const remoteUrl = String(requestUrl.searchParams.get('url') || '');
  let parsedRemote;
  try {
    parsedRemote = new URL(remoteUrl);
    if (!['http:', 'https:'].includes(parsedRemote.protocol)) throw new Error('Invalid protocol');
  } catch {
    return textResponse(400, 'Invalid image URL');
  }
  if (!purchaseBridge?.baseUrl) return textResponse(503, 'Purchase bridge unavailable');
  const target = new URL('/api/purchase/image-proxy', purchaseBridge.baseUrl);
  target.searchParams.set('url', parsedRemote.href);
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: purchaseBridge.authToken
        ? { 'X-Wangzai-Purchase-Token': purchaseBridge.authToken }
        : {},
      signal: AbortSignal.timeout(25_000),
    });
    const contentType = String(response.headers.get('content-type') || '');
    if (!response.ok || !contentType.toLowerCase().startsWith('image/')) {
      return textResponse(response.ok ? 415 : response.status, 'Image unavailable');
    }
    return new Response(await response.arrayBuffer(), {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'private, max-age=86400',
      },
    });
  } catch {
    return textResponse(502, 'Image unavailable');
  }
}

export function registerAppProtocol({
  protocol,
  appHost,
  frontendDist,
  localDataRoot,
  purchaseBridge,
  localApi = null,
  getCollectionPricingOwnerSession = null,
  fetchImpl = fetch,
  legacyRetirementFault = null,
  readVerifiedStatic = null,
}) {
  // Recovery activation restarts local services and refreshes their protected
  // capabilities. Electron refuses a second handler for the same scheme, so
  // replace the previous main-process handler before rebinding it.
  if (protocol.isProtocolHandled?.('app')) protocol.unhandle?.('app');
  protocol.handle('app', async (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== appHost) return textResponse(404, 'Not found');

    if (requestUrl.pathname.startsWith(LOCAL_DATA_ROUTE_PREFIX)) {
      return handleLocalDataRequest(request, requestUrl, localDataRoot, legacyRetirementFault);
    }
    if (requestUrl.pathname === RETIRED_PURCHASE_PLUGIN_CONTEXT_ROUTE) {
      return handleRetiredPurchasePluginContextRequest(request, localDataRoot);
    }
    if (requestUrl.pathname === RETIRED_MARKETING_ACTIVITY_CACHE_ROUTE) {
      return handleRetiredMarketingActivityCacheRequest(request, localDataRoot);
    }
    if (requestUrl.pathname === PURCHASE_IMAGE_ROUTE) {
      return proxyPurchaseBridgeImage({ requestUrl, purchaseBridge, fetchImpl });
    }
    if (requestUrl.pathname === CUSTOMER_CHAT_FILE_ROUTE) {
      return proxyCustomerChatFile({ request, requestUrl, localApi, fetchImpl });
    }
    if (PRODUCT_IMAGE_THUMBNAIL_ROUTE.test(requestUrl.pathname)) {
      return proxyProductImageThumbnail({ request, requestUrl, localApi, fetchImpl });
    }
    if (requestUrl.pathname === COLLECTION_PRICING_DRAFT_ROUTE) {
      return handleCollectionPricingDraftRequest(
        request,
        requestUrl,
        localDataRoot,
        getCollectionPricingOwnerSession,
      );
    }

    if (readVerifiedStatic) {
      const verified = await readVerifiedStatic(requestUrl);
      if (verified) return verified;
    }
    return serveStatic(frontendDist, requestUrl);
  });
}

// Keep this addition after the frozen legacy-data source windows above. The
// account-removal ownership certificate binds those historic line ranges.
const PRODUCT_IMAGE_THUMBNAIL_ROUTE = /^\/api\/product-images\/assets\/([A-Za-z0-9._:-]+)\/thumbnail$/u;
const CUSTOMER_CHAT_FILE_ROUTE = '/api/customer-service/chat-file';

export async function proxyCustomerChatFile({
  request,
  requestUrl,
  localApi,
  fetchImpl = fetch,
}) {
  if (String(request?.method || 'GET').toUpperCase() !== 'GET') {
    return textResponse(405, 'Method not allowed');
  }
  const shopId = String(requestUrl.searchParams.get('shopId') || '').trim();
  const remoteUrl = String(requestUrl.searchParams.get('url') || '').trim();
  let parsedRemote;
  try {
    parsedRemote = new URL(remoteUrl);
  } catch {
    return textResponse(400, 'Invalid Ozon chat image request');
  }
  if (
    !shopId ||
    parsedRemote.protocol !== 'https:' ||
    parsedRemote.hostname !== 'api-seller.ozon.ru' ||
    !parsedRemote.pathname.startsWith('/v2/chat/file/') ||
    !localApi?.baseUrl ||
    !localApi?.authToken
  ) {
    return textResponse(400, 'Invalid Ozon chat image request');
  }
  const target = new URL(CUSTOMER_CHAT_FILE_ROUTE, localApi.baseUrl);
  target.searchParams.set('shopId', shopId);
  target.searchParams.set('url', parsedRemote.toString());
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: {
        accept: 'image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        'x-wangzai-local-api-token': localApi.authToken,
      },
      signal: AbortSignal.timeout(35_000),
    });
    const contentType = String(response.headers.get('content-type') || '');
    if (!response.ok || !contentType.toLowerCase().startsWith('image/')) {
      return textResponse(response.ok ? 415 : response.status, 'Ozon chat image unavailable');
    }
    return new Response(await response.arrayBuffer(), {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': response.headers.get('cache-control') || 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return textResponse(502, 'Ozon chat image unavailable');
  }
}

export async function proxyProductImageThumbnail({
  request,
  requestUrl,
  localApi,
  fetchImpl = fetch,
}) {
  if (String(request?.method || 'GET').toUpperCase() !== 'GET') {
    return textResponse(405, 'Method not allowed');
  }
  const routeMatch = requestUrl.pathname.match(PRODUCT_IMAGE_THUMBNAIL_ROUTE);
  const shopId = String(requestUrl.searchParams.get('shopId') || '').trim();
  if (!routeMatch || !shopId || !localApi?.baseUrl || !localApi?.authToken) {
    return textResponse(400, 'Invalid product image thumbnail request');
  }
  const target = new URL(requestUrl.pathname, localApi.baseUrl);
  target.search = requestUrl.search;
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: {
        accept: 'image/webp,image/*;q=0.8',
        'x-wangzai-local-api-token': localApi.authToken,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const contentType = String(response.headers.get('content-type') || '');
    if (!response.ok || !contentType.toLowerCase().startsWith('image/')) {
      return textResponse(response.ok ? 415 : response.status, 'Product image thumbnail unavailable');
    }
    const headers = {
      'content-type': contentType,
      'cache-control': response.headers.get('cache-control') || 'private, max-age=86400, immutable',
    };
    const etag = response.headers.get('etag');
    if (etag) headers.etag = etag;
    return new Response(await response.arrayBuffer(), { status: 200, headers });
  } catch {
    return textResponse(502, 'Product image thumbnail unavailable');
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LOCAL_DATA_ROUTE_PREFIX = '/local-data-api/';
const RETIRED_PURCHASE_PLUGIN_CONTEXT_ROUTE = '/legacy-migration-api/purchase-source-plugin-context';
const RETIRED_MARKETING_ACTIVITY_CACHE_ROUTE = '/legacy-migration-api/marketing-activity-cache';
const COLLECTION_PRICING_DRAFT_ROUTE = '/collection-pricing-draft-api';
const COLLECTION_PRICING_DRAFT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const LOCAL_DATA_FILES = {
  'ozon-shop-settings': { directory: '分类缓存/01-店铺设置', fileName: 'ozon-shop-settings.json' },
  'sales-source-links': { directory: '分类缓存/05-销售订单', fileName: 'sales-source-links.json' },
  'product-material-profiles': { directory: '商品资料', fileName: 'product-material-profiles.json' },
  'product-source-links': { directory: '商品资料', fileName: 'product-source-links.json' },
  'purchase-source-links': { directory: '分类缓存/07-拍单采购', fileName: 'purchase-source-links.json' },
  'purchase-order-local-overrides': { directory: '商品资料', fileName: 'purchase-order-local-overrides.json' },
  'cross-border-bus-order-records': { directory: '商品资料', fileName: 'cross-border-bus-order-records.json' },
};
// FROZEN-FOR-REMOVAL: keep the closed registry as account-removal/audit
// evidence only.  Generic business JSON reads and writes are no longer an
// executable persistence path; local-api + SQLite is canonical.
const FROZEN_LEGACY_LOCAL_DATA_FILE_KEYS = new Set(Object.keys(LOCAL_DATA_FILES));
const RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE = {
  directory: '分类缓存/07-拍单采购',
  fileName: 'purchase-source-plugin-context.json',
};
const RETIRED_MARKETING_ACTIVITY_CACHE_FILE = {
  directory: '分类缓存/12-营销活动',
  fileName: 'marketing-activity-cache.json',
};
const COLLECTION_PRICING_DRAFT_FILE = {
  directory: '分类缓存/17-采集核价',
  fileName: 'collection-pricing-draft.json',
};
// Legacy file storage is kept only for small UI/settings files. Business cache must go through local-api + SQLite.
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const ATOMIC_WRITE_MAX_ATTEMPTS = 6;
const ATOMIC_WRITE_RETRY_BASE_MS = 80;
const writeQueues = new Map();

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, options = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        rejected = true;
        const error = new Error('Body too large');
        error.code = 'LOCAL_DATA_BODY_TOO_LARGE';
        reject(error);
        if (options.destroyOnBodyTooLarge !== false) req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

async function readDataFile(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function getRawDataRevision(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Keep the exact on-disk bytes for migration CAS.  A parsed/deep-equal object
 * is deliberately insufficient: another process may have reformatted or
 * replaced the legacy payload after SQLite readback.
 */
async function readRetiredMarketingActivityCacheFile(filePath) {
  try {
    const raw = await fs.readFile(filePath);
    const text = raw.toString('utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('Retired marketing activity cache must be an object');
      error.code = 'LEGACY_MARKETING_INVALID_DATA';
      throw error;
    }
    return {
      exists: true,
      data: parsed,
      revision: getRawDataRevision(raw),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        data: {},
        revision: getRawDataRevision(Buffer.alloc(0)),
      };
    }
    throw error;
  }
}

function isExpectedRetiredMarketingRevision(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function emptyCollectionPricingDraft() {
  return { schemaVersion: 1, savedAt: '', items: [] };
}

function isCollectionPricingDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !Array.isArray(value.items)) return false;
  if (value.items.length > 100 || (value.savedAt && typeof value.savedAt !== 'string')) return false;
  return value.items.every((item) => (
    item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    item.id.length <= 300 &&
    (item.sourceUrl == null || (typeof item.sourceUrl === 'string' && item.sourceUrl.length <= 3000)) &&
    (item.title == null || (typeof item.title === 'string' && item.title.length <= 1200)) &&
    (!Array.isArray(item.skus) || item.skus.length <= 800) &&
    (!Array.isArray(item.mainImages) || item.mainImages.length <= 60) &&
    (!Array.isArray(item.skuImages) || item.skuImages.length <= 800) &&
    (!Array.isArray(item.detailImages) || item.detailImages.length <= 300) &&
    (!Array.isArray(item.images) || item.images.length <= 1200)
  ));
}

export async function writeDataFile(directory, filePath, data) {
  await fs.mkdir(directory, { recursive: true });
  const tempFilePath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    await fs.writeFile(tempFilePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    for (let attempt = 1; attempt <= ATOMIC_WRITE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await fs.rename(tempFilePath, filePath);
        return;
      } catch (error) {
        const canRetry = ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
        if (!canRetry || attempt >= ATOMIC_WRITE_MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => {
          setTimeout(resolve, ATOMIC_WRITE_RETRY_BASE_MS * attempt);
        });
      }
    }
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function queueDataFileWrite(filePath, writeTask) {
  const previousWrite = writeQueues.get(filePath) ?? Promise.resolve();
  const currentWrite = previousWrite.catch(() => undefined).then(writeTask);
  const queueTail = currentWrite
    .catch(() => undefined)
    .then(() => {
      if (writeQueues.get(filePath) === queueTail) {
        writeQueues.delete(filePath);
      }
    });
  writeQueues.set(filePath, queueTail);
  return currentWrite;
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
      data.migratedAt.length <= 80
  );
}

export default function localDataPlugin(options = {}) {
  const dataRootDirectory = path.resolve(options.dataRootDirectory || path.resolve(process.cwd(), '..', '本地数据'));

  return {
    name: 'wangzai-local-data',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith(COLLECTION_PRICING_DRAFT_ROUTE)) {
          const dataDirectory = path.join(dataRootDirectory, COLLECTION_PRICING_DRAFT_FILE.directory);
          const filePath = path.join(dataDirectory, COLLECTION_PRICING_DRAFT_FILE.fileName);
          try {
            if (req.method === 'GET') {
              const data = await readDataFile(filePath);
              if (!Object.keys(data).length) {
                sendJson(res, 200, { ok: true, data: emptyCollectionPricingDraft() });
                return;
              }
              if (!isCollectionPricingDraft(data)) {
                sendJson(res, 422, { ok: false, code: 'COLLECTION_PRICING_DRAFT_INVALID' });
                return;
              }
              sendJson(res, 200, { ok: true, data });
              return;
            }
            if (req.method === 'PUT') {
              const data = await readJsonBody(req, COLLECTION_PRICING_DRAFT_MAX_BODY_BYTES, { destroyOnBodyTooLarge: false });
              if (!isCollectionPricingDraft(data)) {
                sendJson(res, 400, { ok: false, code: 'COLLECTION_PRICING_DRAFT_INVALID' });
                return;
              }
              await queueDataFileWrite(filePath, async () => {
                await writeDataFile(dataDirectory, filePath, data);
                const readback = await readDataFile(filePath);
                if (JSON.stringify(readback) !== JSON.stringify(data)) throw new Error('Collection pricing draft readback mismatch');
              });
              sendJson(res, 200, { ok: true, data: { savedAt: data.savedAt, itemCount: data.items.length } });
              return;
            }
            sendJson(res, 405, { ok: false, message: 'Method not allowed' });
            return;
          } catch (error) {
            sendJson(res, error?.code === 'LOCAL_DATA_BODY_TOO_LARGE' ? 413 : 500, {
              ok: false,
              code: error?.code === 'LOCAL_DATA_BODY_TOO_LARGE'
                ? 'COLLECTION_PRICING_DRAFT_TOO_LARGE'
                : 'COLLECTION_PRICING_DRAFT_WRITE_FAILED',
            });
            return;
          }
        }
        if (req.url?.startsWith(RETIRED_MARKETING_ACTIVITY_CACHE_ROUTE)) {
          const dataDirectory = path.join(dataRootDirectory, RETIRED_MARKETING_ACTIVITY_CACHE_FILE.directory);
          const filePath = path.join(dataDirectory, RETIRED_MARKETING_ACTIVITY_CACHE_FILE.fileName);
          try {
            if (req.method === 'GET') {
              const legacy = await readRetiredMarketingActivityCacheFile(filePath);
              sendJson(res, 200, { ok: true, ...legacy });
              return;
            }
            if (req.method === 'PUT') {
              const request = await readJsonBody(req, DEFAULT_MAX_BODY_BYTES);
              if (!request || typeof request !== 'object' || Array.isArray(request) || !isExpectedRetiredMarketingRevision(request.expectedRevision)) {
                sendJson(res, 400, { ok: false, message: 'Invalid retired marketing activity cache expected revision' });
                return;
              }
              const cleanup = await queueDataFileWrite(filePath, async () => {
                const current = await readRetiredMarketingActivityCacheFile(filePath);
                if (current.revision !== request.expectedRevision) {
                  return { conflict: true, current };
                }
                // A successful transition is deletion, not an empty JSON
                // replacement.  This proves the generic old source is gone.
                if (current.exists) await fs.rm(filePath, { force: false });
                const readback = await readRetiredMarketingActivityCacheFile(filePath);
                return { conflict: false, current, readback };
              });
              if (cleanup.conflict) {
                sendJson(res, 409, {
                  ok: false,
                  code: 'LEGACY_SOURCE_CHANGED',
                  message: 'Retired marketing activity cache changed before conditional removal',
                });
                return;
              }
              if (cleanup.readback.exists || Object.keys(cleanup.readback.data).length) {
                sendJson(res, 500, { ok: false, message: 'Retired marketing activity cache was not removed' });
                return;
              }
              sendJson(res, 200, {
                ok: true,
                data: {},
                revision: cleanup.readback.revision,
                exists: false,
              });
              return;
            }
            sendJson(res, 405, { ok: false, message: 'Method not allowed' });
            return;
          } catch (error) {
            sendJson(res, error?.code === 'LOCAL_DATA_BODY_TOO_LARGE' ? 413 : 500, {
              ok: false,
              message: 'Retired marketing activity cache migration failed',
            });
            return;
          }
        }
        if (req.url?.startsWith(RETIRED_PURCHASE_PLUGIN_CONTEXT_ROUTE)) {
          const dataDirectory = path.join(dataRootDirectory, RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE.directory);
          const filePath = path.join(dataDirectory, RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE.fileName);
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, data: await readDataFile(filePath) });
              return;
            }
            if (req.method === 'PUT') {
              const marker = await readJsonBody(req, DEFAULT_MAX_BODY_BYTES);
              if (!isRetiredPurchasePluginContextMarker(marker)) {
                sendJson(res, 400, { ok: false, message: 'Invalid retired purchase plugin context marker' });
                return;
              }
              await queueDataFileWrite(filePath, () => writeDataFile(dataDirectory, filePath, marker));
              sendJson(res, 200, { ok: true, data: {} });
              return;
            }
            sendJson(res, 405, { ok: false, message: 'Method not allowed' });
            return;
          } catch (error) {
            sendJson(res, error?.code === 'LOCAL_DATA_BODY_TOO_LARGE' ? 413 : 500, {
              ok: false,
              message: 'Retired purchase plugin context migration failed',
            });
            return;
          }
        }
        if (!req.url?.startsWith(LOCAL_DATA_ROUTE_PREFIX)) {
          next();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const key = decodeURIComponent(url.pathname.slice(LOCAL_DATA_ROUTE_PREFIX.length).split('/')[0] || '');
        if (key === 'marketing-activity-cache') {
          sendJson(res, 410, { ok: false, message: 'Retired marketing activity cache is migration-only.' });
          return;
        }
        if (key === 'purchase-source-plugin-context') {
          sendJson(res, 410, { ok: false, message: 'Retired purchase plugin context is migration-only.' });
          return;
        }
        if (FROZEN_LEGACY_LOCAL_DATA_FILE_KEYS.has(key)) {
          sendJson(res, 410, { ok: false, message: 'Legacy JSON business storage is frozen; use local-api SQLite.' });
          return;
        }
        const fileConfig = LOCAL_DATA_FILES[key];
        if (!fileConfig) {
          sendJson(res, 404, { ok: false, message: 'Not found' });
          return;
        }

        const dataDirectory = path.join(dataRootDirectory, fileConfig.directory);
        const filePath = path.join(dataDirectory, fileConfig.fileName);

        try {
          if (req.method === 'GET') {
            const data = await readDataFile(filePath);
            sendJson(res, 200, { ok: true, data });
            return;
          }

          if (req.method === 'PUT' || req.method === 'POST') {
            const data = await readJsonBody(req, fileConfig.maxBodyBytes || DEFAULT_MAX_BODY_BYTES, {
              destroyOnBodyTooLarge: fileConfig.returnJsonOnBodyTooLarge !== true,
            });
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
              sendJson(res, 400, { ok: false, message: 'Invalid data' });
              return;
            }
            await queueDataFileWrite(filePath, () => writeDataFile(dataDirectory, filePath, data));
            sendJson(res, 200, { ok: true });
            return;
          }

          sendJson(res, 405, { ok: false, message: 'Method not allowed' });
        } catch (error) {
          if (error?.code === 'LOCAL_DATA_BODY_TOO_LARGE' && fileConfig.returnJsonOnBodyTooLarge === true) {
            sendJson(res, 413, {
              ok: false,
              message: 'Local data body too large',
            });
            return;
          }
          sendJson(res, 500, {
            ok: false,
            message: `Local data write failed: ${error?.code || 'unknown'}`,
          });
        }
      });
    },
  };
}

import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isImageGenerationModel } from '../modelApi/modelApiCapabilities.js';
import {
  APPROVED_IMAGE_API_BASE_URL,
  APPROVED_IMAGE_MODEL_ID,
  isApprovedImageProvider,
} from '../modelApi/imageGenerationProviderPolicy.js';
import { validateProductImageBuffer } from './productImageValidation.js';
import { renderProductImagePromptTemplate } from './productImagePromptTemplate.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_IMAGE_SIZE = '1008x1344';
const DEFAULT_IMAGE_QUALITY = 'high';
const DEFAULT_IMAGE_DOWNLOAD_ATTEMPTS = 3;
const DEFAULT_IMAGE_DOWNLOAD_RETRY_DELAY_MS = 300;
const DEFAULT_THUMBNAIL_READ_ATTEMPTS = 2;
const DEFAULT_THUMBNAIL_RETRY_DELAY_MS = 180;
const MAX_PREVIEW_BATCH_SIZE = 50;
const text = (value) => value == null ? '' : String(value).trim();
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isPrivateAddress(address) {
  if (!address || address === '::1' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  if (!isIP(address)) return true;
  if (address.includes(':')) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

async function assertPublicHttpsUrl(rawUrl, options = {}) {
  const url = new URL(text(rawUrl));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('图片地址必须是无账号信息的 HTTPS 地址。');
  const lookupImpl = options.lookupImpl || lookup;
  const results = await lookupImpl(url.hostname, { all: true });
  if (!results.length || results.some((item) => isPrivateAddress(item.address))) throw new Error('图片地址不能指向本机或内网。');
  return url;
}

function shouldRetryImageDownloadStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestImageDownload(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_IMAGE_DOWNLOAD_ATTEMPTS;
  const retryDelayMs = Number.isFinite(Number(options.retryDelayMs)) && Number(options.retryDelayMs) >= 0
    ? Number(options.retryDelayMs)
    : DEFAULT_IMAGE_DOWNLOAD_RETRY_DELAY_MS;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (!shouldRetryImageDownloadStatus(response.status) || attempt === maxAttempts) return response;
      await response.body?.cancel?.().catch?.(() => {});
      lastError = new Error(`图片读取失败：HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
    await wait(retryDelayMs * attempt);
  }
  const message = text(lastError?.message) || '未知网络错误';
  throw new Error(`图片读取失败：网络错误（已重试 ${Math.max(0, maxAttempts - 1)} 次）：${message}`, {
    cause: lastError,
  });
}

async function downloadImage(rawUrl, options = {}) {
  const redirects = Number(options.redirects) || 0;
  if (redirects > 3) throw new Error('图片地址重定向次数过多。');
  const url = await assertPublicHttpsUrl(rawUrl, options);
  const response = await requestImageDownload(url, options);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('图片重定向缺少目标地址。');
    return downloadImage(new URL(location, url).toString(), { ...options, redirects: redirects + 1 });
  }
  if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
  const mimeType = text(response.headers.get('content-type')).split(';')[0].toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error('只支持 PNG、JPEG 或 WebP 图片。');
  const declaredSize = Number(response.headers.get('content-length')) || 0;
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error('图片超过 10MB。');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.byteLength > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 10MB。');
  return { data, mimeType, finalUrl: url.toString() };
}

function decodeImageBody(input = {}) {
  const raw = text(input.dataBase64 || input.data_base64);
  const match = raw.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/u);
  const mimeType = match ? match[1] : text(input.mimeType || input.mime_type).toLowerCase();
  const base64 = match ? match[2] : raw;
  if (!ALLOWED_MIME_TYPES.has(mimeType) || !base64) throw new Error('本地图片格式无效。');
  const data = Buffer.from(base64, 'base64');
  if (!data.length || data.byteLength > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 10MB。');
  return { data, mimeType };
}

function decodeProviderImagePayload(payload = {}) {
  const first = Array.isArray(payload?.data) ? payload.data[0] || {} : payload?.data || payload;
  const providerUrl = text(first?.url || payload?.url);
  const encoded = text(first?.b64_json || first?.base64 || payload?.b64_json || payload?.base64);
  if (encoded) {
    const dataBase64 = encoded.startsWith('data:image/') ? encoded : `data:image/png;base64,${encoded}`;
    return { image: decodeImageBody({ dataBase64 }), providerUrl, deliveryMode: 'inline-base64' };
  }
  return { image: null, providerUrl, deliveryMode: providerUrl ? 'remote-url' : 'missing' };
}

function safeEqual(left, right) {
  const a = Buffer.from(text(left));
  const b = Buffer.from(text(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeModelCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    accountId: text(item?.accountId || item?.account_id),
    model: text(item?.model || item?.modelId || item?.model_id),
  })).filter((item) => item.accountId && item.model).slice(0, 20);
}

export function resolveProductImageModelSelection({ modelSelection = {}, fallbackAccountId = '', modelApiAccountRepository, randomIndex = (length) => randomInt(length) } = {}) {
  const mode = text(modelSelection?.mode).toLowerCase() === 'random' ? 'random' : 'fixed';
  const candidates = normalizeModelCandidates(modelSelection?.candidates).map((candidate) => {
    const account = modelApiAccountRepository?.getAccountForInternalUse(candidate.accountId);
    if (account?.discoveryVerified !== true || !account?.apiKey || !account.baseUrl) return null;
    const discovered = Array.isArray(account.availableModels)
      ? account.availableModels.find((item) => text(item.id) === candidate.model)
      : null;
    if (account.availableModels?.length && !discovered) return null;
    if (!isImageGenerationModel(discovered || { id: candidate.model })) return null;
    if (!isApprovedImageProvider(account, candidate.model)) return null;
    return { account, model: candidate.model };
  }).filter(Boolean);
  if (candidates.length) {
    const rawIndex = mode === 'random' && candidates.length > 1 ? randomIndex(candidates.length) : 0;
    const index = Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < candidates.length ? rawIndex : 0;
    return { ...candidates[index], mode, candidateCount: candidates.length };
  }
  const account = modelApiAccountRepository?.getAccountForInternalUse(fallbackAccountId || undefined);
  const model = text(account?.defaultModel) || APPROVED_IMAGE_MODEL_ID;
  if (account?.discoveryVerified !== true || !account?.apiKey || !account.baseUrl) return null;
  const discovered = account.availableModels?.find((item) => text(item.id) === model);
  if ((account.availableModels?.length && !discovered) || !isImageGenerationModel(discovered || { id: model })) return null;
  if (!isApprovedImageProvider(account, model)) return null;
  return { account, model, mode: 'fixed', candidateCount: 1 };
}

export function createProductImageAssetService({
  profileAssetRepository,
  productImageAssetRepository = null,
  modelApiAccountRepository,
  objectStorage = null,
  uploadCoordinator = null,
  config,
  fetchImpl = globalThis.fetch,
  dnsLookup = lookup,
} = {}) {
  const imageConfig = config?.imageAssets || {};
  const publicBaseUrl = text(imageConfig.publicBaseUrl).replace(/\/$/u, '');
  const signingSecret = text(imageConfig.signingSecret);
  const previewTtlSeconds = Number(imageConfig.previewUrlTtlSeconds || objectStorage?.previewUrlTtlSeconds || 900);
  const ozonTtlSeconds = Number(imageConfig.ozonUrlTtlSeconds || objectStorage?.ozonUrlTtlSeconds || 86_400);
  const temporaryRetentionSeconds = Number(imageConfig.temporaryRetentionSeconds || 7 * 24 * 60 * 60);
  const deletionRetryDelaySeconds = Number(imageConfig.lifecycle?.retryDelaySeconds || 300);
  const imageDownloadOptions = {
    fetchImpl,
    lookupImpl: dnsLookup,
    maxAttempts: Number(imageConfig.downloadMaxAttempts) || DEFAULT_IMAGE_DOWNLOAD_ATTEMPTS,
    retryDelayMs: Number.isFinite(Number(imageConfig.downloadRetryDelayMs))
      ? Number(imageConfig.downloadRetryDelayMs)
      : DEFAULT_IMAGE_DOWNLOAD_RETRY_DELAY_MS,
  };
  const imagePersistenceTasks = new Map();
  const thumbnailBufferCache = new Map();
  const thumbnailBufferCacheLimit = 240;
  const thumbnailCacheVersion = 'v3';
  const imageTaskRetentionMs = 30 * 60 * 1000;
  let lifecycleStatusProvider = null;
  let provenanceProtector = null;
  const pricing = {
    storageGbMonthCny: Number(imageConfig.storageGbMonthCny || 0.12),
    egressGbCny: Number(imageConfig.egressGbCny || 0.5),
    requestsPerTenThousandCny: Number(imageConfig.requestsPerTenThousandCny || 0.01),
    monthlyBudgetCny: Number(imageConfig.monthlyBudgetCny || 100),
  };

  const scopeOf = (context = {}) => ({
    tenantId: text(context.tenantId || productImageAssetRepository?.defaults?.tenantId || 'tenant_local_default'),
    userId: text(context.userId || productImageAssetRepository?.defaults?.userId || 'user_local_default'),
    shopId: text(context.shopId) || 'shop-unbound',
  });
  const sameScope = (left = {}, right = {}) => left.tenantId === right.tenantId
    && left.userId === right.userId
    && left.shopId === right.shopId;
  const pruneImageTasks = () => {
    const cutoff = Date.now() - imageTaskRetentionMs;
    for (const [taskId, task] of imagePersistenceTasks) {
      if (task.updatedAtMs < cutoff) imagePersistenceTasks.delete(taskId);
    }
  };
  const sign = (assetId, expiresAt) => signingSecret.length < 32 ? '' : createHmac('sha256', signingSecret).update(`${assetId}:${expiresAt}`).digest('hex');
  const buildPublicUrl = (assetId, ttlSeconds = ozonTtlSeconds) => {
    if (!publicBaseUrl.startsWith('https://') || signingSecret.length < 32) return '';
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${publicBaseUrl}/public/product-images/${encodeURIComponent(assetId)}?expires=${expiresAt}&signature=${sign(assetId, expiresAt)}`;
  };
  const recordUsage = (operation, asset, scope, detail = {}, status = 'ok') => productImageAssetRepository?.recordUsage?.({
    assetId: asset?.id, operation, byteLength: Number(asset?.byteLength || 0), requestCount: 1, status, detail,
  }, scope);
  const presentAsset = (asset, extra = {}) => {
    if (!asset) return null;
    const { previewProviderUrl = '', thumbnailProviderUrl = '', ...publicExtra } = extra;
    const storageScope = extra.storageScope || asset.storageScope || 'temporary';
    const localUrl = `/api/product-images/preview/${encodeURIComponent(asset.id)}?shopId=${encodeURIComponent(asset.shopId || 'shop-unbound')}`;
    const objectKey = text(asset.objectKey || extra.objectKey);
    const thumbnailUrl = objectKey && objectStorage?.configured
      ? `/api/product-images/assets/${encodeURIComponent(asset.id)}/thumbnail?shopId=${encodeURIComponent(asset.shopId || 'shop-unbound')}&v=${thumbnailCacheVersion}`
      : text(thumbnailProviderUrl);
    const legacyUrl = storageScope === 'permanent' ? buildPublicUrl(asset.profileAssetId || asset.id) : '';
    const ozonUrl = text(extra.ozonUrl || legacyUrl);
    return { ...asset, ...publicExtra, localUrl, previewUrl: text(previewProviderUrl) || localUrl,
      thumbnailUrl, publicUrl: legacyUrl, ozonUrl,
      ozonReady: storageScope === 'permanent' && Boolean(ozonUrl), storageScope };
  };

  const createThumbnailUrl = (objectKey) => objectKey
    && objectStorage?.configured
    && typeof objectStorage.createSignedThumbnailUrl === 'function'
    ? objectStorage.createSignedThumbnailUrl(objectKey, previewTtlSeconds)
    : '';

  const createOzonUrl = (objectKey) => {
    if (!objectKey || !objectStorage?.configured) return '';
    if (typeof objectStorage.createSignedOzonReadUrl === 'function') {
      return objectStorage.createSignedOzonReadUrl(objectKey, ozonTtlSeconds);
    }
    return objectStorage.createSignedReadUrl(objectKey, ozonTtlSeconds);
  };

  function scopedThumbnailCacheKey(asset, scope) {
    return `${scope.tenantId}::${scope.userId}::${scope.shopId}::${asset.id}`;
  }

  function rememberThumbnail(cacheKey, value) {
    thumbnailBufferCache.delete(cacheKey);
    thumbnailBufferCache.set(cacheKey, value);
    while (thumbnailBufferCache.size > thumbnailBufferCacheLimit) {
      thumbnailBufferCache.delete(thumbnailBufferCache.keys().next().value);
    }
    return value;
  }

  async function loadAssetThumbnail(asset, scope) {
    const cacheKey = scopedThumbnailCacheKey(asset, scope);
    const cached = thumbnailBufferCache.get(cacheKey);
    if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached);
    if (!asset.objectKey || !objectStorage?.configured || typeof objectStorage.getThumbnail !== 'function') return null;
    const pending = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= DEFAULT_THUMBNAIL_READ_ATTEMPTS; attempt += 1) {
        try {
          const result = await objectStorage.getThumbnail(asset.objectKey, { width: 320, quality: 85 });
          const data = Buffer.isBuffer(result?.data) ? result.data : Buffer.from(result?.data || []);
          if (!data.length) throw new Error('OSS 缩略图为空。');
          return {
            data,
            mimeType: text(result?.mimeType) || 'image/webp',
            byteLength: data.byteLength,
          };
        } catch (error) {
          lastError = error;
          if (attempt < DEFAULT_THUMBNAIL_READ_ATTEMPTS) await wait(DEFAULT_THUMBNAIL_RETRY_DELAY_MS * attempt);
        }
      }
      throw lastError || new Error('OSS 缩略图读取失败。');
    })()
      .then((result) => {
        return rememberThumbnail(cacheKey, result);
      })
      .catch((error) => {
        thumbnailBufferCache.delete(cacheKey);
        throw error;
      });
    thumbnailBufferCache.set(cacheKey, pending);
    return pending;
  }

  async function executeUpload(input) {
    const execute = async () => uploadCoordinator?.withRetry
      ? uploadCoordinator.withRetry((attempt) => objectStorage.putImage({ ...input, uploadAttempt: attempt }))
      : { value: await objectStorage.putImage(input), attempts: 1 };
    return uploadCoordinator?.run
      ? uploadCoordinator.run({ scope: input.scope, bytes: input.data.byteLength, execute })
      : execute();
  }

  async function saveBuffer({ data, mimeType }, extra = {}, context = {}) {
    const scope = scopeOf(context);
    const inspected = validateProductImageBuffer({ data, mimeType });
    const profileSaved = profileAssetRepository.saveAsset({ mimeType, dataBase64: data.toString('base64') });
    const storageScope = extra.storageScope === 'permanent' ? 'permanent' : 'temporary';
    const expiresAt = storageScope === 'temporary' ? new Date(Date.now() + temporaryRetentionSeconds * 1000).toISOString() : null;
    const pending = productImageAssetRepository?.upsertPending?.({
      profileAssetId: profileSaved.asset.id, ...inspected, storageScope,
      variant: extra.variant || extra.sourceType || 'original', sourceType: extra.sourceType || 'unknown',
      sourceUrl: extra.sourceUrl || '', productId: extra.productId || '', offerId: extra.offerId || '', expiresAt,
    }, scope);
    let asset = pending?.asset || { ...profileSaved.asset, profileAssetId: profileSaved.asset.id, storageScope };
    if (!objectStorage?.configured) return { ok: true, created: Boolean(pending?.created ?? profileSaved.created), asset: presentAsset(asset, extra) };
    if ((asset.status === 'stored' || asset.status === 'published') && asset.objectKey) {
      const previewProviderUrl = objectStorage.createSignedReadUrl(asset.objectKey, previewTtlSeconds);
      const thumbnailProviderUrl = createThumbnailUrl(asset.objectKey);
      const ozonUrl = storageScope === 'permanent' ? createOzonUrl(asset.objectKey) : '';
      // Warm the generic thumbnail cache while the asset is already known. This
      // runs for every product/asset and never delays the save response.
      void loadAssetThumbnail(asset, scope).catch(() => {});
      recordUsage('signed_preview', asset, scope, { ttlSeconds: previewTtlSeconds });
      if (ozonUrl) recordUsage('signed_ozon', asset, scope, { ttlSeconds: ozonTtlSeconds });
      return { ok: true, created: false, reused: true, asset: presentAsset(asset, {
        ...extra, previewProviderUrl, thumbnailProviderUrl, previewUrlExpiresInSeconds: previewTtlSeconds,
        thumbnailUrlExpiresInSeconds: thumbnailProviderUrl ? previewTtlSeconds : 0, ozonUrl,
      }) };
    }
    try {
      const uploaded = await executeUpload({ data, mimeType, assetId: asset.id, tenantId: scope.tenantId, shopId: scope.shopId,
        variant: extra.variant || extra.sourceType || 'original', storageScope, scope });
      const stored = uploaded.value;
      asset = productImageAssetRepository?.markStored?.(asset.id, { objectKey: stored.objectKey, etag: stored.etag,
        requestId: stored.requestId, uploadAttempts: uploaded.attempts, expiresAt }, scope)
        || { ...asset, objectKey: stored.objectKey, objectEtag: stored.etag, objectRequestId: stored.requestId, status: 'stored' };
      recordUsage('upload', asset, scope, { attempts: uploaded.attempts, storageScope });
      const previewProviderUrl = stored.previewUrl || objectStorage.createSignedReadUrl(stored.objectKey, previewTtlSeconds);
      const thumbnailProviderUrl = stored.thumbnailUrl || createThumbnailUrl(stored.objectKey);
      const ozonUrl = storageScope === 'permanent'
        ? stored.ozonUrl || createOzonUrl(stored.objectKey) : '';
      // Pre-build OSS WebP thumbnails as soon as persistence finishes. Later
      // editor/history opens then hit memory or Chromium cache instead of the
      // multi-megabyte original image.
      void loadAssetThumbnail(asset, scope).catch(() => {});
      recordUsage('signed_preview', asset, scope, { ttlSeconds: previewTtlSeconds });
      if (ozonUrl) recordUsage('signed_ozon', asset, scope, { ttlSeconds: ozonTtlSeconds });
      return { ok: true, created: Boolean(pending?.created ?? profileSaved.created), asset: presentAsset(asset, {
        ...extra, previewProviderUrl, thumbnailProviderUrl, ozonUrl, objectKey: stored.objectKey, objectEtag: stored.etag,
        objectRequestId: stored.requestId, previewUrlExpiresInSeconds: stored.previewExpiresInSeconds || previewTtlSeconds,
        thumbnailUrlExpiresInSeconds: stored.thumbnailExpiresInSeconds || (thumbnailProviderUrl ? previewTtlSeconds : 0),
        ozonUrlExpiresInSeconds: storageScope === 'permanent' ? stored.ozonExpiresInSeconds || ozonTtlSeconds : 0,
      }) };
    } catch (error) {
      productImageAssetRepository?.markFailed?.(asset.id, error, Number(error?.attempts || 1), scope);
      productImageAssetRepository?.recordUsage?.({ assetId: asset.id, operation: 'upload', byteLength: asset.byteLength,
        requestCount: Number(error?.attempts || 1), status: 'failed', detail: { message: text(error?.message).slice(0, 300), storageScope } }, scope);
      throw error;
    }
  }

  function startRemotePersistence({ providerUrl, providerElapsedMs, extra = {}, context = {} }) {
    pruneImageTasks();
    const scope = scopeOf(context);
    const taskId = `pimg_task_${randomUUID()}`;
    const task = {
      id: taskId,
      status: 'pending',
      scope,
      providerUrl,
      providerElapsedMs,
      createdAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
      result: null,
      error: null,
    };
    imagePersistenceTasks.set(taskId, task);
    void (async () => {
      const deliveryStartedAt = Date.now();
      try {
        const generated = await downloadImage(providerUrl, imageDownloadOptions);
        const deliveryElapsedMs = Date.now() - deliveryStartedAt;
        const persistenceStartedAt = Date.now();
        const saved = await saveBuffer(generated, { ...extra, sourceUrl: providerUrl }, context);
        task.status = 'completed';
        task.result = {
          ...saved,
          delivery: {
            mode: 'remote-url-background',
            providerElapsedMs,
            deliveryElapsedMs,
            persistenceElapsedMs: Date.now() - persistenceStartedAt,
          },
        };
      } catch (error) {
        task.status = 'failed';
        task.error = {
          code: text(error?.code) || 'PRODUCT_IMAGE_BACKGROUND_PERSIST_FAILED',
          message: text(error?.message) || '图片后台保存失败。',
        };
      } finally {
        task.updatedAtMs = Date.now();
      }
    })();
    return {
      ok: true,
      pending: true,
      taskId,
      task: { id: taskId, status: 'pending', providerUrl, createdAt: task.createdAt },
      asset: {
        id: '',
        status: 'persisting',
        storageScope: 'temporary',
        previewUrl: providerUrl,
        sourceUrl: providerUrl,
      },
      delivery: {
        mode: 'remote-url-immediate',
        providerElapsedMs,
        deliveryElapsedMs: 0,
        persistenceElapsedMs: 0,
      },
    };
  }

  function readPersistenceTask(taskId, context = {}) {
    pruneImageTasks();
    const task = imagePersistenceTasks.get(text(taskId));
    if (!task || !sameScope(task.scope, scopeOf(context))) return null;
    return {
      ok: true,
      task: {
        id: task.id,
        status: task.status,
        providerUrl: task.providerUrl,
        createdAt: task.createdAt,
        result: task.result,
        error: task.error,
      },
    };
  }

  async function importImage(input = {}, context = {}) {
    const permanentRequested = input.storageScope === 'permanent';
    // Permanent images are the bytes Ozon can eventually read. Stage them as
    // temporary first so the provenance protector can create the verified
    // watermarked derivative before any permanent OSS object is exposed.
    const storageScope = permanentRequested && provenanceProtector ? 'temporary'
      : permanentRequested ? 'permanent' : 'temporary';
    const extra = { sourceType: text(input.sourceType) || 'local', storageScope, variant: input.variant || 'original',
      productId: input.productId, offerId: input.offerId };
    let saved;
    if (input.sourceUrl || input.source_url) {
      const downloaded = await downloadImage(input.sourceUrl || input.source_url, imageDownloadOptions);
      saved = await saveBuffer(downloaded, {
        ...extra,
        sourceType: text(input.sourceType) || 'remote',
        sourceUrl: downloaded.finalUrl,
      }, context);
    } else {
      saved = await saveBuffer(decodeImageBody(input), extra, context);
    }
    if (!permanentRequested || !provenanceProtector) return saved;
    const stagedAssetId = text(saved?.asset?.id || saved?.asset?.assetId);
    if (!stagedAssetId) {
      const error = new Error('图片没有完成临时保存，已阻止未加暗水印的图片进入 Ozon。');
      error.code = 'PRODUCT_IMAGE_PROVENANCE_STAGE_MISSING';
      throw error;
    }
    return promoteAsset({
      ...input,
      assetId: stagedAssetId,
      storageScope: 'permanent',
    }, context);
  }

  async function readAssetBuffer(assetId, context = {}) {
    const scope = scopeOf(context);
    let metadata = null;
    if (productImageAssetRepository && text(assetId).startsWith('pimg_')) metadata = productImageAssetRepository.getAsset(assetId, scope);
    else if (productImageAssetRepository) metadata = productImageAssetRepository.findByProfileAssetId(assetId, scope);
    // A known owner-scoped repository must authorize the blob too. Falling
    // through to the global content-addressed profile store bypasses shop scope.
    if (productImageAssetRepository && !metadata) return null;
    if (metadata && (metadata.status === 'deleted' || Number(metadata.referenceCount || 0) <= 0)) return null;
    const profileId = metadata?.profileAssetId || text(assetId);
    const local = profileAssetRepository.getAsset(profileId, { includeData: true });
    if (local?.dataBase64) return { metadata, data: Buffer.from(local.dataBase64, 'base64'), mimeType: local.mimeType };
    if (metadata?.objectKey && objectStorage?.getImage) {
      const remote = await objectStorage.getImage(metadata.objectKey);
      return { metadata, data: remote.data, mimeType: remote.mimeType || metadata.mimeType };
    }
    return null;
  }

  async function promoteAsset(input = {}, context = {}) {
    const assetId = text(input.assetId || input.id);
    if (!assetId) throw new Error('缺少要提交的图片。');
    const originalSource = await readAssetBuffer(assetId, context);
    let source = originalSource;
    let protectedAssetId = text(originalSource?.metadata?.id);
    let provenance = null;
    const alreadyProtected = text(originalSource?.metadata?.variant) === 'provenance-watermarked';
    if (source?.data && provenanceProtector && !alreadyProtected) {
      provenance = await provenanceProtector({
        sourceAssetId: text(originalSource?.metadata?.id || assetId),
        sourceType: text(input.sourceType) || 'product-submit',
        productId: input.productId,
        offerId: input.offerId,
      }, context);
      protectedAssetId = text(
        provenance?.publicationAsset?.id
        || provenance?.publicationAsset?.assetId
        || provenance?.asset?.id
        || provenance?.asset?.assetId,
      );
      if (!protectedAssetId) {
        const error = new Error('图片暗水印证据没有完成，已阻止未加暗水印的图片进入 Ozon。');
        error.code = 'PRODUCT_IMAGE_PROVENANCE_REQUIRED';
        throw error;
      }
      source = await readAssetBuffer(protectedAssetId, context);
    }
    if (!source?.data) throw new Error('本地图片资产不存在。');
    const protectedVariant = text(source.metadata?.variant) === 'provenance-watermarked';
    const promoted = await saveBuffer(source, { sourceType: text(input.sourceType) || 'product-submit', sourceAssetId: source.metadata?.id || assetId,
      sourceUrl: source.metadata?.sourceUrl || '', storageScope: 'permanent',
      variant: protectedVariant ? 'provenance-watermarked' : text(input.variant) || source.metadata?.variant || 'original',
      productId: input.productId, offerId: input.offerId }, context);
    if (source.metadata?.storageScope === 'temporary' && source.metadata.id !== promoted?.asset?.id) {
      promoted.sourceCleanup = await releaseAsset({ assetId: source.metadata.id, reason: 'promoted' }, context);
    }
    if (originalSource?.metadata?.storageScope === 'temporary'
      && originalSource.metadata.id !== source.metadata?.id
      && originalSource.metadata.id !== promoted?.asset?.id) {
      promoted.originalSourceCleanup = await releaseAsset({
        assetId: originalSource.metadata.id,
        reason: 'provenance-protected',
      }, context);
    }
    return {
      ...promoted,
      provenanceProtected: alreadyProtected || Boolean(provenance),
      provenanceJobId: text(provenance?.job?.id || provenance?.id),
      originalSourceAssetId: text(originalSource?.metadata?.id || assetId),
      protectedSourceAssetId: text(source.metadata?.id || protectedAssetId),
    };
  }

  function selectModel(input) {
    const selection = resolveProductImageModelSelection({ modelSelection: input.modelSelection, fallbackAccountId: input.accountId, modelApiAccountRepository });
    if (!selection?.account?.apiKey) {
      throw new Error(`图片生成只允许 ${APPROVED_IMAGE_API_BASE_URL} 的 ${APPROVED_IMAGE_MODEL_ID}，请先保存该接口 API Key。`);
    }
    const baseUrl = text(selection.account.baseUrl).replace(/\/$/u, '');
    if (!baseUrl.startsWith('https://')) throw new Error('图片中转站地址无效。');
    return { ...selection, baseUrl };
  }

  async function editImage(input = {}, context = {}) {
    const prompt = renderProductImagePromptTemplate(input);
    if (!prompt) throw new Error('请填写图片编辑要求。');
    let source = input.assetId ? await readAssetBuffer(input.assetId, context)
      : input.sourceUrl ? await downloadImage(input.sourceUrl, imageDownloadOptions) : decodeImageBody(input);
    if (!source) throw new Error('本地图片资产不存在。');
    let sourceAssetId = text(input.assetId);
    let sourceAsset = null;
    if (!sourceAssetId) {
      sourceAsset = await saveBuffer(
        source,
        { sourceType: 'edit-original', storageScope: 'temporary', variant: 'original' },
        context,
      );
      sourceAssetId = sourceAsset.asset.id;
    }
    const selection = resolveProductImageModelSelection({
      modelSelection: input.modelSelection,
      fallbackAccountId: input.accountId,
      modelApiAccountRepository,
    });
    if (!selection) {
      throw new Error(`图片编辑只允许 ${APPROVED_IMAGE_API_BASE_URL} 的 ${APPROVED_IMAGE_MODEL_ID}，不会回退到其他图片服务。`);
    }
    const baseUrl = text(selection.account.baseUrl).replace(/\/$/u, '');
    if (!baseUrl.startsWith('https://')) throw new Error('图片中转站地址无效。');
    const form = new FormData();
    form.set('model', selection.model); form.set('prompt', prompt); form.set('response_format', 'url');
    form.set('size', text(input.size) || DEFAULT_IMAGE_SIZE);
    form.set('quality', text(input.quality) || text(selection.account.quality) || DEFAULT_IMAGE_QUALITY);
    if (selection.account.style) form.set('style', selection.account.style);
    if (selection.account.upscale) form.set('upscale', selection.account.upscale);
    form.set('image', new Blob([source.data], { type: source.mimeType }), `product.${source.mimeType.split('/')[1]}`);
    const providerStartedAt = Date.now();
    const response = await fetchImpl(`${baseUrl}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${selection.account.apiKey}` },
      body: form, signal: AbortSignal.timeout(120_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `图片编辑失败：HTTP ${response.status}`);
    const providerElapsedMs = Date.now() - providerStartedAt;
    const decoded = decodeProviderImagePayload(payload);
    if (!decoded.image && !decoded.providerUrl) throw new Error('图片服务未返回图片地址或图片内容。');
    const extra = { sourceType: 'image2-edit', sourceAssetId, storageScope: 'temporary',
      variant: text(input.variant) || 'edited', modelSelection: { mode: selection.mode,
        accountId: selection.account.id, model: selection.model, candidateCount: selection.candidateCount } };
    if (!decoded.image) return startRemotePersistence({ providerUrl: decoded.providerUrl, providerElapsedMs, extra, context });
    const persistenceStartedAt = Date.now();
    const saved = await saveBuffer(decoded.image, { ...extra, sourceUrl: decoded.providerUrl }, context);
    return { ...saved, delivery: { mode: decoded.deliveryMode, providerElapsedMs,
      deliveryElapsedMs: 0, persistenceElapsedMs: Date.now() - persistenceStartedAt } };
  }

  async function generateImage(input = {}, context = {}) {
    const prompt = renderProductImagePromptTemplate(input);
    if (!prompt) throw new Error('请填写生图提示词。');
    const selection = resolveProductImageModelSelection({
      modelSelection: input.modelSelection,
      fallbackAccountId: input.accountId,
      modelApiAccountRepository,
    });
    if (!selection) {
      throw new Error(`图片生成只允许 ${APPROVED_IMAGE_API_BASE_URL} 的 ${APPROVED_IMAGE_MODEL_ID}，不会回退到其他图片服务。`);
    }
    const baseUrl = text(selection.account.baseUrl).replace(/\/$/u, '');
    if (!baseUrl.startsWith('https://')) throw new Error('图片中转站地址无效。');
    const body = { model: selection.model, prompt, n: 1, response_format: 'url',
      size: text(input.size) || DEFAULT_IMAGE_SIZE, quality: text(input.quality) || text(selection.account.quality) || DEFAULT_IMAGE_QUALITY };
    if (text(selection.account.style)) body.style = selection.account.style;
    const providerStartedAt = Date.now();
    const response = await fetchImpl(`${baseUrl}/images/generations`, { method: 'POST',
      headers: { Authorization: `Bearer ${selection.account.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `图片生成失败：HTTP ${response.status}`);
    const providerElapsedMs = Date.now() - providerStartedAt;
    const decoded = decodeProviderImagePayload(payload);
    if (!decoded.image && !decoded.providerUrl) throw new Error('图片中转站没有返回图片地址或图片内容。');
    const extra = { sourceType: 'image2-generation', storageScope: 'temporary',
      variant: text(input.variant) || 'generated', modelSelection: { mode: selection.mode, accountId: selection.account.id,
        model: selection.model, candidateCount: selection.candidateCount } };
    if (!decoded.image) return startRemotePersistence({ providerUrl: decoded.providerUrl, providerElapsedMs, extra, context });
    const persistenceStartedAt = Date.now();
    const saved = await saveBuffer(decoded.image, { ...extra, sourceUrl: decoded.providerUrl }, context);
    return { ...saved, delivery: { mode: decoded.deliveryMode, providerElapsedMs,
      deliveryElapsedMs: 0, persistenceElapsedMs: Date.now() - persistenceStartedAt } };
  }

  function readPublicAsset(assetId, query = {}) {
    const expiresAt = Number(query.expires);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000) || !safeEqual(query.signature, sign(assetId, expiresAt))) return null;
    return profileAssetRepository.getAsset(assetId, { includeData: true });
  }
  async function readLocalAsset(assetId, context = {}) {
    const resolved = await readAssetBuffer(assetId, context);
    return resolved?.data ? { id: text(assetId), mimeType: resolved.mimeType, byteLength: resolved.data.byteLength, dataBase64: resolved.data.toString('base64') } : null;
  }
  function readAssetPreview(assetId, context = {}) {
    const scope = scopeOf(context);
    const normalizedAssetId = text(assetId);
    const asset = normalizedAssetId.startsWith('pimg_')
      ? productImageAssetRepository?.getAsset?.(normalizedAssetId, scope)
      : productImageAssetRepository?.findByProfileAssetId?.(normalizedAssetId, scope);
    if (!asset || asset.status === 'deleted') return null;
    const previewUrl = asset.objectKey
      && objectStorage?.configured
      && typeof objectStorage.createSignedReadUrl === 'function'
      ? objectStorage.createSignedReadUrl(asset.objectKey, previewTtlSeconds)
      : '';
    const thumbnailUrl = asset.objectKey && objectStorage?.configured
      ? `/api/product-images/assets/${encodeURIComponent(asset.id)}/thumbnail?shopId=${encodeURIComponent(scope.shopId)}&v=${thumbnailCacheVersion}`
      : '';
    if (thumbnailUrl) void loadAssetThumbnail(asset, scope).catch(() => {});
    if (previewUrl) recordUsage('signed_preview', asset, scope, {
      ttlSeconds: previewTtlSeconds,
      reason: 'collection-history-read',
    });
    return {
      id: asset.id,
      previewUrl,
      thumbnailUrl,
      previewUrlExpiresInSeconds: previewUrl ? previewTtlSeconds : 0,
      thumbnailUrlExpiresInSeconds: thumbnailUrl ? previewTtlSeconds : 0,
      storageScope: asset.storageScope,
      status: asset.status,
    };
  }

  async function readAssetThumbnail(assetId, context = {}) {
    const scope = scopeOf(context);
    const normalizedAssetId = text(assetId);
    const asset = normalizedAssetId.startsWith('pimg_')
      ? productImageAssetRepository?.getAsset?.(normalizedAssetId, scope)
      : productImageAssetRepository?.findByProfileAssetId?.(normalizedAssetId, scope);
    if (!asset || asset.status === 'deleted') return null;
    const thumbnail = await loadAssetThumbnail(asset, scope);
    if (thumbnail) recordUsage('thumbnail_read', asset, scope, { byteLength: thumbnail.byteLength });
    return thumbnail ? { id: asset.id, ...thumbnail } : null;
  }

  function readAssetPreviews(input = {}, context = {}) {
    const assetIds = [...new Set((Array.isArray(input.assetIds) ? input.assetIds : [])
      .map((assetId) => text(assetId))
      .filter(Boolean))];
    if (!assetIds.length) return { ok: true, assets: [], missingAssetIds: [] };
    if (assetIds.length > MAX_PREVIEW_BATCH_SIZE) {
      const error = new Error(`一次最多读取 ${MAX_PREVIEW_BATCH_SIZE} 张历史图片。`);
      error.code = 'PRODUCT_IMAGE_PREVIEW_BATCH_TOO_LARGE';
      error.statusCode = 413;
      throw error;
    }
    const assets = [];
    const missingAssetIds = [];
    assetIds.forEach((assetId) => {
      const asset = readAssetPreview(assetId, context);
      if (asset) assets.push(asset);
      else missingAssetIds.push(assetId);
    });
    return { ok: true, assets, missingAssetIds };
  }
  async function releaseAsset(input = {}, context = {}) {
    const scope = scopeOf(context);
    const assetId = text(input.assetId || input.id);
    const asset = productImageAssetRepository?.getAsset?.(assetId, scope);
    if (!asset) throw new Error('图片资产不存在。');
    if (asset.status === 'published') return { ok: true, retained: true, reason: 'published', asset: presentAsset(asset) };
    const released = productImageAssetRepository.beginRelease(assetId, scope, { reason: input.reason || 'released' });
    if (!released.queuedForDeletion) return { ok: true, retained: true, assetId, asset: released.asset };
    return deleteQueuedAsset(released.asset, scope);
  }

  async function deleteQueuedAsset(asset, scopeInput = {}) {
    const scope = scopeOf(scopeInput);
    const current = productImageAssetRepository.getAsset(asset.id, scope);
    if (!current || current.status === 'deleted' || current.status === 'published') {
      return { ok: true, retained: true, skipped: true, assetId: asset.id };
    }
    const expiredTemporary = current.storageScope === 'temporary'
      && current.expiresAt
      && new Date(current.expiresAt).getTime() <= Date.now();
    if (Number(current.referenceCount || 0) > 0 && !expiredTemporary) {
      return { ok: true, retained: true, skipped: true, assetId: current.id };
    }
    asset = current;
    try {
      if (asset.objectKey) {
        if (!objectStorage?.configured || typeof objectStorage.deleteImage !== 'function') {
          throw new Error('PRODUCT_IMAGE_OBJECT_STORAGE_DELETE_UNAVAILABLE');
        }
        await objectStorage.deleteImage(asset.objectKey);
      }
      const deleted = productImageAssetRepository.markDeleted(asset.id, scope);
      if (deleted.profileAssetId) profileAssetRepository.deleteAssetIfUnreferenced?.(deleted.profileAssetId);
      recordUsage('delete', asset, scope, { objectKey: asset.objectKey || '', reason: asset.lastError || 'cleanup' });
      return { ok: true, retained: false, deleted: true, assetId: asset.id };
    } catch (error) {
      productImageAssetRepository.markDeleteFailed(asset.id, error, scope);
      productImageAssetRepository.recordUsage?.({ assetId: asset.id, operation: 'delete', byteLength: asset.byteLength,
        requestCount: 1, status: 'failed', detail: { message: text(error?.message).slice(0, 300) } }, scope);
      return { ok: true, retained: true, cleanupPending: true, assetId: asset.id,
        error: { code: 'PRODUCT_IMAGE_DELETE_RETRY_QUEUED', message: '图片远端删除失败，已保留账本并进入重试队列。' } };
    }
  }

  async function cleanupExpiredAssets(optionsInput = {}) {
    const candidates = productImageAssetRepository?.listDeletionCandidates?.({
      now: optionsInput.now,
      limit: optionsInput.limit,
      retryDelaySeconds: optionsInput.retryDelaySeconds ?? deletionRetryDelaySeconds,
    }) || [];
    const summary = { ok: true, scanned: candidates.length, deleted: 0, failed: 0, pending: 0, assetIds: [] };
    for (const asset of candidates) {
      const result = await deleteQueuedAsset(asset, asset);
      summary.assetIds.push(asset.id);
      if (result.deleted) summary.deleted += 1;
      else if (!result.skipped) {
        summary.failed += 1;
        summary.pending += 1;
      }
    }
    return summary;
  }

  async function refreshProductWritePayloadUrls(payload = {}, context = {}) {
    const scope = scopeOf(context);
    if (!objectStorage?.configured || typeof objectStorage.createSignedReadUrl !== 'function') return payload;
    const clone = typeof structuredClone === 'function'
      ? structuredClone(payload)
      : JSON.parse(JSON.stringify(payload));
    const visit = (value) => {
      if (typeof value === 'string') {
        if (!/^https:\/\//iu.test(value)) {
          if (/^[\[{]/u.test(value.trim())) {
            try { return JSON.stringify(visit(JSON.parse(value))); } catch { return value; }
          }
          return value;
        }
        let objectKey = '';
        try { objectKey = decodeURIComponent(new URL(value).pathname.replace(/^\/+/, '')); } catch { return value; }
        const asset = productImageAssetRepository.findAssetByObjectKey?.(objectKey, scope);
        if (!asset) return value;
        const refreshed = createOzonUrl(asset.objectKey);
        recordUsage('signed_ozon', asset, scope, { ttlSeconds: ozonTtlSeconds, reason: 'pre-submit-refresh' });
        return refreshed || value;
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
      }
      return value;
    };
    return visit(clone);
  }
  function getUsageStatus(context = {}) {
    const scope = scopeOf(context);
    const usage = productImageAssetRepository?.getUsageSummary?.(scope) || { scope, day: {}, month: {}, retained: {} };
    const gb = (bytes) => Number(bytes || 0) / (1024 ** 3);
    const estimatedMonthlyCostCny = Number((gb(usage.retained.bytes) * pricing.storageGbMonthCny
      + gb(usage.month.estimated_egress_bytes) * pricing.egressGbCny
      + Number(usage.month.requests || 0) / 10_000 * pricing.requestsPerTenThousandCny).toFixed(4));
    const budgetUsedPercent = pricing.monthlyBudgetCny > 0
      ? Number((estimatedMonthlyCostCny / pricing.monthlyBudgetCny * 100).toFixed(2))
      : 0;
    return { ok: true, usage, estimatedMonthlyCostCny, monthlyBudgetCny: pricing.monthlyBudgetCny,
      budgetUsedPercent, budgetWarning: budgetUsedPercent >= 80, budgetExceeded: budgetUsedPercent >= 100,
      pricing, queue: uploadCoordinator?.getStatus?.() || null,
      lifecycle: lifecycleStatusProvider?.() || null };
  }
  const getStatus = (context = {}) => ({ ok: true, configured: Boolean(objectStorage?.configured), scope: scopeOf(context),
    previewUrlTtlSeconds: previewTtlSeconds, ozonUrlTtlSeconds: ozonTtlSeconds, temporaryRetentionSeconds, queue: uploadCoordinator?.getStatus?.() || null,
    lifecycle: lifecycleStatusProvider?.() || null });
  const setLifecycleStatusProvider = (provider) => { lifecycleStatusProvider = typeof provider === 'function' ? provider : null; };
  const setProvenanceProtector = (provider) => { provenanceProtector = typeof provider === 'function' ? provider : null; };

  return { importImage, editImage, generateImage, promoteAsset, releaseAsset, cleanupExpiredAssets,
    refreshProductWritePayloadUrls, readPublicAsset, readLocalAsset, readAssetPreview, readAssetPreviews, readAssetThumbnail,
    readPersistenceTask, buildPublicUrl, getUsageStatus, getStatus,
    setLifecycleStatusProvider, setProvenanceProtector };
}

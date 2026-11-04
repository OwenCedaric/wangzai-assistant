import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DEFAULT_TEMPORARY_PREFIX = 'wangzai/temp/';
const DEFAULT_PERMANENT_PREFIX = 'wangzai/assets/';
const DEFAULT_PREVIEW_TTL_SECONDS = 15 * 60;
const DEFAULT_OZON_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_THUMBNAIL_WIDTH = 320;
const DEFAULT_THUMBNAIL_QUALITY = 85;
const DEFAULT_ACCELERATE_ENDPOINT = 'https://oss-accelerate.aliyuncs.com';
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ACCELERATION_FALLBACK_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePrefix(value, fallback = DEFAULT_TEMPORARY_PREFIX) {
  const normalized = normalizeText(value || fallback).replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized.includes('..')) throw new Error('OSS object prefix is invalid.');
  return `${normalized}/`;
}

function safeSegment(value, fallback) {
  const normalized = normalizeText(value)
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 96);
  return normalized || fallback;
}

function extensionForMimeType(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  throw new Error('OSS product image MIME type is not allowed.');
}

function thumbnailProcess(options = {}) {
  const width = Math.min(1280, normalizePositiveInteger(options.width, DEFAULT_THUMBNAIL_WIDTH));
  const quality = Math.min(95, normalizePositiveInteger(options.quality, DEFAULT_THUMBNAIL_QUALITY));
  return `image/resize,m_lfit,w_${width},h_${width}/format,webp/quality,q_${quality}`;
}

export function readAliyunOssProductImageConfig(env = process.env) {
  const region = normalizeText(env.ALIYUN_OSS_REGION);
  const bucket = normalizeText(env.ALIYUN_OSS_BUCKET);
  const endpoint = normalizeText(env.ALIYUN_OSS_ENDPOINT);
  const accessKeyId = normalizeText(env.ALIYUN_OSS_ACCESS_KEY_ID);
  const accessKeySecret = normalizeText(env.ALIYUN_OSS_ACCESS_KEY_SECRET);
  const accelerationEnabled = ['1', 'true', 'yes', 'on'].includes(
    normalizeText(env.ALIYUN_OSS_ACCELERATION_ENABLED).toLowerCase(),
  );
  const accelerateEndpoint = accelerationEnabled
    ? normalizeText(env.ALIYUN_OSS_ACCELERATE_ENDPOINT) || DEFAULT_ACCELERATE_ENDPOINT
    : '';
  const configured = Boolean(region && bucket && endpoint && accessKeyId && accessKeySecret);
  return {
    configured,
    region,
    bucket,
    endpoint,
    accelerationEnabled,
    accelerateEndpoint,
    accessKeyId,
    accessKeySecret,
    temporaryPrefix: normalizePrefix(env.ALIYUN_OSS_PREFIX, DEFAULT_TEMPORARY_PREFIX),
    permanentPrefix: normalizePrefix(env.ALIYUN_OSS_PERMANENT_PREFIX, DEFAULT_PERMANENT_PREFIX),
    previewUrlTtlSeconds: normalizePositiveInteger(
      env.ALIYUN_OSS_PREVIEW_URL_TTL_SECONDS,
      DEFAULT_PREVIEW_TTL_SECONDS,
    ),
    ozonUrlTtlSeconds: normalizePositiveInteger(
      env.ALIYUN_OSS_OZON_URL_TTL_SECONDS || env.ALIYUN_OSS_SIGNED_URL_TTL_SECONDS,
      DEFAULT_OZON_TTL_SECONDS,
    ),
  };
}

export function buildProductImageObjectKey({
  prefix = DEFAULT_TEMPORARY_PREFIX,
  tenantId,
  shopId,
  assetId,
  variant = 'original',
  mimeType,
  now = new Date(),
} = {}) {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error('OSS product image MIME type is not allowed.');
  const stableAssetId = safeSegment(assetId, 'asset');
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return [
    normalizePrefix(prefix),
    'images/',
    `${safeSegment(tenantId, 'tenant-local')}/`,
    `${safeSegment(shopId, 'shop-unbound')}/`,
    `${year}/${month}/`,
    `${stableAssetId}/`,
    `${safeSegment(variant, 'original')}.${extensionForMimeType(mimeType)}`,
  ].join('');
}

export function createAliyunOssProductImageStorage({
  config,
  Client = null,
  now = () => new Date(),
} = {}) {
  if (!config?.configured) return null;
  // 正式安装包不能携带共享 OSS 密钥，未配置时必须能正常启动。开发机或
  // 受控服务端明确配置 OSS 后，才加载 SDK；这样可选依赖不会拖垮整个本地 API。
  const ClientConstructor = Client || (() => {
    const dependency = require('ali-oss');
    return dependency.default || dependency;
  })();
  const clientOptions = {
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    secure: true,
    timeout: 30_000,
  };
  const standardClient = new ClientConstructor({ ...clientOptions, endpoint: config.endpoint });
  const acceleratedClient = config.accelerationEnabled && config.accelerateEndpoint
    ? new ClientConstructor({ ...clientOptions, endpoint: config.accelerateEndpoint })
    : null;
  const client = acceleratedClient || standardClient;

  function shouldFallbackFromAcceleration(error) {
    if (!acceleratedClient || client === standardClient) return false;
    const status = Number(error?.status || error?.statusCode || 0);
    const code = normalizeText(error?.code || error?.name).toLowerCase();
    const message = normalizeText(error?.message).toLowerCase();
    return ACCELERATION_FALLBACK_STATUSES.has(status)
      || ['connectiontimeouterror', 'responsetimeouterror', 'requesttimeouterror', 'econnreset', 'etimedout'].some(
        (token) => code.includes(token),
      )
      || message.includes('transfer acceleration is not configured')
      || message.includes('socket hang up');
  }

  async function withAccelerationFallback(operation) {
    try {
      return await operation(client);
    } catch (error) {
      if (!shouldFallbackFromAcceleration(error)) throw error;
      return operation(standardClient);
    }
  }

  function assertManagedObjectKey(objectKey) {
    const normalizedKey = normalizeText(objectKey);
    if (![config.temporaryPrefix, config.permanentPrefix].some((prefix) => normalizedKey.startsWith(prefix))) {
      throw new Error('OSS object key is outside the configured prefixes.');
    }
    return normalizedKey;
  }

  function createSignedReadUrl(objectKey, ttlSeconds = config.previewUrlTtlSeconds, options = {}) {
    const normalizedKey = assertManagedObjectKey(objectKey);
    const normalizedTtlSeconds = normalizePositiveInteger(ttlSeconds, config.previewUrlTtlSeconds);
    const cacheMaxAgeSeconds = Math.max(30, Math.min(
      normalizePositiveInteger(options.cacheMaxAgeSeconds, Math.min(10 * 60, normalizedTtlSeconds)),
      Math.max(30, normalizedTtlSeconds - 30),
    ));
    return client.signatureUrl(normalizedKey, {
      expires: normalizedTtlSeconds,
      method: 'GET',
      ...(normalizeText(options.process) ? { process: normalizeText(options.process) } : {}),
      response: {
        'cache-control': `private, max-age=${cacheMaxAgeSeconds}`,
      },
    });
  }

  function createSignedStandardReadUrl(objectKey, ttlSeconds = config.previewUrlTtlSeconds, options = {}) {
    const normalizedKey = assertManagedObjectKey(objectKey);
    const normalizedTtlSeconds = normalizePositiveInteger(ttlSeconds, config.previewUrlTtlSeconds);
    const cacheMaxAgeSeconds = Math.max(30, Math.min(
      normalizePositiveInteger(options.cacheMaxAgeSeconds, Math.min(10 * 60, normalizedTtlSeconds)),
      Math.max(30, normalizedTtlSeconds - 30),
    ));
    return standardClient.signatureUrl(normalizedKey, {
      expires: normalizedTtlSeconds,
      method: 'GET',
      ...(normalizeText(options.process) ? { process: normalizeText(options.process) } : {}),
      response: {
        'cache-control': `private, max-age=${cacheMaxAgeSeconds}`,
      },
    });
  }

  function createSignedThumbnailUrl(objectKey, ttlSeconds = config.previewUrlTtlSeconds, options = {}) {
    return createSignedReadUrl(objectKey, ttlSeconds, {
      cacheMaxAgeSeconds: options.cacheMaxAgeSeconds,
      process: thumbnailProcess(options),
    });
  }

  function createSignedOzonReadUrl(objectKey, ttlSeconds = config.ozonUrlTtlSeconds, options = {}) {
    return createSignedStandardReadUrl(objectKey, ttlSeconds, options);
  }

  async function putImage({ data, mimeType, assetId, tenantId, shopId, variant, storageScope = 'temporary' } = {}) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('OSS product image data is empty.');
    if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error('OSS product image MIME type is not allowed.');
    const objectKey = buildProductImageObjectKey({
      prefix: storageScope === 'permanent' ? config.permanentPrefix : config.temporaryPrefix,
      tenantId,
      shopId,
      assetId,
      variant,
      mimeType,
      now: now(),
    });
    const result = await withAccelerationFallback((activeClient) => activeClient.put(objectKey, data, {
      mime: mimeType,
      headers: {
        'Cache-Control': 'private, max-age=0, no-store',
        'x-oss-server-side-encryption': 'AES256',
      },
    }));
    return {
      objectKey,
      etag: normalizeText(result?.res?.headers?.etag).replace(/^"|"$/gu, ''),
      requestId: normalizeText(result?.res?.headers?.['x-oss-request-id']),
      previewUrl: createSignedReadUrl(objectKey, config.previewUrlTtlSeconds),
      thumbnailUrl: createSignedThumbnailUrl(objectKey, config.previewUrlTtlSeconds),
      ozonUrl: storageScope === 'permanent'
        ? createSignedStandardReadUrl(objectKey, config.ozonUrlTtlSeconds)
        : '',
      previewExpiresInSeconds: config.previewUrlTtlSeconds,
      thumbnailExpiresInSeconds: config.previewUrlTtlSeconds,
      ozonExpiresInSeconds: storageScope === 'permanent' ? config.ozonUrlTtlSeconds : 0,
    };
  }

  async function getImage(objectKey) {
    const normalizedKey = assertManagedObjectKey(objectKey);
    const result = await withAccelerationFallback((activeClient) => activeClient.get(normalizedKey));
    return {
      data: Buffer.isBuffer(result?.content) ? result.content : Buffer.from(result?.content || []),
      mimeType: normalizeText(result?.res?.headers?.['content-type']),
      requestId: normalizeText(result?.res?.headers?.['x-oss-request-id']),
    };
  }

  async function getThumbnail(objectKey, options = {}) {
    const normalizedKey = assertManagedObjectKey(objectKey);
    const result = await withAccelerationFallback(
      (activeClient) => activeClient.get(normalizedKey, { process: thumbnailProcess(options) }),
    );
    return {
      data: Buffer.isBuffer(result?.content) ? result.content : Buffer.from(result?.content || []),
      mimeType: 'image/webp',
      requestId: normalizeText(result?.res?.headers?.['x-oss-request-id']),
    };
  }

  async function deleteImage(objectKey) {
    const normalizedKey = assertManagedObjectKey(objectKey);
    await withAccelerationFallback((activeClient) => activeClient.delete(normalizedKey));
    return { ok: true, objectKey: normalizedKey };
  }

  return {
    configured: true,
    bucket: config.bucket,
    region: config.region,
    accelerationEnabled: Boolean(acceleratedClient),
    endpoint: config.accelerateEndpoint || config.endpoint,
    fallbackEndpoint: acceleratedClient ? config.endpoint : '',
    temporaryPrefix: config.temporaryPrefix,
    permanentPrefix: config.permanentPrefix,
    // Compatibility alias for older health checks. New code must choose an
    // explicit storage scope instead of assuming every object is temporary.
    prefix: config.temporaryPrefix,
    previewUrlTtlSeconds: config.previewUrlTtlSeconds,
    ozonUrlTtlSeconds: config.ozonUrlTtlSeconds,
    putImage,
    getImage,
    getThumbnail,
    deleteImage,
    createSignedReadUrl,
    createSignedStandardReadUrl,
    createSignedOzonReadUrl,
    createSignedThumbnailUrl,
  };
}

export function createAliyunOssProductImageStorageFromEnvironment(env = process.env, options = {}) {
  return createAliyunOssProductImageStorage({
    ...options,
    config: readAliyunOssProductImageConfig(env),
  });
}

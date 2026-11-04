import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  createProductImageAssetService,
  resolveProductImageModelSelection,
} from './productImageAssetService.js';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createProfileAssetRepository } from '../../db/repositories/profileAssetRepository.js';
import { createProductImageAssetRepository } from '../../db/repositories/productImageAssetRepository.js';
import { createProductImageUploadCoordinator } from './productImageUploadCoordinator.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64',
);

function createAssetRepository() {
  const rows = new Map();
  return {
    saveAsset(input) {
      const id = `asset_${rows.size + 1}`;
      const asset = {
        id,
        mimeType: input.mimeType,
        dataBase64: input.dataBase64,
        byteLength: Buffer.from(input.dataBase64, 'base64').byteLength,
      };
      rows.set(id, asset);
      return { ok: true, created: true, asset: { ...asset, dataBase64: undefined } };
    },
    getAsset(id, options = {}) {
      const asset = rows.get(id);
      if (!asset) return null;
      return options.includeData ? { ...asset } : { ...asset, dataBase64: undefined };
    },
  };
}

test('a profile blob identifier cannot bypass product image owner scope or released metadata', async t => {
  const db = createMigratedTestDb();
  t.after(() => db.close());
  const profileAssets = createProfileAssetRepository(db);
  const assets = createProductImageAssetRepository(db);
  const source = profileAssets.saveAsset({ mimeType: 'image/png', dataBase64: ONE_PIXEL_PNG.toString('base64') }).asset;
  const scopeA = { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' };
  const scopeB = { ...scopeA, shopId: 'shop-b' };
  assets.upsertPending({ profileAssetId: source.id, sha256: source.sha256, mimeType: source.mimeType, byteLength: source.byteLength }, scopeA);
  const service = createProductImageAssetService({ profileAssetRepository: profileAssets, productImageAssetRepository: assets });
  assert.ok((await service.readLocalAsset(source.id, scopeA))?.dataBase64);
  assert.equal(await service.readLocalAsset(source.id, scopeB), null);
  assert.equal(await service.readLocalAsset(source.id, { ...scopeA, userId: 'user-b' }), null);
  db.prepare('UPDATE product_image_assets SET reference_count=0').run();
  assert.equal(await service.readLocalAsset(source.id, scopeA), null);
  assert.ok(profileAssets.getAsset(source.id), 'the physical blob remains present; access must still be denied');
});

test('permanent local product image import creates a signed public Ozon URL when server storage is public', async () => {
  const repository = createAssetRepository();
  const service = createProductImageAssetService({
    profileAssetRepository: repository,
    modelApiAccountRepository: { getAccountForInternalUse: () => null },
    config: {
      imageAssets: {
        publicBaseUrl: 'https://img.example.com',
        signingSecret: '12345678901234567890123456789012',
      },
    },
  });
  const result = await service.importImage({
    sourceType: 'local',
    storageScope: 'permanent',
    dataBase64: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.asset.ozonReady, true);
  assert.match(result.asset.localUrl, /\/api\/product-images\/preview\//u);
  assert.equal((await service.readLocalAsset(result.asset.id)).mimeType, 'image/png');
  const url = new URL(result.asset.ozonUrl);
  assert.equal(url.origin, 'https://img.example.com');
  const readback = service.readPublicAsset(result.asset.id, Object.fromEntries(url.searchParams));
  assert.equal(readback.id, result.asset.id);
});

test('local-only image asset never pretends it can be submitted to Ozon', async () => {
  const service = createProductImageAssetService({
    profileAssetRepository: createAssetRepository(),
    modelApiAccountRepository: { getAccountForInternalUse: () => null },
    config: { imageAssets: {} },
  });
  const result = await service.importImage({
    mimeType: 'image/png',
    dataBase64: ONE_PIXEL_PNG.toString('base64'),
  });
  assert.equal(result.asset.ozonReady, false);
  assert.equal(result.asset.ozonUrl, '');
});

test('retries transient HTTPS image downloads without repeating image generation POST requests', async () => {
  let calls = 0;
  const service = createProductImageAssetService({
    profileAssetRepository: createAssetRepository(),
    modelApiAccountRepository: { getAccountForInternalUse: () => null },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(ONE_PIXEL_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    },
    config: { imageAssets: { downloadRetryDelayMs: 0 } },
  });

  const result = await service.importImage({
    sourceUrl: 'https://1.1.1.1/product.png',
    sourceType: 'remote-test',
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.asset.mimeType, 'image/png');
});

test('configured object storage uploads the image and exposes only its signed URL', async () => {
  const uploads = [];
  const service = createProductImageAssetService({
    profileAssetRepository: createAssetRepository(),
    modelApiAccountRepository: { getAccountForInternalUse: () => null },
    objectStorage: {
      configured: true,
      previewUrlTtlSeconds: 900,
      ozonUrlTtlSeconds: 86400,
      createSignedReadUrl(key, ttl) { return `https://private.example/${key}?ttl=${ttl}`; },
      async putImage(input) {
        uploads.push(input);
        return {
          objectKey: 'wangzai/temp/images/tenant-a/shop-a/asset/generated.png',
          etag: 'etag-a',
          requestId: 'request-a',
          previewUrl: 'https://private.example/generated.png?preview=1',
          ozonUrl: input.storageScope === 'permanent' ? 'https://private.example/generated.png?ozon=1' : '',
          previewExpiresInSeconds: 900,
          ozonExpiresInSeconds: input.storageScope === 'permanent' ? 86400 : 0,
        };
      },
    },
    config: { imageAssets: {} },
  });
  const result = await service.importImage({
    mimeType: 'image/png',
    dataBase64: ONE_PIXEL_PNG.toString('base64'),
    storageScope: 'permanent',
    variant: 'generated',
  }, { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' });

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].tenantId, 'tenant-a');
  assert.equal(uploads[0].shopId, 'shop-a');
  assert.equal(result.asset.ozonReady, true);
  assert.equal(result.asset.ozonUrl, 'https://private.example/generated.png?ozon=1');
  assert.equal(result.asset.objectKey, 'wangzai/temp/images/tenant-a/shop-a/asset/generated.png');
});

test('permanent import exposes only the provenance-watermarked bytes to Ozon', async () => {
  const db = createMigratedTestDb();
  try {
    const scope = { tenantId: 'tenant-proof', userId: 'user-proof', shopId: 'shop-proof' };
    const uploads = [];
    const protectedPng = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#3164a8' },
    }).png().toBuffer();
    const service = createProductImageAssetService({
      profileAssetRepository: createProfileAssetRepository(db),
      productImageAssetRepository: createProductImageAssetRepository(db, {
        tenantId: scope.tenantId,
        userId: scope.userId,
      }),
      modelApiAccountRepository: { getAccountForInternalUse: () => null },
      objectStorage: {
        configured: true,
        createSignedReadUrl(key) { return `https://private.example/${key}?preview=1`; },
        createSignedOzonReadUrl(key) { return `https://private.example/${key}?ozon=1`; },
        async putImage(input) {
          uploads.push({ ...input, data: Buffer.from(input.data) });
          const prefix = input.storageScope === 'permanent' ? 'wangzai/assets' : 'wangzai/temp';
          return {
            objectKey: `${prefix}/${input.assetId}.png`,
            etag: `etag-${uploads.length}`,
            requestId: `request-${uploads.length}`,
          };
        },
      },
      config: { imageAssets: {} },
    });
    let protectionCalls = 0;
    service.setProvenanceProtector(async (input, context) => {
      protectionCalls += 1;
      assert.ok(input.sourceAssetId);
      const protectedAsset = await service.importImage({
        dataBase64: protectedPng.toString('base64'),
        mimeType: 'image/png',
        storageScope: 'temporary',
        variant: 'provenance-watermarked',
        sourceType: 'image-provenance-watermarked',
      }, context);
      return {
        job: { id: 'provenance-job-1' },
        publicationAsset: protectedAsset.asset,
      };
    });

    const result = await service.importImage({
      dataBase64: ONE_PIXEL_PNG.toString('base64'),
      mimeType: 'image/png',
      storageScope: 'permanent',
      variant: 'collection-listing',
      sourceType: 'collection-listing',
    }, scope);

    assert.equal(protectionCalls, 1);
    assert.equal(result.provenanceProtected, true);
    assert.equal(result.provenanceJobId, 'provenance-job-1');
    assert.equal(result.asset.storageScope, 'permanent');
    assert.equal(result.asset.variant, 'provenance-watermarked');
    assert.equal(result.asset.ozonReady, true);
    const permanentUploads = uploads.filter((item) => item.storageScope === 'permanent');
    assert.equal(permanentUploads.length, 1);
    assert.deepEqual(permanentUploads[0].data, protectedPng);
    assert.notDeepEqual(permanentUploads[0].data, ONE_PIXEL_PNG);
    assert.equal(permanentUploads[0].variant, 'provenance-watermarked');
  } finally {
    db.close();
  }
});

test('provenance failure blocks permanent image exposure', async () => {
  const db = createMigratedTestDb();
  try {
    const scope = { tenantId: 'tenant-block', userId: 'user-block', shopId: 'shop-block' };
    const uploads = [];
    const service = createProductImageAssetService({
      profileAssetRepository: createProfileAssetRepository(db),
      productImageAssetRepository: createProductImageAssetRepository(db, {
        tenantId: scope.tenantId,
        userId: scope.userId,
      }),
      modelApiAccountRepository: { getAccountForInternalUse: () => null },
      objectStorage: {
        configured: true,
        createSignedReadUrl(key) { return `https://private.example/${key}`; },
        async putImage(input) {
          uploads.push(input);
          return { objectKey: `wangzai/temp/${input.assetId}.png`, etag: 'etag', requestId: 'request' };
        },
      },
      config: { imageAssets: {} },
    });
    service.setProvenanceProtector(async () => {
      const error = new Error('watermark worker failed');
      error.code = 'IMAGE_PROVENANCE_FAILED';
      throw error;
    });

    await assert.rejects(
      () => service.importImage({
        dataBase64: ONE_PIXEL_PNG.toString('base64'),
        mimeType: 'image/png',
        storageScope: 'permanent',
      }, scope),
      (error) => error.code === 'IMAGE_PROVENANCE_FAILED',
    );
    assert.equal(uploads.filter((item) => item.storageScope === 'permanent').length, 0);
  } finally {
    db.close();
  }
});

test('image edit and generation never fall back when the approved API is missing', async () => {
  const db = createMigratedTestDb();
  try {
    const scope = { tenantId: 'tenant-paid', userId: 'user-paid', shopId: 'shop-paid' };
    const metadata = createProductImageAssetRepository(db, {
      tenantId: scope.tenantId,
      userId: scope.userId,
    });
    const paidCalls = [];
    let uploadIndex = 0;
    const service = createProductImageAssetService({
      profileAssetRepository: createProfileAssetRepository(db),
      productImageAssetRepository: metadata,
      modelApiAccountRepository: { getAccountForInternalUse: () => null },
      objectStorage: {
        configured: true,
        createSignedReadUrl(key, ttl) {
          return `https://accelerated-private-oss.example/${key}?ttl=${ttl}`;
        },
        createSignedStandardReadUrl(key, ttl) {
          return `https://regional-private-oss.example/${key}?ttl=${ttl}`;
        },
        async putImage(input) {
          uploadIndex += 1;
          const objectKey = `wangzai/temp/images/${input.shopId}/${input.assetId}/${uploadIndex}.png`;
          return {
            objectKey,
            etag: `etag-${uploadIndex}`,
            requestId: `request-${uploadIndex}`,
            previewUrl: `https://accelerated-private-oss.example/${objectKey}?signature=preview-${uploadIndex}`,
          };
        },
      },
      paidCapabilityAccess: {
        async execute(request) {
          paidCalls.push(request);
          return {
            chargedPoints: 53,
            result: { images: [{ b64Json: ONE_PIXEL_PNG.toString('base64') }] },
          };
        },
      },
      dnsLookup: async () => [{ address: '93.184.216.34' }],
      fetchImpl: async () => new Response(ONE_PIXEL_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
      config: { imageAssets: {} },
    });

    await assert.rejects(
      () => service.editImage({
        prompt: '保持眼镜结构并生成 Ozon 主图',
        sourceUrl: 'https://supplier.example/1688-source.png',
        accountId: 'builtin-points',
        modelSelection: { mode: 'fixed', candidates: [] },
      }, scope),
      /images\.example\.invalid\/v1/u,
    );
    await assert.rejects(
      () => service.generateImage({
        prompt: '生成 Ozon 商品主图',
        accountId: 'builtin-points',
        modelSelection: { mode: 'fixed', candidates: [] },
      }, scope),
      /images\.example\.invalid\/v1/u,
    );
    assert.equal(paidCalls.length, 0);
  } finally {
    db.close();
  }
});

test('processes twelve scoped images, then promotes only the selected shop assets', async () => {
  const db = createMigratedTestDb();
  try {
    const metadata = createProductImageAssetRepository(db, { tenantId: 'tenant-many', userId: 'user-many' });
    const coordinator = createProductImageUploadCoordinator({ repository: metadata, config: { maxConcurrent: 4, maxConcurrentPerOwner: 2 } });
    const uploads = [];
    const objectStorage = {
      configured: true, previewUrlTtlSeconds: 900, ozonUrlTtlSeconds: 86400,
      createSignedReadUrl(key, ttl) { return `https://bucket.example/${key}?ttl=${ttl}`; },
      async putImage(input) {
        uploads.push(input);
        const prefix = input.storageScope === 'permanent' ? 'wangzai/assets' : 'wangzai/temp';
        const objectKey = `${prefix}/images/${input.tenantId}/${input.shopId}/${input.assetId}/${input.variant}.png`;
        return { objectKey, etag: `etag-${uploads.length}`, requestId: `req-${uploads.length}`,
          previewUrl: `https://bucket.example/${objectKey}?preview=1`,
          ozonUrl: input.storageScope === 'permanent' ? `https://bucket.example/${objectKey}?ozon=1` : '' };
      },
    };
    const service = createProductImageAssetService({
      profileAssetRepository: createProfileAssetRepository(db), productImageAssetRepository: metadata,
      uploadCoordinator: coordinator, objectStorage, modelApiAccountRepository: { getAccountForInternalUse: () => null },
      config: { imageAssets: {} },
    });
    const contexts = ['shop-a', 'shop-b', 'shop-c'].flatMap((shopId) => Array.from({ length: 4 }, (_, index) => ({ shopId, index })));
    const imported = await Promise.all(contexts.map(({ shopId, index }) => service.importImage({
      mimeType: 'image/png', dataBase64: ONE_PIXEL_PNG.toString('base64'), variant: `slot-${index}`,
      tenantId: 'forged-tenant', userId: 'forged-user', shopId: 'forged-shop',
    }, { tenantId: 'tenant-many', userId: 'user-many', shopId })));
    assert.equal(imported.length, 12);
    assert.ok(imported.every((item) => item.asset.ozonReady === false));
    const shopA = imported.filter((_, index) => contexts[index].shopId === 'shop-a');
    const promoted = await Promise.all(shopA.map((item, index) => service.promoteAsset({
      assetId: item.asset.id, variant: `slot-${index}`, productId: 'product-a', offerId: 'offer-a',
    }, { tenantId: 'tenant-many', userId: 'user-many', shopId: 'shop-a' })));
    assert.equal(promoted.length, 4);
    assert.ok(promoted.every((item) => item.asset.ozonReady && item.asset.objectKey.startsWith('wangzai/assets/')));
    assert.equal(uploads.length, 16);
    assert.ok(uploads.every((item) => item.tenantId === 'tenant-many'));
    assert.ok(uploads.every((item) => item.shopId !== 'forged-shop'));
    await assert.rejects(
      () => service.promoteAsset({ assetId: shopA[0].asset.id }, { tenantId: 'tenant-many', userId: 'user-many', shopId: 'shop-b' }),
      (error) => error.code === 'PRODUCT_IMAGE_SCOPE_FORBIDDEN',
    );
  } finally {
    db.close();
  }
});

test('refreshes a shop-scoped private OSS preview without returning image bytes', async () => {
  const db = createMigratedTestDb();
  try {
    const scope = { tenantId: 'tenant-preview', userId: 'user-preview', shopId: 'shop-preview' };
    const metadata = createProductImageAssetRepository(db, scope);
    let thumbnailReads = 0;
    let thumbnailOptions = null;
    const objectStorage = {
      configured: true,
      createSignedReadUrl: (key, ttl) => `https://private.example/${key}?ttl=${ttl}&signature=fresh`,
      createSignedThumbnailUrl: (key, ttl) => `https://private.example/${key}?ttl=${ttl}&thumbnail=320`,
      async getThumbnail(_key, options) {
        thumbnailReads += 1;
        thumbnailOptions = options;
        if (thumbnailReads === 1) throw new Error('temporary OSS thumbnail transform failure');
        return { data: Buffer.from('tiny-webp'), mimeType: 'image/webp' };
      },
      async putImage(input) {
        return {
          objectKey: `wangzai/temp/images/${input.tenantId}/${input.shopId}/${input.assetId}.png`,
          etag: 'etag-preview',
          requestId: 'request-preview',
        };
      },
    };
    const service = createProductImageAssetService({
      profileAssetRepository: createProfileAssetRepository(db),
      productImageAssetRepository: metadata,
      objectStorage,
      modelApiAccountRepository: { getAccountForInternalUse: () => null },
      config: { imageAssets: { previewUrlTtlSeconds: 600 } },
    });
    const imported = await service.importImage({
      mimeType: 'image/png',
      dataBase64: ONE_PIXEL_PNG.toString('base64'),
      variant: 'history-preview',
    }, scope);
    const preview = service.readAssetPreview(imported.asset.id, scope);

    assert.equal(preview.id, imported.asset.id);
    assert.match(preview.previewUrl, /^https:\/\/private\.example\//u);
    assert.equal(preview.thumbnailUrl, `/api/product-images/assets/${encodeURIComponent(imported.asset.id)}/thumbnail?shopId=shop-preview&v=v3`);
    assert.equal(preview.previewUrlExpiresInSeconds, 600);
    assert.equal(preview.thumbnailUrlExpiresInSeconds, 600);
    assert.equal('dataBase64' in preview, false);
    const [firstThumbnail, secondThumbnail] = await Promise.all([
      service.readAssetThumbnail(imported.asset.id, scope),
      service.readAssetThumbnail(imported.asset.id, scope),
    ]);
    assert.equal(firstThumbnail.data.toString(), 'tiny-webp');
    assert.equal(secondThumbnail.data.toString(), 'tiny-webp');
    assert.equal(thumbnailReads, 2, 'a transient thumbnail transform failure should recover before the UI falls back');
    assert.deepEqual(thumbnailOptions, { width: 320, quality: 85 });
    const previewBatch = service.readAssetPreviews({
      assetIds: [imported.asset.id, 'missing-asset', imported.asset.id],
    }, scope);
    assert.deepEqual(previewBatch.assets.map((asset) => asset.id), [imported.asset.id]);
    assert.deepEqual(previewBatch.missingAssetIds, ['missing-asset']);
    assert.throws(
      () => service.readAssetPreview(imported.asset.id, { ...scope, shopId: 'shop-other' }),
      (error) => error.code === 'PRODUCT_IMAGE_SCOPE_FORBIDDEN',
    );
    assert.throws(
      () => service.readAssetPreviews({ assetIds: [imported.asset.id] }, { ...scope, shopId: 'shop-other' }),
      (error) => error.code === 'PRODUCT_IMAGE_SCOPE_FORBIDDEN',
    );
  } finally {
    db.close();
  }
});

test('keeps failed remote deletions in the ledger and removes them on a later cleanup retry', async () => {
  const db = createMigratedTestDb();
  try {
    const metadata = createProductImageAssetRepository(db, { tenantId: 'tenant-delete', userId: 'user-delete' });
    let failDelete = true;
    const deletedKeys = [];
    const objectStorage = {
      configured: true,
      createSignedReadUrl: (key, ttl) => `https://bucket.example/${key}?ttl=${ttl}`,
      async putImage(input) {
        return { objectKey: `wangzai/temp/images/${input.assetId}.png`, etag: 'etag', requestId: 'request' };
      },
      async deleteImage(key) {
        if (failDelete) throw new Error('temporary provider failure');
        deletedKeys.push(key);
      },
    };
    const service = createProductImageAssetService({
      profileAssetRepository: createProfileAssetRepository(db),
      productImageAssetRepository: metadata,
      objectStorage,
      modelApiAccountRepository: { getAccountForInternalUse: () => null },
      config: { imageAssets: { lifecycle: { retryDelaySeconds: 0 } } },
    });
    const scope = { tenantId: 'tenant-delete', userId: 'user-delete', shopId: 'shop-delete' };
    const imported = await service.importImage({
      mimeType: 'image/png', dataBase64: ONE_PIXEL_PNG.toString('base64'), variant: 'delete-test',
    }, scope);

    const released = await service.releaseAsset({ assetId: imported.asset.id }, scope);
    assert.equal(released.cleanupPending, true);
    assert.equal(metadata.getAsset(imported.asset.id, scope).referenceCount, 0);
    assert.match(metadata.getAsset(imported.asset.id, scope).lastError, /^DELETE_FAILED:/u);

    failDelete = false;
    const cleanup = await service.cleanupExpiredAssets({ limit: 10, retryDelaySeconds: 0 });
    assert.equal(cleanup.deleted, 1);
    assert.equal(cleanup.failed, 0);
    assert.equal(deletedKeys.length, 1);
    assert.equal(metadata.getAsset(imported.asset.id, scope).status, 'deleted');
  } finally {
    db.close();
  }
});

test('refreshes permanent OSS URLs immediately before product submit including Rich Content JSON strings', async () => {
  const db = createMigratedTestDb();
  try {
    const metadata = createProductImageAssetRepository(db, { tenantId: 'tenant-sign', userId: 'user-sign' });
    let signature = 0;
    const objectStorage = {
      configured: true,
      createSignedReadUrl(key, ttl) { signature += 1; return `https://bucket.example/${key}?ttl=${ttl}&sig=${signature}`; },
      async putImage(input) {
        return { objectKey: `wangzai/assets/images/${input.assetId}.png`, etag: 'etag', requestId: 'request' };
      },
    };
    const service = createProductImageAssetService({
      profileAssetRepository: createProfileAssetRepository(db),
      productImageAssetRepository: metadata,
      objectStorage,
      modelApiAccountRepository: { getAccountForInternalUse: () => null },
      config: { imageAssets: { ozonUrlTtlSeconds: 7200 } },
    });
    const scope = { tenantId: 'tenant-sign', userId: 'user-sign', shopId: 'shop-sign' };
    const imported = await service.importImage({
      mimeType: 'image/png', dataBase64: ONE_PIXEL_PNG.toString('base64'), storageScope: 'permanent', variant: 'detail',
    }, scope);
    const originalUrl = imported.asset.ozonUrl;
    const payload = { items: [{ attributes: [{ id: 11254, values: [{ value: JSON.stringify({ content: [{ props: { src: originalUrl } }] }) }] }] }] };
    const refreshed = await service.refreshProductWritePayloadUrls(payload, scope);
    const refreshedUrl = JSON.parse(refreshed.items[0].attributes[0].values[0].value).content[0].props.src;
    assert.notEqual(refreshedUrl, originalUrl);
    assert.match(refreshedUrl, /ttl=7200&sig=/u);
    assert.equal(payload.items[0].attributes[0].values[0].value.includes(refreshedUrl), false);
  } finally {
    db.close();
  }
});

test('usage status exposes warning and exceeded states for the configured monthly budget', () => {
  const service = createProductImageAssetService({
    profileAssetRepository: createAssetRepository(),
    productImageAssetRepository: {
      defaults: { tenantId: 'tenant-budget', userId: 'user-budget' },
      getUsageSummary: () => ({
        scope: { tenantId: 'tenant-budget', userId: 'user-budget', shopId: 'shop-budget' },
        day: {},
        month: { requests: 20_000, estimated_egress_bytes: 2 * 1024 ** 3 },
        retained: { bytes: 5 * 1024 ** 3 },
      }),
    },
    modelApiAccountRepository: { getAccountForInternalUse: () => null },
    config: { imageAssets: {
      storageGbMonthCny: 1,
      egressGbCny: 1,
      requestsPerTenThousandCny: 1,
      monthlyBudgetCny: 8,
    } },
  });
  const usage = service.getUsageStatus({ shopId: 'shop-budget' });
  assert.equal(usage.estimatedMonthlyCostCny, 9);
  assert.equal(usage.budgetWarning, true);
  assert.equal(usage.budgetExceeded, true);
  assert.equal(usage.budgetUsedPercent, 112.5);
});

test('validates a fixed model candidate against the discovered account metadata', () => {
  const accounts = new Map([
    ['account-a', {
      id: 'account-a',
      apiKey: 'secret-a',
      discoveryVerified: true,
      baseUrl: 'https://images.example.invalid/v1',
      defaultModel: 'gpt-image-2',
      availableModels: [{ id: 'gpt-image-2', capabilities: ['image-edit'] }],
    }],
  ]);
  const selection = resolveProductImageModelSelection({
    modelSelection: { mode: 'fixed', candidates: [{ accountId: 'account-a', model: 'gpt-image-2' }] },
    modelApiAccountRepository: { getAccountForInternalUse: (id) => accounts.get(id) || null },
  });

  assert.equal(selection.account.id, 'account-a');
  assert.equal(selection.model, 'gpt-image-2');
  assert.equal(selection.mode, 'fixed');
});

test('rejects every discovered image model except gpt-image-2', () => {
  const account = {
    id: 'account-banana',
    apiKey: 'secret-banana',
    discoveryVerified: true,
    baseUrl: 'https://images.example.invalid/v1',
    defaultModel: 'gemini-banana-2.0-pro',
    availableModels: [{ id: 'gemini-banana-2.0-pro', capabilities: ['text-generation'] }],
  };
  const selection = resolveProductImageModelSelection({
    modelSelection: {
      mode: 'fixed',
      candidates: [{ accountId: account.id, model: 'gemini-banana-2.0-pro' }],
    },
    modelApiAccountRepository: { getAccountForInternalUse: (id) => (id === account.id ? account : null) },
  });

  assert.equal(selection, null);
});

test('rejects text and video models from image generation selection', () => {
  const account = {
    id: 'account-mixed',
    apiKey: 'secret-mixed',
    discoveryVerified: true,
    baseUrl: 'https://relay.example/v1',
    defaultModel: 'gpt-5-4-thinking',
    availableModels: [
      { id: 'gpt-5-4-thinking', capabilities: ['text-generation'] },
      { id: 'seedance-2.0', capabilities: [] },
    ],
  };
  const repository = { getAccountForInternalUse: (id) => (id === account.id || id == null ? account : null) };

  assert.equal(resolveProductImageModelSelection({
    modelSelection: {
      mode: 'fixed',
      candidates: [{ accountId: account.id, model: 'gpt-5-4-thinking' }],
    },
    modelApiAccountRepository: repository,
  }), null);
  assert.equal(resolveProductImageModelSelection({
    fallbackAccountId: account.id,
    modelApiAccountRepository: repository,
  }), null);
});

test('chooses one candidate from a validated random pool', () => {
  const accounts = new Map([
    ['account-a', {
      id: 'account-a', apiKey: 'secret-a', discoveryVerified: true, baseUrl: 'https://images.example.invalid/v1', defaultModel: 'gpt-image-2',
      availableModels: [{ id: 'gpt-image-2', capabilities: ['image-edit'] }],
    }],
    ['account-b', {
      id: 'account-b', apiKey: 'secret-b', discoveryVerified: true, baseUrl: 'https://images.example.invalid/v1', defaultModel: 'gpt-image-2',
      availableModels: [{ id: 'gpt-image-2', capabilities: ['image-edit'] }],
    }],
  ]);
  const selection = resolveProductImageModelSelection({
    modelSelection: {
      mode: 'random',
      candidates: [
        { accountId: 'account-a', model: 'gpt-image-2' },
        { accountId: 'account-b', model: 'gpt-image-2' },
      ],
    },
    modelApiAccountRepository: { getAccountForInternalUse: (id) => accounts.get(id) || null },
    randomIndex: () => 1,
  });

  assert.equal(selection.account.id, 'account-b');
  assert.equal(selection.model, 'gpt-image-2');
  assert.equal(selection.candidateCount, 2);
});

test('requests a fast provider URL while still accepting an inline base64 compatibility response', async () => {
  const repository = createAssetRepository();
  const account = {
    id: 'account-generate',
    apiKey: 'secret-generate',
    discoveryVerified: true,
    baseUrl: 'https://images.example.invalid/v1',
    defaultModel: 'gpt-image-2',
    availableModels: [{ id: 'gpt-image-2', capabilities: ['image-generation'] }],
  };
  const calls = [];
  const service = createProductImageAssetService({
    profileAssetRepository: repository,
    modelApiAccountRepository: { getAccountForInternalUse: (id) => (id === account.id ? account : null) },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }] };
        },
      };
    },
    config: { imageAssets: {} },
  });

  const result = await service.generateImage({
    prompt: '生成一张 3:4 商品图',
    size: '1024x1536',
    modelSelection: { mode: 'fixed', candidates: [{ accountId: account.id, model: account.defaultModel }] },
  });
  assert.equal(calls[0].url, 'https://images.example.invalid/v1/images/generations');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'gpt-image-2',
    prompt: '生成一张 3:4 商品图',
    n: 1,
    response_format: 'url',
    size: '1024x1536',
    quality: 'high',
  });
  assert.equal(result.asset.mimeType, 'image/png');
  assert.equal(result.asset.ozonReady, false);
  assert.equal(result.delivery.mode, 'inline-base64');
  assert.ok(result.delivery.deliveryElapsedMs < 50);
});

test('returns the provider preview before the remote image is copied to private storage in the background', async () => {
  const repository = createAssetRepository();
  const account = {
    id: 'account-edit-fast-return',
    apiKey: 'secret-edit-fast-return',
    discoveryVerified: true,
    baseUrl: 'https://images.example.invalid/v1',
    defaultModel: 'gpt-image-2',
    availableModels: [{ id: 'gpt-image-2', capabilities: ['image-edit'] }],
  };
  const calls = [];
  const service = createProductImageAssetService({
    profileAssetRepository: repository,
    modelApiAccountRepository: { getAccountForInternalUse: (id) => (id === account.id ? account : null) },
    dnsLookup: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://images.example.invalid/v1/images/edits') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ url: 'https://images.example/result.png' }] };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === 'content-type' ? 'image/png' : null },
        async arrayBuffer() { return ONE_PIXEL_PNG; },
      };
    },
    config: { imageAssets: {} },
  });

  const result = await service.editImage({
    prompt: '保持商品结构，生成电商主图',
    dataBase64: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`,
    modelSelection: { mode: 'fixed', candidates: [{ accountId: account.id, model: account.defaultModel }] },
  });

  assert.equal(calls[0].url, 'https://images.example.invalid/v1/images/edits');
  assert.equal(calls[0].options.body.get('response_format'), 'url');
  assert.equal(result.delivery.mode, 'remote-url-immediate');
  assert.equal(result.asset.previewUrl, 'https://images.example/result.png');
  assert.equal(result.pending, true);

  let task = service.readPersistenceTask(result.taskId);
  for (let attempt = 0; attempt < 20 && task?.task?.status === 'pending'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    task = service.readPersistenceTask(result.taskId);
  }
  assert.equal(task.task.status, 'completed');
  assert.equal(task.task.result.asset.mimeType, 'image/png');
  assert.equal(task.task.result.delivery.mode, 'remote-url-background');
  assert.equal(calls.filter((call) => String(call.url) === 'https://images.example/result.png').length, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProductImageObjectKey,
  createAliyunOssProductImageStorage,
  readAliyunOssProductImageConfig,
} from './aliyunOssProductImageStorage.js';

class FakeOssClient {
  static latest = null;
  static instances = [];
  static failAcceleratedGet = false;

  constructor(options) {
    this.options = options;
    this.calls = [];
    FakeOssClient.latest = this;
    FakeOssClient.instances.push(this);
  }

  async put(name, data, options) {
    this.calls.push({ type: 'put', name, data, options });
    return {
      res: {
        headers: {
          etag: '"etag-1"',
          'x-oss-request-id': 'request-1',
        },
      },
    };
  }

  signatureUrl(name, options) {
    this.calls.push({ type: 'sign', name, options });
    const origin = this.options.endpoint.includes('oss-accelerate')
      ? 'https://accelerate.example'
      : 'https://private.example';
    return `${origin}/${name}?signed=1`;
  }

  async delete(name) {
    this.calls.push({ type: 'delete', name });
  }

  async get(name, options = {}) {
    this.calls.push({ type: 'get', name, options });
    if (FakeOssClient.failAcceleratedGet && this.options.endpoint.includes('oss-accelerate')) {
      const error = new Error('accelerated route temporarily unavailable');
      error.status = 502;
      throw error;
    }
    return { content: Buffer.from('image-data'), res: { headers: { 'content-type': 'image/png' } } };
  }
}

function configuredOss() {
  return readAliyunOssProductImageConfig({
    ALIYUN_OSS_REGION: 'oss-cn-hongkong',
    ALIYUN_OSS_BUCKET: 'bucket-a',
    ALIYUN_OSS_ENDPOINT: 'https://oss-cn-hongkong.aliyuncs.com',
    ALIYUN_OSS_PREFIX: 'wangzai/temp/',
    ALIYUN_OSS_PERMANENT_PREFIX: 'wangzai/assets/',
    ALIYUN_OSS_PREVIEW_URL_TTL_SECONDS: '600',
    ALIYUN_OSS_OZON_URL_TTL_SECONDS: '86400',
    ALIYUN_OSS_ACCESS_KEY_ID: 'key-id',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'key-secret',
  });
}

test('builds tenant and shop scoped object keys under the fixed prefix', () => {
  assert.equal(buildProductImageObjectKey({
    prefix: 'wangzai/temp/',
    tenantId: 'tenant:1',
    shopId: 'shop/2',
    assetId: 'asset_abc',
    variant: 'detail 1',
    mimeType: 'image/webp',
    now: new Date('2026-08-03T00:00:00Z'),
  }), 'wangzai/temp/images/tenant-1/shop-2/2026/08/asset_abc/detail-1.webp');
});

test('keeps the packaged local API bootable when shared OSS credentials are not configured', () => {
  const config = readAliyunOssProductImageConfig({});
  assert.equal(config.configured, false);
  assert.equal(createAliyunOssProductImageStorage({ config }), null);
});

test('uploads temporary and permanent images with separate signed URL lifetimes', async () => {
  FakeOssClient.instances = [];
  FakeOssClient.failAcceleratedGet = false;
  const storage = createAliyunOssProductImageStorage({
    config: configuredOss(),
    Client: FakeOssClient,
    now: () => new Date('2026-08-03T00:00:00Z'),
  });
  const result = await storage.putImage({
    data: Buffer.from('png-data'),
    mimeType: 'image/png',
    assetId: 'asset_1',
    tenantId: 'tenant-a',
    shopId: 'shop-a',
    variant: 'generated',
  });

  assert.equal(result.objectKey, 'wangzai/temp/images/tenant-a/shop-a/2026/08/asset_1/generated.png');
  assert.equal(result.etag, 'etag-1');
  assert.match(result.previewUrl, /^https:\/\/private\.example\//u);
  assert.match(result.thumbnailUrl, /^https:\/\/private\.example\//u);
  assert.equal(result.ozonUrl, '');
  assert.equal(FakeOssClient.latest.calls[0].options.mime, 'image/png');
  assert.equal(
    FakeOssClient.latest.calls[0].options.headers['x-oss-server-side-encryption'],
    'AES256',
  );
  const signedCalls = FakeOssClient.latest.calls.filter((call) => call.type === 'sign');
  assert.equal(signedCalls.some((call) => /image\/resize,m_lfit,w_320,h_320\/format,webp\/quality,q_85/u.test(call.options.process || '')), true);
  assert.equal(signedCalls.every((call) => /^private, max-age=\d+$/u.test(call.options.response['cache-control'])), true);

  await storage.deleteImage(result.objectKey);
  const permanent = await storage.putImage({
    data: Buffer.from('png-data'), mimeType: 'image/png', assetId: 'asset_2', tenantId: 'tenant-a',
    shopId: 'shop-a', variant: 'generated', storageScope: 'permanent',
  });
  assert.match(permanent.objectKey, /^wangzai\/assets\//u);
  assert.match(permanent.ozonUrl, /^https:\/\/private\.example\//u);
  assert.match(permanent.thumbnailUrl, /^https:\/\/private\.example\//u);
  assert.equal(permanent.ozonExpiresInSeconds, 86400);
  assert.deepEqual((await storage.getImage(permanent.objectKey)).data, Buffer.from('image-data'));
  const thumbnail = await storage.getThumbnail(permanent.objectKey);
  assert.deepEqual(thumbnail.data, Buffer.from('image-data'));
  assert.equal(thumbnail.mimeType, 'image/webp');
  assert.match(FakeOssClient.latest.calls.find((call) => call.type === 'get' && call.options.process)?.options.process || '', /format,webp/u);
  await storage.deleteImage(permanent.objectKey);
  await assert.rejects(() => storage.deleteImage('outside/file.png'), /outside the configured prefixes/u);
});

test('uses the acceleration endpoint for previews and falls back to the regional endpoint for retryable reads', async () => {
  FakeOssClient.instances = [];
  FakeOssClient.failAcceleratedGet = false;
  const config = readAliyunOssProductImageConfig({
    ALIYUN_OSS_REGION: 'oss-cn-hongkong',
    ALIYUN_OSS_BUCKET: 'bucket-a',
    ALIYUN_OSS_ENDPOINT: 'https://oss-cn-hongkong.aliyuncs.com',
    ALIYUN_OSS_ACCELERATION_ENABLED: 'true',
    ALIYUN_OSS_ACCELERATE_ENDPOINT: 'https://oss-accelerate.aliyuncs.com',
    ALIYUN_OSS_PREFIX: 'wangzai/temp/',
    ALIYUN_OSS_PERMANENT_PREFIX: 'wangzai/assets/',
    ALIYUN_OSS_ACCESS_KEY_ID: 'key-id',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'key-secret',
  });
  const storage = createAliyunOssProductImageStorage({ config, Client: FakeOssClient });
  const objectKey = 'wangzai/assets/images/tenant-a/shop-a/2026/08/asset/generated.png';

  assert.equal(storage.accelerationEnabled, true);
  assert.equal(storage.endpoint, 'https://oss-accelerate.aliyuncs.com');
  assert.equal(storage.fallbackEndpoint, 'https://oss-cn-hongkong.aliyuncs.com');
  assert.match(storage.createSignedReadUrl(objectKey), /^https:\/\/accelerate\.example\//u);
  assert.match(storage.createSignedOzonReadUrl(objectKey), /^https:\/\/private\.example\//u);

  FakeOssClient.failAcceleratedGet = true;
  const result = await storage.getImage(objectKey);
  assert.deepEqual(result.data, Buffer.from('image-data'));
  const accelerated = FakeOssClient.instances.find((item) => item.options.endpoint.includes('oss-accelerate'));
  const regional = FakeOssClient.instances.find((item) => item.options.endpoint.includes('oss-cn-hongkong'));
  assert.equal(accelerated.calls.some((call) => call.type === 'get'), true);
  assert.equal(regional.calls.some((call) => call.type === 'get'), true);
  FakeOssClient.failAcceleratedGet = false;
});

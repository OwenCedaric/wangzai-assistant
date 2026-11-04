import '../src/config/loadLocalEnvironment.js';
import { createAliyunOssProductImageStorageFromEnvironment } from '../src/domain/productImages/aliyunOssProductImageStorage.js';

// Keep this fixture large enough for OSS Image Processing to decode. A historical
// 1x1 compatibility PNG could be downloaded normally, but OSS correctly rejected
// it as ImageDamage when the WebP thumbnail transform was requested.
const smokePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAUklEQVR4nJXCgRTAIABF0YcQwhBCGEIIIYTwEUIYQgghhDCEIYzh3XOBuKVE5bqiUmtU7jsqrUWl96iMEZVIzBmV54nKWlHZOyrnROV9o/J9UX9sb3AQMgupXwAAAABJRU5ErkJggg==',
  'base64',
);

const storage = createAliyunOssProductImageStorageFromEnvironment();
if (!storage?.configured) {
  throw new Error('Aliyun OSS product image storage is not configured.');
}

const uploaded = [];
try {
  const cases = Array.from({ length: 12 }, (_, index) => ({
    storageScope: index < 6 ? 'temporary' : 'permanent',
    tenantId: `tenant-smoke-${Math.floor(index / 2)}`,
    shopId: `shop-smoke-${index % 3}`,
    variant: `connectivity-${index}`,
  }));
  for (const [index, item] of cases.entries()) {
    const stored = await storage.putImage({
      data: smokePng,
      mimeType: 'image/png',
      assetId: `asset_smoke_${Date.now()}_${index}`,
      ...item,
    });
    uploaded.push(stored);
    const response = await fetch(stored.previewUrl, {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'image/png' },
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok || !body.equals(smokePng)) throw new Error(`OSS signed readback failed: HTTP ${response.status}.`);
    const thumbnailResponse = await fetch(storage.createSignedThumbnailUrl(stored.objectKey, 300), {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'image/webp' },
    });
    const thumbnailBody = Buffer.from(await thumbnailResponse.arrayBuffer());
    if (!thumbnailResponse.ok || !thumbnailBody.length || !/^image\/webp(?:;|$)/iu.test(thumbnailResponse.headers.get('content-type') || '')) {
      throw new Error(`OSS signed thumbnail readback failed: HTTP ${thumbnailResponse.status}.`);
    }
    if (item.storageScope === 'permanent' && !stored.ozonUrl) throw new Error('Permanent object did not receive an Ozon URL.');
    if (item.storageScope === 'temporary' && stored.ozonUrl) throw new Error('Temporary object unexpectedly received an Ozon URL.');
  }
  console.log(JSON.stringify({
    ok: true,
    bucket: storage.bucket,
    region: storage.region,
    upload: true,
    signedRead: true,
    signedThumbnailRead: true,
    cases: cases.length,
    temporary: cases.filter((item) => item.storageScope === 'temporary').length,
    permanent: cases.filter((item) => item.storageScope === 'permanent').length,
    byteLengthEach: smokePng.byteLength,
  }, null, 2));
} finally {
  await Promise.allSettled(uploaded.map((item) => storage.deleteImage(item.objectKey)));
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createImagesService } from './imagesService.js';

test('images domain reuses the canonical product cache', () => {
  const reads = [];
  const service = createImagesService({
    productsService: {
      readCache(query) {
        reads.push(query);
        return {
          ok: true,
          rows: [{ productId: '100', primaryImage: 'https://img/100.jpg' }],
        };
      },
    },
  });

  const result = service.readCache({ shopId: 'shop-a' });
  assert.equal(result.ok, true);
  assert.deepEqual(reads, [{ shopId: 'shop-a' }]);
});

test('images domain starts picture-only hydration through products service', () => {
  const calls = [];
  const service = createImagesService({
    productsService: {
      startSync(input) {
        calls.push(input);
        return {
          ok: true,
          accepted: true,
          domain: 'products',
          jobId: 'job-images-1',
        };
      },
    },
  });

  const result = service.startSync({ shopId: 'shop-a', maxPages: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.requestedDomain, 'images');
  assert.equal(result.canonicalDomain, 'products');
  assert.deepEqual(calls, [
    {
      shopId: 'shop-a',
      maxPages: 3,
      hydrate: true,
      hydrationMode: 'pictures',
      requestedBy: 'images-domain-sync',
    },
  ]);
});

test('images domain reports a stable error when product sync is unavailable', () => {
  const result = createImagesService().startSync({ shopId: 'shop-a' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'IMAGES_PRODUCT_SERVICE_NOT_CONNECTED');
});

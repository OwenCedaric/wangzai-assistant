import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createProductImageAssetRoutes } from './productImageAssetRoutes.js';

function invokeRoute({ body, service, resolveRequestContext }) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
    req.method = 'POST';
    req.headers = {};
    const response = { statusCode: 0, headers: {}, body: '' };
    const res = {
      writeHead(statusCode, headers) {
        response.statusCode = statusCode;
        response.headers = headers;
      },
      end(value = '') {
        response.body = String(value);
        resolve(response);
      },
    };
    req.once('error', reject);
    const routes = createProductImageAssetRoutes({ service, resolveRequestContext });
    const handled = routes.handleRequest({
      req,
      res,
      requestUrl: new URL('http://127.0.0.1/api/product-images/assets/previews'),
      corsHeaders: {},
    });
    if (!handled) reject(new Error('route was not handled'));
  });
}

test('reads private history previews in one authenticated shop-scoped request', async () => {
  const contextCalls = [];
  const serviceCalls = [];
  const response = await invokeRoute({
    body: { shopId: 'shop-a', assetIds: ['pimg-1', 'pimg-2'] },
    resolveRequestContext: async (input) => {
      contextCalls.push(input.body);
      return { tenantId: 'tenant-a', userId: 'user-a', shopId: input.body.shopId };
    },
    service: {
      readAssetPreviews(input, context) {
        serviceCalls.push({ input, context });
        return {
          ok: true,
          assets: input.assetIds.map((id) => ({ id, previewUrl: `https://private.example/${id}.png` })),
          missingAssetIds: [],
        };
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(contextCalls, [{ shopId: 'shop-a', assetIds: ['pimg-1', 'pimg-2'] }]);
  assert.deepEqual(serviceCalls[0].context, { tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' });
  assert.deepEqual(JSON.parse(response.body).assets.map((asset) => asset.id), ['pimg-1', 'pimg-2']);
});

test('serves one stable cacheable binary thumbnail without JSON or base64 transport', async () => {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = {};
  const output = await new Promise((resolve, reject) => {
    const response = { statusCode: 0, headers: {}, body: null };
    const res = {
      writeHead(statusCode, headers) {
        response.statusCode = statusCode;
        response.headers = headers;
      },
      end(value = '') {
        response.body = value;
        resolve(response);
      },
    };
    const routes = createProductImageAssetRoutes({
      resolveRequestContext: async () => ({ tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' }),
      service: {
        async readAssetThumbnail(assetId, context) {
          assert.equal(assetId, 'pimg-1');
          assert.equal(context.shopId, 'shop-a');
          return { id: assetId, data: Buffer.from('tiny-webp'), mimeType: 'image/webp' };
        },
      },
    });
    const handled = routes.handleRequest({
      req,
      res,
      requestUrl: new URL('http://127.0.0.1/api/product-images/assets/pimg-1/thumbnail?shopId=shop-a'),
      corsHeaders: {},
    });
    if (!handled) reject(new Error('route was not handled'));
  });

  assert.equal(output.statusCode, 200);
  assert.equal(output.headers['content-type'], 'image/webp');
  assert.equal(output.headers['cache-control'], 'private, max-age=86400, immutable');
  assert.deepEqual(output.body, Buffer.from('tiny-webp'));
});

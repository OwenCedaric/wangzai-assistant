import assert from 'node:assert/strict';
import test from 'node:test';
import { getOzonEndpoint, listOzonEndpoints, assertReadOnlyEndpoint } from '../src/ozon/ozonEndpointRegistry.js';

const required = [
  'catalog.categoryTree','catalog.attributes','catalog.attributeValues','products.list','products.infoList','products.attributes','products.pictures','products.prices','products.stocks','orders.fbsList','orders.fbsUnfulfilledList','orders.fboList','orders.fbsGet','orders.fboGet','finance.transactionList','finance.accrualByDay','rating.fbsPostingList','returns.list','returns.rfbsList','warehouse.list','deliveryMethod.list','actions.list','sellerActions.list','shop.roles','shop.sellerInfo',
];

const productWriteEndpoints = [
  'products.import',
  'products.updatePrices',
  'products.updateStocks',
  'products.archive',
  'products.unarchive',
];

test('endpoint registry contains required final scheduler endpoints', () => {
  for (const key of required) {
    const endpoint = getOzonEndpoint(key);
    assert.equal(endpoint.key, key);
    assert.ok(endpoint.owner);
    assert.match(endpoint.risk, /^(read|write|file-read)$/u);
    assert.ok(endpoint.method);
    assert.ok(endpoint.path.startsWith('/'));
    assert.ok(endpoint.timeoutMs > 0);
    assert.ok(endpoint.retry);
    assert.ok(endpoint.rateLimit);
    assert.ok(endpoint.cachePolicy);
    assert.ok(endpoint.planning);
    assert.ok(endpoint.responseShape);
    assert.ok(endpoint.description);
    assert.doesNotThrow(() => assertReadOnlyEndpoint(endpoint));
  }
});

test('product write endpoints are registered as write risk and blocked from read-only path', () => {
  for (const key of productWriteEndpoints) {
    const endpoint = getOzonEndpoint(key);
    assert.equal(endpoint.key, key);
    assert.equal(endpoint.owner, 'products');
    assert.equal(endpoint.risk, 'write');
    assert.equal(endpoint.cachePolicy.policy, 'no_cache');
    assert.throws(() => assertReadOnlyEndpoint(endpoint), /not read-only/u);
  }
});

test('endpoint registry public list exposes planning and cache metadata without secrets', () => {
  const endpoints = listOzonEndpoints();
  assert.ok(endpoints.length >= required.length);
  for (const endpoint of endpoints) {
    assert.ok(endpoint.planning?.mode);
    assert.ok(endpoint.cachePolicy?.policy);
    assert.equal(JSON.stringify(endpoint).includes('Api-Key'), false);
    assert.equal(JSON.stringify(endpoint).includes('Client-Id'), false);
  }
});

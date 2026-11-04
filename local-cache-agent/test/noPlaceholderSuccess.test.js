import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompatibilityRoutes } from '../src/compatRoutes.js';

test('unimplemented domain routes never use generic JSON storage to fake success', async () => {
  const touched = [];
  const store = new Proxy({}, { get(_target, name) { return (...args) => { touched.push([name, args]); return null; }; } });
  const routes = createCompatibilityRoutes({ store });
  for (const [method, pathname] of [
    ['GET', '/api/cache/orders'], ['POST', '/api/account-removal/confirm'],
    ['DELETE', '/api/shops/fixture-shop'], ['POST', '/api/products/summary/hydrate'],
  ]) {
    const result = await routes.handle({ method, pathname, searchParams: new URLSearchParams(),
      payload: { shopId: 'fixture-shop', marker: 'do-not-save' }, scopeId: 'fixture-user:fixture-profile' });
    assert.equal(result.status, 501);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error.code, 'CACHE_AGENT_ROUTE_NOT_IMPLEMENTED');
  }
  assert.deepEqual(touched, []);
});

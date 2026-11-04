import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertShopAccess,
  createPublicRequestContext,
  createRequestContext,
  createTenantScopedKey,
  normalizeContextId,
  readRequestContextHints,
  requestContextDefaults,
} from '../src/security/requestContext.js';

test('request context keeps local single-user compatibility by default', () => {
  const context = createRequestContext({ defaultShopId: 'ozon-shop-1' });

  assert.equal(context.tenantId, 'tenant_local_default');
  assert.equal(context.userId, 'user_local_default');
  assert.equal(context.shopId, 'ozon-shop-1');
  assert.equal(context.isLocalDefaultTenant, true);
  assert.equal(context.isLocalDefaultUser, true);
  assert.deepEqual(context.source, {
    tenantId: 'local-default',
    userId: 'local-default',
    shopId: 'local-default',
  });
});

test('request context reads tenant user and shop from headers before query body values', () => {
  const context = createRequestContext({
    headers: {
      'x-wangzai-tenant-id': 'tenant_a',
      'x-wangzai-user-id': 'user_a',
      'x-wangzai-shop-id': 'shop_header',
    },
    query: { shopId: 'shop_query' },
    body: { values: { shopId: 'shop_body' } },
  });

  assert.equal(context.tenantId, 'tenant_a');
  assert.equal(context.userId, 'user_a');
  assert.equal(context.shopId, 'shop_header');
  assert.equal(context.source.shopId, 'request');
});

test('request context hints preserve body values when headers are absent', () => {
  const hints = readRequestContextHints({
    body: {
      values: {
        tenantId: 'tenant_body',
        userId: 'user_body',
        shopId: 'shop_body',
      },
    },
  });

  assert.deepEqual(hints, {
    tenantId: 'tenant_body',
    userId: 'user_body',
    shopId: 'shop_body',
  });
});

test('request context rejects unsafe identifiers before they can become cache keys', () => {
  assert.throws(
    () => normalizeContextId('../tenant', { fieldName: '租户 ID' }),
    /租户 ID 只能包含/u,
  );
  assert.throws(
    () => createRequestContext({ headers: { 'x-wangzai-user-id': '用户A' } }),
    /用户 ID 只能包含/u,
  );
});

test('tenant scoped key includes tenant and user without leaking credentials', () => {
  const context = createRequestContext({ tenantId: 'tenant_a', userId: 'user_a' });
  const key = createTenantScopedKey(['products', 'ozon-shop-1'], context);

  assert.equal(key, 'tenant_a:user_a:products:ozon-shop-1');
  assert.equal(key.includes('secret'), false);
});

test('shop access allows local compatibility and blocks unauthorized explicit list', () => {
  const context = createRequestContext({ tenantId: 'tenant_a', userId: 'user_a', shopId: 'shop_a' });

  assert.equal(assertShopAccess(context), 'shop_a');
  assert.equal(assertShopAccess(context, 'shop_a', ['shop_a', 'shop_b']), 'shop_a');
  assert.throws(() => assertShopAccess(context, 'shop_c', ['shop_a']), /无权访问该店铺/u);
});

test('public request context only exposes scope flags', () => {
  const context = createRequestContext({ tenantId: 'tenant_a', userId: 'user_a', shopId: 'shop_a' });
  const publicContext = createPublicRequestContext(context);

  assert.deepEqual(publicContext, {
    tenantId: 'tenant_a',
    userId: 'user_a',
    shopId: 'shop_a',
    isLocalDefaultTenant: false,
    isLocalDefaultUser: false,
  });
  assert.equal(JSON.stringify(publicContext).includes('apiKey'), false);
});

test('request context documents stable local defaults and accepted headers', () => {
  assert.equal(requestContextDefaults.tenantId, 'tenant_local_default');
  assert.equal(requestContextDefaults.userId, 'user_local_default');
  assert.deepEqual(requestContextDefaults.headers.tenantId, ['x-wangzai-tenant-id', 'x-tenant-id']);
});

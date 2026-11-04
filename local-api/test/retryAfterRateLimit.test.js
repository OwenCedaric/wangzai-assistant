import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOzonClient, parseRetryAfterMs } from '../src/ozon/ozonClient.js';
import { createRateLimitState } from '../src/ozon/rateLimitState.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

test('ozonClient exposes Retry-After seconds and HTTP date on HTTP errors', async () => {
  const secondsClient = createOzonClient({
    logger: () => {}, waitForEndpoint: async () => {}, retry: { maxAttempts: 1, retryOnStatus: [429], respectRetryAfter: true },
    transport: async () => new Response(JSON.stringify({ error: 'limit' }), { status: 429, headers: { 'Retry-After': '3' } }),
  });
  await assert.rejects(
    () => secondsClient.requestReadOnly({ endpointKey: 'catalog.categoryTree', shopCredentials: { clientId: 'a', apiKey: 'b' } }),
    (error) => { assert.equal(error.status, 429); assert.equal(error.retryAfterMs, 3000); return true; },
  );

  const future = new Date(Date.now() + 2000).toUTCString();
  const parsed = parseRetryAfterMs({ get: (name) => (name.toLowerCase() === 'retry-after' ? future : null) });
  assert.ok(parsed > 0 && parsed <= 3000);
});

test('rateLimitState scopes Retry-After and circuit breaker to shop plus endpoint', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, 'shop-rl-a');
    saveUnitShop(shopRepository, 'shop-rl-b');
    const rate = createRateLimitState(db, { failureThreshold: 2, circuitCooldownMs: 60_000, maxWaitMs: 1 });
    const endpoint = { rate: { bucket: 'catalog.read' } };
    const ticketA = { shopId: 'shop-rl-a', endpointKey: 'catalog.categoryTree', endpoint };
    const ticketOtherShop = { shopId: 'shop-rl-b', endpointKey: 'catalog.categoryTree', endpoint };
    const ticketOtherEndpoint = { shopId: 'shop-rl-a', endpointKey: 'catalog.attributes', endpoint: { rate: { bucket: 'catalog.attributes' } } };

    rate.recordFailure(ticketA, { status: 429, retryAfterMs: 5000, message: 'limited' });
    assert.equal(rate.beforeRequest(ticketA).status, 'rate_limited');
    assert.equal(rate.beforeRequest(ticketOtherShop).allowed, true);
    assert.equal(rate.beforeRequest(ticketOtherEndpoint).allowed, true);

    rate.recordFailure(ticketA, new Error('second failure'));
    assert.equal(rate.beforeRequest(ticketA).status, 'circuit_open');
    assert.equal(rate.beforeRequest(ticketOtherShop).allowed, true);
    const status = rate.getStatus({ shopId: 'shop-rl-a' });
    assert.equal(status.rateLimits[0].retryAfterMs, 5000);
  } finally {
    db.close();
  }
});

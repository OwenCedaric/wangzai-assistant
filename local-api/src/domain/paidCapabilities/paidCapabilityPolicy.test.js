import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAID_CAPABILITY_IDS,
  PaidCapabilityPolicyError,
  createPaidCapabilityRequest,
  decidePaidCapabilityRoute,
  validatePaidCapabilityIdempotencyKey,
  isVerifiedModelApiAccount,
} from './paidCapabilityPolicy.js';

const CAPABILITIES = [
  'text.product-description',
  'text.image-plan',
  'text.data-analysis',
  'text.external-insight',
  'image.generate',
  'image.edit',
  'external.seerfar.shop',
  'external.seerfar.product-detail',
  'external.seerfar.category',
  'external.seerfar.product-report',
  'external.seerfar.market-keyword',
  'external.seerfar.keyword-mining',
  'external.seerfar.keyword-back',
];

function validRequest(overrides = {}) {
  return {
    capability: 'text.product-description',
    version: 1,
    byok: { accountId: 'account-1', model: 'gpt-5.6-sol' },
    input: { systemPrompt: 'system', userPrompt: 'user' },
    fallbackPolicy: 'points-if-byok-unavailable',
    idempotencyKey: 'request:12345678',
    ...overrides,
  };
}

function healthyByok(overrides = {}) {
  return {
    configured: true,
    credentialPresent: true,
    baseUrlSafe: true,
    capabilitySupported: true,
    modelAvailable: true,
    testStatus: 'connected',
    testedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

function healthyCloud(overrides = {}) {
  return {
    configured: true,
    authenticated: true,
    permissionGranted: true,
    available: true,
    ...overrides,
  };
}

function route(request = validRequest(), options = {}) {
  return decidePaidCapabilityRoute(request, {
    now: new Date('2026-08-04T12:05:00.000Z'),
    byok: healthyByok(),
    cloud: healthyCloud(),
    ...options,
  });
}

test('paid capability registry is exact and immutable', () => {
  assert.deepEqual([...PAID_CAPABILITY_IDS], CAPABILITIES);
  assert.equal(Object.isFrozen(PAID_CAPABILITY_IDS), true);
});

for (const capability of CAPABILITIES) {
  test(`registered capability accepts ${capability}@1`, () => {
    const request = createPaidCapabilityRequest(validRequest({ capability }));
    assert.equal(request.capability, capability);
    assert.equal(request.version, 1);
  });
}

const FORBIDDEN_CLIENT_FIELDS = [
  'amountPoints',
  'points',
  'estimatedPoints',
  'maximumPoints',
  'chargePoints',
  'cost',
  'costCny',
  'price',
  'priceVersion',
  'profitMargin',
  'provider',
  'providerCode',
  'providerModel',
  'providerMultiplier',
  'providerUrl',
  'baseUrl',
  'apiKey',
  'authorization',
  'quoteId',
  'walletBalance',
];

for (const field of FORBIDDEN_CLIENT_FIELDS) {
  test(`request rejects client-controlled field ${field}`, () => {
    assert.throws(
      () => createPaidCapabilityRequest({ ...validRequest(), [field]: 'forged' }),
      (error) => error instanceof PaidCapabilityPolicyError
        && error.code === 'PAID_CAPABILITY_REQUEST_FIELDS_INVALID',
    );
  });
}

const INVALID_CAPABILITIES = [
  '',
  ' ',
  'text',
  'text.unknown',
  'image',
  'image.generate.v2',
  'external.seerfar',
  'external.seerfar.quota',
  'admin.points.spend',
  '/chat/completions',
  'https://provider.example/v1',
  'TEXT.PRODUCT-DESCRIPTION',
  'text.product_description',
  '../text.product-description',
  'text.product-description@1',
];

for (const capability of INVALID_CAPABILITIES) {
  test(`request rejects unsupported capability ${JSON.stringify(capability)}`, () => {
    assert.throws(
      () => createPaidCapabilityRequest(validRequest({ capability })),
      (error) => error instanceof PaidCapabilityPolicyError
        && error.code === 'PAID_CAPABILITY_UNSUPPORTED',
    );
  });
}

const INVALID_IDEMPOTENCY_KEYS = [
  '',
  'short',
  '含中文字符123456',
  'space key 123456',
  'newline\n123456',
  'tab\t123456',
  'slash/key/123456',
  'question?123456',
  'hash#123456',
  'percent%123456',
  'ampersand&123456',
  'equals=123456',
  'quote"123456',
  "quote'123456",
  '<tag>123456',
  'Bearer abcdefghijklmnopqrstuvwxyz',
  'a'.repeat(129),
  null,
  undefined,
  12345678,
];

for (const key of INVALID_IDEMPOTENCY_KEYS) {
  test(`idempotency key rejects ${JSON.stringify(key)}`, () => {
    assert.throws(
      () => validatePaidCapabilityIdempotencyKey(key),
      (error) => error instanceof PaidCapabilityPolicyError
        && error.code === 'PAID_CAPABILITY_IDEMPOTENCY_INVALID',
    );
  });
}

const VALID_IDEMPOTENCY_KEYS = [
  '12345678',
  'request:12345678',
  'request-12345678',
  'request_12345678',
  'request.12345678',
  'A:B-C_D.E:12345678',
  'a'.repeat(128),
];

for (const key of VALID_IDEMPOTENCY_KEYS) {
  test(`idempotency key accepts ${key.slice(0, 24)}`, () => {
    assert.equal(validatePaidCapabilityIdempotencyKey(key), key);
  });
}

const BYOK_UNAVAILABLE_CASES = [
  ['not configured', { configured: false }],
  ['credential missing', { credentialPresent: false }],
  ['unsafe base URL', { baseUrlSafe: false }],
  ['capability unsupported', { capabilitySupported: false }],
  ['model unavailable', { modelAvailable: false }],
  ['authentication failed', { testStatus: 'auth-failed' }],
  ['balance limited', { testStatus: 'limited' }],
  ['connection failed', { testStatus: 'error' }],
];

for (const [label, byok] of BYOK_UNAVAILABLE_CASES) {
  test(`BYOK ${label} selects paid cloud`, () => {
    const result = route(validRequest(), { byok: healthyByok(byok) });
    assert.equal(result.route, 'paid-cloud');
    assert.equal(result.requiresServerAuthorization, true);
  });
}

const CLOUD_BLOCK_CASES = [
  ['not configured', { configured: false }, 'PAID_CAPABILITY_GATEWAY_UNAVAILABLE'],
  ['not authenticated', { authenticated: false }, 'PAID_CAPABILITY_AUTH_REQUIRED'],
  ['permission denied', { permissionGranted: false }, 'PAID_CAPABILITY_FORBIDDEN'],
  ['not available', { available: false }, 'PAID_CAPABILITY_GATEWAY_UNAVAILABLE'],
];

for (const [label, cloud, code] of CLOUD_BLOCK_CASES) {
  test(`cloud ${label} blocks paid fallback`, () => {
    const result = route(validRequest(), {
      byok: healthyByok({ configured: false }),
      cloud: healthyCloud(cloud),
    });
    assert.equal(result.route, 'blocked');
    assert.equal(result.code, code);
  });
}

for (const fallbackPolicy of ['never', 'ask']) {
  test(`fallback policy ${fallbackPolicy} does not silently spend points`, () => {
    const result = route(validRequest({ fallbackPolicy }), {
      byok: healthyByok({ configured: false }),
    });
    assert.equal(result.route, 'blocked');
    assert.equal(result.code, 'PAID_CAPABILITY_FALLBACK_DISABLED');
  });
}

const HEALTH_AGE_CASES = [
  ['exactly fresh', '2026-08-04T12:05:00.000Z', 'byok'],
  ['one second old', '2026-08-04T12:04:59.000Z', 'byok'],
  ['nine minutes old', '2026-08-04T11:56:00.000Z', 'byok'],
  ['exactly ten minutes old', '2026-08-04T11:55:00.000Z', 'byok'],
  ['ten minutes and one millisecond old', '2026-08-04T11:54:59.999Z', 'byok-health-check'],
  ['one hour old', '2026-08-04T11:05:00.000Z', 'byok-health-check'],
  ['future timestamp', '2026-08-04T12:05:01.000Z', 'byok-health-check'],
  ['invalid timestamp', 'not-a-date', 'byok-health-check'],
];

for (const [label, testedAt, expectedRoute] of HEALTH_AGE_CASES) {
  test(`BYOK health timestamp ${label}`, () => {
    const result = route(validRequest(), { byok: healthyByok({ testedAt }) });
    assert.equal(result.route, expectedRoute);
  });
}

const STATUS_CASES = [
  ['connected', 'byok'],
  ['unknown', 'byok-health-check'],
  ['testing', 'byok-health-check'],
  ['', 'byok-health-check'],
  [null, 'byok-health-check'],
];

for (const [status, expectedRoute] of STATUS_CASES) {
  test(`BYOK status ${JSON.stringify(status)} selects ${expectedRoute}`, () => {
    const result = route(validRequest(), { byok: healthyByok({ testStatus: status }) });
    assert.equal(result.route, expectedRoute);
  });
}

for (const configured of [false, true]) {
  for (const credentialPresent of [false, true]) {
    for (const capabilitySupported of [false, true]) {
      for (const modelAvailable of [false, true]) {
        test(
          `route matrix configured=${configured} credential=${credentialPresent} capability=${capabilitySupported} model=${modelAvailable}`,
          () => {
            const result = route(validRequest(), {
              byok: healthyByok({
                configured,
                credentialPresent,
                capabilitySupported,
                modelAvailable,
              }),
            });
            const usable = configured
              && credentialPresent
              && capabilitySupported
              && modelAvailable;
            assert.equal(result.route, usable ? 'byok' : 'paid-cloud');
          },
        );
      }
    }
  }
}

for (const capability of CAPABILITIES) {
  test(`healthy BYOK wins over unavailable cloud for ${capability}`, () => {
    const result = route(validRequest({ capability }), {
      cloud: healthyCloud({
        configured: false,
        authenticated: false,
        permissionGranted: false,
        available: false,
      }),
    });
    assert.equal(result.route, 'byok');
    assert.equal(result.requiresServerAuthorization, false);
  });
}

test('local policy never trusts a client points balance', () => {
  const result = decidePaidCapabilityRoute(validRequest(), {
    now: new Date('2026-08-04T12:05:00.000Z'),
    byok: healthyByok({ configured: false }),
    cloud: { ...healthyCloud(), pointsAvailable: false, walletBalance: 0 },
  });
  assert.equal(result.route, 'paid-cloud');
  assert.equal(result.requiresServerAuthorization, true);
});

test('created request is deeply detached from caller-owned top-level and BYOK objects', () => {
  const source = validRequest();
  const created = createPaidCapabilityRequest(source);
  source.capability = 'image.generate';
  source.byok.accountId = 'changed';
  assert.equal(created.capability, 'text.product-description');
  assert.equal(created.byok.accountId, 'account-1');
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.byok), true);
});

for (const [label, account, expected] of [
  ['verified https account', { apiKey: 'key', baseUrl: 'https://relay.example/v1', discoveryVerified: true }, true],
  ['unverified account', { apiKey: 'key', baseUrl: 'https://relay.example/v1', discoveryVerified: false }, false],
  ['missing key', { apiKey: '', baseUrl: 'https://relay.example/v1', discoveryVerified: true }, false],
  ['plain http', { apiKey: 'key', baseUrl: 'http://relay.example/v1', discoveryVerified: true }, false],
  ['url credentials', { apiKey: 'key', baseUrl: 'https://user:pass@relay.example/v1', discoveryVerified: true }, false],
  ['url query', { apiKey: 'key', baseUrl: 'https://relay.example/v1?key=leak', discoveryVerified: true }, false],
]) {
  test(`verified BYOK guard: ${label}`, () => {
    assert.equal(isVerifiedModelApiAccount(account), expected);
  });
}

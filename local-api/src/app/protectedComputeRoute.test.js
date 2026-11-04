import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createProfitCoreBatch, encodeProfitWire, PRIVATE_PROFIT_VERSION } from '../../../shared/profitCoreWire.js';

import { createApp } from './createApp.js';
import { canonicalJson } from '../domain/protectedCompute/canonicalJson.js';
import {
  createProtectedComputeClientFromSignedConfig,
  createStaticProtectedComputeTrustStore,
} from '../domain/protectedCompute/index.js';
import { createMigratedTestDb } from '../../test/testDb.js';

const NOW = new Date('2026-07-16T00:00:00.000Z');
const INPUT = Object.freeze({
  acquiringBasisPoints: 150,
  commissionBasisPoints: 1_700,
  costMinor: 2_500,
  currency: 'RUB',
  logisticsMinor: 600,
  salePriceMinor: 5_516,
  taxBasisPoints: 600,
});
const COLLECTION_INPUT = Object.freeze({
  commissionBasisPoints: 1_700,
  currency: 'CNY',
  currentPriceMinor: 5_516,
  extraCostMinor: 100,
  firstMileCostMinor: 600,
  purchaseCostMinor: 2_500,
  targetMarginBasisPoints: 2_000,
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startServer(protectedComputeRuntime = null) {
  const db = createMigratedTestDb();
  const server = createApp({
    db,
    config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
    protectedComputeRuntime,
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

async function requestJson(baseUrl, path, { method = 'GET', body, accessToken } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken
        ? { 'x-wangzai-protected-compute-access-token': accessToken }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

function signedPayload(payload, privateKey) {
  return {
    ...payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64url'),
  };
}

function createRuntimeFixture() {
  const computeKeys = generateKeyPairSync('ed25519');
  const configKeys = generateKeyPairSync('ed25519');
  let online = true;
  let responseSequence = 0;
  let tamperNext = false;
  let quotaExceeded = false;
  const signedPublicConfig = signedPayload({
    computeKeys: [{
      algorithm: 'Ed25519',
      keyId: 'route-compute-v1',
      publicKeyPem: computeKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    }],
    configVersion: 3,
    contract: 'signed-public-protected-compute-config/v1',
    expiresAt: '2026-07-17T00:00:00.000Z',
    issuedAt: NOW.toISOString(),
    revocationEpoch: 7,
    revokedCapabilities: [],
    revokedKeyIds: [],
    serverBaseUrl: 'https://license.example.test',
    signatureAlgorithm: 'Ed25519',
    signingKeyId: 'route-config-root-v1',
  }, configKeys.privateKey);
  const configTrustStore = createStaticProtectedComputeTrustStore({
    keys: { 'route-config-root-v1': configKeys.publicKey },
  });
  let transportCalls = 0;
  const client = createProtectedComputeClientFromSignedConfig({
    signedPublicConfig,
    configTrustStore,
    localUserSettings: { offlineEnabled: true, sourceClass: 'local-user' },
    accessTokenProvider: async () => '',
    now: () => NOW,
    requestFactoryOptions: {
      requestIdFactory: () => `123e4567-e89b-12d3-a456-${String(transportCalls + 1).padStart(12, '0')}`,
      nonceFactory: () => createHash('sha256')
        .update(`route-nonce-${transportCalls + 1}`)
        .digest('base64url'),
    },
    fetchImpl: async (url, options) => {
      transportCalls += 1;
      if (!online) throw new TypeError('offline');
      assert.equal(url, 'https://license.example.test/api/protected-compute/execute');
      assert.equal(options.headers.authorization, 'Bearer route-short-lived-access');
      assert.doesNotMatch(options.body, /route-short-lived-access/u);
      if (quotaExceeded) return new Response(JSON.stringify({ detail: 'Too many requests' }), { status: 429, headers: { 'Retry-After': '60' } });
      const request = JSON.parse(options.body);
      responseSequence += 1;
      const envelope = signedPayload({
        capability: request.capability,
        contract: 'protected-compute-result/v1',
        expiresAt: '2026-07-16T00:05:00.000Z',
        inputHash: request.inputHash,
        issuedAt: NOW.toISOString(),
        keyId: 'route-compute-v1',
        nonce: request.nonce,
        offlinePolicy: { allowed: request.capability !== 'profit.ledger-batch', maxUses: request.capability === 'profit.ledger-batch' ? 0 : 3, scope: 'input-hash' },
        offlineUntil: request.capability === 'profit.ledger-batch' ? null : '2026-07-16T00:04:00.000Z',
        requestId: request.requestId,
        responseId: `123e4567-e89b-12d3-a456-${String(responseSequence).padStart(12, '0')}`,
        result: request.capability === 'profit.ledger-batch'
          ? { calculationVersion: PRIVATE_PROFIT_VERSION, resultsJson: JSON.stringify(encodeProfitWire([{ id: 'fixture', value: { ok: true } }])) }
          : request.capability === 'collection-pricing.quote'
          ? {
              breakEvenPriceMinor: 3_856,
              currency: 'CNY',
              currentMarginBasisPoints: 2_498,
              currentProfitMinor: 1_378,
              suggestedPriceMinor: 4_627,
              totalCostMinor: 3_200,
            }
          : {
              contributionMinor: 917,
              currency: 'RUB',
              decision: 'review',
              marginBasisPoints: 1_662,
            },
        revocationEpoch: 7,
        signatureAlgorithm: 'Ed25519',
        version: request.version,
      }, computeKeys.privateKey);
      if (tamperNext) {
        envelope.result.contributionMinor += 1;
        tamperNext = false;
      }
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  return {
    runtime: {
      client,
      status: {
        available: true,
        configured: true,
        configVersion: 3,
        configExpiresAt: '2026-07-17T00:00:00.000Z',
        offlineEnabled: true,
      },
    },
    get transportCalls() { return transportCalls; },
    setOnline(value) { online = value; },
    setQuotaExceeded(value) { quotaExceeded = value; },
    tamper() { tamperNext = true; },
  };
}

test('private batches cross the real HTTP route above 64KiB while old quote limits and quota delays remain enforced', async () => {
  const fixture = createRuntimeFixture(), app = await startServer(fixture.runtime);
  try {
    const input = createProfitCoreBatch([{ id: 'fixture', operation: 'ledger', input: { order: { padding: 'x'.repeat(70 * 1024) } } }]);
    const good = await requestJson(app.baseUrl, '/api/protected-compute/execute', { method: 'POST',
      body: { capability: 'profit.ledger-batch', version: 1, input }, accessToken: 'route-short-lived-access' });
    assert.equal(good.response.status, 200);
    assert.equal(good.payload.signatureVerified, true);
    const oversized = await fetch(`${app.baseUrl}/api/protected-compute/execute`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wangzai-protected-compute-access-token': 'route-short-lived-access' },
      body: ' '.repeat(64 * 1024) + JSON.stringify({ capability: 'profitability.quote', version: 1, input: INPUT }),
    });
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error.message, /too large/);
    fixture.setQuotaExceeded(true);
    const limited = await requestJson(app.baseUrl, '/api/protected-compute/execute', { method: 'POST',
      body: { capability: 'profitability.quote', version: 1, input: INPUT }, accessToken: 'route-short-lived-access' });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.payload.error.retryAfterMs, 60_000);
  } finally { await app.close(); }
});

test('protected-compute routes expose contracts but fail closed while runtime is unconfigured', async () => {
  const app = await startServer();
  try {
    const status = await requestJson(app.baseUrl, '/api/protected-compute/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.available, false);
    assert.equal(status.payload.reasonCode, 'PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED');
    assert.deepEqual(status.payload.contracts, [
      { capability: 'profitability.quote', version: 1 },
      { capability: 'collection-pricing.quote', version: 1 },
      { capability: 'profit.ledger-batch', version: 1 },
    ]);

    const execution = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: { capability: 'profitability.quote', version: 1, input: INPUT },
      accessToken: 'route-short-lived-access',
    });
    assert.equal(execution.response.status, 503);
    assert.equal(execution.payload.error.code, 'PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED');
  } finally {
    await app.close();
  }
});

test('protected-compute route resolves runtime status per request and blocks after policy expiry', async () => {
  let available = true;
  let clientCalls = 0;
  const runtime = {
    client: {
      async execute() {
        clientCalls += 1;
        assert.fail('expired runtime status must block before client execution');
      },
    },
    getStatus() {
      return {
        available,
        configured: true,
        configVersion: 9,
        configExpiresAt: '2026-07-16T00:01:00.000Z',
        offlineEnabled: false,
        reasonCode: available ? null : 'PROTECTED_COMPUTE_CONFIG_EXPIRED',
      };
    },
  };
  const app = await startServer(runtime);
  try {
    const initial = await requestJson(app.baseUrl, '/api/protected-compute/status');
    assert.equal(initial.payload.available, true);
    assert.equal(initial.payload.configVersion, 9);

    available = false;
    const expired = await requestJson(app.baseUrl, '/api/protected-compute/status');
    assert.equal(expired.payload.available, false);
    assert.equal(expired.payload.reasonCode, 'PROTECTED_COMPUTE_CONFIG_EXPIRED');
    const execution = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: { capability: 'collection-pricing.quote', version: 1, input: COLLECTION_INPUT },
      accessToken: 'route-short-lived-access',
    });
    assert.equal(execution.response.status, 503);
    assert.equal(execution.payload.error.code, 'PROTECTED_COMPUTE_CONFIG_EXPIRED');
    assert.equal(clientCalls, 0);
  } finally {
    await app.close();
  }
});

test('createApp route uses request-scoped auth, returns only verified typed output, and rejects secrets', async () => {
  const fixture = createRuntimeFixture();
  const app = await startServer(fixture.runtime);
  try {
    const contracts = await requestJson(app.baseUrl, '/api/protected-compute/contracts');
    assert.equal(contracts.response.status, 200);
    assert.deepEqual(contracts.payload.contracts, [
      { capability: 'profitability.quote', version: 1 },
      { capability: 'collection-pricing.quote', version: 1 },
      { capability: 'profit.ledger-batch', version: 1 },
    ]);

    const missingAuth = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: { capability: 'profitability.quote', version: 1, input: INPUT },
    });
    assert.equal(missingAuth.response.status, 401);
    assert.equal(missingAuth.payload.error.code, 'PROTECTED_COMPUTE_AUTH_UNAVAILABLE');
    assert.equal(fixture.transportCalls, 0);

    const secret = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: {
        capability: 'profitability.quote',
        version: 1,
        input: { ...INPUT, api_key: 'must-not-forward' },
      },
      accessToken: 'route-short-lived-access',
    });
    assert.equal(secret.response.status, 400);
    assert.equal(secret.payload.error.code, 'PROTECTED_COMPUTE_SECRET_REJECTED');
    assert.equal(JSON.stringify(secret.payload).includes('must-not-forward'), false);
    assert.equal(fixture.transportCalls, 0);

    const success = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: { capability: 'profitability.quote', version: 1, input: INPUT },
      accessToken: 'route-short-lived-access',
    });
    assert.equal(success.response.status, 200);
    assert.deepEqual(success.payload.result, {
      contributionMinor: 917,
      currency: 'RUB',
      decision: 'review',
      marginBasisPoints: 1_662,
    });
    assert.equal(success.payload.signatureVerified, true);
    assert.equal(success.payload.source, 'server-signed');
    assert.equal(success.payload.verification.revocationEpoch, 7);
    assert.equal(Object.hasOwn(success.payload, 'envelope'), false);
    assert.doesNotMatch(JSON.stringify(success.payload), /route-short-lived-access/u);

    const collectionSuccess = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: { capability: 'collection-pricing.quote', version: 1, input: COLLECTION_INPUT },
      accessToken: 'route-short-lived-access',
    });
    assert.equal(collectionSuccess.response.status, 200);
    assert.equal(collectionSuccess.payload.result.suggestedPriceMinor, 4_627);
    assert.equal(collectionSuccess.payload.signatureVerified, true);

    fixture.tamper();
    const tampered = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: { capability: 'profitability.quote', version: 1, input: INPUT },
      accessToken: 'route-short-lived-access',
    });
    assert.equal(tampered.response.status, 502);
    assert.equal(tampered.payload.error.code, 'PROTECTED_COMPUTE_SIGNATURE_INVALID');

    fixture.setOnline(false);
    const offline = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: { capability: 'profitability.quote', version: 1, input: INPUT },
      accessToken: 'route-short-lived-access',
    });
    assert.equal(offline.response.status, 200);
    assert.equal(offline.payload.source, 'offline-signed');
    assert.equal(offline.payload.signatureVerified, true);
    assert.equal(offline.payload.verification.onlineErrorCode, 'PROTECTED_COMPUTE_NETWORK_UNAVAILABLE');

    const collectionOffline = await requestJson(app.baseUrl, '/api/protected-compute/execute', {
      method: 'POST',
      body: { capability: 'collection-pricing.quote', version: 1, input: COLLECTION_INPUT },
      accessToken: 'route-short-lived-access',
    });
    assert.equal(collectionOffline.response.status, 200);
    assert.equal(collectionOffline.payload.source, 'offline-signed');
    assert.equal(collectionOffline.payload.result.suggestedPriceMinor, 4_627);
  } finally {
    await app.close();
  }
});

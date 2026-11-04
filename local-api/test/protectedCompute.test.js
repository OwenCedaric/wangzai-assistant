import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { createProfitCoreBatch, encodeProfitWire, PRIVATE_PROFIT_VERSION } from '../../shared/profitCoreWire.js';

import { canonicalJson } from "../src/domain/protectedCompute/canonicalJson.js";
import {
  createProtectedComputeClient,
  createProtectedComputeRequest,
  createStaticProtectedComputeTrustStore,
  getProtectedComputeSignedPayload,
  listProtectedComputeContracts,
  MemoryProtectedComputeReplayGuard,
  ProtectedComputeError,
  normalizeProtectedComputeLocalUserSettings,
  verifySignedPublicProtectedComputeConfig,
  verifyProtectedComputeEnvelope,
} from "../src/domain/protectedCompute/index.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const configurationKeyPair = generateKeyPairSync("ed25519");
const trustStore = createStaticProtectedComputeTrustStore({
  keys: { "test-protected-v1": publicKey },
});
const NOW = new Date("2026-07-16T00:00:00.000Z");

test('quota retry-after is preserved as a bounded non-secret delay', async () => {
  const client = createProtectedComputeClient({ baseUrl: 'https://compute.example.test', trustStore,
    accessTokenProvider: async () => 'fixture-token', now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'Too many requests' }), { status: 429, headers: { 'Retry-After': '60' } }),
  });
  await assert.rejects(client.execute({ capability: 'profitability.quote', version: 1, input: VALID_INPUT }),
    error => error.status === 429 && error.details.retryAfterMs === 60_000);
});

test('private batches can verify bounded full ledgers while old quote response limits stay unchanged', async () => {
  const result = { calculationVersion: PRIVATE_PROFIT_VERSION,
    resultsJson: JSON.stringify(encodeProfitWire([{ id: 'fixture', value: { detail: 'x'.repeat(1_100_000) } }])) };
  const client = createProtectedComputeClient({
    baseUrl: 'https://compute.example.test', trustStore, now: () => NOW,
    accessTokenProvider: async () => 'synthetic-device-token',
    fetchImpl: async (_url, options) => new Response(JSON.stringify(signEnvelope(JSON.parse(options.body), {
      result, offlinePolicy: { allowed: false, maxUses: 0, scope: 'input-hash' }, offlineUntil: null,
    }))),
  });
  const verified = await client.execute({ capability: 'profit.ledger-batch', version: 1,
    input: createProfitCoreBatch([{ id: 'fixture', operation: 'ledger', input: { order: {} } }]) });
  assert.equal(verified.signatureVerified, true);
  assert.deepEqual(verified.result, result);
  await assert.rejects(client.execute({ capability: 'profitability.quote', version: 1, input: VALID_INPUT }),
    error => error.code === 'PROTECTED_COMPUTE_RESPONSE_TOO_LARGE');
});

test('unknown-length oversized responses cancel the stream without reading the rest', async () => {
  let cancelled = false, pulls = 0;
  const client = createProtectedComputeClient({
    baseUrl: 'https://compute.example.test', trustStore, now: () => NOW,
    accessTokenProvider: async () => 'synthetic-device-token',
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(600_000)); },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(client.execute({ capability: 'profitability.quote', version: 1, input: VALID_INPUT }),
    error => error.code === 'PROTECTED_COMPUTE_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});
const VALID_INPUT = Object.freeze({
  acquiringBasisPoints: 150,
  commissionBasisPoints: 1_700,
  costMinor: 2_500,
  currency: "rub",
  logisticsMinor: 600,
  salePriceMinor: 5_516,
  taxBasisPoints: 600,
});
const COLLECTION_PRICING_INPUT = Object.freeze({
  commissionBasisPoints: 1_700,
  currency: "cny",
  currentPriceMinor: 5_516,
  extraCostMinor: 100,
  firstMileCostMinor: 600,
  purchaseCostMinor: 2_500,
  targetMarginBasisPoints: 2_000,
});

function makeRequest(overrides = {}) {
  return createProtectedComputeRequest(
    {
      capability: "profitability.quote",
      version: 1,
      input: VALID_INPUT,
      ...overrides,
    },
    {
      now: () => NOW,
      requestIdFactory: () => "123e4567-e89b-12d3-a456-426614174000",
      nonceFactory: () => "a".repeat(43),
    },
  );
}

let responseSequence = 0;
function signEnvelope(request, overrides = {}) {
  responseSequence += 1;
  const payload = {
    capability: request.capability,
    contract: "protected-compute-result/v1",
    expiresAt: "2026-07-16T00:05:00.000Z",
    inputHash: request.inputHash,
    issuedAt: NOW.toISOString(),
    keyId: "test-protected-v1",
    nonce: request.nonce,
    offlinePolicy: { allowed: true, maxUses: 3, scope: "input-hash" },
    offlineUntil: "2026-07-16T00:04:00.000Z",
    requestId: request.requestId,
    responseId: `123e4567-e89b-12d3-a456-${String(responseSequence).padStart(12, "0")}`,
    result:
      request.capability === "collection-pricing.quote"
        ? {
            breakEvenPriceMinor: 3_856,
            currency: "CNY",
            currentMarginBasisPoints: 2_498,
            currentProfitMinor: 1_378,
            suggestedPriceMinor: 4_627,
            totalCostMinor: 3_200,
          }
        : {
            contributionMinor: 917,
            currency: "RUB",
            decision: "review",
            marginBasisPoints: 1_662,
          },
    revocationEpoch: 7,
    signatureAlgorithm: "Ed25519",
    version: request.version,
    ...overrides,
  };
  return {
    ...payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString(
      "base64url",
    ),
  };
}

function signedPublicConfig(overrides = {}) {
  const payload = {
    computeKeys: [
      {
        algorithm: "Ed25519",
        keyId: "test-protected-v1",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      },
    ],
    configVersion: 1,
    contract: "signed-public-protected-compute-config/v1",
    expiresAt: "2026-07-17T00:00:00.000Z",
    issuedAt: NOW.toISOString(),
    revocationEpoch: 7,
    revokedCapabilities: [],
    revokedKeyIds: [],
    serverBaseUrl: "https://compute.example.test",
    signatureAlgorithm: "Ed25519",
    signingKeyId: "config-root-v1",
    ...overrides,
  };
  return {
    ...payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      configurationKeyPair.privateKey,
    ).toString("base64url"),
  };
}

test("minimal input is normalized and secret-shaped fields are rejected before transport", () => {
  const request = makeRequest();
  assert.equal(request.input.currency, "RUB");
  assert.match(request.inputHash, /^sha256:[0-9a-f]{64}$/u);
  assert.throws(
    () =>
      createProtectedComputeRequest({
        capability: "profitability.quote",
        version: 1,
        input: { ...VALID_INPUT, api_key: "ozon-secret" },
      }),
    (error) =>
      error instanceof ProtectedComputeError &&
      error.code === "PROTECTED_COMPUTE_SECRET_REJECTED",
  );
  assert.throws(
    () =>
      createProtectedComputeRequest({
        capability: "profitability.quote",
        version: 1,
        input: {
          ...VALID_INPUT,
          currency: "Bearer this-is-a-secret-token-value",
        },
      }),
    (error) => error.code === "PROTECTED_COMPUTE_SECRET_REJECTED",
  );
});

test("collection-pricing.quote@1 has an exact typed contract and signed binding", () => {
  assert.deepEqual(listProtectedComputeContracts(), [
    { capability: "profitability.quote", version: 1 },
    { capability: "collection-pricing.quote", version: 1 },
    { capability: "profit.ledger-batch", version: 1 },
  ]);
  const request = makeRequest({
    capability: "collection-pricing.quote",
    input: COLLECTION_PRICING_INPUT,
  });
  assert.equal(request.input.currency, "CNY");
  const envelope = signEnvelope(request);
  const collectionReplayGuard = new MemoryProtectedComputeReplayGuard();
  const verified = verifyProtectedComputeEnvelope(envelope, {
    expected: request,
    trustStore,
    replayGuard: collectionReplayGuard,
    revocationState: { minimumEpoch: 7 },
    now: () => NOW,
  });
  assert.equal(verified.result.suggestedPriceMinor, 4_627);
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(envelope, {
        expected: request,
        trustStore,
        replayGuard: collectionReplayGuard,
        now: () => NOW,
      }),
    (error) => error.code === "PROTECTED_COMPUTE_REPLAY_REJECTED",
  );
  const tampered = structuredClone(envelope);
  tampered.result.suggestedPriceMinor += 1;
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(tampered, {
        expected: request,
        trustStore,
        now: () => NOW,
      }),
    (error) => error.code === "PROTECTED_COMPUTE_SIGNATURE_INVALID",
  );
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(envelope, {
        expected: request,
        trustStore,
        revocationState: {
          revokedCapabilities: ["collection-pricing.quote@1"],
        },
        now: () => NOW,
      }),
    (error) => error.code === "PROTECTED_COMPUTE_RESULT_REVOKED",
  );
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(envelope, {
        expected: request,
        trustStore,
        now: () => new Date("2026-07-16T00:05:00.001Z"),
      }),
    (error) => error.code === "PROTECTED_COMPUTE_RESULT_EXPIRED",
  );
});

test("signature, input binding, expiry, revocation, and response replay fail closed", () => {
  const request = makeRequest();
  const envelope = signEnvelope(request);
  const replayGuard = new MemoryProtectedComputeReplayGuard();
  const verified = verifyProtectedComputeEnvelope(envelope, {
    expected: request,
    trustStore,
    replayGuard,
    revocationState: { minimumEpoch: 7 },
    now: () => NOW,
  });
  assert.equal(verified.signatureVerified, true);
  assert.equal(verified.source, "server-signed");
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(envelope, {
        expected: request,
        trustStore,
        replayGuard,
        now: () => NOW,
      }),
    (error) => error.code === "PROTECTED_COMPUTE_REPLAY_REJECTED",
  );

  const tampered = structuredClone(envelope);
  tampered.result.contributionMinor += 1;
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(tampered, {
        expected: request,
        trustStore,
        now: () => NOW,
      }),
    (error) => error.code === "PROTECTED_COMPUTE_SIGNATURE_INVALID",
  );
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(envelope, {
        expected: request,
        trustStore,
        revocationState: { revokedKeyIds: ["test-protected-v1"] },
        now: () => NOW,
      }),
    (error) => error.code === "PROTECTED_COMPUTE_RESULT_REVOKED",
  );
  const wrongResultContract = signEnvelope(request, {
    result: { contributionMinor: 1, hiddenPolicyCoefficient: 137 },
  });
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(wrongResultContract, {
        expected: request,
        trustStore,
        now: () => NOW,
      }),
    (error) => error.code === "PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID",
  );
  assert.throws(
    () =>
      verifyProtectedComputeEnvelope(envelope, {
        expected: request,
        trustStore,
        now: () => new Date("2026-07-16T00:05:00.001Z"),
      }),
    (error) => error.code === "PROTECTED_COMPUTE_RESULT_EXPIRED",
  );
});

test("client stores only verified envelopes and enforces signed offline use limits", async () => {
  let online = true;
  const client = createProtectedComputeClient({
    baseUrl: "https://compute.example.test",
    trustStore,
    accessTokenProvider: async () => "ephemeral-license-token",
    revocationProvider: async () => ({ minimumEpoch: 7 }),
    now: () => NOW,
    requestFactoryOptions: {
      requestIdFactory: () => "123e4567-e89b-12d3-a456-426614174111",
      nonceFactory: () => "b".repeat(43),
    },
    fetchImpl: async (_url, options) => {
      if (!online) throw new TypeError("network unavailable");
      assert.doesNotMatch(options.body, /ephemeral-license-token/u);
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify(signEnvelope(request)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const fresh = await client.execute({
    capability: "profitability.quote",
    version: 1,
    input: VALID_INPUT,
  });
  assert.equal(fresh.source, "server-signed");

  online = false;
  for (let use = 0; use < 3; use += 1) {
    const offline = await client.execute(
      {
        capability: "profitability.quote",
        version: 1,
        input: VALID_INPUT,
      },
      { allowOffline: true },
    );
    assert.equal(offline.source, "offline-signed");
    assert.equal(offline.onlineErrorCode, "PROTECTED_COMPUTE_NETWORK_UNAVAILABLE");
  }
  await assert.rejects(
    client.execute(
      {
        capability: "profitability.quote",
        version: 1,
        input: VALID_INPUT,
      },
      { allowOffline: true },
    ),
    (error) => error.code === "PROTECTED_COMPUTE_OFFLINE_USES_EXHAUSTED",
  );
});

test("invalid signed network response never falls back to a prior offline result", async () => {
  let responseCount = 0;
  const client = createProtectedComputeClient({
    baseUrl: "https://compute.example.test",
    trustStore,
    accessTokenProvider: async () => "ephemeral-license-token",
    now: () => NOW,
    requestFactoryOptions: {
      requestIdFactory: () => "123e4567-e89b-12d3-a456-426614174222",
      nonceFactory: () => "c".repeat(43),
    },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const envelope = signEnvelope(request);
      responseCount += 1;
      if (responseCount > 1) envelope.result.contributionMinor += 99;
      return new Response(JSON.stringify(envelope), { status: 200 });
    },
  });
  await client.execute({
    capability: "profitability.quote",
    version: 1,
    input: VALID_INPUT,
  });
  await assert.rejects(
    client.execute(
      {
        capability: "profitability.quote",
        version: 1,
        input: VALID_INPUT,
      },
      { allowOffline: true },
    ),
    (error) => error.code === "PROTECTED_COMPUTE_SIGNATURE_INVALID",
  );
});

test("production transport requires HTTPS and rejects embedded URL credentials", () => {
  for (const baseUrl of [
    "http://compute.example.test",
    "https://user:pass@compute.example.test",
    "https://compute.example.test?redirect=evil",
  ]) {
    assert.throws(
      () =>
        createProtectedComputeClient({
          baseUrl,
          trustStore,
          accessTokenProvider: async () => "token",
        }),
      (error) => error.code === "PROTECTED_COMPUTE_BASE_URL_INVALID",
    );
  }
});

test("server location and verifier keys come only from valid signed-public config", () => {
  const configTrustStore = createStaticProtectedComputeTrustStore({
    keys: { "config-root-v1": configurationKeyPair.publicKey },
  });
  const envelope = signedPublicConfig();
  const verified = verifySignedPublicProtectedComputeConfig(envelope, {
    configTrustStore,
    now: () => NOW,
  });
  assert.equal(verified.sourceClass, "signed-public");
  assert.equal(verified.signatureVerified, true);
  assert.equal(verified.serverBaseUrl, "https://compute.example.test");
  assert.ok(verified.trustStore.getPublicKey("test-protected-v1"));

  const tampered = structuredClone(envelope);
  tampered.serverBaseUrl = "https://attacker.example.test";
  assert.throws(
    () =>
      verifySignedPublicProtectedComputeConfig(tampered, {
        configTrustStore,
        now: () => NOW,
      }),
    (error) => error.code === "PROTECTED_COMPUTE_CONFIG_SIGNATURE_INVALID",
  );
  assert.throws(
    () =>
      verifySignedPublicProtectedComputeConfig(envelope, {
        configTrustStore,
        now: () => new Date("2026-07-17T00:00:00.001Z"),
      }),
    (error) => error.code === "PROTECTED_COMPUTE_CONFIG_EXPIRED",
  );
});

test("local-user settings can opt into offline reuse but cannot override server policy", () => {
  assert.deepEqual(normalizeProtectedComputeLocalUserSettings(), {
    offlineEnabled: false,
    sourceClass: "local-user",
  });
  assert.deepEqual(
    normalizeProtectedComputeLocalUserSettings({
      offlineEnabled: true,
      sourceClass: "local-user",
    }),
    { offlineEnabled: true, sourceClass: "local-user" },
  );
  assert.throws(
    () =>
      normalizeProtectedComputeLocalUserSettings({
        offlineEnabled: true,
        sourceClass: "local-user",
        serverBaseUrl: "https://attacker.example.test",
      }),
    (error) => error.code === "PROTECTED_COMPUTE_USER_SETTINGS_INVALID",
  );
});

test("signed-payload helper excludes only the signature field", () => {
  const envelope = signEnvelope(makeRequest());
  const payload = getProtectedComputeSignedPayload(envelope);
  assert.equal(payload.signature, undefined);
  assert.equal(Object.keys(envelope).length, Object.keys(payload).length + 1);
});

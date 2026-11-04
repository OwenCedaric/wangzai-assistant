import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../protectedCompute/canonicalJson.js';
import { createStaticProtectedComputeTrustStore } from '../protectedCompute/protectedComputeTrustStore.js';
import { createPaidCapabilityClient } from './paidCapabilityClient.js';

function signed(privateKey, value) {
  return {
    ...value,
    signature: sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64url'),
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createFixture({ mutateQuote, mutateResult, jobResponse, walletPoints = 100 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const calls = [];
  let quoteInputHash = '';
  const fetchImpl = async (url, options) => {
    const request = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, request });
    if (url.endsWith('/api/paid-capabilities/quote')) {
      quoteInputHash = `sha256:${'a'.repeat(64)}`;
      const unsigned = {
        capability: request.capability,
        contract: 'paid-capability-quote/v1',
        estimatedPoints: 7,
        expiresAt: '2026-08-04T12:05:00.000Z',
        inputHash: quoteInputHash,
        issuedAt: '2026-08-04T12:00:00.000Z',
        keyId: 'paid-test-key',
        maximumPoints: 9,
        nonce: request.nonce,
        quoteId: 'quote-123',
        requestId: request.requestId,
        signatureAlgorithm: 'Ed25519',
        version: 1,
      };
      return jsonResponse(mutateQuote ? mutateQuote(signed(privateKey, unsigned)) : signed(privateKey, unsigned));
    }
    if (url.endsWith('/api/points/wallet')) {
      return jsonResponse({
        balance_points: walletPoints,
        reserved_points: 0,
        available_points: walletPoints,
      });
    }
    if (jobResponse) return jobResponse(request);
    const unsigned = {
      capability: 'text.product-description',
      chargedPoints: 6,
      completedAt: '2026-08-04T12:00:03.000Z',
      contract: 'paid-capability-result/v1',
      inputHash: quoteInputHash,
      jobId: 'job-123',
      keyId: 'paid-test-key',
      nonce: request.nonce,
      offlinePolicy: { allowed: false, maxUses: 0, scope: 'none' },
      requestId: request.requestId,
      result: { content: '安全生成结果', usage: { inputTokens: 20, outputTokens: 8 } },
      signatureAlgorithm: 'Ed25519',
      status: 'completed',
      version: 1,
    };
    return jsonResponse(mutateResult ? mutateResult(signed(privateKey, unsigned)) : signed(privateKey, unsigned));
  };
  return {
    calls,
    client: createPaidCapabilityClient({
      baseUrl: 'https://license.example.test',
      fetchImpl,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
      trustStore: createStaticProtectedComputeTrustStore({ keys: { 'paid-test-key': publicKey } }),
    }),
  };
}

const validRequest = Object.freeze({
  capability: 'text.product-description',
  idempotencyKey: 'paid:test-request-12345678',
  input: { systemPrompt: '只按事实输出', userPrompt: '生成商品描述' },
  version: 1,
});

test('executes quote then job and accepts only signed non-offline result', async () => {
  const fixture = createFixture();
  const result = await fixture.client.execute(validRequest, { accessToken: 'license-token' });
  assert.equal(result.signatureVerified, true);
  assert.equal(result.source, 'paid-cloud');
  assert.equal(result.chargedPoints, 6);
  assert.equal(result.result.content, '安全生成结果');
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls[0].options.headers.authorization, 'Bearer license-token');
  assert.equal(fixture.calls[1].options.headers.authorization, 'Bearer license-token');
  assert.equal(fixture.calls[1].options.method, 'GET');
  assert.equal(fixture.calls[2].options.headers.authorization, 'Bearer license-token');
  assert.equal(fixture.calls[2].request.quoteId, 'quote-123');
  assert.equal(fixture.calls[2].request.inputHash, `sha256:${'a'.repeat(64)}`);
  assert.equal(fixture.calls[2].request.idempotencyKey, validRequest.idempotencyKey);
  assert.equal(fixture.calls[0].options.redirect, 'error');
  assert.equal(fixture.calls[1].options.redirect, 'error');
  assert.equal(fixture.calls[2].options.redirect, 'error');
});

test('rejects a forged quote before creating any billable job', async () => {
  const fixture = createFixture({
    mutateQuote: (quote) => ({ ...quote, estimatedPoints: quote.estimatedPoints + 1 }),
  });
  await assert.rejects(
    fixture.client.execute(validRequest, { accessToken: 'license-token' }),
    (error) => error.code === 'PAID_CAPABILITY_SIGNATURE_INVALID',
  );
  assert.equal(fixture.calls.length, 1);
});

test('rejects a forged paid result instead of exposing it to business code', async () => {
  const fixture = createFixture({
    mutateResult: (result) => ({ ...result, chargedPoints: 0 }),
  });
  await assert.rejects(
    fixture.client.execute(validRequest, { accessToken: 'license-token' }),
    (error) => error.code === 'PAID_CAPABILITY_SIGNATURE_INVALID',
  );
  assert.equal(fixture.calls.length, 3);
});

test('rejects any result that claims offline paid use', async () => {
  const fixture = createFixture({
    mutateResult: (result) => ({
      ...result,
      offlinePolicy: { allowed: true, maxUses: 1, scope: 'device' },
    }),
  });
  await assert.rejects(
    fixture.client.execute(validRequest, { accessToken: 'license-token' }),
    (error) => error.code === 'PAID_CAPABILITY_RESULT_INVALID',
  );
});

test('propagates insufficient points and never calls a provider from the client', async () => {
  const fixture = createFixture({ walletPoints: 0 });
  await assert.rejects(
    fixture.client.execute(validRequest, { accessToken: 'license-token' }),
    (error) => (
      error.code === 'POINT_BALANCE_INSUFFICIENT'
      && error.status === 402
      && error.message === '积分不足，请先充值积分。'
    ),
  );
  assert.equal(fixture.calls.length, 2);
  assert.match(fixture.calls[0].url, /\/api\/paid-capabilities\/quote$/u);
  assert.match(fixture.calls[1].url, /\/api\/points\/wallet$/u);
});

test('localizes an authoritative reservation race after the wallet preflight passes', async () => {
  const fixture = createFixture({
    jobResponse: () => jsonResponse({ detail: { code: 'POINT_BALANCE_INSUFFICIENT' } }, 402),
  });
  await assert.rejects(
    fixture.client.execute(validRequest, { accessToken: 'license-token' }),
    (error) => (
      error.code === 'POINT_BALANCE_INSUFFICIENT'
      && error.status === 402
      && error.message === '积分不足，请先充值积分。'
    ),
  );
  assert.equal(fixture.calls.length, 3);
});

test('localizes a rejected paid image source without exposing the generic English gateway error', async () => {
  const fixture = createFixture({
    jobResponse: () => jsonResponse({
      detail: {
        code: 'PAID_CAPABILITY_SOURCE_IMAGE_REJECTED',
        message: 'private provider detail must not be exposed',
      },
    }, 422),
  });
  await assert.rejects(
    fixture.client.execute(validRequest, { accessToken: 'license-token' }),
    (error) => (
      error.code === 'PAID_CAPABILITY_SOURCE_IMAGE_REJECTED'
      && error.status === 422
      && error.message === '生图源图片无法被网关读取，请刷新图片后重试。'
      && !error.message.includes('Paid capability server rejected')
      && !error.message.includes('private provider detail')
    ),
  );
  assert.equal(fixture.calls.length, 3);
});

test('rejects unsupported capabilities before any network request', async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.client.execute({ ...validRequest, capability: 'text.free-bypass' }, { accessToken: 'license-token' }),
    (error) => error.code === 'PAID_CAPABILITY_UNSUPPORTED',
  );
  assert.equal(fixture.calls.length, 0);
});

test('requires a license token before sending the first request', async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.client.execute(validRequest, { accessToken: '' }),
    (error) => error.code === 'PAID_CAPABILITY_AUTH_UNAVAILABLE',
  );
  assert.equal(fixture.calls.length, 0);
});

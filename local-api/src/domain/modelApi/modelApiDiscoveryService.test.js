import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelApiDiscoveryService } from './modelApiDiscoveryService.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => '512' },
    json: async () => payload,
  };
}

test('discovers an OpenAI-compatible model endpoint and returns sanitized capabilities', async () => {
  const calls = [];
  const service = createModelApiDiscoveryService({
    lookupImpl: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        data: [
          {
            id: 'gpt-image-2',
            capabilities: ['images/edits', 'images/generations'],
            modalities: ['text', 'image'],
            options: { quality: ['draft', { id: 'high', label: '高清' }] },
          },
          { id: 'gpt-text', capabilities: ['chat'], modalities: ['text'] },
          { id: 'gpt-image-2-adobe' },
          { id: 'gemini-banana-2.0-pro' },
        ],
      });
    },
    now: () => new Date('2026-07-18T00:00:00.000Z'),
  });

  const result = await service.discover({
    websiteUrl: 'https://relay.example/personal/dashboard',
    apiKey: 'secret-api-key',
  });

  assert.equal(result.updates.baseUrl, 'https://relay.example/v1');
  assert.equal(result.updates.defaultModel, 'gpt-image-2');
  assert.equal(result.updates.discoveryVerified, true);
  assert.deepEqual(result.updates.capabilities, ['image-edit', 'image-generation', 'multimodal', 'text-generation']);
  assert.equal(result.updates.availableModels.length, 4);
  assert.deepEqual(result.updates.availableModels[0].options.quality, [
    { id: 'draft', label: 'draft' },
    { id: 'high', label: '高清' },
  ]);
  assert.equal(
    result.updates.availableModels.find((model) => model.id === 'gemini-banana-2.0-pro').capabilities.includes('image-generation'),
    true,
  );
  assert.equal(calls[0].url, 'https://relay.example/v1/models');
  assert.equal(JSON.stringify(result).includes('secret-api-key'), false);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-api-key');
});

test('uses a known provider fallback without exposing credentials when model listing is temporarily unavailable', async () => {
  const service = createModelApiDiscoveryService({
    lookupImpl: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async () => {
      throw new Error('temporary network failure');
    },
  });

  const result = await service.discover({
    websiteUrl: 'https://images.example.invalid/personal/dashboard',
    apiKey: 'secret-api-key',
  });

  assert.equal(result.updates.baseUrl, 'https://images.example.invalid/v1');
  assert.equal(result.updates.availableModels[0].id, 'gpt-image-2');
  assert.equal(result.updates.discoveryVerified, false);
  assert.equal(JSON.stringify(result).includes('secret-api-key'), false);
});

test('rejects loopback discovery URLs before making a network request', async () => {
  let called = false;
  const service = createModelApiDiscoveryService({
    fetchImpl: async () => {
      called = true;
      return response({});
    },
  });

  await assert.rejects(
    service.discover({ websiteUrl: 'https://127.0.0.1/dashboard', apiKey: 'secret' }),
    /本机或内网/,
  );
  assert.equal(called, false);
});

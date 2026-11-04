import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductDescriptionService } from './productDescriptionService.js';

function createRepository(model = 'gpt-5.5') {
  return {
    getAccountForInternalUse(accountId) {
      if (accountId !== 'text-account') return null;
      return {
        id: accountId,
        baseUrl: 'https://relay.example/v1',
        apiKey: 'secret-key',
        discoveryVerified: true,
        availableModels: [{ id: model, capabilities: ['text-generation'] }],
      };
    },
  };
}

test('generates a Russian product description with the configured GPT-5.5 account', async () => {
  let request = null;
  const service = createProductDescriptionService({
    modelApiAccountRepository: createRepository(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Практичное описание товара.' } }] }),
      };
    },
  });
  const result = await service.generateDescription({
    accountId: 'text-account',
    model: 'gpt-5.5',
    systemPrompt: 'Пиши по-русски.',
    userPrompt: 'Товар: термос.',
  });
  assert.equal(result.description, 'Практичное описание товара.');
  assert.equal(request.url, 'https://relay.example/v1/chat/completions');
  assert.equal(JSON.parse(request.options.body).model, 'gpt-5.5');
});

test('rejects a configured model that is not a text model', async () => {
  const service = createProductDescriptionService({
    modelApiAccountRepository: {
      getAccountForInternalUse: () => ({
        id: 'text-account',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'secret-key',
        discoveryVerified: true,
        availableModels: [{ id: 'image-model', capabilities: ['image-generation'] }],
      }),
    },
    fetchImpl: async () => {
      throw new Error('must not call');
    },
  });
  await assert.rejects(
    service.generateDescription({
      accountId: 'text-account',
      model: 'image-model',
      systemPrompt: 'system',
      userPrompt: 'user',
    }),
    /不是文本生成模型/u,
  );
});

test('uses signed paid capability when the saved API was never verified', async () => {
  let byokCalled = false;
  let paidRequest = null;
  const service = createProductDescriptionService({
    modelApiAccountRepository: {
      getAccountForInternalUse: () => ({
        id: 'unverified-account',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'saved-but-unverified',
        discoveryVerified: false,
      }),
    },
    paidCapabilityAccess: {
      execute: async (request) => {
        paidRequest = request;
        return { chargedPoints: 9, result: { text: '积分生成结果' } };
      },
    },
    fetchImpl: async () => { byokCalled = true; },
  });
  const result = await service.generateDescription({
    accountId: 'unverified-account',
    model: 'gpt-5.6',
    systemPrompt: 'system',
    userPrompt: 'user',
  }, { accessToken: 'license-token' });
  assert.equal(byokCalled, false);
  assert.equal(paidRequest.capability, 'text.product-description');
  assert.equal(result.description, '积分生成结果');
  assert.deepEqual(result.billing, { chargedPoints: 9, source: 'paid-cloud' });
});

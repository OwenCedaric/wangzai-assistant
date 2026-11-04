import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDataAnalysisInsightService,
  DATA_ANALYSIS_INSIGHT_MAX_ATTEMPTS,
  DATA_ANALYSIS_INSIGHT_MODEL_TIMEOUT_MS,
} from './dataAnalysisInsightService.js';

function createService(fetchImpl) {
  return createDataAnalysisInsightService({
    dataAnalysisService: {
      readCache: () => ({
        ok: true,
        dashboard: {
          shopId: 'shop-1',
          range: { startDate: '2026-07-01', endDate: '2026-07-21' },
          generatedAt: '2026-07-21T00:00:00.000Z',
          sourceUpdatedAt: '2026-07-20T23:00:00.000Z',
          sales: {
            rowCount: 12,
            metrics: [{ id: 'salesAmount', label: '销售额', value: 1200, unit: 'money', currency: 'RUB', status: 'confirmed' }],
            productRanking: [{ rank: 1, offerId: 'offer-1', name: '保温杯', quantity: 8, sales: { value: 1200, currency: 'RUB', status: 'confirmed' } }],
          },
          afterSales: { recentRows: [{ returnId: 'return-1', productName: '保温杯', postingNumber: 'posting-1' }] },
          diagnostics: [{ id: 'sales', level: 'info', message: '数据正常' }],
        },
      }),
    },
    modelApiAccountRepository: {
      getAccountForInternalUse: () => ({
        apiKey: 'secret',
        baseUrl: 'https://text.example/v1',
        discoveryVerified: true,
        availableModels: [{ id: 'gpt-5.5', capabilities: ['text-generation'] }],
      }),
    },
    fetchImpl,
  });
}

test('generates an insight from the selected shop/date range without an uploaded file', async () => {
  let request;
  const service = createService(async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '总体销售正常，重点关注库存。' } }], usage: { total_tokens: 12 } }),
    };
  });

  const result = await service.generate({
    accountId: 'text-account',
    model: 'gpt-5.5',
    shopId: 'shop-1',
    startDate: '2026-07-01',
    endDate: '2026-07-21',
  });

  assert.equal(result.ok, true);
  assert.equal(result.insight, '总体销售正常，重点关注库存。');
  assert.deepEqual(result.query, {
    shopId: 'shop-1',
    analysisType: 'all',
    sourceType: 'all',
    startDate: '2026-07-01',
    endDate: '2026-07-21',
    limit: 50,
  });
  assert.match(request.messages[1].content, /保温杯/u);
  assert.doesNotMatch(request.messages[1].content, /secret/u);
});

test('rejects a non-text model before making an external request', async () => {
  const service = createDataAnalysisInsightService({
    dataAnalysisService: { readCache: () => ({ ok: true, dashboard: {} }) },
    modelApiAccountRepository: {
      getAccountForInternalUse: () => ({
        apiKey: 'secret',
        baseUrl: 'https://image.example/v1',
        discoveryVerified: true,
        availableModels: [{ id: 'gpt-image-2', capabilities: ['image-generation'] }],
      }),
    },
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });

  await assert.rejects(
    service.generate({ accountId: 'image-account', model: 'gpt-image-2' }),
    /不是文本生成模型/u,
  );
});

test('keeps a longer model window and returns a readable timeout message', async () => {
  assert.equal(DATA_ANALYSIS_INSIGHT_MODEL_TIMEOUT_MS, 270_000);
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  const service = createService(async () => {
    throw timeout;
  });

  await assert.rejects(
    service.generate({
      accountId: 'text-account',
      model: 'gpt-5.5',
      shopId: 'shop-1',
      startDate: '2026-07-01',
      endDate: '2026-07-21',
    }),
    /分析模型响应时间较长，本次店铺数据仍然保留/u,
  );
});

test('retries one transient provider failure and returns the completed report', async () => {
  assert.equal(DATA_ANALYSIS_INSIGHT_MAX_ATTEMPTS, 2);
  let calls = 0;
  const service = createService(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({ error: { code: 'service_busy', message: 'temporarily unavailable' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '重试后完成经营分析。' } }] }),
    };
  });

  const result = await service.generate({
    accountId: 'text-account',
    model: 'gpt-5.5',
    shopId: 'shop-1',
  });

  assert.equal(calls, 2);
  assert.equal(result.insight, '重试后完成经营分析。');
});

test('translates provider authentication failures instead of exposing the raw response', async () => {
  const service = createService(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { code: 'invalid_api_key', message: 'Invalid API key abc123' } }),
  }));

  await assert.rejects(
    service.generate({ accountId: 'text-account', model: 'gpt-5.5', shopId: 'shop-1' }),
    /文本模型接口验证失败/u,
  );
});

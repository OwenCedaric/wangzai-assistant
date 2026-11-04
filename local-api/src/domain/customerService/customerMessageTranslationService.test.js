import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerMessageTranslationService } from './customerMessageTranslationService.js';

function translatedResponse(
  text = '你好',
  url = 'https://api.mymemory.translated.net/get',
) {
  const isMyMemory = String(url).includes('mymemory');
  return {
    ok: true,
    status: 200,
    async json() {
      return isMyMemory
        ? { responseStatus: 200, responseData: { translatedText: text } }
        : [[[text]], 'ru'];
    },
  };
}

test('deduplicates identical text and reuses the bounded memory cache', async () => {
  let calls = 0;
  const service = createCustomerMessageTranslationService({
    fetchImpl: async (url) => {
      calls += 1;
      return translatedResponse('你好', url);
    },
    sleepImpl: async () => {},
    logger: { warn() {} },
  });

  const first = await service.translateMessages({
    messages: [
      { id: 'message-1', text: 'Здравствуйте' },
      { id: 'message-2', text: 'Здравствуйте' },
    ],
  });
  const second = await service.translateMessages({
    messages: [{ id: 'message-3', text: 'Здравствуйте' }],
  });

  assert.equal(calls, 1);
  assert.equal(first.translatedCount, 2);
  assert.equal(first.rows[0].translatedText, '你好');
  assert.equal(first.rows[1].translatedText, '你好');
  assert.equal(second.rows[0].cacheHit, true);
});

test('retries only transient HTTP failures and succeeds after a short backoff', async () => {
  let calls = 0;
  const service = createCustomerMessageTranslationService({
    fetchImpl: async (url) => {
      calls += 1;
      if (calls < 3)
        return { ok: false, status: calls === 1 ? 429 : 503, headers: {} };
      return translatedResponse('你好', url);
    },
    sleepImpl: async () => {},
  });

  const result = await service.translateMessages({
    messages: [{ id: 'message-1', text: 'Привет' }],
  });
  assert.equal(calls, 3);
  assert.equal(result.rows[0].translatedText, '你好');
  assert.equal(result.rows[0].error, undefined);
});

test('switches to Google immediately when MyMemory is rate limited', async () => {
  let calls = 0;
  const service = createCustomerMessageTranslationService({
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('mymemory')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { responseStatus: 429, quotaFinished: true };
          },
        };
      }
      return translatedResponse('你好', url);
    },
    sleepImpl: async () => {},
  });

  const result = await service.translateMessages({
    messages: [{ id: 'message-1', text: 'Привет' }],
  });
  assert.equal(calls, 2);
  assert.equal(result.rows[0].provider, 'google-translate');
  assert.equal(result.rows[0].translatedText, '你好');
});

test('does not retry permanent client errors', async () => {
  let calls = 0;
  const service = createCustomerMessageTranslationService({
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 400, headers: {} };
    },
    sleepImpl: async () => {},
  });

  const result = await service.translateMessages({
    messages: [{ id: 'message-1', text: 'Привет' }],
  });
  assert.equal(calls, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.rows[0].translatedText, 'Привет');
  assert.equal(result.rows[0].retryable, false);
});

test('shares an in-flight request when two batches ask for the same text', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = createCustomerMessageTranslationService({
    fetchImpl: async (url) => {
      calls += 1;
      await gate;
      return translatedResponse('你好', url);
    },
    sleepImpl: async () => {},
  });

  const first = service.translateMessages({
    messages: [{ id: 'first', text: 'Спасибо' }],
  });
  const second = service.translateMessages({
    messages: [{ id: 'second', text: 'Спасибо' }],
  });
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(firstResult.rows[0].translatedText, '你好');
  assert.equal(secondResult.rows[0].translatedText, '你好');
});

test('gives queued texts an independent timeout after their worker actually starts', async () => {
  let calls = 0;
  const service = createCustomerMessageTranslationService({
    requestTimeoutMs: 100,
    batchTimeoutMs: 60,
    maxAttempts: 1,
    concurrency: 1,
    fetchImpl: async (url) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return translatedResponse(`中文-${calls}`, url);
    },
    sleepImpl: async () => {},
    logger: { warn() {} },
  });

  const result = await service.translateMessages({
    messages: [
      { id: 'first', text: 'Первое сообщение' },
      { id: 'second', text: 'Второе сообщение' },
    ],
  });

  assert.equal(calls, 2);
  assert.equal(result.translatedCount, 2);
  assert.equal(result.failedCount, 0);
});

test('temporarily skips MyMemory after its quota is exhausted', async () => {
  const providers = [];
  const service = createCustomerMessageTranslationService({
    concurrency: 1,
    maxAttempts: 1,
    fetchImpl: async (url) => {
      const provider = String(url).includes('mymemory') ? 'mymemory' : 'google';
      providers.push(provider);
      if (provider === 'mymemory') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { responseStatus: 429, quotaFinished: true };
          },
        };
      }
      return translatedResponse('你好', url);
    },
    sleepImpl: async () => {},
    logger: { warn() {} },
  });

  const result = await service.translateMessages({
    messages: [
      { id: 'first', text: 'Первое сообщение' },
      { id: 'second', text: 'Второе сообщение' },
    ],
  });

  assert.deepEqual(providers, ['mymemory', 'google', 'google']);
  assert.equal(result.translatedCount, 2);
});

test('cancels the active text and does not start queued texts after request abort', async () => {
  let calls = 0;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const service = createCustomerMessageTranslationService({
    concurrency: 1,
    requestTimeoutMs: 1_000,
    textTimeoutMs: 2_000,
    maxAttempts: 1,
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      notifyStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('aborted'), {
                name: 'AbortError',
                code: 20,
              }),
            ),
          { once: true },
        );
      });
    },
    sleepImpl: async () => {},
    logger: { warn() {} },
  });
  const controller = new AbortController();
  const pending = service.translateMessages({
    signal: controller.signal,
    messages: [
      { id: 'first', text: 'Первое сообщение' },
      { id: 'second', text: 'Второе сообщение' },
    ],
  });
  await started;
  controller.abort();
  const result = await pending;

  assert.equal(calls, 1);
  assert.deepEqual(
    result.rows.map((row) => row.errorCode),
    ['CUSTOMER_TRANSLATION_ABORTED', 'CUSTOMER_TRANSLATION_ABORTED'],
  );
});

test('returns the original text after a bounded timeout instead of hanging', async () => {
  let calls = 0;
  const service = createCustomerMessageTranslationService({
    requestTimeoutMs: 5,
    batchTimeoutMs: 25,
    maxAttempts: 1,
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    },
    sleepImpl: async () => {},
  });

  const result = await service.translateMessages({
    messages: [{ id: 'message-1', text: 'Добрый день' }],
  });
  assert.equal(calls, 2);
  assert.equal(result.rows[0].translatedText, 'Добрый день');
  assert.equal(result.rows[0].error, '翻译未完成，请重试。');
});

test('splits long Russian text within the provider byte limit', async () => {
  const queryByteLengths = [];
  const service = createCustomerMessageTranslationService({
    fetchImpl: async (url) => {
      queryByteLengths.push(
        new TextEncoder().encode(url.searchParams.get('q')).length,
      );
      return translatedResponse('长文片段', url);
    },
    sleepImpl: async () => {},
  });
  const longText = 'Сообщение '.repeat(90);
  const result = await service.translateMessages({
    messages: [{ id: 'long', text: longText }],
  });

  assert.equal(queryByteLengths.length > 1, true);
  assert.equal(
    queryByteLengths.every((length) => length <= 450),
    true,
  );
  assert.equal(result.rows[0].translated, true);
});

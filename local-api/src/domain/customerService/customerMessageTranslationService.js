const GOOGLE_TRANSLATION_ENDPOINT =
  'https://translate.googleapis.com/translate_a/single';
const MYMEMORY_TRANSLATION_ENDPOINT = 'https://api.mymemory.translated.net/get';
const MYMEMORY_MAX_QUERY_BYTES = 450;
const MAX_TRANSLATION_ROWS = 100;
const MAX_TRANSLATION_TEXT_LENGTH = 4000;
const MAX_MEMORY_CACHE_ROWS = 500;
const MAX_IN_FLIGHT_ROWS = 200;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 4_500;
const DEFAULT_TEXT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAYS_MS = [300];
const MYMEMORY_RATE_LIMIT_COOLDOWN_MS = 60_000;

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
}

function containsCyrillic(value = '') {
  return /[\u0400-\u04FF]/u.test(String(value));
}

function containsChinese(value = '') {
  return /[\u3400-\u9FFF]/u.test(String(value));
}

function extractGoogleTranslatedText(payload) {
  const segments = Array.isArray(payload?.[0]) ? payload[0] : [];
  return segments
    .map((segment) => normalizeText(segment?.[0]))
    .filter(Boolean)
    .join('')
    .trim();
}

function utf8Length(value) {
  return new TextEncoder().encode(String(value ?? '')).length;
}

function createTranslationMemoryCache() {
  // Each service instance owns its own bounded cache; translations never leak across instances.

  const memoryCache = new Map();
  return memoryCache;
}

function splitTranslationText(value, maxBytes = MYMEMORY_MAX_QUERY_BYTES) {
  const text = normalizeText(value);
  if (!text || utf8Length(text) <= maxBytes) return text ? [text] : [];
  const chunks = [];
  let current = '';
  for (const character of text) {
    if (current && utf8Length(`${current}${character}`) > maxBytes) {
      chunks.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function createCacheKey(text) {
  return `ru:zh-CN:${normalizeText(text)}`;
}

function cleanProviderTranslation(sourceText, translatedText) {
  let result = normalizeText(translatedText);
  if (!/^[,，]/u.test(normalizeText(sourceText)) && /^[,，]/u.test(result)) {
    result = result.replace(/^[,，]\s*/u, '');
  }
  return result;
}

function createTranslationError(
  message,
  { code, retryable = false, status = null } = {},
) {
  const error = new Error(message);
  error.code = code || 'CUSTOMER_TRANSLATION_FAILED';
  error.retryable = retryable;
  error.status = status;
  return error;
}

function isRetryableTranslationError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const status = Number(error?.status);
  if (status === 429 || status >= 500) return true;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
    return true;
  return error instanceof TypeError;
}

function waitWithSignal(delayMs, signal) {
  if (!delayMs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        createTranslationError('翻译批次已结束。', {
          code: 'CUSTOMER_TRANSLATION_ABORTED',
        }),
      );
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          createTranslationError('翻译批次已结束。', {
            code: 'CUSTOMER_TRANSLATION_ABORTED',
          }),
        );
      },
      { once: true },
    );
  });
}

function createLinkedTimeout(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    abort() {
      controller.abort();
    },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function waitForSharedTranslation(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      createTranslationError('翻译请求已取消。', {
        code: 'CUSTOMER_TRANSLATION_ABORTED',
      }),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(
        createTranslationError('翻译请求已取消。', {
          code: 'CUSTOMER_TRANSLATION_ABORTED',
        }),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

async function mapWithConcurrency(rows, limit, mapper) {
  const results = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(rows[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, rows.length) }, () => worker()),
  );
  return results;
}

export function createCustomerMessageTranslationService({
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  textTimeoutMs = DEFAULT_TEXT_TIMEOUT_MS,
  batchTimeoutMs,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  concurrency = DEFAULT_CONCURRENCY,
  sleepImpl = waitWithSignal,
  logger = console,
} = {}) {
  const memoryCache = createTranslationMemoryCache();
  const inFlight = new Map();
  let myMemoryUnavailableUntil = 0;
  const effectiveTextTimeoutMs = Math.max(
    1_000,
    Number(batchTimeoutMs ?? textTimeoutMs) || DEFAULT_TEXT_TIMEOUT_MS,
  );

  function logTranslationFailure(error, text) {
    try {
      logger?.warn?.('[customer-translation-failed]', {
        code: normalizeText(error?.code) || 'CUSTOMER_TRANSLATION_FAILED',
        status: Number(error?.status) || null,
        provider: normalizeText(error?.provider) || 'unknown',
        attempt: Number(error?.attempt) || null,
        textLength: normalizeText(text).length,
      });
    } catch {
      // Diagnostics must never break the translation response.
    }
  }

  function remember(key, value) {
    if (memoryCache.has(key)) memoryCache.delete(key);
    while (memoryCache.size >= MAX_MEMORY_CACHE_ROWS) {
      memoryCache.delete(memoryCache.keys().next().value);
    }
    memoryCache.set(key, value);
  }

  async function requestJson(url, signal) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      const status = Number(response.status) || 0;
      throw createTranslationError(`HTTP ${status}`, {
        code: 'CUSTOMER_TRANSLATION_HTTP_ERROR',
        status,
        retryable: status === 429 || status >= 500,
      });
    }
    try {
      return await response.json();
    } catch {
      throw createTranslationError('翻译服务返回格式无效。', {
        code: 'CUSTOMER_TRANSLATION_INVALID_RESPONSE',
        status: Number(response.status) || null,
        retryable: true,
      });
    }
  }

  async function requestMyMemoryTranslation(text, signal) {
    const chunks = splitTranslationText(text);
    const translatedChunks = await mapWithConcurrency(
      chunks,
      2,
      async (chunk) => {
        const url = new URL(MYMEMORY_TRANSLATION_ENDPOINT);
        url.searchParams.set('q', chunk);
        url.searchParams.set('langpair', 'ru|zh-CN');
        url.searchParams.set('mt', '1');
        const payload = await requestJson(url, signal);
        const responseStatus = Number(payload?.responseStatus) || 0;
        if (
          payload?.quotaFinished ||
          responseStatus === 429 ||
          responseStatus === 403
        ) {
          throw createTranslationError('翻译服务请求频率受限。', {
            code: 'CUSTOMER_TRANSLATION_RATE_LIMITED',
            status: 429,
            retryable: true,
          });
        }
        if (responseStatus && responseStatus !== 200) {
          throw createTranslationError('翻译服务没有返回有效结果。', {
            code: 'CUSTOMER_TRANSLATION_PROVIDER_ERROR',
            status: responseStatus,
            retryable: responseStatus >= 500,
          });
        }
        const translatedText = normalizeText(
          payload?.responseData?.translatedText,
        );
        if (!translatedText) {
          throw createTranslationError('翻译结果为空。', {
            code: 'CUSTOMER_TRANSLATION_EMPTY_RESULT',
            retryable: false,
          });
        }
        return translatedText;
      },
    );
    return {
      translatedText: translatedChunks.join(''),
      sourceLanguage: 'ru',
      provider: 'mymemory',
    };
  }

  async function requestGoogleTranslation(text, signal) {
    const chunks = splitTranslationText(text);
    const translatedChunks = await mapWithConcurrency(
      chunks,
      2,
      async (chunk) => {
        const url = new URL(GOOGLE_TRANSLATION_ENDPOINT);
        url.searchParams.set('client', 'gtx');
        url.searchParams.set('sl', 'ru');
        url.searchParams.set('tl', 'zh-CN');
        url.searchParams.set('dt', 't');
        url.searchParams.set('q', chunk);
        const payload = await requestJson(url, signal);
        const translatedText = extractGoogleTranslatedText(payload);
        if (!translatedText) {
          throw createTranslationError('翻译结果为空。', {
            code: 'CUSTOMER_TRANSLATION_EMPTY_RESULT',
            retryable: false,
          });
        }
        return {
          translatedText,
          sourceLanguage: normalizeText(payload?.[1] ?? payload?.[2]) || 'ru',
        };
      },
    );
    return {
      translatedText: translatedChunks
        .map((chunk) => chunk.translatedText)
        .join(''),
      sourceLanguage: translatedChunks[0]?.sourceLanguage || 'ru',
      provider: 'google-translate',
    };
  }

  async function requestTranslation(text, signal) {
    const providers = () => [
      ...(Date.now() >= myMemoryUnavailableUntil
        ? [{ name: 'mymemory', request: requestMyMemoryTranslation }]
        : []),
      { name: 'google-translate', request: requestGoogleTranslation },
    ];
    let lastError = null;
    const attemptsLimit = Math.max(1, maxAttempts);
    for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
      if (signal?.aborted) {
        throw createTranslationError('翻译批次已结束。', {
          code: 'CUSTOMER_TRANSLATION_ABORTED',
        });
      }

      let retryableFailure = false;
      for (const provider of providers()) {
        if (signal?.aborted) {
          throw createTranslationError('翻译请求已取消。', {
            code: 'CUSTOMER_TRANSLATION_ABORTED',
          });
        }
        const timeout = createLinkedTimeout(
          signal,
          Math.max(250, requestTimeoutMs),
        );
        try {
          const providerResult = await provider.request(text, timeout.signal);
          const translatedText = cleanProviderTranslation(
            text,
            providerResult.translatedText,
          );
          if (normalizeText(translatedText) === normalizeText(text)) {
            throw createTranslationError('翻译服务返回了未转换的原文。', {
              code: 'CUSTOMER_TRANSLATION_UNCHANGED_RESULT',
              retryable: true,
            });
          }
          return {
            translatedText,
            translated: translatedText !== text,
            skipped: false,
            sourceLanguage: providerResult.sourceLanguage,
            provider: providerResult.provider || provider.name,
            attempts: attempt,
          };
        } catch (error) {
          lastError = timeout.didTimeOut()
            ? createTranslationError('翻译请求超时。', {
                code: 'CUSTOMER_TRANSLATION_TIMEOUT',
                retryable: true,
              })
            : signal?.aborted || error?.name === 'AbortError'
              ? createTranslationError('翻译请求已取消。', {
                  code: 'CUSTOMER_TRANSLATION_ABORTED',
                })
              : error;
          if (!lastError || typeof lastError !== 'object') {
            lastError = createTranslationError(
              String(lastError || '翻译未完成。'),
              {
                retryable: true,
              },
            );
          }
          lastError.provider = provider.name;
          lastError.attempt = attempt;
          if (
            provider.name === 'mymemory' &&
            (lastError.code === 'CUSTOMER_TRANSLATION_RATE_LIMITED' ||
              Number(lastError.status) === 429 ||
              Number(lastError.status) === 403)
          ) {
            myMemoryUnavailableUntil =
              Date.now() + MYMEMORY_RATE_LIMIT_COOLDOWN_MS;
          }
          if (signal?.aborted) throw lastError;
          retryableFailure =
            retryableFailure || isRetryableTranslationError(lastError);
        } finally {
          timeout.cleanup();
        }
      }

      if (!retryableFailure || attempt >= attemptsLimit || signal?.aborted) {
        throw lastError;
      }
      await sleepImpl(
        retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0,
        signal,
      );
    }
    throw lastError || createTranslationError('翻译未完成。');
  }

  async function translateUniqueText(text, signal) {
    const cacheKey = createCacheKey(text);
    if (memoryCache.has(cacheKey)) {
      return { ...memoryCache.get(cacheKey), cacheHit: true };
    }
    if (signal?.aborted) {
      throw createTranslationError('翻译请求已取消。', {
        code: 'CUSTOMER_TRANSLATION_ABORTED',
      });
    }
    if (typeof fetchImpl !== 'function') {
      throw createTranslationError('翻译服务未连接。', {
        code: 'CUSTOMER_TRANSLATION_NOT_CONNECTED',
        retryable: false,
      });
    }

    let entry = inFlight.get(cacheKey);
    let sharedRequest = Boolean(entry);
    if (!entry) {
      const deadline = createLinkedTimeout(null, effectiveTextTimeoutMs);
      entry = {
        promise: null,
        deadline,
        subscribers: 0,
        settled: false,
      };
      entry.promise = requestTranslation(text, deadline.signal)
        .catch((error) => {
          if (deadline.didTimeOut()) {
            throw createTranslationError('单条翻译超过处理时限。', {
              code: 'CUSTOMER_TRANSLATION_TIMEOUT',
              retryable: true,
            });
          }
          throw error;
        })
        .then((result) => {
          remember(cacheKey, result);
          return result;
        })
        .finally(() => {
          entry.settled = true;
          deadline.cleanup();
          if (inFlight.get(cacheKey) === entry) inFlight.delete(cacheKey);
        });
      if (inFlight.size < MAX_IN_FLIGHT_ROWS) inFlight.set(cacheKey, entry);
    }

    entry.subscribers += 1;
    try {
      return {
        ...(await waitForSharedTranslation(entry.promise, signal)),
        cacheHit: false,
        ...(sharedRequest ? { sharedRequest: true } : {}),
      };
    } finally {
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0 && !entry.settled && signal?.aborted) {
        entry.deadline.abort();
      }
    }
  }

  async function translateMessages(input = {}) {
    const sourceRows = Array.isArray(input.messages)
      ? input.messages.slice(0, MAX_TRANSLATION_ROWS)
      : [];
    const rows = sourceRows.map((row) => ({
      id: normalizeText(row?.id),
      text: normalizeText(row?.text).slice(0, MAX_TRANSLATION_TEXT_LENGTH),
    }));
    const results = new Array(rows.length);
    const groups = new Map();

    rows.forEach((row, index) => {
      if (!row.id || !row.text) {
        results[index] = {
          ...row,
          translatedText: row.text,
          translated: false,
          skipped: true,
        };
        return;
      }
      if (!containsCyrillic(row.text)) {
        results[index] = {
          ...row,
          translatedText: row.text,
          translated: false,
          skipped: true,
          sourceLanguage: containsChinese(row.text) ? 'zh' : 'unknown',
        };
        return;
      }
      const cacheKey = createCacheKey(row.text);
      const group = groups.get(cacheKey) || { text: row.text, indexes: [] };
      group.indexes.push(index);
      groups.set(cacheKey, group);
    });

    const inputSignal =
      input.signal instanceof AbortSignal ? input.signal : null;
    const uniqueGroups = [...groups.values()];
    const uniqueResults = await mapWithConcurrency(
      uniqueGroups,
      Math.max(
        1,
        Math.min(
          Number(concurrency) || DEFAULT_CONCURRENCY,
          DEFAULT_CONCURRENCY,
        ),
      ),
      async (group) => {
        try {
          return {
            ok: true,
            result: await translateUniqueText(group.text, inputSignal),
          };
        } catch (error) {
          logTranslationFailure(error, group.text);
          return {
            ok: false,
            error: {
              code: normalizeText(error?.code) || 'CUSTOMER_TRANSLATION_FAILED',
              message: '翻译未完成，请重试。',
              retryable: isRetryableTranslationError(error),
            },
          };
        }
      },
    );

    uniqueGroups.forEach((group, groupIndex) => {
      const outcome = uniqueResults[groupIndex];
      for (const index of group.indexes) {
        const row = rows[index];
        results[index] = outcome?.ok
          ? { ...row, ...outcome.result }
          : {
              ...row,
              translatedText: row.text,
              translated: false,
              skipped: false,
              error: outcome?.error?.message || '翻译未完成，请重试。',
              errorCode: outcome?.error?.code || 'CUSTOMER_TRANSLATION_FAILED',
              retryable: outcome?.error?.retryable === true,
            };
      }
    });

    return {
      ok: true,
      sourceLanguage: 'ru',
      targetLanguage: 'zh-CN',
      provider: 'mymemory+google-fallback',
      rows: results,
      translatedCount: results.filter((row) => row?.translated).length,
      failedCount: results.filter((row) => row?.error).length,
      uniqueRequestCount: groups.size,
    };
  }

  return { translateMessages };
}

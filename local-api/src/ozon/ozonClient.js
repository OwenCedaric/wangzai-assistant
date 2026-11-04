import { getOzonEndpoint, assertReadOnlyEndpoint, assertWriteEndpoint } from './ozonEndpointRegistry.js';
import { safeLog, safeLogPayload } from '../security/safeLog.js';
import { stripJsonBom } from '../utils/jsonText.js';

const DEFAULT_BASE_URL = 'https://api-seller.ozon.ru';
const DEFAULT_RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeCredential(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createOzonRequestError(message, details = {}) {
  const error = new Error(message);
  error.name = 'OzonRequestError';
  Object.assign(error, details);
  return error;
}

function mergeRetry(endpointRetry = {}, clientRetry = {}) {
  return {
    maxAttempts: clientRetry.maxAttempts ?? endpointRetry.maxAttempts ?? 3,
    baseDelayMs: clientRetry.baseDelayMs ?? endpointRetry.baseDelayMs ?? 600,
    maxDelayMs: clientRetry.maxDelayMs ?? endpointRetry.maxDelayMs ?? 6_000,
    retryOnStatus: new Set(clientRetry.retryOnStatus ?? endpointRetry.retryOnStatus ?? DEFAULT_RETRY_STATUS),
    respectRetryAfter: clientRetry.respectRetryAfter ?? endpointRetry.respectRetryAfter ?? true,
  };
}

export function parseRetryAfterMs(headers) {
  const value = headers?.get?.('retry-after')
    ?? headers?.get?.('Retry-After')
    ?? headers?.['retry-after']
    ?? headers?.['Retry-After'];
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function computeRetryDelayMs({ response, attempt, retry }) {
  const retryAfterMs = retry.respectRetryAfter ? parseRetryAfterMs(response?.headers) : null;
  if (retryAfterMs != null) {
    return Math.min(retryAfterMs, retry.maxDelayMs);
  }

  const exponential = retry.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.max(20, retry.baseDelayMs / 4));
  return Math.min(exponential + jitter, retry.maxDelayMs);
}

const CHAT_INT64_FIELD_PATTERN = /("(?:first_unread_message_id|last_message_id|message_id|firstUnreadMessageId|lastMessageId|messageId)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/gu;

function preserveChatMessageIds(jsonText, endpointKey = '') {
  if (!String(endpointKey || '').startsWith('chat.')) return jsonText;
  // Ozon serializes chat message ids as JSON int64 numbers. JSON.parse rounds
  // values above Number.MAX_SAFE_INTEGER, so chat.read used to submit a
  // different, non-existent message id. Preserve the exact decimal value.
  return jsonText.replace(CHAT_INT64_FIELD_PATTERN, '$1"$2"');
}

async function readResponsePayload(response, endpointKey = '') {
  const text = await response.text();
  const cleanText = stripJsonBom(text);
  if (!cleanText) {
    return null;
  }

  try {
    return JSON.parse(preserveChatMessageIds(cleanText, endpointKey));
  } catch (_error) {
    return { rawText: cleanText };
  }
}

function createTimeoutController(timeoutMs, externalSignal) {
  const controller = new AbortController();
  let finished = false;

  const timeout = setTimeout(() => {
    if (!finished) {
      controller.abort(new Error(`Ozon request timed out after ${timeoutMs}ms.`));
    }
  }, timeoutMs);

  const abortFromExternal = () => {
    if (!finished) {
      controller.abort(externalSignal.reason);
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortFromExternal();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup() {
      finished = true;
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    },
  };
}

function createEndpointLimiter() {
  const nextAllowedAt = new Map();

  return async function waitForEndpoint(endpoint, scope = {}) {
    const minIntervalMs = Number(endpoint.rateLimit?.minIntervalMs) || 0;
    if (minIntervalMs <= 0) {
      return;
    }

    const clientId = normalizeCredential(scope.clientId ?? scope.client_id);
    if (!clientId) {
      throw createOzonRequestError('Ozon endpoint limiter requires an exact Client-Id scope.', {
        code: 'OZON_LIMIT_SCOPE_REQUIRED',
        endpointKey: endpoint.key,
      });
    }
    const bucket = endpoint.rateLimit?.bucket || endpoint.rate?.bucket || endpoint.key;
    const key = `${clientId}::${bucket}`;
    const now = Date.now();
    const next = nextAllowedAt.get(key) || now;
    const waitMs = Math.max(0, next - now);
    nextAllowedAt.set(key, Math.max(now, next) + minIntervalMs);

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  };
}

function normalizeEndpointUrl(baseUrl, endpointPath) {
  return new URL(endpointPath, baseUrl).toString();
}

function normalizeMethod(method) {
  return String(method || 'POST').toUpperCase();
}

function resolveOzonFileUrl(baseUrl, endpointPath, resourceUrl) {
  let base;
  let target;
  try {
    base = new URL(baseUrl);
    target = new URL(String(resourceUrl || '').trim());
  } catch {
    throw createOzonRequestError('Ozon chat file URL is invalid.', {
      code: 'OZON_FILE_URL_INVALID',
    });
  }
  const allowedPath = new URL(endpointPath, base).pathname;
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash ||
    !target.pathname.startsWith(allowedPath)
  ) {
    throw createOzonRequestError('Ozon chat file URL is outside the registered endpoint.', {
      code: 'OZON_FILE_URL_FORBIDDEN',
    });
  }
  return target.toString();
}

function detectImageMimeType(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return '';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) return 'image/png';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (data.toString('ascii', 0, 6) === 'GIF87a' || data.toString('ascii', 0, 6) === 'GIF89a') {
    return 'image/gif';
  }
  return '';
}

export function createOzonClient(options = {}) {
  const transport = options.transport || globalThis.fetch;
  if (typeof transport !== 'function') {
    throw new Error('No fetch implementation is available in the current Node runtime.');
  }

  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const logger = options.logger || safeLog;
  const waitForEndpoint = options.waitForEndpoint || createEndpointLimiter();
  const authorizeClientId = typeof options.authorizeClientId === 'function'
    ? options.authorizeClientId
    : null;

  async function requestReadOnly({ endpointKey, shopCredentials = {}, payload = {}, signal, requestId } = {}) {
    const endpoint = assertReadOnlyEndpoint(getOzonEndpoint(endpointKey));
    const clientId = normalizeCredential(shopCredentials.clientId ?? shopCredentials.client_id);
    const apiKey = normalizeCredential(shopCredentials.apiKey ?? shopCredentials.api_key);

    if (!clientId || !apiKey) {
      throw createOzonRequestError('Ozon read request is missing shop credentials.', {
        code: 'OZON_CREDENTIALS_MISSING',
        endpointKey,
      });
    }

    const retry = mergeRetry(endpoint.retry, options.retry);
    const method = normalizeMethod(endpoint.method);
    const url = normalizeEndpointUrl(baseUrl, endpoint.path);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'Client-Id': clientId,
      'Api-Key': apiKey,
    };

    logger('[local-api][ozon] read request queued', {
      endpointKey,
      owner: endpoint.owner,
      risk: endpoint.risk,
      requestId,
    });

    let lastError = null;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      await authorizeClientId?.(clientId, { endpointKey, operation: 'read' });
      await waitForEndpoint(endpoint, { clientId });
      const timeout = createTimeoutController(endpoint.timeoutMs, signal);

      try {
        const response = await transport(url, {
          method,
          headers,
          body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
          signal: timeout.signal,
        });
        const data = await readResponsePayload(response, endpointKey);
        timeout.cleanup();

        if (response.ok) {
          logger('[local-api][ozon] read request success', {
            endpointKey,
            status: response.status,
            attempt,
            requestId,
          });

          return {
            ok: true,
            endpointKey,
            status: response.status,
            attempts: attempt,
            data,
            receivedAt: new Date().toISOString(),
          };
        }

        const retryAfterMs = parseRetryAfterMs(response.headers);
        const shouldRetry = retry.retryOnStatus.has(response.status) && attempt < retry.maxAttempts;
        lastError = createOzonRequestError(`Ozon read request failed with HTTP ${response.status}.`, {
          code: 'OZON_HTTP_ERROR',
          endpointKey,
          status: response.status,
          attempts: attempt,
          retryAfterMs,
          retryable: shouldRetry,
          response: safeLogPayload(data),
        });

        logger('[local-api][ozon] read request failed', {
          endpointKey,
          status: response.status,
          attempt,
          willRetry: shouldRetry,
          requestId,
        });

        if (!shouldRetry) {
          throw lastError;
        }

        await sleep(computeRetryDelayMs({ response, attempt, retry }));
      } catch (error) {
        timeout.cleanup();
        lastError = error;
        const shouldRetry = error?.retryable !== false && attempt < retry.maxAttempts;

        logger('[local-api][ozon] read request error', {
          endpointKey,
          attempt,
          willRetry: shouldRetry,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        });

        if (!shouldRetry) {
          throw error;
        }

        await sleep(computeRetryDelayMs({ attempt, retry }));
      }
    }

    throw lastError || createOzonRequestError('Ozon read request failed.', { endpointKey });
  }

  async function requestBinaryReadOnly({
    endpointKey,
    shopCredentials = {},
    resourceUrl,
    signal,
    requestId,
    maxBytes = 15 * 1024 * 1024,
  } = {}) {
    const endpoint = assertReadOnlyEndpoint(getOzonEndpoint(endpointKey));
    if (normalizeMethod(endpoint.method) !== 'GET' || endpoint.responseShape?.envelope !== 'binary') {
      throw createOzonRequestError('Ozon endpoint is not registered for binary reads.', {
        code: 'OZON_BINARY_ENDPOINT_REQUIRED',
        endpointKey,
      });
    }
    const clientId = normalizeCredential(shopCredentials.clientId ?? shopCredentials.client_id);
    const apiKey = normalizeCredential(shopCredentials.apiKey ?? shopCredentials.api_key);
    if (!clientId || !apiKey) {
      throw createOzonRequestError('Ozon file read is missing shop credentials.', {
        code: 'OZON_CREDENTIALS_MISSING',
        endpointKey,
      });
    }
    const url = resolveOzonFileUrl(baseUrl, endpoint.path, resourceUrl);
    const byteLimit = Math.min(Math.max(Number(maxBytes) || 15 * 1024 * 1024, 1), 15 * 1024 * 1024);
    const retry = mergeRetry(endpoint.retry, options.retry);
    const headers = {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
      'Client-Id': clientId,
      'Api-Key': apiKey,
    };

    logger('[local-api][ozon] binary read queued', {
      endpointKey,
      owner: endpoint.owner,
      risk: endpoint.risk,
      requestId,
    });

    let lastError = null;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      await authorizeClientId?.(clientId, { endpointKey, operation: 'file-read' });
      await waitForEndpoint(endpoint, { clientId });
      const timeout = createTimeoutController(endpoint.timeoutMs, signal);
      try {
        const response = await transport(url, { method: 'GET', headers, signal: timeout.signal });
        const declaredLength = Number(response.headers?.get?.('content-length')) || 0;
        if (declaredLength > byteLimit) {
          throw createOzonRequestError('Ozon chat image exceeds the local size limit.', {
            code: 'OZON_FILE_TOO_LARGE',
            endpointKey,
            status: response.status,
            retryable: false,
          });
        }
        if (response.ok) {
          const data = Buffer.from(await response.arrayBuffer());
          if (data.byteLength > byteLimit) {
            throw createOzonRequestError('Ozon chat image exceeds the local size limit.', {
              code: 'OZON_FILE_TOO_LARGE',
              endpointKey,
              status: response.status,
              retryable: false,
            });
          }
          const mimeType = detectImageMimeType(data);
          if (!mimeType) {
            throw createOzonRequestError('Ozon chat attachment is not a supported image.', {
              code: 'OZON_FILE_TYPE_INVALID',
              endpointKey,
              status: response.status,
              retryable: false,
            });
          }
          timeout.cleanup();
          logger('[local-api][ozon] binary read success', {
            endpointKey,
            status: response.status,
            attempt,
            byteLength: data.byteLength,
            requestId,
          });
          return {
            ok: true,
            endpointKey,
            status: response.status,
            attempts: attempt,
            data,
            mimeType,
            byteLength: data.byteLength,
            receivedAt: new Date().toISOString(),
          };
        }

        const payload = await readResponsePayload(response, endpointKey);
        const shouldRetry = retry.retryOnStatus.has(response.status) && attempt < retry.maxAttempts;
        lastError = createOzonRequestError(`Ozon file read failed with HTTP ${response.status}.`, {
          code: 'OZON_HTTP_ERROR',
          endpointKey,
          status: response.status,
          attempts: attempt,
          retryAfterMs: parseRetryAfterMs(response.headers),
          retryable: shouldRetry,
          response: safeLogPayload(payload),
        });
        if (!shouldRetry) throw lastError;
        timeout.cleanup();
        await sleep(computeRetryDelayMs({ response, attempt, retry }));
      } catch (error) {
        timeout.cleanup();
        lastError = error;
        const shouldRetry = error?.retryable !== false && attempt < retry.maxAttempts;
        logger('[local-api][ozon] binary read error', {
          endpointKey,
          attempt,
          willRetry: shouldRetry,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        });
        if (!shouldRetry) throw error;
        await sleep(computeRetryDelayMs({ attempt, retry }));
      }
    }
    throw lastError || createOzonRequestError('Ozon file read failed.', { endpointKey });
  }

  async function requestWrite({ endpointKey, shopCredentials = {}, payload = {}, signal, requestId } = {}) {
    const endpoint = assertWriteEndpoint(getOzonEndpoint(endpointKey));
    const clientId = normalizeCredential(shopCredentials.clientId ?? shopCredentials.client_id);
    const apiKey = normalizeCredential(shopCredentials.apiKey ?? shopCredentials.api_key);

    if (!clientId || !apiKey) {
      throw createOzonRequestError('Ozon write request is missing shop credentials.', {
        code: 'OZON_CREDENTIALS_MISSING',
        endpointKey,
      });
    }

    const retry = mergeRetry(endpoint.retry, {
      maxAttempts: options.writeRetry?.maxAttempts ?? 1,
      baseDelayMs: options.writeRetry?.baseDelayMs ?? options.retry?.baseDelayMs,
      maxDelayMs: options.writeRetry?.maxDelayMs ?? options.retry?.maxDelayMs,
      retryOnStatus: options.writeRetry?.retryOnStatus ?? endpoint.retry?.retryOnStatus,
      respectRetryAfter: options.writeRetry?.respectRetryAfter ?? true,
    });
    const method = normalizeMethod(endpoint.method);
    const url = normalizeEndpointUrl(baseUrl, endpoint.path);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'Client-Id': clientId,
      'Api-Key': apiKey,
    };

    logger('[local-api][ozon] write request queued', {
      endpointKey,
      owner: endpoint.owner,
      risk: endpoint.risk,
      requestId,
    });

    let lastError = null;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      await authorizeClientId?.(clientId, { endpointKey, operation: 'write' });
      await waitForEndpoint(endpoint, { clientId });
      const timeout = createTimeoutController(endpoint.timeoutMs, signal);

      try {
        const response = await transport(url, {
          method,
          headers,
          body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
          signal: timeout.signal,
        });
        const data = await readResponsePayload(response, endpointKey);
        timeout.cleanup();

        if (response.ok) {
          logger('[local-api][ozon] write request success', {
            endpointKey,
            status: response.status,
            attempt,
            requestId,
          });

          return {
            ok: true,
            endpointKey,
            status: response.status,
            attempts: attempt,
            data,
            receivedAt: new Date().toISOString(),
          };
        }

        const retryAfterMs = parseRetryAfterMs(response.headers);
        const shouldRetry = retry.retryOnStatus.has(response.status) && attempt < retry.maxAttempts;
        lastError = createOzonRequestError(`Ozon write request failed with HTTP ${response.status}.`, {
          code: 'OZON_HTTP_ERROR',
          endpointKey,
          status: response.status,
          attempts: attempt,
          retryAfterMs,
          retryable: shouldRetry,
          response: safeLogPayload(data),
        });

        logger('[local-api][ozon] write request failed', {
          endpointKey,
          status: response.status,
          attempt,
          willRetry: shouldRetry,
          requestId,
        });

        if (!shouldRetry) {
          throw lastError;
        }

        await sleep(computeRetryDelayMs({ response, attempt, retry }));
      } catch (error) {
        timeout.cleanup();
        lastError = error;
        const shouldRetry = error?.retryable !== false && attempt < retry.maxAttempts;

        logger('[local-api][ozon] write request error', {
          endpointKey,
          attempt,
          willRetry: shouldRetry,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        });

        if (!shouldRetry) {
          throw error;
        }

        await sleep(computeRetryDelayMs({ attempt, retry }));
      }
    }

    throw lastError || createOzonRequestError('Ozon write request failed.', { endpointKey });
  }

  return {
    requestReadOnly,
    requestBinaryReadOnly,
    requestWrite,
    requestFileJob() {
      throw new Error('Ozon file jobs are disabled until file-read endpoints, job state, and cache persistence rules are implemented.');
    },
  };
}

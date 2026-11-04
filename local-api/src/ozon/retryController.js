const DEFAULT_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function numberOrNull(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.floor(numberValue) : null;
}

function httpStatus(error = {}) {
  return numberOrNull(error.status ?? error.statusCode ?? error.status_code ?? error.response?.status);
}

function retryAfterMs(error = {}) {
  return numberOrNull(error.retryAfterMs ?? error.retry_after_ms ?? error.response?.retryAfterMs);
}

function ozonCode(error = {}) {
  const candidates = [
    error.ozonCode,
    error.ozon_code,
    error.response?.code,
    error.response?.data?.code,
    error.response?.result?.code,
  ];
  const found = candidates.find((value) => value !== undefined && value !== null && value !== '');
  return found == null ? null : String(found);
}

function isTimeoutLike(error = {}) {
  const name = String(error.name || '').toLowerCase();
  const code = String(error.code || '').toLowerCase();
  const message = String(error.message || '').toLowerCase();
  return (
    name.includes('abort') ||
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'sockettimeout' ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('connection reset')
  );
}

function isNetworkLike(error = {}) {
  const code = String(error.code || error.cause?.code || '').toLowerCase();
  const message = String(error.message || error.cause?.message || '').toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket hang up') ||
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'ehostunreach' ||
    code === 'enetunreach' ||
    code === 'und_err_socket' ||
    code === 'und_err_connect_timeout' ||
    code === 'und_err_headers_timeout' ||
    code === 'und_err_body_timeout'
  );
}

function classify(error = {}) {
  const status = httpStatus(error);
  const code = ozonCode(error);
  if (status && DEFAULT_RETRYABLE_STATUS.has(status)) {
    return { retryable: true, reason: `http_${status}`, status, ozonCode: code };
  }
  if (code === '8') {
    return { retryable: true, reason: 'ozon_code_8', status, ozonCode: code };
  }
  if (isTimeoutLike(error)) {
    return { retryable: true, reason: 'timeout', status, ozonCode: code };
  }
  if (isNetworkLike(error)) {
    return { retryable: true, reason: 'network', status, ozonCode: code };
  }
  return { retryable: false, reason: 'not_retryable', status, ozonCode: code };
}

export function createRetryController(options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 6);
  const backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length
    ? options.backoffMs.map((value) => Math.max(0, Number(value) || 0))
    : DEFAULT_BACKOFF_MS;
  const maxDelayMs = Math.max(1, Number(options.maxDelayMs) || 30_000);
  const sleeper = typeof options.sleep === 'function' ? options.sleep : sleep;

  function delayFor(error = {}, attempt = 1) {
    const retryAfter = retryAfterMs(error);
    if (retryAfter != null) return Math.min(retryAfter, maxDelayMs);
    const index = Math.max(0, Math.min(backoffMs.length - 1, attempt - 1));
    return Math.min(backoffMs[index] ?? maxDelayMs, maxDelayMs);
  }

  function getDecision(error = {}, attempt = 1) {
    const result = classify(error);
    const canTryAgain = attempt < maxAttempts;
    if (!result.retryable || !canTryAgain) {
      return {
        ...result,
        shouldRetry: false,
        attempt,
        nextAttempt: attempt,
        retryAfterMs: null,
        nextRetryAt: null,
      };
    }
    const waitMs = delayFor(error, attempt);
    return {
      ...result,
      shouldRetry: true,
      attempt,
      nextAttempt: attempt + 1,
      retryAfterMs: waitMs,
      nextRetryAt: new Date(Date.now() + waitMs).toISOString(),
    };
  }

  async function wait(decision = {}) {
    if (!decision.shouldRetry) return;
    await sleeper(decision.retryAfterMs || 0);
  }

  return {
    maxAttempts,
    classify,
    getDecision,
    delayFor,
    wait,
  };
}

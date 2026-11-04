const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 120, 360, 900]);

function errorText(error) {
  return `${error?.code || ''} ${error?.message || error || ''}`.trim();
}

export function isTransientLocalApiWriteError(error) {
  if (error?.name === 'AbortError') return false;
  return /(?:SQLITE_BUSY|database is locked|LOCAL_API_REQUEST_TIMEOUT|请求超时|timeout|fetch failed|无法连接本地 API|ECONNRESET|ECONNREFUSED|EPIPE)/iu.test(
    errorText(error)
  );
}

function wait(delayMs) {
  const duration = Math.max(0, Number(delayMs) || 0);
  return duration ? new Promise((resolve) => globalThis.setTimeout(resolve, duration)) : Promise.resolve();
}

export async function retryTransientLocalApiWrite(operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('LOCAL_API_WRITE_OPERATION_REQUIRED');
  const retryDelaysMs = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
    ? options.retryDelaysMs
    : DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; attempt < retryDelaysMs.length + 1; attempt += 1) {
    try {
      return await operation(attempt + 1);
    } catch (error) {
      if (!isTransientLocalApiWriteError(error) || attempt >= retryDelaysMs.length) throw error;
      await wait(retryDelaysMs[attempt]);
    }
  }
  throw new Error('LOCAL_API_WRITE_RETRY_EXHAUSTED');
}

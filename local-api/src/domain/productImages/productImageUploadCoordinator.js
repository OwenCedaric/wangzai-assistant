function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function scopeKey(scope = {}) {
  return `${String(scope.tenantId || '').trim()}:${String(scope.userId || '').trim()}`;
}

export class ProductImageCapacityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductImageCapacityError';
    this.code = code;
    this.statusCode = 429;
  }
}

export function createProductImageUploadCoordinator({ repository, config = {}, sleep } = {}) {
  const maxConcurrent = positiveInteger(config.maxConcurrent, 4);
  const maxConcurrentPerOwner = positiveInteger(config.maxConcurrentPerOwner, 2);
  const maxQueue = positiveInteger(config.maxQueue, 200);
  const maxDailyUploads = positiveInteger(config.maxDailyUploads, 2_000);
  const maxDailyBytes = positiveInteger(config.maxDailyBytes, 2 * 1024 * 1024 * 1024);
  const maxRetainedBytes = positiveInteger(config.maxRetainedBytes, 20 * 1024 * 1024 * 1024);
  const maxAttempts = positiveInteger(config.maxAttempts, 3);
  const retryBaseMs = positiveInteger(config.retryBaseMs, 250);
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const queued = [];
  const activeByOwner = new Map();
  const reservedByOwner = new Map();
  let active = 0;

  function releaseReservation(key, bytes) {
    const current = reservedByOwner.get(key) || { count: 0, bytes: 0 };
    const next = { count: Math.max(0, current.count - 1), bytes: Math.max(0, current.bytes - bytes) };
    if (!next.count && !next.bytes) reservedByOwner.delete(key); else reservedByOwner.set(key, next);
  }

  function reserve(scope, bytes) {
    const key = scopeKey(scope);
    if (!key || key === ':') throw new ProductImageCapacityError('PRODUCT_IMAGE_SCOPE_REQUIRED', '缺少用户范围，不能上传图片。');
    const usage = repository?.getUsageSummary?.(scope) || { day: {}, retained: {} };
    const reserved = reservedByOwner.get(key) || { count: 0, bytes: 0 };
    if (Number(usage.day.uploads || 0) + reserved.count + 1 > maxDailyUploads) {
      throw new ProductImageCapacityError('PRODUCT_IMAGE_DAILY_COUNT_LIMIT', '今日图片上传数量已达到上限。');
    }
    if (Number(usage.day.upload_bytes || 0) + reserved.bytes + bytes > maxDailyBytes) {
      throw new ProductImageCapacityError('PRODUCT_IMAGE_DAILY_BYTES_LIMIT', '今日图片上传容量已达到上限。');
    }
    if (Number(usage.retained.bytes || 0) + reserved.bytes + bytes > maxRetainedBytes) {
      throw new ProductImageCapacityError('PRODUCT_IMAGE_RETAINED_BYTES_LIMIT', '当前用户图片存储容量已达到上限。');
    }
    reservedByOwner.set(key, { count: reserved.count + 1, bytes: reserved.bytes + bytes });
    return key;
  }

  function pump() {
    if (active >= maxConcurrent || queued.length === 0) return;
    let index = queued.findIndex((job) => Number(activeByOwner.get(job.key) || 0) < maxConcurrentPerOwner);
    while (index >= 0 && active < maxConcurrent) {
      const [job] = queued.splice(index, 1);
      active += 1;
      activeByOwner.set(job.key, Number(activeByOwner.get(job.key) || 0) + 1);
      Promise.resolve()
        .then(job.execute)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          const ownerActive = Math.max(0, Number(activeByOwner.get(job.key) || 1) - 1);
          if (ownerActive) activeByOwner.set(job.key, ownerActive); else activeByOwner.delete(job.key);
          releaseReservation(job.key, job.bytes);
          pump();
        });
      index = queued.findIndex((candidate) => Number(activeByOwner.get(candidate.key) || 0) < maxConcurrentPerOwner);
    }
  }

  function run({ scope, bytes = 0, execute } = {}) {
    if (typeof execute !== 'function') return Promise.reject(new Error('Product image upload task is missing.'));
    if (queued.length >= maxQueue) {
      return Promise.reject(new ProductImageCapacityError('PRODUCT_IMAGE_QUEUE_FULL', '图片处理中，请稍后重试。'));
    }
    let key;
    try { key = reserve(scope, Number(bytes) || 0); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      queued.push({ key, scope, bytes: Number(bytes) || 0, execute, resolve, reject });
      pump();
    });
  }

  async function withRetry(execute, onAttempt = () => undefined) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        onAttempt(attempt);
        return { value: await execute(attempt), attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) break;
        await wait(retryBaseMs * (2 ** (attempt - 1)));
      }
    }
    lastError.attempts = maxAttempts;
    throw lastError;
  }

  function getStatus() {
    return {
      active,
      queued: queued.length,
      ownersActive: activeByOwner.size,
      limits: { maxConcurrent, maxConcurrentPerOwner, maxQueue, maxDailyUploads, maxDailyBytes, maxRetainedBytes, maxAttempts },
    };
  }

  return { run, withRetry, getStatus };
}

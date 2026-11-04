import { ACCOUNT_REMOVAL_ERROR_CODES, failAccountRemovalContract } from './accountRemovalErrors.js';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 3;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readOwnerObjectKeys(db, shopId) {
  return db.prepare(`
    SELECT DISTINCT object_key
    FROM product_image_assets
    WHERE shop_id = ? AND object_key IS NOT NULL AND TRIM(object_key) <> ''
    ORDER BY object_key ASC
  `).all(shopId).map((row) => String(row.object_key || '').trim()).filter(Boolean);
}

export function createAccountRemovalProductImageCleanup({
  db,
  objectStorage,
  concurrency = DEFAULT_CONCURRENCY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  if (!db) throw new Error('ACCOUNT_REMOVAL_DATABASE_REQUIRED');
  const workerCount = positiveInteger(concurrency, DEFAULT_CONCURRENCY);
  const attemptLimit = positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS);

  async function deleteWithRetry(objectKey) {
    let lastError = null;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      try {
        await objectStorage.deleteImage(objectKey);
        return { attempts: attempt };
      } catch (error) {
        lastError = error;
      }
    }
    const failure = new Error(
      lastError instanceof Error ? lastError.message : String(lastError || 'remote object deletion failed'),
    );
    failure.code = ACCOUNT_REMOVAL_ERROR_CODES.REMOTE_OBJECT_DELETE_FAILED;
    throw failure;
  }

  async function cleanupOwner(owner = {}) {
    if (owner.ownerType !== 'ozon_shop') {
      return Object.freeze({ completed: true, candidates: 0, deleted: 0, retries: 0 });
    }
    const shopId = String(owner.ownerId || '').trim();
    if (!shopId) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_REQUIRED);
    const objectKeys = readOwnerObjectKeys(db, shopId);
    if (objectKeys.length === 0) {
      return Object.freeze({ completed: true, candidates: 0, deleted: 0, retries: 0 });
    }
    if (typeof objectStorage?.deleteImage !== 'function') {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.REMOTE_STORAGE_UNAVAILABLE);
    }

    let cursor = 0;
    let deleted = 0;
    let retries = 0;
    const workers = Array.from(
      { length: Math.min(workerCount, objectKeys.length) },
      async () => {
        while (cursor < objectKeys.length) {
          const current = cursor;
          cursor += 1;
          const result = await deleteWithRetry(objectKeys[current]);
          deleted += 1;
          retries += Math.max(0, result.attempts - 1);
        }
      },
    );
    await Promise.all(workers);
    return Object.freeze({
      completed: true,
      candidates: objectKeys.length,
      deleted,
      retries,
    });
  }

  return { cleanupOwner };
}


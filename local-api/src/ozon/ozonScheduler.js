import { randomUUID } from 'node:crypto';
import { buildOzonCacheKey, createCacheKeyService } from '../cache/cacheKeyService.js';
import { createCacheMergeService } from '../cache/cacheMergeService.js';
import { createCacheReadService } from '../cache/cacheReadService.js';
import { createSyncJobService, SYNC_JOB_STATUS } from '../sync/syncJobService.js';
import { createSyncStateService } from '../sync/syncStateService.js';
import { createSyncLockService } from '../sync/syncLockService.js';
import { recoverPersistedSyncRuntime } from '../sync/syncRuntimeRecoveryService.js';
import { safeLogPayload } from '../security/safeLog.js';
import { createStableHash } from '../utils/stableHash.js';
import { getOzonEndpoint, assertReadOnlyEndpoint, assertWriteEndpoint, listOzonEndpoints } from './ozonEndpointRegistry.js';
import { createBatchPlanner } from './batchPlanner.js';
import { createOzonResponseNormalizer } from './ozonResponseNormalizer.js';
import { createRateLimitState } from './rateLimitState.js';
import { createRequestQueue } from './requestQueue.js';
import { createRetryController } from './retryController.js';
import { createTraceController } from './traceController.js';
import { createSchedulerQueueOptions, createTrafficController } from './trafficController.js';

// A second scheduler created against the same live Database object is another
// adapter inside the current process, not evidence of a process restart. A
// freshly opened Database object (the normal startup path after a crash) must
// reconcile durable owners exactly once before accepting new work.
const RECOVERED_DATABASES = new WeakSet();

function nowIso() {
  return new Date().toISOString();
}

function addSeconds(seconds) {
  return new Date(Date.now() + Math.max(0, Number(seconds) || 0) * 1000).toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSchedulerTraceJobId(value) {
  return normalizeText(value).startsWith('ozon_job_');
}

function normalizePriority(value) {
  return ['P0', 'P1', 'P2', 'P3', 'P4', 'WRITE'].includes(value) ? value : 'P2';
}

function normalizeSource(value) {
  return normalizeText(value) || 'system';
}

function normalizeProfile(value, input = {}) {
  const profile = normalizeText(value);
  if (['foreground', 'background', 'write', 'readback'].includes(profile)) return profile;
  const source = normalizeText(input.source ?? input.syncSource).toLowerCase(); const requestedBy = normalizeText(input.requestedBy ?? input.requested_by).toLowerCase();
  const action = normalizeText(input.action);
  if (['background', 'continuous-sync'].includes(source) || requestedBy === 'continuous-sync' || input.priority === 'P4') return 'background';
  if (source === 'readback' || action === 'readback') return 'readback';
  if (source === 'write_confirm' || action === 'write' || input.priority === 'WRITE') return 'write';
  return 'foreground';
}

function compactText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function extractOzonErrorDetail(error) {
  const response = error?.response;
  if (!response || typeof response !== 'object') return '';
  const parts = [];
  const push = (value) => {
    const text = compactText(value);
    if (text && !parts.includes(text)) parts.push(text);
  };

  push(response.message);
  push(response.error);
  push(response.error_message);
  push(response.description);
  push(response.detail);
  push(response.rawText);
  if (response.code != null) push(`Ozon code ${response.code}`);
  if (Array.isArray(response.errors)) {
    for (const item of response.errors) {
      if (!item || typeof item !== 'object') {
        push(item);
        continue;
      }
      push(item.message);
      push(item.error);
      push(item.error_message);
      push(item.description);
      push(item.code != null ? `Ozon error ${item.code}` : '');
    }
  }
  return parts.join('; ');
}

function publicErrorMessage(error) {
  const base = error instanceof Error ? error.message : String(error);
  const detail = extractOzonErrorDetail(error);
  if (!detail || base.includes(detail)) return base;
  return `${base} ${detail}`;
}

function schedulerLastError(error, fallbackCode = 'OZON_SCHEDULER_ERROR') {
  const code = error?.code || fallbackCode;
  return `${code}: ${publicErrorMessage(error)}`;
}

function publicError(error) {
  return {
    code: error?.code || 'OZON_SCHEDULER_ERROR',
    message: publicErrorMessage(error),
    status: error?.status || error?.statusCode || error?.status_code || null,
    retryAfterMs: error?.retryAfterMs ?? null,
    response: error?.response || null,
  };
}

function extractOzonCode(error = {}) {
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

function errorHttpStatus(error = {}) {
  const value = Number(
    error?.status ?? error?.statusCode ?? error?.status_code ?? error?.response?.status,
  );
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isAuthenticationFailure(error = {}) {
  const status = errorHttpStatus(error);
  const code = normalizeText(error?.code).toUpperCase();
  const ozonCode = extractOzonCode(error);
  const message = publicErrorMessage(error);
  const explicitCredentialRejection =
    /invalid\s+api[- ]?key|api[- ]?key\s+(?:is\s+)?invalid|credential(?:s)?\s+(?:is|are)?\s*invalid|authentication\s+failed|unauthori[sz]ed/iu.test(message);
  return (
    status === 401 ||
    status === 403 ||
    (ozonCode === '5' && explicitCredentialRejection) ||
    code === 'OZON_CREDENTIALS_MISSING' ||
    code.includes('AUTHENTICATION') ||
    code.includes('UNAUTHORIZED') ||
    explicitCredentialRejection
  );
}

function isCompanyBlockedText(value) {
  const message = normalizeText(value);
  return /company\s+is\s+blocked|company\s+blocked|компан\S*\s+заблокирован|公司.{0,8}(?:封禁|冻结)/iu.test(message);
}

function isCompanyBlockedFailure(error = {}) {
  return isCompanyBlockedText(publicErrorMessage(error));
}

function isCompanyBlockedPause(lastError) {
  return /(?:^|:)REASON=COMPANY_BLOCKED(?::|$)/u.test(normalizeText(lastError));
}

function isProductImportReadBackRequest(request = {}) {
  return (
    request.domain === 'products' &&
    ['product-import-task-readback', 'product-write-readback'].includes(request.action)
  );
}

function isExpectedProductImportVisibilityDelay(request = {}, error = {}) {
  if (
    request.domain !== 'products' ||
    request.action !== 'product-write-readback' ||
    request.endpointKey !== 'products.attributes'
  ) {
    return false;
  }
  const message = publicErrorMessage(error);
  return (
    errorHttpStatus(error) === 404 &&
    extractOzonCode(error) === '5' &&
    /item\s+not\s+found|product\s+not\s+found|товар\S*\s+не\s+найден/iu.test(message)
  );
}

function authFailureRevision(lastError) {
  const match = /(?:^|:)CREDENTIAL_REVISION=(\d+)(?::|$)/u.exec(
    normalizeText(lastError),
  );
  return match ? Number(match[1]) : null;
}

function collectWriteResultItems(value, path = '', depth = 0) {
  if (value == null || depth > 4) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectWriteResultItems(item, `${path}[${index}]`, depth + 1));
  }
  if (typeof value !== 'object') return [];

  const items = [];
  const keys = Object.keys(value);
  const looksLikeWriteItem =
    keys.some((key) => ['offer_id', 'offerId', 'product_id', 'productId', 'sku', 'warehouse_id', 'warehouseId'].includes(key)) ||
    Array.isArray(value.errors) ||
    value.error ||
    value.updated === false ||
    value.success === false;
  if (looksLikeWriteItem) {
    items.push({ path, item: value });
  }

  for (const key of ['result', 'results', 'items', 'errors']) {
    if (value[key] !== undefined) {
      items.push(...collectWriteResultItems(value[key], path ? `${path}.${key}` : key, depth + 1));
    }
  }
  return items;
}

function collectWriteItemErrors(item = {}) {
  const errors = [];
  const pushError = (source = {}) => {
    if (source == null || source === '') return;
    if (typeof source !== 'object') {
      const message = compactText(source);
      if (message) errors.push({ code: '', message });
      return;
    }
    const code = compactText(source.code || source.error_code || source.name);
    const message = compactText(
      source.message ||
        source.error ||
        source.error_message ||
        source.description ||
        source.detail ||
        source.reason
    );
    if (code || message) errors.push({ code, message });
  };

  if (Array.isArray(item.errors)) {
    item.errors.forEach(pushError);
  }
  if (item.error) pushError(item.error);
  if (item.success === false && !errors.length) {
    pushError({ code: 'OZON_WRITE_ITEM_REJECTED', message: 'Ozon 返回该明细未写入。' });
  }
  return errors;
}

function getWriteItemLabel(item = {}) {
  return compactText(
    item.offer_id ||
      item.offerId ||
      item.product_id ||
      item.productId ||
      item.sku ||
      item.warehouse_id ||
      item.warehouseId ||
      '当前明细'
  );
}

function inspectOzonWriteApplicationResult({ endpointKey, data } = {}) {
  const items = collectWriteResultItems(data);
  const failedItems = [];
  let successCount = 0;

  for (const { item, path } of items) {
    const errors = collectWriteItemErrors(item);
    if (errors.length) {
      failedItems.push({
        path,
        label: getWriteItemLabel(item),
        errors,
        raw: item,
      });
      continue;
    }
    if (item.updated === true || item.success === true || item.result === true) {
      successCount += 1;
    }
  }

  if (!failedItems.length) {
    return {
      ok: true,
      itemCount: items.length,
      successCount: successCount || items.length,
      failedCount: 0,
      failedItems: [],
      message: '',
    };
  }

  const detail = failedItems
    .slice(0, 3)
    .map((failed) => {
      const reason = failed.errors
        .map((error) => [error.code, error.message].filter(Boolean).join(': '))
        .filter(Boolean)
        .join('；');
      return `${failed.label}：${reason || 'Ozon 返回明细写入失败'}`;
    })
    .join('；');
  const more = failedItems.length > 3 ? `；另有 ${failedItems.length - 3} 项失败` : '';
  return {
    ok: false,
    endpointKey,
    itemCount: items.length,
    successCount: Math.max(0, items.length - failedItems.length),
    failedCount: failedItems.length,
    failedItems,
    message: `Ozon 已拒绝写入：${detail}${more}`,
  };
}

function createSchedulerError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'OzonSchedulerError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function createAttemptId() {
  return `attempt_${randomUUID()}`;
}

function createRequestId() {
  return `ozon_req_${randomUUID()}`;
}

function normalizeSchedulerRequest(input = {}) {
  const endpointKey = normalizeText(input.endpointKey ?? input.endpoint_key);
  const domain = normalizeText(input.domain) || endpointKey.split('.')[0] || 'unknown';
  const action = normalizeText(input.action) || 'read';
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  const shopId = normalizeText(input.shopId ?? input.shop_id);
  if (!endpointKey) throw createSchedulerError('OZON_ENDPOINT_KEY_REQUIRED', 'endpointKey is required for scheduled Ozon requests.');
  if (!shopId) throw createSchedulerError('OZON_SHOP_ID_REQUIRED', 'shopId is required for scheduled Ozon requests.');
  return {
    shopId,
    domain,
    endpointKey,
    action,
    priority: normalizePriority(input.priority),
    profile: normalizeProfile(input.profile ?? input.schedulerProfile, input),
    source: normalizeSource(input.source ?? input.syncSource),
    snapshotId: normalizeText(input.snapshotId ?? input.snapshot_id),
    params,
    cacheKey: normalizeText(input.cacheKey ?? input.cache_key),
    idempotencyKey: normalizeText(input.idempotencyKey ?? input.idempotency_key),
    requestedBy: normalizeText(input.requestedBy ?? input.requested_by) || 'local-api',
    allowStale: input.allowStale !== false,
    forceRefresh: input.forceRefresh === true,
    waitForResult: input.waitForResult === true,
    dedupeTtlMs: Number(input.dedupeTtlMs) || 5 * 60 * 1000,
    lockTtlMs: Number(input.lockTtlMs) || 120_000,
  };
}

function createRequestFingerprint(request) {
  return createStableHash({
    profileId: request.scopeToken?.profileId || null,
    shopId: request.shopId,
    shopIncarnation: request.scopeToken?.shopIncarnation || null,
    credentialRevision: request.scopeToken?.credentialRevision || null,
    domain: request.domain,
    endpointKey: request.endpointKey,
    action: request.action,
    params: request.params,
    cacheKey: request.cacheKey,
  }, { length: 32 });
}

function toJobPayload(job, extra = {}) {
  return {
    ok: !['failed', 'blocked', 'canceled', 'rate_limited', 'circuit_open'].includes(job?.status),
    job,
    jobId: job?.jobId || job?.id || null,
    ...extra,
  };
}

export function createOzonScheduler({
  db,
  shopRepository,
  ozonClient,
  technicalArchiveService = null,
  allowRealWrite = false,
  queueOptions,
  rateLimitOptions,
  trafficOptions,
  retryOptions,
  logger = () => {},
} = {}) {
  if (!db) throw new Error('createOzonScheduler requires db.');
  if (!shopRepository) throw new Error('createOzonScheduler requires shopRepository.');
  if (!ozonClient?.requestReadOnly) throw new Error('createOzonScheduler requires ozonClient.requestReadOnly.');

  let startupRecovery;
  if (RECOVERED_DATABASES.has(db)) {
    startupRecovery = Object.freeze({
      recoveredAt: nowIso(),
      skipped: true,
      reason: 'database_already_recovered_in_process',
    });
  } else {
    startupRecovery = recoverPersistedSyncRuntime(db);
    RECOVERED_DATABASES.add(db);
  }

  const jobService = createSyncJobService(db);
  const stateService = createSyncStateService(db);
  const lockService = createSyncLockService(db);
  const cacheKeyService = createCacheKeyService(db);
  const cacheMergeService = createCacheMergeService(db);
  const cacheReadService = createCacheReadService(db);
  const batchPlanner = createBatchPlanner();
  const normalizer = createOzonResponseNormalizer();
  const rateLimitState = createRateLimitState(db, rateLimitOptions);
  const resolvedQueueOptions = createSchedulerQueueOptions(queueOptions || {});
  const trafficController = createTrafficController({
    ...(trafficOptions || {}),
    profiles: resolvedQueueOptions.profiles,
    rateLimitState,
  });
  const retryController = createRetryController(retryOptions);
  const traceController = createTraceController(db, { archiveReader: technicalArchiveService });
  const requestQueue = createRequestQueue({
    ...resolvedQueueOptions,
    ...(queueOptions || {}),
    profiles: resolvedQueueOptions.profiles,
    permitController: trafficController,
    onEvent: (event) => {
      traceController.record({
        ...event,
        sourceFile: 'local-api/src/ozon/ozonScheduler.js',
        sourceFunction: 'requestQueue',
      });
    },
  });
  const inFlight = new Map();
  const inFlightResults = new Map();

  function captureShopScopeToken(shopId) {
    if (shopRepository.identityRepository?.createScopeToken) {
      const token = shopRepository.identityRepository.createScopeToken(
        shopId,
        shopRepository.profileId,
      );
      shopRepository.identityRepository.assertCurrentScopeToken(token);
      return token;
    }
    // Compatibility for isolated scheduler adapters. Production repositories
    // always expose identityRepository; the fallback still fences on the
    // generation fields returned with credentials when adapters provide them.
    const credentials = shopRepository.getShopCredentialsForInternalUse(shopId);
    if (!credentials) {
      throw createSchedulerError(
        'SHOP_SCOPE_NOT_FOUND',
        'Scheduled Ozon request requires a current shop identity.',
        { shopId },
      );
    }
    return Object.freeze({
      profileId: normalizeText(credentials.profileId) || 'default',
      shopId,
      shopIncarnation: normalizeText(credentials.shopIncarnation) || `legacy:${shopId}`,
      credentialRevision: Number(credentials.credentialRevision) || 1,
    });
  }

  function assertShopScopeToken(scopeToken) {
    if (shopRepository.identityRepository?.assertCurrentScopeToken) {
      return shopRepository.identityRepository.assertCurrentScopeToken(scopeToken);
    }
    const current = shopRepository.getShopCredentialsForInternalUse(scopeToken.shopId);
    if (!current) {
      throw createSchedulerError(
        'SHOP_SCOPE_NOT_FOUND',
        'The scheduled shop identity no longer exists.',
        { shopId: scopeToken.shopId },
      );
    }
    const currentIncarnation = normalizeText(current.shopIncarnation) || `legacy:${scopeToken.shopId}`;
    const currentCredentialRevision = Number(current.credentialRevision) || 1;
    if (currentIncarnation !== scopeToken.shopIncarnation) {
      throw createSchedulerError(
        'SHOP_INCARNATION_STALE',
        'The scheduled Ozon task belongs to a retired shop incarnation.',
        { shopId: scopeToken.shopId },
      );
    }
    if (currentCredentialRevision !== scopeToken.credentialRevision) {
      throw createSchedulerError(
        'SHOP_CREDENTIAL_REVISION_STALE',
        'The scheduled Ozon task belongs to a retired credential revision.',
        { shopId: scopeToken.shopId },
      );
    }
    return scopeToken;
  }

  function recordError(entry = {}) {
    db.prepare(`
      INSERT INTO ozon_error_events (
        id, job_id, domain, shop_id, endpoint_key, error_code,
        error_message, severity, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `error_${randomUUID()}`,
      entry.jobId || null,
      entry.domain || null,
      entry.shopId || null,
      entry.endpointKey || null,
      entry.errorCode || 'OZON_ERROR',
      entry.errorMessage || 'Unknown Ozon scheduler error.',
      entry.severity || 'warning',
      nowIso(),
    );
  }

  function readShopRuntimeState(shopId) {
    const row = db.prepare(`
      SELECT shop_id, status, last_success_at, last_failure_at, last_error,
             active_jobs, queued_jobs, updated_at
        FROM ozon_shop_runtime_state
       WHERE shop_id = ?
    `).get(normalizeText(shopId));
    if (!row) return null;
    return {
      shopId: row.shop_id,
      status: row.status,
      lastSuccessAt: row.last_success_at || null,
      lastFailureAt: row.last_failure_at || null,
      lastError: row.last_error || null,
      activeJobs: Number(row.active_jobs || 0),
      queuedJobs: Number(row.queued_jobs || 0),
      updatedAt: row.updated_at,
    };
  }

  function writeShopRuntimeState(shopId, {
    status,
    lastError = null,
    success = false,
    failed = false,
  }) {
    const ownerId = normalizeText(shopId);
    if (!ownerId) return null;
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO ozon_shop_runtime_state (
        shop_id, status, last_success_at, last_failure_at, last_error,
        active_jobs, queued_jobs, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(shop_id) DO UPDATE SET
        status = excluded.status,
        last_success_at = CASE
          WHEN ? = 1 THEN excluded.last_success_at
          ELSE ozon_shop_runtime_state.last_success_at
        END,
        last_failure_at = CASE
          WHEN ? = 1 THEN excluded.last_failure_at
          ELSE ozon_shop_runtime_state.last_failure_at
        END,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      ownerId,
      status,
      success ? timestamp : null,
      failed ? timestamp : null,
      lastError,
      timestamp,
      success ? 1 : 0,
      failed ? 1 : 0,
    );
    return readShopRuntimeState(ownerId);
  }

  function upgradeLegacyCompanyBlockedPause(state, scopeToken) {
    if (!state || /(?:^|:)REASON=/u.test(normalizeText(state.lastError))) return state;
    const failedAt = Date.parse(state.lastFailureAt || '');
    const rows = db.prepare(`
      SELECT error_message, created_at
        FROM ozon_error_events
       WHERE shop_id = ?
       ORDER BY created_at DESC
       LIMIT 20
    `).all(scopeToken.shopId);
    const matched = rows.some((row) => {
      if (!isCompanyBlockedText(row.error_message)) return false;
      const createdAt = Date.parse(row.created_at || '');
      return !Number.isFinite(failedAt) || !Number.isFinite(createdAt) || Math.abs(createdAt - failedAt) <= 60_000;
    });
    if (!matched) return state;
    const httpMarker = /HTTP_(\d+)/u.exec(normalizeText(state.lastError))?.[1] || '403';
    return writeShopRuntimeState(scopeToken.shopId, {
      status: 'auth_failed',
      lastError: `PAUSED_AUTH:CREDENTIAL_REVISION=${scopeToken.credentialRevision}:REASON=COMPANY_BLOCKED:HTTP_${httpMarker}`,
    });
  }

  function authPauseForCurrentRevision(scopeToken, request = {}) {
    let state = readShopRuntimeState(scopeToken.shopId);
    if (state?.status !== 'auth_failed') return null;
    const failedRevision = authFailureRevision(state.lastError);
    if (failedRevision !== Number(scopeToken.credentialRevision)) {
      writeShopRuntimeState(scopeToken.shopId, { status: 'ready' });
      return null;
    }
    // v18 and earlier treated every Ozon code 5 as an invalid API key. Ozon
    // also uses HTTP 404/code 5 for a newly imported product that is not yet
    // visible through `products.attributes`. Allow one readback probe for that
    // legacy pause. New credential pauses carry an explicit reason marker and
    // therefore cannot loop on a genuinely invalid key.
    if (
      isProductImportReadBackRequest(request) &&
      /HTTP_404/iu.test(normalizeText(state.lastError)) &&
      !/REASON=/iu.test(normalizeText(state.lastError))
    ) {
      writeShopRuntimeState(scopeToken.shopId, { status: 'ready', lastError: null });
      return null;
    }
    state = upgradeLegacyCompanyBlockedPause(state, scopeToken);
    return state;
  }

  function markShopRuntimeReady(scopeToken) {
    const current = readShopRuntimeState(scopeToken.shopId);
    // A concurrent success issued with the same credentials must not clear a
    // 401/403 pause recorded by another endpoint. Rotating credentials changes
    // the revision and is the explicit resume boundary.
    if (
      current?.status === 'auth_failed' &&
      authFailureRevision(current.lastError) === Number(scopeToken.credentialRevision)
    ) {
      return current;
    }
    return writeShopRuntimeState(scopeToken.shopId, {
      status: 'ready',
      lastError: null,
      success: true,
    });
  }

  function markShopRuntimeFailure(scopeToken, failures = [], request = {}) {
    const errors = failures
      .filter(Boolean)
      .filter((error) => !isExpectedProductImportVisibilityDelay(request, error));
    if (!errors.length) return readShopRuntimeState(scopeToken.shopId);
    const authError = errors.find(isAuthenticationFailure);
    if (authError) {
      const status = errorHttpStatus(authError);
      const reason = isCompanyBlockedFailure(authError) ? 'COMPANY_BLOCKED' : 'CREDENTIAL_REJECTED';
      return writeShopRuntimeState(scopeToken.shopId, {
        status: 'auth_failed',
        failed: true,
        lastError: `PAUSED_AUTH:CREDENTIAL_REVISION=${scopeToken.credentialRevision}:REASON=${reason}:HTTP_${status || 'UNKNOWN'}`,
      });
    }
    const rateError = errors.find((error) => {
      const status = errorHttpStatus(error);
      return status === 429 || extractOzonCode(error) === '8';
    });
    if (rateError) {
      return writeShopRuntimeState(scopeToken.shopId, {
        status: 'rate_limited',
        failed: true,
        lastError: `RATE_LIMITED:${schedulerLastError(rateError, 'OZON_RATE_LIMITED')}`,
      });
    }
    const networkError = errors.find((error) => {
      const reason = retryController.classify(error).reason;
      return reason === 'network' || reason === 'timeout';
    });
    if (networkError) {
      return writeShopRuntimeState(scopeToken.shopId, {
        status: 'blocked',
        failed: true,
        lastError: `WAITING_NETWORK:${schedulerLastError(networkError, 'OZON_NETWORK_UNAVAILABLE')}`,
      });
    }
    const first = errors[0];
    return writeShopRuntimeState(scopeToken.shopId, {
      status: 'blocked',
      failed: true,
      lastError: first
        ? schedulerLastError(first, 'OZON_REQUEST_FAILED')
        : 'OZON_REQUEST_FAILED',
    });
  }

  function createAttempt({ jobId, requestId, shopId, endpointKey, payloadHash, attempt = 1 }) {
    const attemptId = createAttemptId();
    db.prepare(`
      INSERT INTO ozon_request_attempts (
        id, job_id, request_id, shop_id, endpoint_key, payload_hash,
        status, attempt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(attemptId, jobId, requestId, shopId || null, endpointKey, payloadHash || null, attempt, nowIso());
    return attemptId;
  }

  function finishAttempt(attemptId, patch = {}) {
    db.prepare(`
      UPDATE ozon_request_attempts SET
        status = ?, status_code = ?, ozon_error_code = ?, retry_after_ms = ?,
        duration_ms = ?, error_message = ?, finished_at = ?
      WHERE id = ?
    `).run(
      patch.status || 'success',
      patch.statusCode || null,
      patch.ozonErrorCode || null,
      patch.retryAfterMs || null,
      patch.durationMs || null,
      patch.errorMessage || null,
      nowIso(),
      attemptId,
    );
  }

  async function executeBatch({ request, endpoint, batch, jobId, shopCredentials, lockKey }) {
    const clientIdHash = createStableHash(shopCredentials.clientId || shopCredentials.client_id || request.shopId, { length: 16 });

    async function runAttempt(attemptNumber) {
      const requestId = createRequestId();
      const ticket = {
        ...batch,
        endpoint,
        jobId,
        requestId,
        shopId: request.shopId,
        domain: request.domain,
        endpointKey: request.endpointKey,
        priority: request.priority,
        profile: request.profile,
        source: request.source,
        snapshotId: request.snapshotId,
        clientIdHash,
      };

      return requestQueue.enqueue(ticket, async (activeTicket) => {
        assertShopScopeToken(request.scopeToken);
        lockService.heartbeat(lockKey, request.lockTtlMs);
        const started = Date.now();
        const attemptId = createAttempt({
          jobId,
          requestId,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          payloadHash: batch.payloadHash,
          attempt: attemptNumber,
        });
        jobService.updateJob(jobId, {
          status: SYNC_JOB_STATUS.running,
          stage: request.endpointKey,
          message: `正在读取 ${request.endpointKey} ${batch.index + 1} / ${batch.total} 批`,
          retryCount: attemptNumber - 1,
          lastEndpointKey: request.endpointKey,
          lastAttemptId: attemptId,
        });
        traceController.record({
          jobId,
          requestId,
          attemptId,
          domain: request.domain,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          batchIndex: batch.index + 1,
          batchTotal: batch.total,
          priority: request.priority,
          source: request.source,
          snapshotId: request.snapshotId,
          phase: 'request_sent',
          status: 'running',
          queueWaitMs: activeTicket.queueWaitMs,
          permitWaitMs: activeTicket.permitWaitMs,
          retryCount: attemptNumber - 1,
          sourceFile: 'local-api/src/ozon/ozonScheduler.js',
          sourceFunction: 'executeBatch',
        });

        let attemptFinalized = false;
        try {
          const response = await ozonClient.requestReadOnly({
            endpointKey: request.endpointKey,
            shopCredentials,
            payload: batch.params,
            requestId,
          });
          trafficController.recordSuccess(ticket);
          rateLimitState.recordSuccess(ticket);
          const requestDurationMs = Date.now() - started;
          const normalized = normalizer.normalize({ domain: request.domain, endpointKey: request.endpointKey, response, params: batch.params });
          // A credential rotation, delete/rebind, or profile move may happen
          // while the network request is in flight. Never let that stale
          // callback merge into the current shop generation.
          assertShopScopeToken(request.scopeToken);
          traceController.record({
            jobId,
            requestId,
            attemptId,
            domain: request.domain,
            shopId: request.shopId,
            endpointKey: request.endpointKey,
            batchIndex: batch.index + 1,
            batchTotal: batch.total,
            priority: request.priority,
            source: request.source,
            snapshotId: request.snapshotId,
            phase: 'response_received',
            status: 'success',
            requestDurationMs,
            retryCount: attemptNumber - 1,
            statusCode: response?.status || null,
            sourceFile: 'local-api/src/ozon/ozonScheduler.js',
            sourceFunction: 'executeBatch',
          });

          let merge = null;
          const mergeStarted = Date.now();
          if (request.cacheKey) {
            traceController.record({
              jobId,
              requestId,
              attemptId,
              domain: request.domain,
              shopId: request.shopId,
              endpointKey: request.endpointKey,
              batchIndex: batch.index + 1,
              batchTotal: batch.total,
              priority: request.priority,
              source: request.source,
              snapshotId: request.snapshotId,
              phase: 'merge_started',
              status: 'running',
              retryCount: attemptNumber - 1,
              sourceFile: 'local-api/src/ozon/ozonScheduler.js',
              sourceFunction: 'executeBatch',
            });
            merge = cacheMergeService.mergeResponse({
              domain: request.domain,
              shopId: request.shopId,
              endpointKey: request.endpointKey,
              cacheKey: batch.total > 1 ? `${request.cacheKey}:batch:${batch.index + 1}` : request.cacheKey,
              params: batch.params,
              payload: normalized.data,
              remoteHash: normalized.remoteHash,
              payloadHash: normalized.payloadHash,
              status: normalized.status,
              expiresAt: endpoint.cachePolicy?.ttlSeconds ? addSeconds(endpoint.cachePolicy.ttlSeconds) : null,
            });
            cacheReadService.hotCache.invalidate({
              tags: [`domain:${request.domain}`, `shop:${request.shopId}`],
            });
            traceController.record({
              jobId,
              requestId,
              attemptId,
              domain: request.domain,
              shopId: request.shopId,
              endpointKey: request.endpointKey,
              batchIndex: batch.index + 1,
              batchTotal: batch.total,
              priority: request.priority,
              source: request.source,
              snapshotId: request.snapshotId,
              phase: 'merge_finished',
              status: merge?.status || 'skipped',
              mergeDurationMs: Date.now() - mergeStarted,
              retryCount: attemptNumber - 1,
              sourceFile: 'local-api/src/ozon/ozonScheduler.js',
              sourceFunction: 'executeBatch',
            });
          }

          finishAttempt(attemptId, { status: 'success', statusCode: response?.status || null, durationMs: requestDurationMs });
          attemptFinalized = true;
          const currentJob = jobService.getJob(jobId);
          jobService.updateJob(jobId, {
            progressDone: Math.min((currentJob?.progress?.done || 0) + 1, batch.total),
            progressTotal: batch.total,
            stage: request.endpointKey,
            message: `已完成 ${request.endpointKey} ${Math.min((currentJob?.progress?.done || 0) + 1, batch.total)} / ${batch.total} 批`,
            retryCount: attemptNumber - 1,
            lastEndpointKey: request.endpointKey,
            lastAttemptId: attemptId,
          });

          return { ok: true, requestId, attemptId, batch, response, normalized, merge };
        } catch (error) {
          const expectedVisibilityDelay = isExpectedProductImportVisibilityDelay(request, error);
          if (isAuthenticationFailure(error) && !expectedVisibilityDelay) {
            // A 401/403 is revision-scoped, not batch-scoped. Cancel queued
            // siblings immediately so one expired key cannot create a burst of
            // identical authorization failures before the shop is paused.
            requestQueue.cancelJob(jobId);
          }
          trafficController.recordFailure(ticket, error);
          if (!expectedVisibilityDelay) rateLimitState.recordFailure(ticket, error);
          const queueStatus = error?.code === 'OZON_CIRCUIT_OPEN'
            ? 'circuit_open'
            : error?.status === 429 || error?.retryAfterMs != null || extractOzonCode(error) === '8'
              ? 'rate_limited'
              : 'failed';
          const requestDurationMs = Date.now() - started;
          try {
            finishAttempt(attemptId, {
              status: queueStatus,
              statusCode: error?.status || error?.statusCode || null,
              ozonErrorCode: error?.code || 'OZON_REQUEST_FAILED',
              retryAfterMs: error?.retryAfterMs || null,
              durationMs: requestDurationMs,
              errorMessage: publicErrorMessage(error),
            });
            attemptFinalized = true;
          } catch (finishError) {
            logger(
              '[local-api][ozon-scheduler] attempt finalization deferred to finally',
              safeLogPayload({
                jobId,
                attemptId,
                endpointKey: request.endpointKey,
                errorCode: finishError?.code || 'OZON_ATTEMPT_FINALIZE_FAILED',
              })
            );
          }
          traceController.record({
            jobId,
            requestId,
            attemptId,
            domain: request.domain,
            shopId: request.shopId,
            endpointKey: request.endpointKey,
            batchIndex: batch.index + 1,
            batchTotal: batch.total,
            priority: request.priority,
            source: request.source,
            snapshotId: request.snapshotId,
            phase: 'failed',
            status: queueStatus,
            requestDurationMs,
            retryCount: attemptNumber - 1,
            retryAfterMs: error?.retryAfterMs || null,
            statusCode: error?.status || error?.statusCode || null,
            ozonCode: extractOzonCode(error),
            errorMessage: publicErrorMessage(error),
            sourceFile: 'local-api/src/ozon/ozonScheduler.js',
            sourceFunction: 'executeBatch',
          });
          recordError({
            jobId,
            domain: request.domain,
            shopId: request.shopId,
            endpointKey: request.endpointKey,
            errorCode: error?.code || 'OZON_REQUEST_FAILED',
            errorMessage: publicErrorMessage(error),
            severity: 'warning',
          });
          throw error;
        } finally {
          if (!attemptFinalized) {
            try {
              finishAttempt(attemptId, {
                status: 'failed',
                ozonErrorCode: 'OZON_ATTEMPT_INTERRUPTED',
                durationMs: Date.now() - started,
                errorMessage: 'Ozon 请求已结束，但本地任务收尾失败。',
              });
            } catch (finishError) {
              logger(
                '[local-api][ozon-scheduler] attempt finalization failed',
                safeLogPayload({
                  jobId,
                  attemptId,
                  endpointKey: request.endpointKey,
                  errorCode: finishError?.code || 'OZON_ATTEMPT_FINALIZE_FAILED',
                })
              );
            }
          }
        }
      });
    }

    for (let attempt = 1; attempt <= retryController.maxAttempts; attempt += 1) {
      try {
        return await runAttempt(attempt);
      } catch (error) {
        const decision = retryController.getDecision(error, attempt);
        if (!decision.shouldRetry) throw error;
        traceController.record({
          jobId,
          domain: request.domain,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          batchIndex: batch.index + 1,
          batchTotal: batch.total,
          priority: request.priority,
          source: request.source,
          snapshotId: request.snapshotId,
          phase: 'retry_scheduled',
          status: decision.reason,
          retryCount: attempt,
          retryAfterMs: decision.retryAfterMs,
          statusCode: decision.status || null,
          ozonCode: decision.ozonCode || extractOzonCode(error),
          errorMessage: publicErrorMessage(error),
          sourceFile: 'local-api/src/ozon/ozonScheduler.js',
          sourceFunction: 'executeBatch',
        });
        jobService.updateJob(jobId, {
          status: SYNC_JOB_STATUS.running,
          stage: request.endpointKey,
          message: `限流/超时后排队重试 ${request.endpointKey}，第 ${attempt + 1} 次尝试`,
          retryCount: attempt,
          nextRetryAt: decision.nextRetryAt,
          lastRetryAfterMs: decision.retryAfterMs,
          lastEndpointKey: request.endpointKey,
        });
        await retryController.wait(decision);
      }
    }

    throw createSchedulerError('OZON_RETRY_EXHAUSTED', 'Ozon request retry attempts were exhausted.', { jobId, endpointKey: request.endpointKey });
  }

  async function executeReadOnly(input = {}) {
    const request = normalizeSchedulerRequest(input);
    request.scopeToken = captureShopScopeToken(request.shopId);
    const pausedAuth = authPauseForCurrentRevision(request.scopeToken, request);
    if (pausedAuth) {
      const companyBlocked = isCompanyBlockedPause(pausedAuth.lastError);
      return {
        ok: false,
        status: 'blocked',
        reused: false,
        job: null,
        jobId: null,
        reason: companyBlocked ? 'shop_company_blocked' : 'shop_paused_auth',
        error: {
          code: companyBlocked ? 'OZON_COMPANY_BLOCKED' : 'OZON_AUTH_PAUSED',
          message: companyBlocked
            ? '该店铺已被 Ozon 封禁，无法刷新数据。'
            : 'Ozon synchronization is paused until this shop credential revision changes.',
        },
      };
    }
    const endpoint = assertReadOnlyEndpoint(getOzonEndpoint(request.endpointKey));
    request.cacheKey = request.cacheKey || buildOzonCacheKey(request);
    const requestFingerprint = createRequestFingerprint(request);
    request.requestFingerprint = requestFingerprint;
    const dedupeUntil = new Date(Date.now() + request.dedupeTtlMs).toISOString();

    if (inFlight.has(requestFingerprint)) {
      const activeJob = inFlight.get(requestFingerprint);
      const activeResult = inFlightResults.get(requestFingerprint);
      if (request.waitForResult && activeResult) {
        const settled = await activeResult;
        return {
          ...settled,
          reused: true,
          reusedFromJobId: activeJob.jobId,
          reason: 'request_fingerprint_active',
        };
      }
      return toJobPayload(activeJob, { reused: true, reusedFromJobId: activeJob.jobId, reason: 'request_fingerprint_active', status: activeJob.status });
    }

    const reusable = jobService.findReusableJob({ requestFingerprint, idempotencyKey: request.idempotencyKey });
    if (reusable?.job) {
      const cache = ['success', 'partial'].includes(reusable.job.status)
        ? cacheReadService.getCacheRow(request.domain, request.cacheKey, request.shopId)
        : null;
      return toJobPayload(reusable.job, {
        reused: true,
        reusedFromJobId: reusable.job.jobId,
        reason: reusable.reason,
        status: reusable.job.status,
        ...(cache ? { cache } : {}),
      });
    }

    if (!request.forceRefresh) {
      const cacheFresh = cacheReadService.isCacheFresh(request.domain, request.cacheKey, request.shopId);
      if (cacheFresh.fresh) {
        return {
          ok: true,
          reused: false,
          cacheHit: true,
          status: 'cache_hit',
          job: null,
          jobId: null,
          cache: cacheFresh.row,
          reason: 'fresh_cache',
        };
      }
    }

    const batches = batchPlanner.plan(request, endpoint);
    const jobId = `ozon_job_${randomUUID()}`;
    const lockKey = lockService.buildLockKey({ domain: request.domain, shopId: request.shopId, cacheKey: request.cacheKey });
    const lock = lockService.acquire({ domain: request.domain, shopId: request.shopId, cacheKey: request.cacheKey, ownerJobId: jobId, ttlMs: request.lockTtlMs });
    if (!lock.acquired) {
      const existingJob = lock.existingJobId ? jobService.getJob(lock.existingJobId) : null;
      if (
        existingJob?.requestFingerprint &&
        existingJob.requestFingerprint !== requestFingerprint
      ) {
        const errorMessage = `Cache key ${request.cacheKey} is already locked by a different request.`;
        recordError({
          jobId: existingJob.jobId,
          domain: request.domain,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          errorCode: 'OZON_CACHE_KEY_COLLISION',
          errorMessage,
          severity: 'error',
        });
        return {
          ok: false,
          status: 'failed',
          reused: false,
          reusedFromJobId: existingJob.jobId,
          reason: 'cache_key_collision',
          error: {
            code: 'OZON_CACHE_KEY_COLLISION',
            message: errorMessage,
          },
        };
      }
      return toJobPayload(existingJob, {
        reused: true,
        reusedFromJobId: lock.existingJobId,
        reason: 'active_sync_lock',
        lock: lock.lock,
        status: existingJob?.status || 'queued',
      });
    }

    cacheKeyService.registerCacheKey({
      domain: request.domain,
      shopId: request.shopId,
      endpointKey: request.endpointKey,
      action: request.action,
      params: request.params,
      cacheKey: request.cacheKey,
      allowStale: request.allowStale,
      policy: endpoint.cachePolicy?.policy || 'entity_snapshot',
    });

    const job = jobService.createJob({
      id: jobId,
      domain: request.domain,
      shopId: request.shopId,
      endpointKey: request.endpointKey,
      action: request.action,
      priority: request.priority,
      profile: request.profile,
      source: request.source,
      snapshotId: request.snapshotId,
      requestedBy: request.requestedBy,
      cacheKey: request.cacheKey,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      dedupeUntil,
      lockKey,
      progressTotal: batches.length,
      stage: request.endpointKey,
      message: `等待调度 ${request.endpointKey}，共 ${batches.length} 批。`,
    });
    traceController.record({
      jobId: job.jobId,
      domain: request.domain,
      shopId: request.shopId,
      endpointKey: request.endpointKey,
      priority: request.priority,
      source: request.source,
      snapshotId: request.snapshotId,
      phase: 'created',
      status: 'queued',
      sourceFile: 'local-api/src/ozon/ozonScheduler.js',
      sourceFunction: 'executeReadOnly',
    });
    inFlight.set(requestFingerprint, job);
    let settleInFlightResult;
    const inFlightResult = new Promise((resolve) => {
      settleInFlightResult = resolve;
    });
    inFlightResults.set(requestFingerprint, inFlightResult);
    let inFlightSettled = false;
    const settleInFlight = (payload) => {
      if (inFlightSettled) return;
      inFlightSettled = true;
      settleInFlightResult(payload);
    };

    stateService.upsertState({ domain: request.domain, shopId: request.shopId, scopeKey: request.cacheKey, status: 'running', lastAttemptAt: nowIso() });

    try {
      const shopCredentials = shopRepository.getShopCredentialsForInternalUse(request.shopId);
      if (!shopCredentials?.clientId || !shopCredentials?.apiKey) {
        throw createSchedulerError('OZON_CREDENTIALS_MISSING', 'Scheduled Ozon request requires stored shop credentials.', { shopId: request.shopId });
      }

      jobService.updateJob(job.jobId, {
        status: SYNC_JOB_STATUS.running,
        startedAt: nowIso(),
        stage: request.endpointKey,
        message: `开始同步 ${request.endpointKey}，共 ${batches.length} 批。`,
      });
      logger('[local-api][ozon-scheduler] job running', safeLogPayload({ jobId: job.jobId, domain: request.domain, endpointKey: request.endpointKey, shopId: request.shopId, batchCount: batches.length }));

      const settled = await Promise.allSettled(batches.map((batch) => executeBatch({ request, endpoint, batch, jobId: job.jobId, shopCredentials, lockKey })));
      const successes = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
      const failures = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
      const changedCount = successes.filter((item) => ['inserted', 'updated'].includes(item.merge?.status)).length;
      const unchangedCount = successes.filter((item) => item.merge?.status === 'unchanged').length;
      const failedCount = failures.length;
      const finalStatus = failedCount === 0 ? SYNC_JOB_STATUS.success : successes.length > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
      const lastError = failures[0] ? schedulerLastError(failures[0], 'OZON_REQUEST_FAILED') : null;
      if (failedCount === 0) markShopRuntimeReady(request.scopeToken);
      else markShopRuntimeFailure(request.scopeToken, failures, request);
      const finalJob = jobService.updateJob(job.jobId, {
        status: finalStatus,
        progressDone: successes.length,
        progressTotal: batches.length,
        changedCount,
        unchangedCount,
        failedCount,
        lastError,
        finishedAt: nowIso(),
        stage: request.endpointKey,
        message: finalStatus === SYNC_JOB_STATUS.success
          ? `同步完成 ${request.endpointKey}，SQLite 已合并。`
          : `同步结束 ${request.endpointKey}，成功 ${successes.length} 批，失败 ${failedCount} 批。`,
        nextRetryAt: null,
      });
      stateService.upsertState({ domain: request.domain, shopId: request.shopId, scopeKey: request.cacheKey, status: finalStatus, lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(), lastAttemptAt: nowIso(), lastError, changedCount, unchangedCount });
      traceController.record({
        jobId: job.jobId,
        domain: request.domain,
        shopId: request.shopId,
        endpointKey: request.endpointKey,
        priority: request.priority,
        source: request.source,
        snapshotId: request.snapshotId,
        phase: finalStatus === SYNC_JOB_STATUS.success ? 'success' : 'failed',
        status: finalStatus,
        retryCount: finalJob.retry?.count || 0,
        errorMessage: lastError,
        sourceFile: 'local-api/src/ozon/ozonScheduler.js',
        sourceFunction: 'executeReadOnly',
      });
      const payload = toJobPayload(finalJob, {
        reused: false,
        status: finalStatus,
        data: successes[0]?.normalized?.data ?? null,
        results: successes.map((item) => ({ requestId: item.requestId, endpointKey: request.endpointKey, remoteHash: item.normalized.remoteHash, rowCount: item.normalized.rowCount, mergeStatus: item.merge?.status || null })),
        errors: failures.map(publicError),
      });
      settleInFlight(payload);

      return payload;
    } catch (error) {
      const code = error?.code || 'OZON_SCHEDULER_ERROR';
      markShopRuntimeFailure(request.scopeToken, [error], request);
      const finalStatus = code === 'OZON_CIRCUIT_OPEN'
        ? SYNC_JOB_STATUS.circuitOpen
        : code === 'OZON_RATE_LIMITED'
          ? SYNC_JOB_STATUS.rateLimited
          : code === 'OZON_CREDENTIALS_MISSING'
            ? SYNC_JOB_STATUS.blocked
            : SYNC_JOB_STATUS.failed;
      const finalJob = jobService.updateJob(job.jobId, {
        status: finalStatus,
        failedCount: batches.length,
        lastError: schedulerLastError(error, code),
        finishedAt: nowIso(),
        stage: request.endpointKey,
        message: `同步失败 ${request.endpointKey}：${publicErrorMessage(error)}`,
      });
      stateService.upsertState({ domain: request.domain, shopId: request.shopId, scopeKey: request.cacheKey, status: finalStatus, lastAttemptAt: nowIso(), lastError: finalJob.lastError });
      recordError({ jobId: job.jobId, domain: request.domain, shopId: request.shopId, endpointKey: request.endpointKey, errorCode: code, errorMessage: publicErrorMessage(error), severity: finalStatus === SYNC_JOB_STATUS.blocked ? 'info' : 'error' });
      traceController.record({
        jobId: job.jobId,
        domain: request.domain,
        shopId: request.shopId,
        endpointKey: request.endpointKey,
        priority: request.priority,
        source: request.source,
        snapshotId: request.snapshotId,
        phase: 'failed',
        status: finalStatus,
        errorMessage: publicErrorMessage(error),
        sourceFile: 'local-api/src/ozon/ozonScheduler.js',
        sourceFunction: 'executeReadOnly',
      });
      const payload = toJobPayload(finalJob, { reused: false, status: finalStatus, errors: [publicError(error)] });
      settleInFlight(payload);
      return payload;
    } finally {
      if (!inFlightSettled) {
        let fallbackJob = null;
        try {
          const currentJob = jobService.getJob(job.jobId);
          fallbackJob = ['queued', 'running', 'rate_limited', 'circuit_open'].includes(currentJob?.status)
            ? jobService.updateJob(job.jobId, {
                status: SYNC_JOB_STATUS.failed,
                failedCount: batches.length,
                lastError: 'OZON_SCHEDULER_FINALIZATION_FAILED',
                finishedAt: nowIso(),
                stage: request.endpointKey,
                message: `同步收尾失败 ${request.endpointKey}，可重新读取。`,
                nextRetryAt: null,
              })
            : currentJob;
        } catch (finalizeError) {
          logger(
            '[local-api][ozon-scheduler] job fallback finalization failed',
            safeLogPayload({
              jobId: job.jobId,
              endpointKey: request.endpointKey,
              errorCode: finalizeError?.code || 'OZON_SCHEDULER_FINALIZATION_FAILED',
            })
          );
        }
        settleInFlight(
          fallbackJob
            ? toJobPayload(fallbackJob, {
                reused: false,
                status: fallbackJob.status,
                errors: [{ code: 'OZON_SCHEDULER_FINALIZATION_FAILED', message: '本地任务收尾失败，请重新读取。' }],
              })
            : {
                ok: false,
                reused: false,
                status: 'failed',
                job: null,
                jobId: job.jobId,
                errors: [{ code: 'OZON_SCHEDULER_FINALIZATION_FAILED', message: '本地任务收尾失败，请重新读取。' }],
              }
        );
      }
      try {
        lockService.release(lockKey, job.jobId);
      } catch (releaseError) {
        logger(
          '[local-api][ozon-scheduler] lock release failed',
          safeLogPayload({
            jobId: job.jobId,
            endpointKey: request.endpointKey,
            errorCode: releaseError?.code || 'OZON_SYNC_LOCK_RELEASE_FAILED',
          })
        );
      }
      inFlight.delete(requestFingerprint);
      inFlightResults.delete(requestFingerprint);
    }
  }

  async function executeWrite(input = {}) {
    const request = normalizeSchedulerRequest({
      ...input,
      priority: 'WRITE',
      profile: input.profile || 'write',
      source: input.source || 'write_confirm',
      action: normalizeText(input.action) || 'write',
    });
    request.scopeToken = captureShopScopeToken(request.shopId);
    const endpoint = assertWriteEndpoint(getOzonEndpoint(request.endpointKey));
    const realWrite = input.realWrite === true;
    const dryRun = input.dryRun !== false || !realWrite;
    const jobId = `ozon_job_${randomUUID()}`;
    const requestId = createRequestId();
    const payloadHash = createStableHash(request.params, { length: 32 });
    const requestFingerprint = createStableHash({
      shopId: request.shopId,
      domain: request.domain,
      endpointKey: request.endpointKey,
      action: request.action,
      params: request.params,
      realWrite,
      dryRun,
      previewId: input.previewId || null,
    }, { length: 32 });
    const job = jobService.createJob({
      id: jobId,
      domain: request.domain,
      shopId: request.shopId,
      endpointKey: request.endpointKey,
      action: request.action,
      priority: 'P0',
      profile: 'write',
      source: request.source,
      requestedBy: request.requestedBy,
      cacheKey: request.cacheKey || `write:${request.endpointKey}:${payloadHash}`,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + request.dedupeTtlMs).toISOString(),
      progressTotal: 1,
      stage: request.endpointKey,
      message: `等待写入 ${request.endpointKey}。`,
    });

    if (dryRun) {
      const finalJob = jobService.updateJob(job.jobId, {
        status: SYNC_JOB_STATUS.success,
        progressDone: 1,
        progressTotal: 1,
        changedCount: 0,
        unchangedCount: 1,
        finishedAt: nowIso(),
      });
      logger('[local-api][ozon-scheduler] write dry-run recorded', safeLogPayload({
        jobId: finalJob.jobId,
        endpointKey: request.endpointKey,
        shopId: request.shopId,
        previewId: input.previewId || null,
      }));
      return {
        ok: true,
        status: 'dry_run',
        jobId: finalJob.jobId,
        job: finalJob,
        endpointKey: request.endpointKey,
        realWrite: false,
        dryRun: true,
        readBackRows: input.readBackRows || input.params?.readBackRows || [],
        data: {
          ok: true,
          dryRun: true,
          endpointKey: request.endpointKey,
          previewId: input.previewId || null,
        },
      };
    }

    if (!allowRealWrite) {
      const finalJob = jobService.updateJob(job.jobId, {
        status: SYNC_JOB_STATUS.blocked,
        failedCount: 1,
        lastError: 'REAL_OZON_WRITE_DISABLED: Real Ozon write is disabled by local-api config.',
        finishedAt: nowIso(),
      });
      recordError({
        jobId: job.jobId,
        domain: request.domain,
        shopId: request.shopId,
        endpointKey: request.endpointKey,
        errorCode: 'REAL_OZON_WRITE_DISABLED',
        errorMessage: 'Real Ozon write is disabled by local-api config.',
        severity: 'info',
      });
      return {
        ok: false,
        status: 'blocked',
        jobId: finalJob.jobId,
        job: finalJob,
        endpointKey: request.endpointKey,
        realWrite: false,
        dryRun: false,
        error: {
          code: 'REAL_OZON_WRITE_DISABLED',
          message: '真实 Ozon 写入未启用。需要设置 LOCAL_API_ENABLE_REAL_OZON_WRITE=1 并在确认请求里传 realWrite=true、dryRun=false。',
        },
      };
    }

    if (!ozonClient?.requestWrite) {
      const finalJob = jobService.updateJob(job.jobId, {
        status: SYNC_JOB_STATUS.blocked,
        failedCount: 1,
        lastError: 'OZON_WRITE_CLIENT_NOT_CONNECTED: ozonClient.requestWrite is unavailable.',
        finishedAt: nowIso(),
      });
      return {
        ok: false,
        status: 'blocked',
        jobId: finalJob.jobId,
        job: finalJob,
        endpointKey: request.endpointKey,
        realWrite: false,
        dryRun: false,
        error: {
          code: 'OZON_WRITE_CLIENT_NOT_CONNECTED',
          message: 'ozonClient.requestWrite is unavailable.',
        },
      };
    }

    const shopCredentials = shopRepository.getShopCredentialsForInternalUse(request.shopId);
    if (!shopCredentials?.clientId || !shopCredentials?.apiKey) {
      const finalJob = jobService.updateJob(job.jobId, {
        status: SYNC_JOB_STATUS.blocked,
        failedCount: 1,
        lastError: 'OZON_CREDENTIALS_MISSING: Scheduled Ozon write requires stored shop credentials.',
        finishedAt: nowIso(),
      });
      return {
        ok: false,
        status: 'blocked',
        jobId: finalJob.jobId,
        job: finalJob,
        endpointKey: request.endpointKey,
        realWrite: false,
        dryRun: false,
        error: {
          code: 'OZON_CREDENTIALS_MISSING',
          message: 'Scheduled Ozon write requires stored shop credentials.',
        },
      };
    }

    jobService.updateJob(job.jobId, {
      status: SYNC_JOB_STATUS.running,
      startedAt: nowIso(),
      stage: request.endpointKey,
      message: `正在写入 ${request.endpointKey}。`,
    });
    const ticket = {
      endpoint,
      jobId: job.jobId,
      requestId,
      shopId: request.shopId,
      domain: request.domain,
      endpointKey: request.endpointKey,
      priority: 'WRITE',
      profile: 'write',
      source: request.source,
      clientIdHash: createStableHash(shopCredentials.clientId || shopCredentials.client_id || request.shopId, { length: 16 }),
    };

    const writePromise = requestQueue.enqueue(ticket, async (activeTicket) => {
      assertShopScopeToken(request.scopeToken);
      const started = Date.now();
      const attemptId = createAttempt({
        jobId: job.jobId,
        requestId,
        shopId: request.shopId,
        endpointKey: request.endpointKey,
        payloadHash,
      });
      jobService.updateJob(job.jobId, {
        lastEndpointKey: request.endpointKey,
        lastAttemptId: attemptId,
      });
      traceController.record({
        jobId: job.jobId,
        requestId,
        attemptId,
        domain: request.domain,
        shopId: request.shopId,
        endpointKey: request.endpointKey,
        priority: 'P0',
        source: request.source,
        phase: 'request_sent',
        status: 'running',
        queueWaitMs: activeTicket.queueWaitMs,
        permitWaitMs: activeTicket.permitWaitMs,
        sourceFile: 'local-api/src/ozon/ozonScheduler.js',
        sourceFunction: 'executeWrite',
      });

      try {
        const response = await ozonClient.requestWrite({
          endpointKey: request.endpointKey,
          shopCredentials,
          payload: request.params,
          requestId,
        });
        // Do not accept an old-generation write callback as a valid local
        // completion/readback input after delete, rebind, or credential rotate.
        assertShopScopeToken(request.scopeToken);
        const writeApplicationResult = inspectOzonWriteApplicationResult({
          endpointKey: request.endpointKey,
          data: response?.data,
        });
        if (!writeApplicationResult.ok) {
          const finalStatus =
            writeApplicationResult.successCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
          trafficController.recordSuccess(ticket);
          rateLimitState.recordSuccess(ticket);
          finishAttempt(attemptId, {
            status: finalStatus,
            statusCode: response?.status || null,
            ozonErrorCode: 'OZON_WRITE_APPLICATION_ERROR',
            durationMs: Date.now() - started,
            errorMessage: writeApplicationResult.message,
          });
          const finalJob = jobService.updateJob(job.jobId, {
            status: finalStatus,
            progressDone: writeApplicationResult.successCount,
            progressTotal: Math.max(1, writeApplicationResult.itemCount || writeApplicationResult.failedCount),
            changedCount: writeApplicationResult.successCount,
            failedCount: writeApplicationResult.failedCount,
            lastError: `OZON_WRITE_APPLICATION_ERROR: ${writeApplicationResult.message}`,
            finishedAt: nowIso(),
            stage: request.endpointKey,
            message: writeApplicationResult.message,
          });
          recordError({
            jobId: job.jobId,
            domain: request.domain,
            shopId: request.shopId,
            endpointKey: request.endpointKey,
            errorCode: 'OZON_WRITE_APPLICATION_ERROR',
            errorMessage: writeApplicationResult.message,
            severity: 'error',
          });
          return {
            ok: false,
            status: finalStatus,
            jobId: finalJob.jobId,
            job: finalJob,
            endpointKey: request.endpointKey,
            realWrite: true,
            dryRun: false,
            data: response?.data ?? response,
            error: {
              code: 'OZON_WRITE_APPLICATION_ERROR',
              message: writeApplicationResult.message,
              response: safeLogPayload(response?.data ?? response),
              failedItems: safeLogPayload(writeApplicationResult.failedItems),
            },
          };
        }
        trafficController.recordSuccess(ticket);
        rateLimitState.recordSuccess(ticket);
        finishAttempt(attemptId, {
          status: 'success',
          statusCode: response?.status || null,
          durationMs: Date.now() - started,
        });
        const finalJob = jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.success,
          progressDone: 1,
          progressTotal: 1,
          changedCount: 1,
          finishedAt: nowIso(),
          stage: request.endpointKey,
          message: `写入 ${request.endpointKey} 已返回成功，等待业务 readback 规则确认最终展示。`,
          lastEndpointKey: request.endpointKey,
          lastAttemptId: attemptId,
        });
        traceController.record({
          jobId: finalJob.jobId,
          requestId,
          attemptId,
          domain: request.domain,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          priority: 'P0',
          source: request.source,
          phase: 'success',
          status: 'success',
          requestDurationMs: Date.now() - started,
          statusCode: response?.status || null,
          sourceFile: 'local-api/src/ozon/ozonScheduler.js',
          sourceFunction: 'executeWrite',
        });
        logger('[local-api][ozon-scheduler] real write executed', safeLogPayload({
          jobId: finalJob.jobId,
          endpointKey: request.endpointKey,
          shopId: request.shopId,
          previewId: input.previewId || null,
        }));
        return {
          ok: true,
          status: 'success',
          jobId: finalJob.jobId,
          job: finalJob,
          endpointKey: request.endpointKey,
          realWrite: true,
          dryRun: false,
          data: response?.data ?? response,
          readBackRows: input.readBackRows || input.params?.readBackRows || [],
        };
      } catch (error) {
        trafficController.recordFailure(ticket, error);
        rateLimitState.recordFailure(ticket, error);
        const status = error?.status === 429 || error?.retryAfterMs != null || extractOzonCode(error) === '8' ? SYNC_JOB_STATUS.rateLimited : SYNC_JOB_STATUS.failed;
        finishAttempt(attemptId, {
          status,
          statusCode: error?.status || error?.statusCode || null,
          ozonErrorCode: error?.code || 'OZON_WRITE_FAILED',
          retryAfterMs: error?.retryAfterMs || null,
          durationMs: Date.now() - started,
          errorMessage: publicErrorMessage(error),
        });
        const finalJob = jobService.updateJob(job.jobId, {
          status,
          failedCount: 1,
          lastError: schedulerLastError(error, 'OZON_WRITE_FAILED'),
          finishedAt: nowIso(),
          stage: request.endpointKey,
          message: `写入失败 ${request.endpointKey}：${publicErrorMessage(error)}`,
          lastEndpointKey: request.endpointKey,
          lastAttemptId: attemptId,
        });
        traceController.record({
          jobId: finalJob.jobId,
          requestId,
          attemptId,
          domain: request.domain,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          priority: 'P0',
          source: request.source,
          phase: 'failed',
          status,
          requestDurationMs: Date.now() - started,
          retryAfterMs: error?.retryAfterMs || null,
          statusCode: error?.status || error?.statusCode || null,
          ozonCode: extractOzonCode(error),
          errorMessage: publicErrorMessage(error),
          sourceFile: 'local-api/src/ozon/ozonScheduler.js',
          sourceFunction: 'executeWrite',
        });
        recordError({
          jobId: job.jobId,
          domain: request.domain,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          errorCode: error?.code || 'OZON_WRITE_FAILED',
          errorMessage: publicErrorMessage(error),
          severity: 'error',
        });
        return {
          ok: false,
          status,
          jobId: finalJob.jobId,
          job: finalJob,
          endpointKey: request.endpointKey,
          realWrite: true,
          dryRun: false,
          error: publicError(error),
        };
      }
    });

    if (input.waitForResult === false || input.fastAck === true || input.asyncWrite === true) {
      const notifyAsyncWriteSettled = (result) => {
        if (typeof input.onAsyncWriteSettled !== 'function') return;
        Promise.resolve(input.onAsyncWriteSettled(result)).catch((error) => {
          logger('[local-api][ozon-scheduler] async write settle callback failed', safeLogPayload({
            jobId: job.jobId,
            endpointKey: request.endpointKey,
            shopId: request.shopId,
            error: publicErrorMessage(error),
          }));
        });
      };
      writePromise
        .then((result) => {
          notifyAsyncWriteSettled(result);
          return result;
        })
        .catch((error) => {
        const finalJob = jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          failedCount: 1,
          lastError: schedulerLastError(error, 'OZON_WRITE_QUEUE_FAILED'),
          finishedAt: nowIso(),
        });
        recordError({
          jobId: job.jobId,
          domain: request.domain,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          errorCode: error?.code || 'OZON_WRITE_QUEUE_FAILED',
          errorMessage: publicErrorMessage(error),
          severity: 'error',
        });
        logger('[local-api][ozon-scheduler] async write queue failed', safeLogPayload({
          jobId: finalJob.jobId,
          endpointKey: request.endpointKey,
          shopId: request.shopId,
          error: publicErrorMessage(error),
        }));
          notifyAsyncWriteSettled({
            ok: false,
            status: SYNC_JOB_STATUS.failed,
            jobId: finalJob.jobId,
            job: finalJob,
            endpointKey: request.endpointKey,
            realWrite: true,
            dryRun: false,
            error: publicError(error),
          });
        });
      return {
        ok: true,
        accepted: true,
        pending: true,
        status: 'accepted',
        jobId: job.jobId,
        job: jobService.getJob(job.jobId),
        endpointKey: request.endpointKey,
        realWrite: true,
        dryRun: false,
        writeConnected: true,
        message: 'Ozon write accepted by local-api queue and is running in background.',
      };
    }

    return writePromise;
  }

  function getAccountRemovalShopRuntimeStatus(shopId) {
    const ownerId = normalizeText(shopId);
    const queue = requestQueue.getShopStatus(ownerId);
    const schedulerInFlight = [...inFlight.values()].filter((job) => job?.shopId === ownerId).length;
    const hotCacheEntries = cacheReadService.hotCache.count({ tags: [`shop:${ownerId}`] });
    return {
      shopId: ownerId,
      queue,
      schedulerInFlight,
      hotCacheEntries,
      trafficStateCount: trafficController.countShopState(ownerId),
      rateLimitMemoryCount: rateLimitState.countMemoryShopState(ownerId),
    };
  }

  async function quiesceAccountRemovalShop(shopId, options = {}) {
    const ownerId = normalizeText(shopId);
    const queue = await requestQueue.quiesceShop(ownerId, options);
    const deadline = Date.now() + Math.max(1, Number(options.timeoutMs) || 30_000);
    while ([...inFlight.values()].some((job) => job?.shopId === ownerId)) {
      if (Date.now() >= deadline) {
        throw createSchedulerError('OZON_SCHEDULER_OWNER_DRAIN_TIMEOUT', 'Timed out draining owner-scoped scheduler work.', { shopId: ownerId });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { ok: true, queue, status: getAccountRemovalShopRuntimeStatus(ownerId) };
  }

  function clearAccountRemovalShopRuntime(shopId) {
    const ownerId = normalizeText(shopId);
    const hotCache = cacheReadService.hotCache.invalidate({ tags: [`shop:${ownerId}`] });
    const traffic = trafficController.clearShop(ownerId);
    const rateLimit = rateLimitState.clearMemoryShopState(ownerId);
    return { ok: true, hotCache, traffic, rateLimit };
  }

  return {
    executeReadOnly,
    executeWrite,
    listEndpoints() { return listOzonEndpoints(); },
    getJob(jobId) {
      const job = jobService.getJob(jobId);
      if (!job) return null;
      // Domain sync jobs (products_sync_*, orders_sync_*, ...) are parent jobs
      // and never own scheduler trace rows. Falling back to encrypted history
      // for those IDs turns a lightweight lifecycle poll into a full archive
      // directory scan. Only ozon_job_* IDs can have scheduler traces.
      if (!isSchedulerTraceJobId(job.jobId || job.id || jobId)) return job;
      const lastTrace = traceController.getLastForJob(jobId);
      return lastTrace ? { ...job, trace: { ...job.trace, lastEvent: lastTrace } } : job;
    },
    // Internal background admission only needs the durable job state. Avoid a
    // trace lookup (and a telemetry flush) on every 500 ms scheduler poll.
    getJobRuntimeStatus(jobId) {
      return jobService.getJob(jobId);
    },
    flushTelemetry() {
      return traceController.flush();
    },
    listJobs(filters = {}) { return jobService.listJobs(filters); },
    cancelJob(jobId, reason = 'canceled_by_api') {
      const queueResult = requestQueue.cancelJob(jobId);
      const job = jobService.cancelJob(jobId, reason);
      if (job?.lockKey) lockService.release(job.lockKey, job.jobId);
      return { ok: Boolean(job), job, queue: queueResult };
    },
    listSyncState(domain, filters = {}) { return stateService.listStates(domain, filters); },
    readCache(domain, filters = {}) { return cacheReadService.readDomainCache(domain, filters); },
    getSchedulerStatus() {
      const queue = requestQueue.getStatus();
      return {
        ok: true,
        startupRecovery,
        queue,
        traffic: trafficController.getStatus(),
        jobs: jobService.listJobs({ limit: 20 }),
        locks: lockService.listLocks({ status: 'active' }),
        background: {
          profile: 'background',
          queued: queue.queuedByProfile?.background || 0,
          running: queue.activeByProfile?.background || 0,
        },
      };
    },
    getRateLimitStatus(filters = {}) { return rateLimitState.getStatus(filters); },
    getShopRuntimeState(shopId) { return readShopRuntimeState(shopId); },
    pauseShop(shopId) { return requestQueue.pauseShop(shopId); },
    resumeShop(shopId) { return requestQueue.resumeShop(shopId); },
    pauseEndpoint(endpointKey) { return requestQueue.pauseEndpoint(endpointKey); },
    resumeEndpoint(endpointKey) { return requestQueue.resumeEndpoint(endpointKey); },
    quiesceAccountRemovalShop,
    getAccountRemovalShopRuntimeStatus,
    clearAccountRemovalShopRuntime,
    releaseAccountRemovalShopFence(shopId) { return requestQueue.resumeShop(shopId); },
    listErrors(filters = {}) {
      const rows = db.prepare(`
        SELECT id, job_id, domain, shop_id, endpoint_key, error_code,
               error_message, severity, created_at
        FROM ozon_error_events
        WHERE (? IS NULL OR domain = ?) AND (? IS NULL OR shop_id = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `).all(filters.domain || null, filters.domain || null, filters.shopId || null, filters.shopId || null, Math.min(Number(filters.limit) || 100, 500));
      return rows.map((row) => ({ id: row.id, jobId: row.job_id || null, domain: row.domain || null, shopId: row.shop_id || null, endpointKey: row.endpoint_key || null, errorCode: row.error_code, errorMessage: row.error_message, severity: row.severity, createdAt: row.created_at }));
    },
  };
}

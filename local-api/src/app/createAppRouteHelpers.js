function createBadJsonPayload(error) {
  const accountRemovalCode =
    typeof error?.code === "string" && error.code.startsWith("ACCOUNT_REMOVAL_")
      ? error.code
      : null;
  return {
    ok: false,
    error: {
      code: accountRemovalCode || "BAD_JSON_BODY",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function createModelApiDiscoveryFailureUpdates(error) {
  const rawMessage =
    error instanceof Error ? error.message : String(error || "");
  const safeReason = /^(?:请填写|中转站网址|登录网址)/u.test(rawMessage)
    ? rawMessage
    : "暂时无法连接中转站，请检查网址、网络或 API Key 后重试。";
  return {
    detectionStatus: "已保存账号，自动识别未完成：" + safeReason,
    detectedAt: new Date().toISOString(),
    discoveryVerified: false,
  };
}

function isAccountRemovalError(error) {
  return (
    typeof error?.code === "string" && error.code.startsWith("ACCOUNT_REMOVAL_")
  );
}

function recoveryCommandErrorCode(error) {
  const explicit = typeof error?.code === "string" ? error.code.trim() : "";
  const message = error instanceof Error ? error.message : String(error || "");
  const candidate =
    explicit || message.match(/^([A-Z][A-Z0-9_]+)(?::|$)/u)?.[1] || "";
  return /^(?:DATA_BACKUP|RECOVERY|ACCOUNT_REMOVAL)_[A-Z0-9_]+$/u.test(
    candidate,
  )
    ? candidate
    : "RECOVERY_COMMAND_FAILED";
}

function recoveryCommandErrorStatus(code) {
  if (['RECOVERY_REMOTE_AUTH_REQUIRED', 'RECOVERY_REMOTE_LOGIN_REQUIRED'].includes(code)) return 401;
  if (code === 'RECOVERY_REMOTE_ACCESS_DENIED') return 403;
  if (code === 'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE') return 404;
  if (code === 'RECOVERY_REMOTE_UNAVAILABLE') return 503;
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (
    code.includes("STALE") ||
    code.includes("MISMATCH") ||
    code.includes("CONFLICT") ||
    code.includes("NOT_VERIFIED") ||
    code.includes("QUIESCED")
  )
    return 409;
  return 400;
}

function historicalProductImportErrorPayload(error) {
  const explicit = typeof error?.code === "string" ? error.code.trim() : "";
  const message = error instanceof Error ? error.message : String(error || "");
  const code =
    explicit.startsWith("HISTORICAL_IMPORT_") ||
    explicit.startsWith("HISTORICAL_ORDER_IMPORT_") ||
    explicit.startsWith("ACCOUNT_REMOVAL_")
      ? explicit
      : message.match(/^(HISTORICAL_(?:ORDER_)?IMPORT_[A-Z0-9_]+)/u)?.[1] ||
        "HISTORICAL_IMPORT_REQUEST_FAILED";
  return {
    ok: false,
    error: {
      code,
      message,
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
  };
}

function historicalProductImportErrorStatus(error) {
  const code = historicalProductImportErrorPayload(error).error.code;
  if (code.startsWith("ACCOUNT_REMOVAL_")) return 409;
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (
    code.includes("STALE") ||
    code.includes("MISMATCH") ||
    code.includes("CONFLICT") ||
    code.includes("AMBIGUOUS") ||
    code.includes("RACE")
  )
    return 409;
  return 400;
}

function createPurchaseBrowserErrorPayload(error) {
  const code =
    typeof error?.code === "string" &&
    (error.code.startsWith("PURCHASE_BROWSER_") ||
      error.code.startsWith("SHOP_LICENSE_"))
      ? error.code
      : "PURCHASE_BROWSER_REQUEST_INVALID";
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function purchaseBrowserErrorStatus(error) {
  const code = String(error?.code || "");
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (code.startsWith("SHOP_LICENSE_")) return 403;
  if (
    code.includes("FENCED") ||
    code.includes("CONFLICT") ||
    code.includes("MISMATCH") ||
    code.includes("AMBIGUOUS") ||
    // A missing readback proof is an invalid/incomplete request (400).  Only
    // an already-attempted readback that failed to match durable state is a
    // state conflict (409).
    code.includes("READBACK_FAILED") ||
    code.includes("READBACK_MISMATCH") ||
    code.includes("NOT_CONFIRMED")
  )
    return 409;
  if (code.includes("CAPABILITY") || code.includes("INTERNAL")) return 403;
  return 400;
}

function crossBorderChargeErrorCode(error) {
  const explicit = typeof error?.code === "string" ? error.code.trim() : "";
  const message = error instanceof Error ? error.message : String(error || "");
  return explicit.startsWith("CROSS_BORDER_")
    ? explicit
    : message.match(/^(CROSS_BORDER_[A-Z0-9_]+)/u)?.[1] ||
        "CROSS_BORDER_CHARGE_REQUEST_FAILED";
}

function crossBorderChargeErrorStatus(error) {
  const code = crossBorderChargeErrorCode(error);
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (
    code.includes("EXPIRED") ||
    code.includes("MISMATCH") ||
    code.includes("AMBIGUOUS")
  )
    return 409;
  return 400;
}

function crossBorderChargeErrorPayload(error) {
  return {
    ok: false,
    error: {
      code: crossBorderChargeErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function getControlledMarketingCacheErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const match = message.match(/^([A-Z][A-Z0-9_]+)(?::|$)/u);
  return match?.[1] || "MARKETING_CACHE_REQUEST_INVALID";
}

function createControlledMarketingCacheErrorPayload(error) {
  return {
    ok: false,
    error: {
      code: getControlledMarketingCacheErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function createQueryObject(requestUrl) {
  return Object.fromEntries(requestUrl.searchParams.entries());
}

function matchShopTestRoute(pathname) {
  const match = pathname.match(/^\/api\/shops\/([^/]+)\/test$/u);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchSingleParamRoute(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

function getPayloadValues(payload = {}) {
  return {
    ...(payload.values ?? {}),
    ...(payload.credentials ?? {}),
    ...payload,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMarketingLegacyImportEntries(body = {}) {
  if (!isPlainObject(body))
    throw new Error("MARKETING_LEGACY_IMPORT_BODY_INVALID");
  if (Array.isArray(body.entries)) return body.entries;
  if (Object.hasOwn(body, "shopId") && Object.hasOwn(body, "snapshot")) {
    return [{ shopId: body.shopId, snapshot: body.snapshot }];
  }
  if (!isPlainObject(body.snapshots) || !isPlainObject(body.scopeMapping)) {
    throw new Error("MARKETING_LEGACY_IMPORT_SCOPE_MAPPING_REQUIRED");
  }
  return Object.entries(body.snapshots).map(([legacyScope, snapshot]) => {
    const mapping = body.scopeMapping[legacyScope];
    const shopId =
      typeof mapping === "string"
        ? mapping
        : isPlainObject(mapping)
          ? mapping.shopId
          : "";
    if (!shopId)
      throw new Error(`MARKETING_LEGACY_IMPORT_SCOPE_UNMAPPED:${legacyScope}`);
    return { legacyScope, shopId, snapshot };
  });
}

function getPerformanceAccountId(payload = {}) {
  const values = getPayloadValues(payload);
  return normalizeText(
    values.accountId ||
      values.performanceAccountId ||
      values.performance_account_id ||
      values.id,
  );
}

function createPerformanceCredentialResolver(performanceAccountRepository) {
  return (payload = {}) => {
    const accountId = getPerformanceAccountId(payload);
    if (!accountId) return null;
    const credentials =
      performanceAccountRepository.getCredentialsForInternalUse(accountId);
    if (!credentials) return null;
    if (!credentials.shopId) {
      const error = new Error(
        "请先把当前 Performance API 账号绑定到对应的 Ozon 店铺。",
      );
      error.code = "PERFORMANCE_ACCOUNT_SHOP_BINDING_REQUIRED";
      error.statusCode = 409;
      throw error;
    }
    const values = getPayloadValues(payload);
    const requestedShopId = normalizeText(values.shopId || values.shop_id);
    if (requestedShopId && requestedShopId !== credentials.shopId) {
      const error = new Error(
        "Performance API 账号与当前选择的 Ozon 店铺不匹配。",
      );
      error.code = "PERFORMANCE_ACCOUNT_SHOP_MISMATCH";
      error.statusCode = 409;
      throw error;
    }
    return credentials;
  };
}

function createPerformanceAccountSavedPayload(result) {
  return {
    ok: true,
    created: Boolean(result?.created),
    account: result?.account || null,
    message: "Performance API 凭证已加密保存到 local-api。",
  };
}

function createPerformanceAccountsPayload(accounts = []) {
  return {
    ok: true,
    accounts,
    // Keep the existing UI alias until ordinary settings consumers finish their
    // migration. High-cardinality retirement uses cursorMode=legacy-migration
    // and receives rows only, never this duplicated compatibility DTO.
    rows: accounts,
    total: accounts.length,
    hasMore: false,
    nextCursor: "",
    storage: {
      encrypted: true,
      publicResponse:
        "返回 client_id 与 client_secret 固定遮罩；不返回明文 client_secret。",
    },
  };
}

function mapSyncJobStatusRow(row = {}) {
  return {
    id: row.id,
    jobId: row.id,
    domain: row.domain,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key || null,
    action: row.action || null,
    priority: row.priority || null,
    profile: row.profile || null,
    source: row.source || null,
    status: row.status,
    stage: row.stage || null,
    message: row.message || null,
    cacheKey: row.cache_key || null,
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    progress: {
      done: row.progress_done,
      total: row.progress_total,
      itemsDone: row.items_done || 0,
      itemsTotal: row.items_total || 0,
    },
    changedCount: row.changed_count,
    unchangedCount: row.unchanged_count,
    failedCount: row.failed_count,
    staleCount: row.stale_count,
    retry: {
      count: row.retry_count || 0,
      nextRetryAt: row.next_retry_at || null,
      lastRetryAfterMs: row.last_retry_after_ms || null,
    },
    snapshotId: row.snapshot_id || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };
}

function listLightSyncJobs(db, ids = []) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
        SELECT id, domain, shop_id, endpoint_key, action, priority, profile,
               source, status, stage, message, cache_key, progress_done,
               progress_total, items_done, items_total, changed_count,
               unchanged_count, failed_count, stale_count, retry_count,
               next_retry_at, last_retry_after_ms, snapshot_id, last_error,
               created_at, started_at, updated_at, finished_at
        FROM ozon_request_jobs
        WHERE id IN (${placeholders})
      `,
    )
    .all(...ids);
  const byId = new Map(rows.map((row) => [row.id, mapSyncJobStatusRow(row)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function normalizeOzonRequestMethod(value) {
  return normalizeText(value || "POST").toUpperCase() || "POST";
}

function getLegacyOzonShopInput(body = {}) {
  const shop = body.shop && typeof body.shop === "object" ? body.shop : {};
  return {
    id: normalizeText(shop.id || shop.shopId || body.shopId || body.shop_id),
    name: normalizeText(
      shop.name ||
        shop.shopAlias ||
        shop.alias ||
        body.shopName ||
        body.shop_name ||
        "Ozon 店铺",
    ),
    alias: normalizeText(
      shop.shopAlias || shop.alias || body.shopAlias || body.alias,
    ),
    clientId: normalizeText(
      shop.clientId || shop.client_id || body.clientId || body.client_id,
    ),
    apiKey: normalizeText(
      shop.apiKey || shop.api_key || body.apiKey || body.api_key,
    ),
    status: "active",
  };
}

function getLegacyOzonPayload(body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, "body"))
    return body.body ?? {};
  if (Object.prototype.hasOwnProperty.call(body, "payload"))
    return body.payload ?? {};
  if (Object.prototype.hasOwnProperty.call(body, "params"))
    return body.params ?? {};
  return {};
}

function createRealWritePolicy(config = {}) {
  const ozon = config?.ozon || {};
  return {
    enabled: ozon.enableRealWrite === true,
  };
}

function getLegacyOzonPublicError(error) {
  return {
    code: error?.code || "OZON_REQUEST_FAILED",
    message: error instanceof Error ? error.message : String(error),
    endpoint: error?.endpoint || undefined,
    status: error?.status || error?.statusCode || undefined,
    response: error?.response || undefined,
  };
}

export {
  createBadJsonPayload,
  createModelApiDiscoveryFailureUpdates,
  isAccountRemovalError,
  recoveryCommandErrorCode,
  recoveryCommandErrorStatus,
  historicalProductImportErrorPayload,
  historicalProductImportErrorStatus,
  createPurchaseBrowserErrorPayload,
  purchaseBrowserErrorStatus,
  crossBorderChargeErrorCode,
  crossBorderChargeErrorStatus,
  crossBorderChargeErrorPayload,
  getControlledMarketingCacheErrorCode,
  createControlledMarketingCacheErrorPayload,
  createQueryObject,
  matchShopTestRoute,
  matchSingleParamRoute,
  getPayloadValues,
  isPlainObject,
  normalizeMarketingLegacyImportEntries,
  getPerformanceAccountId,
  createPerformanceCredentialResolver,
  createPerformanceAccountSavedPayload,
  createPerformanceAccountsPayload,
  mapSyncJobStatusRow,
  listLightSyncJobs,
  normalizeText,
  normalizeOzonRequestMethod,
  getLegacyOzonShopInput,
  getLegacyOzonPayload,
  createRealWritePolicy,
  getLegacyOzonPublicError,
};

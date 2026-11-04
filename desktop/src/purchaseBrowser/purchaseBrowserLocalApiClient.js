const LOCAL_API_TOKEN_HEADER = 'x-wangzai-local-api-token';
const PURCHASE_BROWSER_TOKEN_HEADER = 'x-wangzai-purchase-browser-token';
const DEFAULT_LOGIN_STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_LOGIN_STATUS_TRANSPORT_RETRIES = 2;
const DEFAULT_TRANSPORT_RETRY_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

function requiredText(value, code, maximum = 500) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum || /[\u0000-\u001F\u007F]/u.test(text)) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return text;
}

function boundedNonNegativeInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(maximum, Math.trunc(parsed)));
}

function transportCauseCode(error) {
  const value = String(
    error?.causeCode
    || error?.code
    || error?.cause?.code
    || error?.name
    || 'UNKNOWN',
  ).trim().toUpperCase();
  return /^[A-Z0-9_]{1,80}$/u.test(value) ? value : 'UNKNOWN';
}

function waitForRetry(delayMs) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function localApiTransportError(error, attempts) {
  const wrapped = new Error('PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED');
  wrapped.code = 'PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED';
  wrapped.causeCode = transportCauseCode(error);
  wrapped.attempts = attempts;
  wrapped.cause = error;
  return wrapped;
}

export function createPurchaseBrowserLocalApiClient({
  baseUrl,
  authToken,
  purchaseBrowserToken,
  tenantId = '',
  userId = '',
  shopId = '',
  fetchImpl = fetch,
  transportRetryDelayMs = DEFAULT_TRANSPORT_RETRY_DELAY_MS,
} = {}) {
  const root = new URL(requiredText(baseUrl, 'PURCHASE_BROWSER_LOCAL_API_URL_REQUIRED', 1000));
  if (!['http:', 'https:'].includes(root.protocol)) throw new Error('PURCHASE_BROWSER_LOCAL_API_URL_INVALID');
  const localApiToken = requiredText(authToken, 'PURCHASE_BROWSER_LOCAL_API_TOKEN_REQUIRED', 500);
  const capability = requiredText(
    purchaseBrowserToken,
    'PURCHASE_BROWSER_INTERNAL_CAPABILITY_REQUIRED',
    500,
  );
  if (typeof fetchImpl !== 'function') throw new Error('PURCHASE_BROWSER_FETCH_REQUIRED');
  const retryDelayMs = boundedNonNegativeInteger(
    transportRetryDelayMs,
    DEFAULT_TRANSPORT_RETRY_DELAY_MS,
    2_000,
  );

  async function request(pathname, {
    method = 'POST',
    body,
    context = {},
    timeoutMs = 0,
    transportRetries = 0,
    signal = null,
  } = {}) {
    const resolvedTenantId = String(context.tenantId || tenantId || '').trim();
    const resolvedUserId = String(context.userId || userId || '').trim();
    const resolvedShopId = String(context.shopId || shopId || '').trim();
    const boundedTimeoutMs = boundedNonNegativeInteger(
      timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      30_000,
    );
    const boundedTransportRetries = boundedNonNegativeInteger(transportRetries, 0, 3);
    const url = new URL(pathname, root);
    const requestOptions = {
      method,
      headers: {
        'content-type': 'application/json',
        [LOCAL_API_TOKEN_HEADER]: localApiToken,
        [PURCHASE_BROWSER_TOKEN_HEADER]: capability,
        ...(resolvedTenantId ? { 'x-wangzai-tenant-id': resolvedTenantId } : {}),
        ...(resolvedUserId ? { 'x-wangzai-user-id': resolvedUserId } : {}),
        ...(resolvedShopId ? { 'x-wangzai-shop-id': resolvedShopId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    let response;
    let lastTransportError = null;
    for (let attempt = 0; attempt <= boundedTransportRetries; attempt += 1) {
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort('PURCHASE_BROWSER_COMMAND_CANCELLED');
      signal?.addEventListener?.('abort', onCallerAbort, { once: true });
      const timeout = controller
        ? globalThis.setTimeout(() => controller.abort('LOCAL_API_TIMEOUT'), boundedTimeoutMs)
        : null;
      try {
        response = await fetchImpl(url, {
          ...requestOptions,
          ...(controller ? { signal: controller.signal } : {}),
        });
        lastTransportError = null;
        break;
      } catch (error) {
        const callerCancelled = signal?.aborted === true;
        lastTransportError = controller?.signal.aborted
          ? Object.assign(
              new Error(callerCancelled ? 'PURCHASE_BROWSER_COMMAND_CANCELLED' : 'LOCAL_API_TIMEOUT'),
              { code: callerCancelled ? 'PURCHASE_BROWSER_COMMAND_CANCELLED' : 'LOCAL_API_TIMEOUT', cause: error },
            )
          : error;
        if (callerCancelled) break;
        if (attempt >= boundedTransportRetries) break;
        await waitForRetry(retryDelayMs * (attempt + 1));
      } finally {
        if (timeout) globalThis.clearTimeout(timeout);
        signal?.removeEventListener?.('abort', onCallerAbort);
      }
    }
    if (lastTransportError || !response) {
      throw localApiTransportError(lastTransportError, boundedTransportRetries + 1);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      const code = payload?.error?.code || 'PURCHASE_BROWSER_LOCAL_API_REQUEST_FAILED';
      const error = new Error(code);
      error.code = code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  return Object.freeze({
    listAccounts() {
      return request('/api/purchase/accounts', { method: 'GET' });
    },
    listPurchaseSourceLinks(query = {}) {
      const params = new URLSearchParams(Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [key, String(value)]));
      return request(`/api/purchase/source-links?${params.toString()}`, { method: 'GET' });
    },
    listProductSourceLinks(query = {}) {
      const params = new URLSearchParams(Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [key, String(value)]));
      return request(`/api/products/source-links?${params.toString()}`, { method: 'GET' });
    },
    listPurchaseOrderOverrides(query = {}) {
      const params = new URLSearchParams(Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [key, String(value)]));
      return request(`/api/purchase/orders/overrides?${params.toString()}`, { method: 'GET' });
    },
    savePurchaseOrderOverride(body) {
      return request('/api/purchase/orders/overrides', { body });
    },
    saveCrossBorderOrderRecord(body) {
      return request('/api/logistics/cross-border/orders', { body });
    },
    listIntegrationProfiles() {
      return request('/api/integrations/profiles', { method: 'GET' });
    },
    getOwnerBinding(accountId, ownerType = 'purchase_account') {
      return request('/api/internal/purchase-browser/account-binding', {
        body: {
          accountId: requiredText(accountId, 'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED', 128),
          ownerType: requiredText(ownerType, 'PURCHASE_BROWSER_OWNER_TYPE_REQUIRED', 40),
        },
      });
    },
    getTask(taskId) {
      const id = encodeURIComponent(requiredText(taskId, 'PURCHASE_BROWSER_TASK_ID_REQUIRED', 160));
      return request(`/api/purchase/browser/tasks/${id}`, { method: 'GET' });
    },
    claimTask(taskId, executionCapability) {
      const id = encodeURIComponent(requiredText(taskId, 'PURCHASE_BROWSER_TASK_ID_REQUIRED', 160));
      return request(`/api/internal/purchase-browser/tasks/${id}/claim`, {
        body: { executionCapability: requiredText(executionCapability, 'PURCHASE_BROWSER_EXECUTION_CAPABILITY_REQUIRED', 500) },
      });
    },
    completeTask(taskId, body) {
      const id = encodeURIComponent(requiredText(taskId, 'PURCHASE_BROWSER_TASK_ID_REQUIRED', 160));
      return request(`/api/internal/purchase-browser/tasks/${id}/receipt`, { body });
    },
    failTask(taskId, body) {
      const id = encodeURIComponent(requiredText(taskId, 'PURCHASE_BROWSER_TASK_ID_REQUIRED', 160));
      return request(`/api/internal/purchase-browser/tasks/${id}/fail`, { body });
    },
    recordPluginState(body) {
      return request('/api/internal/purchase-browser/plugin-state', { body });
    },
    savePurchaseAccountLoginStatus(accountId, body) {
      const id = encodeURIComponent(requiredText(
        accountId,
        'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED',
        128,
      ));
      return request(`/api/internal/purchase-browser/accounts/${id}/login-status`, { body });
    },
    saveIntegrationProfileLoginStatus(profileId, body) {
      const id = encodeURIComponent(requiredText(
        profileId,
        'PURCHASE_BROWSER_INTEGRATION_PROFILE_ID_REQUIRED',
        128,
      ));
      return request(`/api/internal/purchase-browser/integration-profiles/${id}/login-status`, {
        body,
        timeoutMs: DEFAULT_LOGIN_STATUS_TIMEOUT_MS,
        transportRetries: DEFAULT_LOGIN_STATUS_TRANSPORT_RETRIES,
      });
    },
    previewPurchaseCapture(body, options = {}) {
      return request('/api/purchase/browser-capture/preview', { body, signal: options.signal });
    },
    confirmPurchaseCapture(body, options = {}) {
      return request('/api/purchase/browser-capture/confirm', { body, signal: options.signal });
    },
    previewPurchaseRefund(body, options = {}) {
      return request('/api/purchase/browser-capture/refund/preview', { body, signal: options.signal });
    },
    confirmPurchaseRefund(body, options = {}) {
      return request('/api/purchase/browser-capture/refund/confirm', { body, signal: options.signal });
    },
    readbackPurchaseCapture(target, options = {}) {
      const query = new URLSearchParams(Object.entries(target || {})
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [key, String(value)]));
      return request(`/api/purchase/browser-capture/readback?${query.toString()}`, {
        method: 'GET',
        signal: options.signal,
      });
    },
    previewCrossBorderCharges(body, context) {
      return request('/api/logistics/cross-border/charges/preview', { body, context });
    },
    confirmCrossBorderCharges(body, context) {
      return request('/api/logistics/cross-border/charges/confirm', { body, context });
    },
    listCrossBorderCharges(query = {}, context) {
      const params = new URLSearchParams(Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [key, String(value)]));
      return request(`/api/logistics/cross-border/charges?${params.toString()}`, { method: 'GET', context });
    },
    prepareAccountRemoval(operationId) {
      return request('/api/internal/purchase-browser/account-removal/prepare', {
        body: { operationId: requiredText(operationId, 'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED', 160) },
      });
    },
    recordAccountRemovalReceipt(operationId, proof) {
      return request('/api/internal/purchase-browser/account-removal/receipt', {
        body: {
          operationId: requiredText(operationId, 'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED', 160),
          proof,
        },
      });
    },
    getAccountRemovalOperation(operationId) {
      const id = encodeURIComponent(requiredText(operationId, 'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED', 160));
      return request(`/api/account-removal/operations/${id}`, { method: 'GET' });
    },
    async finalizeAccountRemoval(operationId) {
      const id = encodeURIComponent(requiredText(
        operationId,
        'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED',
        160,
      ));
      const operation = await request(`/api/account-removal/operations/${id}`, { method: 'GET' });
      if (operation.completed === true) return operation;
      if (
        operation.requiresClientCleanup !== true
        || !operation.clientCleanup?.nonce
        || !Array.isArray(operation.clientCleanup.resourceIds)
      ) {
        throw new Error('PURCHASE_BROWSER_ACCOUNT_REMOVAL_FINALIZE_INVALID');
      }
      return request('/api/account-removal/client-verify', {
        body: {
          operationId: operation.operationId,
          nonce: operation.clientCleanup.nonce,
          previewFingerprint: operation.previewFingerprint,
          resourceObservations: operation.clientCleanup.resourceIds.map((resourceId) => ({
            resourceId,
            state: 'absent',
          })),
        },
      });
    },
  });
}

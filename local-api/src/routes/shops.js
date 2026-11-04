export function createShopsListPayload(shops) {
  return {
    ok: true,
    count: shops.length,
    shops,
  };
}

export function createShopSavedPayload(result) {
  return {
    ok: true,
    created: result.created,
    shop: result.shop,
    bindingReady: result.bindingReady === true,
    bindingStatus: result.bindingStatus || 'not_started',
    bootstrapRun: result.bootstrapRun || null,
    bootstrap: {
      required: result.syncBootstrapRequired === true,
      ready: result.bindingReady === true,
      status: result.bindingStatus || 'not_started',
      run: result.bootstrapRun || null,
    },
  };
}

export function createShopDeletedPayload(result) {
  return {
    ok: true,
    deleted: Boolean(result.deleted),
    shopId: result.shopId,
    shop: result.shop || null,
    deletedRows: result.deletedRows || {},
    totalDeletedRows: result.totalDeletedRows || 0,
  };
}

export function createShopValidationErrorPayload(message) {
  return {
    ok: false,
    error: {
      code: 'SHOP_VALIDATION_ERROR',
      message,
    },
  };
}

export function createShopNotFoundPayload(shopId) {
  return {
    ok: false,
    error: {
      code: 'SHOP_NOT_FOUND',
      message: '未找到指定店铺。',
    },
    shop: {
      id: shopId,
    },
  };
}

export function createShopConnectionTestNotConnectedPayload(shop) {
  return {
    ok: false,
    error: {
      code: 'SHOP_CONNECTION_TEST_NOT_CONNECTED',
      message: '店铺连接测试尚未接入真实 Ozon。当前阶段不会请求 Ozon。',
      next: '后续必须通过 local-api/src/ozon/ozonClient.js 统一测试连接，并经过 endpoint registry、限流重试和脱敏日志。',
    },
    shop: {
      id: shop.id,
      name: shop.name,
      alias: shop.alias,
      status: shop.status,
      hasClientId: shop.hasClientId,
      hasApiKey: shop.hasApiKey,
    },
    connected: false,
  };
}

function toPublicShopPayload(shop = {}) {
  return {
    id: shop.id,
    name: shop.name,
    alias: shop.alias,
    status: shop.status,
    hasClientId: shop.hasClientId,
    hasApiKey: shop.hasApiKey,
  };
}

function extractConnectionOzonCode(error = {}) {
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

function connectionEndpointKey(step) {
  if (step === 'roles') return 'shop.roles';
  if (step === 'seller/info') return 'shop.sellerInfo';
  return null;
}

function isConnectionAuthenticationFailure(error = {}, message = '') {
  const status = Number(error?.status || error?.statusCode || error?.status_code || 0) || null;
  const code = String(error?.code || '').toUpperCase();
  return (
    status === 401 ||
    status === 403 ||
    extractConnectionOzonCode(error) === '5' ||
    code === 'OZON_AUTH_PAUSED' ||
    code.includes('AUTHENTICATION') ||
    code.includes('UNAUTHORIZED') ||
    /invalid\s+api[- ]?key|api[- ]?key\s+(?:is\s+)?invalid/iu.test(message)
  );
}

export function createShopCredentialsRequiredPayload(shop) {
  return {
    ok: false,
    connected: false,
    error: {
      code: 'SHOP_CREDENTIALS_REQUIRED',
      message: '请先保存本地配置，local-api 会加密保存 Client ID 和 API Key 后再测试连接。',
    },
    shop: toPublicShopPayload(shop),
  };
}

export function createShopConnectionTestSuccessPayload({ shop, roles, sellerInfo, jobs = [] } = {}) {
  return {
    ok: true,
    connected: true,
    message: '已通过 local-api 统一调度器完成 Ozon 只读连接测试。',
    shop: toPublicShopPayload(shop),
    checks: {
      roles: {
        ok: true,
        endpointKey: 'shop.roles',
        data: roles,
        jobId: jobs[0]?.jobId || null,
      },
      sellerInfo: {
        ok: true,
        endpointKey: 'shop.sellerInfo',
        data: sellerInfo,
        jobId: jobs[1]?.jobId || null,
      },
    },
    roles,
    sellerInfo,
  };
}

export function createShopConnectionTestFailedPayload({ shop, step, result, error } = {}) {
  const publicError = result?.errors?.[0] || result?.error || error || {};
  const upstreamMessage =
    publicError?.message ||
    result?.job?.lastError ||
    (error instanceof Error ? error.message : String(error || 'Ozon 店铺连接测试失败。'));
  const authFailure = isConnectionAuthenticationFailure(publicError, upstreamMessage);
  const message = authFailure
    ? 'API Key 无效、已撤销或与当前 Client ID 不匹配，请在 Ozon 后台重新生成后保存再测试。'
    : upstreamMessage;
  const ozonCode = extractConnectionOzonCode(publicError);
  const ozonStatus = publicError?.status || publicError?.statusCode || publicError?.status_code || null;

  return {
    ok: false,
    connected: false,
    error: {
      code: authFailure
        ? 'OZON_AUTHENTICATION_FAILED'
        : publicError?.code || result?.job?.lastError?.split(':')?.[0] || 'SHOP_CONNECTION_TEST_FAILED',
      message: `${step || 'Ozon'} 测试失败：${message}`,
      endpointKey: connectionEndpointKey(step),
      status: ozonStatus,
      ozonCode,
      retryAfterMs: publicError?.retryAfterMs ?? null,
    },
    shop: toPublicShopPayload(shop),
    jobId: result?.jobId || null,
    status: result?.status || result?.job?.status || 'failed',
  };
}

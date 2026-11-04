const DEFAULT_LOCAL_TENANT_ID = 'tenant_local_default';
const DEFAULT_LOCAL_USER_ID = 'user_local_default';
const CONTEXT_HEADER_NAMES = {
  tenantId: ['x-wangzai-tenant-id', 'x-tenant-id'],
  userId: ['x-wangzai-user-id', 'x-user-id'],
  shopId: ['x-wangzai-shop-id', 'x-shop-id'],
};
const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

function normalizePlainText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

function readFirstValue(...candidates) {
  for (const candidate of candidates) {
    const value = normalizePlainText(candidate);
    if (value) return value;
  }
  return '';
}

export function normalizeContextId(value, { fieldName = '上下文 ID', fallback = '' } = {}) {
  const normalized = normalizePlainText(value) || normalizePlainText(fallback);
  if (!normalized) return '';
  if (!CONTEXT_ID_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} 只能包含字母、数字、点、下划线、冒号和短横线，且长度不能超过 128。`);
  }
  return normalized;
}

export function readRequestContextHints(input = {}) {
  const req = input.req || {};
  const headers = normalizeHeaders(input.headers || req.headers || {});
  const query = input.query || {};
  const body = input.body || {};
  const values = body.values || {};

  return {
    tenantId: readFirstValue(
      input.tenantId,
      headers[CONTEXT_HEADER_NAMES.tenantId[0]],
      headers[CONTEXT_HEADER_NAMES.tenantId[1]],
      query.tenantId,
      body.tenantId,
      values.tenantId,
    ),
    userId: readFirstValue(
      input.userId,
      headers[CONTEXT_HEADER_NAMES.userId[0]],
      headers[CONTEXT_HEADER_NAMES.userId[1]],
      query.userId,
      body.userId,
      values.userId,
    ),
    shopId: readFirstValue(
      input.shopId,
      headers[CONTEXT_HEADER_NAMES.shopId[0]],
      headers[CONTEXT_HEADER_NAMES.shopId[1]],
      query.shopId,
      body.shopId,
      values.shopId,
    ),
  };
}

export function createRequestContext(input = {}) {
  const hints = readRequestContextHints(input);
  const tenantId = normalizeContextId(hints.tenantId, {
    fieldName: '租户 ID',
    fallback: input.defaultTenantId || DEFAULT_LOCAL_TENANT_ID,
  });
  const userId = normalizeContextId(hints.userId, {
    fieldName: '用户 ID',
    fallback: input.defaultUserId || DEFAULT_LOCAL_USER_ID,
  });
  const shopId = normalizeContextId(hints.shopId, {
    fieldName: '店铺 ID',
    fallback: input.defaultShopId || '',
  });

  return {
    tenantId,
    userId,
    shopId,
    isLocalDefaultTenant: tenantId === DEFAULT_LOCAL_TENANT_ID,
    isLocalDefaultUser: userId === DEFAULT_LOCAL_USER_ID,
    source: {
      tenantId: hints.tenantId ? 'request' : 'local-default',
      userId: hints.userId ? 'request' : 'local-default',
      shopId: hints.shopId ? 'request' : shopId ? 'local-default' : 'none',
    },
  };
}

export function createTenantScopedKey(parts = [], context = createRequestContext()) {
  const normalizedParts = Array.isArray(parts) ? parts : [parts];
  const safeParts = normalizedParts.map((part, index) =>
    normalizeContextId(part, { fieldName: `范围键片段 ${index + 1}` }),
  );
  return [context.tenantId, context.userId, ...safeParts].filter(Boolean).join(':');
}

export function assertShopAccess(context, requestedShopId, allowedShopIds = null) {
  const normalizedShopId = normalizeContextId(requestedShopId || context?.shopId, {
    fieldName: '店铺 ID',
  });
  if (!normalizedShopId) {
    throw new Error('缺少店铺 ID，不能执行需要店铺隔离的操作。');
  }

  if (!Array.isArray(allowedShopIds)) {
    return normalizedShopId;
  }

  const allowed = new Set(
    allowedShopIds
      .map((shopId) => normalizeContextId(shopId, { fieldName: '允许店铺 ID' }))
      .filter(Boolean),
  );
  if (!allowed.has(normalizedShopId)) {
    throw new Error('当前用户无权访问该店铺。');
  }
  return normalizedShopId;
}

export function createPublicRequestContext(context = createRequestContext()) {
  return {
    tenantId: context.tenantId,
    userId: context.userId,
    shopId: context.shopId || null,
    isLocalDefaultTenant: Boolean(context.isLocalDefaultTenant),
    isLocalDefaultUser: Boolean(context.isLocalDefaultUser),
  };
}

export const requestContextDefaults = Object.freeze({
  tenantId: DEFAULT_LOCAL_TENANT_ID,
  userId: DEFAULT_LOCAL_USER_ID,
  headers: CONTEXT_HEADER_NAMES,
});

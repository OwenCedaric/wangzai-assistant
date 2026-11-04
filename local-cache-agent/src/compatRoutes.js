import crypto from 'node:crypto';

const PROFILE_SETTING_NAMESPACES = new Set([
  'fee-settings',
  'watermark-settings',
  'prompt-library',
  'ozon-shop-preferences',
  'cross-border-preferences',
  'purchase-plugin-context',
  'logistics-pricing-settings',
]);
const SECRET_SETTING_KEY = /(?:apikey|accesstoken|refreshtoken|clientsecret|companysecret|loginpassword|password|token|secret|authorization|credential)/u;
const LEGACY_SHOP_FIELDS = new Set(['id', 'name', 'alias', 'status', 'clientId', 'apiKey']);
const SHOP_STATUSES = new Set(['inactive', 'active', 'disabled', 'error']);

function text(value) {
  return String(value ?? '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function fail(code, message = code, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function assertSafeProfileSetting(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PROFILE_SETTING_VALUE_INVALID', `Profile setting contains a non-finite number at ${path}.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeProfileSetting(item, `${path}[${index}]`));
    return;
  }
  assertPlainObject(value, 'PROFILE_SETTING_VALUE_INVALID');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('PROFILE_SETTING_KEY_FORBIDDEN');
    if (SECRET_SETTING_KEY.test(key.replaceAll(/[_-]/gu, '').toLowerCase())) fail('PROFILE_SETTING_SECRET_FIELD_FORBIDDEN');
    assertSafeProfileSetting(child, `${path}.${key}`);
  }
}

function publicShop(shop = {}) {
  return {
    id: shop.id,
    name: shop.name,
    alias: shop.alias || '',
    status: shop.status || 'inactive',
    clientId: shop.clientId || '',
    hasClientId: Boolean(shop.clientId),
    hasApiKey: Boolean(shop.apiKey),
    apiKeyHint: shop.apiKey ? '••••••••••' : '',
    profileId: shop.profileId || '',
    shopIncarnation: shop.shopIncarnation,
    credentialRevision: Number(shop.credentialRevision || 1),
    boundAt: shop.boundAt || null,
    disabledAt: shop.disabledAt || null,
    createdAt: shop.createdAt,
    updatedAt: shop.updatedAt,
  };
}

function normalizeStringList(value, limit = 64) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => text(item))
    .filter(Boolean))].slice(0, limit);
}

function normalizeModelOptions(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map((item) => {
    const source = typeof item === 'string' ? { id: item } : item;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const id = text(source.id || source.model);
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const normalized = {
      id,
      label: text(source.label || source.displayName || id) || id,
      capabilities: normalizeStringList(source.capabilities, 32),
      modalities: normalizeStringList(source.modalities, 16),
    };
    if (source.options && typeof source.options === 'object' && !Array.isArray(source.options)) {
      normalized.options = structuredClone(source.options);
    }
    return normalized;
  }).filter(Boolean).slice(0, 100);
}

function publicModelApiAccount(account = {}) {
  return {
    id: account.id,
    apiAlias: account.apiAlias,
    provider: account.provider || '',
    websiteUrl: account.websiteUrl || '',
    loginAccount: account.loginAccount || '',
    hasLoginPassword: Boolean(account.loginPassword),
    loginPasswordHint: account.loginPassword ? '••••••••••' : '',
    baseUrl: account.baseUrl || '',
    hasApiKey: Boolean(account.apiKey),
    apiKeyHint: account.apiKey ? '••••••••••' : '',
    defaultModel: account.defaultModel || '',
    usageScene: account.usageScene || '',
    upscale: account.upscale || '',
    quality: account.quality || '',
    style: account.style || '',
    availableModels: Array.isArray(account.availableModels) ? account.availableModels : [],
    capabilities: Array.isArray(account.capabilities) ? account.capabilities : [],
    discoveryVerified: account.discoveryVerified === true,
    detectionStatus: account.detectionStatus || '',
    detectedSource: account.detectedSource || '',
    detectedAt: account.detectedAt || '',
    isDefault: account.isDefault === true,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function normalizeModelApiAccount(input, existing = null) {
  assertPlainObject(input, 'MODEL_API_ACCOUNT_PAYLOAD_INVALID');
  const timestamp = nowIso();
  const apiAlias = text(input.apiAlias ?? input.api_alias ?? existing?.apiAlias ?? '模型中转站');
  if (!apiAlias) fail('MODEL_API_ACCOUNT_ALIAS_REQUIRED');
  const loginPasswordProvided = Object.hasOwn(input, 'loginPassword') || Object.hasOwn(input, 'login_password');
  const apiKeyProvided = Object.hasOwn(input, 'apiKey') || Object.hasOwn(input, 'api_key');
  const availableModelsProvided = Object.hasOwn(input, 'availableModels') || Object.hasOwn(input, 'available_models');
  const capabilitiesProvided = Object.hasOwn(input, 'capabilities');
  const websiteUrl = text(input.websiteUrl ?? input.website_url ?? existing?.websiteUrl);
  const discoveryVerified = Boolean(
    input.discoveryVerified ?? input.discovery_verified ?? existing?.discoveryVerified ?? false,
  );
  return {
    id: text(input.id || input.accountId || existing?.id) || `model_api_${crypto.randomUUID()}`,
    apiAlias,
    provider: text(input.provider ?? existing?.provider),
    websiteUrl,
    loginAccount: text(input.loginAccount ?? input.login_account ?? existing?.loginAccount),
    loginPassword: loginPasswordProvided
      ? text(input.loginPassword ?? input.login_password)
      : text(existing?.loginPassword),
    baseUrl: text(input.baseUrl ?? input.base_url ?? existing?.baseUrl),
    apiKey: apiKeyProvided ? text(input.apiKey ?? input.api_key) : text(existing?.apiKey),
    defaultModel: text(input.defaultModel ?? input.default_model ?? existing?.defaultModel),
    usageScene: text(input.usageScene ?? input.usage_scene ?? existing?.usageScene),
    upscale: text(input.upscale ?? existing?.upscale),
    quality: text(input.quality ?? existing?.quality),
    style: text(input.style ?? existing?.style),
    availableModels: availableModelsProvided
      ? normalizeModelOptions(input.availableModels ?? input.available_models)
      : structuredClone(existing?.availableModels || []),
    capabilities: capabilitiesProvided
      ? normalizeStringList(input.capabilities)
      : structuredClone(existing?.capabilities || []),
    discoveryVerified,
    detectionStatus: text(
      input.detectionStatus
      ?? input.detection_status
      ?? existing?.detectionStatus
      ?? (websiteUrl ? '已保存账号，等待服务器识别接口' : ''),
    ),
    detectedSource: text(input.detectedSource ?? input.detected_source ?? existing?.detectedSource),
    detectedAt: text(input.detectedAt ?? input.detected_at ?? existing?.detectedAt),
    isDefault: Boolean(input.isDefault ?? input.is_default ?? existing?.isDefault ?? false),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function normalizeShop(input, existing, scopeId) {
  assertPlainObject(input, 'SHOP_PAYLOAD_INVALID');
  const id = text(input.id) || `shop_${crypto.randomUUID()}`;
  const name = text(input.name ?? existing?.name);
  if (!name) fail('SHOP_NAME_REQUIRED', 'Shop name is required.');
  const hasClientId = Object.hasOwn(input, 'clientId') || Object.hasOwn(input, 'client_id');
  const hasApiKey = Object.hasOwn(input, 'apiKey') || Object.hasOwn(input, 'api_key');
  const clientId = hasClientId ? text(input.clientId ?? input.client_id) : text(existing?.clientId);
  const apiKey = hasApiKey ? text(input.apiKey ?? input.api_key) : text(existing?.apiKey);
  const credentialsChanged = Boolean(existing) && (clientId !== text(existing.clientId) || apiKey !== text(existing.apiKey));
  const timestamp = nowIso();
  return {
    id,
    name,
    alias: text(input.alias ?? existing?.alias),
    status: ['inactive', 'active', 'disabled', 'error'].includes(text(input.status)) ? text(input.status) : existing?.status || 'inactive',
    clientId,
    apiKey,
    profileId: scopeId,
    shopIncarnation: existing?.shopIncarnation || crypto.randomUUID(),
    credentialRevision: existing ? Number(existing.credentialRevision || 1) + (credentialsChanged ? 1 : 0) : 1,
    boundAt: existing?.boundAt || timestamp,
    disabledAt: text(input.status) === 'disabled' ? existing?.disabledAt || timestamp : null,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function shopRecord(store, scopeId, shopId) {
  return store.getRecord({ scopeId, namespace: 'shops', key: shopId });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function legacyImportDigest(shops, preferences) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue({
    shops: shops.map((shop) => ({
      id: shop.id,
      name: shop.name,
      alias: shop.alias,
      status: shop.status,
      hasClientId: Boolean(shop.clientId),
      hasApiKey: Boolean(shop.apiKey),
    })),
    preferences,
  }))).digest('hex');
}

function compatibilityRoute(method, pathname) {
  if (collectionRoute(method, pathname)) return true;
  if (genericLocalRoute(method, pathname)) return true;
  if (['GET', 'POST'].includes(method) && pathname === '/api/model-api/accounts') return true;
  if (['GET', 'POST'].includes(method) && pathname === '/api/shops') return true;
  if (method === 'POST' && pathname === '/api/shops/legacy-import') return true;
  if (['GET', 'PUT', 'DELETE'].includes(method) && /^\/api\/profile-settings\/[^/]+$/u.test(pathname)) return true;
  if (method === 'POST' && pathname === '/api/profile-assets') return true;
  if (method === 'GET' && /^\/api\/profile-assets\/[^/]+$/u.test(pathname)) return true;
  if (['GET', 'PUT', 'DELETE'].includes(method) && pathname === '/api/profit/ledger-snapshot') return true;
  return false;
}

export function supportsCompatibilityRoute(method, pathname) {
  return compatibilityRoute(String(method || '').toUpperCase(), String(pathname || ''));
}

function profileAssetDto(asset, { includeData = false, content = null } = {}) {
  if (!asset) return null;
  const metadata = asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
  return {
    id: asset.assetId,
    mimeType: asset.mediaType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    sourceType: text(metadata.sourceType),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    ...(includeData && content ? { dataBase64: Buffer.from(content).toString('base64') } : {}),
  };
}

function saveProfileAsset(store, scopeId, payload) {
  assertPlainObject(payload, 'PROFILE_ASSET_PAYLOAD_INVALID');
  const mimeType = text(payload.mimeType || payload.mediaType).toLowerCase();
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType];
  if (!extension) fail('PROFILE_ASSET_MIME_TYPE_INVALID');
  let dataBase64 = text(payload.dataBase64 || payload.contentBase64);
  dataBase64 = dataBase64.replace(/^data:image\/(?:jpeg|png|webp);base64,/iu, '');
  let content;
  try {
    content = Buffer.from(dataBase64, 'base64');
  } catch {
    fail('PROFILE_ASSET_DATA_INVALID');
  }
  if (!content.length || content.length > 2 * 1024 * 1024) fail('PROFILE_ASSET_DATA_INVALID');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const assetId = `profile-${sha256.slice(0, 48)}`;
  const existing = store.getAsset({ scopeId, assetId });
  if (existing) return { ok: true, created: false, asset: profileAssetDto(existing) };
  const asset = store.putAsset({
    scopeId,
    assetId,
    extension,
    mediaType: mimeType,
    contentBase64: content.toString('base64'),
    metadata: { sourceType: text(payload.sourceType || payload.source_type) },
  });
  return { ok: true, created: true, asset: profileAssetDto(asset) };
}

function readProfitLedgerSnapshot(store, scopeId, searchParams) {
  const keys = text(searchParams.get('keys')).split(',').map(text).filter(Boolean).slice(0, 100);
  const records = keys.length
    ? keys.map((key) => store.getRecord({ scopeId, namespace: 'profit-ledger-snapshots', key })).filter(Boolean)
    : store.listRecords({ scopeId, namespace: 'profit-ledger-snapshots', limit: 1000 });
  const record = records[0]?.payload || null;
  return {
    ok: true,
    source: 'sqlite',
    snapshotKey: record?.snapshotKey || null,
    snapshot: record?.snapshot || null,
    savedAt: record?.savedAt || null,
  };
}

function saveProfitLedgerSnapshot(store, scopeId, payload) {
  assertPlainObject(payload, 'PROFIT_LEDGER_SNAPSHOT_PAYLOAD_INVALID');
  const snapshotKey = text(payload.snapshotKey);
  if (!snapshotKey) fail('PROFIT_LEDGER_SNAPSHOT_KEY_REQUIRED');
  assertPlainObject(payload.snapshot, 'PROFIT_LEDGER_SNAPSHOT_REQUIRED');
  const savedAt = nowIso();
  const record = { snapshotKey, snapshot: structuredClone(payload.snapshot), savedAt };
  store.putRecord({ scopeId, namespace: 'profit-ledger-snapshots', key: snapshotKey, payload: record });
  return { ok: true, source: 'sqlite', ...record };
}

function clearProfitLedgerSnapshots(store, scopeId, payload, searchParams) {
  const bodyKeys = Array.isArray(payload?.snapshotKeys) ? payload.snapshotKeys : [];
  const queryKeys = text(searchParams.get('keys')).split(',');
  const keys = [...new Set([...bodyKeys, ...queryKeys].map(text).filter(Boolean))].slice(0, 1000);
  let removedSnapshots = 0;
  for (const key of keys) {
    if (store.deleteRecord({ scopeId, namespace: 'profit-ledger-snapshots', key }).deleted) {
      removedSnapshots += 1;
    }
  }
  return { ok: true, source: 'sqlite', stats: { changed: removedSnapshots > 0, removedSnapshots } };
}

const COLLECTION_ROUTE_DEFS = Object.freeze([
  { family: 'product', namespace: 'product-source-links', base: '/api/products/source-links', keyNames: ['productKey', 'product_key', 'offerId', 'offer_id', 'id'] },
  { family: 'purchase', namespace: 'purchase-source-links', base: '/api/purchase/source-links', keyNames: ['orderKey', 'order_key', 'postingNumber', 'posting_number', 'orderId', 'order_id'] },
  { family: 'sales', namespace: 'sales-source-links', base: '/api/sales/source-links', keyNames: ['orderKey', 'order_key', 'postingNumber', 'posting_number', 'orderId', 'order_id'] },
  { family: 'override', namespace: 'purchase-order-overrides', base: '/api/purchase/orders/overrides', keyNames: ['orderKey', 'order_key', 'postingNumber', 'posting_number', 'orderId', 'order_id'] },
]);

const GENERIC_LOCAL_ROUTE_PATTERNS = Object.freeze([
  /^\/api\/account-removal\//u,
  /^\/api\/app\//u,
  /^\/api\/cache\//u,
  /^\/api\/customer-service\/(?:push-view-markers|chat-file)(?:\/|$)/u,
  /^\/api\/customer-service\/(?:order-route-context|outbound-file\/stage|realtime\/wait)$/u,
  /^\/api\/exchange-rate\/rub-cny\/cache$/u,
  /^\/api\/image-provenance\/jobs(?:\/|$)/u,
  /^\/api\/integrations\/profiles(?:\/|$)/u,
  /^\/api\/logistics\/cross-border\/(?:accounts|orders)(?:\/|$)/u,
  /^\/api\/orders\/test-split-simulation$/u,
  /^\/api\/performance\/accounts(?:\/|$)/u,
  /^\/api\/product-images\/(?:assets\/previews|assets\/[^/]+\/preview|preview\/[^/]+|tasks\/[^/]+)$/u,
  /^\/api\/products\/(?:image-health|material(?:\/legacy-import)?|summary\/hydrate)$/u,
  /^\/api\/purchase\/accounts(?:\/|$)/u,
  /^\/api\/shops\/[^/]+$/u,
]);

function genericLocalRoute(method, pathname) {
  if (method !== '*' && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  if (collectionRoute(method, pathname)) return false;
  return GENERIC_LOCAL_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function handleGenericLocalRoute() {
  // A generic JSON record is not an order sync, account-removal receipt or
  // hydrated product range. Keep explicit local codecs above; never adopt the
  // old route-cache-* records as authoritative domain facts.
  return { handled: true, status: 501, payload: { ok: false, error: {
    code: 'CACHE_AGENT_ROUTE_NOT_IMPLEMENTED',
    message: '此薄客户端功能尚未接入真实业务处理，未读取或修改业务数据。',
  } } };
}

function stageCustomerOutboundFile(store, scopeId, payload = {}) {
  const shopId = text(payload.shopId ?? payload.shop_id);
  const chatId = text(payload.chatId ?? payload.chat_id);
  const name = text(payload.name).replace(/[\\/\0]/gu, '_').slice(0, 180);
  if (!shopId || !chatId || !name) fail('CUSTOMER_FILE_SCOPE_REQUIRED');
  const contentBase64 = text(payload.base64Content ?? payload.base64_content)
    .replace(/^data:[^;]+;base64,/u, '');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (!contentBase64 || !bytes.length || bytes.length > 5 * 1024 * 1024) {
    fail('CUSTOMER_FILE_SIZE_INVALID', '附件大小必须在 1 字节至 5 MB 之间。', bytes.length > 5 * 1024 * 1024 ? 413 : 400);
  }
  const suffix = name.match(/\.([A-Za-z0-9]{1,12})$/u)?.[1]?.toLowerCase() || 'bin';
  const mimeType = text(payload.mimeType ?? payload.mime_type).toLowerCase() || 'application/octet-stream';
  const token = `customer-file-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const asset = store.putAsset({
    scopeId,
    assetId: token,
    extension: suffix,
    mediaType: mimeType,
    contentBase64,
    metadata: { kind: 'customer-outbound-file', shopId, chatId, name, expiresAt },
  });
  return {
    handled: true,
    status: 200,
    payload: {
      ok: true,
      file: {
        token,
        shopId,
        chatId,
        name,
        mimeType,
        size: asset.sizeBytes,
        sha256: asset.sha256,
        expiresAt,
      },
    },
  };
}

function readCustomerOrderRouteContext(store, scopeId, searchParams) {
  const shopId = text(searchParams.get('shopId') || searchParams.get('shop_id'));
  const postingNumber = text(searchParams.get('postingNumber') || searchParams.get('posting_number'));
  const matches = (row = {}) => (
    (!shopId || text(row.shopId ?? row.shop_id) === shopId)
    && (!postingNumber || [row.postingNumber, row.posting_number, row.orderKey, row.order_key]
      .map(text).includes(postingNumber))
  );
  const purchaseRows = store.listRecords({
    scopeId,
    namespace: 'purchase-order-overrides',
    limit: 1000,
  }).map((record) => record.payload).filter(matches);
  const purchaseLinks = store.listRecords({
    scopeId,
    namespace: 'purchase-source-links',
    limit: 1000,
  }).map((record) => record.payload).filter(matches);
  return {
    handled: true,
    status: 200,
    payload: {
      ok: true,
      rows: purchaseRows,
      purchaseRows,
      purchaseLinks,
      logisticsRows: [],
      total: purchaseRows.length + purchaseLinks.length,
      source: 'local-cache-agent',
    },
  };
}

function readCustomerRealtimeCursor(store, scopeId, searchParams) {
  const shopId = text(searchParams.get('shopId') || searchParams.get('shop_id'));
  if (!shopId) fail('CUSTOMER_SERVICE_REALTIME_SHOP_REQUIRED');
  const record = store.getRecord({
    scopeId,
    namespace: 'customer-service-realtime',
    key: shopId,
  });
  const sequence = Math.max(0, Number(record?.payload?.sequence) || 0);
  return {
    handled: true,
    status: 200,
    payload: {
      ok: true,
      shopId,
      sequence,
      changed: false,
      event: null,
      timedOut: searchParams.has('afterSequence'),
      source: 'local-cache-agent',
    },
  };
}

const CROSS_BORDER_CLIENT_SECRET_FIELDS = Object.freeze([
  'companySecret',
  'company_secret',
  'accessToken',
  'access_token',
  'expiresToken',
  'expires_token',
  'appUid',
  'app_uid',
  'password',
  'passwordEncrypted',
]);

function publicCrossBorderAccount(value = {}) {
  const authorizationRef = text(value.authorizationRef || value.authorization_ref);
  const shopIds = normalizeStringList(value.shopIds || value.shop_ids, 500);
  return {
    id: text(value.id),
    name: text(value.name),
    status: text(value.status) || 'inactive',
    authorizationRef,
    authorizationExpiresAt: text(
      value.authorizationExpiresAt || value.authorization_expires_at,
    ),
    hasServerAuthorization: Boolean(authorizationRef),
    defaultStorehouse: text(value.defaultStorehouse || value.default_storehouse),
    defaultSection: text(value.defaultSection || value.default_section),
    defaultService: text(value.defaultService || value.default_service),
    note: text(value.note),
    shopIds,
    shopCount: shopIds.length,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function saveCrossBorderAccount(store, scopeId, payload = {}) {
  for (const field of CROSS_BORDER_CLIENT_SECRET_FIELDS) {
    if (Object.hasOwn(payload, field) && text(payload[field])) {
      fail(
        'CROSS_BORDER_ENTERPRISE_SECRET_FORBIDDEN',
        '跨境巴士企业 API、Token、appUid 和密码只能由服务器处理。',
        400,
      );
    }
  }
  const id = text(payload.id || payload.accountId) || `cross_border_${crypto.randomUUID()}`;
  const existing = store.getRecord({
    scopeId,
    namespace: 'cross-border-accounts',
    key: id,
  });
  const timestamp = nowIso();
  const row = {
    ...(existing?.payload || {}),
    id,
    name: text(payload.name || existing?.payload?.name || '跨境巴士服务器授权'),
    status: text(payload.status || existing?.payload?.status || 'inactive'),
    authorizationRef: text(
      payload.authorizationRef
      || payload.authorization_ref
      || existing?.payload?.authorizationRef,
    ),
    authorizationExpiresAt: text(
      payload.authorizationExpiresAt
      || payload.authorization_expires_at
      || existing?.payload?.authorizationExpiresAt,
    ),
    defaultStorehouse: text(
      payload.defaultStorehouse
      || payload.default_storehouse
      || existing?.payload?.defaultStorehouse,
    ),
    defaultSection: text(
      payload.defaultSection
      || payload.default_section
      || existing?.payload?.defaultSection,
    ),
    defaultService: text(
      payload.defaultService
      || payload.default_service
      || existing?.payload?.defaultService,
    ),
    note: text(payload.note || existing?.payload?.note),
    shopIds: normalizeStringList(
      payload.shopIds || payload.shop_ids || existing?.payload?.shopIds,
      500,
    ),
    createdAt: existing?.payload?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  store.putRecord({ scopeId, namespace: 'cross-border-accounts', key: id, payload: row });
  return {
    handled: true,
    status: existing ? 200 : 201,
    payload: { ok: true, created: !existing, account: publicCrossBorderAccount(row) },
  };
}

function listCrossBorderAccounts(store, scopeId) {
  const rows = store.listRecords({
    scopeId,
    namespace: 'cross-border-accounts',
    limit: 1000,
  }).map((record) => publicCrossBorderAccount(record.payload));
  return {
    handled: true,
    status: 200,
    payload: { ok: true, rows, accounts: rows, total: rows.length },
  };
}

function deleteCrossBorderServerAccount(store, scopeId, accountId) {
  const id = text(accountId);
  if (!id) fail('CROSS_BORDER_ACCOUNT_ID_REQUIRED');
  const deleted = store.deleteRecord({
    scopeId,
    namespace: 'cross-border-accounts',
    key: id,
  }).deleted;
  return {
    handled: true,
    status: deleted ? 200 : 404,
    payload: deleted
      ? { ok: true, deleted: true, accountId: id }
      : { ok: false, deleted: false, code: 'CROSS_BORDER_ACCOUNT_NOT_FOUND' },
  };
}

function collectionRoute(method, pathname) {
  for (const definition of COLLECTION_ROUTE_DEFS) {
    if (pathname === definition.base) return { ...definition, method, kind: 'normal' };
    if (pathname === `${definition.base}/legacy-import`) return { ...definition, method, kind: 'legacy-import' };
  }
  return null;
}

function collectionQuery(searchParams) {
  return Object.fromEntries(searchParams.entries());
}

function collectionText(value) {
  return text(value).slice(0, 5000);
}

function collectionIdentity(definition, input = {}) {
  const shopId = collectionText(input.shopId ?? input.shop_id);
  const key = collectionText(
    definition.keyNames.map((name) => input[name]).find((value) => text(value)),
  );
  if (!shopId) fail(`${definition.family.toUpperCase()}_SOURCE_SHOP_ID_REQUIRED`);
  if (!key) fail(`${definition.family.toUpperCase()}_SOURCE_RECORD_KEY_REQUIRED`);
  return { shopId, key };
}

function collectionLinks(input = {}) {
  if (Array.isArray(input.links)) return input.links;
  if (Array.isArray(input.items)) return input.items;
  if (Array.isArray(input.record?.links)) return input.record.links;
  if (Array.isArray(input.record?.items)) return input.record.items;
  return [];
}

function collectionPublicLink(definition, input, index, identity) {
  const item = assertPlainObject(input, 'SOURCE_LINK_RECORD_INVALID');
  const slotIndex = Math.max(0, Number(item.slotIndex ?? item.slot_index ?? index) || 0);
  const url = collectionText(item.url ?? item.link ?? item.sourceUrl ?? item.source_url);
  const sourceProductId = collectionText(item.sourceProductId ?? item.source_product_id ?? item.productId ?? item.product_id);
  const base = {
    ...structuredClone(item),
    id: item.id || `${definition.family}-source-${crypto.createHash('sha256').update(`${identity.shopId}:${identity.key}:${slotIndex}`).digest('hex').slice(0, 32)}`,
    shopId: identity.shopId,
    shop_id: identity.shopId,
    slotIndex,
    slot_index: slotIndex,
    isPrimary: item.isPrimary === true || item.is_primary === true || slotIndex === Number(input.primaryIndex ?? input.primary_index ?? 0),
    is_primary: item.isPrimary === true || item.is_primary === true || slotIndex === Number(input.primaryIndex ?? input.primary_index ?? 0),
    url,
    link: url,
    sourceProductId,
    source_product_id: sourceProductId,
    title: collectionText(item.title ?? item.name),
    imageUrl: collectionText(item.imageUrl ?? item.image_url ?? item.image),
    previewImageUrl: collectionText(item.previewImageUrl ?? item.preview_image_url),
    originalImageUrl: collectionText(item.originalImageUrl ?? item.original_image_url),
    priceValue: Number.isFinite(Number(item.priceValue ?? item.price_value ?? item.price)) ? Number(item.priceValue ?? item.price_value ?? item.price) : null,
    currencyCode: collectionText(item.currencyCode ?? item.currency_code ?? item.currency ?? 'CNY'),
    qty: collectionText(item.qty ?? item.quantity ?? item.count),
    updatedAt: nowIso(),
  };
  if (definition.family === 'product') {
    base.productKey = identity.key;
    base.product_key = identity.key;
  } else {
    base.orderKey = identity.key;
    base.order_key = identity.key;
  }
  return base;
}

function collectionRows(store, scopeId, definition, query = {}) {
  const records = store.listRecords({ scopeId, namespace: definition.namespace, limit: 1000 });
  const shopId = collectionText(query.shopId ?? query.shop_id);
  const key = collectionText(definition.keyNames.map((name) => query[name]).find((value) => text(value)));
  const keyword = collectionText(query.keyword ?? query.q).toLowerCase();
  const rows = records
    .map((record) => record.payload)
    .filter((row) => (!shopId || shopId === 'all' || shopId === '*' || row.shopId === shopId))
    .filter((row) => (!key || (row.productKey || row.orderKey) === key))
    .filter((row) => (!keyword || JSON.stringify(row).toLowerCase().includes(keyword)))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  const pageSize = Math.min(Math.max(Number(query.pageSize ?? query.limit) || 100, 1), 1000);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
  return { rows: rows.slice(offset, offset + pageSize), total: rows.length, page, pageSize, offset };
}

function deleteCollectionGroup(store, scopeId, definition, identity) {
  const records = store.listRecords({ scopeId, namespace: definition.namespace, limit: 1000 });
  let deleted = 0;
  records.forEach((record) => {
    const row = record.payload || {};
    if (row.shopId === identity.shopId && (row.productKey || row.orderKey) === identity.key) {
      if (store.deleteRecord({ scopeId, namespace: definition.namespace, key: record.key }).deleted) deleted += 1;
    }
  });
  return deleted;
}

function saveCollection(store, scopeId, definition, payload) {
  const identity = collectionIdentity(definition, payload);
  const links = collectionLinks(payload);
  if (definition.family !== 'override' && !links.length) fail('SOURCE_LINKS_REQUIRED');
  if (definition.family === 'override') {
    const override = { ...structuredClone(payload), ...identity, orderKey: identity.key, order_key: identity.key, updatedAt: nowIso() };
    store.putRecord({ scopeId, namespace: definition.namespace, key: `${identity.shopId}:${identity.key}`, payload: override });
    return { ok: true, override };
  }
  const rows = links.slice(0, 100).map((link, index) => collectionPublicLink(
    definition,
    { ...link, primaryIndex: payload.primaryIndex ?? payload.primary_index },
    index,
    identity,
  ));
  const retained = new Set(rows.map((row) => `${identity.shopId}:${identity.key}:${row.slotIndex}`));
  const existing = store.listRecords({ scopeId, namespace: definition.namespace, limit: 1000 });
  const writes = rows.map((row) => ({ scopeId, namespace: definition.namespace, key: `${identity.shopId}:${identity.key}:${row.slotIndex}`, payload: row }));
  const stale = existing.filter((record) => record.payload?.shopId === identity.shopId && (record.payload?.productKey || record.payload?.orderKey) === identity.key && !retained.has(record.key));
  store.putRecordsAtomic(writes);
  stale.forEach((record) => store.deleteRecord({ scopeId, namespace: definition.namespace, key: record.key }));
  const resultRows = rows;
  if (definition.family === 'product') return { ok: true, domain: 'products', changed: rows.length, links: resultRows, record: { links: resultRows, primaryIndex: Number(payload.primaryIndex ?? payload.primary_index) || 0 } };
  if (definition.family === 'purchase') return { ok: true, changed: rows.length, links: resultRows };
  return { ok: true, changed: rows.length, rows: resultRows, total: resultRows.length, page: 1, pageSize: 1000, offset: 0 };
}

function importCollection(store, scopeId, definition, payload) {
  const inputs = Array.isArray(payload?.records) ? payload.records : Array.isArray(payload?.overrides) ? payload.overrides : Array.isArray(payload?.entries) ? payload.entries : [];
  if (!inputs.length) fail(`${definition.family.toUpperCase()}_SOURCE_LEGACY_IMPORT_REQUIRED`);
  const seen = new Set();
  inputs.forEach((input) => {
    const identity = collectionIdentity(definition, input);
    const groupKey = `${identity.shopId}:${identity.key}`;
    if (seen.has(groupKey)) fail('SOURCE_LEGACY_RECORD_DUPLICATE');
    seen.add(groupKey);
    saveCollection(store, scopeId, definition, input);
  });
  return { ok: true, importedCount: inputs.length, scopeCount: new Set(inputs.map((input) => collectionIdentity(definition, input).shopId)).size, digest: crypto.createHash('sha256').update(JSON.stringify(inputs.map((input) => collectionIdentity(definition, input)))).digest('hex') };
}

function prepareLegacyShopImport(store, scopeId, payload) {
  assertPlainObject(payload, 'SHOP_LEGACY_IMPORT_PAYLOAD_INVALID');
  if (!Array.isArray(payload.shops) || payload.shops.length < 1 || payload.shops.length > 1000) {
    fail('SHOP_LEGACY_IMPORT_SHOPS_REQUIRED');
  }
  const ids = new Set();
  const clientIds = new Set();
  const shops = payload.shops.map((input) => {
    assertPlainObject(input, 'SHOP_LEGACY_IMPORT_RECORD_INVALID');
    for (const field of Object.keys(input)) {
      if (!LEGACY_SHOP_FIELDS.has(field)) fail('SHOP_LEGACY_IMPORT_FIELD_NOT_ALLOWED');
    }
    const id = text(input.id);
    if (!id) fail('SHOP_LEGACY_IMPORT_ID_REQUIRED');
    if (ids.has(id)) fail('SHOP_LEGACY_IMPORT_ID_DUPLICATE');
    ids.add(id);
    const status = text(input.status);
    if (status && !SHOP_STATUSES.has(status)) fail('SHOP_LEGACY_IMPORT_STATUS_INVALID');
    const existing = shopRecord(store, scopeId, id)?.payload || null;
    const shop = normalizeShop(input, existing, scopeId);
    if (Boolean(shop.clientId) !== Boolean(shop.apiKey)) fail('SHOP_LEGACY_IMPORT_CREDENTIAL_PAIR_REQUIRED');
    if (shop.clientId && clientIds.has(shop.clientId)) fail('SHOP_EXTERNAL_IDENTITY_ALREADY_BOUND');
    if (shop.clientId) clientIds.add(shop.clientId);
    return shop;
  });

  const preferences = structuredClone(assertPlainObject(
    payload.preferences,
    'SHOP_LEGACY_IMPORT_PREFERENCES_INVALID',
  ));
  try {
    assertSafeProfileSetting(preferences);
  } catch (error) {
    if (error?.code === 'PROFILE_SETTING_SECRET_FIELD_FORBIDDEN') {
      fail('SHOP_LEGACY_IMPORT_PREFERENCE_SECRET_FIELD');
    }
    throw error;
  }
  if (Number(preferences.version) !== 1 || !Array.isArray(preferences.shops)) {
    fail('SHOP_LEGACY_IMPORT_PREFERENCES_INVALID');
  }
  const preferenceIds = new Set();
  for (const preferenceShop of preferences.shops) {
    assertPlainObject(preferenceShop, 'SHOP_LEGACY_IMPORT_PREFERENCE_SHOP_INVALID');
    const id = text(preferenceShop.id);
    if (!id || preferenceIds.has(id) || !ids.has(id)) fail('SHOP_LEGACY_IMPORT_PREFERENCE_SCOPE_INVALID');
    preferenceIds.add(id);
  }
  if (preferenceIds.size !== ids.size) fail('SHOP_LEGACY_IMPORT_PREFERENCE_SCOPE_INCOMPLETE');
  if (!ids.has(text(preferences.activeShopId))) fail('SHOP_LEGACY_IMPORT_ACTIVE_SHOP_INVALID');
  assertPlainObject(preferences.defaultWarehouseIds, 'SHOP_LEGACY_IMPORT_WAREHOUSE_MAP_INVALID');
  for (const shopId of Object.keys(preferences.defaultWarehouseIds)) {
    if (!ids.has(text(shopId))) fail('SHOP_LEGACY_IMPORT_WAREHOUSE_SCOPE_INVALID');
  }
  return { ids, shops, preferences };
}

export function createCompatibilityRoutes({ store }) {
  async function handle({ method, pathname, searchParams, payload, scopeId }) {
    if (pathname === '/api/logistics/cross-border/accounts' && method === 'GET') {
      return listCrossBorderAccounts(store, scopeId);
    }
    if (pathname === '/api/logistics/cross-border/accounts' && method === 'POST') {
      return saveCrossBorderAccount(store, scopeId, payload);
    }
    const crossBorderAccountMatch = pathname.match(/^\/api\/logistics\/cross-border\/server-accounts\/([^/]+)$/u);
    if (crossBorderAccountMatch && method === 'DELETE') {
      return deleteCrossBorderServerAccount(
        store,
        scopeId,
        decodeURIComponent(crossBorderAccountMatch[1]),
      );
    }
    if (method === 'POST' && pathname === '/api/customer-service/outbound-file/stage') {
      return stageCustomerOutboundFile(store, scopeId, payload);
    }
    if (method === 'GET' && pathname === '/api/customer-service/order-route-context') {
      return readCustomerOrderRouteContext(store, scopeId, searchParams);
    }
    if (method === 'GET' && pathname === '/api/customer-service/realtime/wait') {
      return readCustomerRealtimeCursor(store, scopeId, searchParams);
    }
    if (method === 'POST' && pathname === '/v1/internal/shop-credentials/get') {
      const shopId = text(payload?.shopId);
      if (!shopId) fail('SHOP_ID_REQUIRED');
      const record = shopRecord(store, scopeId, shopId);
      if (!record) fail('SHOP_NOT_FOUND', '未找到指定店铺。', 404);
      const shop = record.payload;
      if (!shop.clientId || !shop.apiKey) fail('SHOP_CREDENTIALS_REQUIRED', '店铺缺少 Client ID 或 API Key。');
      return {
        handled: true,
        status: 200,
        payload: {
          ok: true,
          credentials: { clientId: shop.clientId, apiKey: shop.apiKey },
          shop: publicShop(shop),
        },
      };
    }

    if (method === 'POST' && pathname === '/v1/internal/model-api-credentials/get') {
      const accountId = text(payload?.accountId);
      const records = store.listRecords({ scopeId, namespace: 'model-api-accounts', limit: 1000 });
      const record = accountId
        ? records.find((item) => item.key === accountId)
        : records.find((item) => item.payload?.isDefault && item.payload?.apiKey)
          || records.find((item) => item.payload?.apiKey);
      if (!record) fail('MODEL_API_ACCOUNT_NOT_FOUND', '未找到模型中转账号。', 404);
      return {
        handled: true,
        status: 200,
        payload: {
          ok: true,
          account: publicModelApiAccount(record.payload),
          credentials: {
            loginAccount: record.payload.loginAccount || '',
            loginPassword: record.payload.loginPassword || '',
            apiKey: record.payload.apiKey || '',
          },
        },
      };
    }

    if (method === 'GET' && pathname === '/api/model-api/accounts') {
      const accounts = store.listRecords({
        scopeId,
        namespace: 'model-api-accounts',
        limit: 1000,
      }).map((record) => publicModelApiAccount(record.payload))
        .sort((left, right) => (
          Number(right.isDefault) - Number(left.isDefault)
          || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
          || String(left.apiAlias || '').localeCompare(String(right.apiAlias || ''))
        ));
      return {
        handled: true,
        status: 200,
        payload: { ok: true, accounts, rows: accounts, total: accounts.length },
      };
    }

    if (method === 'POST' && pathname === '/api/model-api/accounts') {
      const requestedId = text(payload?.id || payload?.accountId);
      const existing = requestedId
        ? store.getRecord({ scopeId, namespace: 'model-api-accounts', key: requestedId })?.payload || null
        : null;
      const account = normalizeModelApiAccount(payload, existing);
      const records = store.listRecords({ scopeId, namespace: 'model-api-accounts', limit: 1000 });
      const writes = [];
      if (account.isDefault) {
        for (const record of records) {
          if (record.key === account.id || record.payload?.isDefault !== true) continue;
          writes.push({
            scopeId,
            namespace: 'model-api-accounts',
            key: record.key,
            payload: { ...record.payload, isDefault: false, updatedAt: account.updatedAt },
          });
        }
      }
      writes.push({ scopeId, namespace: 'model-api-accounts', key: account.id, payload: account });
      store.putRecordsAtomic(writes);
      return {
        handled: true,
        status: 200,
        payload: { ok: true, created: !existing, account: publicModelApiAccount(account) },
      };
    }

    if (method === 'GET' && pathname === '/api/shops') {
      const records = store.listRecords({ scopeId, namespace: 'shops', limit: 1000 });
      const shops = records.map((record) => publicShop(record.payload));
      if (searchParams.get('cursorMode') === 'legacy-migration') {
        return { handled: true, status: 200, payload: { ok: true, rows: shops, total: shops.length, hasMore: false, nextCursor: '' } };
      }
      return { handled: true, status: 200, payload: { ok: true, count: shops.length, shops } };
    }

    if (method === 'POST' && pathname === '/api/shops/legacy-import') {
      const prepared = prepareLegacyShopImport(store, scopeId, payload);
      const existingPreferences = store.getRecord({
        scopeId,
        namespace: 'profile-settings',
        key: 'ozon-shop-preferences',
      });
      const timestamp = nowIso();
      const setting = {
        namespace: 'ozon-shop-preferences',
        value: prepared.preferences,
        createdAt: existingPreferences?.payload?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      store.putRecordsAtomic([
        ...prepared.shops.map((shop) => ({
          scopeId,
          namespace: 'shops',
          key: shop.id,
          payload: shop,
        })),
        {
          scopeId,
          namespace: 'profile-settings',
          key: 'ozon-shop-preferences',
          payload: setting,
        },
      ]);
      return {
        handled: true,
        status: 200,
        payload: {
          ok: true,
          importedCount: prepared.shops.length,
          scopeCount: prepared.ids.size,
          digest: legacyImportDigest(prepared.shops, prepared.preferences),
        },
      };
    }

    if (method === 'POST' && pathname === '/api/shops') {
      const requestedId = text(payload?.id);
      const existingRecord = requestedId ? shopRecord(store, scopeId, requestedId) : null;
      const shop = normalizeShop(payload, existingRecord?.payload || null, scopeId);
      store.putRecord({ scopeId, namespace: 'shops', key: shop.id, payload: shop });
      return {
        handled: true,
        status: existingRecord ? 200 : 201,
        payload: {
          ok: true,
          created: !existingRecord,
          shop: publicShop(shop),
          bindingReady: false,
          bindingStatus: 'local_saved',
          bootstrapRun: null,
          bootstrap: { required: Boolean(shop.clientId && shop.apiKey), ready: false, status: 'local_saved', run: null },
        },
      };
    }

    const collection = collectionRoute(method, pathname);
    if (collection) {
      if (collection.kind === 'legacy-import' && method === 'POST') {
        return { handled: true, status: 200, payload: importCollection(store, scopeId, collection, payload) };
      }
      if (collection.family === 'override' && method === 'GET') {
        const result = collectionRows(store, scopeId, collection, collectionQuery(searchParams));
        return { handled: true, status: 200, payload: { ok: true, ...result, rows: result.rows } };
      }
      if (collection.family !== 'override' && method === 'GET') {
        const result = collectionRows(store, scopeId, collection, collectionQuery(searchParams));
        if (collection.family === 'product' && searchParams.get('cursorMode') !== 'legacy-migration') {
          return { handled: true, status: 200, payload: result.rows };
        }
        return { handled: true, status: 200, payload: { ok: true, ...result, rows: result.rows, hasMore: result.offset + result.rows.length < result.total, nextCursor: '' } };
      }
      if (method === 'POST') {
        return { handled: true, status: 200, payload: saveCollection(store, scopeId, collection, payload) };
      }
      if (method === 'DELETE') {
        const identity = collectionIdentity(collection, { ...collectionQuery(searchParams), ...payload });
        return { handled: true, status: 200, payload: { ok: true, deleted: deleteCollectionGroup(store, scopeId, collection, identity), [collection.family === 'product' ? 'productKey' : 'orderKey']: identity.key } };
      }
    }

    if (genericLocalRoute(method, pathname)) {
      return handleGenericLocalRoute();
    }

    if (method === 'POST' && pathname === '/api/profile-assets') {
      return { handled: true, status: 200, payload: saveProfileAsset(store, scopeId, payload) };
    }

    const profileAssetMatch = pathname.match(/^\/api\/profile-assets\/([^/]+)$/u);
    if (method === 'GET' && profileAssetMatch) {
      const assetId = decodeURIComponent(profileAssetMatch[1]);
      const asset = store.readAsset({ scopeId, assetId });
      return {
        handled: true,
        status: 200,
        payload: { ok: true, asset: profileAssetDto(asset, { includeData: true, content: asset?.content }) },
      };
    }

    if (pathname === '/api/profit/ledger-snapshot') {
      if (method === 'GET') {
        return { handled: true, status: 200, payload: readProfitLedgerSnapshot(store, scopeId, searchParams) };
      }
      if (method === 'PUT') {
        return { handled: true, status: 200, payload: saveProfitLedgerSnapshot(store, scopeId, payload) };
      }
      if (method === 'DELETE') {
        return { handled: true, status: 200, payload: clearProfitLedgerSnapshots(store, scopeId, payload, searchParams) };
      }
    }

    const profileMatch = pathname.match(/^\/api\/profile-settings\/([^/]+)$/u);
    if (profileMatch) {
      const namespace = decodeURIComponent(profileMatch[1]);
      if (!PROFILE_SETTING_NAMESPACES.has(namespace)) fail('PROFILE_SETTING_NAMESPACE_FORBIDDEN');
      if (method === 'GET') {
        const record = store.getRecord({ scopeId, namespace: 'profile-settings', key: namespace });
        return { handled: true, status: 200, payload: { ok: true, setting: record?.payload || null } };
      }
      if (method === 'PUT') {
        assertPlainObject(payload?.value, 'PROFILE_SETTING_VALUE_INVALID');
        assertSafeProfileSetting(payload.value);
        const existing = store.getRecord({ scopeId, namespace: 'profile-settings', key: namespace });
        const timestamp = nowIso();
        const setting = {
          namespace,
          value: structuredClone(payload.value),
          createdAt: existing?.payload?.createdAt || timestamp,
          updatedAt: timestamp,
        };
        store.putRecord({ scopeId, namespace: 'profile-settings', key: namespace, payload: setting });
        return { handled: true, status: 200, payload: { ok: true, created: !existing, setting } };
      }
      if (method === 'DELETE') {
        const existing = store.getRecord({ scopeId, namespace: 'profile-settings', key: namespace });
        const result = store.deleteRecord({ scopeId, namespace: 'profile-settings', key: namespace });
        return {
          handled: true,
          status: 200,
          payload: { ok: true, deleted: result.deleted, namespace, ...(existing ? { setting: existing.payload } : {}) },
        };
      }
    }
    return { handled: false };
  }

  return Object.freeze({ handle });
}

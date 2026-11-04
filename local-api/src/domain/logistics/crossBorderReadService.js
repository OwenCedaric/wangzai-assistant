import { assertCrossBorderReadEndpoint, listCrossBorderEndpoints } from '../../cross-border/crossBorderEndpointRegistry.js';
import { createCrossBorderAccountRepository } from '../../db/repositories/crossBorderAccountRepository.js';
import { createCrossBorderOrderRepository } from '../../db/repositories/crossBorderOrderRepository.js';
import { resolveCrossBorderAccountShop } from './crossBorderAccountScope.js';

function hasTable(db, tableName) {
  try {
    return Boolean(db?.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', tableName));
  } catch {
    return false;
  }
}

function getPayload(data) {
  if (!data || typeof data !== 'object') return data;
  return data.data ?? data.result ?? data.payload ?? data;
}

function getListItems(data) {
  const payload = getPayload(data);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.result?.list)) return payload.result.list;
  return [];
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function buildRecordFromReadResult(endpointKey, data, context = {}) {
  if (endpointKey === 'order.search') {
    return getListItems(data).map((item) => ({ ...item, shopId: context.shopId }));
  }
  if (endpointKey === 'order.status' || endpointKey === 'order.outInfo') {
    const orderId = normalizeText(context.body?.order_id ?? context.body?.orderId ?? context.body?.id);
    if (!orderId) return [];
    return [
      {
        shopId: context.shopId,
        order_id: orderId,
        ...(endpointKey === 'order.status' ? { statusPayload: getPayload(data) } : { outPayload: getPayload(data) }),
        raw: { endpointKey, body: context.body, payload: getPayload(data) },
      },
    ];
  }
  return [];
}

export function createCrossBorderReadService({ db, crossBorderClient, profileId, tenantId, userId } = {}) {
  const accountRepository = db && hasTable(db, 'cross_border_accounts')
    ? createCrossBorderAccountRepository(db, { profileId, tenantId, userId })
    : null;
  const orderRepository = db && hasTable(db, 'cross_border_order_records') ? createCrossBorderOrderRepository(db) : null;

  function ensureReady() {
    if (!accountRepository || !orderRepository || !crossBorderClient?.requestReadOnly) {
      const error = new Error('cross-border read service is not connected.');
      error.code = 'CROSS_BORDER_READ_NOT_CONNECTED';
      throw error;
    }
  }

  function listEndpoints() {
    return {
      ok: true,
      endpoints: listCrossBorderEndpoints().map((endpoint) => ({
        key: endpoint.key,
        risk: endpoint.risk,
        method: endpoint.method,
        path: endpoint.path,
        description: endpoint.description,
      })),
    };
  }

  async function requestReadOnly(payload = {}) {
    ensureReady();
    const endpointKey = normalizeText(payload.endpointKey ?? payload.endpoint_key);
    const accountId = normalizeText(payload.accountId ?? payload.account_id);
    const shopId = normalizeText(payload.shopId ?? payload.shop_id);
    if (!endpointKey) throw new Error('endpointKey is required for cross-border read.');
    if (!accountId) throw new Error('accountId is required for cross-border read.');
    const endpoint = assertCrossBorderReadEndpoint(endpointKey);
    const credentials = accountRepository.getCredentialsForInternalUse(accountId);
    if (!credentials) {
      const error = new Error('跨境巴士授权账号不存在。');
      error.code = 'CROSS_BORDER_ACCOUNT_NOT_FOUND';
      throw error;
    }
    const accountScope = resolveCrossBorderAccountShop(credentials, shopId, {
      requireShop: endpoint.key.startsWith('order.'),
    });
    const effectiveShopId = accountScope.shopId;
    const result = await crossBorderClient.requestReadOnly({
      endpointKey,
      credentials,
      body: payload.body || {},
      timeoutMs: payload.timeoutMs,
    });
    const records = buildRecordFromReadResult(endpointKey, result.data, {
      shopId: effectiveShopId,
      body: payload.body || {},
    });
    const saved = records.length
      ? orderRepository.upsertRecords({ shopId: effectiveShopId, records })
      : { ok: true, rows: [], total: 0 };
    return {
      ok: true,
      endpointKey,
      accountId,
      shopId: effectiveShopId,
      data: result.data,
      cachedRecords: saved.rows || [],
      cachedRecordCount: saved.total || 0,
    };
  }

  return { domain: 'cross-border-read', listEndpoints, requestReadOnly };
}


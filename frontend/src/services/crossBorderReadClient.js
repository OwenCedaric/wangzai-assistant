import {
  getCrossBorderAccounts,
} from '../api/localApiClient.js';
import {
  listCrossBorderServerEndpoints,
  readCrossBorderWithServer,
} from '../features/licensing/services/licenseCenterClient.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

const LEGACY_ENDPOINT_MAP = {
  '/erpapi/orderlist/search': 'order.search',
  '/erpapi/orderlist/status': 'order.status',
  '/erpapi/order/get_order_out_info': 'order.outInfo',
  '/erpapi/user/queryauthorization': 'auth.queryAuthorization',
  '/erpapi/storehouse/cooperationStorehouse': 'warehouse.cooperationStorehouse',
  '/erpapi/storehouse/searchStorehouseSection': 'warehouse.searchStorehouseSection',
};

export function mapLegacyCrossBorderEndpoint(endpoint) {
  return LEGACY_ENDPOINT_MAP[normalizeText(endpoint)] || '';
}

async function resolveServerAuthorization(accountId) {
  const payload = await getCrossBorderAccounts();
  const rows = Array.isArray(payload?.rows) ? payload.rows : payload?.accounts || [];
  const requested = normalizeText(accountId);
  const account = rows.find((item) => normalizeText(item?.id) === requested)
    || (rows.length === 1 ? rows[0] : null);
  const authorizationRef = normalizeText(account?.authorizationRef || account?.authorization_ref);
  if (!authorizationRef) throw new Error('跨境巴士服务器授权不存在，请重新授权');
  return { authorizationRef, account };
}

export async function listCrossBorderReadEndpoints(options = {}) {
  void options;
  return listCrossBorderServerEndpoints();
}

export async function readCrossBorderEndpoint(
  { endpointKey, legacyEndpoint, accountId, shopId, body = {}, timeoutMs, dedupeKey, maxRetries } = {},
  options = {}
) {
  const resolvedEndpointKey = normalizeText(endpointKey) || mapLegacyCrossBorderEndpoint(legacyEndpoint);
  if (!resolvedEndpointKey) {
    throw Object.assign(new Error('该跨境巴士接口尚未接入只读通道。'), {
      code: 'CROSS_BORDER_ENDPOINT_NOT_CONNECTED',
    });
  }
  const server = await resolveServerAuthorization(accountId);
  void shopId;
  void timeoutMs;
  void dedupeKey;
  void maxRetries;
  void options;
  const result = await readCrossBorderWithServer({
    authorizationRef: server.authorizationRef,
    endpointKey: resolvedEndpointKey,
    body,
  });
  return { ...result, endpointKey: result.endpoint_key || resolvedEndpointKey };
}

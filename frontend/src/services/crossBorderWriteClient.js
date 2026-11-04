import {
  getCrossBorderAccounts,
} from '../api/localApiClient.js';
import {
  confirmCrossBorderWriteWithServer,
  previewCrossBorderWriteWithServer,
} from '../features/licensing/services/licenseCenterClient.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

const LEGACY_WRITE_ENDPOINT_MAP = {
  '/erpapi/order/createOrder': 'order.create',
  '/erpapi/order/updateOrder': 'order.update',
  '/erpapi/order/updateOrderSheet': 'order.updateSheet',
  '/erpapi/order/updateOrderPackage': 'order.updatePackage',
  '/erpapi/order/cancelOrder': 'order.cancel',
  '/erpapi/ordersync/order_update': 'order.syncStatus',
  '/erpapi/orderassociation/association_order_account': 'order.associate',
};

export function mapLegacyCrossBorderWriteEndpoint(endpoint) {
  return LEGACY_WRITE_ENDPOINT_MAP[normalizeText(endpoint)] || '';
}

export function toCrossBorderWritePayload(input = {}) {
  const endpointKey = normalizeText(input.endpointKey) || mapLegacyCrossBorderWriteEndpoint(input.legacyEndpoint);
  if (!endpointKey) {
    const error = new Error('该跨境巴士写入接口尚未接入写入安全门。');
    error.code = 'CROSS_BORDER_WRITE_ENDPOINT_NOT_CONNECTED';
    throw error;
  }
  return {
    endpointKey,
    accountId: normalizeText(input.accountId),
    shopId: normalizeText(input.shopId),
    action: normalizeText(input.action) || endpointKey,
    before: input.before ?? null,
    after: input.after ?? input.body ?? input.payload ?? null,
    payload: input.payload ?? input.body ?? input.after ?? null,
    requestedBy: normalizeText(input.requestedBy) || 'frontend-cross-border-write-client',
    idempotencyKey: normalizeText(input.idempotencyKey),
  };
}

async function resolveServerAuthorization(accountId) {
  const response = await getCrossBorderAccounts();
  const rows = Array.isArray(response?.rows) ? response.rows : response?.accounts || [];
  const requested = normalizeText(accountId);
  const account = rows.find((item) => normalizeText(item?.id) === requested)
    || (rows.length === 1 ? rows[0] : null);
  const authorizationRef = normalizeText(account?.authorizationRef || account?.authorization_ref);
  if (!authorizationRef) throw new Error('跨境巴士服务器授权不存在，请重新授权');
  return { authorizationRef, account };
}

export async function previewCrossBorderWriteOperation(input = {}, options = {}) {
  const payload = toCrossBorderWritePayload(input);
  const server = await resolveServerAuthorization(payload.accountId);
  void options;
  const result = await previewCrossBorderWriteWithServer({
    authorizationRef: server.authorizationRef,
    endpointKey: payload.endpointKey,
    body: payload.payload || {},
    requestId: payload.idempotencyKey || undefined,
  });
  return { ...result, previewId: result.preview_token };
}

export async function confirmCrossBorderWriteOperation(input = {}, options = {}) {
  const previewId = normalizeText(input.previewId);
  if (!previewId) {
    throw Object.assign(new Error('跨境巴士写入确认需要 previewId。'), {
      code: 'CROSS_BORDER_WRITE_PREVIEW_REQUIRED',
    });
  }
  const payload = toCrossBorderWritePayload(input);
  const server = await resolveServerAuthorization(payload.accountId);
  void options;
  return confirmCrossBorderWriteWithServer({
    authorizationRef: server.authorizationRef,
    previewToken: previewId,
  });
}

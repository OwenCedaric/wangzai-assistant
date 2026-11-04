import {
  LocalApiError,
  confirmDomainWrite,
  previewDomainWrite,
  requestLocalOzon,
} from '../../../api/localApiClient.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function errorFrom(result = {}) {
  return new LocalApiError(
    result?.error?.message || result?.message || 'Ozon 仓库操作失败。',
    {
      status: result?.status || 200,
      code: result?.error?.code || result?.code || 'LOGISTICS_WRITE_FAILED',
      payload: result,
    },
  );
}

export function createWarehouseWritePayload(input = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  return {
    shopId: text(input.shopId || input.shop_id),
    action: text(input.action),
    endpointKey: text(input.endpointKey),
    payload,
    before: input.before || null,
    after: input.after || payload,
    idempotencyKey: text(input.idempotencyKey),
    requestedBy: input.requestedBy || 'warehouse-logistics-page',
  };
}

export async function requestWarehouseWriteOperation(input = {}, options = {}) {
  const payload = createWarehouseWritePayload(input);
  const preview = await previewDomainWrite('logistics', payload, options);
  if (!preview?.ok || !preview.previewId) throw errorFrom(preview);
  const confirm = await confirmDomainWrite('logistics', {
    ...payload,
    previewId: preview.previewId,
    confirm: true,
    realWrite: input.realWrite !== false,
    dryRun: input.dryRun === true,
    waitForResult: true,
  }, options);
  if (!confirm?.ok) throw errorFrom(confirm);
  return {
    ...confirm,
    previewId: confirm.previewId || preview.previewId,
    message: confirm.message || (
      confirm.writeStatus === 'readback_merged'
        ? 'Ozon 仓库操作成功并已完成回读。'
        : 'Ozon 仓库操作已提交，正在等待回读。'
    ),
  };
}

export function isRfbsWarehouse(warehouse = {}) {
  return warehouse?.raw?.is_rfbs === true || warehouse?.raw?.isRfbs === true;
}

export function isPausedRfbsWarehouse(warehouse = {}) {
  return Boolean(warehouse?.raw?.pause_at || warehouse?.raw?.pauseAt)
    || /暂停|pause/iu.test(String(warehouse?.status || warehouse?.raw?.status || ''));
}

export function getDeliveryMethodWriteEndpoint(method = {}) {
  const integrationType = text(
    method?.raw?.tpl_integration_type
      || method?.raw?.tplIntegrationType
      || method?.raw?.integration_type,
  ).toLowerCase();
  return integrationType === 'aggregator'
    ? 'warehouse.erfbsAggregatorDeliveryMethodUpdate'
    : 'warehouse.erfbsNonIntegratedDeliveryMethodUpdate';
}

export async function requestWarehouseReferenceData({ shop, endpoint, body = {} } = {}, options = {}) {
  return requestLocalOzon({
    endpoint,
    method: 'POST',
    access: 'read',
    shop,
    body,
    requestedBy: 'warehouse-create-dialog',
  }, options);
}

export function getWarehouseReferenceRows(payload = {}, field = 'points') {
  const candidates = [
    payload?.[field],
    payload?.result?.[field],
    payload?.data?.[field],
    payload?.result,
  ];
  return candidates.find(Array.isArray) || [];
}

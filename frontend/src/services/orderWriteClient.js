import { LocalApiError, confirmDomainWrite, previewDomainWrite } from '../api/localApiClient.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizePayload(value) {
  return value && typeof value === 'object' ? value : {};
}

export function getOrderWriteStatusMessage(result = {}) {
  const code = normalizeText(result.error?.code || result.code);
  const writeStatus = normalizeText(result.writeStatus);

  if (code === 'REAL_OZON_WRITE_DISABLED' || writeStatus === 'blocked_real_write_disabled') {
    return '真实 Ozon 写入总开关未开启，本次不会提交 Ozon。';
  }
  if (code === 'REAL_OZON_WRITE_SHOP_ID_REQUIRED' || writeStatus === 'blocked_shop_missing') {
    return '真实 Ozon 写入缺少店铺信息，无法确认店铺授权。';
  }
  if (writeStatus === 'submitted_waiting_readback' && result.readBackJobs?.scheduled) {
    return '订单写入已提交 Ozon，后台回读已排队；SQLite 合并完成前仅显示处理中。';
  }
  if (writeStatus === 'submitted_waiting_readback') {
    return '订单写入已提交 Ozon，等待回读确认；SQLite 合并完成前仅显示处理中。';
  }
  if (writeStatus === 'readback_merged') {
    return '订单 Ozon 写入回读成功，SQLite 已合并。';
  }
  return result.message || result.error?.message || '订单写入状态未知，请查看 local-api 审计日志。';
}

function createOrderWriteError(result = {}) {
  const message = getOrderWriteStatusMessage(result);
  const error = new LocalApiError(message, {
    status: result.status || 200,
    code: result.error?.code || result.code || 'ORDER_WRITE_FAILED',
    payload: result,
  });
  error.writeStatus = result.writeStatus || null;
  error.previewId = result.previewId || null;
  return error;
}

function unwrapOrderWriteData(result = {}) {
  const data = result.schedulerResult?.data ?? result.data ?? null;
  const payload = data && typeof data === 'object' ? { ...data } : { result: data };
  const writeStatus = result.writeStatus || payload.writeStatus || null;
  const readBack = result.readBack ?? payload.readBack ?? null;
  const readBackJobs = result.readBackJobs ?? payload.readBackJobs ?? null;
  const splitRelation = result.splitRelation ?? payload.splitRelation ?? null;
  return {
    ...payload,
    writeStatus,
    readBack,
    readBackJobs,
    splitRelation,
    localApiWrite: {
      domain: 'orders',
      endpointKey: result.endpointKey || null,
      action: result.action || null,
      previewId: result.previewId || null,
      auditId: result.auditId || null,
      writeStatus,
      message: getOrderWriteStatusMessage({ ...result, writeStatus, readBackJobs }),
      schedulerResult: result.schedulerResult || null,
      readBack,
      readBackJobs,
      splitRelation,
    },
  };
}

export function createOrderWritePayload(input = {}) {
  const payload = normalizePayload(input.payload);
  return {
    shopId: normalizeText(input.shopId || input.shop_id),
    action: normalizeText(input.action || input.operationId),
    endpointKey: normalizeText(input.endpointKey),
    payload,
    before: input.before || null,
    after: input.after || payload,
    idempotencyKey: normalizeText(input.idempotencyKey),
    requestedBy: input.requestedBy || 'order-write-client',
  };
}

export async function requestOrderWriteOperation(input = {}, options = {}) {
  const previewPayload = createOrderWritePayload(input);
  const preview = await previewDomainWrite('orders', previewPayload, options);
  if (!preview?.ok || !preview.previewId) {
    throw createOrderWriteError(
      preview || { error: { code: 'ORDER_WRITE_PREVIEW_FAILED', message: '订单写入预览失败。' } }
    );
  }

  const confirmPayload = {
    ...previewPayload,
    previewId: preview.previewId,
    confirm: true,
    realWrite: input.realWrite !== false,
    dryRun: input.dryRun === true,
    fastAck: input.fastAck === true,
    asyncWrite: input.asyncWrite === true,
    waitForResult: input.waitForResult !== false,
  };
  const confirm = await confirmDomainWrite('orders', confirmPayload, options);
  if (!confirm?.ok) {
    throw createOrderWriteError({
      action: previewPayload.action,
      endpointKey: previewPayload.endpointKey,
      ...(confirm || {}),
      previewId: preview.previewId,
    });
  }

  return unwrapOrderWriteData({
    action: previewPayload.action,
    endpointKey: previewPayload.endpointKey,
    ...confirm,
    previewId: confirm.previewId || preview.previewId,
  });
}

const RETURNS_WRITE_ACTIONS = Object.freeze({
  setRfbsReturnAction: {
    endpointKey: 'returns.setRfbsReturnAction',
    description: '提交 rFBS 退货处理动作',
    source: 'rfbs-return',
  },
  rejectRfbsReturn: {
    endpointKey: 'returns.rejectRfbsReturn',
    description: '拒绝 rFBS 退货',
    source: 'rfbs-return',
  },
  compensateRfbsReturn: {
    endpointKey: 'returns.compensateRfbsReturn',
    description: 'rFBS 部分退款或补偿',
    source: 'rfbs-return',
  },
  verifyRfbsReturn: {
    endpointKey: 'returns.verifyRfbsReturn',
    description: '同意 rFBS 退货',
    source: 'rfbs-return',
  },
  receiveRfbsReturn: {
    endpointKey: 'returns.receiveRfbsReturn',
    description: '确认收到退货并检查',
    source: 'rfbs-return',
  },
  refundRfbsReturn: {
    endpointKey: 'returns.refundRfbsReturn',
    description: '给买家退款',
    source: 'rfbs-return',
  },
  approveConditionalCancellation: {
    endpointKey: 'returns.approveConditionalCancellation',
    description: '同意 rFBS 条件取消',
    source: 'conditional',
  },
  rejectConditionalCancellation: {
    endpointKey: 'returns.rejectConditionalCancellation',
    description: '拒绝 rFBS 条件取消',
    source: 'conditional',
  },
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.returns)) return value.returns;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.conditional_cancellations)) return value.conditional_cancellations;
  if (Array.isArray(value?.cancellations)) return value.cancellations;
  if (Array.isArray(value?.result?.returns)) return value.result.returns;
  if (Array.isArray(value?.result?.items)) return value.result.items;
  if (Array.isArray(value?.result?.conditional_cancellations)) return value.result.conditional_cancellations;
  if (Array.isArray(value?.result?.cancellations)) return value.result.cancellations;
  if (Array.isArray(value?.result)) return value.result;
  if (value?.result && typeof value.result === 'object') return [value.result];
  if (value && typeof value === 'object' && (value.return_id || value.returnId || value.id || value.cancellation_id)) {
    return [value];
  }
  return [];
}

function resolveReadBackRows(result = {}, input = {}, preview = {}) {
  const direct = normalizeRows(result.readBackRows);
  if (direct.length) return direct;
  const dataRows = normalizeRows(result.data?.readBackRows || result.data?.items || result.data?.result || result.data);
  if (dataRows.length) return dataRows;
  const inputRows = normalizeRows(input.readBackRows || input.payload?.readBackRows || input.after?.readBackRows);
  if (inputRows.length) return inputRows;
  return normalizeRows(preview?.payload?.readBackRows || preview?.diff?.after?.readBackRows);
}

function resolveAction(input = {}, preview = {}) {
  return normalizeText(input.action || preview?.action || preview?.diff?.action);
}

function resolveEndpointKey(input = {}, preview = {}, actionConfig = {}) {
  return normalizeText(input.endpointKey || preview?.endpointKey || preview?.diff?.endpointKey) || actionConfig.endpointKey;
}

export function listReturnsWriteActions() {
  return Object.entries(RETURNS_WRITE_ACTIONS).map(([action, config]) => ({
    action,
    endpointKey: config.endpointKey,
    description: config.description,
  }));
}

export function createReturnsWriteService({ repository, ozonScheduler } = {}) {
  function validateFoundation() {
    if (!repository) {
      return {
        ok: false,
        error: {
          code: 'RETURNS_WRITE_CACHE_NOT_CONNECTED',
          message: '售后写入回读需要先连接 ozon_returns 缓存表。',
        },
      };
    }
    if (!ozonScheduler?.executeWrite) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: 'RETURNS_WRITE_EXECUTOR_NOT_CONNECTED',
          message: '售后写入执行器尚未连接，本次不会写入 Ozon。',
        },
        writeQueue: {
          priority: 'WRITE',
          connected: false,
          requiredFlow: ['preview', 'confirm', 'write_queue', 'ozonClient.requestWrite', 'read_back', 'audit'],
        },
      };
    }
    return null;
  }

  async function executeConfirmedWrite({ preview, input = {} } = {}) {
    const foundationError = validateFoundation();
    if (foundationError) return foundationError;

    const action = resolveAction(input, preview);
    const actionConfig = RETURNS_WRITE_ACTIONS[action];
    if (!actionConfig) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: 'RETURNS_WRITE_ACTION_NOT_REGISTERED',
          message: `售后写入动作尚未登记：${action || 'unknown'}`,
        },
      };
    }

    const shopId = normalizeText(input.shopId || input.shop_id || preview?.shopId || preview?.diff?.shopId);
    if (!shopId) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: { code: 'RETURNS_WRITE_SHOP_ID_REQUIRED', message: '售后写入确认必须包含 shopId。' },
      };
    }

    const endpointKey = resolveEndpointKey(input, preview, actionConfig);
    if (endpointKey !== actionConfig.endpointKey) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        endpointKey,
        action,
        error: {
          code: 'RETURNS_WRITE_ENDPOINT_MISMATCH',
          message: `售后写入动作 ${action} 只能走 ${actionConfig.endpointKey}，不能改写为 ${endpointKey || 'unknown'}。`,
        },
      };
    }

    const payload = input.payload ?? preview?.payload ?? preview?.diff?.after ?? {};
    const idempotencyKey =
      normalizeText(input.idempotencyKey || preview?.idempotencyKey) ||
      `returns-write:${shopId}:${action}:${preview?.previewId || Date.now()}`;
    const realWrite = input.realWrite === true && input.dryRun === false;
    const fastAck = input.fastAck === true || input.asyncWrite === true || input.waitForResult === false;

    const writeResult = await ozonScheduler.executeWrite({
      shopId,
      domain: 'returns',
      endpointKey,
      action,
      priority: 'WRITE',
      params: payload,
      idempotencyKey,
      requestedBy: input.requestedBy || preview?.requestedBy || 'returns-write-guard',
      previewId: preview?.previewId || input.previewId,
      realWrite,
      dryRun: !realWrite,
      waitForResult: fastAck ? false : true,
      fastAck,
      asyncWrite: fastAck,
    });

    if (writeResult?.accepted === true || writeResult?.pending === true) {
      return {
        ok: true,
        accepted: true,
        pending: true,
        confirmed: true,
        writeConnected: true,
        writeStatus: 'submitted_waiting_readback',
        endpointKey,
        action,
        schedulerResult: {
          ok: true,
          accepted: true,
          pending: true,
          jobId: writeResult.jobId || writeResult.id || null,
          status: writeResult.status || 'accepted',
          realWrite: writeResult.realWrite === true,
          dryRun: writeResult.dryRun !== false,
          job: writeResult.job || null,
        },
        readBack: { status: 'pending', rows: 0, merge: null },
        message: '售后写入已提交 Ozon，等待回读确认；SQLite 合并完成前仅显示处理中。',
      };
    }

    if (!writeResult?.ok) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: true,
        writeStatus: 'write_failed',
        endpointKey,
        action,
        error: writeResult?.error || {
          code: 'RETURNS_WRITE_FAILED',
          message: '售后写入执行失败，旧缓存已保留。',
        },
        schedulerResult: writeResult || null,
      };
    }

    const readBackRows = resolveReadBackRows(writeResult, input, preview);
    const merge = readBackRows.length
      ? repository.upsertReturns({ shopId, rows: readBackRows, source: actionConfig.source || 'rfbs-return' })
      : { ok: true, changed: 0, inserted: 0, updated: 0, unchanged: 0, missing: 0, rows: 0, skipped: true };
    const hasReadBack = readBackRows.length > 0;

    return {
      ok: true,
      confirmed: true,
      writeConnected: true,
      writeStatus: writeResult.dryRun ? 'dry_run_recorded' : hasReadBack ? 'readback_merged' : 'submitted_waiting_readback',
      endpointKey,
      action,
      schedulerResult: {
        ok: true,
        jobId: writeResult.jobId || writeResult.id || null,
        status: writeResult.status || 'success',
        realWrite: writeResult.realWrite === true,
        dryRun: writeResult.dryRun !== false,
        data: writeResult.data || null,
      },
      readBack: {
        status: hasReadBack ? 'merged' : 'pending',
        rows: readBackRows.length,
        merge,
      },
      message: writeResult.dryRun
        ? '售后写入已记录 dry-run，未写入 Ozon。'
        : hasReadBack
          ? '售后 Ozon 写入回读成功，SQLite 已合并。'
          : '售后写入已提交 Ozon，等待回读确认；未取得回读结果前仅显示处理中。',
    };
  }

  return {
    listActions: listReturnsWriteActions,
    executeConfirmedWrite,
  };
}

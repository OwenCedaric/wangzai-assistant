const MARKETING_WRITE_ACTIONS = Object.freeze({
  'marketing.products.add': {
    officialEndpointKey: 'actions.productsActivate',
    sellerEndpointKey: 'sellerActions.productsAdd',
    description: '营销活动添加商品',
  },
  'marketing.products.remove': {
    officialEndpointKey: 'actions.productsDeactivate',
    sellerEndpointKey: 'sellerActions.productsDelete',
    description: '营销活动移除商品',
  },
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function getSourceTypeFromEndpoint(endpointKey = '') {
  return String(endpointKey || '').startsWith('sellerActions.') ? 'seller' : 'official';
}

function resolveEndpointKey(actionConfig = {}, inputEndpointKey = '', sourceType = '') {
  const normalizedEndpoint = normalizeText(inputEndpointKey);
  if (normalizedEndpoint) return normalizedEndpoint;
  return sourceType === 'seller' ? actionConfig.sellerEndpointKey : actionConfig.officialEndpointKey;
}

export function listMarketingWriteActions() {
  return Object.entries(MARKETING_WRITE_ACTIONS).map(([action, config]) => ({
    action,
    officialEndpointKey: config.officialEndpointKey,
    sellerEndpointKey: config.sellerEndpointKey,
    description: config.description,
  }));
}

export function createMarketingWriteService({ ozonScheduler } = {}) {
  function validateFoundation() {
    if (!ozonScheduler?.executeWrite) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: 'MARKETING_WRITE_EXECUTOR_NOT_CONNECTED',
          message: '营销活动写入执行器尚未连接，本次不会写入 Ozon。',
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

    const action = normalizeText(input.action || preview?.action || preview?.diff?.action);
    const actionConfig = MARKETING_WRITE_ACTIONS[action];
    if (!actionConfig) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: 'MARKETING_WRITE_ACTION_NOT_REGISTERED',
          message: `营销活动写入动作尚未登记：${action || 'unknown'}`,
        },
      };
    }

    const shopId = normalizeText(input.shopId || input.shop_id || preview?.shopId || preview?.diff?.shopId);
    if (!shopId) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: { code: 'MARKETING_WRITE_SHOP_ID_REQUIRED', message: '营销活动写入确认必须包含 shopId。' },
      };
    }

    const previewEndpointKey = normalizeText(input.endpointKey || preview?.endpointKey || preview?.diff?.endpointKey);
    const allowedEndpointKeys = [actionConfig.officialEndpointKey, actionConfig.sellerEndpointKey].filter(Boolean);
    if (previewEndpointKey && !allowedEndpointKeys.includes(previewEndpointKey)) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        endpointKey: previewEndpointKey,
        action,
        error: {
          code: 'MARKETING_WRITE_ENDPOINT_MISMATCH',
          message: `营销活动写入动作 ${action} 只能走 ${allowedEndpointKeys.join(' 或 ')}，不能改写为 ${previewEndpointKey}。`,
        },
      };
    }
    const sourceType = normalizeText(input.sourceType || input.source_type) || getSourceTypeFromEndpoint(previewEndpointKey);
    const endpointKey = resolveEndpointKey(actionConfig, previewEndpointKey, sourceType);
    const payload = input.payload ?? preview?.payload ?? preview?.diff?.after ?? {};
    const idempotencyKey =
      normalizeText(input.idempotencyKey || preview?.idempotencyKey) ||
      `marketing-write:${shopId}:${action}:${preview?.previewId || Date.now()}`;
    const realWrite = input.realWrite === true && input.dryRun === false;
    const fastAck = input.fastAck === true || input.asyncWrite === true || input.waitForResult === false;

    const writeResult = await ozonScheduler.executeWrite({
      shopId,
      domain: 'marketing',
      endpointKey,
      action,
      priority: 'WRITE',
      params: payload,
      idempotencyKey,
      requestedBy: input.requestedBy || preview?.requestedBy || 'marketing-write-guard',
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
        message: '营销活动写入已提交 Ozon，等待活动商品池回读确认；回读成功前仅显示处理中。',
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
          code: 'MARKETING_WRITE_FAILED',
          message: '营销活动写入执行失败，旧缓存已保留。',
        },
        schedulerResult: writeResult || null,
      };
    }

    return {
      ok: true,
      confirmed: true,
      writeConnected: true,
      writeStatus: writeResult.dryRun ? 'dry_run_recorded' : 'submitted_waiting_readback',
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
      readBack: { status: writeResult.dryRun ? 'not_required' : 'pending', rows: 0, merge: null },
      message: writeResult.dryRun
        ? '营销活动写入已记录 dry-run，未写入 Ozon。'
        : '营销活动写入已提交 Ozon，等待页面或后台回读最新活动商品池；回读成功前仅显示处理中。',
    };
  }

  return {
    listActions: listMarketingWriteActions,
    executeConfirmedWrite,
  };
}

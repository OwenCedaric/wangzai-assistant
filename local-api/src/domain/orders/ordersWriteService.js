const ORDER_WRITE_ACTIONS = Object.freeze({
  cancelOrder: { endpointKey: 'orders.cancelOrder', description: '取消订单', source: 'FBS' },
  createOrder: { endpointKey: 'orders.createOrder', description: '创建订单', source: 'FBS' },
  cancelFboPosting: { endpointKey: 'orders.cancelFboPosting', description: '取消 FBO 发货单', source: 'FBO' },
  cancelFbsPosting: { endpointKey: 'orders.cancelFbsPosting', description: '取消 FBS 发货单', source: 'FBS' },
  cancelFbsProduct: { endpointKey: 'orders.cancelFbsProduct', description: '取消 FBS 部分商品发货', source: 'FBS' },
  setFbsAwaitingDelivery: { endpointKey: 'orders.setFbsAwaitingDelivery', description: '提交 FBS 等待交付', source: 'FBS' },
  shipFbsPosting: { endpointKey: 'orders.shipFbsPosting', description: '确认 FBS/rFBS 发货', source: 'FBS' },
  shipFbsPackage: { endpointKey: 'orders.shipFbsPackage', description: '确认多包裹发货', source: 'FBS' },
  createFbsPackageLabel: { endpointKey: 'orders.createFbsPackageLabel', description: '创建 FBS 面单任务', source: 'FBS' },
  getFbsPackageLabel: { endpointKey: 'orders.getFbsPackageLabel', description: '获取 FBS 面单文件', source: 'FBS' },
  splitFbsPosting: { endpointKey: 'orders.splitFbsPosting', description: '拆分 FBS 发货单', source: 'FBS' },
  splitTraceableFbsPosting: { endpointKey: 'orders.splitTraceableFbsPosting', description: '拆分可追溯发货单', source: 'FBS' },
  setMultiboxQty: { endpointKey: 'orders.setMultiboxQty', description: '设置多箱数量', source: 'FBS' },
  updateFbsExemplar: { endpointKey: 'orders.updateFbsExemplar', description: '更新商品实例/标记码', source: 'FBS' },
  setFbsExemplar: { endpointKey: 'orders.setFbsExemplar', description: '保存商品实例/标记码', source: 'FBS' },
  createOrGetFbsExemplar: { endpointKey: 'orders.createOrGetFbsExemplar', description: '创建或读取商品实例/标记码', source: 'FBS' },
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.postings)) return value.postings;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.result?.postings)) return value.result.postings;
  if (Array.isArray(value?.result?.items)) return value.result.items;
  if (Array.isArray(value?.result)) return value.result;
  if (value?.result && typeof value.result === 'object') return [value.result];
  if (value && typeof value === 'object' && (value.posting_number || value.order_id || value.orderId)) return [value];
  return [];
}

function resolveReadBackRows(result = {}, input = {}, preview = {}, context = {}) {
  const direct = normalizeRows(result.readBackRows);
  if (direct.length) return direct;
  const inputRows = normalizeRows(input.readBackRows || input.payload?.readBackRows || input.after?.readBackRows);
  if (inputRows.length) return inputRows;
  const previewRows = normalizeRows(preview?.payload?.readBackRows || preview?.diff?.after?.readBackRows);
  if (previewRows.length) return previewRows;
  if (isSplitAction(context.action)) return [];
  return normalizeRows(result.data?.readBackRows || result.data?.items || result.data?.result || result.data);
}

function resolveAction(input = {}, preview = {}) {
  return normalizeText(input.action || preview?.action || preview?.diff?.action);
}

function resolveEndpointKey(input = {}, preview = {}, actionConfig = {}) {
  return normalizeText(input.endpointKey || preview?.endpointKey || preview?.diff?.endpointKey) || actionConfig.endpointKey;
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

function firstFilled(...values) {
  for (const value of values) {
    const normalized = normalizeId(value);
    if (normalized) return normalized;
  }
  return '';
}

function normalizePostingNumber(row = {}) {
  if (typeof row === 'string' || typeof row === 'number') return normalizeId(row);
  return normalizeId(firstFilled(row.posting_number, row.postingNumber, row.posting?.posting_number, row.id));
}

function isSplitAction(action) {
  return action === 'splitFbsPosting' || action === 'splitTraceableFbsPosting';
}

function resolveSplitParentPostingNumber(payload = {}, input = {}, preview = {}) {
  return normalizePostingNumber(
    payload.posting_number ||
      payload.postingNumber ||
      payload.parentPostingNumber ||
      payload.parent_posting_number ||
      input.posting_number ||
      input.postingNumber ||
      preview?.payload?.posting_number ||
      preview?.diff?.after?.posting_number,
  );
}

function toPositiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function sumRowsProductQuantity(rows = []) {
  return normalizeRows(rows)
    .flatMap((row) => (Array.isArray(row.products) ? row.products : Array.isArray(row.items) ? row.items : []))
    .reduce((sum, product) => sum + toPositiveInteger(product?.quantity ?? product?.qty ?? product?.count), 0);
}

function normalizeSplitQuantitiesFromPayload(payload = {}) {
  const postings = Array.isArray(payload.postings) ? payload.postings : Array.isArray(payload.packages) ? payload.packages : [];
  const rows = [];
  postings.forEach((posting, postingIndex) => {
    const products = Array.isArray(posting?.products) ? posting.products : Array.isArray(posting?.items) ? posting.items : [];
    products.forEach((product) => {
      const quantity = toPositiveInteger(product?.quantity ?? product?.qty ?? product?.count);
      if (!quantity) return;
      rows.push({
        postingIndex,
        offer_id: normalizeText(firstFilled(product?.offer_id, product?.offerId, product?.sku, product?.skuId)),
        product_id: normalizeText(firstFilled(product?.product_id, product?.productId)),
        quantity,
      });
    });
  });
  return rows;
}

function collectPostingNumbers(value, output = []) {
  if (!value || output.length > 1000) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPostingNumbers(item, output));
    return output;
  }
  if (typeof value !== 'object') return output;
  const postingNumber = normalizePostingNumber(value);
  if (postingNumber) output.push(postingNumber);
  for (const key of ['result', 'posting', 'postings', 'items', 'packages', 'data', 'children', 'child_postings', 'childPostings']) {
    if (value[key]) collectPostingNumbers(value[key], output);
  }
  return output;
}

function extractChildPostingNumbers({ writeResult = {}, readBackRows = [], parentPostingNumber = '' } = {}) {
  const collected = [
    ...collectPostingNumbers(writeResult.data),
    ...collectPostingNumbers(writeResult.result),
    ...collectPostingNumbers(writeResult.postings),
    ...collectPostingNumbers(readBackRows),
  ];
  return [...new Set(collected.filter((item) => item && item !== parentPostingNumber))];
}

function analyzeSplitReadback({ parentPostingNumber, childPostingNumbers = [], readBackRows = [], splitQuantities = [] } = {}) {
  const normalizedReadBackRows = normalizeRows(readBackRows);
  const rowPostingNumbers = normalizedReadBackRows.map(normalizePostingNumber).filter(Boolean);
  const parentOzonVisible = rowPostingNumbers.includes(parentPostingNumber) ? true : null;
  const inferredChildren = childPostingNumbers.length
    ? childPostingNumbers
    : rowPostingNumbers.filter((postingNumber) => postingNumber && postingNumber !== parentPostingNumber);
  const confirmedChildren = inferredChildren.filter((child) => rowPostingNumbers.includes(child));
  const childrenConfirmed = inferredChildren.length > 0 && confirmedChildren.length === inferredChildren.length;
  const submittedQuantity = splitQuantities.reduce((sum, item) => sum + toPositiveInteger(item.quantity), 0);
  const confirmedPostingNumbers = new Set(confirmedChildren);
  if (parentOzonVisible) confirmedPostingNumbers.add(parentPostingNumber);
  const splitQuantityPostingNumbers = splitQuantities.map(normalizePostingNumber).filter(Boolean);
  const expectedPostingNumbers = splitQuantityPostingNumbers.length
    ? [...new Set(splitQuantityPostingNumbers)]
    : [];
  const allSubmittedRowsConfirmed = splitQuantities.length
    ? expectedPostingNumbers.length
      ? expectedPostingNumbers.every((postingNumber) => confirmedPostingNumbers.has(postingNumber))
      : confirmedPostingNumbers.size >= splitQuantities.length
    : childrenConfirmed;
  const quantityRows = expectedPostingNumbers.length
    ? normalizedReadBackRows.filter((row) => expectedPostingNumbers.includes(normalizePostingNumber(row)))
    : normalizedReadBackRows.filter((row) => confirmedPostingNumbers.has(normalizePostingNumber(row)));
  const readbackQuantity = sumRowsProductQuantity(quantityRows);
  const quantityMismatch =
    allSubmittedRowsConfirmed && submittedQuantity > 0 && readbackQuantity > 0 && submittedQuantity !== readbackQuantity;
  if (quantityMismatch) {
    return {
      childPostingNumbers: inferredChildren,
      parentOzonVisible,
      childrenConfirmed: false,
      readbackStatus: 'mismatch',
      status: 'readback_mismatch',
      mismatchReason: `拆单回读数量不一致：提交 ${submittedQuantity} 件，回读 ${readbackQuantity} 件。`,
    };
  }
  if (allSubmittedRowsConfirmed) {
    return {
      childPostingNumbers: inferredChildren,
      parentOzonVisible,
      childrenConfirmed,
      readbackStatus: 'merged',
      status: 'readback_merged',
      mismatchReason: '',
    };
  }
  if (rowPostingNumbers.length > 0) {
    return {
      childPostingNumbers: inferredChildren,
      parentOzonVisible,
      childrenConfirmed: false,
      readbackStatus: 'partial',
      status: 'submitted_waiting_readback',
      mismatchReason: inferredChildren.length ? '拆单回读未覆盖全部子单。' : '拆单回读未返回子单号。',
    };
  }
  return {
    childPostingNumbers: inferredChildren,
    parentOzonVisible: null,
    childrenConfirmed: false,
    readbackStatus: 'pending',
    status: 'submitted_waiting_readback',
    mismatchReason: '',
  };
}

function buildSplitReadBackRequests({ shopId, action, parentPostingNumber, childPostingNumbers = [] } = {}) {
  const parent = normalizePostingNumber(parentPostingNumber);
  const children = [...new Set((childPostingNumbers || []).map(normalizePostingNumber).filter(Boolean))];
  const requests = [];
  if (parent) {
    requests.push({
      type: 'split-parent-detail',
      shopId,
      endpointKey: 'orders.fbsGet',
      postingNumber: parent,
      parentPostingNumbers: [parent],
      priority: 'P1',
      requestedBy: 'orders-write-split-readback',
    });
  }
  for (const child of children) {
    requests.push({
      type: 'split-child-detail',
      shopId,
      endpointKey: 'orders.fbsGet',
      postingNumber: child,
      parentPostingNumbers: parent ? [parent] : [],
      priority: 'P1',
      requestedBy: 'orders-write-split-readback',
    });
  }
  requests.push({
    type: 'split-list-refresh',
    shopId,
    endpointKey: 'orders.fbsList',
    params: {},
    maxPages: 1,
    pageSize: 100,
    parentPostingNumbers: parent ? [parent] : [],
    priority: 'P2',
    requestedBy: 'orders-write-split-readback',
  });
  return requests.map((request) => ({
    ...request,
    idempotencyKey: `orders-readback:${action || 'split'}:${shopId}:${request.postingNumber || request.type}:${Date.now()}`,
  }));
}

export function listOrderWriteActions() {
  return Object.entries(ORDER_WRITE_ACTIONS).map(([action, config]) => ({
    action,
    endpointKey: config.endpointKey,
    description: config.description,
  }));
}

export function createOrdersWriteService({ repository, ozonScheduler, scheduleReadBack } = {}) {
  function validateFoundation() {
    if (!repository) {
      return { ok: false, error: { code: 'ORDERS_WRITE_CACHE_NOT_CONNECTED', message: '订单写入回读需要先连接 ozon_orders 缓存表。' } };
    }
    if (!ozonScheduler?.executeWrite) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: 'ORDERS_WRITE_EXECUTOR_NOT_CONNECTED',
          message: '订单写入执行器尚未连接，本次不会写入 Ozon。',
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

  function recordSplitRelation({
    action,
    shopId,
    payload,
    input,
    preview,
    writeResult,
    readBackRows = [],
    realWrite,
  } = {}) {
    if (!realWrite || !isSplitAction(action) || !repository?.upsertSplitRelation) return null;
    const parentPostingNumber = resolveSplitParentPostingNumber(payload, input, preview);
    if (!parentPostingNumber) return null;
    const splitQuantities = normalizeSplitQuantitiesFromPayload(payload);
    const childPostingNumbers = extractChildPostingNumbers({ writeResult, readBackRows, parentPostingNumber });
    const readback = analyzeSplitReadback({
      parentPostingNumber,
      childPostingNumbers,
      readBackRows,
      splitQuantities,
    });
    return repository.upsertSplitRelation({
      shopId,
      parentPostingNumber,
      childPostingNumbers: readback.childPostingNumbers,
      splitQuantities,
      status: readback.status,
      readbackStatus: readback.readbackStatus,
      parentOzonVisible: readback.parentOzonVisible,
      childrenConfirmed: readback.childrenConfirmed,
      submittedPayload: payload,
      ozonResponse: writeResult?.data ?? writeResult ?? null,
      parentSnapshot: input.parentSnapshot ?? input.parentOrder ?? preview?.diff?.before ?? null,
      readBackRows,
      mismatchReason: readback.mismatchReason,
    });
  }

  function scheduleSplitReadBack({ action, shopId, payload, input, preview, writeResult, readBackRows = [], realWrite } = {}) {
    if (!realWrite || !isSplitAction(action) || typeof scheduleReadBack !== 'function') {
      return { ok: true, scheduled: false, jobs: [], skipped: true };
    }
    const parentPostingNumber = resolveSplitParentPostingNumber(payload, input, preview);
    if (!parentPostingNumber) return { ok: false, scheduled: false, jobs: [], error: { code: 'ORDER_SPLIT_PARENT_POSTING_REQUIRED', message: '拆单回读缺少母单货件号。' } };
    const childPostingNumbers = extractChildPostingNumbers({ writeResult, readBackRows, parentPostingNumber });
    const requests = buildSplitReadBackRequests({ shopId, action, parentPostingNumber, childPostingNumbers });
    return scheduleReadBack(requests, {
      action,
      shopId,
      parentPostingNumber,
      childPostingNumbers,
    });
  }

  async function executeConfirmedWrite({ preview, input = {} } = {}) {
    const foundationError = validateFoundation();
    if (foundationError) return foundationError;

    const action = resolveAction(input, preview);
    const actionConfig = ORDER_WRITE_ACTIONS[action];
    if (!actionConfig) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: 'ORDERS_WRITE_ACTION_NOT_REGISTERED',
          message: `订单写入动作尚未登记：${action || 'unknown'}`,
        },
      };
    }

    const shopId = normalizeText(input.shopId || input.shop_id || preview?.shopId || preview?.diff?.shopId);
    if (!shopId) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: { code: 'ORDERS_WRITE_SHOP_ID_REQUIRED', message: '订单写入确认必须包含 shopId。' },
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
          code: 'ORDERS_WRITE_ENDPOINT_MISMATCH',
          message: `订单写入动作 ${action} 只能走 ${actionConfig.endpointKey}，不能改写为 ${endpointKey || 'unknown'}。`,
        },
      };
    }

    const payload = input.payload ?? preview?.payload ?? preview?.diff?.after ?? {};
    const idempotencyKey =
      normalizeText(input.idempotencyKey || preview?.idempotencyKey) ||
      `orders-write:${shopId}:${action}:${preview?.previewId || Date.now()}`;
    const realWrite = input.realWrite === true && input.dryRun === false;
    const fastAck = input.fastAck === true || input.asyncWrite === true || input.waitForResult === false;

    const writeResult = await ozonScheduler.executeWrite({
      shopId,
      domain: 'orders',
      endpointKey,
      action,
      priority: 'WRITE',
      params: payload,
      idempotencyKey,
      requestedBy: input.requestedBy || preview?.requestedBy || 'orders-write-guard',
      previewId: preview?.previewId || input.previewId,
      realWrite,
      dryRun: !realWrite,
      waitForResult: fastAck ? false : true,
      fastAck,
      asyncWrite: fastAck,
    });

    if (writeResult?.accepted === true || writeResult?.pending === true) {
      const splitRelation = recordSplitRelation({
        action,
        shopId,
        payload,
        input,
        preview,
        writeResult,
        readBackRows: [],
        realWrite,
      });
      const readBackJobs = scheduleSplitReadBack({
        action,
        shopId,
        payload,
        input,
        preview,
        writeResult,
        readBackRows: [],
        realWrite,
      });
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
        splitRelation: splitRelation?.relation || null,
        readBackJobs,
        message: readBackJobs?.scheduled
          ? '订单写入已提交 Ozon，后台回读已排队；SQLite 合并完成前仅显示处理中。'
          : '订单写入已提交 Ozon，等待回读确认；SQLite 合并完成前仅显示处理中。',
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
          code: 'ORDERS_WRITE_FAILED',
          message: '订单写入执行失败，旧缓存已保留。',
        },
        schedulerResult: writeResult || null,
      };
    }

    const readBackRows = resolveReadBackRows(writeResult, input, preview, { action });
    const merge = readBackRows.length
      ? repository.upsertOrders({ shopId, rows: readBackRows, source: actionConfig.source || 'FBS' })
      : { ok: true, changed: 0, inserted: 0, updated: 0, unchanged: 0, missing: 0, rows: 0, skipped: true };
    const hasReadBack = readBackRows.length > 0;
    const splitRelation = recordSplitRelation({
      action,
      shopId,
      payload,
      input,
      preview,
      writeResult,
      readBackRows,
      realWrite,
    });
    const readBackJobs = hasReadBack
      ? { ok: true, scheduled: false, jobs: [], skipped: true, reason: 'inline_readback_rows_merged' }
      : scheduleSplitReadBack({
          action,
          shopId,
          payload,
          input,
          preview,
          writeResult,
          readBackRows,
          realWrite,
        });

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
      splitRelation: splitRelation?.relation || null,
      readBackJobs,
      message: writeResult.dryRun
        ? '订单写入已记录 dry-run，未写入 Ozon。'
        : hasReadBack
          ? '订单 Ozon 写入回读成功，SQLite 已合并。'
          : readBackJobs?.scheduled
            ? '订单写入已提交 Ozon，后台回读已排队；未取得回读结果前仅显示处理中。'
            : '订单写入已提交 Ozon，等待回读确认；未取得回读结果前仅显示处理中。',
    };
  }

  return {
    listActions: listOrderWriteActions,
    executeConfirmedWrite,
  };
}

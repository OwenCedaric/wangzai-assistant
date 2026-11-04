import { translateAfterSalesReasonToChinese } from '../../../../services/afterSalesReasonTranslate.js';

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function normalizeId(value) {
  const text = normalizeText(value);
  if (!text || text === '未返回') return '';
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : text;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function getRawOrder(order = {}, latestRaw = null) {
  return Object.keys(asRecord(latestRaw)).length ? asRecord(latestRaw) : asRecord(order.raw);
}

function getNestedRawRecords(raw = {}) {
  return [
    asRecord(raw),
    asRecord(raw.detail),
    asRecord(raw.listItem),
    asRecord(raw.return),
    asRecord(raw.result),
  ];
}

function getFirstRecordValue(records = [], keys = []) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return '';
}

function getActionKind(name = '') {
  const text = normalizeText(name).toLowerCase();
  if (/reject|decline|отклон|拒绝/u.test(text)) return 'reject';
  if (/compens|компенсац|部分退款|补偿/u.test(text)) return 'compensate';
  if (/return.?money|money.?back|refund|вернут.{0,12}ден|退款/u.test(text)) return 'refund';
  if (/receive|получен|принят|确认收货|收到退货/u.test(text)) return 'receive';
  if (/verify|approve|одобр|соглас|同意退货/u.test(text)) return 'verify';
  return 'generic';
}

function getActionLabel(action = {}) {
  const name = normalizeText(action.name || action.title || action.action);
  const kind = getActionKind(name);
  const labels = {
    reject: '拒绝退货',
    compensate: '部分退款或补偿',
    refund: '给买家退款',
    receive: '确认收到退货',
    verify: '同意退货',
  };
  return labels[kind] || `Ozon 可用操作 ${normalizeText(action.id) || ''}`.trim();
}

function getConditionalState(raw = {}) {
  const state = asRecord(raw.state);
  return normalizeText(firstFilled(state.state, state.status, raw.status, raw.state)).toUpperCase();
}

function getRfbsActions(raw = {}) {
  return asList(raw.available_actions || raw.availableActions).flatMap((action, index) => {
    const actionId = normalizeId(firstFilled(action.id, action.action_id, action.actionId));
    if (actionId === '') return [];
    const name = normalizeText(firstFilled(action.name, action.title, action.action));
    const kind = getActionKind(name);
    return [{
      key: `rfbs:${actionId}:${index}`,
      operationId: 'setRfbsReturnAction',
      actionId,
      name,
      label: getActionLabel(action),
      kind,
    }];
  });
}

function getRejectionReasons(raw = {}) {
  return asList(raw.rejection_reason || raw.rejectionReason || raw.rejection_reasons).flatMap((reason) => {
    const id = normalizeId(firstFilled(reason.id, reason.reason_id, reason.reasonId));
    if (id === '') return [];
    const sourceName = normalizeText(firstFilled(reason.name, reason.title, reason.reason));
    const translatedName = translateAfterSalesReasonToChinese(sourceName);
    const sourceHint = normalizeText(reason.hint);
    const translatedHint = translateAfterSalesReasonToChinese(sourceHint);
    return [{
      id,
      name: translatedName && !/[\u0400-\u04FF]/u.test(translatedName)
        ? translatedName
        : `Ozon 返回的其他拒绝原因（编号 ${id}）`,
      hint: translatedHint && !/[\u0400-\u04FF]/u.test(translatedHint) ? translatedHint : '',
      commentRequired: reason.is_comment_required === true || reason.isCommentRequired === true,
    }];
  });
}

export function getAfterSalesOperationPlan(order = {}, latestRaw = null) {
  const raw = getRawOrder(order, latestRaw);
  const rawRecords = getNestedRawRecords(raw);
  const source = normalizeText(firstFilled(order.source, raw.source)).toLowerCase();
  const cancellationId = normalizeId(firstFilled(
    getFirstRecordValue(rawRecords, ['cancellation_id', 'cancellationId']),
    order.cancellation_id,
    order.cancellationId,
    source === 'conditional' ? order.returnId : ''
  ));
  const returnId = normalizeId(firstFilled(
    getFirstRecordValue(rawRecords, ['return_id', 'returnId']),
    order.return_id,
    order.returnId,
    source === 'rfbs-return' && /^\d+$/u.test(normalizeText(order.id)) ? order.id : ''
  ));

  if (source === 'conditional' || cancellationId !== '') {
    const state = getConditionalState(raw);
    const terminal = /(^|[_\s-])(APPROVED|REJECTED|CANCELLED|CANCELED|COMPLETED|CLOSED)($|[_\s-])/u.test(state);
    const actions = !terminal && cancellationId !== ''
      ? [
          {
            key: 'conditional:approve',
            operationId: 'approveConditionalCancellation',
            label: '同意取消',
            kind: 'approve',
          },
          {
            key: 'conditional:reject',
            operationId: 'rejectConditionalCancellation',
            label: '拒绝取消',
            kind: 'reject-conditional',
          },
        ]
      : [];
    return {
      type: 'conditional',
      source,
      returnId: '',
      cancellationId,
      state,
      raw,
      actions,
      rejectionReasons: [],
      actionable: actions.length > 0,
      message: cancellationId === ''
        ? 'Ozon 没有返回取消申请 ID，不能提交处理。'
        : terminal
          ? '这条取消申请已经处理完成，无需再次操作。'
          : '',
    };
  }

  const isRfbsReturn = source === 'rfbs-return' || source.includes('rfbs') || Array.isArray(raw.available_actions);
  if (isRfbsReturn) {
    const actions = getRfbsActions(raw);
    return {
      type: 'rfbs-return',
      source,
      returnId,
      cancellationId: '',
      state: normalizeText(firstFilled(raw.state?.state, raw.status, order.status)),
      raw,
      actions,
      rejectionReasons: getRejectionReasons(raw),
      actionable: returnId !== '' && actions.length > 0,
      message: returnId === ''
        ? 'Ozon 没有返回退货申请 ID，不能提交处理。'
        : actions.length === 0
          ? 'Ozon 当前没有返回可执行动作，这条售后可能已经处理完成。'
          : '',
    };
  }

  return {
    type: 'unsupported',
    source,
    returnId: '',
    cancellationId: '',
    state: '',
    raw,
    actions: [],
    rejectionReasons: [],
    actionable: false,
    message: '这条记录不是可通过 Seller API 处理的 rFBS 退货或条件取消，请在 Ozon 后台处理。',
  };
}

export function shouldLoadAfterSalesOperationPlan(plan = {}) {
  return plan.type === 'rfbs-return' && plan.returnId !== '';
}

export function createAfterSalesOperationForm(plan = {}) {
  const action = plan.actions?.[0] || null;
  return {
    actionKey: action?.key || '',
    rejectionReasonId: plan.rejectionReasons?.[0]?.id ?? '',
    comment: '',
    compensationAmount: '',
    returnForBackWay: '0',
    returnMethodDescription: normalizeText(firstFilled(
      plan.raw?.return_method_description,
      plan.raw?.returnMethodDescription,
      plan.raw?.client_return_method_type?.name,
      plan.raw?.clientReturnMethodType?.name
    )),
  };
}

export function buildAfterSalesOperationRequest(plan = {}, form = {}) {
  const action = (plan.actions || []).find((item) => item.key === form.actionKey);
  if (!action) throw new Error('请选择 Ozon 当前允许的售后操作。');

  const comment = normalizeText(form.comment);
  if (plan.type === 'conditional') {
    if (plan.cancellationId === '') throw new Error('缺少 Ozon 取消申请 ID。');
    return {
      operationId: action.operationId,
      payload: {
        cancellation_id: plan.cancellationId,
        ...(comment ? { comment } : {}),
      },
    };
  }

  if (plan.type !== 'rfbs-return' || plan.returnId === '') {
    throw new Error(plan.message || '这条售后不能通过 Seller API 处理。');
  }

  const payload = {
    return_id: plan.returnId,
    id: action.actionId,
  };

  if (action.kind === 'reject') {
    const rejectionReason = (plan.rejectionReasons || []).find(
      (reason) => String(reason.id) === String(form.rejectionReasonId)
    );
    if (!rejectionReason) throw new Error('请选择 Ozon 返回的拒绝原因。');
    if (rejectionReason.commentRequired && !comment) throw new Error('这个拒绝原因必须填写说明。');
    payload.rejection_reason_id = rejectionReason.id;
  }
  if (action.kind === 'compensate') {
    const amount = Number(form.compensationAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('请输入正确的补偿金额。');
    payload.compensation_amount = normalizeText(form.compensationAmount);
  }
  if (action.kind === 'refund') {
    const amount = Number(form.returnForBackWay || 0);
    if (!Number.isInteger(amount) || amount < 0) throw new Error('退货运费补偿必须是大于等于 0 的整数。');
    payload.return_for_back_way = amount;
  }
  if (action.kind === 'verify' && normalizeText(form.returnMethodDescription)) {
    payload.return_method_description = normalizeText(form.returnMethodDescription);
  }
  if (comment) payload.comment = comment;

  return { operationId: action.operationId, payload };
}

export function getSelectedAfterSalesOperation(plan = {}, form = {}) {
  return (plan.actions || []).find((item) => item.key === form.actionKey) || null;
}

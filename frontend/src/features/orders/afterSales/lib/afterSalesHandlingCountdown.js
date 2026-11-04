function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function parseDeadlineMs(value) {
  if (isPlainObject(value)) {
    return parseDeadlineMs(value.value ?? value.at ?? value.date ?? value.datetime ?? value.time);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d{10,13}$/.test(text)) return parseDeadlineMs(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readDeadlineValues(source = {}) {
  if (!isPlainObject(source)) return [];
  return [
    source.deadline,
    source.deadline_at,
    source.deadlineAt,
    source.due_at,
    source.dueAt,
    source.action_deadline,
    source.actionDeadline,
    source.decision_deadline,
    source.decisionDeadline,
    source.response_deadline,
    source.responseDeadline,
    source.seller_response_deadline,
    source.sellerResponseDeadline,
    source.expires_at,
    source.expiresAt,
    source.expiration_date,
    source.expirationDate,
  ];
}

function getCountdownSources(order = {}) {
  const safeOrder = isPlainObject(order) ? order : {};
  const raw = isPlainObject(safeOrder.raw) ? safeOrder.raw : {};
  return [
    safeOrder,
    raw,
    safeOrder.detail,
    raw.detail,
    safeOrder.listItem,
    raw.listItem,
    safeOrder.state,
    raw.state,
  ].filter(isPlainObject);
}

function getAvailableActions(sources = []) {
  return sources.flatMap((source) => [
    ...asList(source.available_actions),
    ...asList(source.availableActions),
    ...asList(source.actions),
  ]).filter((action) => isPlainObject(action) || String(action ?? '').trim());
}

export function getAfterSalesHandlingDeadlineMs(order = {}) {
  const sources = getCountdownSources(order);
  const actions = getAvailableActions(sources);
  const candidates = [...sources.flatMap(readDeadlineValues), ...actions.flatMap(readDeadlineValues)];
  return candidates.map(parseDeadlineMs).find((value) => value > 0) || 0;
}

export function getAfterSalesHandlingCountdown(order = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const sources = getCountdownSources(order);
  const availableActions = getAvailableActions(sources);
  const deadlineMs = getAfterSalesHandlingDeadlineMs(order);

  if (!deadlineMs) {
    return availableActions.length
      ? { label: '当前可处理', tone: 'ready', deadlineMs: 0 }
      : { label: '等待 Ozon 处理', tone: 'waiting', deadlineMs: 0 };
  }

  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) {
    return { label: '处理期限已截止', tone: 'overdue', deadlineMs };
  }

  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours || days) parts.push(`${hours}小时`);
  if (!days) parts.push(`${minutes}分`);

  return {
    label: `处理倒计时：剩余 ${parts.join(' ')}`,
    tone: totalMinutes <= 360 ? 'urgent' : 'active',
    deadlineMs,
  };
}

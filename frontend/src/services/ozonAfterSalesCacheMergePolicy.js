const MISSING_TEXT_VALUES = new Set(['未返回', '读取失败', '待确认', '']);
const AFTER_SALES_REFUSED_REFUND_STATUS = '\u62d2\u6536\u540e\u9000\u6b3e';
const AFTER_SALES_NEEDS_EVIDENCE_STATUS = '\u5f85\u6838\u5bf9';
const AFTER_SALES_STATUS_LINE_PREFIX = '\u552e\u540e\u72b6\u6001\uff1a';
const AFTER_SALES_INCOMPLETE_REFUSED_REFUND_EVIDENCE_REASON =
  '旧缓存未确认原订单已取消、买家拒收/未取、商品销毁/处置和原订单未签收的完整证据，标记待核对';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isMissingTextValue(value) {
  return typeof value === 'string' && MISSING_TEXT_VALUES.has(normalizeText(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasEffectiveFieldValue(value) {
  if (value === undefined || value === null) return false;
  if (isMissingTextValue(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.values(value).some(hasEffectiveFieldValue);
  return true;
}

function cloneJsonSafe(value) {
  if (value === undefined || typeof value === 'function') return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function mergeEffectiveObjectValue(currentValue, freshValue) {
  const currentObject = isPlainObject(currentValue) ? currentValue : {};
  const merged = { ...currentObject };
  for (const [key, value] of Object.entries(freshValue || {})) {
    const cloned = cloneJsonSafe(value);
    if (isPlainObject(cloned)) {
      if (hasEffectiveFieldValue(cloned)) {
        merged[key] = mergeEffectiveObjectValue(currentObject[key], cloned);
      }
      continue;
    }
    if (hasEffectiveFieldValue(cloned)) {
      merged[key] = cloned;
    }
  }
  return merged;
}

function toBooleanFlag(value) {
  if (value === true) return true;
  const text = normalizeText(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function normalizeAfterSalesRefundLossStatus(value) {
  return normalizeText(value);
}

function isAfterSalesRefundLossStatus(value) {
  return normalizeAfterSalesRefundLossStatus(value) === AFTER_SALES_REFUSED_REFUND_STATUS;
}

function hasAfterSalesRequiredRefusedRefundEvidence(fields = {}) {
  return Boolean(
    (hasEffectiveFieldValue(fields.refusedEvidence) || hasEffectiveFieldValue(fields.destroyedEvidence)) &&
    !hasEffectiveFieldValue(fields.originalOrderDeliveredEvidence)
  );
}

function hasAfterSalesDurableRefusedFinanceConfirmation(fields = {}) {
  return Boolean(
    (hasEffectiveFieldValue(fields.refusedEvidence) || hasEffectiveFieldValue(fields.destroyedEvidence)) &&
    !hasEffectiveFieldValue(fields.originalOrderDeliveredEvidence)
  );
}

function hasAfterSalesDurableFinanceConfirmation(fields = {}) {
  const status = normalizeAfterSalesRefundLossStatus(fields.status || fields.type);
  if (status === AFTER_SALES_REFUSED_REFUND_STATUS) return hasAfterSalesDurableRefusedFinanceConfirmation(fields);
  return false;
}

function hasExplicitAfterSalesFinanceNonConfirmation(fields = {}) {
  const financeEvidence = isPlainObject(fields.financeRefundEvidence) ? fields.financeRefundEvidence : {};
  const hasCheckedResult = toBooleanFlag(fields.financeRefundChecked) || toBooleanFlag(financeEvidence.checked);
  return Boolean(
    hasCheckedResult &&
    !toBooleanFlag(fields.financeRefundConfirmed) &&
    !toBooleanFlag(financeEvidence.confirmed) &&
    !toBooleanFlag(financeEvidence.signedRefundConfirmed)
  );
}

function updateAfterSalesTimelineStatus(timeline = [], status) {
  const rows = Array.isArray(timeline) ? timeline : [];
  let hasStatusLine = false;
  const nextStatusLine = `${AFTER_SALES_STATUS_LINE_PREFIX}${status}`;
  const nextRows = rows
    .map((item) => {
      const text = normalizeText(item);
      if (!text.startsWith(AFTER_SALES_STATUS_LINE_PREFIX)) return item;
      if (hasStatusLine) return null;
      hasStatusLine = true;
      return nextStatusLine;
    })
    .filter((item) => item !== null);
  return hasStatusLine ? nextRows : [nextStatusLine, ...nextRows];
}

export function normalizeAfterSalesCachedClassificationFields(fields = {}) {
  if (!isPlainObject(fields)) return { fields: {}, changed: false };
  const nextFields = { ...fields };
  let changed = false;
  const status = normalizeAfterSalesRefundLossStatus(nextFields.status);
  const type = normalizeAfterSalesRefundLossStatus(nextFields.type);
  if (status && status !== nextFields.status) {
    nextFields.status = status;
    changed = true;
  }
  if (type && type !== nextFields.type) {
    nextFields.type = type;
    changed = true;
  }

  const hasRefundLossStatus =
    isAfterSalesRefundLossStatus(nextFields.status) || isAfterSalesRefundLossStatus(nextFields.type);
  if (!hasRefundLossStatus || hasAfterSalesRequiredRefusedRefundEvidence(nextFields)) {
    return { fields: nextFields, changed };
  }

  nextFields.status = AFTER_SALES_NEEDS_EVIDENCE_STATUS;
  nextFields.type = AFTER_SALES_NEEDS_EVIDENCE_STATUS;
  nextFields.tone = 'warning';
  nextFields.classificationReason = AFTER_SALES_INCOMPLETE_REFUSED_REFUND_EVIDENCE_REASON;
  nextFields.timeline = updateAfterSalesTimelineStatus(nextFields.timeline, AFTER_SALES_NEEDS_EVIDENCE_STATUS);
  return { fields: nextFields, changed: true };
}

export function shouldKeepAfterSalesStrongField(currentFields = {}, field = '', freshValue) {
  const freshFields = { ...(isPlainObject(currentFields) ? currentFields : {}), [field]: freshValue };
  const fieldClearsStaleFinance =
    (field === 'financeRefundConfirmed' &&
      !toBooleanFlag(freshValue) &&
      toBooleanFlag(freshFields.financeRefundChecked)) ||
    (field === 'financeRefundEvidence' &&
      toBooleanFlag(freshValue?.checked) &&
      !toBooleanFlag(freshValue?.confirmed) &&
      !toBooleanFlag(freshValue?.signedRefundConfirmed));
  const freshClearsStaleFinance =
    (fieldClearsStaleFinance || hasExplicitAfterSalesFinanceNonConfirmation(freshFields)) &&
    !hasAfterSalesDurableFinanceConfirmation(currentFields);
  if (
    field === 'originalOrderEvidenceChecked' &&
    toBooleanFlag(currentFields.originalOrderEvidenceChecked) &&
    !toBooleanFlag(freshValue)
  ) {
    return true;
  }
  if (
    field === 'financeRefundConfirmed' &&
    toBooleanFlag(currentFields.financeRefundConfirmed) &&
    !toBooleanFlag(freshValue) &&
    !freshClearsStaleFinance
  ) {
    return true;
  }
  if (
    field === 'financeRefundEvidence' &&
    toBooleanFlag(currentFields.financeRefundEvidence?.confirmed) &&
    !toBooleanFlag(freshValue?.confirmed) &&
    !freshClearsStaleFinance
  ) {
    return true;
  }
  const currentStatus = normalizeAfterSalesRefundLossStatus(currentFields.status || currentFields.type);
  const freshStatus = normalizeAfterSalesRefundLossStatus(freshValue);
  if (
    ['status', 'type', 'tone'].includes(field) &&
    currentStatus === AFTER_SALES_REFUSED_REFUND_STATUS &&
    hasAfterSalesRequiredRefusedRefundEvidence(currentFields) &&
    freshStatus !== AFTER_SALES_REFUSED_REFUND_STATUS
  ) {
    return true;
  }
  return false;
}

export function mergeAfterSalesFinanceEvidenceValue(currentValue, freshValue, currentFields = {}, freshFields = {}) {
  if (!isPlainObject(currentValue) || !isPlainObject(freshValue)) return freshValue;
  const merged = mergeEffectiveObjectValue(currentValue, freshValue);
  const freshClearsStaleFinance =
    hasExplicitAfterSalesFinanceNonConfirmation({ ...freshFields, financeRefundEvidence: freshValue }) &&
    !hasAfterSalesDurableFinanceConfirmation(currentFields);
  if (toBooleanFlag(currentValue.confirmed) && !freshClearsStaleFinance) {
    merged.confirmed = true;
    merged.checked = true;
  }
  return merged;
}
